/* No weights are opened. Test the production transaction against a stateful
 * engine double; compilation against the real engine is a separate gate. */
#define _POSIX_C_SOURCE 200809L
#define DSTUDIO_PLD_NATIVE
#include "../../patch/ds4-agent-jsonl/pld_core.c"

static unsigned checks;
static int resync_calls, resync_failure, resync_position;
/* Stateful double for upstream Agent's sync helper. The production macro
 * under test must invoke this after both ordinary and snapshot rewinds. */
static int agent_worker_rewind(ds4_session *w, int pos, char *err, size_t len) {
    (void)w; (void)err; (void)len;
    resync_calls++;
    resync_position=pos;
    return resync_failure;
}
#include "../../patch/ds4-agent-jsonl/pld_agent_rewind.h"
#define CHECK(x) do { checks++; if (!(x)) { \
    fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #x); abort(); \
} } while (0)

static void reset(ds4_session *s, ds4_engine *e) {
    memset(s, 0, sizeof(*s)); memset(e, 0, sizeof(*e));
    e->backend = DS4_BACKEND_METAL;
    s->engine = e; s->checkpoint_valid = true; s->ctx_size = 512;
    s->checkpoint.v = s->storage; s->checkpoint.cap = 512;
    s->graph.owner = s; s->graph.prefill_cap = 32;
    s->logits[0] = 10;
    fake_fail_alloc = fake_fail_save = fake_fail_load = fake_fail_verify = 0;
    fake_fail_eval = fake_verify_calls = fake_serial_calls = fake_drift_row = 0;
    fake_payload_bytes = 0; DS4_MODEL_FAMILY = 0;
}
static void same_state(ds4_session *a, ds4_session *b) {
    CHECK(a->checkpoint.len == b->checkpoint.len);
    CHECK(a->applied == b->applied);
    CHECK(a->compressor == b->compressor);
    CHECK(a->indexer == b->indexer);
    CHECK(memcmp(a->raw, b->raw, sizeof(a->raw)) == 0);
    CHECK(memcmp(a->logits, b->logits, sizeof(a->logits)) == 0);
    CHECK(memcmp(a->storage, b->storage,
                 (size_t)a->checkpoint.len * sizeof(int)) == 0);
    CHECK(a->checkpoint_valid == b->checkpoint_valid);
}

static void lookup_tests(void) {
    ds4ui_pld_index p = {0}; int out[8] = {0};
    int t[] = {1,2,3,4,5,6,7,8,9,1,2};
    CHECK(ds4ui_pld_propose(&p,t,11,3,out,4) == 4);
    CHECK(out[0] == 4 && out[3] == 7);
    CHECK(ds4ui_pld_propose(&p,t,11,3,out,1) == 1);
    CHECK(ds4ui_pld_propose(&p,t,11,3,out,0) == 0);
    CHECK(ds4ui_pld_propose(&p,t,2,3,out,4) == 0); /* rewind */
    CHECK(ds4ui_pld_propose(&p,t,11,99,out,4) == 0);
    ds4ui_pld_note(&p,0); ds4ui_pld_note(&p,0); ds4ui_pld_note(&p,0);
    CHECK(p.cooldown == 16);
    for (int i=0;i<16;i++) CHECK(ds4ui_pld_propose(&p,t,11,3,out,4)==0);
    CHECK(ds4ui_pld_propose(&p,t,11,3,out,4)==4);
    /* Deliberately poison a colliding bucket. Hash equality is not evidence. */
    memset(&p,0,sizeof(p)); p.indexed=11;
    unsigned h=ds4ui_pld_hash(1,2,3); p.sites[h][0]=4;
    CHECK(ds4ui_pld_propose(&p,t,11,3,out,4)==0);
    /* Random incremental histories: every returned draft must be a real,
     * already committed occurrence, including after bounded rewinds. */
    uint32_t seed=7; int v[2000]; memset(&p,0,sizeof(p));
    for(int n=0;n<2000;n++) {
        seed=seed*1664525u+1013904223u; v[n]=(int)(seed>>24)%11;
        int first=(n%9), k=ds4ui_pld_propose(&p,v,n,first,out,4);
        bool found=k==0;
        for(int i=0;!found&&i+3+k<=n;i++)
            found=v[i]==v[n-2]&&v[i+1]==v[n-1]&&v[i+2]==first&&
                memcmp(v+i+3,out,(size_t)k*sizeof(int))==0;
        CHECK(found); CHECK(k>=0&&k<=4);
    }
}

static void transaction_tests(void) {
    ds4_session s, ref; ds4_engine e, er; char err[160];
    {
        reset(&s,&e);
        ds4_session *w=&s;
        ds4ui_pld_transaction tx={0};
        resync_calls=resync_failure=0;
        CHECK(DS4UI_AGENT_PLD_REWIND(w,&tx,0,err,sizeof(err))==0);
        CHECK(resync_calls==1 && resync_position==0);
        resync_failure=-7;
        CHECK(DS4UI_AGENT_PLD_REWIND(w,&tx,0,err,sizeof(err))==-7);
        CHECK(resync_calls==2); /* cannot swallow upstream replay failure */
        resync_failure=0;tx.active=1;tx.start=2;tx.count=1;
        CHECK(DS4UI_AGENT_PLD_REWIND(w,&tx,0,err,sizeof(err))==-1);
        CHECK(resync_calls==2); /* do not resync a failed snapshot transaction */
        reset(&s,&e);memset(&tx,0,sizeof(tx));resync_calls=0;
        int proposal[]={0,1,2};
        CHECK(ds4ui_pld_verify(w,proposal,3,&tx,err,sizeof(err))==3);
        CHECK(DS4UI_AGENT_PLD_REWIND(w,&tx,1,err,sizeof(err))==0);
        CHECK(resync_calls==1 && resync_position==1);
        CHECK(s.checkpoint.len==1 && s.checkpoint_valid);
        ds4ui_pld_release(&tx);free(s.graph.spec_logits);
    }
    /* Every possible rejection position and every parser/interrupt boundary,
     * both before and after a raw-ring wrap. */
    for(int prefix=0;prefix<20;prefix++) for(int bad=1;bad<=5;bad++) {
        reset(&s,&e); reset(&ref,&er);
        for(int i=0;i<prefix;i++) {
            CHECK(ds4_session_eval(&s,i%8,err,sizeof(err))==0);
            CHECK(ds4_session_eval(&ref,i%8,err,sizeof(err))==0);
        }
        int t[5], first=ds4_session_argmax(&s);
        for(int i=0;i<5;i++) t[i]=(first+i)%8;
        if(bad<5) t[bad]=(t[bad]+3)%8;
        ds4ui_pld_transaction tx={0};
        int n=ds4ui_pld_verify(&s,t,5,&tx,err,sizeof(err));
        CHECK(n==bad); CHECK(tx.active); CHECK(fake_verify_calls==1);
        for(int i=0;i<n;i++) CHECK(ds4_session_eval(&ref,t[i],err,sizeof(err))==0);
        same_state(&s,&ref);
        for(int keep=n;keep>=0;keep--) {
            CHECK(ds4ui_pld_rewind(&s,&tx,prefix+keep,err,sizeof(err))==0);
            reset(&ref,&er);
            for(int i=0;i<prefix;i++) ds4_session_eval(&ref,i%8,err,sizeof(err));
            for(int i=0;i<keep;i++) ds4_session_eval(&ref,t[i],err,sizeof(err));
            same_state(&s,&ref);
        }
        ds4ui_pld_release(&tx); ds4ui_pld_release(&tx);
        CHECK(!tx.active&&!tx.before.ptr);
        free(s.graph.spec_logits);
    }
    /* Batched verifier can accept a rounding-divergent prefix; on partial
     * rejection, canonical replay must recheck, not blindly commit it. */
    reset(&s,&e); fake_drift_row=1;
    int drift[]={0,4,7}; ds4ui_pld_transaction tx={0};
    CHECK(ds4ui_pld_verify(&s,drift,3,&tx,err,sizeof(err))==1);
    CHECK(s.checkpoint.len==1&&ds4_session_argmax(&s)==1);
    ds4ui_pld_release(&tx); free(s.graph.spec_logits);

    for(int failure=0;failure<8;failure++) {
        reset(&s,&e); reset(&ref,&er); int t[]={0,1,2};
        if(failure==0) fake_fail_verify=1;
        if(failure==1) {fake_fail_verify=1;fake_fail_load=1;}
        if(failure==2) fake_fail_save=1;
        if(failure==3) fake_fail_alloc=1;
        if(failure==4) e.backend=DS4_BACKEND_CPU;
        if(failure==5) e.support_kind=1;
        if(failure==6) fake_payload_bytes=129ull*1024*1024;
        if(failure==7) s.ctx_size=2;
        memset(&tx,0,sizeof(tx));
        int n=ds4ui_pld_verify(&s,t,3,&tx,err,sizeof(err));
        CHECK(n==(failure<3?-1:0)); CHECK(!tx.active&&!tx.before.ptr);
        if(failure==1) CHECK(!s.checkpoint_valid);
        else same_state(&s,&ref);
        free(s.graph.spec_logits);
    }
    reset(&s,&e); int t[]={0,1,2}; memset(&tx,0,sizeof(tx));
    CHECK(ds4ui_pld_verify(&s,t,3,&tx,err,sizeof(err))==3);
    CHECK(ds4ui_pld_rewind(&s,&tx,4,err,sizeof(err))==-1);
    CHECK(!s.checkpoint_valid);
    ds4ui_pld_release(&tx); free(s.graph.spec_logits);
}
#undef DS4UI_AGENT_PLD_REWIND
#include "../support/pld_agent_harness.h"
#include "../support/pld_server_harness.h"
#include "../../patch/ds4-agent-jsonl/pld_benchmark_clock.h"
static void benchmark_clock_tests(void) {
    setenv("DS4UI_BENCHMARK_EPOCH","1788566400",1);
    unsetenv("RUN_HEAVY");
    CHECK(llabs((long long)ds4ui_benchmark_now()-(long long)time(NULL))<=1);
    setenv("RUN_HEAVY","1",1);CHECK(ds4ui_benchmark_now()==1788566400);
    const char *invalid[]={"bad","-1","0","99999999999999999999","123x","4102444801"};
    for(unsigned i=0;i<sizeof invalid/sizeof invalid[0];i++){
        setenv("DS4UI_BENCHMARK_EPOCH",invalid[i],1);
        CHECK(llabs((long long)ds4ui_benchmark_now()-(long long)time(NULL))<=1);
    }
    unsetenv("DS4UI_BENCHMARK_EPOCH");unsetenv("RUN_HEAVY");
}
int main(void) {
    benchmark_clock_tests();
    mode_tests(); lookup_tests(); transaction_tests(); agent_loop_tests(); server_loop_tests();
    printf("Agent/Cowork/Chat PLD: %u checks passed (stateful test double; no model/Metal run)\n", checks);
    return 0;
}
