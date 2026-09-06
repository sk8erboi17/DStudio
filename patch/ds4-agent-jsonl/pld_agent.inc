#ifndef DS4UI_AGENT_PLD_REWIND
#define DS4UI_AGENT_PLD_REWIND ds4ui_pld_rewind
#endif
        bool status_greedy_sampling = false;
        ds4ui_pld_index pld = {0};
        const ds4ui_pld_mode pld_mode = ds4ui_pld_mode_for(
            agent_is_cowork_runtime() ? "DS4UI_COWORK_PLD" : "DS4UI_AGENT_PLD");
        const bool pld_off = pld_mode == DS4UI_PLD_OFF;
        const bool pld_batch = pld_mode == DS4UI_PLD_BATCH;
        agent_trace(w, "PLD mode=%s (batch unqualified; strict adds no PLD batches)",
                    pld_off ? "off" : pld_batch ? "batch-experimental" : "strict");
        while (generated < max_tokens && !worker_should_interrupt(w)) {
            worker_apply_pending_power(w);
            bool greedy_sampling = agent_stream_wants_greedy_sampling(&stream);
            if (greedy_sampling != status_greedy_sampling) {
                worker_set_greedy_sampling(w, greedy_sampling);
                status_greedy_sampling = greedy_sampling;
            }
            int token = worker_sample_with_mode(w, cfg, greedy_sampling, &rng);
            if (ds4_token_is_stop_for_think_mode(w->engine, token, think_mode)) {
                if (tool_syntax == AGENT_TOOL_SYNTAX_GLM &&
                    token != ds4_token_eos(w->engine)) {
                    agent_trace(w, "glm assistant generation stopped before control token id=%d", token);
                }
                break;
            }

            ds4ui_pld_transaction pld_tx = {0};
            int toks[17];
            int ntok = 0;
            const int block_start = ds4_session_pos(w->session);
            if (ds4_engine_mtp_draft_tokens(w->engine) > 1 &&
                getenv("DS4_MTP_SPEC_DISABLE") == NULL) {
                ntok = ds4_session_eval_speculative(
                    w->session, token, max_tokens - generated,
                    ds4_token_eos(w->engine),
                    greedy_sampling ? 0.0f : cfg->gen.temperature, 0,
                    greedy_sampling ? 1.0f : cfg->gen.top_p,
                    greedy_sampling ? 0.0f : cfg->gen.min_p,
                    &rng, toks, (int)(sizeof(toks) / sizeof(toks[0])),
                    err, sizeof(err));
                if (ntok < 0) {
                    goto ds4ui_pld_failed;
                }
            } else {
                /* Whole-request greedy only: never replace sampled payloads
                 * with greedy proposals, even inside a greedy tool envelope.
                 * Remote providers use a different loop and are untouched. */
                int candidates[DS4UI_PLD_DRAFT + 1] = { token };
                const bool eligible = !pld_off &&
                                      !cfg->engine.quality &&
                                      cfg->gen.temperature == 0.0f &&
                                      !w->image_count;
                int drafted = eligible ? ds4ui_pld_propose(
                    &pld, w->transcript.v, w->transcript.len, token,
                    candidates + 1, max_tokens - generated - 1) : 0;
                for (int i = 1; i <= drafted; i++) {
                    if (ds4_token_is_stop_for_think_mode(w->engine,
                                                       candidates[i], think_mode)) {
                        drafted = i - 1;
                        break;
                    }
                }
                if (pld_batch && drafted > 0) {
                    ntok = ds4ui_pld_verify(w->session, candidates, drafted + 1,
                                           &pld_tx, err, sizeof(err));
                    if (ntok < 0) goto ds4ui_pld_failed;
                    if (ntok > 0) {
                        memcpy(toks, candidates, (size_t)ntok * sizeof(int));
                        pld.batches++;
                        ds4ui_pld_note(&pld, ntok - 1);
                    } else {
                        pld.fallbacks++;
                        /* An unavailable backend must not repeatedly snapshot. */
                        pld.cooldown = 16;
                    }
                }
                if (ntok == 0) {
                    if (ds4_session_eval(w->session, token,
                                         err, sizeof(err)) != 0)
                        goto ds4ui_pld_failed;
                    toks[0] = token;
                    ntok = 1;
                    /* Strict is a reference/observation mode: ordinary state
                     * and sampling, no speculative future is committed. */
                    if (!pld_batch && drafted > 0)
                        ds4ui_pld_note(&pld,
                            ds4_session_argmax(w->session) == candidates[1] ? 1 : 0);
                }
            }
            if (ntok == 0) {
                snprintf(err, sizeof(err), "decode returned no tokens");
                goto ds4ui_pld_failed;
            }

            bool stop_block = false;
            bool restart_sampling = false;
            for (int ti = 0; ti < ntok && generated < max_tokens; ti++) {
                if (worker_should_interrupt(w)) {
                    if (DS4UI_AGENT_PLD_REWIND(w->session, &pld_tx, block_start + ti,
                                         err, sizeof(err)) != 0)
                        goto ds4ui_pld_failed;
                    stop_block = true;
                    break;
                }
                token = toks[ti];
                if (ds4_token_is_stop_for_think_mode(w->engine,
                                                     token,
                                                     think_mode)) {
                    if (DS4UI_AGENT_PLD_REWIND(w->session, &pld_tx, block_start + ti,
                                          err, sizeof(err)) != 0)
                        goto ds4ui_pld_failed;
                    stop_block = true;
                    break;
                }

                size_t text_len = 0;
                char *text = ds4_token_text(w->engine, token, &text_len);
                if (cfg->edit_upto &&
                    agent_edit_upto_forcer_should_replace(&upto_forcer,
                                                           &dsml,
                                                           text,
                                                           text_len))
                {
                    agent_trace(w,
                                "edit old auto-upto replaced token=%d text=%.*s",
                                token,
                                (int)(text_len > 80 ? 80 : text_len),
                                text);
                    free(text);
                    if (DS4UI_AGENT_PLD_REWIND(w->session, &pld_tx, block_start + ti,
                                          err, sizeof(err)) != 0)
                        goto ds4ui_pld_failed;
                    if (worker_force_generated_text(w, "[upto]\n", max_tokens,
                                                    &generated, t0, &stream,
                                                    err, sizeof(err)) != 0) {
                        goto ds4ui_pld_failed;
                    }
                    restart_sampling = true;
                    break;
                }
                free(text);
                if (worker_finish_generated_token(w, token, &generated, t0,
                                                  &stream, false,
                                                  err, sizeof(err)) != 0) {
                    goto ds4ui_pld_failed;
                }

                const bool next_greedy =
                    agent_stream_wants_greedy_sampling(&stream);
                if (next_greedy != status_greedy_sampling) {
                    worker_set_greedy_sampling(w, next_greedy);
                    status_greedy_sampling = next_greedy;
                }

                if (dsml.state == AGENT_DSML_DONE) {
                    got_tool = true;
                    stop_block = true;
                } else if (stream.tool_preflight_error) {
                    early_tool_error = true;
                    stop_block = true;
                } else if (dsml.state == AGENT_DSML_ERROR ||
                           stream.dsml_in_think) {
                    malformed_tool = true;
                    stop_block = true;
                }
                if (stop_block) {
                    if (ti + 1 < ntok) {
                        if (DS4UI_AGENT_PLD_REWIND(w->session, &pld_tx, block_start + ti + 1,
                                          err, sizeof(err)) != 0)
                        goto ds4ui_pld_failed;
                    }
                    break;
                }

                if (ti + 1 < ntok && next_greedy != greedy_sampling) {
                    /* Later tokens were proposed under the old parser mode.
                     * Re-evaluate this boundary token to restore its logits,
                     * then sample the suffix under the new mode. */
                    if (DS4UI_AGENT_PLD_REWIND(w->session, &pld_tx, block_start + ti,
                                          err, sizeof(err)) != 0)
                        goto ds4ui_pld_failed;
                    if (ds4_session_eval(w->session, token,
                                         err, sizeof(err)) != 0) {
                        goto ds4ui_pld_failed;
                    }
                    restart_sampling = true;
                    break;
                }
            }
            ds4ui_pld_release(&pld_tx);
            if (stop_block) break;
            if (restart_sampling) continue;
            continue;

ds4ui_pld_failed:
            if ((pld_tx.active || ds4_session_pos(w->session) > w->transcript.len) &&
                DS4UI_AGENT_PLD_REWIND(w->session, &pld_tx, w->transcript.len,
                                 err, sizeof(err)) != 0)
                ds4_session_invalidate(w->session);
            ds4ui_pld_release(&pld_tx);
            agent_dsml_parser_free(&dsml);
            agent_set_error(w, err);
            return 1;
        }
        agent_trace(w, "PLD lookups=%llu hits=%llu proposed=%llu matches=%llu batches=%llu fallback=%llu",
                    (unsigned long long)pld.lookups, (unsigned long long)pld.hits,
                    (unsigned long long)pld.proposed, (unsigned long long)pld.accepted,
                    (unsigned long long)pld.batches, (unsigned long long)pld.fallbacks);
#undef DS4UI_AGENT_PLD_REWIND
