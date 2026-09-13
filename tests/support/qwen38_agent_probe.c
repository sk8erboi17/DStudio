/* Actual upstream/derived parsers and tool dispatch. Engine identity is a test
 * double only for prompt routing; this harness never loads model weights. */
#include "ds4.h"
#include <assert.h>
static bool probe_vision;
static bool probe_qwen(ds4_engine *engine) { (void)engine; return true; }
static bool probe_has_vision(ds4_engine *engine) { (void)engine; return probe_vision; }
#define ds4_engine_is_qwen4 probe_qwen
#define ds4_engine_has_vision probe_has_vision
#define DS4_AGENT_TEST
#define DS4_AGENT_TEST_NO_MAIN
#include "ds4_agent.c"

static const char *literal_call =
    "<tool_call>\n<function=write>\n<parameter=path>\nreport.md\n</parameter>\n"
    "<parameter=content>\nA literal </tool_call> is document text, not a boundary.\n"
    "Unicode: caffè. Escaped &lt;/parameter> remains literal.\n</parameter>\n"
    "</function>\n</tool_call>";
static const char *literal_content =
    "A literal </tool_call> is document text, not a boundary.\n"
    "Unicode: caffè. Escaped </parameter> remains literal.";

static int check_parser_boundaries(void) {
    size_t failures = 0;
    for (size_t split = 0; split <= strlen(literal_call); split++) {
        agent_dsml_parser p = {.syntax = AGENT_TOOL_SYNTAX_QWEN,
                               .state = AGENT_DSML_SEARCH};
        agent_dsml_feed(&p, literal_call, split);
        agent_dsml_feed(&p, literal_call + split, strlen(literal_call) - split);
        agent_dsml_finish(&p);
        const char *value = p.calls.len == 1 ? agent_tool_arg_value(&p.calls.v[0], "content") : NULL;
        if (p.state != AGENT_DSML_DONE || !value || strcmp(value, literal_content)) {
            fprintf(stderr, "literal-markup split=%zu state=%d calls=%d error=%s\n",
                    split, p.state, p.calls.len, p.error);
            failures++;
        }
        agent_dsml_parser_free(&p);
    }
    printf("{\"case\":\"literal-markup-fragmentation\",\"checks\":%zu,\"failures\":%zu}\n",
           strlen(literal_call) + 1, failures);
    return failures ? 1 : 0;
}

static void check_incomplete_calls(void) {
    const char *bad[] = {
        "<tool_call>\n<function=write>\n<parameter=content>\nunfinished </tool_call>",
        "<tool_call>\n<function=write>\n<parameter=content>\nx\n</parameter>\n</tool_call>",
        "<tool_call>\n<function=write>\n<parameter=>\nx\n</parameter>\n</function>\n</tool_call>"
    };
    for (size_t i = 0; i < sizeof(bad)/sizeof(bad[0]); i++) {
        agent_dsml_parser p = {.syntax = AGENT_TOOL_SYNTAX_QWEN, .state = AGENT_DSML_SEARCH};
        agent_dsml_feed(&p, bad[i], strlen(bad[i]));
        agent_dsml_finish(&p);
        assert(p.state != AGENT_DSML_DONE && p.calls.len == 0);
        agent_dsml_parser_free(&p);
    }
    puts("{\"case\":\"invalid-or-incomplete-not-executable\",\"checks\":3,\"passed\":true}");
}

static int check_json_document_values(void) {
    const char *values[]={"{\"markup\":\"&lt;/parameter>\"}","[\"&lt;/parameter>\"]"};
    const char *expected[]={"{\"markup\":\"</parameter>\"}","[\"</parameter>\"]"};
    size_t failures=0,checks=0;
    for(size_t i=0;i<2;i++) {
        char text[512];snprintf(text,sizeof(text),"<tool_call><function=write><parameter=content>\n%s\n</parameter></function></tool_call>",values[i]);
        for(size_t split=0;split<=strlen(text);split++) {
            agent_dsml_parser p={.syntax=AGENT_TOOL_SYNTAX_QWEN,.state=AGENT_DSML_SEARCH};
            agent_dsml_feed(&p,text,split);agent_dsml_feed(&p,text+split,strlen(text)-split);agent_dsml_finish(&p);
            const char *content=p.calls.len==1?agent_tool_arg_value(&p.calls.v[0],"content"):NULL;
            if(p.state!=AGENT_DSML_DONE||!content||strcmp(content,expected[i])) failures++;
            checks++;agent_dsml_parser_free(&p);
        }
    }
    printf("{\"case\":\"json-document-delimiter-escapes\",\"checks\":%zu,\"failures\":%zu}\n",checks,failures);
    return failures?1:0;
}

#ifdef DSTUDIO_TEST_DERIVED
static void emit_text(const char *name, const char *value) {
    size_t cap = strlen(value) * 6 + 8;
    char *escaped = xmalloc(cap);
    ds4ui_json_escape(value, escaped, cap);
    printf("{\"case\":\"%s\",\"text\":\"%s\"}\n", name, escaped);
    free(escaped);
}

static void prompts(void) {
    for (int cowork = 0; cowork < 2; cowork++) for (int vision = 0; vision < 2; vision++)
    for (int upto = 0; upto < 2; upto++) {
        probe_vision = vision;
        assert(setenv("DS4UI_RUNTIME_NAME", cowork ? "cowork" : "agent", 1) == 0);
        char *prompt = agent_build_tools_prompt(NULL, upto);
        assert(prompt);
        size_t cap = strlen(prompt) * 6 + 8;
        char *escaped = xmalloc(cap);
        ds4ui_json_escape(prompt, escaped, cap);
        printf("{\"case\":\"prompt\",\"cowork\":%d,\"vision\":%d,\"upto\":%d,\"text\":\"%s\"}\n",
               cowork, vision, upto, escaped);
        free(escaped); free(prompt);
    }
}

static char *execute_qwen_call(agent_worker *worker, const char *text) {
    agent_dsml_parser p = {.syntax = AGENT_TOOL_SYNTAX_QWEN, .state = AGENT_DSML_SEARCH};
    for (size_t i = 0; text[i]; i++) agent_dsml_feed(&p, text + i, 1);
    agent_dsml_finish(&p);
    assert(p.state == AGENT_DSML_DONE && p.calls.len == 1);
    agent_tool_observation obs = agent_execute_tool_observation(worker, &p.calls);
    assert(obs.part_count == 1 && obs.parts[0].text);
    char *result = xstrdup(obs.parts[0].text);
    agent_tool_observation_free(&obs);
    agent_dsml_parser_free(&p);
    return result;
}

static void cowork_tools(agent_worker *worker) {
    assert(setenv("DS4UI_RUNTIME_NAME", "cowork", 1) == 0);
    assert(access("notes.md", F_OK) != 0);
    const char *content = "# Field notes\nCaffè and gardens. Literal </tool_call>.";
    const char *write = "<tool_call>\n<function=write_document>\n"
        "<parameter=path>\nnotes.md\n</parameter>\n"
        "<parameter=content>\n# Field notes\nCaffè and gardens. Literal </tool_call>.\n"
        "</parameter>\n</function>\n</tool_call>";
    char *result = execute_qwen_call(worker, write);
    emit_text("cowork-write-observation", result);
    assert(!strstr(result, "error:"));
    free(result);
    char *actual = ds4ui_read_file_buf("notes.md");
    assert(actual && !strcmp(actual, content));
    free(actual);
    result = execute_qwen_call(worker, "<tool_call>\n<function=read_document>\n"
        "<parameter=path>\nnotes.md\n</parameter>\n</function>\n</tool_call>");
    assert(strstr(result, content));
    emit_text("cowork-read-observation", result);
    free(result);

    /* Both the traversal target and the symlink destination are fixtures in
     * this run's parent, never user files. Neither rejected call may write. */
    assert(symlink("../outside.md", "linked.md") == 0);
    const char *paths[] = {"../outside.md", "linked.md"};
    for (size_t i = 0; i < sizeof(paths)/sizeof(paths[0]); i++) {
        char call[512];
        snprintf(call, sizeof(call), "<tool_call>\n<function=write_document>\n"
            "<parameter=path>\n%s\n</parameter>\n<parameter=content>\nwrong\n"
            "</parameter>\n</function>\n</tool_call>", paths[i]);
        result = execute_qwen_call(worker, call);
        assert(strstr(result, "error:"));
        emit_text("cowork-rejected-observation", result);
        free(result);
        actual = ds4ui_read_file_buf("../outside.md");
        assert(actual && !strcmp(actual, "outside fixture stays unchanged\n"));
        free(actual);
    }
    actual = ds4ui_read_file_buf("notes.md");
    assert(actual && !strcmp(actual, content));
    free(actual);
    puts("{\"case\":\"real-cowork-documents\",\"passed\":true,\"rejectedWrites\":2}");
}

static void tools(void) {
    probe_vision = false;
    assert(setenv("DS4UI_RUNTIME_NAME", "agent", 1) == 0);
    assert(access("report.md", F_OK) != 0);
    agent_config cfg = {.jsonl = true, .non_interactive = true};
    agent_worker worker = {.cfg = &cfg, .wake_fd = {-1, -1}};
    assert(pthread_mutex_init(&worker.mu, NULL) == 0);
    agent_dsml_parser p = {.syntax = AGENT_TOOL_SYNTAX_QWEN, .state = AGENT_DSML_SEARCH};
    for (size_t i = 0; i < strlen(literal_call); i++) agent_dsml_feed(&p, literal_call + i, 1);
    agent_dsml_finish(&p);
    assert(p.state == AGENT_DSML_DONE && p.calls.len == 1);
    /* Parsing prepares a call: it cannot itself write the requested artifact. */
    assert(access("report.md", F_OK) != 0);
    agent_tool_observation obs = agent_execute_tool_observation(&worker, &p.calls);
    char *actual = ds4ui_read_file_buf("report.md");
    assert(actual && !strcmp(actual, literal_content));
    assert(!strstr(obs.parts[0].text, "Tool error:"));
    free(actual); agent_tool_observation_free(&obs); agent_dsml_parser_free(&p);
    assert(worker.out && strstr(worker.out, "\"type\":\"tool_call\"") &&
           strstr(worker.out, "\"type\":\"tool_result\""));
    cowork_tools(&worker);
    emit_text("tool-events", worker.out);
    free(worker.out); pthread_mutex_destroy(&worker.mu);
    puts("{\"case\":\"real-tool-write\",\"passed\":true}");
}
#endif

int main(void) {
    ds4_agent_unit_tests_run();
    printf("{\"case\":\"upstream-agent-units\",\"failures\":%d}\n", agent_test_failures);
    int failed = check_parser_boundaries();
    failed |= check_json_document_values();
    check_incomplete_calls();
#ifdef DSTUDIO_TEST_DERIVED
    prompts();
    if (!failed) tools();
#endif
    return failed || agent_test_failures;
}
