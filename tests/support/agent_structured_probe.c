/* Native adapter admission/lifetime boundaries. Compile next to the exact
 * derived Agent, using its own upstream objects. No inference or tool effects. */
#define DS4_AGENT_TEST
#define DS4_AGENT_TEST_NO_MAIN
#include <unistd.h>
#include <fcntl.h>
#include <string.h>
static ssize_t image_probe_read(int, void *, size_t);
static int image_probe_openat(int, const char *, int, ...);
static char *image_probe_strdup(const char *);
/* Test-only syscall barriers: mutate/cancel precisely between read and owner
 * revalidation, or swap a path after realpath but before openat. No sleeps. */
#define read image_probe_read
#define openat image_probe_openat
#define strdup image_probe_strdup
#include "agent-runtime.c"
#undef read
#undef openat
#undef strdup
#include <assert.h>

static size_t checks;
#define CHECK(x) do { checks++; if (!(x)) { fprintf(stderr, "structured:%d: %s\n", __LINE__, #x); exit(1); } } while (0)

static int image_read_action, image_open_swap, image_receipt_cancel;
static char *image_probe_strdup(const char *text) {
    char *value = strdup(text);
    if (image_receipt_cancel && !strncmp(text, "Image bytes attached", 20)) {
        image_receipt_cancel = 0; agent_sigint = 1;
    }
    return value;
}
static ssize_t image_probe_read(int fd, void *buffer, size_t size) {
    ssize_t n = read(fd, buffer, size);
    if (n > 0 && image_read_action) {
        int action = image_read_action; image_read_action = 0;
        if (action == 1) agent_sigint = 1;
        else if (action == 2) {
            int changed = open("sample.png", O_WRONLY); CHECK(changed >= 0);
            CHECK(ftruncate(changed, 9) == 0); close(changed);
        } else {
            CHECK(unlink("sample.png") == 0);
            CHECK(symlink("../outside.png", "sample.png") == 0);
        }
    }
    return n;
}
static int image_probe_openat(int fd, const char *path, int flags, ...) {
    if (image_open_swap && !strcmp(path, "sample.png")) {
        image_open_swap = 0;
        CHECK(unlink("sample.png") == 0);
        CHECK(symlink("../outside.png", "sample.png") == 0);
    }
    if (flags & O_CREAT) {
        va_list args; va_start(args, flags); mode_t mode = (mode_t)va_arg(args, int); va_end(args);
        return openat(fd, path, flags, mode);
    }
    return openat(fd, path, flags);
}

static void image_file(const char *path, const void *bytes, size_t size) {
    int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0600); CHECK(fd >= 0);
    CHECK(write(fd, bytes, size) == (ssize_t)size); CHECK(close(fd) == 0);
}
static void image_boundaries(void) {
    int saved_cwd = open(".", O_RDONLY | O_DIRECTORY); CHECK(saved_cwd >= 0);
    char temp[] = "structured-images.XXXXXX"; CHECK(mkdtemp(temp)); CHECK(chdir(temp) == 0);
    image_file("outside.png", "PRIVATE OUTSIDE BYTES", 21);
    CHECK(mkdir("workspace", 0700) == 0); CHECK(chdir("workspace") == 0);
    /* Header-level transport fixture, not evidence of PNG decoding/quality.
     * Real valid PNGs and an independent base64 oracle live in the host gate. */
    const char png[] = "\x89PNG\r\n\x1a\noriginal";
    image_file("sample.png", png, sizeof png - 1);
    image_file("text.txt", "not pixels", 10); image_file("empty.png", "", 0);
    CHECK(mkfifo("pipe.png", 0600) == 0);
    CHECK(symlink("../outside.png", "outside-link.png") == 0);
    CHECK(symlink("sample.png", "inside-link.png") == 0);
    agent_config cfg = {0}; agent_worker w = {.cfg = &cfg, .wake_fd = {-1, -1}};
    CHECK(pthread_mutex_init(&w.mu, NULL) == 0);
    ds4ui_msg_list messages = {0}; CHECK(ds4ui_msg_list_add(&messages, "system", "keep"));
    agent_tool_arg arg = {.name = "path", .value = "sample.png", .is_string = true};
    agent_tool_call call = {.name = "view_image", .args = &arg, .argc = 1};
    char receipt[512], *url;
    CHECK(setenv("DS4UI_REMOTE_VISION", "", 1) == 0);
    CHECK(!ds4ui_remote_image_prepare(&w, &messages, &call, receipt, sizeof receipt));
    CHECK(setenv("DS4UI_REMOTE_VISION", "qwen27-openai", 1) == 0);
    const char *rejected[] = {"../outside.png", "outside-link.png", "text.txt", "empty.png", "pipe.png", "missing.png", "/dev/zero"};
    for (size_t i = 0; i < sizeof rejected / sizeof *rejected; i++) {
        arg.value = (char *)rejected[i];
        CHECK(!ds4ui_remote_image_prepare(&w, &messages, &call, receipt, sizeof receipt));
        CHECK(strstr(receipt, "Tool error:"));
    }
    arg.value = "inside-link.png";
    url = ds4ui_remote_image_prepare(&w, &messages, &call, receipt, sizeof receipt);
    CHECK(url && !strcmp(url, "data:image/png;base64,iVBORw0KGgpvcmlnaW5hbA==")); free(url);
    const unsigned char jpeg[] = {255, 216, 255, 0, 0};
    const char *expected[] = {"data:image/jpeg;base64,/9j/", "data:image/jpeg;base64,/9j/AA==", "data:image/jpeg;base64,/9j/AAA="};
    for (size_t i = 0; i < 3; i++) {
        image_file("small.jpeg", jpeg, i + 3); arg.value = "small.jpeg";
        url = ds4ui_remote_image_prepare(&w, &messages, &call, receipt, sizeof receipt);
        CHECK(url && !strcmp(url, expected[i])); free(url);
    }
    arg.value = "sample.png";
    int large = open("large.png", O_CREAT | O_RDWR, 0600); CHECK(large >= 0);
    CHECK(ftruncate(large, DS4UI_REMOTE_IMAGE_BYTES + 1) == 0); close(large);
    arg.value = "large.png"; CHECK(!ds4ui_remote_image_prepare(&w, &messages, &call, receipt, sizeof receipt));
    CHECK(strstr(receipt, "2 MiB")); arg.value = "sample.png";
    messages.content_bytes = DS4UI_REMOTE_HISTORY_MAX;
    CHECK(!ds4ui_remote_image_prepare(&w, &messages, &call, receipt, sizeof receipt));
    CHECK(strstr(receipt, "byte budget")); messages.content_bytes = 4;
    for (int action = 1; action <= 3; action++) {
        image_file("sample.png", png, sizeof png - 1); image_read_action = action;
        CHECK(!ds4ui_remote_image_prepare(&w, &messages, &call, receipt, sizeof receipt));
        CHECK(!image_read_action); CHECK(strstr(receipt, action == 1 ? "cancelled" : "changed"));
        CHECK(messages.n == 1 && messages.content_bytes == 4 && !strcmp(messages.v[0].content, "keep"));
        agent_sigint = 0;
    }
    CHECK(unlink("sample.png") == 0); image_file("sample.png", png, sizeof png - 1);
    image_open_swap = 1; CHECK(!ds4ui_remote_image_prepare(&w, &messages, &call, receipt, sizeof receipt));
    CHECK(!image_open_swap); CHECK(unlink("sample.png") == 0); image_file("sample.png", png, sizeof png - 1);
    /* Exercise real batch ownership, count limits, snapshot and retirement. */
    char *schema = ds4ui_remote_tool_schemas(); ds4ui_remote_json parsed;
    CHECK(schema && ds4ui_remote_json_open(&parsed, schema, '['));
    const char *race = "[{\"id\":\"receipt-race\",\"type\":\"function\",\"function\":{\"name\":\"view_image\",\"arguments\":\"{\\\"path\\\":\\\"sample.png\\\"}\"}}]";
    char race_error[512] = "";
    ds4ui_remote_tool_group *race_group = ds4ui_remote_group_prepare(race, &parsed, &messages, race_error, sizeof race_error);
    CHECK(race_group && ds4ui_remote_group_admit(&messages, race_group, ""));
    image_receipt_cancel = 1; CHECK(ds4ui_remote_group_execute(&w, &messages, race_group));
    CHECK(!image_receipt_cancel && agent_sigint); CHECK(!race_group->calls[0].image_url);
    CHECK(race_group->calls[0].state == DS4UI_TOOL_INTERRUPTED);
    agent_sigint = 0; ds4ui_msg_list_free(&messages); CHECK(ds4ui_msg_list_add(&messages, "system", "keep"));
    for (int i = 0; i < DS4UI_REMOTE_IMAGE_COUNT + 1; i++) {
        char json[256], error[512] = "";
        snprintf(json, sizeof json, "[{\"id\":\"image-%d\",\"type\":\"function\",\"function\":{\"name\":\"view_image\",\"arguments\":\"{\\\"path\\\":\\\"sample.png\\\"}\"}}]", i);
        ds4ui_remote_tool_group *g = ds4ui_remote_group_prepare(json, &parsed, &messages, error, sizeof error);
        CHECK(g && ds4ui_remote_group_admit(&messages, g, "")); CHECK(ds4ui_remote_group_execute(&w, &messages, g));
        CHECK((g->calls[0].image_url != NULL) == (i < DS4UI_REMOTE_IMAGE_COUNT));
        if (!i) ds4ui_remote_images_reply(&messages, true);
        if (i == DS4UI_REMOTE_IMAGE_COUNT) CHECK(strstr(g->calls[0].result, "eight images"));
    }
    char *snapshot = ds4ui_msg_list_snapshot(&messages), error[512] = "";
    CHECK(snapshot && dtg_json_validate_complete(snapshot, '[', error, sizeof error)); free(snapshot);
    size_t before_reject = messages.content_bytes;
    ds4ui_remote_images_reply(&messages, false);
    CHECK(messages.content_bytes < before_reject);
    CHECK(messages.v[1].group->calls[0].image_url && messages.v[1].group->calls[0].image_delivery == DS4UI_IMAGE_ACCEPTED);
    for (int i = 2; i <= DS4UI_REMOTE_IMAGE_COUNT; i++) CHECK(!messages.v[i].group->calls[0].image_url && messages.v[i].group->calls[0].image_delivery == DS4UI_IMAGE_REJECTED);
    size_t after_reject = messages.content_bytes; ds4ui_remote_images_reply(&messages, false); CHECK(messages.content_bytes == after_reject);
    snapshot = ds4ui_msg_list_snapshot(&messages); CHECK(snapshot && dtg_json_validate_complete(snapshot, '[', error, sizeof error));
    CHECK(strstr(snapshot, "not confirmed")); free(snapshot);
    ds4ui_msg_list_compact(&messages, 0, &w);
    CHECK(messages.n == DS4UI_REMOTE_KEEP_RECENT + 1);
    ds4ui_msg_list_free(&messages); CHECK(!messages.content_bytes && !messages.v);
    free(parsed.tokens); free(schema); free(w.out); pthread_mutex_destroy(&w.mu);
    CHECK(setenv("DS4UI_REMOTE_VISION", "", 1) == 0);
    CHECK(fchdir(saved_cwd) == 0); close(saved_cwd);
    printf("{\"scope\":\"image transport, immutable bytes, filesystem races and cancellation; no image decode/inference\",\"passed\":true}\n");
}

static char *batch(int count, int first, size_t argument_bytes, size_t id_bytes) {
    dstudio_remote_buf json = {0}, args = {0};
    if (argument_bytes) {
        const char prefix[] = "{\"path\":\"unused.txt\",\"content\":\"";
        CHECK(argument_bytes >= sizeof prefix + 1);
        size_t n = argument_bytes - (sizeof prefix - 1) - 2;
        char *payload = malloc(n + 1); CHECK(payload); memset(payload, 'x', n); payload[n] = 0;
        dstudio_remote_buf_puts(&args, prefix); dstudio_remote_buf_puts(&args, payload);
        dstudio_remote_buf_puts(&args, "\"}"); free(payload);
        CHECK(args.len == argument_bytes);
    } else dstudio_remote_buf_puts(&args, "{\"path\":\"unused.txt\"}");
    dstudio_remote_buf_puts(&json, "[");
    for (int i = 0; i < count; i++) {
        char id[300];
        if (id_bytes) { CHECK(id_bytes < sizeof id); memset(id, 'i', id_bytes); id[id_bytes] = 0; }
        else snprintf(id, sizeof id, "call-%d", first + i);
        if (i) dstudio_remote_buf_puts(&json, ",");
        dstudio_remote_buf_puts(&json, "{\"id\":"); dstudio_remote_json_string(&json, id);
        dstudio_remote_buf_puts(&json, " ,\"type\":\"function\",\"function\":{\"name\":");
        dstudio_remote_json_string(&json, argument_bytes ? "write" : "read");
        dstudio_remote_buf_puts(&json, ",\"arguments\":"); dstudio_remote_json_string(&json, args.ptr);
        dstudio_remote_buf_puts(&json, "}}");
    }
    dstudio_remote_buf_puts(&json, "]"); dstudio_remote_buf_free(&args);
    return dstudio_remote_buf_take(&json);
}

static ds4ui_remote_tool_group *prepare(const ds4ui_remote_json *schemas,
        ds4ui_msg_list *messages, int count, int first, size_t args, size_t id, int expected) {
    char *json = batch(count, first, args, id), error[512] = "";
    int before = messages->n, ids = messages->call_id_count;
    ds4ui_remote_tool_group *group = ds4ui_remote_group_prepare(json, schemas, messages, error, sizeof error);
    CHECK(!!group == expected); CHECK(messages->n == before && messages->call_id_count == ids);
    if (group) CHECK(!strcmp(group->json, json)); else CHECK(error[0]);
    free(json); return group;
}

static void snapshot_benchmark(void) {
    const int sizes[] = {8, 64, 512}; char payload[1025];
    memset(payload, 'x', sizeof payload - 1); payload[sizeof payload - 1] = 0;
    for (size_t n = 0; n < sizeof sizes / sizeof *sizes; n++) {
        ds4ui_msg_list messages = {0};
        for (int i = 0; i < sizes[n]; i++) CHECK(ds4ui_msg_list_add(&messages, "user", payload));
        struct timespec from, to; CHECK(clock_gettime(CLOCK_MONOTONIC, &from) == 0);
        size_t output_bytes = 0;
        for (int i = 0; i < 20; i++) {
            char *json = ds4ui_msg_list_snapshot(&messages); CHECK(json);
            output_bytes = strlen(json); free(json);
        }
        CHECK(clock_gettime(CLOCK_MONOTONIC, &to) == 0);
        double ms = (to.tv_sec - from.tv_sec) * 1000.0 + (to.tv_nsec - from.tv_nsec) / 1000000.0;
        printf("{\"scope\":\"model-free snapshot microbenchmark\",\"messages\":%d,\"payloadBytesEach\":1024,\"iterations\":20,\"outputBytes\":%zu,\"totalMs\":%.3f}\n", sizes[n], output_bytes, ms);
        ds4ui_msg_list_free(&messages);
    }
}

int main(void) {
    CHECK(setenv("DS4UI_RUNTIME_NAME", "agent", 1) == 0);
    CHECK(setenv("DS4UI_REMOTE_TOOL_PROTOCOL", "openai", 1) == 0);
    CHECK(setenv("DS4UI_REMOTE_VISION", "", 1) == 0);
    char *text = ds4ui_remote_tool_schemas(); ds4ui_remote_json schemas;
    CHECK(text && ds4ui_remote_json_open(&schemas, text, '['));
    ds4ui_msg_list messages = {0};
    const int counts[] = {1, DS4UI_REMOTE_TOOLS_MAX, DS4UI_REMOTE_TOOLS_MAX + 1};
    for (size_t i = 0; i < sizeof counts / sizeof *counts; i++)
        ds4ui_remote_group_free(prepare(&schemas, &messages, counts[i], 0, 0, 0, i < 2));
    ds4ui_remote_group_free(prepare(&schemas, &messages, 1, 0, 0, 255, 1));
    CHECK(!prepare(&schemas, &messages, 1, 0, 0, 256, 0));
    ds4ui_remote_group_free(prepare(&schemas, &messages, 1, 0, DS4UI_REMOTE_ARGUMENT_BYTES, 0, 1));
    CHECK(!prepare(&schemas, &messages, 1, 0, DS4UI_REMOTE_ARGUMENT_BYTES + 1, 0, 0));
    ds4ui_remote_group_free(prepare(&schemas, &messages, 2, 0, DS4UI_REMOTE_ARGUMENT_BYTES, 0, 1));
    CHECK(!prepare(&schemas, &messages, 3, 0, DS4UI_REMOTE_ARGUMENT_BYTES, 0, 0));

    CHECK(ds4ui_msg_list_add(&messages, "system", "system"));
    for (int first = 0; first < DS4UI_REMOTE_CALL_IDS_MAX; first += DS4UI_REMOTE_TOOLS_MAX) {
        ds4ui_remote_tool_group *group = prepare(&schemas, &messages, DS4UI_REMOTE_TOOLS_MAX, first, 0, 0, 1);
        CHECK(ds4ui_remote_group_admit(&messages, group, "prepared, not executed"));
    }
    CHECK(messages.call_id_count == DS4UI_REMOTE_CALL_IDS_MAX);
    CHECK(!prepare(&schemas, &messages, 1, DS4UI_REMOTE_CALL_IDS_MAX, 0, 0, 0));
    agent_config cfg = {0}; agent_worker worker = {.cfg = &cfg, .wake_fd = {-1, -1}};
    CHECK(pthread_mutex_init(&worker.mu, NULL) == 0);
    ds4ui_msg_list_compact(&messages, 0, &worker);
    CHECK(messages.n == 1 + DS4UI_REMOTE_KEEP_RECENT);
    CHECK(messages.call_id_count == DS4UI_REMOTE_CALL_IDS_MAX);
    CHECK(!prepare(&schemas, &messages, 1, 0, 0, 0, 0));
    char *snapshot = ds4ui_msg_list_snapshot(&messages), error[512] = "";
    CHECK(snapshot && dtg_json_validate_complete(snapshot, '[', error, sizeof error));
    free(snapshot); free(worker.out); pthread_mutex_destroy(&worker.mu);
    ds4ui_msg_list_free(&messages);
    CHECK(!messages.v && !messages.call_ids && !messages.call_id_count && !messages.content_bytes);
    ds4ui_remote_group_free(prepare(&schemas, &messages, 1, 0, 0, 0, 1));

    for (int n = 0; n < DS4UI_REMOTE_MESSAGES_MAX; n++) CHECK(ds4ui_msg_list_add(&messages, "user", "x"));
    CHECK(!ds4ui_msg_list_add(&messages, "user", "over bound"));
    CHECK(messages.n == DS4UI_REMOTE_MESSAGES_MAX && messages.content_bytes == DS4UI_REMOTE_MESSAGES_MAX);
    CHECK(!ds4ui_msg_list_snapshot(&messages));
    ds4ui_msg_list_free(&messages);

    char *large = malloc(DS4UI_REMOTE_HISTORY_MAX + 1); CHECK(large);
    memset(large, 'x', DS4UI_REMOTE_HISTORY_MAX); large[DS4UI_REMOTE_HISTORY_MAX] = 0;
    CHECK(ds4ui_msg_list_add(&messages, "user", large)); free(large);
    ds4ui_remote_tool_group *group = prepare(&schemas, &messages, 1, 0, 0, 0, 1);
    CHECK(!ds4ui_remote_group_admit(&messages, group, "budget must fail before effect"));
    CHECK(messages.n == 1 && messages.call_id_count == 0 && messages.content_bytes == DS4UI_REMOTE_HISTORY_MAX);
    CHECK(!ds4ui_msg_list_snapshot(&messages)); /* JSON envelope also consumes wire bytes. */
    ds4ui_remote_group_free(group); ds4ui_msg_list_free(&messages);
    free(schemas.tokens); free(text);
    image_boundaries();
    printf("{\"scope\":\"native structured admission and lifetime\",\"passedChecks\":%zu,\"sizeofMessage\":%zu,\"sizeofTranscript\":%zu,\"sizeofCall\":%zu,\"sizeofGroup\":%zu}\n", checks, sizeof(ds4ui_msg), sizeof(ds4ui_msg_list), sizeof(ds4ui_remote_call), sizeof(ds4ui_remote_tool_group));
    snapshot_benchmark();
    return 0;
}
