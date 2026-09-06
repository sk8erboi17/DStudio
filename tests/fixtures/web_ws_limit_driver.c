/* This includes the produced source to exercise the actual frame reader using
 * a socket pair. No source-string assertions and no live remote server needed. */
#define _GNU_SOURCE
#include <assert.h>
#include "ds4_web_ds4ui.c"

static void frame_header(int fd, bool fin, uint64_t length) {
    unsigned char header[10] = { (unsigned char)(fin ? 0x80 : 0x01), 127 };
    for (int i = 0; i < 8; i++) header[i + 2] = (unsigned char)(length >> (56 - 8 * i));
    assert(web_write_all(fd, header, sizeof header) == 0);
}

int main(void) {
    int pair[2]; assert(socketpair(AF_UNIX, SOCK_STREAM, 0, pair) == 0);
    pid_t writer = fork(); assert(writer >= 0);
    if (!writer) {
        close(pair[0]);
        const size_t cap = DS4_WEB_MAX_RESULT_BYTES * 4;
        char *body = calloc(1, cap); assert(body);
        frame_header(pair[1], false, cap);
        assert(web_write_all(pair[1], body, cap) == 0);
        free(body);
        frame_header(pair[1], true, 1); /* each frame fits, whole message does not */
        close(pair[1]); _exit(0);
    }
    close(pair[1]);
    cdp_ws ws = { .fd = pair[0] };
    char error[256] = {0};
    char *message = web_ws_read_message(&ws, error, sizeof error);
    assert(!message && !strcmp(error, "websocket message too large"));
    close(pair[0]);
    int status; assert(waitpid(writer, &status, 0) == writer && WIFEXITED(status) && WEXITSTATUS(status) == 0);
    puts("web_ws_limit: fragmented response cannot exceed the aggregate byte budget");
    return 0;
}
