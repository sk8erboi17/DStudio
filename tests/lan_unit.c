#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif

#include <assert.h>
#include <stdio.h>
#include <string.h>

#define main dstudio_embedded_main_for_tests
#include "../src/dstudio.c"
#undef main

static uint32_t ip4(const char *s) {
    struct in_addr a;
    assert(inet_pton(AF_INET, s, &a) == 1);
    return ntohl(a.s_addr);
}

static int test_valid_utf8(const unsigned char *s) {
    while (*s) {
        if (*s < 0x80) { s++; continue; }
        int continuation = 0;
        if ((*s & 0xe0) == 0xc0) continuation = 1;
        else if ((*s & 0xf0) == 0xe0) continuation = 2;
        else if ((*s & 0xf8) == 0xf0) continuation = 3;
        else return 0;
        s++;
        for (int i = 0; i < continuation; i++, s++)
            if ((*s & 0xc0) != 0x80) return 0;
    }
    return 1;
}

int main(void) {
#ifndef _WIN32
    {
        int plen[] = { 7000, 4000 };
        pdf_rag_chunk *chunks = NULL;
        int n = pdf_build_rag_chunks(plen, 2, 2, &chunks);
        assert(n == 5);
        assert(chunks[0].page == 0 && chunks[0].start == 0 && chunks[0].len == 3200);
        assert(chunks[1].page == 0 && chunks[1].start == 2700);
        assert(chunks[2].page == 0 && chunks[2].start == 5400 && chunks[2].len == 1600);
        assert(chunks[3].page == 1 && chunks[3].start == 0);
        assert(chunks[4].page == 1 && chunks[4].start == 2700 && chunks[4].len == 1300);
        free(chunks);

        const char *pages[] = { "abcdefghij", "klmnopqrst", "uvwxyzABCD" };
        int short_len[] = { 10, 10, 10 };
        pdf_rag_chunk middle = { 1, 0, 10 };
        char *window = pdf_rag_chunk_text(pages, short_len, 3, &middle);
        assert(window);
        assert(strstr(window, "Previous page tail:\nabcdefghij") != NULL);
        assert(strstr(window, "Physical PDF page 2 passage:\nklmnopqrst") != NULL);
        assert(strstr(window, "Next page head:\nuvwxyzABCD") != NULL);
        free(window);

        /* Every independently chosen byte boundary must be moved to a UTF-8
         * code-point boundary before it is JSON-escaped for the sidecar. */
        char prev_utf8[322], next_utf8[323];
        memset(prev_utf8, 'p', sizeof prev_utf8 - 1);
        prev_utf8[0] = (char)0xe2; prev_utf8[1] = (char)0x80; prev_utf8[2] = (char)0x94;
        prev_utf8[321] = '\0';
        memset(next_utf8, 'n', sizeof next_utf8 - 1);
        next_utf8[318] = (char)0xe2; next_utf8[319] = (char)0x80; next_utf8[320] = (char)0x94;
        next_utf8[322] = '\0';
        const char current_utf8[] = { (char)0xe2, (char)0x80, (char)0x94,
                                      'b', 'o', 'd', 'y', '\0' };
        const char *utf8_pages[] = { prev_utf8, current_utf8, next_utf8 };
        int utf8_len[] = { 321, 7, 322 };
        pdf_rag_chunk split_middle = { 1, 1, 6 };
        window = pdf_rag_chunk_text(utf8_pages, utf8_len, 3, &split_middle);
        assert(window);
        assert(test_valid_utf8((const unsigned char *)window));
        assert(strstr(window, "Physical PDF page 2 passage:\nbody") != NULL);
        free(window);

        pdf_rag_term terms[PDF_RAG_MAX_QUERY_TERMS] = {0};
        int nt = pdf_rag_terms("HNSW nearest-neighbor nearest", terms,
                               PDF_RAG_MAX_QUERY_TERMS);
        assert(nt == 3); /* duplicate query terms are collapsed */
        int first = -1;
        pdf_rag_term cat = { "cat", 3, 0 };
        int count = 0;
        pdf_rag_term_counts("cat concatenate CAT", 19, &cat, 1, &count, &first);
        assert(count == 2);
        assert(first == 0);

        int scores[PDF_MAX_TOTAL_PAGES];
        unsigned char selected[PDF_MAX_TOTAL_PAGES];
        for (int i = 0; i < PDF_MAX_TOTAL_PAGES; i++) scores[i] = INT_MIN;
        scores[0] = 100; scores[1] = 99; scores[2] = 20;
        scores[4] = 40; scores[5] = 98; scores[6] = 35;
        scores[8] = 30; scores[9] = 97; scores[10] = 25;
        assert(pdf_select_semantic_pages(selected, scores, 0, 10, 6) == 6);
        assert(selected[0] && selected[5] && selected[9]);
    }
#endif
#ifndef _WIN32
    char lock_path[] = "/tmp/dstudio-lock-test.XXXXXX";
    int lock_fd = mkstemp(lock_path);
    assert(lock_fd >= 0);
    assert(setenv("DS4_LOCK_FILE", lock_path, 1) == 0);
    assert(flock(lock_fd, LOCK_EX | LOCK_NB) == 0);
    assert(ftruncate(lock_fd, 0) == 0);
    dprintf(lock_fd, "%ld\n", (long)getpid());
    assert(ds4_instance_lock_owner() == getpid());
    assert(flock(lock_fd, LOCK_UN) == 0);
    assert(ds4_instance_lock_owner() == 0);
    close(lock_fd);
    unlink(lock_path);
    unsetenv("DS4_LOCK_FILE");
#endif
    assert(!ipv4_usable_lan(ip4("127.0.0.1")));
    assert(!ipv4_usable_lan(ip4("169.254.1.10")));
    assert(ipv4_usable_lan(ip4("192.168.1.10")));
    assert(ipv4_usable_lan(ip4("25.17.235.135")));

    assert(ipv4_private_lan(ip4("10.1.2.3")));
    assert(ipv4_private_lan(ip4("192.168.1.207")));
    assert(ipv4_private_lan(ip4("172.16.0.1")));
    assert(ipv4_private_lan(ip4("172.31.255.254")));
    assert(!ipv4_private_lan(ip4("172.32.0.1")));
    assert(!ipv4_private_lan(ip4("25.17.235.135")));

    char out[INET_ADDRSTRLEN];
    assert(lan_ip_text(" 192.168.1.207\n", out, sizeof out));
    assert(strcmp(out, "192.168.1.207") == 0);
    assert(lan_ip_text("\t25.17.235.135 extra\n", out, sizeof out));
    assert(strcmp(out, "25.17.235.135") == 0);
    assert(!lan_ip_text("127.0.0.1\n", out, sizeof out));
    assert(!lan_ip_text("169.254.5.7\n", out, sizeof out));
    assert(!lan_ip_text("not-an-ip\n", out, sizeof out));

    const char *glm_catalog =
        "HTTP/1.1 200 OK\r\n\r\n{\"data\":[{\"id\":\"glm-5.3-flash\",\"owned_by\":\"ds4.c\"}]}";
    const char *deepseek_catalog =
        "HTTP/1.1 200 OK\r\n\r\n{\"data\":[{\"id\":\"deepseek-v4-flash\",\"owned_by\":\"ds4.c\"}]}";
    const char *laguna_catalog =
        "HTTP/1.1 200 OK\r\n\r\n{\"data\":[{\"id\":\"laguna-s-2.1\",\"owned_by\":\"ds4.c\"}]}";
    snprintf(g_model_override, sizeof g_model_override, "%s", MODEL_GLM53_Q2);
    assert(ds4_catalog_matches_selected_model(glm_catalog));
    assert(!ds4_catalog_matches_selected_model(deepseek_catalog));
    snprintf(g_model_override, sizeof g_model_override, "%s", MODEL_LAGUNA);
    assert(ds4_catalog_matches_selected_model(laguna_catalog));
    assert(!ds4_catalog_matches_selected_model(glm_catalog));
    snprintf(g_model_override, sizeof g_model_override, "%s", MODEL_FLASH);
    assert(ds4_catalog_matches_selected_model(deepseek_catalog));
    assert(!ds4_catalog_matches_selected_model(glm_catalog));
    g_model_override[0] = '\0';

#ifndef _WIN32
    char data_dir[] = "/tmp/dstudio-port-test.XXXXXX";
    assert(mkdtemp(data_dir));
    assert(setenv("DS4UI_DATA_DIR", data_dir, 1) == 0);
    assert(persist_http_port(15550));
    char port_file[PATH_MAX];
    snprintf(port_file, sizeof port_file, "%s/http-port", data_dir);
    FILE *pf = fopen(port_file, "rb");
    assert(pf);
    int saved_port = 0;
    assert(fscanf(pf, "%d", &saved_port) == 1 && saved_port == 15550);
    fclose(pf);
    unlink(port_file);
    rmdir(data_dir);
    unsetenv("DS4UI_DATA_DIR");
#endif

    assert(lan_client_id_ok("client-abc_123.test"));
    assert(!lan_client_id_ok("ab"));
    assert(!lan_client_id_ok("client with spaces"));
    assert(!lan_client_id_ok("client/slash"));

    char err[256] = {0};
    assert(parse_remote_start(
        "{\"modelBackend\":\"remote\",\"remoteBaseUrl\":\"http://25.17.235.135:5500\",\"remoteModel\":\"ds4\"}",
        1, err, sizeof err));
    assert(strcmp(g_remote_base_url, "http://25.17.235.135:5500") == 0);
    assert(strcmp(g_remote_model, "ds4") == 0);
    assert(parse_remote_start(
        "{\"modelBackend\":\"remote\",\"remoteBaseUrl\":\"https://25.17.235.135:5500\"}",
        1, err, sizeof err));
    assert(strcmp(g_remote_base_url, "https://25.17.235.135:5500") == 0);
    assert(!parse_remote_start(
        "{\"modelBackend\":\"remote\",\"remoteBaseUrl\":\"http://25.17.235.135:5500\"}",
        0, err, sizeof err));
    assert(strstr(err, "only valid for agent/design") != NULL);
    assert(!parse_remote_start("{\"lanClient\":true}", 1, err, sizeof err));
    assert(strstr(err, "remote model host") != NULL);
    assert(parse_remote_start("{}", 1, err, sizeof err));
    assert(g_remote_base_url[0] == '\0');
    assert(g_remote_model[0] == '\0');

    engine_cfg remote_cfg = ENGINE_DEFAULTS;
    assert(ENGINE_DEFAULTS.uncensored == 0);
    assert(ENGINE_DEFAULTS.ctx == 65536);
    assert(strcmp(MODEL_FLASH, MODEL_STD) == 0);
    assert(strcmp(MODEL_FLASH, MODEL_UNC) != 0);
    assert(strcmp(variant_rel("flash"), MODEL_STD) == 0);
    engine_cfg parsed_default = ENGINE_DEFAULTS;
    int parsed_bad = 0;
    parse_cfg("{}", &parsed_default, &parsed_bad);
    assert(!parsed_bad && parsed_default.uncensored == 0);

    const unsigned long long gib = 1024ull * 1024ull * 1024ull;
    assert(flash_context_memory_bytes(65536) < gib);
    assert(flash_context_memory_bytes(1048576) > 10ull * gib);
    assert(flash_context_memory_bytes(1048576) < 11ull * gib);
    assert(flash_largest_safe_context(1048576, 86720111488ull, 0, 88ull * gib) == 262144);
    assert(flash_largest_safe_context(1048576, 86720111488ull, 5989114272ull, 88ull * gib) == 0);
#ifdef __APPLE__
    if (file_present(MODEL_STD) && file_present(MODEL_DSPARK_UPSTREAM) &&
        local_metal_budget_bytes() > 0) {
        engine_cfg oversized = ENGINE_DEFAULTS;
        oversized.ctx = 1048576;
        oversized.ssd_streaming = SSD_STREAMING_OFF;
        g_dspark_enabled = 1;
        char adjustment[384] = "";
        assert(normalize_flash_memory_config(&oversized, 0, adjustment, sizeof adjustment));
        assert(!g_dspark_enabled);
        assert(oversized.ctx == 1048576);
        assert(strstr(adjustment, "DSpark disabled") != NULL);
        assert(strstr(adjustment, "preserving the requested") != NULL);
    }
#endif

    remote_cfg.ssd_streaming = SSD_STREAMING_ON;
    char ssd_reason[192] = "", ssd_err[256] = "";
    assert(engine_effective_ssd_streaming(&remote_cfg, 1, ssd_reason, sizeof ssd_reason,
                                          ssd_err, sizeof ssd_err) == -1);
    assert(strstr(ssd_err, "local-engine-only") != NULL);
    remote_cfg.ssd_streaming = SSD_STREAMING_AUTO;
    g_dspark_enabled = 1;
    assert(engine_effective_ssd_streaming(&remote_cfg, 0, ssd_reason, sizeof ssd_reason,
                                          ssd_err, sizeof ssd_err) == 0);
    assert(strstr(ssd_reason, "DSpark") != NULL);
    remote_cfg.ssd_streaming = SSD_STREAMING_ON;
    assert(engine_effective_ssd_streaming(&remote_cfg, 0, ssd_reason, sizeof ssd_reason,
                                          ssd_err, sizeof ssd_err) == -1);
    assert(strstr(ssd_err, "DSpark") != NULL);
    g_dspark_enabled = 0;
    remote_cfg.ssd_streaming = SSD_STREAMING_AUTO;
    assert(engine_effective_ssd_streaming(&remote_cfg, 0, ssd_reason, sizeof ssd_reason,
                                          ssd_err, sizeof ssd_err) == 0);
    assert(strstr(ssd_reason, "sole active heavyweight model") != NULL);

    snprintf(g_bind_host, sizeof g_bind_host, "127.0.0.1");
    assert(lan_public_path_allowed("GET", "/"));
    assert(lan_public_path_allowed("GET", "/remote"));
    assert(lan_public_path_allowed("POST", "/api/remote/chat"));
    assert(lan_public_path_allowed("POST", "/api/lan-client/chats"));
    assert(lan_public_path_allowed("OPTIONS", "/api/lan-client/chats"));
    assert(lan_public_path_allowed("GET", "/api/lan-health"));
    assert(lan_public_path_allowed("OPTIONS", "/api/lan-health"));
    assert(!lan_public_path_allowed("POST", "/api/lan-health"));
    assert(!lan_public_path_allowed("POST", "/api/web-search"));
    assert(!lan_public_path_allowed("POST", "/api/web-read"));
    assert(!lan_public_path_allowed("POST", "/api/http-probe"));
    assert(!lan_public_path_allowed("OPTIONS", "/api/web-search"));
    assert(!lan_public_path_allowed("GET", "/api/store"));
    assert(!lan_public_path_allowed("GET", "/api/lan-client/chats"));
    assert(!lan_public_path_allowed("GET", "/v1/models"));

    snprintf(g_bind_host, sizeof g_bind_host, "0.0.0.0");
    assert(lan_public_path_allowed("GET", "/v1/models"));
    assert(lan_public_path_allowed("POST", "/v1/chat/completions"));
    assert(lan_public_path_allowed("POST", "/api/web-search"));
    assert(lan_public_path_allowed("POST", "/api/web-read"));
    assert(lan_public_path_allowed("POST", "/api/http-probe"));
    assert(lan_public_path_allowed("OPTIONS", "/api/web-search"));
    assert(lan_public_path_allowed("OPTIONS", "/api/web-read"));
    assert(lan_public_path_allowed("OPTIONS", "/api/http-probe"));
    assert(!lan_public_path_allowed("OPTIONS", "/api/start"));
    assert(!lan_public_path_allowed("POST", "/api/start"));
    assert(!lan_public_path_allowed("POST", "/api/fs/list"));
    assert(!lan_public_path_allowed("GET", "/api/design/files"));
    assert(!lan_public_path_allowed("GET", "/api/store"));
    assert(!lan_public_path_allowed("POST", "/api/lan"));

    char cwd[DSTUDIO_PATH_MAX];
    assert(getcwd(cwd, sizeof cwd) != NULL);
    assert(setenv("DS4UI_PAGE_FROM_DISK", "1", 1) == 0);
    assert(chdir("tests/.build") == 0);
    size_t page_len = 0;
    char *page = read_page(&page_len);
    assert(page && page_len > 1000);
    free(page);
    size_t loading_len = 0;
    char *loading = read_loading_page(&loading_len);
    assert(loading && loading_len > 1000);
    free(loading);
    assert(chdir(cwd) == 0);
    unsetenv("DS4UI_PAGE_FROM_DISK");

    int start = 25000 + (int)(getpid() % 20000);
    int p1 = start;
    int fd1 = open_first_listener("127.0.0.1", &p1);
    assert(fd1 >= 0);
#ifndef _WIN32
    assert((fcntl(fd1, F_GETFD, 0) & FD_CLOEXEC) != 0);
#endif
    int p2 = p1;
    int fd2 = open_first_listener("127.0.0.1", &p2);
    assert(fd2 >= 0);
    assert(p2 > p1);
    close(fd1);
    close(fd2);

    puts("lan_unit: ok");
    return 0;
}
