/* Real production store worker and file publication, no model or user store. */
#define _GNU_SOURCE
#include <assert.h>
#define DSTUDIO_CHAT_STORE_TEST 1
#define main dstudio_embedded_main_for_store_tests
#include "../../src/dstudio.c"
#undef main

static pthread_mutex_t barrier_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t barrier_condition = PTHREAD_COND_INITIALIZER;
static int barrier_entered, barrier_release;
static void before_publish(void) {
    pthread_mutex_lock(&barrier_lock);
    barrier_entered = 1; pthread_cond_broadcast(&barrier_condition);
    while (!barrier_release) pthread_cond_wait(&barrier_condition, &barrier_lock);
    pthread_mutex_unlock(&barrier_lock);
}
static int peer;
static int response_socket(void) {
    int pair[2]; assert(socketpair(AF_UNIX, SOCK_STREAM, 0, pair) == 0);
    peer = pair[1]; return pair[0];
}
static void finish_write(void) {
    for (int i = 0; g_store_write && i < 10000; i++) { chat_store_tick(); usleep(1000); }
    assert(!g_store_write);
}
static void expect_response(int client, const char *status, const char *text) {
    char response[2048]; size_t used = 0; ssize_t count;
    while ((count = read(client, response + used, sizeof response - used - 1)) > 0) {
        used += (size_t)count; assert(used < sizeof response - 1);
    }
    response[used] = 0; close(client);
    assert(strstr(response, status)); assert(strstr(response, text));
}
static void assert_file(const char *expected) {
    char path[2048]; store_file_path(path, sizeof path);
    FILE *file = fopen(path, "rb"); assert(file);
    assert(fseek(file, 0, SEEK_END) == 0); long size = ftell(file); rewind(file);
    assert(size == (long)strlen(expected));
    char *bytes = malloc((size_t)size + 1); assert(bytes);
    assert(fread(bytes, 1, (size_t)size, file) == (size_t)size);
    assert(!memcmp(bytes, expected, (size_t)size)); free(bytes); fclose(file);
}
int main(void) {
    signal(SIGPIPE, SIG_IGN);
    char profile[] = "/tmp/dstudio-chat-store-XXXXXX"; assert(mkdtemp(profile));
    assert(setenv("DS4UI_DATA_DIR", profile, 1) == 0);
    const char *first = "{\"v\":2,\"chats\":[{\"id\":\"retained\",\"text\":\"original\"}],\"deleted\":[]}";
    g_store_before_publish = before_publish;
    int fd = response_socket(), first_peer = peer;
    assert(api_store_set(fd, strdup(first), strlen(first), 0));
    pthread_mutex_lock(&barrier_lock);
    while (!barrier_entered) pthread_cond_wait(&barrier_condition, &barrier_lock);
    pthread_mutex_unlock(&barrier_lock);
    char byte; assert(recv(first_peer, &byte, 1, MSG_DONTWAIT) < 0 && (errno == EAGAIN || errno == EWOULDBLOCK));
    assert(g_store == NULL && g_store_rev == 0);
    // These independent owner paths must complete while file publication is
    // deterministically blocked. No timing threshold substitutes for the gate.
    fd = response_socket(); api_store_get(fd); close(fd); expect_response(peer, "200 OK", "\"data\":null");
    fd = response_socket(); assert(!api_store_set(fd, strdup(first), strlen(first), 0)); close(fd); expect_response(peer, "409 Conflict", "store_busy");
    fd = response_socket(); assert(!api_wipe(fd)); close(fd); expect_response(peer, "409 Conflict", "store_busy");
    pthread_mutex_lock(&barrier_lock); barrier_release = 1; pthread_cond_broadcast(&barrier_condition); pthread_mutex_unlock(&barrier_lock);
    finish_write(); expect_response(first_peer, "200 OK", "\"durable\":true");
    assert(g_store_rev == 1 && !strcmp(g_store, first)); assert_file(first);
    g_store_before_publish = NULL;

    fd = response_socket(); assert(!api_store_set(fd, strdup("{}"), 2, 0)); close(fd); expect_response(peer, "409 Conflict", "store_conflict");
    assert_file(first); assert(g_store_rev == 1);
    fd = response_socket(); assert(api_store_set(fd, strdup("{broken"), 7, 1)); finish_write(); expect_response(peer, "400 Bad Request", "store_invalid");
    assert_file(first); assert(g_store_rev == 1);

    g_store_test_write_failure = 1;
    fd = response_socket(); assert(api_store_set(fd, strdup("{}"), 2, 1)); finish_write(); expect_response(peer, "503 Service Unavailable", "store_write_failed");
    assert_file(first); assert(g_store_rev == 1 && !strcmp(g_store, first));
    g_store_test_write_failure = 0;
    g_store_test_directory_failure = 1;
    fd = response_socket(); assert(api_store_set(fd, strdup("{\"uncertain\":true}"), 18, 1)); finish_write(); expect_response(peer, "503 Service Unavailable", "store_durability_unknown");
    assert_file("{\"uncertain\":true}"); assert(g_store_rev == 2 && !strcmp(g_store, "{\"uncertain\":true}"));
    g_store_test_directory_failure = 0;

    const size_t padding = 8 * 1024 * 1024;
    char *large = malloc(padding + 32); assert(large);
    memcpy(large, "{\"body\":\"", 9); memset(large + 9, 'x', padding); memcpy(large + 9 + padding, "\"}", 3);
    fd = response_socket(); assert(api_store_set(fd, strdup(large), strlen(large), 2)); finish_write(); expect_response(peer, "200 OK", "\"durable\":true");
    assert_file(large); free(g_store); g_store = NULL; g_store_len = 0; g_store_rev = 0;
    store_load(); assert(g_store_len == strlen(large) && !strcmp(g_store, large)); free(large);

    g_child = 1; // A live runtime makes KV clearing inapplicable; no engine ran.
    fd = response_socket(); assert(api_wipe(fd)); finish_write(); expect_response(peer, "200 OK", "\"kvCleared\":false");
    g_child = -1;
    assert(strstr(g_store, "\"chats\":[]")); assert_file(g_store);
    char path[2048]; store_file_path(path, sizeof path); assert(!unlink(path)); assert(!rmdir(profile));
    free(g_store); g_store = NULL; g_store_len = 0;
    puts("PASS: durable native history, 8 MiB restart, atomic failure preservation, invalid JSON, revision/busy refusal, responsive owner under a blocked writer, uncertain directory sync and serialized wipe (no model)");
    return 0;
}
