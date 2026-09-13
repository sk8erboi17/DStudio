/* Included by dstudio.c. The HTTP owner owns admission; the inference owner
 * owns transcript append. Volatile delivery receipts are NEVER replayed after
 * a crash. The browser retains unconfirmed text for explicit user review.
 * Bounds: 16 outstanding / 128 total inputs per turn, 16 KiB each, <=2 MiB.
 * No locks, worker waits or disk writes on this control path. */
typedef struct { char id[65]; char *text; int state; } steer_input;
static struct {
    char key[65]; unsigned long long turn; int open, count;
    steer_input inputs[128]; /* state: 0 pending, 1 delivered, 2 appended */
} g_steer;

static void steer_prepare(void) {
    for (int i = 0; i < g_steer.count; i++) free(g_steer.inputs[i].text);
    memset(&g_steer, 0, sizeof g_steer);
#ifndef _WIN32
    unsigned char bytes[32];
    FILE *f = fopen("/dev/urandom", "rb");
    if (!f) return;
    size_t n = fread(bytes, 1, sizeof bytes, f); fclose(f);
    if (n == sizeof bytes)
        for (size_t i = 0; i < n; i++) snprintf(g_steer.key + 2*i, 3, "%02x", bytes[i]);
#endif
}

static void steer_child_env(void) {
    char port[16]; snprintf(port, sizeof port, "%d", g_http_port);
    setenv("DSTUDIO_STEER_PORT", port, 1);
    setenv("DSTUDIO_STEER_KEY", g_steer.key, 1);
}

static int steer_active(void) {
    return g_steer.turn && g_steer.turn == g_active_turn_task &&
        MODE_IS_PIPED(g_mode) && g_child > 0 && g_agent_working && !g_interrupt_pending;
}

static void api_steer_status(int fd) {
    int active = steer_active();
    json_dyn_buf b = {0};
    json_dyn_printf(&b, "{\"ok\":true,\"turnId\":\"%llu\",\"open\":%s,\"inputs\":[",
        g_steer.turn, active && g_steer.open ? "true" : "false");
    for (int i = 0; i < g_steer.count; i++) {
        if (i) json_dyn_puts(&b, ",");
        json_dyn_puts(&b, "{\"id\":"); json_dyn_put_escaped(&b, g_steer.inputs[i].id);
        json_dyn_puts(&b, ",\"state\":");
        json_dyn_put_escaped(&b, g_steer.inputs[i].state == 2 ? "applied" :
            !active ? "unconfirmed" : g_steer.inputs[i].state == 1 ? "delivered" : "pending");
        json_dyn_puts(&b, "}");
    }
    json_dyn_puts(&b, "]}"); send_json(fd, "200 OK", b.ptr); free(b.ptr);
}

static void api_steer(int fd, const char *body) {
    dtg_json_token tokens[32]; char err[256] = "invalid steering request";
    char turn[32], id[65], text[16385];
    int n = dtg_json_validate_complete(body, '{', err, sizeof err)
        ? dtg_json_tokenize(body, strlen(body), tokens, 32) : -1;
    if (n < 1 ||
        !dtg_json_object_string(body,tokens,n,0,"expectedTurnId",turn,sizeof turn,1,err,sizeof err) ||
        !dtg_json_object_string(body,tokens,n,0,"inputId",id,sizeof id,1,err,sizeof err) ||
        !dtg_json_object_string(body,tokens,n,0,"text",text,sizeof text,1,err,sizeof err) ||
        !dtg_id_valid(id) || !text[0]) {
        dtg_api_error(fd, "400 Bad Request", err); return;
    }
    char actual[32]; snprintf(actual, sizeof actual, "%llu", g_steer.turn);
    if (strcmp(actual, turn) || !steer_active()) {
        dtg_api_error(fd, "409 Conflict", "This turn is no longer active. Your context was not sent."); return;
    }
    /* Idempotent acknowledgement, never a second append on a retried request. */
    for (int i = 0; i < g_steer.count; i++) if (!strcmp(g_steer.inputs[i].id, id)) {
        if (strcmp(g_steer.inputs[i].text, text)) dtg_api_error(fd, "409 Conflict", "Input ID already has different content");
        else api_steer_status(fd);
        return;
    }
    if (!g_steer.open) { dtg_api_error(fd, "409 Conflict", "The runtime has closed this turn. Your context was not sent."); return; }
    int pending = 0;
    for (int i = 0; i < g_steer.count; i++) pending += g_steer.inputs[i].state != 2;
    if (pending >= 16 || g_steer.count == 128) {
        dtg_api_error(fd, "429 Too Many Requests", "Context limit reached (16 pending / 128 per turn)."); return;
    }
    char *copy = ds4_strdup_local(text);
    if (!copy) { dtg_api_error(fd, "500 Internal Server Error", "Cannot retain context"); return; }
    steer_input *item = &g_steer.inputs[g_steer.count++];
    snprintf(item->id, sizeof item->id, "%s", id); item->text = copy; item->state = 0;
    api_steer_status(fd);
}

static void api_steer_pull(int fd, const char *body) {
    char key[65], tail; unsigned long long turn; unsigned ack; int finish;
    if (sscanf(body, "%64[0-9a-f]\n%llu\n%u\n%d%c", key, &turn, &ack, &finish, &tail) != 4 ||
        !g_steer.key[0] || strcmp(key, g_steer.key) || (finish != 0 && finish != 1)) {
        dtg_api_error(fd, "403 Forbidden", "Invalid runtime steering credential"); return;
    }
    if (!turn) {
        if (!g_active_turn_task || g_interrupt_pending || !MODE_IS_PIPED(g_mode)) {
            send_text(fd, "409 Conflict", "inactive", 0); return;
        }
        if (g_steer.turn != g_active_turn_task) {
            for (int i = 0; i < g_steer.count; i++) free(g_steer.inputs[i].text);
            memset(g_steer.inputs, 0, sizeof g_steer.inputs);
            g_steer.count = 0; g_steer.turn = g_active_turn_task; g_steer.open = 1;
        }
        char out[32]; snprintf(out, sizeof out, "%llu", g_steer.turn);
        send_text(fd, "200 OK", out, 0); return;
    }
    if (turn != g_steer.turn || !steer_active()) { send_text(fd,"409 Conflict","stale",0); return; }
    if (ack) {
        if (ack > (unsigned)g_steer.count || !g_steer.inputs[ack-1].state) {
            send_text(fd,"409 Conflict","invalid acknowledgement",0); return;
        }
        steer_input *item = &g_steer.inputs[ack-1];
        if (item->state != 2) {
            item->state = 2;
            /* Echo only after append, so the transcript is not optimistic. */
            agent_buf_append("\x01" "USER\x02", 6);
            agent_buf_append(item->text, strlen(item->text));
            agent_buf_append("\x01" "ENDUSER\x02\n", 10);
            /* The existing conversation stream carries the receipt across a
             * rapid Goal/GSA turn transition; no second receipt store. */
            char receipt[256];
            int n = snprintf(receipt, sizeof receipt,
                "\x1e{\"type\":\"steering_applied\",\"turnId\":\"%llu\",\"inputId\":\"%s\"}\n", turn, item->id);
            agent_buf_append(receipt, (size_t)n);
        }
    }
    for (int i = 0; i < g_steer.count; i++) if (g_steer.inputs[i].state != 2) {
        if (g_steer.inputs[i].state == 1) { send_text(fd,"409 Conflict","delivery unconfirmed",0); return; }
        json_dyn_buf b = {0};
        if (!json_dyn_printf(&b, "%d\n%s", i+1, g_steer.inputs[i].text)) {
            free(b.ptr); send_text(fd,"500 Internal Server Error","memory",0); return;
        }
        g_steer.inputs[i].state = 1;
        send_text(fd,"200 OK",b.ptr,0); free(b.ptr); return;
    }
    if (finish) g_steer.open = 0;
    send_text(fd,"200 OK","0",0);
}
