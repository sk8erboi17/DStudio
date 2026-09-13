/* Goal is a Task Graph action, not a second scheduler or state store. The
 * immutable definition owns objective/budget; attempts and control transitions
 * use the existing journal. Completion checks the runtime evidence contract,
 * not arbitrary semantic correctness of the user's entire objective. */
static int goal_definition(const char *objective, const char *context, const char *display, int rounds,
                            json_dyn_buf *out) {
    /* Keep the user's explicit analysis mode in the existing durable action.
     * The expanded context may have no slash prefix; it is not the mode owner. */
    const char *action_display = display_prompt_is_guided_analysis(display) ? display : objective;
    json_dyn_buf prompt = {0};
    int ok = json_dyn_puts(&prompt,
        "Follow this persistent user goal. Work only within the user's request and existing authority. "
        "Keep working through tool/model rounds until the objective is met or real input is needed. "
        "Before claiming completion, use actual tools to verify the requested observable outcome. "
        "The LAST tool must be bash or bash_status reporting a completed verification command with exit status zero "
        "and no timeout. Choose a relevant check of the user's acceptance criteria, not a vacuous command. "
        "A plan or an intention is not completion. Preserve prior work and appended user context.\n\nGoal:\n") &&
        json_dyn_puts(&prompt, objective) && json_dyn_puts(&prompt, "\n\nRequest context:\n") &&
        json_dyn_puts(&prompt, context) && json_dyn_puts(&prompt,
        "\n\nIf blocked on the user or missing authority, explain what is needed and finish with "
        "[[DSTUDIO_GOAL_BLOCKED]]. Otherwise, only after the relevant tool checks pass, finish with "
        "[[DSTUDIO_GOAL_COMPLETE]]. Never include that completion receipt in a tool argument or a saved file.");
    ok = ok && json_dyn_puts(out,
        "{\"schemaVersion\":1,\"policy\":\"agent.general.v1\",\"mode\":\"agent\",\"executorMode\":\"native\",\"goal\":") &&
        json_dyn_put_escaped(out, objective) && json_dyn_puts(out, ",\"workspace\":") && json_dyn_put_escaped(out, g_workdir) &&
        json_dyn_printf(out, ",\"limits\":{\"maxParallelHostNodes\":1,\"maxParallelLlmNodes\":1,\"maxAttemptsPerNode\":%d},\"nodes\":[", rounds) &&
        json_dyn_puts(out,
        "{\"id\":\"goal\",\"kind\":\"agent_turn\",\"title\":\"Work towards the goal\",\"mutation\":\"workspace_write\","
        "\"capabilities\":[\"filesystem.read\",\"filesystem.write\",\"git.read\",\"terminal\",\"test.run\"],"
        "\"idempotent\":false,\"retry\":{") &&
        json_dyn_printf(out, "\"maxAttempts\":%d,\"automatic\":false},\"timeoutMs\":900000,", rounds) &&
        json_dyn_puts(out, "\"action\":{\"name\":\"agent.goal\",\"text\":") && json_dyn_put_escaped(out, prompt.ptr) &&
        json_dyn_puts(out, ",\"display\":") && json_dyn_put_escaped(out, action_display) &&
        json_dyn_puts(out,
        ",\"contains\":\"[[DSTUDIO_GOAL_COMPLETE]]\",\"requireToolResult\":true}},"
        "{\"id\":\"evidence\",\"kind\":\"gate\",\"title\":\"Check completion evidence\",\"mutation\":\"read_only\","
        "\"dependsOn\":[\"goal\"],\"capabilities\":[\"filesystem.read\"],\"action\":{\"name\":\"agent.receipt.verify\"}}]}");
    free(prompt.ptr); return ok;
}

static void api_goal_send(int fd, const char *body, const char *prompt, const char *display) {
    dtg_json_token tokens[64]; char err[512] = "Invalid goal", objective[DTG_GOAL_MAX];
    int n = dtg_json_validate_complete(body, '{', err, sizeof err)
        ? dtg_json_tokenize(body, strlen(body), tokens, 64) : -1;
    long long rounds = 8;
    if (n < 1 || !dtg_json_object_string(body,tokens,n,0,"goalObjective",objective,sizeof objective,1,err,sizeof err) ||
        !objective[0] || !dtg_json_object_int(body,tokens,n,0,"goalMaxTurns",8,1,32,&rounds,err,sizeof err)) {
        dtg_api_error(fd,"400 Bad Request",err); return;
    }
    if (strlen(prompt) + strlen(objective) > DTG_ACTION_TEXT_MAX - 1500 ||
        (display_prompt_is_guided_analysis(display) && strlen(display) > DTG_ACTION_TEXT_MAX)) {
        dtg_api_error(fd,"413 Content Too Large","Goal context exceeds the bounded action size"); return;
    }
    json_dyn_buf definition = {0};
    if (!goal_definition(objective,prompt,display,(int)rounds,&definition)) {
        free(definition.ptr); dtg_api_error(fd,"500 Internal Server Error","Cannot prepare goal"); return;
    }
    dtg_runtime *rt = dtg_store_create(definition.ptr,1,err,sizeof err);
    free(definition.ptr);
    if (!rt || !dtg_scheduler_start(rt,err,sizeof err)) { dtg_api_error(fd,"422 Unprocessable Entity",err); return; }
    const dtg_node *node = dtg_find_node_const(&rt->graph,"goal");
    json_dyn_buf result = {0};
    json_dyn_puts(&result,"{\"ok\":true,\"orchestration\":\"goal\",\"graphId\":");
    json_dyn_put_escaped(&result,rt->graph.id);
    json_dyn_printf(&result,",\"taskId\":%llu,\"from\":%zu,\"at\":%zu}",
        node ? node->operation_task_id : 0, node ? node->transcript_from : g_alen, g_alen);
    send_json(fd,"200 OK",result.ptr); free(result.ptr);
}
