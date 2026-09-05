            /* The entire request must be greedy. A greedy tool envelope in
             * an otherwise sampled request is insufficient. ignore_eos has
             * a different argmax contract and keeps its original path. */
            const bool eligible = pld_mode != DS4UI_PLD_OFF &&
                !s->batched_mode && s->slot_count == 1 && !multimodal &&
                !j->req.ignore_eos && temperature == 0.0f &&
                j->req.temperature == 0.0f &&
                (!ds4_think_mode_enabled(j->req.think_mode) || j->req.temperature_set) &&
                ds4ui_pld_can_verify(slot->session);
            int candidates[DS4UI_PLD_DRAFT + 1] = {token};
            const ds4_tokens *history = ds4_session_tokens(slot->session);
            int drafted = eligible ? ds4ui_pld_propose(&pld, history->v,
                history->len, token, candidates + 1, max_tokens - completion - 1) : 0;
            for (int i = 1; i <= drafted; i++) {
                if (ds4_token_is_stop_for_think_mode(s->engine, candidates[i],
                                                     j->req.think_mode)) {
                    drafted = i - 1;
                    break;
                }
            }
            if (pld_mode == DS4UI_PLD_BATCH && drafted > 0 &&
                !g_stop_requested && !job_cancelled(j)) {
                pthread_mutex_lock(&s->inference_mu);
                ntok = ds4ui_pld_verify(slot->session, candidates, drafted + 1,
                                       &pld_tx, err, sizeof(err));
                pthread_mutex_unlock(&s->inference_mu);
                if (ntok < 0) {
                    ds4ui_pld_release(&pld_tx);
                    finish = "error";
                    break;
                }
                if (ntok > 0) {
                    memcpy(toks, candidates, (size_t)ntok * sizeof(int));
                    pld.batches++;
                    ds4ui_pld_note(&pld, ntok - 1);
                } else {
                    pld.fallbacks++;
                    pld.cooldown = 16;
                }
            }
            if (ntok == 0) {
                if (server_eval_token(s, slot, token, err, sizeof(err)) != 0) {
                    finish = "error";
                    break;
                }
                toks[0] = token;
                ntok = 1;
                if (pld_mode == DS4UI_PLD_STRICT && drafted > 0)
                    ds4ui_pld_note(&pld,
                        ds4_session_argmax(slot->session) == candidates[1] ? 1 : 0);
            }
