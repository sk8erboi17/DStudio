/* Real HTTP serializer over a socketpair, not inferred from source strings. */
#define Q36_SERVER_TEST
#define Q36_SERVER_TEST_NO_MAIN
#include "q36_server.c"

q36_engine *dstudio_catalog_engine(unsigned family);
q36_session *dstudio_catalog_session(void);

int main(int argc, char **argv) {
    if (argc != 3) return 2;
    unsigned family = (unsigned)atoi(argv[1]);
    if (family > 2) return 2;
    int pair[2];
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, pair)) return 3;
    server srv = {0};
    srv.engine = dstudio_catalog_engine(family);
    srv.ctx_size = q36_session_ctx(dstudio_catalog_session());
    srv.default_tokens = 256;
    bool sent = !strcmp(argv[2], "list") ? send_models(&srv, pair[0]) : send_model(&srv, pair[0]);
    if (!sent) return 4;
    shutdown(pair[0], SHUT_WR);
    char bytes[8192];
    ssize_t n;
    while ((n = read(pair[1], bytes, sizeof bytes)) > 0)
        if (fwrite(bytes, 1, (size_t)n, stdout) != (size_t)n) return 5;
    close(pair[0]); close(pair[1]);
    return n < 0 ? 6 : 0;
}
