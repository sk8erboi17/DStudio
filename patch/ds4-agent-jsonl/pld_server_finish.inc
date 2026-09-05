        /* Never leave an unconsumed verified suffix in a reusable live
         * session. Stop strings truncate visible bytes, not necessarily whole
         * tokens, so preserve upstream's invalidation after any replay. */
        if (pld_tx.active) {
            pthread_mutex_lock(&s->inference_mu);
            int consumed = completion - pld_completion_start;
            if (consumed < ntok && ds4ui_pld_rewind(slot->session, &pld_tx,
                    pld_tx.start + consumed, err, sizeof(err)) != 0) {
                finish = "error";
                stop_decode = true;
            }
            if (pld_discard || g_stop_requested || job_cancelled(j) ||
                strcmp(finish, "error") == 0)
                ds4_session_invalidate(slot->session);
            pthread_mutex_unlock(&s->inference_mu);
        }
        ds4ui_pld_release(&pld_tx);
