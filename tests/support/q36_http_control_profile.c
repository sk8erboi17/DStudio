/* Opt-in, model-free microprofile of the actual native publication functions.
 * Instrumentation exists only in this probe, not in the production runtime.
 * Uncontended mutex timings include clock overhead; they are not end-to-end
 * latency, generation throughput or evidence of quality under concurrent load. */
#include <assert.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

enum {SAMPLES = 128, MAX_CALLS = SAMPLES * 32, PHASES = 4};
typedef struct {uint64_t wait[MAX_CALLS], hold[MAX_CALLS]; unsigned count;} measurements;
static measurements measured[PHASES];
static pthread_mutex_t *owner_mutex;
static uint64_t entered, waited;
static int phase = -1;
static uint64_t ns(void) {
    struct timespec t; assert(clock_gettime(CLOCK_MONOTONIC, &t) == 0);
    return (uint64_t)t.tv_sec * UINT64_C(1000000000) + (uint64_t)t.tv_nsec;
}
static int measured_lock(pthread_mutex_t *mutex) {
    if (mutex != owner_mutex || phase < 0) return pthread_mutex_lock(mutex);
    uint64_t before = ns(); int rc = pthread_mutex_lock(mutex);
    entered = ns(); waited = entered - before; return rc;
}
static int measured_unlock(pthread_mutex_t *mutex) {
    if (mutex != owner_mutex || phase < 0) return pthread_mutex_unlock(mutex);
    uint64_t held = ns() - entered; int rc = pthread_mutex_unlock(mutex);
    measurements *m = &measured[phase]; assert(m->count < MAX_CALLS);
    m->wait[m->count] = waited; m->hold[m->count++] = held; return rc;
}
#define pthread_mutex_lock measured_lock
#define pthread_mutex_unlock measured_unlock
#define Q36_SERVER_TEST
#define Q36_SERVER_TEST_NO_MAIN
#include "q36_server.c"
#undef pthread_mutex_lock
#undef pthread_mutex_unlock

static int compare_u64(const void *a, const void *b) {
    uint64_t x = *(const uint64_t *)a, y = *(const uint64_t *)b; return (x > y) - (x < y);
}
static void distribution(uint64_t *values, unsigned count) {
    qsort(values, count, sizeof(*values), compare_u64);
    printf("{\"p50_ns\":%llu,\"p95_ns\":%llu,\"max_ns\":%llu}",
        (unsigned long long)values[count / 2], (unsigned long long)values[(count - 1) * 95 / 100],
        (unsigned long long)values[count - 1]);
}
static int profile_tool_replay(void) {
    const size_t sizes[] = {1024, 16384, 262144};
    const int ceilings[] = {128, 100000};
    tool_schema_orders orders = {0};
    tool_schema_orders_add_json(&orders, "{\"name\":\"inspect\",\"parameters\":{\"type\":\"object\","
        "\"properties\":{\"data\":{\"type\":\"string\"}}}}");
    printf("{\"scope\":\"model-free uncontended native exact-tool replay; instrumented clocks, no inference or throughput claim\","
           "\"layout\":{\"server\":%zu,\"tool_memory\":%zu,\"tool_entry\":%zu,\"tool_block\":%zu,"
           "\"request\":%zu,\"schema_property\":%zu,\"tool_stream\":%zu},\"rows\":[",
           sizeof(server), sizeof(tool_memory), sizeof(tool_memory_entry), sizeof(tool_memory_block),
           sizeof(request), sizeof(orders.v[0].prop[0]), sizeof(openai_tool_stream));
    for (unsigned ceiling = 0; ceiling < 2; ceiling++) for (unsigned row = 0; row < 3; row++) {
        server s = {.batched_mode = true}; pthread_mutex_init(&s.tool_mu, NULL);
        s.tool_mem.max_entries = ceilings[ceiling]; owner_mutex = &s.tool_mu;
        char *data = malloc(sizes[row] + 1); assert(data); memset(data, 'x', sizes[row]); data[sizes[row]] = 0;
        buf raw = {0}, args = {0};
        buf_puts(&raw, "<tool_call>\n\n<function=inspect>\n<parameter=data>\n");
        buf_puts(&raw, data); buf_puts(&raw, "\n</parameter>\n</function>\n</tool_call>");
        tool_memory_put(&s, "call_profile", raw.ptr);
        buf_puts(&args, "{\"data\":"); json_escape(&args, data); buf_putc(&args, '}');
        chat_msgs msgs = {0}; chat_msg message = {.role = xstrdup("assistant"), .content = xstrdup("")};
        tool_calls_push(&message.calls, (tool_call){.id = xstrdup("call_profile"), .name = xstrdup("inspect"), .arguments = buf_take(&args)});
        chat_msgs_push(&msgs, message);
        memset(measured, 0, sizeof(measured)); uint64_t total[SAMPLES], unlocked[SAMPLES];
        for (unsigned sample = 0; sample < SAMPLES; sample++) {
            tool_replay_stats stats = {0}; unsigned first = measured[0].count;
            phase = 0; uint64_t begin = ns();
            tool_memory_attach_to_messages(&s, &msgs, &stats
#ifndef Q36_SCHEMA_TEST_LEGACY_API
                , &orders
#endif
            );
            total[sample] = ns() - begin; phase = -1;
            assert(stats.mem == 1 && msgs.v[0].calls.raw_tool_text && !strcmp(msgs.v[0].calls.raw_tool_text, raw.ptr));
            uint64_t locked = 0;
            for (unsigned i = first; i < measured[0].count; i++) locked += measured[0].wait[i] + measured[0].hold[i];
            assert(total[sample] >= locked); unlocked[sample] = total[sample] - locked;
            free(msgs.v[0].calls.raw_tool_text); msgs.v[0].calls.raw_tool_text = NULL;
        }
        measurements *m = &measured[0];
        printf("%s{\"argument_bytes\":%zu,\"configured_id_limit\":%d,\"active_ids\":%d,\"cache_bytes\":%zu,\"repetitions\":%u,\"critical_sections\":%u,\"total\":",
               row || ceiling ? "," : "", sizes[row], ceilings[ceiling], s.tool_mem.entries, s.tool_mem.bytes, SAMPLES, m->count);
        distribution(total, SAMPLES); printf(",\"outside_observed_locks\":"); distribution(unlocked, SAMPLES);
        printf(",\"lock_wait\":"); distribution(m->wait, m->count);
        printf(",\"lock_hold\":"); distribution(m->hold, m->count); printf("}");
        chat_msgs_free(&msgs); tool_memory_free(&s.tool_mem); buf_free(&raw); free(data);
        pthread_mutex_destroy(&s.tool_mu); owner_mutex = NULL;
    }
    printf("]}\n"); tool_schema_orders_free(&orders); return 0;
}

static int profile_tool_store(void) {
    const size_t sizes[] = {1024, 16384, 262144};
    const int ceilings[] = {128, 100000};
    printf("{\"scope\":\"model-free native cache rebind and real tool-map file writes; uncontended, instrumented clocks\","
           "\"layout\":{\"server\":%zu,\"tool_memory\":%zu,\"tool_entry\":%zu,\"tool_block\":%zu},\"rows\":[",
           sizeof(server), sizeof(tool_memory), sizeof(tool_memory_entry), sizeof(tool_memory_block));
    for (unsigned ceiling = 0; ceiling < 2; ceiling++) for (unsigned row = 0; row < 3; row++) {
        server s = {.batched_mode = true}; pthread_mutex_init(&s.tool_mu, NULL);
        s.tool_mem.max_entries = ceilings[ceiling]; owner_mutex = &s.tool_mu;
        buf raw[2] = {{0}};
        for (int variant = 0; variant < 2; variant++) {
            buf_puts(&raw[variant], "<tool_call>\n<function=inspect>\n<parameter=data>\n");
            for (size_t i = 0; i < sizes[row]; i++) buf_putc(&raw[variant], variant ? 'b' : 'a');
            buf_puts(&raw[variant], "\n</parameter>\n</function>\n</tool_call>");
        }
        tool_memory_put(&s, "call_profile", raw[0].ptr);
        FILE *file = tmpfile(); assert(file);
        memset(measured, 0, sizeof(measured)); uint64_t total[2][SAMPLES], unlocked[2][SAMPLES], disk_bytes = 0;
        for (unsigned sample = 0; sample < SAMPLES; sample++) {
            const char *text = raw[(sample + 1) % 2].ptr;
            assert(!ftruncate(fileno(file), 0)); rewind(file);
            for (unsigned p = 0; p < 2; p++) {
                unsigned first = measured[p].count; phase = (int)p; uint64_t begin = ns();
                if (!p) tool_memory_put(&s, "call_profile", text);
                else {assert(kv_tool_map_write(&s, file, text, &disk_bytes)); assert(!fflush(file));}
                total[p][sample] = ns() - begin; phase = -1;
                uint64_t locked = 0;
                for (unsigned i = first; i < measured[p].count; i++) locked += measured[p].wait[i] + measured[p].hold[i];
                assert(total[p][sample] >= locked); unlocked[p][sample] = total[p][sample] - locked;
            }
            assert(s.tool_mem.entries == 1 && disk_bytes == (uint64_t)ftello(file) && disk_bytes > sizes[row]);
        }
        printf("%s{\"argument_bytes\":%zu,\"configured_id_limit\":%d,\"active_ids\":%d,\"cache_payload_bytes\":%zu,\"disk_map_bytes\":%llu,\"repetitions\":%u,\"phases\":{",
               row || ceiling ? "," : "", sizes[row], ceilings[ceiling], s.tool_mem.entries, s.tool_mem.bytes,
               (unsigned long long)disk_bytes, SAMPLES);
        for (unsigned p = 0; p < 2; p++) {
            measurements *m = &measured[p];
            printf("%s\"%s\":{\"critical_sections\":%u,\"total\":", p ? "," : "", p ? "map_write" : "rebind", m->count);
            distribution(total[p], SAMPLES); printf(",\"outside_observed_locks\":"); distribution(unlocked[p], SAMPLES);
            printf(",\"lock_wait\":"); distribution(m->wait, m->count);
            printf(",\"lock_hold\":"); distribution(m->hold, m->count); printf("}");
        }
        printf("}}"); fclose(file); tool_memory_free(&s.tool_mem); buf_free(&raw[0]); buf_free(&raw[1]);
        pthread_mutex_destroy(&s.tool_mu); owner_mutex = NULL;
    }
    printf("]}\n"); return 0;
}

int main(int argc, char **argv) {
    if (argc == 2 && !strcmp(argv[1], "--tool-replay")) return profile_tool_replay();
    if (argc == 2 && !strcmp(argv[1], "--tool-store")) return profile_tool_store();
    if (argc != 1) return 2;
    server s = {0}; pthread_mutex_init(&s.mu, NULL); owner_mutex = &s.mu;
    job jobs[16] = {0}; char ids[16][32];
    for (unsigned i = 0; i < 16; i++) {
        snprintf(ids[i], sizeof(ids[i]), "profile-identity-%u", i);
        jobs[i].request_id = ids[i]; atomic_init(&jobs[i].cancelled, false);
    }
    printf("{\"scope\":\"model-free uncontended native admission/cancel/release; instrumented clocks\","
           "\"layout\":{\"server\":%zu,\"job\":%zu,\"request\":%zu,\"http_request\":%zu},\"rows\":[",
           sizeof(server), sizeof(job), sizeof(request), sizeof(http_request));
    const unsigned sizes[] = {1, 8, 16};
    const char *names[] = {"admit", "cancel_missing", "cancel_oldest", "release"};
    for (unsigned row = 0; row < 3; row++) {
        unsigned count = sizes[row]; memset(measured, 0, sizeof(measured));
        for (unsigned sample = 0; sample < SAMPLES; sample++) {
            phase = 0;
            for (unsigned i = 0; i < count; i++) {
                atomic_store(&jobs[i].cancelled, false); assert(server_admit_job(&s, &jobs[i]) == 0);
            }
            phase = 1; assert(!server_cancel_request(&s, "absent-identity"));
            phase = 2; assert(server_cancel_request(&s, ids[0]));
            assert(atomic_load(&jobs[0].cancelled));
            phase = 3;
            for (unsigned i = 0; i < count; i++) server_release_job(&s, &jobs[i]);
            assert(!s.live_jobs && !s.generation_clients); phase = -1;
        }
        printf("%s{\"active_requests\":%u,\"repetitions\":%u,\"phases\":{", row ? "," : "", count, SAMPLES);
        for (unsigned p = 0; p < PHASES; p++) {
            measurements *m = &measured[p];
            printf("%s\"%s\":{\"calls\":%u,\"lock_wait\":", p ? "," : "", names[p], m->count);
            distribution(m->wait, m->count); printf(",\"lock_hold\":"); distribution(m->hold, m->count); printf("}");
        }
        printf("}}");
    }
    printf("]}\n"); pthread_mutex_destroy(&s.mu); return 0;
}
