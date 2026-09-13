/* Execute native admission with initialized, bounded state and no inference.
 * CPU buffers are real. GPU backends here are state fixtures, not GPU tests;
 * the separate full-model vision probe exercises actual Metal cancellation. */
#define Q36_NO_GPU
#include "q36.c"

static int checks, failures, cases;
#define CHECK(value) do { checks++; if (!(value)) { failures++; \
    fprintf(stderr, "FAIL case %d line %d: %s\n", cases, __LINE__, #value); } } while (0)
static bool cancelled(void *ud) { (*(int *)ud)++; return true; }

static void run_case(q36_backend backend, int scenario) {
    int visits = 0, old_tokens[] = {1, 2, 3}, new_tokens[] = {4, 2, 3, 7, 0, 0};
    float hidden[8], next[8], conv[24], state[8], logits[8], embedding[8];
    for (int i = 0; i < 8; i++) hidden[i] = next[i] = state[i] = logits[i] = embedding[i] = i + 1;
    for (int i = 0; i < 24; i++) conv[i] = i + 1;
    q36_cpu_runtime runtime = {.hidden = hidden, .next_hidden = next};
    runtime.full[0].len = 3;
    runtime.recurrent[0].conv = conv; runtime.recurrent[0].state = state;
    q36_engine engine = {.backend = backend, .vision_ready = true};
    engine.vocab.image_pad_id = 7;
    engine.vocab.vision_start_id = 6;
    engine.vocab.vision_end_id = 5;
    q36_session session = {.engine = &engine, .ctx_size = 32,
        .checkpoint = {.v = old_tokens, .len = 3, .cap = 3}, .checkpoint_valid = true,
        .logits = logits, .logits_host_valid = true, .gpu_top2_valid = true, .gpu_top2 = {2, 3},
        .runtime = &runtime, .mtp_draft_valid = true, .mtp_draft_token = 2, .rope_delta = 9};
    q36_tokens prompt = {.v = new_tokens, .len = 4, .cap = 6};
    q36_vision_span span = {.token_start = 3, .embedding = {.data = embedding,
        .token_count = 1, .grid_width = 1, .grid_height = 1}};
    if (scenario == 1 || scenario == 2 || scenario == 5) {
        memcpy(new_tokens, old_tokens, sizeof old_tokens);
        if (scenario != 1) prompt.len = 3;
    }
    if (scenario == 3) prompt.len = 32;
    if (scenario == 4) prompt.len = 0;
    if (scenario == 6 || scenario == 7) {
        /* A valid visual request includes its real start/end wrapper tokens.
         * Current upstream validates them before consulting cancellation.
         * Use the same valid fixture on the old and new core; malformed input
         * must remain an error, never become a cancellation success. */
        new_tokens[2] = engine.vocab.vision_start_id;
        new_tokens[4] = engine.vocab.vision_end_id;
        prompt.len = 6;
    }
    if (scenario == 7) span.token_start = UINT32_MAX;
    if (scenario == 8) session.vision_state = true;
    q36_session_set_cancel(&session, scenario == 5 ? NULL : cancelled, &visits);
    q36_session before;
    q36_cpu_runtime runtime_before;
    memcpy(&before, &session, sizeof before);
    memcpy(&runtime_before, &runtime, sizeof runtime_before);
    float hidden_before[8], next_before[8], conv_before[24], state_before[8], logits_before[8];
    memcpy(hidden_before, hidden, sizeof hidden); memcpy(next_before, next, sizeof next);
    memcpy(conv_before, conv, sizeof conv); memcpy(state_before, state, sizeof state);
    memcpy(logits_before, logits, sizeof logits);
    char error[64] = {0};
    cases++;
    int result = scenario == 6 || scenario == 7 ?
        q36_session_sync_vision(&session, &prompt, &span, 1, error, sizeof error) :
        q36_session_sync(&session, &prompt, error, sizeof error);
    bool invalid = scenario == 3 || scenario == 4 || scenario == 7;
    CHECK(result == (invalid ? 1 : scenario == 5 ? 0 : Q36_SESSION_SYNC_INTERRUPTED));
    CHECK(visits == (invalid || scenario == 5 ? 0 : 1));
    CHECK(memcmp(&before, &session, sizeof session) == 0);
    CHECK(memcmp(&runtime_before, &runtime, sizeof runtime) == 0);
    CHECK(memcmp(hidden_before, hidden, sizeof hidden) == 0 && memcmp(next_before, next, sizeof next) == 0);
    CHECK(memcmp(conv_before, conv, sizeof conv) == 0 && memcmp(state_before, state, sizeof state) == 0);
    CHECK(memcmp(logits_before, logits, sizeof logits) == 0);
    CHECK(old_tokens[0] == 1 && old_tokens[1] == 2 && old_tokens[2] == 3);
}

int main(void) {
    g_q36_shape = Q36_SHAPE_27B;
    g_q36_shape.n_layer = 1; g_q36_shape.n_embd = 8; g_q36_shape.n_vocab = 8;
    g_q36_shape.n_ssm_state = 2; g_q36_shape.n_ssm_dt_rank = 2;
    g_q36_shape.n_ssm_conv = 4; g_q36_shape.n_ssm_group = 1; g_q36_shape.n_ssm_inner = 4;
    const q36_backend backends[] = {Q36_BACKEND_CPU, Q36_BACKEND_METAL, Q36_BACKEND_VULKAN};
    for (unsigned b = 0; b < sizeof backends / sizeof *backends; b++)
        for (int scenario = 0; scenario < (b ? 9 : 6); scenario++) run_case(backends[b], scenario);
    printf("{\"cases\":%d,\"checks\":%d,\"failures\":%d}\n", cases, checks, failures);
    return failures ? 1 : 0;
}
