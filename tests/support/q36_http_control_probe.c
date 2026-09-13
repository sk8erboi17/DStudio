/* Real native HTTP client/control handlers with a deterministic receive barrier.
 * No weights, inference or timing-only ownership oracle. The body is deliberately
 * withheld, so cancellation/admission must not depend on finishing a large upload. */
#include <assert.h>
#include <pthread.h>
#include <stdatomic.h>
#include <sys/socket.h>
#include <unistd.h>
#include "q36.h"
static void simulated_tokenize(q36_engine *, const char *, q36_tokens *);
static bool replay_context_fixture;
static pthread_mutex_t *observed_output_mutex;
static unsigned output_under_lock;
static void observe_output_lock(void) {
    if (observed_output_mutex) {
        int rc = pthread_mutex_trylock(observed_output_mutex);
        if (rc == 0) pthread_mutex_unlock(observed_output_mutex);
        else output_under_lock++;
    }
}
static size_t observed_fwrite(const void *p, size_t size, size_t count, FILE *fp) {
    observe_output_lock();
    return fwrite(p, size, count, fp);
}
static int observed_fflush(FILE *fp) {
    observe_output_lock();
    return fflush(fp);
}

static _Thread_local int watched_slot = -1, receives;
static pthread_mutex_t barrier_mu = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t barrier_cv = PTHREAD_COND_INITIALIZER;
static int waiting[16], ended[16];
static ssize_t observed_recv(int fd, void *bytes, size_t size, int flags) {
    if (watched_slot >= 0 && ++receives >= 2) {
        pthread_mutex_lock(&barrier_mu);
        waiting[watched_slot] = 1;
        pthread_cond_broadcast(&barrier_cv);
        pthread_mutex_unlock(&barrier_mu);
    }
    return recv(fd, bytes, size, flags);
}
#define recv observed_recv
#define fwrite observed_fwrite
#define fflush observed_fflush
#define q36_tokenize_rendered_chat simulated_tokenize
#define Q36_SERVER_TEST
#define Q36_SERVER_TEST_NO_MAIN
#include "q36_server.c"
#undef recv
#undef fwrite
#undef fflush
#undef q36_tokenize_rendered_chat

/* Queue/control tests only: no vocabulary or model runs in this probe. */
static void simulated_tokenize(q36_engine *e, const char *text, q36_tokens *tokens) {
    (void)e;
    int count = replay_context_fixture && !strstr(text, "<tool_call>\n\n<function=read>") ? 8 : 4;
    for (int i = 0; i < count; i++) q36_tokens_push(tokens, 100 + i);
}

q36_engine *dstudio_catalog_engine(unsigned family);
static server srv;
static unsigned failures, checks;
static void checked(bool value, int line) {
    checks++;
    if (!value) {failures++; fprintf(stderr, "HTTP control assertion at line %d\n", line);}
}
#define check(value) checked((value), __LINE__)
typedef struct {int fd, watch; pthread_t thread;} connection;
typedef struct {client_arg *arg; int watch;} incoming;
static void *client_entry(void *arg) {
    incoming in = *(incoming *)arg; free(arg);
    watched_slot = in.watch; receives = 0;
    void *result = client_main(in.arg);
    if (in.watch >= 0) {
        pthread_mutex_lock(&barrier_mu); ended[in.watch] = 1;
        pthread_cond_broadcast(&barrier_cv); pthread_mutex_unlock(&barrier_mu);
    }
    return result;
}
static connection connect_client(int watch) {
    int pair[2]; assert(socketpair(AF_UNIX, SOCK_STREAM, 0, pair) == 0);
    configure_client_socket(pair[0]);
    incoming *in = calloc(1, sizeof(*in)); assert(in);
    in->watch = watch; in->arg = calloc(1, sizeof(*in->arg)); assert(in->arg);
    in->arg->srv = &srv; in->arg->fd = pair[0];
    pthread_mutex_lock(&srv.mu); srv.clients++; pthread_mutex_unlock(&srv.mu);
    connection c = {.fd = pair[1], .watch = watch};
    assert(pthread_create(&c.thread, NULL, client_entry, in) == 0); return c;
}
static void close_client(connection *c) {
    shutdown(c->fd, SHUT_RDWR); close(c->fd); c->fd = -1;
    pthread_join(c->thread, NULL);
}
static int response(connection *c, char *body, size_t cap) {
    size_t len = 0;
    while (len + 1 < cap) {
        struct pollfd p = {.fd = c->fd, .events = POLLIN};
        if (poll(&p, 1, 1000) <= 0) return 0;
        ssize_t n = recv(c->fd, body + len, cap - len - 1, 0);
        if (!n) break;
        if (n < 0) return 0;
        len += (size_t)n;
    }
    body[len] = 0; int code = 0; sscanf(body, "HTTP/1.1 %d", &code); return code;
}
static int rpc(const char *request, char *body, size_t cap) {
    connection c = connect_client(-1);
    assert(send_all(c.fd, request, strlen(request)));
    int code = response(&c, body, cap); close_client(&c); return code;
}
static connection waiting_body(int index, const char *id) {
    connection c = connect_client(index); char header[512];
    snprintf(header, sizeof(header), "POST /v1/chat/completions HTTP/1.1\r\nHost: localhost\r\n"
        "X-DStudio-Request-Id: %s\r\nContent-Length: 10000\r\n\r\n{", id);
    assert(send_all(c.fd, header, strlen(header)));
    pthread_mutex_lock(&barrier_mu);
    while (!waiting[index] && !ended[index]) pthread_cond_wait(&barrier_cv, &barrier_mu);
    check(waiting[index] != 0);
    pthread_mutex_unlock(&barrier_mu); return c;
}
static connection queued_request(const char *id, const char *endpoint, const char *body) {
    connection c = connect_client(-1);
    char header[8192];
    int n = snprintf(header, sizeof(header), "POST %s HTTP/1.1\r\nHost: localhost\r\n"
        "X-DStudio-Request-Id: %s\r\nContent-Length: %zu\r\n\r\n%s", endpoint, id, strlen(body), body);
    assert(n > 0 && n < (int)sizeof(header));
    assert(send_all(c.fd, header, strlen(header)));
    pthread_mutex_lock(&srv.mu);
    bool found = false;
    while (!found) {
        for (job *j = srv.head; j; j = j->next) if (j->request_id && !strcmp(j->request_id, id)) found = true;
        if (!found) pthread_cond_wait(&srv.cv, &srv.mu);
    }
    pthread_mutex_unlock(&srv.mu); return c;
}
static connection queued_body(const char *id) {
    return queued_request(id, "/v1/chat/completions",
        "{\"messages\":[{\"role\":\"user\",\"content\":\"control fixture\"}],\"thinking\":false,\"max_tokens\":1}");
}
static int cancel_id(const char *id, char *body, size_t cap) {
    char header[512];
    snprintf(header, sizeof(header), "POST /v1/requests/%s/cancel HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n", id);
    return rpc(header, body, cap);
}
int main(int argc, char **argv) {
    if (argc != 2) return 2;
    signal(SIGPIPE, SIG_IGN);
    pthread_mutex_init(&srv.mu, NULL); pthread_cond_init(&srv.cv, NULL);
    pthread_cond_init(&srv.clients_cv, NULL);
    pthread_mutex_init(&srv.tool_mu, NULL); pthread_mutex_init(&srv.kv_mu, NULL);
    pthread_mutex_init(&srv.trace_mu, NULL);
    srv.ctx_size = 8192; srv.default_tokens = 32; srv.engine = dstudio_catalog_engine(1);
    int mode = atoi(argv[1]); char body[8192];
    if (mode == 0) {
        connection c = waiting_body(0, "receiving-unique-1");
        check(rpc("POST /v1/requests/receiving-unique-1/cancel HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n", body, sizeof(body)) == 202);
        check(strstr(body, "\"cancellation_requested\":true") != NULL);
        if (!failures) check(response(&c, body, sizeof(body)) == 499);
        close_client(&c);
        check(rpc("POST /v1/requests/receiving-unique-1/cancel HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n", body, sizeof(body)) == 404);
    } else if (mode == 1) {
        connection c = waiting_body(0, "duplicate-unique-1");
        check(rpc("POST /v1/chat/completions HTTP/1.1\r\nHost: localhost\r\nX-DStudio-Request-Id: duplicate-unique-1\r\nContent-Length: 2\r\n\r\n{}", body, sizeof(body)) == 409);
        close_client(&c);
    } else if (mode == 2) {
        connection c[16];
        for (int i = 0; i < 16; i++) {char id[32]; snprintf(id, sizeof(id), "full-unique-%d", i); c[i] = waiting_body(i, id);}
        check(rpc("POST /v1/chat/completions HTTP/1.1\r\nHost: localhost\r\nX-DStudio-Request-Id: overflow-unique\r\nContent-Length: 2\r\n\r\n{}", body, sizeof(body)) == 503);
        check(rpc("GET /v1/models HTTP/1.1\r\nHost: localhost\r\n\r\n", body, sizeof(body)) == 200);
        check(strstr(body, "qwen3.8-27b") != NULL);
        check(rpc("POST /v1/requests/full-unique-5/cancel HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n", body, sizeof(body)) == 202);
        for (int i = 0; i < 16; i++) close_client(&c[i]);
    } else if (mode == 3) {
        const char *bad[] = {
            "X-DStudio-Request-Id: \r\n", "X-DStudio-Request-Id: id/other\r\n",
            "X-DStudio-Request-Id: id with spaces\r\n",
            "X-DStudio-Request-Id: duplicate\r\nx-dstudio-request-id: duplicate\r\n",
            "X-DStudio-Request-Id: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\r\n",
            "Content-Length: 0\r\nContent-Length: 0\r\n", "Content-Length: -1\r\n",
            "Content-Length: +1\r\n", "Content-Length: 2junk\r\n",
            "Content-Length: 18446744073709551616\r\n", "Transfer-Encoding: chunked\r\n",
        };
        for (size_t i = 0; i < sizeof(bad)/sizeof(bad[0]); i++) {
            char header[512]; snprintf(header, sizeof(header), "POST /v1/chat/completions HTTP/1.1\r\nHost: localhost\r\n%s\r\n", bad[i]);
            check(rpc(header, body, sizeof(body)) == 400);
        }
        check(rpc("POST /v1/chat/completions HTTP/1.1\r\nHost: localhost\r\nContent-Length: 67108865\r\n\r\n", body, sizeof(body)) == 413);
        check(rpc("GET /v1/models HTTP/1.1\r\nHost: localhost\r\nContent-Length: 1025\r\n\r\n", body, sizeof(body)) == 413);
        check(rpc("POST /v1/requests/name%2Fother/cancel HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n", body, sizeof(body)) == 400);
    } else if (mode == 4) {
        connection c = waiting_body(0, "not-the-cancel-target");
        check(cancel_id("unknown-target", body, sizeof(body)) == 404);
        pthread_mutex_lock(&srv.mu);
        check(srv.live_jobs && !atomic_load(&srv.live_jobs->cancelled));
        pthread_mutex_unlock(&srv.mu);
        check(cancel_id("not-the-cancel-target", body, sizeof(body)) == 202);
        check(response(&c, body, sizeof(body)) == 499); close_client(&c);
        check(srv.generation_clients == 0 && srv.live_jobs == NULL);
        waiting[0] = ended[0] = 0;
        c = waiting_body(0, "fresh-request-after-cancel");
        check(srv.generation_clients == 1);
        close_client(&c);
    } else if (mode == 5 || mode == 6 || mode == 7) {
        connection a = queued_body("running-unique"), b;
        job *active = dequeue(&srv);
        check(!server_job_cancelled(active));
        if (mode == 5) {
            b = queued_body("queued-unique");
            check(cancel_id("queued-unique", body, sizeof(body)) == 202);
            check(response(&b, body, sizeof(body)) == 499); close_client(&b);
            check(!server_job_cancelled(active));
            check(srv.head == NULL && srv.tail == NULL);
        } else if (mode == 6) {
            b = queued_body("must-remain-queued");
            check(cancel_id("running-unique", body, sizeof(body)) == 202);
            check(server_job_cancelled(active));
            pthread_mutex_lock(&srv.mu);
            check(srv.head && !atomic_load(&srv.head->cancelled));
            pthread_mutex_unlock(&srv.mu);
            check(cancel_id("must-remain-queued", body, sizeof(body)) == 202);
            check(response(&b, body, sizeof(body)) == 499); close_client(&b);
        }
        http_response(active->fd, mode == 6 ? 499 : 200, "application/json", "{\"simulated_worker\":true}");
        server_finish_job(&srv, active);
        check(response(&a, body, sizeof(body)) == (mode == 6 ? 499 : 200)); close_client(&a);
        check(cancel_id("running-unique", body, sizeof(body)) == 404);
    } else if (mode == 8) {
        const char *raw = "ready\n<tool_call>\n<function=read>\n<parameter=path>fixture.txt</parameter>\n</function>\n</tool_call>";
        for (int interrupted = 0; interrupted < 2; interrupted++) {
            const char *finish = interrupted ? "error" : "stop";
            char err[160] = "request interrupted", *content = NULL, *reasoning = NULL;
            tool_calls calls = {0}; bool recovered = false;
            parse_generated_message_for_response(raw, false, true, true, &finish,
                err, sizeof(err), &content, &reasoning, &calls, &recovered, NULL);
            check(calls.len == (interrupted ? 0 : 1));
            check(!strcmp(finish, interrupted ? "error" : "stop")); check(!recovered);
            if (interrupted) check(content && !strcmp(content, raw));
            else {check(!strcmp(calls.v[0].name, "read")); check(!strcmp(calls.v[0].arguments, "{\"path\":\"fixture.txt\"}"));}
            free(content); free(reasoning); tool_calls_free(&calls);
        }
    } else if (mode >= 9 && mode <= 14) {
        /* Deliberately noncanonical whitespace distinguishes native replay
         * from rendering the equivalent HTTP arguments without cache access. */
        const char *sampled = "\n<tool_call>\n\n<function=read>\n<parameter=path>\nfixture.txt\n</parameter>\n</function>\n</tool_call>";
        tool_memory_put(&srv, "call_saved", sampled);
        check(tool_memory_has_id(&srv, "call_saved"));
        if (mode == 14) {
            char *saved = NULL; size_t bytes = 0; uint64_t written = 0;
            FILE *fp = open_memstream(&saved, &bytes); assert(fp);
            observed_output_mutex = &srv.tool_mu;
            check(kv_tool_map_write(&srv, fp, sampled, &written));
            observed_output_mutex = NULL;
            check(fclose(fp) == 0); check(bytes == written && written > KV_TOOL_MAP_HEADER);
            check(output_under_lock == 0);
            check(memmem(saved, bytes, sampled, strlen(sampled)) != NULL);
            free(saved);
        } else {
            const char *chat = "{\"messages\":[{\"role\":\"assistant\",\"content\":null,\"tool_calls\":[{\"id\":\"call_saved\",\"type\":\"function\",\"function\":{\"name\":\"read\",\"arguments\":\"{\\\"path\\\":\\\"fixture.txt\\\"}\"}}]},{\"role\":\"tool\",\"tool_call_id\":\"call_saved\",\"content\":\"found\"},{\"role\":\"user\",\"content\":\"continue\"}],\"thinking\":false,\"max_tokens\":1}";
            const char *responses = "{\"input\":[{\"type\":\"function_call\",\"call_id\":\"call_saved\",\"name\":\"read\",\"arguments\":\"{\\\"path\\\":\\\"fixture.txt\\\"}\"},{\"type\":\"function_call_output\",\"call_id\":\"call_saved\",\"output\":\"found\"},{\"role\":\"user\",\"content\":\"continue\"}],\"max_output_tokens\":1}";
            const char *anthropic = "{\"messages\":[{\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"call_saved\",\"name\":\"read\",\"input\":{\"path\":\"fixture.txt\"}}]},{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"call_saved\",\"content\":\"found\"},{\"type\":\"text\",\"text\":\"continue\"}]}],\"max_tokens\":1}";
            uint64_t clock = srv.tool_mem.clock;
            if (mode == 13) {replay_context_fixture = true; srv.ctx_size = 6;}
            connection c = queued_request("replay-owner", mode == 10 ? "/v1/responses" : mode == 11 ? "/v1/messages" : "/v1/chat/completions",
                mode == 10 ? responses : mode == 11 ? anthropic : chat);
            job *active = dequeue(&srv);
            check(srv.tool_mem.clock == clock); /* No client-side LRU mutation. */
            check(active->req.tool_replay.missing_ids == 1 && active->req.tool_replay.mem == 0);
            check(!strstr(active->req.prompt_text, sampled));
            if (mode == 13) check(request_exceeds_context(&active->req, srv.ctx_size));
            active->req.temperature = 0.8125f; active->req.seed = 12345; active->req.max_tokens = 7;
            char *original_body = active->req.raw_body, *original_model = active->req.model;
            char *before = xstrdup(active->req.prompt_text);
            if (mode == 12) atomic_store(&active->cancelled, true);
            char err[160] = {0};
#ifdef DSTUDIO_Q36_REPLAY_BASELINE
            /* The original owner consumes the already-rendered request; no
             * owner-side tool lookup exists in that production revision. */
            int rc = server_job_cancelled(active) ? Q36_SESSION_SYNC_INTERRUPTED : 0;
#else
            int rc = server_prepare_tool_replay(&srv, active, err, sizeof(err));
#endif
            if (mode == 12) {
                check(rc == Q36_SESSION_SYNC_INTERRUPTED);
                check(!strcmp(active->req.prompt_text, before) && srv.tool_mem.clock == clock);
            } else {
                check(rc == 0); check(strstr(active->req.prompt_text, sampled) != NULL);
                check(active->req.tool_replay.mem == 1 && active->req.tool_replay.missing_ids == 0);
                check(!request_exceeds_context(&active->req, srv.ctx_size));
            }
            check(active->req.temperature == 0.8125f && active->req.seed == 12345 && active->req.max_tokens == 7);
            check(active->req.raw_body == original_body && active->req.model == original_model);
            free(before);
            http_response(active->fd, mode == 12 ? 499 : 200, "application/json", "{\"simulated_worker\":true}");
            server_finish_job(&srv, active);
            check(response(&c, body, sizeof(body)) == (mode == 12 ? 499 : 200)); close_client(&c);
        }
        tool_memory_free(&srv.tool_mem);
    } else if (mode == 15) {
        char *saved = NULL; size_t bytes = 0;
        srv.trace = open_memstream(&saved, &bytes); assert(srv.trace);
        job active = {0};
        active.req.kind = REQ_CHAT;
        active.req.raw_body = "{\"fixture\":true}";
        active.req.prompt_text = "trace fixture prompt";
        active.req.tool_replay.mem = 1;
        tool_calls calls = {0};
        observed_output_mutex = &srv.trace_mu;
        uint64_t id = trace_begin(&srv, &active, 0, 4, NULL, "none", 0, NULL);
        check(id == 1);
        trace_piece(&srv, id, "received-byte-exact", 19);
        trace_event(&srv, id, "owner event %d", 17);
        trace_finish(&srv, id, &active.req, "stop", 4, false, false,
                     "received-byte-exact", NULL, &calls, 0.25);
        observed_output_mutex = NULL;
        check(fclose(srv.trace) == 0); srv.trace = NULL;
        check(output_under_lock == 0);
        check(bytes == strlen(saved));
        check(strstr(saved, "tool_replay: mem=1 disk=0 canonical=0 missing_ids=0") != NULL);
        check(strstr(saved, "received-byte-exact") != NULL);
        check(strstr(saved, "owner event 17") != NULL);
        check(strstr(saved, "===== end request 1 =====") != NULL);
        free(saved);
    } else return 2;
    check(srv.clients == 0); check(srv.head == NULL && srv.tail == NULL);
    check(srv.live_jobs == NULL && srv.generation_clients == 0);
    pthread_mutex_destroy(&srv.mu); pthread_cond_destroy(&srv.cv); pthread_cond_destroy(&srv.clients_cv);
    pthread_mutex_destroy(&srv.tool_mu); pthread_mutex_destroy(&srv.kv_mu);
    pthread_mutex_destroy(&srv.trace_mu);
    printf("{\"case\":%d,\"checks\":%u,\"failures\":%u,\"layout\":{\"server\":%zu,\"job\":%zu,\"request\":%zu,\"http_request\":%zu}}\n",
        mode, checks, failures, sizeof(server), sizeof(job), sizeof(request), sizeof(http_request));
    return failures ? 1 : 0;
}
