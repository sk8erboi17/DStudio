#include "session_state.h"
#include <string.h>

void session_init(session_state_t *state, const char *user) {
    if (state == 0) return;
    memset(state, 0, sizeof(*state));
    if (user != 0) {
        strcpy(state->user, user);
    }
}

int session_accept_payload(session_state_t *state, const char *payload, size_t len) {
    if (state == 0 || payload == 0) return 0;
    state->request_count++;
    if (len == 0) return 0;
    return state->authenticated || len < 512;
}
