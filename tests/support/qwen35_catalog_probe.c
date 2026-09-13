/* Execute native HTTP serialization with controlled metadata, not inference. */
#define DS4_SERVER_TEST
#define DS4_SERVER_TEST_NO_MAIN
#define ds4_engine_is_glm_dsa catalog_is_glm
#define ds4_engine_is_qwen35moe catalog_is_qwen
#define ds4_engine_model_id catalog_model_id
#define ds4_engine_model_name catalog_model_name
#include "ds4_server.c"

static int catalog_family;
bool catalog_is_glm(ds4_engine *e) { (void)e; return catalog_family == 1; }
bool catalog_is_qwen(ds4_engine *e) { (void)e; return catalog_family == 2; }
int catalog_model_id(ds4_engine *e) { (void)e; return 0; }
const char *catalog_model_name(ds4_engine *e) {
    (void)e;
    return catalog_family == 2 ? "Qwen3.6 35B A3B" :
           catalog_family == 1 ? "GLM 5.2" : "DeepSeek V4 Flash";
}

int main(int argc, char **argv) {
    if (argc != 2) return 2;
    catalog_family = atoi(argv[1]);
    int pair[2];
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, pair) != 0) return 3;
    server srv = {0};
    srv.ctx_size = 8192;
    srv.default_tokens = 256;
    if (!send_models(&srv, pair[0])) return 4;
    shutdown(pair[0], SHUT_WR);
    char bytes[4096];
    ssize_t count;
    while ((count = read(pair[1], bytes, sizeof bytes)) > 0)
        if (fwrite(bytes, 1, (size_t)count, stdout) != (size_t)count) return 5;
    close(pair[0]);
    close(pair[1]);
    return count < 0 ? 6 : 0;
}
