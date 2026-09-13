/* Execute the native Agent loop with its real GGUF tokenizer and a scripted
 * session API. Compare bounded-context continuation to a no-compaction oracle.
 * This proves orchestration/stream behavior, NOT language-model quality. */
#include "ds4.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
struct ds4_session {
    ds4_tokens tokens;
    int ctx, output_pos, summary_pos, syncs, summaries, rebuilding, invalidated;
    int fail_rebuild, cancel_rebuild, changed_during, overflow;
    int tool_phase, retry_pos, final_pos, retried, total_generated;
    int speculative_calls;
    int summary_open, summary_closed, summary_unknown;
    ds4_tokens original;
    struct { size_t start, end; } notices[32];
    int notice_count;
    ds4_session_cancel_fn cancel;
    void *cancel_ud;
};
static ds4_engine *tokenizer;
static ds4_tokens scripted_output, scripted_summary, retry_output, final_output;
static int tool_case, jsonl_case, writes, partial_writes;
static int speculative_case;
static bool compact_after_reply;
static bool control_done;
static FILE *counted_fopen(const char *path, const char *mode) {
    if (strchr(mode, 'w')) {
        if (!strcmp(path, "effect.txt")) writes++;
        if (!strcmp(path, "partial.txt")) partial_writes++;
    }
    return fopen(path, mode);
}
static void *current_worker;
static int mock_sync(ds4_session *, const ds4_tokens *, char *, size_t);
static int mock_ctx(ds4_session *s) { return s->ctx; }
static int mock_pos(ds4_session *s) { return s->tokens.len; }
static int mock_common(ds4_session *s, const ds4_tokens *tokens) {
    int i = 0; while (i < s->tokens.len && i < tokens->len && s->tokens.v[i] == tokens->v[i]) i++;
    return i;
}
static void mock_progress(ds4_session *s, ds4_session_progress_fn f, void *ud) { (void)s; (void)f; (void)ud; }
static void mock_cancel(ds4_session *s, ds4_session_cancel_fn f, void *ud) { s->cancel=f; s->cancel_ud=ud; }
static int mock_argmax(ds4_session *s) {
    if (s->rebuilding) return s->summary_pos < scripted_summary.len ?
        scripted_summary.v[s->summary_pos] : ds4_token_eos(tokenizer);
    if (tool_case && s->tool_phase == 1) return s->retry_pos < retry_output.len ?
        retry_output.v[s->retry_pos] : ds4_token_eos(tokenizer);
    if (tool_case && s->tool_phase == 2) return s->final_pos < final_output.len ?
        final_output.v[s->final_pos] : ds4_token_eos(tokenizer);
    return s->output_pos < scripted_output.len ? scripted_output.v[s->output_pos] : ds4_token_eos(tokenizer);
}
static int mock_sample(ds4_session *s, float temp, int k, float p, float min, uint64_t *rng) {
    (void)temp; (void)k; (void)p; (void)min; (void)rng; return mock_argmax(s);
}
static int mock_eval(ds4_session *s, int token, char *err, size_t cap) {
    if (s->tokens.len >= s->ctx) { s->overflow++; snprintf(err, cap, "fixture context overflow"); return 1; }
    assert(token == mock_argmax(s));
    ds4_tokens_push(&s->tokens, token);
    if (s->rebuilding) s->summary_pos++;
    else {
        s->total_generated++;
        if (tool_case && s->tool_phase == 1) s->retry_pos++;
        else if (tool_case && s->tool_phase == 2) s->final_pos++;
        else s->output_pos++;
    }
    return 0;
}
static void mock_invalidate(ds4_session *s) { s->invalidated++; ds4_tokens_free(&s->tokens); }
static int mock_top(ds4_session *s, ds4_token_score *out, int k) { (void)s; (void)out; (void)k; return 0; }
static int mock_drafts(ds4_engine *e) { (void)e; return speculative_case ? 3 : 0; }
static int mock_speculative(ds4_session *s, int first, int limit, int eos,
                            int *accepted, int capacity, char *err, size_t cap) {
    s->speculative_calls++;
    int count=0;
    while(count<3 && count<limit && count<capacity) {
        int token=count ? mock_argmax(s) : first;
        accepted[count++]=token;
        if(token==eos) break;
        if(mock_eval(s,token,err,cap)) return -1;
    }
    return count;
}
#define ds4_session_ctx mock_ctx
#define ds4_session_pos mock_pos
#define ds4_session_common_prefix mock_common
#define ds4_session_set_progress mock_progress
#define ds4_session_set_display_progress mock_progress
#define ds4_session_set_cancel mock_cancel
#define ds4_session_argmax mock_argmax
#define ds4_session_sample mock_sample
#define ds4_session_eval mock_eval
#define ds4_session_invalidate mock_invalidate
#define ds4_session_sync mock_sync
#define ds4_session_top_logprobs mock_top
#define ds4_engine_mtp_draft_tokens mock_drafts
#define ds4_session_eval_speculative_argmax mock_speculative
#define fopen counted_fopen
#define DS4_AGENT_TEST
#define DS4_AGENT_TEST_NO_MAIN
#include "ds4_agent.c"
ds4_engine *dstudio_test_tokenizer_open(const char *path);
void dstudio_test_tokenizer_close(ds4_engine *engine);
static bool equal(const ds4_tokens *a, const ds4_tokens *b) {
    return a->len == b->len && (!a->len || !memcmp(a->v,b->v,(size_t)a->len*sizeof(int)));
}
static char *render(const ds4_tokens *tokens) {
    agent_buf b={0};
    for(int i=0;i<tokens->len;i++) { size_t n=0; char *p=ds4_token_text(tokenizer,tokens->v[i],&n);
        agent_buf_append(&b,p,n); free(p); }
    return agent_buf_take(&b);
}
static int mock_sync(ds4_session *s, const ds4_tokens *tokens, char *err, size_t cap) {
    agent_worker *w=current_worker;
    char *text=render(tokens);
    bool summary=strstr(text,"Output only the compact summary.")!=NULL;
    if (summary) {
        /* Observe the actual native-tokenizer request consumed by inference,
         * not the source of its prompt builder. The scripted summary contains
         * neither marker, so an old summary cannot satisfy this assertion. */
        bool open=strstr(text,"Runtime state: the current assistant reply is still open")!=NULL;
        bool closed=strstr(text,"Runtime state: no assistant reply is currently open")!=NULL;
        s->summary_open+=open && !closed;
        s->summary_closed+=closed && !open;
        s->summary_unknown+=open==closed;
    }
    if (tool_case && !summary && !s->rebuilding) {
        if (!s->tool_phase && strstr(text, "was NOT executed")) {
            s->tool_phase=1; s->retried++;
        } else if (s->tool_phase==1 && writes) s->tool_phase=2;
    }
    free(text); s->syncs++;
    if(tokens->len >= s->ctx) { s->overflow++; snprintf(err,cap,"fixture prompt overflow"); return 1; }
    if(summary) {
        assert(s->notice_count < 32);
        ds4_tokens_copy(&s->original,&w->transcript);
        const char *at=w->out, *last=NULL;
        while(at && (at=strstr(at,"\n\x1b[1;95mCOMPACTING"))) { last=at; at++; }
        assert(last);
        s->notices[s->notice_count].start=(size_t)(last-w->out);
        s->summary_pos=0; s->summaries++; s->rebuilding=1;
    } else if(s->rebuilding) {
        s->changed_during += !equal(&s->original,&w->transcript);
        s->notices[s->notice_count++].end=w->out_len;
        s->rebuilding=0;
        if(s->cancel_rebuild) worker_interrupt(w);
        if(s->fail_rebuild) { snprintf(err,cap,"injected private rebuild failure"); return 1; }
    }
    ds4_tokens_copy(&s->tokens,tokens); return 0;
}
static void *control_thread(void *arg) {
    agent_worker *w=arg;
    for (;;) {
        pthread_mutex_lock(&w->mu);
        while(!control_done && !w->queued_user_drain_pending) pthread_cond_wait(&w->cond,&w->mu);
        bool finished=control_done;
        pthread_mutex_unlock(&w->mu);
        if(finished) return NULL;
        if(worker_take_queued_user_drain_request(w)) worker_answer_queued_user_drain(w,NULL);
    }
}
typedef struct { int rc, generated, compactions, unchanged, overflow, retried, speculative;
    int summary_open, summary_closed, summary_unknown; char *text; } result;
static result run(int context, int budget, ds4_think_mode think, int failure, bool oversized) {
    ds4_session s={.ctx=context,.fail_rebuild=failure==1,.cancel_rebuild=failure==2};
    agent_config cfg={.non_interactive=true,.jsonl=jsonl_case,.gen={.ctx_size=context,.n_predict=budget,
        .temperature=0,.seed=73,.think_mode=think}};
    agent_worker w={.cfg=&cfg,.engine=tokenizer,.session=&s,.wake_fd={-1,-1},.datetime_context_injected=true};
    assert(!pthread_mutex_init(&w.mu,NULL)); assert(!pthread_cond_init(&w.cond,NULL));
    current_worker=&w;
    writes=partial_writes=0;
    pthread_t control;
    control_done=false;
    if(tool_case) assert(!pthread_create(&control,NULL,control_thread,&w));
    agent_worker_build_system_tokens(&w,&w.transcript);
    ds4_tokens prior={0};
    if(oversized) {
        ds4_chat_append_message(tokenizer,&w.transcript,"user","Earlier admitted request.");
        ds4_chat_append_assistant_prefix(tokenizer,&w.transcript,think);
        while(w.transcript.len < context-1000) ds4_tokens_push(&w.transcript,scripted_output.v[0]);
        agent_worker_append_assistant_turn_end(&w);
        ds4_tokens_copy(&prior,&w.transcript);
    }
    char *large=oversized ? render(&scripted_output) : NULL;
    if (failure == 3) worker_interrupt(&w); /* Stop after admission, before dispatch. */
    int rc=worker_run_turn(&w,large ? large : "Continue the exact response, preserving all bytes.");
    free(large);
    if (compact_after_reply) {
        char err[256]={0};
        assert(!tool_case && !rc && !failure && !oversized);
        if (!agent_worker_compact(&w,"manual",err,sizeof(err))) {
            fprintf(stderr,"manual compaction: %s\n",err); rc=1;
        }
    }
    if(tool_case) {
        pthread_mutex_lock(&w.mu); control_done=true; pthread_cond_signal(&w.cond); pthread_mutex_unlock(&w.mu);
        pthread_join(control,NULL);
    }
    agent_buf projected={0}; size_t cursor=0;
    for(int i=0;i<s.notice_count;i++) {
        assert(s.notices[i].start>=cursor && s.notices[i].end<=w.out_len);
        agent_buf_append(&projected,w.out+cursor,s.notices[i].start-cursor);
        cursor=s.notices[i].end;
    }
    if(w.out_len>cursor) agent_buf_append(&projected,w.out+cursor,w.out_len-cursor);
    result r={.rc=rc,.generated=s.total_generated,.compactions=s.summaries,.overflow=s.overflow,.retried=s.retried,
        .speculative=s.speculative_calls,
        .summary_open=s.summary_open,.summary_closed=s.summary_closed,.summary_unknown=s.summary_unknown,
        .unchanged=oversized ? equal(&prior,&w.transcript) && !s.syncs :
            !s.changed_during && (!failure || equal(&s.original,&w.transcript)),
        .text=agent_buf_take(&projected)};
    if(w.status.error[0]) fprintf(stderr,"%s\n",w.status.error);
    ds4_tokens_free(&w.transcript); ds4_tokens_free(&s.tokens); ds4_tokens_free(&s.original); ds4_tokens_free(&prior);
    free(w.out); free(w.session_title); pthread_mutex_destroy(&w.mu); pthread_cond_destroy(&w.cond);
    current_worker=NULL; return r;
}
static int cases, failed;
static void check(const char *name, bool ok, const result *r) {
    cases++; failed+=!ok;
    printf("{\"case\":\"%s\",\"passed\":%s,\"returnCode\":%d,\"generated\":%d,\"compactions\":%d,\"overflow\":%d,"
        "\"summaryOpen\":%d,\"summaryClosed\":%d,\"summaryUnknown\":%d}\n",
        name,ok?"true":"false",r->rc,r->generated,r->compactions,r->overflow,
        r->summary_open,r->summary_closed,r->summary_unknown);
}
int main(int argc,char **argv) {
    assert(argc==2);
    tokenizer=dstudio_test_tokenizer_open(argv[1]); assert(tokenizer);
    ds4_tokenize_text(tokenizer,"Only previously established facts; the exact task is still pending.",&scripted_summary);
    agent_buf text={0};
    agent_buf_puts(&text,"```c\n");
    for(int i=0;i<3500;i++) { char line[160];
        snprintf(line,sizeof(line),"int value_%d(void) { return %d; } /* Café 日本語 🧑🏾‍🚀 */\n",i,i*i);
        agent_buf_puts(&text,line); }
    agent_buf_puts(&text,"```\nEND_OF_RESPONSE");
    ds4_tokenize_text(tokenizer,text.ptr,&scripted_output); free(text.ptr);
    assert(scripted_output.len > 18000);
    const int budget=18000;
    result oracle=run(65536,budget,DS4_THINK_NONE,0,false);
    check("uncompacted-reference",!oracle.rc && oracle.generated==budget && !oracle.compactions && !oracle.overflow,&oracle);
    result bounded=run(8192,budget,DS4_THINK_NONE,0,false);
    check("resume-across-multiple-compactions",!bounded.rc && bounded.compactions>=2 && bounded.unchanged && !bounded.overflow,&bounded);
    check("output-budget-not-renewed",bounded.generated==budget,&bounded);
    check("identical-rendered-bytes",!strcmp(oracle.text,bounded.text),&bounded);
    check("mid-reply-summary-receives-open-runtime-state",bounded.compactions>=2 &&
        bounded.summary_open==bounded.compactions && !bounded.summary_closed && !bounded.summary_unknown,&bounded);
    assert(!mkdir("summary-state",0700)); assert(!chdir("summary-state"));
    int full_length=scripted_output.len; scripted_output.len=9000;
    result ended_reference=run(65536,12000,DS4_THINK_NONE,0,false);
    compact_after_reply=true;
    result ended=run(8192,12000,DS4_THINK_NONE,0,false);
    compact_after_reply=false; scripted_output.len=full_length;
    check("completed-reply-updates-summary-state-before-manual-compaction",!ended_reference.rc && !ended.rc &&
        ended.generated==9000 && ended.compactions>=2 && !ended.overflow && ended.unchanged &&
        ended.summary_open==ended.compactions-1 && ended.summary_closed==1 && !ended.summary_unknown &&
        !strcmp(ended.text,ended_reference.text),&ended);
    free(ended.text); free(ended_reference.text); assert(!chdir(".."));
    result limited=run(8192,17,DS4_THINK_NONE,0,false);
    check("short-budget-no-compaction",!limited.rc && limited.generated==17 && !limited.compactions && !limited.overflow,&limited);
    result handoff_stop=run(8192,17,DS4_THINK_NONE,3,false);
    check("stop-before-dispatch-is-not-cleared",!handoff_stop.rc && !handoff_stop.generated && !handoff_stop.compactions,&handoff_stop);
    free(handoff_stop.text);
    result stop=run(8192,budget,DS4_THINK_NONE,2,false);
    check("stop-keeps-incomplete-answer",!stop.rc && stop.compactions==1 && stop.unchanged && stop.generated<budget,&stop);
    result error=run(8192,budget,DS4_THINK_NONE,1,false);
    check("failed-rebuild-keeps-incomplete-answer",error.rc==1 && error.compactions==1 && error.unchanged && error.generated<budget,&error);
    result huge=run(8192,budget,DS4_THINK_NONE,0,true);
    check("oversized-user-no-mutation-or-inference",huge.rc==1 && huge.unchanged && !huge.generated && !huge.compactions,&huge);
#ifdef DSTUDIO_COMPACT_LAGUNA
    speculative_case=1;
    result spec=run(8192,budget,DS4_THINK_NONE,0,false);
    check("native-speculative-loop-continuation",!spec.rc && spec.speculative>0 && spec.generated==budget &&
        spec.compactions>=2 && !spec.overflow && !strcmp(spec.text,oracle.text),&spec);
    int length=scripted_output.len; scripted_output.len=17;
    result eos=run(8192,100,DS4_THINK_NONE,0,false);
    check("model-stop-inside-speculative-block",!eos.rc && eos.speculative>0 && eos.generated==17 && !eos.compactions && !eos.overflow,&eos);
    scripted_output.len=length; speculative_case=0;
    free(spec.text); free(eos.text);
#endif
    ds4_tokens before_thinking={0}; ds4_tokens_copy(&before_thinking,&scripted_output);
    scripted_output.len=9000;
    ds4_tokenize_rendered_chat(tokenizer,"</think>\n",&scripted_output);
    agent_tokens_append_range(&scripted_output,&before_thinking,9000,before_thinking.len);
    result think_reference=run(65536,budget,DS4_THINK_HIGH,0,false);
    result think=run(8192,budget,DS4_THINK_HIGH,0,false);
    check("thinking-and-answer-resume-identically",!think_reference.rc && !think.rc && think.generated==budget &&
        think.compactions>=2 && !think.overflow && !strcmp(think.text,think_reference.text),&think);
    ds4_tokens_copy(&scripted_output,&before_thinking); ds4_tokens_free(&before_thinking);
    free(think_reference.text); free(think.text);
    assert(!mkdir("memory-continuation",0700)); assert(!chdir("memory-continuation"));
    jsonl_case=1;
    result memory=run(8192,budget,DS4_THINK_NONE,0,false);
    check("repeated-compaction-with-memory-export",!memory.rc && memory.generated==budget && memory.compactions>=2 && memory.unchanged && !memory.overflow,&memory);
    jsonl_case=0;
    assert(!chdir("..")); assert(!mkdir("partial-tool",0700)); assert(!chdir("partial-tool"));
    bool laguna;
#ifdef DSTUDIO_COMPACT_LAGUNA
    laguna=true;
#else
    laguna=false;
#endif
    agent_buf partial={0};
    agent_buf_puts(&partial,laguna ?
        "<tool_call>write<arg_key>path</arg_key><arg_value>partial.txt</arg_value><arg_key>content</arg_key><arg_value>" :
        "<tool_call>\n<function=write>\n<parameter=path>\npartial.txt\n</parameter>\n<parameter=content>\n");
    for(int i=0;i<16000;i++) agent_buf_puts(&partial,"never commit this incomplete tool payload. ");
    ds4_tokens_free(&scripted_output);
    ds4_tokenize_rendered_chat(tokenizer,partial.ptr,&scripted_output); free(partial.ptr);
    ds4_tokenize_rendered_chat(tokenizer,laguna ?
        "<tool_call>write<arg_key>path</arg_key><arg_value>effect.txt</arg_value><arg_key>content</arg_key><arg_value>committed once</arg_value></tool_call>" :
        "<tool_call>\n<function=write>\n<parameter=path>\neffect.txt\n</parameter>\n<parameter=content>\ncommitted once\n</parameter>\n</function>\n</tool_call>",&retry_output);
    ds4_tokenize_text(tokenizer,"Finished after one confirmed write.",&final_output);
    tool_case=1;
    result partial_run=run(8192,budget,DS4_THINK_NONE,0,false);
    check("partial-tool-never-executed",!partial_writes && access("partial.txt",F_OK)!=0,&partial_run);
    char content[80]={0}; FILE *effect=fopen("effect.txt","rb");
    if(effect) { assert(!ferror(effect)); fread(content,1,sizeof(content)-1,effect); fclose(effect); }
    check("explicit-smaller-retry-commits-once",!partial_run.rc && partial_run.retried==1 && writes==1 && effect &&
        !strcmp(content,"committed once") && !partial_run.overflow,&partial_run);
    assert(!chdir("..")); assert(!mkdir("partial-tool-stop",0700)); assert(!chdir("partial-tool-stop"));
    result partial_stop=run(8192,budget,DS4_THINK_NONE,2,false);
    check("stop-before-partial-tool-discard-keeps-transcript",!partial_stop.rc && partial_stop.compactions==1 &&
        partial_stop.unchanged && !partial_stop.retried && !writes && !partial_writes &&
        access("effect.txt",F_OK)!=0 && access("partial.txt",F_OK)!=0,&partial_stop);
    tool_case=0; assert(!chdir(".."));
    free(oracle.text); free(bounded.text); free(limited.text); free(stop.text); free(error.text); free(huge.text);
    free(memory.text); free(partial_run.text); free(partial_stop.text);
    ds4_tokens_free(&scripted_output); ds4_tokens_free(&scripted_summary);
    ds4_tokens_free(&retry_output); ds4_tokens_free(&final_output); dstudio_test_tokenizer_close(tokenizer);
    printf("{\"case\":\"total\",\"passed\":%s,\"checks\":%d,\"failed\":%d}\n",failed?"false":"true",cases,failed);
    return failed?1:0;
}
