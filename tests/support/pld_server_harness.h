/* Execute the production Chat eval/cleanup hooks with deterministic stream
 * boundaries. Protocol parsing/networking are doubles; this is not inference. */
#include <pthread.h>
typedef struct {
    ds4_engine *engine;
    bool batched_mode;
    int slot_count;
    pthread_mutex_t inference_mu;
} pld_test_server;
typedef struct { ds4_session *session; } pld_test_slot;
typedef struct {
    struct {
        bool ignore_eos, temperature_set;
        float temperature;
        int think_mode;
    } req;
    bool cancelled;
} pld_test_job;
static bool g_stop_requested;
static bool job_cancelled(pld_test_job *j) {return j->cancelled;}
static bool ds4_think_mode_enabled(int mode) {return mode!=0;}
static const ds4_tokens *ds4_session_tokens(ds4_session *s) {return &s->checkpoint;}
static int server_eval_token(pld_test_server *s,pld_test_slot *slot,int token,
                             char *err,size_t n) {
    if(g_stop_requested)return 1;
    pthread_mutex_lock(&s->inference_mu);
    int rc=ds4_session_eval(slot->session,token,err,n);
    pthread_mutex_unlock(&s->inference_mu);
    return rc;
}

static void mode_tests(void) {
    const char *names[]={"DS4UI_AGENT_PLD","DS4UI_COWORK_PLD","DS4UI_CHAT_PLD"};
    const char *values[]={NULL,"strict","batch","off","typo",""};
    for(int i=0;i<3;i++)unsetenv(names[i]);
    for(int global=0;global<6;global++) for(int surface=0;surface<3;surface++)
    for(int local=0;local<6;local++) {
        if(values[global])setenv("DS4UI_PLD",values[global],1);else unsetenv("DS4UI_PLD");
        if(values[local])setenv(names[surface],values[local],1);else unsetenv(names[surface]);
        int chosen=local?local:global;
        CHECK(ds4ui_pld_mode_for(names[surface])==
            (chosen==2?DS4UI_PLD_BATCH:chosen==3?DS4UI_PLD_OFF:DS4UI_PLD_STRICT));
        unsetenv(names[surface]);
    }
    /* An Agent-specific experimental opt-in must not enable Chat/Cowork. */
    unsetenv("DS4UI_PLD");setenv(names[0],"batch",1);
    CHECK(ds4ui_pld_mode_for(names[1])==DS4UI_PLD_STRICT);
    CHECK(ds4ui_pld_mode_for(names[2])==DS4UI_PLD_STRICT);
    unsetenv(names[0]);
}

static void server_loop_tests(void) {
    /* Normal, tool end, stop-string, disconnect, write error, shutdown,
     * sampled/tool-envelope, implicit thinking defaults, images, multi-slot,
     * batched scheduler, ignore-EOS, quality, CPU, max-token/EOS boundaries,
     * verification/restore errors and snapshot-budget fallback. */
    for(int mode=0;mode<3;mode++) for(int scenario=0;scenario<21;scenario++)
    for(int boundary=0;boundary<5;boundary++) {
        ds4_session session,ref;ds4_engine engine,ref_engine;
        reset(&session,&engine);reset(&ref,&ref_engine);
        pld_test_server srv={.engine=&engine,.slot_count=1},*s=&srv;
        CHECK(pthread_mutex_init(&s->inference_mu,NULL)==0);
        pld_test_slot sl={.session=&session},*slot=&sl;
        pld_test_job request={.req={.temperature_set=true}},*j=&request;
        ds4ui_pld_index pld={0};
        const ds4ui_pld_mode pld_mode=mode==0?DS4UI_PLD_STRICT:
                                      mode==1?DS4UI_PLD_BATCH:DS4UI_PLD_OFF;
        bool multimodal=false;g_stop_requested=false;char err[160]={0};
        for(int i=0;i<10;i++) {
            CHECK(ds4_session_eval(&session,i%8,err,sizeof(err))==0);
            CHECK(ds4_session_eval(&ref,i%8,err,sizeof(err))==0);
        }
        float temperature=0;int max_tokens=5,completion=0;
        const char *finish="length";
        if(scenario==6){j->req.temperature=1;temperature=1;}
        if(scenario==7)j->req.temperature=1; /* forced greedy tool envelope */
        if(scenario==8){j->req.think_mode=1;j->req.temperature_set=false;temperature=1;}
        if(scenario==9)multimodal=true;
        if(scenario==10)s->slot_count=2;
        if(scenario==11)s->batched_mode=true;
        if(scenario==12)j->req.ignore_eos=true;
        if(scenario==13)engine.quality=true;
        if(scenario==14)engine.backend=DS4_BACKEND_CPU;
        if(scenario==15)max_tokens=boundary; /* includes zero remaining budget */
        if(scenario==16)max_tokens=8; /* EOS in proposed suffix */
        if(scenario==17)fake_fail_verify=1;
        if(scenario==19)fake_payload_bytes=129ull*1024*1024;
        if(scenario==20){j->req.think_mode=1;j->req.temperature_set=true;}
        bool injected_restore=false;
        while(completion<max_tokens && !j->cancelled && !g_stop_requested) {
            int token=ds4_session_argmax(slot->session);
            if(ds4_token_is_stop_for_think_mode(s->engine,token,j->req.think_mode)) {
                finish="stop";break;
            }
            ds4ui_pld_transaction pld_tx={0};
            const int pld_completion_start=completion;
            bool pld_discard=false;
            int toks[17],ntok=0;
#include "../../patch/ds4-agent-jsonl/pld_server_eval.inc"
            CHECK(ntok>0&&ntok<=max_tokens-completion);
            bool stop_decode=false;
            for(int ti=0;ti<ntok && completion<max_tokens;ti++) {
                if(scenario==3&&completion==boundary)j->cancelled=true;
                if(scenario==5&&completion==boundary)g_stop_requested=true;
                if(g_stop_requested||job_cancelled(j)){stop_decode=true;break;}
                token=toks[ti];
                CHECK(token==2+completion); /* no speculative token reaches output unchecked */
                completion++;
                CHECK(ds4_session_eval(&ref,token,err,sizeof(err))==0);
                if((scenario==1||scenario==2||scenario==4||scenario==18)&&completion==boundary+1) {
                    finish=scenario==4?"error":scenario==2?"stop":"tool_calls";
                    stop_decode=true;
                    if(scenario==2) {pld_discard=true;ds4_session_invalidate(slot->session);}
                    if(scenario==18&&pld_tx.active&&ti+1<ntok) {
                        fake_fail_load=1;injected_restore=true;
                    }
                    break;
                }
            }
#include "../../patch/ds4-agent-jsonl/pld_server_finish.inc"
            CHECK(!pld_tx.active&&!pld_tx.before.ptr);
            if(stop_decode)break;
        }
        const bool bypass=scenario>=6&&scenario<=14;
        if(mode!=1||bypass|| (scenario==15&&boundary<2))CHECK(fake_verify_calls==0);
        else if(scenario==19)CHECK(fake_verify_calls==0&&pld.fallbacks>0);
        else CHECK(fake_verify_calls>0);
        if(scenario==17&&mode==1)CHECK(strcmp(finish,"error")==0&&completion==0);
        if(injected_restore) {
            CHECK(strcmp(finish,"error")==0);CHECK(!session.checkpoint_valid);
        } else {
            /* The unchanged serial server evaluates one token before polling
             * cancellation in its emission loop. Only PLD owns a snapshot
             * capable of retracting that future token here. */
            if(mode!=1&&(scenario==3||scenario==5))
                CHECK(ds4_session_eval(&ref,ds4_session_argmax(&ref),err,sizeof(err))==0);
            /* Compare validity only where these hooks guarantee it; baseline
             * request cleanup clears protocol bindings separately. */
            if(scenario==2)CHECK(!session.checkpoint_valid);
            if(mode==1&&(scenario==3||scenario==4||scenario==5))CHECK(!session.checkpoint_valid);
            ref.checkpoint_valid=session.checkpoint_valid;
            if(session.checkpoint.len!=ref.checkpoint.len)
                fprintf(stderr,"Chat mode=%d scenario=%d boundary=%d pos=%d/%d completion=%d\n",
                    mode,scenario,boundary,session.checkpoint.len,ref.checkpoint.len,completion);
            same_state(&session,&ref);
        }
        CHECK(pthread_mutex_destroy(&s->inference_mu)==0);
        free(session.graph.spec_logits);
    }
    g_stop_requested=false;
}
