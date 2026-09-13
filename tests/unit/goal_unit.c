/* Native Goal scheduler/journal behavior. Model/tool transcript frames are
 * fixtures; runtime_steering_test separately executes actual native tools. */
#include <assert.h>
#define main dstudio_test_main
#include "../../src/dstudio.c"
#undef main

static dtg_runtime *start_goal(int turns) {
    json_dyn_buf definition = {0}; char err[512] = "";
    assert(goal_definition("Repair the parser and verify its actual output", "Only this workspace", NULL, turns, &definition));
    dtg_runtime *rt = dtg_store_create(definition.ptr, 1, err, sizeof err);
    if (!rt) fprintf(stderr,"%s\n",err);
    assert(rt); free(definition.ptr);
    assert(dtg_scheduler_start(rt,err,sizeof err));
    assert(g_dtg_agent_owner_rt == rt && g_agent_working);
    return rt;
}
static void end_turn(const char *text, int tool) {
    if (tool) {
        const char *call = "\x1e{\"type\":\"tool_call\",\"name\":\"bash\",\"input\":{\"command\":\"run parser test\"}}\n";
        const char *result = tool > 0
          ? "\x1e{\"type\":\"tool_result\",\"name\":\"bash\",\"output\":\"bash job=1 pid=12 status=done elapsed_sec=0.1 timed_out=0\\nexit_status=0\\n<output>PASS</output>\"}\n"
          : "\x1e{\"type\":\"tool_result\",\"name\":\"bash\",\"output\":\"bash job=1 pid=12 status=done elapsed_sec=0.1 timed_out=0\\nexit_status=1\\n<output>exit_status=0</output>\"}\n";
        dtg_watchdog_observe_event_line(call); dtg_watchdog_observe_event_line(result);
        agent_buf_append(call,strlen(call)); agent_buf_append(result,strlen(result));
    }
    agent_buf_append(text,strlen(text));
    /* Exercise the real healthy terminal event, including the task receipt.
     * Directly clearing working state no longer describes a completed turn. */
    static const char waiting[] = "+DWARFSTAR_WAITING\n";
    scan_lines(waiting, sizeof waiting-1, g_line_err, &g_line_err_len, 1);
    dtg_scheduler_tick(dstudio_now_ms());
}
static void settle(void) { for (int i=0;i<4;i++) dtg_scheduler_tick(dstudio_now_ms()+i); }

static void check_result_frame(const char *prefix, const char *metadata,
                                const char *header, int terminated, int expected) {
    json_dyn_buf frame = {0};
    assert(json_dyn_puts(&frame, prefix));
    assert(json_dyn_puts(&frame, "{\"type\":\"tool_result\",\"call_id\":\"check-1\",\"name\":\"bash\","));
    assert(json_dyn_puts(&frame, metadata));
    assert(json_dyn_puts(&frame, "\"output\":"));
    assert(json_dyn_put_escaped(&frame, header));
    assert(json_dyn_puts(&frame, terminated ? "}\n" : "}"));
    assert(dtg_goal_successful_check(frame.ptr, strstr(frame.ptr,"\"type\":\"tool_result\"")) == expected);
    free(frame.ptr);
}

static void check_blocked_turn(const char *active, const char *stale, int expected) {
    size_t active_len = strlen(active), stale_len = strlen(stale);
    g_abuf = malloc(active_len + stale_len); assert(g_abuf);
    memcpy(g_abuf, active, active_len); memcpy(g_abuf + active_len, stale, stale_len);
    g_abase = 0; g_alen = active_len; g_acap = active_len + stale_len;
    dtg_node node = {0}; char err[256] = ""; int needs_input = -1;
    cstr_copy(node.action_name, sizeof node.action_name, "agent.goal");
    node.action_require_tool_result = 1; node.transcript_to = active_len;
    assert(!dtg_agent_completion_contract(&node, err, sizeof err, &needs_input));
    assert(needs_input == expected);
    free(g_abuf); g_abuf = NULL; g_abase = g_alen = g_acap = 0;
}

int main(void) {
    const char *success = "bash job=1 pid=12 status=done elapsed_sec=0.1 timed_out=0\nexit_status=0\n<output>PASS</output>\n";
    check_result_frame("\x1e", "", success, 1, 1);
    check_result_frame("PASS\n\x1b[0m\x1e", "\"outcome\":\"returned\",", success, 1, 1);
    check_result_frame("output without newline\x1e", "", success, 1, 1);
    check_result_frame("\x1e", "\"outcome\":\"interrupted_or_unknown\",", success, 1, 0);
    check_result_frame("\x1e", "\"outcome\":\"not_executed\",", success, 1, 0);
    check_result_frame("\x1e", "\"outcome\":\"\",", success, 1, 0);
    check_result_frame("\x1b[0m", "", success, 1, 0); /* No native RS boundary. */
    check_result_frame("\x1e", "", success, 0, 0); /* Incomplete frame. */
    check_result_frame("\x1e", "", "bash job=1 pid=12 status=done elapsed_sec=0.1 timed_out=1\nexit_status=0\n", 1, 0);
    check_result_frame("\x1e", "", "bash job=1 pid=12 status=running elapsed_sec=0.1 timed_out=0\nexit_status=0\n", 1, 0);
    check_result_frame("\x1e", "", "bash job=1 pid=12 status=done elapsed_sec=0.1 timed_out=0\nexit_status=1\n<output>exit_status=0</output>\n", 1, 0);
    check_blocked_turn("\x01" "USER\x02Question\x01" "ENDUSER\x02\nNeed input. [[DSTUDIO_GOAL_BLOCKED]]",
        "old text\x01" "ENDUSER\x02stale answer", 1);
    check_blocked_turn("Still working.", "[[DSTUDIO_GOAL_BLOCKED]]", 0);
    check_blocked_turn("Need input. [[DSTUDIO_GOAL_\x1e{\"type\":\"status\",\"state\":\"working\"}\nBLOCKED]]", "", 1);
    check_blocked_turn("\x01" "USER\x02[[DSTUDIO_GOAL_BLOCKED]]\x01" "ENDUSER\x02\n"
        "\x1e{\"type\":\"status\",\"text\":\"[[DSTUDIO_GOAL_BLOCKED]]\"}\nStill working.", "", 0);
    char work[] = "/tmp/dstudio-goal-test-XXXXXX", err[512] = "";
    assert(mkdtemp(work)); assert(realpath(work,g_workdir));
    g_child = getpid(); /* Sentinel only: these tests never signal/cancel it. */
    g_mode = ENGINE_AGENT; g_ready = 1;
    char input_path[4096]; snprintf(input_path,sizeof input_path,"%s/runtime-input.txt",work);
    g_in_fd = open(input_path,O_CREAT|O_RDWR|O_TRUNC,0600); assert(g_in_fd >= 0);
    g_abuf = calloc(65536,1); g_acap = 65536;
    dtg_runtime *rt = start_goal(3);
    dtg_node *node = dtg_find_node(&rt->graph,"goal");
    assert(node->attempts_started == 1 && !node->automatic_retry);
    unsigned long long original = node->operation_task_id;
    end_turn("Plan only, no work yet.\n",0);
    assert(node->attempts_started == 2 && node->operation_task_id != original && node->state == DTG_NODE_RUNNING);
    char runtime_input[16384]; ssize_t n = pread(g_in_fd,runtime_input,sizeof runtime_input-1,0);
    assert(n > 0); runtime_input[n] = 0;
    assert(strstr(runtime_input,"Goal continuation, not a replay"));
    end_turn("[[DSTUDIO_GOAL_COMPLETE]]\n",1); settle();
    assert(rt->graph.state == DTG_GRAPH_SUCCEEDED);
    char id[65]; snprintf(id,sizeof id,"%s",rt->graph.id);
    dtg_registry_forget(rt); rt = dtg_store_load(work,id,err,sizeof err); assert(rt);
    assert(rt->graph.state == DTG_GRAPH_SUCCEEDED);
    assert(!strcmp(rt->graph.goal,"Repair the parser and verify its actual output"));
    assert(dtg_find_node(&rt->graph,"goal")->attempts_started == 2);

    rt = start_goal(2); node = dtg_find_node(&rt->graph,"goal");
    end_turn("[[DSTUDIO_GOAL_COMPLETE]]\n",0); /* Prose alone cannot finish. */
    assert(node->attempts_started == 2 && rt->graph.state == DTG_GRAPH_RUNNING);
    end_turn("Still no evidence.\n",0); settle();
    assert(rt->graph.state == DTG_GRAPH_NEEDS_INPUT && node->attempts_started == 2);
    assert(!dtg_scheduler_resume(rt,err,sizeof err));

    rt = start_goal(1);
    end_turn("[[DSTUDIO_GOAL_COMPLETE]]\n",-1); settle();
    assert(rt->graph.state == DTG_GRAPH_NEEDS_INPUT); /* Failed command cannot forge success in stdout. */

    rt = start_goal(3);
    static const char turn_error[] = "+DSTUDIO_TURN_ERROR\n";
    scan_lines(turn_error, sizeof turn_error-1, g_line_err, &g_line_err_len, 1);
    end_turn("[[DSTUDIO_GOAL_COMPLETE]]\n",1); settle();
    assert(rt->graph.state == DTG_GRAPH_NEEDS_INPUT);
    assert(dtg_find_node(&rt->graph,"goal")->attempts_started == 1); /* WAITING cannot erase failure or replay a turn. */

    rt = start_goal(8); node = dtg_find_node(&rt->graph,"goal");
    end_turn("I need the user's missing input. [[DSTUDIO_GOAL_BLOCKED]]\n",0); settle();
    assert(rt->graph.state == DTG_GRAPH_NEEDS_INPUT && node->attempts_started == 1);
    assert(dtg_scheduler_resume(rt,err,sizeof err)); settle();
    assert(node->attempts_started == 2);
    end_turn("[[DSTUDIO_GOAL_COMPLETE]]\n",1); settle();
    assert(rt->graph.state == DTG_GRAPH_SUCCEEDED);

    rt = start_goal(3); node = dtg_find_node(&rt->graph,"goal");
    assert(dtg_scheduler_pause(rt,err,sizeof err));
    end_turn("First part finished; more remains.\n",1); settle();
    assert(rt->graph.state == DTG_GRAPH_PAUSED && node->attempts_started == 1);
    assert(dtg_scheduler_resume(rt,err,sizeof err)); settle();
    assert(g_agent_working && node->attempts_started == 2);
    end_turn("[[DSTUDIO_GOAL_COMPLETE]]\n",1); settle();
    assert(rt->graph.state == DTG_GRAPH_SUCCEEDED);

    rt = start_goal(3); node = dtg_find_node(&rt->graph,"goal");
    end_turn("Need clarification. [[DSTUDIO_GOAL_BLOCKED]]\n",0); settle();
    dtg_node *gate = dtg_find_node(&rt->graph,"evidence");
    assert(dtg_scheduler_set_node(rt,gate,"node.blocked",DTG_NODE_BLOCKED,"Await goal",err,sizeof err));
    /* Exact crash window: the resume intent is durable, the gate reset and
     * graph.resumed are not. Loading must not dispatch anything by itself. */
    assert(dtg_store_node_event(rt,node,"goal.resume_requested",DTG_NODE_PENDING,
        node->attempts_started,"",0,0,"User requested continuation",err,sizeof err));
    snprintf(id,sizeof id,"%s",rt->graph.id);
    dtg_registry_forget(rt); rt = dtg_store_load(work,id,err,sizeof err); assert(rt);
    settle(); assert(rt->graph.state == DTG_GRAPH_NEEDS_INPUT && !g_agent_working);
    assert(dtg_scheduler_resume(rt,err,sizeof err)); settle();
    assert(dtg_find_node(&rt->graph,"goal")->attempts_started == 2);
    assert(dtg_find_node(&rt->graph,"evidence")->state != DTG_NODE_BLOCKED);
    end_turn("[[DSTUDIO_GOAL_COMPLETE]]\n",1); settle();
    assert(rt->graph.state == DTG_GRAPH_SUCCEEDED);

    rt = start_goal(3); snprintf(id,sizeof id,"%s",rt->graph.id);
    g_dtg_agent_owner_rt = NULL; g_dtg_agent_owner_node = NULL;
    g_agent_working = 0; g_active_turn_task = 0;
    dtg_registry_forget(rt); rt = dtg_store_load(work,id,err,sizeof err); assert(rt);
    settle();
    assert(rt->graph.state == DTG_GRAPH_NEEDS_INPUT);
    assert(dtg_find_node(&rt->graph,"goal")->attempts_started == 1); /* No crash replay. */
    close(g_in_fd); free(g_abuf); g_child = -1;
    printf("goal_unit: PASS — continuation, evidence gate, turn budget, blocked input, pause/resume, durable replay, no crash retry (%s)\n",work);
}
