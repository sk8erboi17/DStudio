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

int main(void) {
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
    remote_cfg.ssd_streaming = SSD_STREAMING_ON;
    char ssd_reason[192] = "", ssd_err[256] = "";
    assert(engine_effective_ssd_streaming(&remote_cfg, 1, ssd_reason, sizeof ssd_reason,
                                          ssd_err, sizeof ssd_err) == -1);
    assert(strstr(ssd_err, "local-engine-only") != NULL);

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
