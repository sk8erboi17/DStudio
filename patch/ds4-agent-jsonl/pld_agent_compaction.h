/* Included inside the native generation function on upstream branches with
 * assistant continuation across compaction. pld_agent.inc consumes/undefines
 * these hooks. Keep the same 32-token reserve and the user's remaining limit;
 * no runtime flag or alternate compaction semantics is introduced. */
#define DS4UI_AGENT_PLD_MODEL_STOPPED() (model_stopped = true)
#define DS4UI_AGENT_PLD_COMPACTION_LOOKAHEAD() do { \
    if (context_limited && generated == max_tokens && \
        compaction_lookahead < 32 && \
        agent_stream_compaction_needs_lookahead(&stream)) { \
        max_tokens++; \
        compaction_lookahead++; \
        if (max_tokens == cfg->gen.n_predict - carried_generation) \
            context_limited = false; \
    } \
} while (0)
