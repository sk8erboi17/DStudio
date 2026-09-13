/* Execute the pinned Qwen3.6 Agent/parser and real local tools. Only model
 * identity and streamed model output are simulated; no inference in this gate. */
#include "ds4.h"
#include <assert.h>
static bool probe_qwen(ds4_engine *engine) { (void)engine; return true; }
#define ds4_engine_is_qwen35moe probe_qwen
#define DS4_AGENT_TEST
#define DS4_AGENT_TEST_NO_MAIN
#include "ds4_agent.c"

static const char call[] =
    "<tool_call>\n<function=write>\n<parameter=path>\nreport.md\n</parameter>\n"
    "<parameter=content>\nCaffè: literal </tool_call> and <function=example>.\n"
    "Escaped: &lt;/parameter>. Double: &amp;lt;/parameter>. Ordinary: &amp; &lt;div>.\n"
    "</parameter>\n</function>\n</tool_call>";
static const char expected[] =
    "Caffè: literal </tool_call> and <function=example>.\n"
    "Escaped: </parameter>. Double: &lt;/parameter>. Ordinary: &amp; &lt;div>.";

static agent_dsml_parser parser(void) {
    return (agent_dsml_parser){.syntax=agent_tool_syntax_for_engine(NULL), .state=AGENT_DSML_SEARCH};
}

static int boundaries(void) {
    size_t failures=0;
    for (size_t split=0; split<=strlen(call); split++) {
        agent_dsml_parser p=parser();
        agent_dsml_feed(&p,call,split);
        agent_dsml_feed(&p,call+split,strlen(call)-split);
        agent_dsml_finish(&p);
        const char *content=p.calls.len==1 ? agent_tool_arg_value(&p.calls.v[0],"content") : NULL;
        if (p.state!=AGENT_DSML_DONE || !content || strcmp(content,expected)) failures++;
        agent_dsml_parser_free(&p);
    }
    printf("{\"case\":\"fragmentation-and-literal-markup\",\"checks\":%zu,\"failures\":%zu}\n",strlen(call)+1,failures);
    return failures ? 1 : 0;
}

#ifdef DSTUDIO_TEST_DERIVED
static void emit(const char *name,const char *value) {
    char *escaped=xmalloc(strlen(value)*6+8);
    ds4ui_json_escape(value,escaped,strlen(value)*6+8);
    printf("{\"case\":\"%s\",\"text\":\"%s\"}\n",name,escaped);
    free(escaped);
}

static void invalid_calls(void) {
    const char *invalid[]={
        "<tool_call>\n<function=write>\n<parameter=content>\nunfinished </tool_call>",
        "<tool_call><function=write><parameter=path>one</parameter><parameter=path>two</parameter></function></tool_call>",
        "<tool_call><function=write><parameter=>x</parameter></function></tool_call>",
        "<tool_call><function=write></tool_call>",
        "<tool_call><function=>x</function></tool_call>"
    };
    for(size_t i=0;i<sizeof(invalid)/sizeof(invalid[0]);i++) {
        agent_dsml_parser p=parser();
        agent_dsml_feed(&p,invalid[i],strlen(invalid[i])); agent_dsml_finish(&p);
        assert(p.state!=AGENT_DSML_DONE);
        agent_dsml_parser_free(&p);
    }
    puts("{\"case\":\"malformed-or-ambiguous-not-executable\",\"checks\":5,\"passed\":true}");
}

static void json_document_values(void) {
    const char *values[]={"{\"markup\":\"&lt;/parameter>\"}","[\"&lt;/parameter>\"]"};
    const char *expected_values[]={"{\"markup\":\"</parameter>\"}","[\"</parameter>\"]"};
    for(size_t i=0;i<2;i++) {
        char text[512];snprintf(text,sizeof(text),"<tool_call><function=write><parameter=content>\n%s\n</parameter></function></tool_call>",values[i]);
        for(size_t split=0;split<=strlen(text);split++) {
            agent_dsml_parser p=parser();agent_dsml_feed(&p,text,split);
            agent_dsml_feed(&p,text+split,strlen(text)-split);agent_dsml_finish(&p);
            assert(p.state==AGENT_DSML_DONE&&p.calls.len==1);
            assert(!strcmp(agent_tool_arg_value(&p.calls.v[0],"content"),expected_values[i]));
            agent_dsml_parser_free(&p);
        }
    }
    puts("{\"case\":\"json-document-values-keep-literal-markup\",\"passed\":true}");
}

static void limits(void) {
    agent_dsml_parser p=parser();
    const char *start="<tool_call><function=write><parameter=content>";
    agent_dsml_feed(&p,start,strlen(start));
    char bytes[4096];memset(bytes,'x',sizeof(bytes));
    for(int i=0;i<257 && p.state!=AGENT_DSML_ERROR;i++) agent_dsml_feed(&p,bytes,sizeof(bytes));
    assert(p.state==AGENT_DSML_ERROR && p.raw_len<=1024*1024 && p.raw_cap<=2*1024*1024);
    agent_dsml_parser_free(&p);
    const char *small="<tool_call><function=list><parameter=path>.</parameter></function></tool_call>";
    p=parser();for(int i=0;i<33;i++)agent_dsml_feed(&p,small,strlen(small));
    agent_dsml_finish(&p);assert(p.state==AGENT_DSML_ERROR && p.calls.len==32);
    agent_dsml_parser_free(&p);
    p=parser();const char *function="<tool_call><function=list>";
    agent_dsml_feed(&p,function,strlen(function));
    for(int i=0;i<65;i++){char value[96];snprintf(value,sizeof(value),"<parameter=p%d>x</parameter>",i);agent_dsml_feed(&p,value,strlen(value));}
    assert(p.state==AGENT_DSML_ERROR && p.current.argc==64);agent_dsml_parser_free(&p);
    p=parser();const char *name="<tool_call><function=";
    agent_dsml_feed(&p,name,strlen(name));
    agent_dsml_feed(&p,bytes,256);assert(p.state==AGENT_DSML_ERROR);agent_dsml_parser_free(&p);
    puts("{\"case\":\"bounded-parser-storage\",\"checks\":4,\"passed\":true}");
}

static void linear_visits(void) {
    const size_t sizes[]={4096,65536};
    for(size_t i=0;i<2;i++) {
        agent_dsml_parser p=parser();
        agent_qwen_value_scan_bytes=agent_qwen_tail_scan_bytes=0;
        const char *start="<tool_call><function=write><parameter=content>";
        agent_dsml_feed(&p,start,strlen(start));
        char *body=xmalloc(sizes[i]);memset(body,'x',sizes[i]);
        agent_dsml_feed(&p,body,sizes[i]);
        const char *end="</parameter></function></tool_call>";
        agent_dsml_feed(&p,end,strlen(end));agent_dsml_finish(&p);
        assert(p.state==AGENT_DSML_DONE&&p.calls.len==1);
        assert(agent_qwen_value_scan_bytes<=12*(sizes[i]+strlen(end)));
        assert(agent_qwen_tail_scan_bytes<=64*(sizes[i]+strlen(end)));
        assert(strlen(agent_tool_arg_value(&p.calls.v[0],"content"))==sizes[i]);
        printf("{\"case\":\"linear-parser-visits\",\"bytes\":%zu,\"valueVisits\":%llu,\"tailVisits\":%llu}\n",
          sizes[i],(unsigned long long)agent_qwen_value_scan_bytes,(unsigned long long)agent_qwen_tail_scan_bytes);
        free(body);agent_dsml_parser_free(&p);
    }
}

static char *execute(agent_worker *w,const char *text) {
    agent_dsml_parser p=parser();
    for(size_t i=0;text[i];i++)agent_dsml_feed(&p,text+i,1);
    agent_dsml_finish(&p);assert(p.state==AGENT_DSML_DONE && p.calls.len==1);
    char *result=agent_execute_tool_calls(w,&p.calls);
    assert(result);agent_dsml_parser_free(&p);return result;
}

static void real_tools(void) {
    agent_config cfg={.jsonl=true,.non_interactive=true};
    agent_worker w={.cfg=&cfg,.wake_fd={-1,-1}};
    assert(!pthread_mutex_init(&w.mu,NULL));
    assert(!setenv("DS4UI_RUNTIME_NAME","agent",1));
    assert(access("report.md",F_OK)!=0);
    agent_dsml_parser p=parser();agent_dsml_feed(&p,call,strlen(call));agent_dsml_finish(&p);
    assert(access("report.md",F_OK)!=0); /* Preparation cannot write. */
    agent_dsml_parser_free(&p);
    char *result=execute(&w,call);emit("agent-write-observation",result);free(result);
    char *actual=ds4ui_read_file_buf("report.md");assert(actual && !strcmp(actual,expected));free(actual);

    assert(!setenv("DS4UI_RUNTIME_NAME","cowork",1));
    const char *doc="<tool_call>\n<function=write_document>\n<parameter=path>\nnotes.md\n</parameter>\n"
        "<parameter=content>\n# Gardens\nCaffè and plants. Literal </tool_call>.\n</parameter>\n</function>\n</tool_call>";
    result=execute(&w,doc);emit("cowork-write-observation",result);free(result);
    const char *body="# Gardens\nCaffè and plants. Literal </tool_call>.";
    actual=ds4ui_read_file_buf("notes.md");assert(actual && !strcmp(actual,body));free(actual);
    result=execute(&w,"<tool_call><function=read_document><parameter=path>notes.md</parameter></function></tool_call>");
    assert(strstr(result,body));emit("cowork-read-observation",result);free(result);
    assert(!symlink("../outside.md","linked.md"));
    const char *paths[]={"../outside.md","linked.md"};
    for(size_t i=0;i<2;i++){
        char text[512];snprintf(text,sizeof(text),"<tool_call><function=write_document><parameter=path>%s</parameter>"
          "<parameter=content>wrong</parameter></function></tool_call>",paths[i]);
        result=execute(&w,text);assert(strstr(result,"error:"));emit("cowork-rejection",result);free(result);
        actual=ds4ui_read_file_buf("../outside.md");assert(actual&&!strcmp(actual,"Outside fixture stays unchanged.\n"));free(actual);
    }
    result=execute(&w,"<tool_call><function=bash><parameter=command>touch forbidden.txt</parameter></function></tool_call>");
    assert(strstr(result,"error:") || strstr(result,"Tool error"));assert(access("forbidden.txt",F_OK)!=0);
    emit("cowork-shell-rejection",result);free(result);
    emit("tool-events",w.out ? w.out : "");
    free(w.out);pthread_mutex_destroy(&w.mu);
    puts("{\"case\":\"real-local-tools\",\"passed\":true,\"rejectedEffects\":3}");
}

static void disk_checkpoint_guard(void) {
    agent_worker w={.user_activity=true,.session_dirty=true};
    ds4_tokens tokens={0};char err[256],sha[41]="unchanged";int saved=123;
    assert(access("blocked.kv",F_OK)!=0);
    /* A NULL inference session would crash if either guard reached the
     * incomplete payload API. No file, token buffer or output may be changed. */
    assert(!agent_kv_load_path(&w,"blocked.kv",NULL,NULL,0,&tokens,NULL,err,sizeof(err)));
    assert(strstr(err,"recurrent disk checkpoints are not supported") && !tokens.len);
    assert(!agent_kv_save_path(&w,"blocked.kv",&tokens,"test",sha,NULL,0,err,sizeof(err)));
    assert(strstr(err,"recurrent disk checkpoints are not supported") && !strcmp(sha,"unchanged"));
    assert(!agent_worker_needs_save(&w));
    assert(!agent_worker_save_session_now(&w,sha,&saved,err,sizeof(err)));
    assert(strstr(err,"recurrent disk checkpoints are not supported") && saved==123);
    assert(w.user_activity&&w.session_dirty&&access("blocked.kv",F_OK)!=0);
    puts("{\"case\":\"unsupported-recurrent-disk-cache-not-used\",\"checks\":4,\"passed\":true}");
}

static void streams(void) {
    const char *chunks[]={"<think>Plan","ning</think>\n",call};
    agent_dsml_parser p=parser();
    char *output=agent_test_stream_capture(p.syntax,chunks,3,&p,NULL);
    agent_dsml_finish(&p);assert(p.state==AGENT_DSML_DONE&&p.calls.len==1);
    assert(!strcmp(agent_tool_arg_value(&p.calls.v[0],"content"),expected));
    emit("stream-visible-output",output);free(output);agent_dsml_parser_free(&p);
    const char *thinking[]={"<think>",call,"</think>\nNo tool executed."};
    p=parser();output=agent_test_stream_capture(p.syntax,thinking,3,&p,NULL);
    agent_dsml_finish(&p);assert(p.calls.len==0);free(output);agent_dsml_parser_free(&p);
    puts("{\"case\":\"stream-routing-and-reasoning-isolation\",\"checks\":2,\"passed\":true}");
}

static void prompts(void) {
    for(int cowork=0;cowork<2;cowork++) for(int upto=0;upto<2;upto++) {
        assert(!setenv("DS4UI_RUNTIME_NAME",cowork?"cowork":"agent",1));
        char *text=agent_build_tools_prompt(NULL,upto);
        emit(cowork?"cowork-prompt":"agent-prompt",text);free(text);
    }
}
#endif

int main(void) {
    ds4_agent_unit_tests_run();
    printf("{\"case\":\"native-agent-regressions\",\"failures\":%d}\n",agent_test_failures);
    int failed=boundaries();
#ifdef DSTUDIO_TEST_DERIVED
    if(!failed){invalid_calls();json_document_values();limits();linear_visits();prompts();streams();disk_checkpoint_guard();real_tools();}
#endif
    return failed || agent_test_failures;
}
