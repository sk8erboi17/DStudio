/* Native disk-map bytes and sampled call groups; no model or actual tool. */
#include <assert.h>
#include <pthread.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <stdatomic.h>
#include <time.h>
static pthread_mutex_t *watched_mutex;
static unsigned locked_writes;
static atomic_uint locked_memory;
static _Thread_local unsigned tool_lock_depth;
static _Thread_local bool observe_memory;
static _Thread_local int allocation_fail_at, allocations;
static pthread_mutex_t write_barrier = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t write_cv = PTHREAD_COND_INITIALIZER;
static bool block_write, write_waiting, release_write;
static unsigned allocations_waiting;
static bool release_allocations;
static _Thread_local bool block_allocation;
static int fail_write_at, write_calls;
static int observed_lock(pthread_mutex_t *m) {
    int rc = pthread_mutex_lock(m); if (!rc && m == watched_mutex) tool_lock_depth++; return rc;
}
static int observed_unlock(pthread_mutex_t *m) {
    if (m == watched_mutex) {assert(tool_lock_depth); tool_lock_depth--;}
    return pthread_mutex_unlock(m);
}
static size_t observed_write(const void *p, size_t size, size_t count, FILE *fp) {
    if (tool_lock_depth) locked_writes++;
    write_calls++;
    if (fail_write_at && write_calls == fail_write_at) {errno = EIO; return 0;}
    if (block_write) {
        pthread_mutex_lock(&write_barrier); write_waiting = true;
        pthread_cond_broadcast(&write_cv);
        while (!release_write) pthread_cond_wait(&write_cv, &write_barrier);
        pthread_mutex_unlock(&write_barrier);
    }
    return fwrite(p, size, count, fp);
}
static bool allocation_failed(void) {
    if (observe_memory && tool_lock_depth) atomic_fetch_add(&locked_memory, 1);
    if (block_allocation) {
        block_allocation = false;
        pthread_mutex_lock(&write_barrier); allocations_waiting++;
        pthread_cond_broadcast(&write_cv);
        while (!release_allocations) pthread_cond_wait(&write_cv, &write_barrier);
        pthread_mutex_unlock(&write_barrier);
    }
    return allocation_fail_at && ++allocations == allocation_fail_at;
}
static void *observed_malloc(size_t n) {return allocation_failed() ? NULL : malloc(n);}
static void *observed_calloc(size_t n, size_t size) {return allocation_failed() ? NULL : calloc(n, size);}
static void *observed_realloc(void *p, size_t n) {return allocation_failed() ? NULL : realloc(p, n);}
static void observed_free(void *p) {
    if (observe_memory && tool_lock_depth) atomic_fetch_add(&locked_memory, 1);
    free(p);
}
#define malloc observed_malloc
#define calloc observed_calloc
#define realloc observed_realloc
#define free observed_free
#define pthread_mutex_lock observed_lock
#define pthread_mutex_unlock observed_unlock
#define fwrite observed_write
#define Q36_SERVER_TEST
#define Q36_SERVER_TEST_NO_MAIN
#include "q36_server.c"
#undef pthread_mutex_lock
#undef pthread_mutex_unlock
#undef fwrite
#undef malloc
#undef calloc
#undef realloc
#undef free

static unsigned cases, failures;
static void check(const char *name, bool pass) {
    cases++; failures += !pass; buf row = {0}; buf_puts(&row, "{\"name\":"); json_escape(&row, name);
    buf_printf(&row, ",\"passed\":%s}", pass ? "true" : "false"); puts(row.ptr); buf_free(&row);
}
static const char *first = "<tool_call>\n\n<function=read_file>\n<parameter=path>\nfirst.txt\n</parameter>\n</function>\n</tool_call>";
static const char *second = "<tool_call>\n<function=inspect>\n<parameter=value>\n42\n</parameter>\n</function>\n</tool_call>";

static tool_calls sample(const char *raw) {
    tool_calls calls = {0}; char *content = NULL, *reasoning = NULL;
    assert(parse_generated_message(raw, &content, &reasoning, &calls));
    for (int i = 0; i < calls.len; i++) {
        char id[32]; snprintf(id, sizeof(id), "call_%d", i); calls.v[i].id = xstrdup(id);
    }
    free(content); free(reasoning); return calls;
}
static chat_msgs incoming(const tool_calls *calls, bool swap_ids) {
    chat_msgs msgs = {0}; chat_msg msg = {.role = xstrdup("assistant"), .content = xstrdup("")};
    for (int i = 0; i < calls->len; i++) tool_calls_push(&msg.calls, (tool_call){
        .id = xstrdup(calls->v[swap_ids ? calls->len - 1 - i : i].id),
        .name = xstrdup(calls->v[i].name), .arguments = xstrdup(calls->v[i].arguments)});
    chat_msgs_push(&msgs, msg); return msgs;
}
static void disk_case(bool batch, bool group, bool surrounding) {
    server source = {.batched_mode = batch}, restored = {0};
    pthread_mutex_init(&source.tool_mu, NULL); pthread_mutex_init(&restored.tool_mu, NULL);
    buf raw = {0}; buf_puts(&raw, first); if (group) {buf_puts(&raw, "\n\n"); buf_puts(&raw, second);}
    tool_calls sampled = sample(raw.ptr); tool_memory_remember(&source, &sampled);
    buf text = {0}; if (surrounding) buf_puts(&text, "<|im_start|>assistant\nprevious answer\n\n");
    buf_puts(&text, raw.ptr); if (surrounding) buf_puts(&text, "<|im_end|>\n<|im_start|>user\nnext");
    FILE *fp = tmpfile(); assert(fp); uint64_t written = 0;
    watched_mutex = &source.tool_mu; locked_writes = 0;
    bool stored = kv_tool_map_write(&source, fp, text.ptr, &written);
    watched_mutex = NULL;
    char name[192]; snprintf(name, sizeof(name), "%s/%s/%s", batch ? "batched" : "single", group ? "group" : "one", surrounding ? "in conversation" : "bare");
    check(name, stored && written > 8 && (uint64_t)ftello(fp) == written);
    check("native disk writes never hold the tool cache mutex", locked_writes == 0);
    tool_memory_free(&source.tool_mem); /* No RAM hint survives the round-trip. */
    rewind(fp); int loaded = kv_tool_map_load_from_pos(&restored, fp, NULL);
    check("disk restores every saved call ID", loaded == sampled.len);
    chat_msgs msgs = incoming(&sampled, false); tool_replay_stats stats = {0};
    tool_memory_attach_to_messages(&restored, &msgs, &stats, NULL);
    check("disk replay retains complete sampled text and call order", msgs.v[0].calls.raw_tool_text &&
        !strcmp(msgs.v[0].calls.raw_tool_text, raw.ptr) && stats.disk == 1);
    chat_msgs_free(&msgs);
    if (group) {
        msgs = incoming(&sampled, true); memset(&stats, 0, sizeof(stats));
        char *before = render_chat_prompt_text(&msgs, NULL, NULL, Q36_THINK_NONE);
        tool_memory_attach_to_messages(&restored, &msgs, &stats, NULL);
        char *after = render_chat_prompt_text(&msgs, NULL, NULL, Q36_THINK_NONE);
        check("persisted IDs cannot exchange positions", !msgs.v[0].calls.raw_tool_text && !strcmp(before, after));
        free(before); free(after); chat_msgs_free(&msgs);
    }
    fclose(fp); tool_memory_free(&restored.tool_mem); tool_calls_free(&sampled); buf_free(&raw); buf_free(&text);
    pthread_mutex_destroy(&source.tool_mu); pthread_mutex_destroy(&restored.tool_mu);
}
#ifdef DSTUDIO_Q36_TOOL_MAP_V2
static void init_server(server *s) {
    memset(s, 0, sizeof(*s)); s->batched_mode = true;
    pthread_mutex_init(&s->tool_mu, NULL); s->kv.budget_bytes = 1024 * 1024;
}
static void free_server(server *s) {tool_memory_free(&s->tool_mem); pthread_mutex_destroy(&s->tool_mu);}
static uint8_t *file_bytes(FILE *f, size_t *len) {
    assert(!fflush(f)); assert(!fseeko(f, 0, SEEK_END)); *len = (size_t)ftello(f);
    uint8_t *data = malloc(*len ? *len : 1); assert(data); rewind(f);
    assert(fread(data, 1, *len, f) == *len); return data;
}
static FILE *byte_file(const uint8_t *data, size_t len) {
    FILE *f = tmpfile(); assert(f); assert(fwrite(data, 1, len, f) == len); rewind(f); return f;
}
static uint8_t *two_groups(size_t *len) {
    server s; init_server(&s);
    assert(tool_memory_put_ordinal(&s, "call_A", first, TOOL_MEMORY_RAM, 0));
    assert(tool_memory_put_ordinal(&s, "call_B", second, TOOL_MEMORY_RAM, 0));
    buf text = {0}; buf_puts(&text, first); buf_puts(&text, "\n<|im_end|>\n<|im_start|>assistant\n"); buf_puts(&text, second);
    FILE *f = tmpfile(); assert(f); uint64_t written;
    assert(kv_tool_map_write(&s, f, text.ptr, &written));
    uint8_t *bytes = file_bytes(f, len); assert(*len == written && le_get32(bytes + 4) == 2);
    fclose(f); buf_free(&text); free_server(&s); return bytes;
}
static bool rejected_without_mutation(const uint8_t *data, size_t len) {
    server s; init_server(&s); assert(tool_memory_put_ordinal(&s, "sentinel", first, TOOL_MEMORY_RAM, 0));
    uint64_t generation = s.tool_mem.identity_clock; size_t original = s.tool_mem.bytes;
    FILE *f = byte_file(data, len); int loaded = kv_tool_map_load_from_pos(&s, f, NULL);
    bool ok = !loaded && s.tool_mem.entries == 1 && s.tool_mem.bytes == original &&
        s.tool_mem.identity_clock == generation && tool_memory_has_id(&s, "sentinel");
    fclose(f); free_server(&s); return ok;
}
static void corrupt_cases(void) {
    size_t len; uint8_t *valid = two_groups(&len), *bad = malloc(len); assert(bad);
    bool all_cuts = true;
    for (size_t cut = 0; cut < len; cut++) if (!rejected_without_mutation(valid, cut)) {
        fprintf(stderr, "partial import at byte %zu of %zu\n", cut, len); all_cuts = false; break;
    }
    char title[128]; snprintf(title, sizeof title, "all %zu byte-truncation positions preserve the prior cache", len);
    check(title, all_cuts);
    /* Version 3 adds the sampled-prelude flags before ID bytes. Corrupt the
     * ID itself on both versions; zeroing an already-zero flag tests nothing. */
    assert(valid[3] == 2 || valid[3] == 3);
    size_t id_header = valid[3] == 3 ? 12u : 8u;
    size_t first_id = 20 + strlen(first), second_group = first_id + id_header + strlen("call_A");
    size_t second_id = second_group + 12 + strlen(second);
    for (int variant = 0; variant < 8; variant++) {
        memcpy(bad, valid, len);
        switch (variant) {
            case 0: bad[3] = 99; break;
            case 1: le_put32(bad + 4, UINT32_MAX); break;
            case 2: le_put32(bad + 8, UINT32_MAX); break;
            case 3: le_put32(bad + first_id, 1); break;
            case 4: le_put32(bad + second_id + 4, 257); break;
            case 5: bad[first_id + id_header] = 0; break;
            case 6: bad[20] = 0; break;
            case 7: memcpy(bad + second_id + id_header, bad + first_id + id_header, strlen("call_A")); break;
        }
        const char *names[] = {"unknown format", "group count overflow", "text size overflow",
            "invalid call position", "oversized ID", "NUL ID", "NUL sampled text", "duplicate ID across groups"};
        check(names[variant], rejected_without_mutation(bad, len));
    }
    server s; init_server(&s);
    assert(tool_memory_put_ordinal(&s, "call_A", second, TOOL_MEMORY_RAM, 0));
    uint64_t prior = tool_memory_find_entry_locked(&s.tool_mem, "call_A")->generation;
    FILE *f = byte_file(valid, len); int loaded = kv_tool_map_load_from_pos(&s, f, NULL);
    tool_memory_entry *e = tool_memory_find_entry_locked(&s.tool_mem, "call_A");
    check("historical disk data cannot rebind a current RAM ID", loaded == 1 && e &&
        e->source == TOOL_MEMORY_RAM && e->generation == prior && !strcmp(e->block->qwen_tool, second));
    fclose(f); free_server(&s); free(valid); free(bad);
}
static void allocation_cases(void) {
    for (int fail = 1; fail <= 4; fail++) {
        server s; init_server(&s); assert(tool_memory_put_ordinal(&s, "call_A", first, TOOL_MEMORY_RAM, 0));
        uint64_t generation = s.tool_mem.identity_clock; size_t bytes = s.tool_mem.bytes;
        watched_mutex = &s.tool_mu; observe_memory = true;
        allocation_fail_at = fail; allocations = 0;
        bool put = tool_memory_put_prepared(&s, "call_A", second, TOOL_MEMORY_RAM, 0);
        allocation_fail_at = 0; observe_memory = false; watched_mutex = NULL;
        char name[128]; snprintf(name, sizeof name, "cache allocation failure %d preserves the old binding", fail);
        check(name, !put && s.tool_mem.identity_clock == generation && s.tool_mem.bytes == bytes &&
            !strcmp(tool_memory_find_entry_locked(&s.tool_mem, "call_A")->block->qwen_tool, first));
        free_server(&s);
    }
    for (int fail = 1; fail <= 2; fail++) {
        server s; init_server(&s); allocation_fail_at = fail; allocations = 0;
        bool put = tool_memory_put_prepared(&s, "call_A", first, TOOL_MEMORY_RAM, 0);
        allocation_fail_at = 0;
        check("failed lazy index allocation leaves an empty reusable cache", !put && !s.tool_mem.entries &&
            tool_memory_put_prepared(&s, "call_A", first, TOOL_MEMORY_RAM, 0)); free_server(&s);
    }
    server s; init_server(&s); s.tool_mem.max_entries = 2; watched_mutex = &s.tool_mu; observe_memory = true;
    assert(tool_memory_put_ordinal(&s, "call_A", first, TOOL_MEMORY_RAM, 0));
    assert(tool_memory_put_ordinal(&s, "call_B", second, TOOL_MEMORY_RAM, 0));
    assert(tool_memory_put_ordinal(&s, "call_C", second, TOOL_MEMORY_RAM, 0));
    kv_tool_snapshot map = {0}; assert(kv_tool_snapshot_prepare(&s, second, &map, NULL, NULL));
    FILE *f = tmpfile(); assert(f); uint64_t written;
    assert(kv_tool_snapshot_write(&map, f, NULL, NULL, &written)); kv_tool_snapshot_free(&map);
    observe_memory = false; watched_mutex = NULL;
    check("LRU capacity evicts only the oldest identity", !tool_memory_has_id(&s, "call_A") &&
        tool_memory_has_id(&s, "call_B") && tool_memory_has_id(&s, "call_C") && s.tool_mem.entries == 2);
    check("cache insertion, eviction and map preparation allocate/free outside tool_mu", !atomic_load(&locked_memory));
    fclose(f); free_server(&s);
}
static void index_bounds_cases(void) {
    server s; init_server(&s); char names[33][32]; unsigned found = 0;
    for (unsigned n = 0; found < 33; n++) {
        char id[32]; snprintf(id, sizeof id, "collision-%u", n);
        if (tool_bucket(id) == 0) memcpy(names[found++], id, strlen(id) + 1);
    }
    for (unsigned i = 0; i < 32; i++) assert(tool_memory_put_prepared(&s, names[i], first, TOOL_MEMORY_RAM, 0));
    uint64_t generation = s.tool_mem.identity_clock; size_t bytes = s.tool_mem.bytes;
    bool inserted = tool_memory_put_prepared(&s, names[32], first, TOOL_MEMORY_RAM, 0);
    bool preserved = !inserted && s.tool_mem.entries == 32 && s.tool_mem.bytes == bytes && s.tool_mem.identity_clock == generation;
    for (unsigned i = 0; i < 32; i++) preserved &= tool_memory_has_id(&s, names[i]);
    check("full bounded hash chain rejects an insertion without pruning prior IDs", preserved);
    kv_tool_snapshot map = {0}; assert(kv_tool_snapshot_prepare(&s, first, &map, NULL, NULL));
    check("snapshot copies every ID across bounded 16-record owner visits", map.ids == 32 && map.len == 1);
    kv_tool_snapshot_free(&map); free_server(&s);
    init_server(&s);
    for (int i = 0; i < 100; i++) {
        char id[32]; snprintf(id, sizeof id, "retained-%d", i);
        assert(tool_memory_put_prepared(&s, id, first, TOOL_MEMORY_RAM, 0));
    }
    generation = s.tool_mem.identity_clock; bytes = s.tool_mem.bytes; s.tool_mem.max_bytes = bytes;
    buf large = {0}; buf_puts(&large, "<tool_call>\n<function=inspect>\n<parameter=data>\n");
    for (size_t i = 0; i < bytes * 9 / 10; i++) buf_putc(&large, 'x');
    buf_puts(&large, "\n</parameter>\n</function>\n</tool_call>");
    inserted = tool_memory_put_prepared(&s, "too-costly", large.ptr, TOOL_MEMORY_RAM, 0);
    check("more than 64 required evictions reject before changing the cache", !inserted &&
        s.tool_mem.entries == 100 && s.tool_mem.bytes == bytes && s.tool_mem.identity_clock == generation);
    buf_free(&large); free_server(&s);
}
typedef struct {server *s; const char *id; bool ok;} insert_job;
static void *insert_thread(void *ptr) {
    insert_job *job = ptr; observe_memory = true; block_allocation = true;
    job->ok = tool_memory_put_prepared(job->s, job->id, second, TOOL_MEMORY_RAM, 0);
    observe_memory = false; return NULL;
}
static void insertion_races(void) {
    for (int variant = 0; variant < 3; variant++) {
        server s; init_server(&s); assert(tool_memory_put_prepared(&s, "sentinel", first, TOOL_MEMORY_RAM, 0));
        if (variant == 1) s.tool_mem.max_entries = 1;
        insert_job jobs[2] = {{&s, variant == 0 ? "sentinel" : "racing-id", false}, {&s, "racing-id", false}};
        pthread_t threads[2]; unsigned count = variant == 2 ? 2 : 1;
        allocations_waiting = 0; release_allocations = false; watched_mutex = &s.tool_mu;
        for (unsigned i = 0; i < count; i++) assert(!pthread_create(&threads[i], NULL, insert_thread, &jobs[i]));
        struct timespec until; clock_gettime(CLOCK_REALTIME, &until); until.tv_sec += 3;
        pthread_mutex_lock(&write_barrier);
        while (allocations_waiting < count) assert(!pthread_cond_timedwait(&write_cv, &write_barrier, &until));
        pthread_mutex_unlock(&write_barrier);
        int lock = pthread_mutex_trylock(&s.tool_mu); check("blocked cache allocation leaves the owner available", lock == 0);
        if (!lock) pthread_mutex_unlock(&s.tool_mu);
        if (variant == 0) assert(tool_memory_put_prepared(&s, "sentinel", second, TOOL_MEMORY_RAM, 0));
        if (variant == 1) {
            assert(tool_memory_put_prepared(&s, "racing-id", second, TOOL_MEMORY_RAM, 0));
            assert(tool_memory_put_prepared(&s, "sentinel", first, TOOL_MEMORY_RAM, 0));
        }
        uint64_t current = s.tool_mem.identity_clock;
        pthread_mutex_lock(&write_barrier); release_allocations = true; pthread_cond_broadcast(&write_cv); pthread_mutex_unlock(&write_barrier);
        for (unsigned i = 0; i < count; i++) assert(!pthread_join(threads[i], NULL));
        watched_mutex = NULL;
        if (variant == 0) check("stale prepared rebind cannot overwrite a newer identity", !jobs[0].ok && s.tool_mem.identity_clock == current);
        if (variant == 1) check("absent-present-absent ID race rejects stale insertion", !jobs[0].ok &&
            s.tool_mem.identity_clock == current && s.tool_mem.entries == 1 && !tool_memory_has_id(&s, "racing-id"));
        if (variant == 2) check("overlapping duplicate preparations publish one cache entry", jobs[0].ok != jobs[1].ok &&
            s.tool_mem.entries == 2 && s.tool_mem.identity_clock == current + 1 && tool_memory_has_id(&s, "racing-id"));
        check("racing insert preparation and retirement stay outside the owner mutex", !atomic_load(&locked_memory));
        free_server(&s);
    }
    server s; init_server(&s); assert(tool_memory_put_prepared(&s, "sentinel", first, TOOL_MEMORY_RAM, 0));
    /* Fixture with a colliding lookup key but different sampled bytes. The
     * digest alone must not authorize sharing the existing immutable block. */
    tool_memory_entry *old = tool_memory_find_entry_locked(&s.tool_mem, "sentinel"); old->block->qwen_tool[20] ^= 1;
    uint64_t generation = s.tool_mem.identity_clock;
    check("digest collision cannot substitute different sampled bytes", !tool_memory_put_prepared(&s, "new", first, TOOL_MEMORY_RAM, 0) &&
        s.tool_mem.identity_clock == generation && s.tool_mem.entries == 1);
    free_server(&s);
}
typedef struct {server *s; kv_tool_snapshot *map; const char *path; bool ok;} rewrite_job;
static void *rewrite_thread(void *ptr) {
    rewrite_job *job = ptr; job->ok = kv_cache_rewrite_tool_map(job->s, job->path, job->map, NULL, NULL); return NULL;
}
static bool cancel_after_write(void *ptr) {return write_calls >= *(int *)ptr;}
static void rewrite_cases(void) {
    const int variants =
#ifdef DSTUDIO_Q36_TOOL_MAP_V3
        8;
#else
        7;
#endif
    for (int variant = 0; variant < variants; variant++) {
        server s; init_server(&s); assert(tool_memory_put_ordinal(&s, "call_A", first, TOOL_MEMORY_RAM, 0));
        kv_tool_snapshot map = {0}; assert(kv_tool_snapshot_prepare(&s, first, &map, NULL, NULL));
        char directory[] = "/tmp/dstudio-tool-map-XXXXXX"; assert(mkdtemp(directory));
        char path[512]; snprintf(path, sizeof path, "%s/checkpoint.qkv", directory);
        FILE *file = fopen(path, "w+b"); assert(file);
        uint8_t h[KV_CACHE_FIXED_HEADER], text_len[4], payload[256]; memset(payload, 0x5a, sizeof payload);
        kv_fill_header(h, 4, 0, 0, 1, 0, 4096, 1, 2, sizeof payload); le_put32(text_len, 3);
        assert(fwrite(h, 1, sizeof h, file) == sizeof h && fwrite(text_len, 1, 4, file) == 4 &&
            fwrite("old", 1, 3, file) == 3 && fwrite(payload, 1, sizeof payload, file) == sizeof payload);
        size_t prior_len; uint8_t *prior = file_bytes(file, &prior_len); fclose(file);
        bool ok; int threshold = 2; write_calls = 0; fail_write_at = variant == 1 ? 2 : 0;
        if (variant == 3) s.kv.budget_bytes = prior_len + map.bytes - 1;
        if (variant >= 4) {
            block_write = true; write_waiting = false; release_write = false;
            rewrite_job job = {&s, &map, path, false}; pthread_t thread; assert(!pthread_create(&thread, NULL, rewrite_thread, &job));
            struct timespec until; clock_gettime(CLOCK_REALTIME, &until); until.tv_sec += 3;
            pthread_mutex_lock(&write_barrier);
            while (!write_waiting) assert(!pthread_cond_timedwait(&write_cv, &write_barrier, &until));
            pthread_mutex_unlock(&write_barrier);
            int lock = pthread_mutex_trylock(&s.tool_mu); check("blocked disk write leaves the tool owner available", lock == 0);
            if (!lock) pthread_mutex_unlock(&s.tool_mu);
            if (variant == 4) assert(tool_memory_put_ordinal(&s, "call_A", second, TOOL_MEMORY_RAM, 0));
            if (variant == 5) {FILE *changed = fopen(path, "ab"); assert(changed); fputc('!', changed); fclose(changed);}
#ifdef DSTUDIO_Q36_TOOL_MAP_V3
            if (variant == 7) assert(tool_memory_put_prepared_mode(&s, "call_A", first, TOOL_MEMORY_RAM, 0, true));
#endif
            pthread_mutex_lock(&write_barrier); release_write = true; pthread_cond_broadcast(&write_cv); pthread_mutex_unlock(&write_barrier);
            assert(!pthread_join(thread, NULL)); block_write = false; ok = job.ok;
        } else ok = kv_cache_rewrite_tool_map(&s, path, &map, variant == 2 ? cancel_after_write : NULL, &threshold);
        fail_write_at = 0;
        file = fopen(path, "rb"); assert(file); size_t after_len; uint8_t *after = file_bytes(file, &after_len); fclose(file);
        const char *names[] = {"successful rewrite retains payload and persists the map", "write failure preserves original file",
            "mid-write cancellation preserves original file", "rewrite budget failure preserves original file",
            "stale tool identity cannot publish a disk replacement", "changed destination cannot be overwritten",
            "unchanged paused rewrite can finish normally", "changed prelude alone rejects a stale disk snapshot"};
        if (variant == 0 || variant == 6) {
            file = fopen(path, "rb"); assert(file); assert(!fseeko(file, (off_t)prior_len, SEEK_SET));
            server restored; init_server(&restored); int loaded = kv_tool_map_load_from_pos(&restored, file, NULL);
            check(names[variant], ok && after_len == prior_len + map.bytes && loaded == 1 &&
                !memcmp(prior + KV_CACHE_FIXED_HEADER, after + KV_CACHE_FIXED_HEADER, prior_len - KV_CACHE_FIXED_HEADER));
            fclose(file); free_server(&restored);
        } else check(names[variant], !ok && after_len == prior_len + (variant == 5) && !memcmp(prior, after, prior_len));
        free(prior); free(after); kv_tool_snapshot_free(&map); free_server(&s);
        assert(!unlink(path)); check("failed/successful rewrite retires every task-owned temporary file", !rmdir(directory));
    }
}
#ifdef DSTUDIO_Q36_TOOL_MAP_V3
/* Independent wire fixtures, not bytes copied from a producer implementation.
 * The v1 format has one ID then text; v2/v3 group text then ordinal/ID records. */
static FILE *legacy_prelude_map(unsigned version, const char *id, const char *raw) {
    FILE *f = tmpfile(); assert(f);
    uint8_t h[20] = {'K', 'T', 'M', (uint8_t)version};
    le_put32(h + 4, 1);
    const uint32_t id_len = (uint32_t)strlen(id), text_len = (uint32_t)strlen(raw);
    if (version == 1) {
        le_put32(h + 8, id_len); le_put32(h + 12, text_len);
        assert(fwrite(h, 1, 16, f) == 16);
        assert(fwrite(id, 1, id_len, f) == id_len && fwrite(raw, 1, text_len, f) == text_len);
    } else {
        assert(version == 2);
        le_put32(h + 8, text_len); le_put32(h + 12, 1); le_put32(h + 16, 8 + id_len);
        assert(fwrite(h, 1, 20, f) == 20 && fwrite(raw, 1, text_len, f) == text_len);
        uint8_t record[8] = {0}; le_put32(record + 4, id_len);
        assert(fwrite(record, 1, 8, f) == 8 && fwrite(id, 1, id_len, f) == id_len);
    }
    rewind(f); return f;
}
static bool replay_prelude(server *s, const char *id, bool expected) {
    tool_calls calls = sample(first); free(calls.v[0].id); calls.v[0].id = xstrdup(id);
    chat_msgs msgs = incoming(&calls, false); tool_replay_stats stats = {0};
    tool_memory_attach_to_messages(s, &msgs, &stats, NULL);
    bool ok = msgs.v[0].calls.raw_tool_text && !strcmp(msgs.v[0].calls.raw_tool_text, first) &&
        msgs.v[0].calls.replay_empty_think == expected;
    chat_msgs_push(&msgs, (chat_msg){.role = xstrdup("user"), .content = xstrdup("next")});
    char *rendered = render_chat_prompt_text_profile(&msgs, NULL, NULL, Q36_THINK_HIGH, false, false);
    buf prefix = {0}; buf_puts(&prefix, "<|im_start|>assistant\n");
    if (expected) buf_puts(&prefix, "<think>\n\n</think>\n\n");
    buf_puts(&prefix, first);
    ok &= strstr(rendered, prefix.ptr) != NULL;
    free(rendered); buf_free(&prefix); chat_msgs_free(&msgs); tool_calls_free(&calls);
    return ok;
}
static void prelude_cases(void) {
    server source, restored; init_server(&source); init_server(&restored);
    assert(tool_memory_put_prepared_mode(&source, "empty", first, TOOL_MEMORY_RAM, 0, true));
    assert(tool_memory_put_prepared_mode(&source, "plain", first, TOOL_MEMORY_RAM, 0, false));
    check("identical sampled bytes retain per-ID reasoning metadata in RAM",
        replay_prelude(&source, "empty", true) && replay_prelude(&source, "plain", false));
    tool_memory_entry *old = tool_memory_find_entry_locked(&source.tool_mem, "empty");
    uint64_t generation = old->generation;
    assert(tool_memory_put_prepared_mode(&source, "empty", first, TOOL_MEMORY_RAM, 0, true));
    check("same bytes and prelude reuse the current generation",
        tool_memory_find_entry_locked(&source.tool_mem, "empty")->generation == generation);
    assert(tool_memory_put_prepared_mode(&source, "empty", first, TOOL_MEMORY_RAM, 0, false));
    check("changing only prelude publishes a new identity and rendering",
        tool_memory_find_entry_locked(&source.tool_mem, "empty")->generation > generation &&
        replay_prelude(&source, "empty", false));
    assert(tool_memory_put_prepared_mode(&source, "empty", first, TOOL_MEMORY_RAM, 0, true));
    FILE *f = tmpfile(); assert(f); uint64_t written;
    assert(kv_tool_map_write(&source, f, first, &written));
    size_t len; uint8_t *bytes = file_bytes(f, &len);
    check("version 3 explicitly encodes both flag records in one shared-text group",
        len == 8 + 12 + strlen(first) + 12 + strlen("empty") + 12 + strlen("plain") &&
        bytes[3] == 3 && le_get32(bytes + 4) == 1 && le_get32(bytes + 12) == 2);
    free_server(&source); rewind(f);
    check("disk-only replay preserves different preludes for identical sampled text",
        kv_tool_map_load_from_pos(&restored, f, NULL) == 2 &&
        replay_prelude(&restored, "empty", true) && replay_prelude(&restored, "plain", false));
    fclose(f); free_server(&restored);
    size_t flags = 20 + strlen(first) + 8;
    const uint32_t invalid[] = {2, 0x80000000u, UINT32_MAX};
    for (size_t i = 0; i < sizeof invalid / sizeof invalid[0]; i++) {
        le_put32(bytes + flags, invalid[i]);
        check("unknown prelude flag cannot partially import a map", rejected_without_mutation(bytes, len));
    }
    free(bytes);
    for (unsigned version = 1; version <= 2; version++) {
        init_server(&restored); f = legacy_prelude_map(version, "legacy", first);
        check("legacy map restores sampled text without inventing reasoning metadata",
            kv_tool_map_load_from_pos(&restored, f, NULL) == 1 && replay_prelude(&restored, "legacy", false));
        fclose(f); free_server(&restored);
    }
}
#endif
#endif
int main(void) {
    for (int batch = 0; batch < 2; batch++) for (int group = 0; group < 2; group++)
        for (int surrounding = 0; surrounding < 2; surrounding++) disk_case(batch, group, surrounding);
#ifdef DSTUDIO_Q36_TOOL_MAP_V2
    corrupt_cases(); allocation_cases(); index_bounds_cases(); insertion_races(); rewrite_cases();
#ifdef DSTUDIO_Q36_TOOL_MAP_V3
    prelude_cases();
#endif
#endif
    printf("{\"cases\":%u,\"failures\":%u,\"scope\":\"real native disk-map and renderer; no inference\"}\n", cases, failures);
    return failures ? 1 : 0;
}
