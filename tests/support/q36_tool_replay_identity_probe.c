/* Execute the native cache/parser/renderer. No inference or tool execution. */
#include <assert.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>
#include <stdbool.h>
#include <stdatomic.h>
#include <errno.h>
#include <time.h>
static pthread_mutex_t *watched_mutex;
static const char *watched_text;
static _Thread_local bool observe;
static atomic_uint expensive_under_lock;
static _Thread_local unsigned cache_lock_depth;
static pthread_mutex_t barrier = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t barrier_cv = PTHREAD_COND_INITIALIZER;
static unsigned preparing;
static bool released;
static int observed_lock(pthread_mutex_t *m) {
    int rc = pthread_mutex_lock(m);
    if (!rc && observe && m == watched_mutex) cache_lock_depth++;
    return rc;
}
static int observed_unlock(pthread_mutex_t *m) {
    if (observe && m == watched_mutex) {assert(cache_lock_depth); cache_lock_depth--;}
    return pthread_mutex_unlock(m);
}
static void observe_lock(void) {
    if (observe && cache_lock_depth) atomic_fetch_add(&expensive_under_lock, 1);
}
static void *observed_malloc(size_t n) {observe_lock(); return malloc(n);}
static void *observed_realloc(void *p, size_t n) {observe_lock(); return realloc(p, n);}
static void observed_free(void *p) {observe_lock(); free(p);}
static size_t observed_strlen(const char *s) {
    if (observe && s == watched_text) {
        observe_lock(); pthread_mutex_lock(&barrier); preparing++;
        pthread_cond_broadcast(&barrier_cv);
        while (!released) pthread_cond_wait(&barrier_cv, &barrier);
        pthread_mutex_unlock(&barrier);
    }
    return strlen(s);
}
#define malloc observed_malloc
#define realloc observed_realloc
#define free observed_free
#define strlen observed_strlen
#define pthread_mutex_lock observed_lock
#define pthread_mutex_unlock observed_unlock
#define Q36_SERVER_TEST
#define Q36_SERVER_TEST_NO_MAIN
#include "q36_server.c"
#undef malloc
#undef realloc
#undef free
#undef strlen
#undef pthread_mutex_lock
#undef pthread_mutex_unlock

static unsigned failures, cases;
static void result(const char *name, bool passed) {
    cases++; failures += !passed;
    buf row = {0}; buf_puts(&row, "{\"name\":"); json_escape(&row, name);
    buf_printf(&row, ",\"passed\":%s}", passed ? "true" : "false");
    puts(row.ptr); buf_free(&row);
}

static const char *sampled = "<tool_call>\n\n<function=read_file>\n"
    "<parameter=path>\noriginal.txt\n</parameter>\n"
    "<parameter=limit>\n12\n</parameter>\n</function>\n</tool_call>";

static chat_msgs history(const char *name, const char *args) {
    chat_msgs msgs = {0};
    chat_msg msg = {.role = xstrdup("assistant"), .content = xstrdup("")};
    tool_calls_push(&msg.calls, (tool_call){.id = xstrdup("call_original"),
        .name = xstrdup(name), .arguments = xstrdup(args)});
    chat_msgs_push(&msgs, msg); return msgs;
}

static void semantic_cases(bool batched, bool disk) {
    struct scenario {const char *name, *tool, *arguments; bool exact;} rows[] = {
        {"unchanged fields retain sampled bytes", "read_file", "{\"path\":\"original.txt\",\"limit\":12}", true},
        {"reordered fields retain sampled bytes", "read_file", "{\"limit\":12,\"path\":\"original.txt\"}", true},
        {"escaped string and whitespace preserve identity", "read_file", " { \"limit\" : 12, \"path\" : \"original\\u002etxt\" } ", true},
        {"same ID cannot replace changed path", "read_file", "{\"path\":\"changed.txt\",\"limit\":12}", false},
        {"same ID cannot replace changed tool", "write_file", "{\"path\":\"original.txt\",\"limit\":12}", false},
        {"string is not a JSON number", "read_file", "{\"path\":\"original.txt\",\"limit\":\"12\"}", false},
        {"omitted argument cannot be restored", "read_file", "{\"path\":\"original.txt\"}", false},
        {"added argument cannot be hidden", "read_file", "{\"path\":\"original.txt\",\"limit\":12,\"extra\":true}", false},
        {"duplicate field is ambiguous", "read_file", "{\"path\":\"original.txt\",\"limit\":12,\"limit\":12}", false},
        {"trailing JSON cannot acquire a cache hit", "read_file", "{\"path\":\"original.txt\",\"limit\":12} true", false},
        {"missing separator is not an identity", "read_file", "{\"path\":\"original.txt\" \"limit\":12}", false},
        {"trailing separator is not an identity", "read_file", "{\"path\":\"original.txt\",\"limit\":12,}", false},
        {"changed numeric value cannot be hidden", "read_file", "{\"path\":\"original.txt\",\"limit\":13}", false},
    };
    for (size_t i = 0; i < sizeof(rows)/sizeof(rows[0]); i++) {
        server s = {.batched_mode = batched}; pthread_mutex_init(&s.tool_mu, NULL);
        if (disk) {
            server source = {0}; tool_memory_put(&source, "call_original", sampled);
            FILE *fp = tmpfile(); assert(fp); uint64_t written = 0;
            assert(kv_tool_map_write(&source, fp, sampled, &written) && written);
            rewind(fp); assert(kv_tool_map_load_from_pos(&s, fp, NULL) == 1);
            fclose(fp); tool_memory_free(&source.tool_mem);
        } else tool_memory_put(&s, "call_original", sampled);
        chat_msgs msgs = history(rows[i].tool, rows[i].arguments);
        char *before = render_chat_prompt_text(&msgs, NULL, NULL, Q36_THINK_NONE);
        tool_replay_stats stats = {0}; tool_memory_attach_to_messages(&s, &msgs, &stats, NULL);
        char *after = render_chat_prompt_text(&msgs, NULL, NULL, Q36_THINK_NONE);
        bool attached = msgs.v[0].calls.raw_tool_text != NULL;
        bool pass = rows[i].exact
            ? attached && strstr(after, sampled) && stats.canonical == 0 && (disk ? stats.disk : stats.mem) == 1
            : !attached && !strcmp(before, after) && stats.canonical == 1 && !stats.mem && !stats.disk;
        char name[256]; snprintf(name, sizeof(name), "%s / %s / %s", batched ? "batched" : "single", disk ? "disk" : "RAM", rows[i].name);
        result(name, pass); free(before); free(after); chat_msgs_free(&msgs);
        tool_memory_free(&s.tool_mem); pthread_mutex_destroy(&s.tool_mu);
    }
}

static void group_cases(void) {
    const char *second = "<tool_call>\n<function=inspect>\n<parameter=value>\nsecond\n</parameter>\n</function>\n</tool_call>";
    buf raw = {0}; buf_puts(&raw, sampled); buf_puts(&raw, "\n\n"); buf_puts(&raw, second);
    for (int batch = 0; batch < 2; batch++) for (int mode = 0; mode < 7; mode++) {
        server s = {.batched_mode = batch}; pthread_mutex_init(&s.tool_mu, NULL);
        tool_calls original = {0}; char *content = NULL, *reasoning = NULL;
        assert(parse_generated_message(raw.ptr, &content, &reasoning, &original) && original.len == 2);
        original.v[0].id = xstrdup("call_original"); original.v[1].id = xstrdup("call_second");
        tool_memory_remember(&s, &original);
        chat_msgs msgs = history("read_file", "{\"limit\":12,\"path\":\"original.txt\"}");
        if (mode != 1) tool_calls_push(&msgs.v[0].calls, (tool_call){.id = xstrdup("call_second"),
            .name = xstrdup("inspect"), .arguments = xstrdup("{\"value\":\"second\"}")});
        if (mode == 2) {tool_call temp = msgs.v[0].calls.v[0]; msgs.v[0].calls.v[0] = msgs.v[0].calls.v[1]; msgs.v[0].calls.v[1] = temp;}
        if (mode == 3) {free(msgs.v[0].calls.v[1].id); msgs.v[0].calls.v[1].id = xstrdup("call_original");}
        if (mode == 4) {char *id = msgs.v[0].calls.v[0].id; msgs.v[0].calls.v[0].id = msgs.v[0].calls.v[1].id; msgs.v[0].calls.v[1].id = id;}
        if (mode == 5) tool_calls_push(&msgs.v[0].calls, (tool_call){.id = xstrdup("call_extra"), .name = xstrdup("extra"), .arguments = xstrdup("{}")});
        if (mode == 6) {
            /* Actually produced legacy v1 record: no call-position field.
             * Retain readable single-call records; ambiguous groups miss. */
            tool_memory_free(&s.tool_mem);
            FILE *fp = tmpfile(); assert(fp);
            const unsigned char header[8] = {'K','T','M',1,1,0,0,0};
            unsigned char lengths[8]; le_put32(lengths, 13); le_put32(lengths + 4, (uint32_t)raw.len);
            assert(fwrite(header, 1, 8, fp) == 8 && fwrite(lengths, 1, 8, fp) == 8);
            assert(fwrite("call_original", 1, 13, fp) == 13 && fwrite(raw.ptr, 1, raw.len, fp) == raw.len);
            rewind(fp); int loaded = kv_tool_map_load_from_pos(&s, fp, NULL); fclose(fp);
            result("legacy ambiguous map reports no recovered ID", loaded == 0);
        }
        char *before = render_chat_prompt_text(&msgs, NULL, NULL, Q36_THINK_NONE);
        tool_replay_stats stats = {0}; tool_memory_attach_to_messages(&s, &msgs, &stats, NULL);
        char *after = render_chat_prompt_text(&msgs, NULL, NULL, Q36_THINK_NONE);
        bool attached = msgs.v[0].calls.raw_tool_text != NULL;
        const char *names[] = {"complete ordered call list keeps exact bytes", "subset cannot restore extra calls",
            "changed call order is retained", "duplicate IDs cannot replay a group", "IDs cannot exchange call positions",
            "superset cannot lose a call", "legacy grouped disk record cannot invent ID positions"};
        char name[256]; snprintf(name, sizeof(name), "%s / %s", batch ? "batched" : "single", names[mode]);
        result(name, mode == 0 ? attached && !strcmp(msgs.v[0].calls.raw_tool_text, raw.ptr)
            : !attached && !strcmp(before, after) && stats.canonical == 1);
        free(before); free(after); chat_msgs_free(&msgs); free(content); free(reasoning); tool_calls_free(&original);
        tool_memory_free(&s.tool_mem); pthread_mutex_destroy(&s.tool_mu);
    }
    buf_free(&raw);
}

static void nested_cases(void) {
    const char *json = "{\"obj\":{\"x\":true,\"y\":null},\"list\":[1,2],\"large\":9007199254740992,\"unicode\":\"\\ud83d\\ude80\"}";
    const char *variants[] = {
        "{\"unicode\":\"🚀\",\"large\":9007199254740992,\"list\":[1,2],\"obj\":{\"y\":null,\"x\":true}}",
        "{\"obj\":{\"x\":true,\"y\":null},\"list\":[2,1],\"large\":9007199254740992,\"unicode\":\"🚀\"}",
        "{\"obj\":{\"x\":true,\"y\":null},\"list\":[1,2],\"large\":9007199254740993,\"unicode\":\"🚀\"}",
        "{\"obj\":{\"x\":true,\"x\":false,\"y\":null},\"list\":[1,2],\"large\":9007199254740992,\"unicode\":\"🚀\"}",
        "{\"obj\":{\"x\":true,\"y\":null},\"list\":[1,2],\"large\":09007199254740992,\"unicode\":\"🚀\"}",
        "{\"obj\":{\"x\":true,\"y\":null},\"list\":[1,2],\"large\":9007199254740992,\"unicode\":\"\\ud83d\"}",
    };
    buf raw = {0}; buf_puts(&raw, "<tool_call>\n<function=inspect>\n<parameter=data>\n");
    buf_puts(&raw, json); buf_puts(&raw, "\n</parameter>\n</function>\n</tool_call>");
    for (size_t i = 0; i < sizeof(variants)/sizeof(*variants); i++) {
        server s = {0}; tool_memory_put(&s, "call_original", raw.ptr);
        buf args = {0}; buf_puts(&args, "{\"data\":"); buf_puts(&args, variants[i]); buf_putc(&args, '}');
        chat_msgs msgs = history("inspect", args.ptr); tool_replay_stats stats = {0};
        tool_memory_attach_to_messages(&s, &msgs, &stats, NULL);
        const char *names[] = {"nested key order and valid unicode escapes match", "array order is not an object-key order",
            "large integers cannot compare through rounded doubles", "nested duplicate key is ambiguous",
            "invalid JSON number cannot hit", "lone surrogate cannot hit"};
        result(names[i], (msgs.v[0].calls.raw_tool_text != NULL) == (i == 0));
        chat_msgs_free(&msgs); buf_free(&args); tool_memory_free(&s.tool_mem);
    }
    buf_free(&raw);
}

static void prefix_cases(void) {
    const char *prefixes[] = {"altered source fact\n", "<think>unrelated reasoning</think>\n", "\n\n"};
    for (size_t i = 0; i < sizeof(prefixes)/sizeof(*prefixes); i++) {
        server s = {0}; buf raw = {0}; buf_puts(&raw, prefixes[i]); buf_puts(&raw, sampled);
        tool_memory_put_source(&s, "call_original", raw.ptr, TOOL_MEMORY_DISK);
        chat_msgs msgs = history("read_file", "{\"path\":\"original.txt\",\"limit\":12}");
        char *before = render_chat_prompt_text(&msgs, NULL, NULL, Q36_THINK_NONE);
        tool_replay_stats stats = {0}; tool_memory_attach_to_messages(&s, &msgs, &stats, NULL);
        char *after = render_chat_prompt_text(&msgs, NULL, NULL, Q36_THINK_NONE);
        result(i == 0 ? "cache cannot prepend unrelated content" : i == 1 ? "cache cannot insert unrelated reasoning" : "sampled leading whitespace remains replayable",
            i == 2 ? msgs.v[0].calls.raw_tool_text && !strcmp(msgs.v[0].calls.raw_tool_text, raw.ptr)
                   : !msgs.v[0].calls.raw_tool_text && !strcmp(before, after));
        free(before); free(after); buf_free(&raw); chat_msgs_free(&msgs); tool_memory_free(&s.tool_mem);
    }
}

static void bounded_cases(void) {
    for (int count = 128; count <= 129; count++) {
        server s = {0}; tool_calls original = {0}; buf raw = {0};
        for (int i = 0; i < count; i++) {
            if (i) buf_putc(&raw, '\n');
            buf_puts(&raw, "<tool_call>\n\n<function=inspect>\n</function>\n</tool_call>");
            char id[32]; snprintf(id, sizeof(id), "call_%d", i);
            tool_calls_push(&original, (tool_call){.id = xstrdup(id), .name = xstrdup("inspect"), .arguments = xstrdup("{}")});
        }
        original.raw_tool_text = buf_take(&raw); tool_memory_remember(&s, &original);
        chat_msgs msgs = {0}; chat_msg message = {.role = xstrdup("assistant"), .content = xstrdup("")};
        for (int i = 0; i < count; i++) tool_calls_push(&message.calls, (tool_call){.id = xstrdup(original.v[i].id),
            .name = xstrdup("inspect"), .arguments = xstrdup("{}")});
        chat_msgs_push(&msgs, message);
        char *before = render_chat_prompt_text(&msgs, NULL, NULL, Q36_THINK_NONE);
        tool_replay_stats stats = {0}; tool_memory_attach_to_messages(&s, &msgs, &stats, NULL);
        char *after = render_chat_prompt_text(&msgs, NULL, NULL, Q36_THINK_NONE);
        result(count == 128 ? "128-call replay boundary retains the complete group" : "over-bound group keeps every incoming call without exact replay",
            count == 128 ? msgs.v[0].calls.raw_tool_text && !strcmp(msgs.v[0].calls.raw_tool_text, original.raw_tool_text)
                         : !msgs.v[0].calls.raw_tool_text && !strcmp(before, after) && msgs.v[0].calls.len == count);
        free(before); free(after); chat_msgs_free(&msgs); tool_calls_free(&original); tool_memory_free(&s.tool_mem);
    }
    for (int count = 63; count <= 65; count += 2) {
        server s = {0}; buf value = {0}, raw = {0}, args = {0};
        for (int i = 0; i < count; i++) buf_putc(&value, '[');
        buf_putc(&value, '0'); for (int i = 0; i < count; i++) buf_putc(&value, ']');
        buf_puts(&raw, "<tool_call>\n\n<function=inspect>\n<parameter=data>\n");
        buf_puts(&raw, value.ptr); buf_puts(&raw, "\n</parameter>\n</function>\n</tool_call>");
        tool_memory_put(&s, "call_original", raw.ptr);
        buf_puts(&args, "{\"data\":"); buf_puts(&args, value.ptr); buf_putc(&args, '}');
        chat_msgs msgs = history("inspect", args.ptr); tool_replay_stats stats = {0};
        char *before = render_chat_prompt_text(&msgs, NULL, NULL, Q36_THINK_NONE);
        tool_memory_attach_to_messages(&s, &msgs, &stats, NULL);
        char *after = render_chat_prompt_text(&msgs, NULL, NULL, Q36_THINK_NONE);
        result(count == 63 ? "bounded nested JSON retains exact replay" : "deeper JSON retains the incoming request through a cache miss",
            count == 63 ? msgs.v[0].calls.raw_tool_text != NULL : !msgs.v[0].calls.raw_tool_text && !strcmp(before, after));
        free(before); free(after); chat_msgs_free(&msgs); buf_free(&value); buf_free(&raw); buf_free(&args); tool_memory_free(&s.tool_mem);
    }
}

typedef struct {server *s; chat_msgs *msgs; tool_replay_stats stats;} reader;
static void *read_block(void *p) {
    reader *r = p; observe = true;
    tool_memory_attach_to_messages(r->s, r->msgs, &r->stats, NULL);
    observe = false; return NULL;
}
static void race_cases(void) {
    for (int mode = 0; mode < 4; mode++) {
        server s = {.batched_mode = true}; pthread_mutex_init(&s.tool_mu, NULL);
        s.tool_mem.max_entries = 1; tool_memory_put(&s, "call_original", sampled);
        watched_text = tool_memory_find_entry_locked(&s.tool_mem, "call_original")->block->qwen_tool;
        watched_mutex = &s.tool_mu; atomic_store(&expensive_under_lock, 0); preparing = 0; released = false;
        chat_msgs msgs = history("read_file", "{\"path\":\"original.txt\",\"limit\":12}");
        reader r = {.s = &s, .msgs = &msgs}; pthread_t thread;
        assert(pthread_create(&thread, NULL, read_block, &r) == 0);
        chat_msgs other = history("read_file", "{\"limit\":12,\"path\":\"original.txt\"}");
        reader r2 = {.s = &s, .msgs = &other}; pthread_t second;
        if (mode == 3) assert(pthread_create(&second, NULL, read_block, &r2) == 0);
        pthread_mutex_lock(&barrier);
        struct timespec until; clock_gettime(CLOCK_REALTIME, &until); until.tv_sec += 2;
        unsigned expected = mode == 3 ? 2 : 1;
        int rc = 0; while (preparing < expected && !rc) rc = pthread_cond_timedwait(&barrier_cv, &barrier, &until);
        bool overlapped = preparing >= expected;
        pthread_mutex_unlock(&barrier);
        bool unlocked = overlapped && pthread_mutex_trylock(&s.tool_mu) == 0;
        if (unlocked) pthread_mutex_unlock(&s.tool_mu);
        result("paused replay preparation leaves the tool owner available", unlocked);
        if (unlocked && mode == 1) tool_memory_put(&s, "call_original", "<tool_call>\n<function=other>\n</function>\n</tool_call>");
        if (unlocked && mode == 2) tool_memory_put(&s, "call_other", sampled);
        pthread_mutex_lock(&barrier); released = true; pthread_cond_broadcast(&barrier_cv); pthread_mutex_unlock(&barrier);
        pthread_join(thread, NULL);
        if (mode == 3) pthread_join(second, NULL);
        result(mode == 0 ? "unchanged pinned replay commits" : mode == 1 ? "changed ID mapping rejects stale preparation" : mode == 2 ? "evicted ID rejects stale preparation" : "independent preparations overlap and retain their results",
            unlocked && ((msgs.v[0].calls.raw_tool_text != NULL) == (mode == 0 || mode == 3)) && (mode != 3 || other.v[0].calls.raw_tool_text));
        result("replay allocations, retirement and large text work stay outside cache synchronization", !atomic_load(&expensive_under_lock));
        watched_mutex = NULL; watched_text = NULL;
        chat_msgs_free(&msgs); chat_msgs_free(&other); tool_memory_free(&s.tool_mem); pthread_mutex_destroy(&s.tool_mu);
    }
}

int main(int argc, char **argv) {
    if (argc == 2 && !strcmp(argv[1], "--races")) {
        race_cases();
        printf("{\"cases\":%u,\"failures\":%u,\"scope\":\"deterministic native replay ownership; no inference\"}\n", cases, failures);
        return failures ? 1 : 0;
    }
    for (int batch = 0; batch < 2; batch++) for (int disk = 0; disk < 2; disk++) semantic_cases(batch, disk);
    group_cases(); nested_cases(); prefix_cases(); bounded_cases();
    printf("{\"cases\":%u,\"failures\":%u,\"scope\":\"native tool replay identity; no inference\"}\n", cases, failures);
    return failures ? 1 : 0;
}
