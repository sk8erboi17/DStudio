/* Execute the actual patched Agent loop with deterministic parser/tool doubles.
 * No shell/tool execution, model, GPU or network is involved. */
#include <stdarg.h>
typedef struct {
    struct { float temperature, top_p, min_p; } gen;
    struct { bool quality; } engine;
    bool edit_upto;
} agent_config;
typedef struct {
    ds4_engine *engine; ds4_session *session; ds4_tokens transcript;
    int image_count, emitted, failed;
} agent_worker;
enum { AGENT_TOOL_SYNTAX_GLM=2, AGENT_DSML_DONE=3, AGENT_DSML_ERROR=4 };
typedef struct { int state; } agent_dsml_parser;
typedef struct {
    bool tool_preflight_error, dsml_in_think, greedy;
    agent_dsml_parser *parser;
} agent_stream_renderer;
static int h_stop, h_cancel, h_error, h_switch, h_force, h_cowork, h_mtp;
static int h_forced;
static bool agent_is_cowork_runtime(void) { return h_cowork!=0; }
static void agent_trace(agent_worker *w,const char *fmt,...) {(void)w;(void)fmt;}
static void worker_apply_pending_power(agent_worker *w) {(void)w;}
static bool worker_should_interrupt(agent_worker *w) {
    return h_cancel>0 && w->emitted>=h_cancel;
}
static bool agent_stream_wants_greedy_sampling(agent_stream_renderer *s) {return s->greedy;}
static void worker_set_greedy_sampling(agent_worker *w,bool b) {(void)w;(void)b;}
static int worker_sample_with_mode(agent_worker *w,agent_config *c,bool g,uint64_t *rng) {
    (void)c;(void)g;(void)rng; return ds4_session_argmax(w->session);
}
static int ds4_token_eos(ds4_engine *e) {(void)e;return 7;}
static bool ds4_token_is_stop_for_think_mode(ds4_engine *e,int t,int m) {
    (void)e;(void)m;return t==7;
}
static int ds4_engine_mtp_draft_tokens(ds4_engine *e) {(void)e;return h_mtp?2:0;}
static int ds4_session_eval_speculative(ds4_session *s,int t,int max,int eos,
        float temp,int k,float top,float min,uint64_t *rng,int *out,int cap,
        char *err,size_t n) {
    (void)max;(void)eos;(void)temp;(void)k;(void)top;(void)min;(void)rng;(void)cap;
    out[0]=t; return ds4_session_eval(s,t,err,n)==0?1:-1;
}
static char *ds4_token_text(ds4_engine *e,int t,size_t *len) {
    (void)e; char *p=malloc(2); assert(p);p[0]=(char)('a'+t);p[1]=0;*len=1;return p;
}
static bool agent_edit_upto_forcer_should_replace(int *f,agent_dsml_parser *d,
                                                 char *text,size_t n) {
    (void)f;(void)d;(void)n;
    return h_force&&!h_forced&&text[0]=='e'; /* replace token 4 */
}
static int worker_finish_generated_token(agent_worker *w,int token,int *gen,
        double t,agent_stream_renderer *sr,bool eval,char *err,size_t n) {
    (void)t;(void)eval;
    if(h_error>0&&w->emitted+1==h_error) {
        snprintf(err,n,"injected renderer failure");return 1;
    }
    token_vec_push(&w->transcript,token); w->emitted++;(*gen)++;
    if(h_stop>0&&w->emitted==h_stop) sr->parser->state=AGENT_DSML_DONE;
    if(h_switch>0&&w->emitted==h_switch) sr->greedy=!sr->greedy;
    return 0;
}
static int worker_force_generated_text(agent_worker *w,const char *text,int max,
        int *gen,double t,agent_stream_renderer *sr,char *err,size_t n) {
    (void)text;(void)max;h_forced=1;
    if(ds4_session_eval(w->session,6,err,n))return 1;
    return worker_finish_generated_token(w,6,gen,t,sr,false,err,n);
}
static void agent_dsml_parser_free(agent_dsml_parser *p) {(void)p;}
static void agent_set_error(agent_worker *w,const char *e) {(void)e;w->failed=1;}
static int harness_round(agent_worker *w,agent_config *cfg,int max_tokens) {
    int tool_syntax=0,think_mode=0,generated=0,upto_forcer=0;
    uint64_t rng=123; char err[160]={0}; double t0=0;
    bool got_tool=false,malformed_tool=false,early_tool_error=false;
    agent_dsml_parser dsml={0}; agent_stream_renderer stream={.parser=&dsml};
#include "../../patch/ds4-agent-jsonl/pld_agent.inc"
    (void)got_tool;(void)malformed_tool;(void)early_tool_error;
    return 0;
}
static void agent_loop_tests(void) {
    ds4_session s,ref; ds4_engine e,er; char err[160];
    unsetenv("DS4UI_PLD");
    for(int cowork=0;cowork<2;cowork++)
    for(int mode=0;mode<5;mode++) for(int scenario=0;scenario<11;scenario++) {
        reset(&s,&e);reset(&ref,&er);
        h_stop=h_cancel=h_error=h_switch=h_force=h_forced=h_cowork=h_mtp=0;
        setenv("DS4UI_AGENT_PLD",mode==0?"strict":mode==1?"batch":mode==2?"off":"typo",1);
        setenv("DS4UI_COWORK_PLD",mode==0?"strict":mode==1?"batch":mode==2?"off":"typo",1);
        if(mode==4) {unsetenv("DS4UI_AGENT_PLD");unsetenv("DS4UI_COWORK_PLD");}
        h_cowork=cowork;
        int history[512]={0};
        for(int i=0;i<10;i++) {
            ds4_session_eval(&s,i%8,err,sizeof(err));
            ds4_session_eval(&ref,i%8,err,sizeof(err));history[i]=i%8;
        }
        agent_config cfg={.gen={.temperature=0,.top_p=1}};
        agent_worker w={.engine=&e,.session=&s,.transcript={history,10,512}};
        if(scenario==1)h_stop=3;
        if(scenario==2)h_cancel=2;
        if(scenario==3)h_switch=2;
        if(scenario==4){h_force=1;cfg.edit_upto=true;}
        if(scenario==5)cfg.gen.temperature=1;
        if(scenario==6)w.image_count=1;
        if(scenario==7)h_cowork=1;
        if(scenario==8)h_mtp=1;
        if(scenario==9)h_error=3;
        if(scenario==10)cfg.engine.quality=true;
        int n=harness_round(&w,&cfg,5);
        CHECK(n==(scenario==9?1:0)); CHECK(w.failed==(scenario==9));
        int expected=scenario==1?3:(scenario==2||scenario==9)?2:scenario==4?3:5;
        CHECK(w.emitted==expected); CHECK(w.transcript.len==10+expected);
        for(int i=0;i<expected;i++) {
            int t=scenario==4&&i==2?6:2+i;
            CHECK(history[10+i]==t);ds4_session_eval(&ref,t,err,sizeof(err));
        }
        if(s.checkpoint.len!=ref.checkpoint.len || s.applied!=ref.applied)
            fprintf(stderr,"Agent scenario mode=%d case=%d pos=%d/%d applied=%d/%d\n",
                    mode,scenario,s.checkpoint.len,ref.checkpoint.len,s.applied,ref.applied);
        same_state(&s,&ref);
        if(mode!=1||scenario==5||scenario==6||scenario==8||scenario==10)
            CHECK(fake_verify_calls==0);
        else CHECK(fake_verify_calls>0);
        free(s.graph.spec_logits);
    }
    unsetenv("DS4UI_AGENT_PLD");
    unsetenv("DS4UI_COWORK_PLD");
}
