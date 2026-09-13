/* Actual native cache and decode scheduler, simulated numerical sessions.
 * The file writer is held at a deterministic barrier while another slot
 * performs an actual scheduler round-trip. No model-quality claim. */
#include "q36.h"
static int scheduled_eval(q36_decode_item *, int, char *, size_t);
#define q36_sessions_eval_batch scheduled_eval
#define main text_transaction_suite_main
#include "q36_http_text_prepare_probe.c"
#undef main
#undef q36_sessions_eval_batch

static server_slot slots[2];
static bool decode_reached, decode_finished;
static int decode_result;
static bool load_case, prefill_case, cancel_case;
static bool cancel_read, stale_read, corrupt_read;
static bool shutdown_case;
static int loaded;
static void pause_writer(void) {wait_at_preparation();}
static void check_prefill_disk(void) {CHECK(!srv.model_busy); outside_locks();}
static int scheduled_eval(q36_decode_item *items, int count, char *err, size_t len) {
    (void)err; (void)len;
    for (int i = 0; i < count; i++) {
        simulated_session *s = (simulated_session *)items[i].session;
        assert(s->tokens.len < 32); s->ids[s->tokens.len++] = items[i].token;
        s->logits[0] = (float)items[i].token;
    }
    pthread_mutex_lock(&barrier_mu); decode_reached = true;
    pthread_cond_broadcast(&barrier_cv); pthread_mutex_unlock(&barrier_mu); return 0;
}
static void *save_job(void *unused) {
    (void)unused;
    if (load_case) {
        q36_tokens effective = {0}; char *path = NULL;
        loaded = server_kv_try_load_text(&srv, &slots[0], "abcdz", &effective, &path);
        if (cancel_read || stale_read || corrupt_read) CHECK(!loaded && !effective.len && !path);
        else CHECK(loaded == 4 && effective.len == 5 && effective.v[4] == 'z');
        q36_tokens_free(&effective); free(path);
    } else server_kv_store_current(&srv, &slots[0], "cold");
    return NULL;
}
static void *decode_job(void *unused) {
    (void)unused; char err[160]; decode_result = server_eval_token(&srv, &slots[1], 42, err, sizeof err);
    pthread_mutex_lock(&barrier_mu); decode_finished = true;
    pthread_cond_broadcast(&barrier_cv); pthread_mutex_unlock(&barrier_mu); return NULL;
}
int main(int argc, char **argv) {
    if (argc != 2 && argc != 3) return 2;
    load_case = argc == 3 && !strcmp(argv[2], "--load");
    prefill_case = argc == 3 && !strcmp(argv[2], "--prefill");
    cancel_case = argc == 3 && !strcmp(argv[2], "--cancel-write");
    cancel_read = argc == 3 && !strcmp(argv[2], "--cancel-read");
    stale_read = argc == 3 && !strcmp(argv[2], "--stale-read");
    corrupt_read = argc == 3 && !strcmp(argv[2], "--corrupt-read");
    shutdown_case = argc == 3 && !strcmp(argv[2], "--shutdown");
    load_case |= cancel_read || stale_read || corrupt_read;
    if (argc == 3 && !load_case && !prefill_case && !cancel_case && !shutdown_case) return 2;
    bool independent = false;
    pthread_mutex_t *locks[] = {&srv.mu, &srv.kv_mu, &srv.tool_mu, &srv.model_mu,
#ifndef Q36_PAYLOAD_RESTORE_SCHEDULE_API
        &srv.inference_mu,
#endif
    };
    for (unsigned i = 0; i < sizeof locks / sizeof *locks; i++) assert(!pthread_mutex_init(locks[i], NULL));
#ifndef Q36_PAYLOAD_RESTORE_SCHEDULE_API
    if (prefill_case) {
        /* The upstream prefill callback re-enters this mutex. Match its real
         * recursive type so the RED is ownership, not a fixture deadlock. */
        pthread_mutex_destroy(&srv.inference_mu); pthread_mutexattr_t attr;
        pthread_mutexattr_init(&attr); pthread_mutexattr_settype(&attr, PTHREAD_MUTEX_RECURSIVE);
        pthread_mutex_init(&srv.inference_mu, &attr); pthread_mutexattr_destroy(&attr);
    }
#endif
    pthread_cond_init(&srv.model_cv, NULL); srv.engine = dstudio_catalog_engine(1); srv.ctx_size = 32;
    srv.kv.enabled = true; srv.kv.dir = strdup(argv[1]); srv.kv.budget_bytes = 1024 * 1024;
    srv.kv.opt = (kv_cache_options){.min_tokens = 4, .cold_max_tokens = 32,
        .continued_interval_tokens = 4, .boundary_align_tokens = 4};
    assert(!mkdir(srv.kv.dir, 0700));
    original = new_session(); fill_state(original, 'a', 4);
    simulated_session *other = new_session(); fill_state(other, 'x', 4);
    slots[0] = (server_slot){.srv = &srv, .id = 0, .session = (q36_session *)original};
    slots[1] = (server_slot){.srv = &srv, .id = 1, .session = (q36_session *)other};
    assert(kv_cache_store_live_prefix(&srv, &slots[0], &original->tokens, 4, "cold"));
    char sha[41], before[41]; sha1_bytes_hex("abcd", 4, sha); char *retained = kv_path_for_sha(&srv.kv, sha);
    if (corrupt_read) {
        FILE *corrupt = fopen(retained, "r+b"); assert(corrupt);
        assert(!fseeko(corrupt, KV_CACHE_FIXED_HEADER + 4 + 4, SEEK_SET));
        unsigned char invalid_count[4] = {255, 255, 255, 255};
        assert(fwrite(invalid_count, 1, sizeof invalid_count, corrupt) == sizeof invalid_count);
        assert(!fclose(corrupt));
    }
    file_sha(retained, before);
    unsigned char retained_bytes[256]; FILE *file = fopen(retained, "rb"); assert(file);
    size_t retained_size = fread(retained_bytes, 1, sizeof retained_bytes, file); assert(feof(file)); fclose(file);
    fill_state(original, 'k', 4); srv.batched_mode = true; srv.slots = slots; srv.slot_count = 2;
    srv.last_prefill_slot = 1; srv.active_generations = 1;
    running = true;
    if (prefill_case) {
        released = true; srv.kv.opt.min_tokens = 6; probe_save_pause = check_prefill_disk;
        int ids[13]; for (int i = 0; i < 13; i++) ids[i] = 'k' + i;
        q36_tokens target = {.v = ids, .len = 13, .cap = 13}; char error[160];
        server_prefill_progress progress = {.srv = &srv, .slot = &slots[0],
            .prompt_tokens = 13, .cached_tokens = 4, .t0 = now_sec()};
        probe_progress(slots[0].session, server_progress_cb, &progress);
        CHECK(!server_session_sync(&srv, &slots[0], &target, error, sizeof error));
        probe_progress(slots[0].session, NULL, NULL); probe_save_pause = NULL;
        CHECK(original->tokens.len == 13 && !memcmp(original->ids, ids, sizeof ids));
        CHECK(!srv.model_busy && !slots[0].prefill_waiting && file_count(false) == 3 && !file_count(true));
        kv_cache_refresh(&srv.kv); bool eight = false, twelve = false;
        for (int i = 0; i < srv.kv.len; i++) {
            eight |= srv.kv.entry[i].tokens == 8; twelve |= srv.kv.entry[i].tokens == 12;
        }
        CHECK(eight && twelve && slots[0].continued_last_store_tokens == 12);
        char after[41]; file_sha(retained, after); CHECK(!strcmp(before, after));
        goto cleanup;
    }
    if (cancel_case || cancel_read) {
        active.fd = -1;
#ifdef Q36_PAYLOAD_SCHEDULE_API
        slots[0].current_job = &active;
#endif
    }
    if (load_case) probe_load_pause = pause_writer;
    else probe_save_pause = pause_writer;
    pthread_t writer, decoder, consumer;
    assert(!pthread_create(&decoder, NULL, decode_worker_main, &srv));
    assert(!pthread_create(&writer, NULL, save_job, NULL));
    struct timespec deadline; clock_gettime(CLOCK_REALTIME, &deadline); deadline.tv_sec += 3;
    pthread_mutex_lock(&barrier_mu);
    while (!reached) assert(!pthread_cond_timedwait(&barrier_cv, &barrier_mu, &deadline));
    pthread_mutex_unlock(&barrier_mu);
    outside_locks();
    CHECK(file_count(false) == 1 && original->tokens.len == 4 && other->tokens.len == 4);
    if (cancel_case || cancel_read) atomic_store(&active.cancelled, true);
    if (stale_read) {
        replacement = new_session(); fill_state(replacement, 'r', 4);
        pthread_mutex_lock(&srv.mu); pthread_mutex_lock(&srv.model_mu);
        slots[0].session = (q36_session *)replacement;
        pthread_mutex_unlock(&srv.model_mu); pthread_mutex_unlock(&srv.mu);
    }
#ifdef Q36_PAYLOAD_SCHEDULE_API
    /* Contention cannot create another file, wait on disk or change a slot. */
    CHECK(!server_kv_store_live_prefix(&srv, &slots[1], &other->tokens, 4, "cold"));
    CHECK(other->tokens.len == 4 && original->tokens.len == 4);
#endif
    assert(!pthread_create(&consumer, NULL, decode_job, NULL));
    clock_gettime(CLOCK_REALTIME, &deadline); deadline.tv_sec += 1;
    pthread_mutex_lock(&barrier_mu);
    while (!decode_finished) {
        int rc = pthread_cond_timedwait(&barrier_cv, &barrier_mu, &deadline);
        if (rc == ETIMEDOUT) break;
        assert(!rc);
    }
    independent = decode_reached && decode_finished;
    CHECK(independent);
    released = true; pthread_cond_broadcast(&barrier_cv); pthread_mutex_unlock(&barrier_mu);
    assert(!pthread_join(writer, NULL)); assert(!pthread_join(consumer, NULL)); probe_save_pause = NULL;
    pthread_mutex_lock(&srv.model_mu); srv.model_stopping = true;
    pthread_cond_broadcast(&srv.model_cv); pthread_mutex_unlock(&srv.model_mu);
    assert(!pthread_join(decoder, NULL));
    CHECK(!decode_result && other->tokens.len == 5 && other->ids[4] == 42 && other->logits[0] == 42);
#ifdef Q36_PAYLOAD_RESTORE_SCHEDULE_API
    if (load_case && !cancel_read && !stale_read && !corrupt_read) {
        simulated_session *restored = (simulated_session *)slots[0].session;
        CHECK(restored != original && restored->tokens.len == 4 && restored->ids[0] == 'a');
        CHECK(original->retired && original->tokens.len == 4 && original->ids[0] == 'k');
    } else
#endif
    CHECK(original->tokens.len == 4 && original->ids[0] ==
        (load_case && !cancel_read && !stale_read && !corrupt_read ? 'a' : 'k') && !original->retired);
    if (stale_read) CHECK(slots[0].session == (q36_session *)replacement && !replacement->retired && replacement->ids[0] == 'r');
    CHECK(file_count(false) == (load_case || cancel_case ? 1 : 2) && !file_count(true));
    if (shutdown_case) {
        /* The real decoder above has been joined. Give the shutdown owner two
         * distinct final states not already on disk, as after a last turn. */
        fill_state(original, 'm', 4); fill_state(other, 't', 4);
        g_stop_requested = 1; srv.stopping = true;
#ifdef DSTUDIO_Q36_CACHE_SHUTDOWN_BASELINE
        /* Exact loop of the preceding server after its worker joins. */
        for (int i = 0; i < srv.slot_count; i++) server_kv_store_current(&srv, &slots[i], "shutdown");
#else
        server_persist_after_workers_joined(&srv);
#endif
        CHECK(file_count(false) == 4 && !file_count(true));
        char key[41]; sha1_bytes_hex("mnop", 4, key); char *final = kv_path_for_sha(&srv.kv, key);
        CHECK(access(final, F_OK) == 0); free(final);
        sha1_bytes_hex("tuvw", 4, key); final = kv_path_for_sha(&srv.kv, key);
        CHECK(access(final, F_OK) == 0); free(final);
        CHECK(original->ids[0] == 'm' && other->ids[0] == 't'); g_stop_requested = 0;
    }
    if (!load_case || cancel_read || stale_read || corrupt_read) {char after[41]; file_sha(retained, after); CHECK(!strcmp(before, after));}
    else {
        /* A successful hit may update hits/last_used, never its native bytes. */
        unsigned char after[256]; file = fopen(retained, "rb"); assert(file);
        size_t size = fread(after, 1, sizeof after, file); assert(feof(file)); fclose(file);
        CHECK(size == retained_size);
        memset(after + 12, 0, 4); memset(retained_bytes + 12, 0, 4);
        memset(after + 32, 0, 8); memset(retained_bytes + 32, 0, 8);
        CHECK(size == retained_size && !memcmp(after, retained_bytes, size));
    }
cleanup:
#ifdef Q36_PAYLOAD_SCHEDULE_API
    CHECK(!srv.kv_busy);
#endif
    free(retained); kv_cache_clear(&srv.kv); free(srv.kv.dir); tool_memory_free(&srv.tool_mem);
    for (unsigned i = 0; i < allocations; i++) free(allocated[i]);
    printf("{\"checks\":%u,\"failures\":%u,\"decodeWhileWriteBlocked\":%s,\"serverBytes\":%zu,\"slotBytes\":%zu,\"scope\":\"native scheduler/cache; simulated numerical state\"}\n",
        atomic_load(&checks), atomic_load(&failures), prefill_case ? "null" : independent ? "true" : "false",
        sizeof(server), sizeof(server_slot));
    return atomic_load(&failures) ? 1 : 0;
}
