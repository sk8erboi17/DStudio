/* Executed native hybrid model with synthetic weights. The unmodified
 * single-token path is the reference; this is not model quality evaluation. */
#define ds4_gpu_tensor_alloc probe_tensor_alloc
#define ds4_gpu_tensor_free probe_tensor_free
#define ds4_gpu_tensor_bytes probe_tensor_bytes
#define ds4_gpu_begin_commands probe_begin_commands
#include DSTUDIO_QWEN35_SOURCE
#undef ds4_gpu_tensor_alloc
#undef ds4_gpu_tensor_free
#undef ds4_gpu_tensor_bytes
#undef ds4_gpu_begin_commands
#include <assert.h>

extern ds4_gpu_tensor *ds4_gpu_tensor_alloc(uint64_t);
extern void ds4_gpu_tensor_free(ds4_gpu_tensor *);
extern uint64_t ds4_gpu_tensor_bytes(const ds4_gpu_tensor *);
extern int ds4_gpu_begin_commands(void);
static int command_begins;
int probe_begin_commands(void) {command_begins++;return ds4_gpu_begin_commands();}
static const ds4_gpu_tensor *oversized_tensor;
static uint64_t oversized_bytes;
uint64_t probe_tensor_bytes(const ds4_gpu_tensor *p) {
    return p && p==oversized_tensor ? oversized_bytes : ds4_gpu_tensor_bytes(p);
}
static int alloc_calls,alloc_fail_at,owned_count;
static ds4_gpu_tensor *owned[256];
ds4_gpu_tensor *probe_tensor_alloc(uint64_t bytes) {
    if (++alloc_calls==alloc_fail_at) return NULL;
    ds4_gpu_tensor *p=ds4_gpu_tensor_alloc(bytes);
    if (p) {assert(owned_count<256);owned[owned_count++]=p;}
    return p;
}
void probe_tensor_free(ds4_gpu_tensor *p) {
    for (int i=0;i<owned_count;i++) if (owned[i]==p) {owned[i]=owned[--owned_count];break;}
    ds4_gpu_tensor_free(p);
}

static uint32_t random_state=1729;
static uint32_t random_u32(void) {random_state^=random_state<<13;random_state^=random_state>>17;random_state^=random_state<<5;return random_state;}
static ds4_tensor tensors[200]; static size_t tensor_count; static uint64_t used;
static uint8_t *mapping;
typedef struct {uint16_t d; int8_t qs[32];} fixture_q8_0;
_Static_assert(sizeof(fixture_q8_0)==34,"Q8_0 fixture layout");
static ds4_tensor *weight(uint32_t type,uint32_t in,uint32_t rows,int control) {
    ds4_tensor *t=&tensors[tensor_count++]; assert(tensor_count<200);
    used=(used+255u)&~255ull; t->type=type;t->abs_offset=used;
    t->bytes=(uint64_t)rows*(type==DS4_TENSOR_F32 ? in*4u : type==DS4_TENSOR_Q8_0 ? in/32u*34u : in/256u*210u);
    assert(used+t->bytes<128u*1024u*1024u);
    if (type==DS4_TENSOR_F32) {
        float *w=(float *)(mapping+used);
        for(uint64_t i=0;i<t->bytes/4u;i++) w[i]=control ? (control==1 ? 1.0f : control==-1 ? -0.8f : 0.0f) : ((int)(random_u32()%101)-50)*0.0005f;
    } else if(type==DS4_TENSOR_Q8_0) {
        for(uint64_t i=0;i<t->bytes/34u;i++) {
            fixture_q8_0 *b=(fixture_q8_0 *)(mapping+used+i*34u); b->d=f32_to_f16(0.002f);
            for(int j=0;j<32;j++) b->qs[j]=(int8_t)((int)(random_u32()%101)-50);
        }
    } else {
        for(uint64_t i=0;i<t->bytes/210u;i++) {
            block_q6_K *b=(block_q6_K *)(mapping+used+i*210u); b->d=f32_to_f16(0.0005f);
            for(size_t j=0;j<sizeof b->ql;j++) b->ql[j]=(uint8_t)random_u32();
            for(size_t j=0;j<sizeof b->qh;j++) b->qh[j]=(uint8_t)random_u32();
            for(size_t j=0;j<sizeof b->scales;j++) b->scales[j]=(int8_t)(1+random_u32()%4);
        }
    }
    used+=t->bytes;return t;
}
static void model(ds4_engine *e,int all_q6) {
    g_ds4_shape=DS4_SHAPE_QWEN35_35B;
    g_ds4_shape.n_layer=4;g_ds4_shape.n_embd=256;g_ds4_shape.n_vocab=32;
    g_ds4_shape.n_head=2;g_ds4_shape.n_head_kv=1;g_ds4_shape.n_expert=16;
    g_ds4_shape.n_expert_used=2;g_ds4_shape.n_ff_exp=256;
    g_ds4_shape.n_ssm_dt_rank=6;g_ds4_shape.n_ssm_group=1;
    uint32_t qt=all_q6 ? DS4_TENSOR_Q6_K : DS4_TENSOR_Q8_0;
    e->backend=DS4_BACKEND_METAL;e->metal_ready=true;e->power_percent=100;
    mapping=mmap(NULL,128u*1024u*1024u,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANON,-1,0); assert(mapping!=MAP_FAILED);
    e->model.map=mapping;e->model.size=128u*1024u*1024u;
    e->weights.token_embd=weight(qt,256,32,0);e->weights.output=weight(qt,256,32,0);
    e->weights.output_norm=weight(DS4_TENSOR_F32,256,1,1);
    for(uint32_t i=0;i<4;i++) {
        ds4_layer_weights *l=&e->weights.layer[i];
        l->attn_norm=weight(DS4_TENSOR_F32,256,1,1); l->ffn_norm=weight(DS4_TENSOR_F32,256,1,1);
        if(qwen35_layer_is_attn(i)) {
            l->attn_q=weight(qt,256,1024,0);l->attn_k=weight(qt,256,256,0);l->attn_v=weight(qt,256,256,0);
            l->attn_output=weight(qt,512,256,0);l->attn_q_norm=weight(DS4_TENSOR_F32,256,1,1);l->attn_k_norm=weight(DS4_TENSOR_F32,256,1,1);
        } else {
            l->attn_qkv=weight(qt,256,1024,0);l->attn_gate=weight(qt,256,768,0);
            l->ssm_alpha=weight(all_q6 ? qt : DS4_TENSOR_F32,256,6,0);l->ssm_beta=weight(all_q6 ? qt : DS4_TENSOR_F32,256,6,0);
            l->ssm_conv1d=weight(DS4_TENSOR_F32,4,1024,0);l->ssm_a=weight(DS4_TENSOR_F32,6,1,-1);
            l->ssm_dt_bias=weight(DS4_TENSOR_F32,6,1,2);l->ssm_norm=weight(DS4_TENSOR_F32,128,1,1);
            l->ssm_out=weight(qt,768,256,0);
        }
        l->ffn_gate_inp=weight(DS4_TENSOR_F32,256,16,0);l->ffn_gate_inp_shexp=weight(DS4_TENSOR_F32,256,1,0);
        l->ffn_gate_exps=weight(i%2 || all_q6 ? DS4_TENSOR_Q6_K : qt,256,16*256,0);
        l->ffn_up_exps=weight(i%2 || all_q6 ? DS4_TENSOR_Q6_K : qt,256,16*256,0);
        l->ffn_down_exps=weight(qt,256,16*256,0);
        l->ffn_gate_shexp=weight(qt,256,256,0);l->ffn_up_shexp=weight(qt,256,256,0);l->ffn_down_shexp=weight(qt,256,256,0);
    }
    assert(ds4_gpu_set_model_map(mapping,e->model.size));
}
static int progress_calls,last_progress,cancel_at,cancel_calls;
static bool cancel_probe(void *unused) {(void)unused;return cancel_at && ++cancel_calls>=cancel_at;}
static bool cancel_after_chunk(void *unused) {(void)unused;return last_progress>=64;}
static void progress(void *unused,const char *event,int current,int total) {
    (void)unused; assert(!strcmp(event,"prefill_chunk") && current>last_progress && current<=total);
    last_progress=current;progress_calls++;
}
static void save_tensor(FILE *f,ds4_gpu_tensor *t,uint64_t n) {
    void *data=malloc((size_t)n);assert(data && ds4_gpu_tensor_read(t,0,data,n));assert(fwrite(data,1,(size_t)n,f)==n);free(data);
}
static void save_session(const char *file,ds4_session *s) {
    FILE *f=fopen(file,"wb");assert(f);
    assert(fwrite(&s->checkpoint.len,sizeof(int),1,f)==1);
    assert(fwrite(s->logits,sizeof(float),DS4_N_VOCAB,f)==DS4_N_VOCAB);
    save_tensor(f,s->q35_gdn_state,ds4_gpu_tensor_bytes(s->q35_gdn_state));
    save_tensor(f,s->q35_conv_state,ds4_gpu_tensor_bytes(s->q35_conv_state));
    uint64_t row=(uint64_t)DS4_N_HEAD_KV*DS4_N_HEAD_DIM*sizeof(uint16_t);
    for(uint32_t i=0;i<DS4_N_LAYER/DS4_N_FULL_ATTN_INTERVAL;i++) {
        uint64_t offset=(uint64_t)i*s->ctx_size*row;
        ds4_gpu_tensor *k=ds4_gpu_tensor_view(s->q35_k_cache,offset,(uint64_t)s->checkpoint.len*row);
        ds4_gpu_tensor *v=ds4_gpu_tensor_view(s->q35_v_cache,offset,(uint64_t)s->checkpoint.len*row);
        save_tensor(f,k,(uint64_t)s->checkpoint.len*row);save_tensor(f,v,(uint64_t)s->checkpoint.len*row);
        ds4_gpu_tensor_free(k);ds4_gpu_tensor_free(v);
    }
    assert(!fclose(f));
}
static void same_session(const char *file,ds4_session *s) {
    char temp[4096];snprintf(temp,sizeof temp,"%s.check",file);save_session(temp,s);
    FILE *a=fopen(file,"rb"),*b=fopen(temp,"rb");assert(a&&b);
    int x,y;do {x=fgetc(a);y=fgetc(b);assert(x==y);} while(x!=EOF);
    fclose(a);fclose(b);assert(!unlink(temp));
}
static void long_attention(ds4_session *s,const char *file) {
    const uint32_t rows=64,pos=65535,dim=DS4_N_HEAD_DIM;
    const uint64_t row=(uint64_t)DS4_N_HEAD*dim*sizeof(float);
    const uint64_t kv=(uint64_t)(pos+rows)*DS4_N_HEAD_KV*dim*sizeof(uint16_t);
    ds4_gpu_tensor *q=probe_tensor_alloc(row*rows),*gate=probe_tensor_alloc(row*rows*2u);
    ds4_gpu_tensor *out=probe_tensor_alloc(row*rows),*k=probe_tensor_alloc(kv),*v=probe_tensor_alloc(kv);
    assert(q && gate && out && k && v);
    uint16_t *half=malloc(kv);float *host=malloc(row*rows*2u);assert(half && host);
    for(uint64_t i=0;i<kv/2u;i++)half[i]=f32_to_f16(((int)(i%19)-9)*0.03125f);
    assert(ds4_gpu_tensor_write(k,0,half,kv));
    for(uint64_t i=0;i<kv/2u;i++)half[i]=f32_to_f16(((int)(i%23)-11)*0.0625f);
    assert(ds4_gpu_tensor_write(v,0,half,kv));free(half);
    for(uint64_t i=0;i<row*rows/sizeof(float);i++)host[i]=((int)(i%17)-8)*0.015625f;
    assert(ds4_gpu_tensor_write(q,0,host,row*rows));
    for(uint64_t i=0;i<row*rows*2u/sizeof(float);i++)host[i]=((int)(i%7)-3)*0.125f;
    assert(ds4_gpu_tensor_write(gate,0,host,row*rows*2u));
    command_begins=0;
#ifdef DSTUDIO_Q35_BATCH_PROBE
    qwen35_prefill candidate={.q=q,.qkv=gate,.attn_out=out};
    assert(probe_begin_commands());
    assert(qwen35_prefill_attention(s,&candidate,k,v,pos,rows));
    assert(ds4_gpu_end_commands());
    // This input crosses the production 8M work limit: two attention tiles,
    // rather than one command containing all 64 long-context queries.
    assert(command_begins==4);
#else
    for(uint32_t t=0;t<rows;t++) {
        ds4_gpu_tensor *qr=ds4_gpu_tensor_view(q,t*row,row);
        ds4_gpu_tensor *gr=ds4_gpu_tensor_view(gate,t*row*2u,row*2u);
        ds4_gpu_tensor *o=ds4_gpu_tensor_view(out,t*row,row);assert(qr && gr && o);
        assert(probe_begin_commands());
        assert(ds4_gpu_qwen35_attn_tensor(qr,gr,k,v,o,pos+t+1u,dim,
            DS4_N_HEAD,DS4_N_HEAD_KV,1.0f/sqrtf((float)dim)));
        assert(ds4_gpu_end_commands());
        probe_tensor_free(qr);probe_tensor_free(gr);probe_tensor_free(o);
    }
#endif
    assert(ds4_gpu_tensor_read(out,0,host,row*rows));
    FILE *saved=fopen(file,"wb");assert(saved);
    assert(fwrite(host,1,row*rows,saved)==row*rows && !fclose(saved));free(host);
    probe_tensor_free(q);probe_tensor_free(gate);probe_tensor_free(out);probe_tensor_free(k);probe_tensor_free(v);
}
int main(int argc,char **argv) {
    assert(argc==6);bool scalar=!strcmp(argv[1],"scalar");int length=atoi(argv[2]);assert(length>0&&length<256);
    int q6=atoi(argv[3]);ds4_engine *e=calloc(1,sizeof(*e));assert(e && ds4_gpu_init());model(e,q6);
    ds4_session *s=NULL;assert(!ds4_session_create(&s,e,256));
    ds4_session_set_progress(s,progress,NULL);
    ds4_tokens prompt={0};for(int i=0;i<length;i++) token_vec_push(&prompt,(i*7+3)%32);
    char err[512]="";int result=0;
    if(scalar) {
        for(int i=0;i<length;i++) {assert(qwen35_eval_token(s,prompt.v[i],(uint32_t)i));token_vec_push(&s->checkpoint,prompt.v[i]);}
        s->checkpoint_valid=true;
    } else {
        if(length>64) {
            ds4_session_set_cancel(s,cancel_after_chunk,NULL);
            result=ds4_session_sync(s,&prompt,err,sizeof err);
            assert(result==DS4_SESSION_SYNC_INTERRUPTED && s->checkpoint.len==64 && progress_calls==1);
            char prefix[4096];snprintf(prefix,sizeof prefix,"%s.prefix64",argv[4]);save_session(prefix,s);
            ds4_session_set_cancel(s,NULL,NULL);
        }
        result=ds4_session_sync(s,&prompt,err,sizeof err);
    }
    assert(!result);save_session(argv[4],s);
    if(!scalar) {
        assert(s->prefill_cap==64);assert(progress_calls==(length+63)/64);
        // A cancellation at a deterministic layer boundary preserves the
        // completed prefix, including recurrent state, KV and logits.
        token_vec_push(&prompt,13);token_vec_push(&prompt,17);
        cancel_at=4;cancel_calls=0;ds4_session_set_cancel(s,cancel_probe,NULL);
        result=ds4_session_sync(s,&prompt,err,sizeof err);
        if(result!=DS4_SESSION_SYNC_INTERRUPTED) fprintf(stderr,"cancel rc=%d calls=%d error=%s\n",result,cancel_calls,err);
        assert(result==DS4_SESSION_SYNC_INTERRUPTED);
        assert(s->checkpoint.len==length && s->checkpoint_valid);save_session(argv[5],s);
        same_session(argv[4],s);
        // Replacing the history must also retain the old KV on cancellation.
        prompt.v[0]=(prompt.v[0]+1)%32;cancel_calls=0;
        assert(ds4_session_sync(s,&prompt,err,sizeof err)==DS4_SESSION_SYNC_INTERRUPTED);
        same_session(argv[4],s);prompt.v[0]=(prompt.v[0]+31)%32;
        ds4_session_set_cancel(s,NULL,NULL);cancel_at=0;
        int baseline_owned=owned_count;
        // Capacity fault injection uses a real session and the production
        // allocator. Oversized advertised KV/scratch must fail before any GPU
        // allocation, including values that would underflow quota subtraction.
        alloc_calls=0;
        g_ds4_shape.n_vocab=128u*1024u*1024u/sizeof(float)+1u;
        assert(ds4_session_sync(s,&prompt,err,sizeof err)==1 && alloc_calls==0);
        g_ds4_shape.n_vocab=32;assert(owned_count==baseline_owned);same_session(argv[4],s);
        oversized_tensor=s->q35_v_cache;oversized_bytes=4ull*1024u*1024u*1024u+1u;
        alloc_calls=0;
        assert(ds4_session_sync(s,&prompt,err,sizeof err)==1 && alloc_calls==0);
        oversized_tensor=s->q35_k_cache;oversized_bytes=4ull*1024u*1024u*1024u;
        alloc_calls=0;
        assert(ds4_session_sync(s,&prompt,err,sizeof err)==1 && alloc_calls==0);
        oversized_tensor=NULL;assert(owned_count==baseline_owned);same_session(argv[4],s);
        // Every candidate allocation fails deterministically before submission;
        // partial allocations retire and the old authoritative prefix remains.
        for (int failure=1;failure<=23;failure++) {
            alloc_calls=0;alloc_fail_at=failure;
            assert(ds4_session_sync(s,&prompt,err,sizeof err)==1);
            assert(owned_count==baseline_owned);same_session(argv[4],s);
        }
        prompt.v[0]=(prompt.v[0]+1)%32;
        for(int failure=24;failure<=25;failure++) {
            alloc_calls=0;alloc_fail_at=failure;
            assert(ds4_session_sync(s,&prompt,err,sizeof err)==1);
            assert(owned_count==baseline_owned);same_session(argv[4],s);
        }
        prompt.v[0]=(prompt.v[0]+31)%32;
        alloc_fail_at=0;
        assert(!ds4_session_sync(s,&prompt,err,sizeof err));assert(s->checkpoint.len==length+2);
    }
    if(length==130 && !q6) {
        char file[4096];snprintf(file,sizeof file,"%s.long-attention",argv[4]);
        long_attention(s,file);
    }
    printf("{\"scalar\":%s,\"tokens\":%d,\"allQ6\":%s,\"progressCalls\":%d,\"prefillCap\":%d,\"passed\":true}\n",
        scalar?"true":"false",length,q6?"true":"false",progress_calls,s->prefill_cap);
    ds4_session_free(s);assert(!owned_count);ds4_tokens_free(&prompt);ds4_gpu_cleanup();munmap(mapping,e->model.size);free(e);return 0;
}
