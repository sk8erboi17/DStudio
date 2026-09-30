/* LAYER-GATE VARIANT [27-39]: dynamic expert expansion ONLY on MoE layers
 * 27-39 (lay_in_range = layer >= 27). Layers 0-26 take the exact native
 * top-8 path (no threshold cut, no expansion, no decay).
 * In-gate behavior: reference rank = N/2, threshold cut at T*p_ref, up to
 * N experts, linear decay 0.99 -> 0.50 applied to ranks >= 8 before
 * renormalization. This is the round-3 winning gate: canary 11294 solved
 * (J, 5,905 tok) and the 210-question MMLU-Pro run gave paired net +2 vs
 * default8 (evalscope/comparison_gate39.md). Use with
 * --q35-experts 20 --q35-expert-threshold 0.8. */
/* Qwen3.5/3.6 MoE (qwen35moe) kernels: gated delta net layers, GQA decode
 * attention, softmax top-8 routing, and F32/Q6_K mat-vecs reading weights
 * straight from the mapped GGUF.  All quant block helpers (block_q6_K and
 * ds4_glm_q6_K_value) come from moe.metal, which is concatenated before this
 * file but #undefs QK_K at its end. */

#ifndef QK_K
#define QK_K 256
#endif

struct ds4_metal_args_qwen35_matvec_f32 {
    uint32_t in_dim;
    uint32_t out_dim;
};

kernel void kernel_qwen35_matvec_f32(
        constant ds4_metal_args_qwen35_matvec_f32 &args,
        device const float *w,
        device const float *x,
        device float *out,
        uint gid [[thread_position_in_grid]]) {
    if (gid >= args.out_dim) return;
    device const float *row = w + (ulong)gid * args.in_dim;
    float acc = 0.0f;
    for (uint32_t i = 0; i < args.in_dim; i++) {
        acc += row[i] * x[i];
    }
    out[gid] = acc;
}

kernel void kernel_qwen35_matvec_q6_k(
        constant ds4_metal_args_qwen35_matvec_f32 &args,
        device const uchar *w,
        device const float *x,
        device float *out,
        uint3 tgpig [[threadgroup_position_in_grid]],
        ushort tiisg [[thread_index_in_simdgroup]],
        ushort sgitg [[simdgroup_index_in_threadgroup]]) {
    /* Same lane scheme as kernel_qwen35_moe_gate_up: two simdgroups per
     * threadgroup, two output rows per simdgroup, the 32 lanes of a
     * simdgroup covering one 256-wide q6_K block (gh/n128/quarter/l8). */
    const short NSG = 2;
    const short NR0 = 2;
    const int first_row = ((int)tgpig.x * NSG + (int)sgitg) * NR0;
    if (first_row >= (int)args.out_dim) return;
    const short nr = (first_row + NR0 <= (int)args.out_dim) ? NR0 : 1;

    const short gh = tiisg >> 2;
    const short n128 = gh >> 2;
    const short quarter = gh & 3;
    const short l8 = tiisg & 3;
    const int ql_off = n128 * 64 + (quarter & 1) * 32 + l8 * 8;
    const int qh_off = n128 * 32 + l8 * 8;
    /* nibble order per ggml dequantize_row_q6_K: LO,LO,HI,HI across the
     * four quarters — NOT (quarter & 1), which swaps quarters 1 and 2. */
    const int ql_shift = (quarter >> 1) * 4;
    const int qh_shift = quarter * 2;
    const int sc_idx = n128 * 8 + quarter * 2 + (l8 >> 1);
    const int y_off = n128 * 128 + quarter * 32 + l8 * 8;

    const int nb = (int)(args.in_dim / 256u);
    const uint64_t row_bytes = (uint64_t)nb * 210u;
    device const uchar *base = w + (uint64_t)first_row * row_bytes;
    float acc[NR0] = { 0.0f, 0.0f };
    float yl[8];
    for (int ib = 0; ib < nb; ++ib) {
        device const float *yb = x + (uint64_t)ib * 256u + y_off;
        for (short i = 0; i < 8; ++i) yl[i] = yb[i];
        for (short row = 0; row < nr; ++row) {
            device const block_q6_K *bx =
                (device const block_q6_K *)(base + (uint64_t)row * row_bytes) + ib;
            const float ds = (float)bx->d * (float)bx->scales[sc_idx];
            device const uchar *qlp = bx->ql + ql_off;
            device const uchar *qhp = bx->qh + qh_off;
            float s = 0.0f;
            for (short i = 0; i < 8; ++i) {
                const int q = ((qlp[i] >> ql_shift) & 0xF) |
                              (((qhp[i] >> qh_shift) & 3) << 4);
                s += (float)(q - 32) * yl[i];
            }
            acc[row] += ds * s;
        }
    }

    for (short row = 0; row < nr; ++row) {
        const float v = simd_sum(acc[row]);
        if (tiisg == 0) out[first_row + row] = v;
    }
}

struct ds4_metal_args_qwen35_embed_q6 {
    uint32_t in_dim;
    uint32_t n_vocab;
    int32_t token;
    uint32_t _pad;
};

/* Q6_K embedding row lookup: one thread per output element. */
kernel void kernel_qwen35_embed_q6_k(
        constant ds4_metal_args_qwen35_embed_q6 &args,
        device const uchar *w,
        device float *out,
        uint gid [[thread_position_in_grid]]) {
    if (gid >= args.in_dim) return;
    const uint row_bytes = (args.in_dim / QK_K) * (uint32_t)sizeof(block_q6_K);
    device const block_q6_K *row =
        (device const block_q6_K *)(w +
            (ulong)(uint)args.token * (ulong)row_bytes);
    out[gid] = ds4_glm_q6_K_value(row, gid);
}

struct ds4_metal_args_qwen35_conv1d {
    uint32_t channels;
    uint32_t kern;
    uint32_t n_tokens;
    uint32_t write_out;   /* 0: state warm only */
};

/* Causal depthwise conv1d over the pre-conv qkv stream with SiLU and rolling
 * state update.  Weight layout is GGUF [kernel, channels]: element (k,c) at
 * w[c*kernel + k].  Each thread owns one channel and advances the whole
 * token chunk sequentially; the state holds the last kernel-1 raw inputs. */
kernel void kernel_qwen35_conv1d_silu(
        constant ds4_metal_args_qwen35_conv1d &args,
        device const float *w,
        device const float *in,
        device float *state,
        device float *out,
        uint gid [[thread_position_in_grid]]) {
    const uint c = gid;
    if (c >= args.channels) return;
    const uint k = args.kern;
    const uint hist = k - 1u;
    float window[8];
    for (uint i = 0; i < hist; i++) {
        window[i] = state[(ulong)i * args.channels + c];
    }
    for (uint t = 0; t < args.n_tokens; t++) {
        const float cur = in[(ulong)t * args.channels + c];
        float acc = 0.0f;
        for (uint i = 0; i < hist; i++) {
            acc += w[(ulong)c * k + i] * window[i];
        }
        acc += w[(ulong)c * k + hist] * cur;
        for (uint i = 1; i < hist; i++) {
            window[i - 1u] = window[i];
        }
        window[hist - 1u] = cur;
        if (args.write_out != 0u) {
            const float s = acc / (1.0f + exp(-acc));
            out[(ulong)t * args.channels + c] = s;
        }
    }
    for (uint i = 0; i < hist; i++) {
        state[(ulong)i * args.channels + c] = window[i];
    }
}

/* Gated delta rule step.  Per layer, per token chunk:
 *   qkv_silu  [n_tokens][8192]  conv+SiLU output: q[16*128] k[16*128] v[32*128]
 *   z         [n_tokens][4096]  attn_gate projection
 *   alpha_raw [n_tokens][32]    ssm_alpha @ x
 *   beta_raw  [n_tokens][32]    ssm_beta  @ x
 *   a_bias [32] = ssm_a, dt_bias [32] (model F32)
 *   state [n_v_heads][128 j][128 i] f32, element S[i][j] at [h][j][i]
 *   out   [n_tokens][4096]  gated-norm output feeding ssm_out
 * One threadgroup per (v-head, token), 128 threads (thread = column j). */
struct ds4_metal_args_qwen35_gdn {
    uint32_t n_tokens;
    uint32_t head_dim;     /* 128 */
    uint32_t n_v_heads;    /* 32 */
    uint32_t n_k_heads;    /* 16 */
    float eps;
};

kernel void kernel_qwen35_gdn_step(
        constant ds4_metal_args_qwen35_gdn &args,
        device const float *qkv_silu,
        device const float *z,
        device const float *alpha_raw,
        device const float *beta_raw,
        device const float *a_bias,
        device const float *dt_bias,
        device const float *ssm_norm,
        device float *state,
        device float *out,
        uint3 tgpig [[threadgroup_position_in_grid]],
        ushort tiitg [[thread_index_in_threadgroup]],
        ushort tiisg [[thread_index_in_simdgroup]],
        ushort sgitg [[simdgroup_index_in_threadgroup]]) {
    const uint D = args.head_dim;            /* 128 */
    const uint h = tgpig.x;                  /* v head */
    const uint t = tgpig.y;                  /* token */
    const uint j = tiitg;                    /* column */
    /* ggml gated_delta_net maps v head h to k head h % n_k_heads (interleaved,
     * matching ggml_repeat on the non-fused path) */
    const uint kh = h % args.n_k_heads;
    const uint key_dim = args.n_k_heads * D; /* 2048 */
    const uint conv_dim = 2u * key_dim + args.n_v_heads * D;

    threadgroup float sh_q[128];
    threadgroup float sh_k[128];
    threadgroup float sh_red[4];
    threadgroup float sh_scalar[3]; /* g, beta, inv_rms */

    device const float *q_raw = qkv_silu + (ulong)t * conv_dim;
    device const float *k_raw = q_raw + key_dim;
    device const float *v_row = q_raw + 2u * key_dim + (ulong)h * D;

    /* L2-normalize q and k over the shared k head (threadgroup reduction) */
    float qv = q_raw[(ulong)kh * D + j];
    float kv = k_raw[(ulong)kh * D + j];
    float qss = simd_sum(qv * qv);
    if (tiisg == 0) sh_red[sgitg] = qss;
    threadgroup_barrier(mem_flags::mem_threadgroup);
    if (tiitg == 0) {
        sh_red[0] = rsqrt(sh_red[0] + sh_red[1] + sh_red[2] + sh_red[3] + args.eps);
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
    qv *= sh_red[0];
    float kss = simd_sum(kv * kv);
    /* every thread must read the q norm factor before simdgroup 0's lane 0
     * overwrites sh_red[0] with the k partial */
    threadgroup_barrier(mem_flags::mem_threadgroup);
    if (tiisg == 0) sh_red[sgitg] = kss;
    threadgroup_barrier(mem_flags::mem_threadgroup);
    if (tiitg == 0) {
        sh_red[0] = rsqrt(sh_red[0] + sh_red[1] + sh_red[2] + sh_red[3] + args.eps);
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
    kv *= sh_red[0];
    /* q is additionally scaled by 1/sqrt(head_dim) (delta-net-base) */
    qv *= rsqrt((float)D);

    sh_q[j] = qv;
    sh_k[j] = kv;
    threadgroup_barrier(mem_flags::mem_threadgroup);

    /* decay gate: exp(ssm_a * softplus(alpha_raw + dt_bias)); beta: sigmoid */
    if (tiitg == 0) {
        const float ap = alpha_raw[(ulong)t * args.n_v_heads + h] + dt_bias[h];
        const float sp = ap > 20.0f ? ap : log(1.0f + exp(ap));
        sh_scalar[0] = exp(a_bias[h] * sp);
        const float b = beta_raw[(ulong)t * args.n_v_heads + h];
        sh_scalar[1] = 1.0f / (1.0f + exp(-b));
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
    const float g = sh_scalar[0];
    const float beta = sh_scalar[1];

    /* delta-rule state update; S is column-major per head: S[h][j][i].
     * The decay g is applied to the state BEFORE the delta correction
     * (matches ggml gated_delta_net: delta = beta * (v - g * (S . k))). */
    device float *S = state + ((ulong)h * D + j) * D;
    float sk = 0.0f;
    float qS = 0.0f;
    for (uint i = 0; i < D; i++) {
        sk += sh_k[i] * S[i];
        qS += sh_q[i] * S[i];
    }
    const float d = beta * (v_row[j] - g * sk);
    for (uint i = 0; i < D; i++) {
        S[i] = g * S[i] + d * sh_k[i];
    }
    float qk = 0.0f;
    for (uint i = 0; i < D; i++) {
        qk += sh_q[i] * sh_k[i];
    }
    const float o = g * qS + d * qk;

    /* group RMS norm gated by silu(z) */
    float oss = simd_sum(o * o);
    if (tiisg == 0) sh_red[sgitg] = oss;
    threadgroup_barrier(mem_flags::mem_threadgroup);
    if (tiitg == 0) {
        const float total = sh_red[0] + sh_red[1] + sh_red[2] + sh_red[3];
        sh_scalar[2] = rsqrt(total / (float)D + args.eps);
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);

    const float zv = z[(ulong)t * (args.n_v_heads * D) + (ulong)h * D + j];
    const float sz = zv / (1.0f + exp(-zv));
    out[(ulong)t * (args.n_v_heads * D) + (ulong)h * D + j] =
        o * sh_scalar[2] * ssm_norm[j] * sz;
}

struct ds4_metal_args_qwen35_norm_rope {
    uint32_t n_heads;    /* heads in this pass (16 q or 2 k) */
    uint32_t head_dim;   /* 256 */
    uint32_t n_rot;      /* 64 */
    uint32_t in_stride;  /* input stride between heads (512 for q, 256 for k) */
    uint32_t in_offset;  /* value block offset within the stride */
    uint32_t out_f16;    /* 1: write half to kv cache, 0: write f32 */
    uint32_t pos;
    float freq_base;
    float eps;
};

/* Per-head RMS norm (weight from model) followed by paired RoPE over the
 * first n_rot dims.  One threadgroup per head, 128 threads (thread handles
 * dims {j, j+128}).  For the q pass the input rows are the value half of the
 * interleaved q/gate projection; output is contiguous f32.  For the k pass
 * the output goes to the f16 KV cache row `pos`. */
kernel void kernel_qwen35_norm_rope(
        constant ds4_metal_args_qwen35_norm_rope &args,
        device const float *in,
        device const float *norm_w,
        device float *out_f32,
        device half *out_f16,
        uint3 tgpig [[threadgroup_position_in_grid]],
        ushort tiitg [[thread_index_in_threadgroup]],
        ushort tiisg [[thread_index_in_simdgroup]],
        ushort sgitg [[simdgroup_index_in_threadgroup]]) {
    const uint h = tgpig.x;
    const uint hd = args.head_dim;
    device const float *x = in + (ulong)h * args.in_stride + args.in_offset;

    threadgroup float sh_x[256];
    threadgroup float sh_red[4];
    sh_x[tiitg] = x[tiitg];
    sh_x[tiitg + 128u] = x[tiitg + 128u];
    threadgroup_barrier(mem_flags::mem_threadgroup);

    float ss = sh_x[tiitg] * sh_x[tiitg] + sh_x[tiitg + 128u] * sh_x[tiitg + 128u];
    ss = simd_sum(ss);
    if (tiisg == 0) sh_red[sgitg] = ss;
    threadgroup_barrier(mem_flags::mem_threadgroup);
    if (tiitg == 0) {
        const float total = sh_red[0] + sh_red[1] + sh_red[2] + sh_red[3];
        sh_red[0] = rsqrt(total / (float)hd + args.eps);
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
    const float inv = sh_red[0];

    /* NEOX-style pairing (matches ggml rotate_pairs with n_offset = n_rot/2):
     * pair p < n_rot/2 rotates dims (p, p + n_rot/2); angle = pos *
     * base^(-2p/n_rot).  For text tokens IMRoPE sections all share the same
     * position, so the section selection collapses to plain rope. */
    if (tiitg < args.n_rot / 2u) {
        const uint d0 = tiitg;
        const uint d1 = tiitg + args.n_rot / 2u;
        const float v0 = sh_x[d0] * inv * norm_w[d0];
        const float v1 = sh_x[d1] * inv * norm_w[d1];
        const float theta =
            pow(args.freq_base, -2.0f * (float)tiitg / (float)args.n_rot);
        const float ang = (float)args.pos * theta;
        const float cosv = cos(ang);
        const float sinv = sin(ang);
        const float r0 = v0 * cosv - v1 * sinv;
        const float r1 = v1 * cosv + v0 * sinv;
        if (args.out_f16 == 0u) {
            out_f32[(ulong)h * hd + d0] = r0;
            out_f32[(ulong)h * hd + d1] = r1;
        } else {
            out_f16[(ulong)h * hd + d0] = (half)r0;
            out_f16[(ulong)h * hd + d1] = (half)r1;
        }
        return;
    }
    /* dims beyond n_rot are copied unrotated */
    {
        const uint d = 64u + (tiitg - 32u); /* threads 32..127 cover dims 64..159 */
        if (d < hd) {
            const float v = sh_x[d] * inv * norm_w[d];
            if (args.out_f16 == 0u) {
                out_f32[(ulong)h * hd + d] = v;
            } else {
                out_f16[(ulong)h * hd + d] = (half)v;
            }
        }
        const uint d2 = d + 96u; /* and dims 160..255 */
        if (d2 < hd) {
            const float v = sh_x[d2] * inv * norm_w[d2];
            if (args.out_f16 == 0u) {
                out_f32[(ulong)h * hd + d2] = v;
            } else {
                out_f16[(ulong)h * hd + d2] = (half)v;
            }
        }
    }
}

kernel void kernel_qwen35_v_store_f16(
        device const float *in,
        device half *out,
        uint gid [[thread_position_in_grid]]) {
    out[gid] = (half)in[gid];
}

/* GQA decode attention.  One threadgroup per q head (16 groups), 256
 * threads = 8 simdgroups.  Rows advance in strides of 8: each simdgroup owns
 * the rows r = sgitg + 8k.  Within a simdgroup every lane covers the strided
 * dims {lane, lane+32, ..., lane+224} for BOTH the score dot and the value
 * accumulation, so each simdgroup produces a full online-softmax partial over
 * all 256 dims.  Partials are merged through shared memory at the end; every
 * thread finalizes its own 8 dims.  The per-head sigmoid output gate from
 * the q projection is folded into the final output. */
struct ds4_metal_args_qwen35_attn {
    uint32_t n_rows;      /* pos+1 keys */
    uint32_t head_dim;    /* 256 */
    uint32_t n_q_heads;   /* 16 */
    uint32_t n_kv_heads;  /* 2 */
    float scale;
};

kernel void kernel_qwen35_attn(
        constant ds4_metal_args_qwen35_attn &args,
        device const float *q,
        device const float *qg,
        device const half *k_cache,
        device const half *v_cache,
        device float *out,
        uint3 tgpig [[threadgroup_position_in_grid]],
        ushort tiitg [[thread_index_in_threadgroup]],
        ushort tiisg [[thread_index_in_simdgroup]],
        ushort sgitg [[simdgroup_index_in_threadgroup]]) {
    const uint h = tgpig.x;
    const uint kvh = h * args.n_kv_heads / args.n_q_heads;
    const uint hd = args.head_dim;   /* 256 */
    const uint ndps = hd / 32u;      /* dims per simd lane = 8 */
    device const float *qh = q + (ulong)h * hd;
    device const half *K = k_cache + (ulong)kvh * hd;
    device const half *V = v_cache + (ulong)kvh * hd;

    float m = -FLT_MAX/2;
    float l = 0.0f;
    float acc[8];
    for (uint i = 0; i < ndps; i++) acc[i] = 0.0f;

    for (uint r = sgitg; r < args.n_rows; r += 8u) {
        device const half *krow = K + (ulong)r * args.n_kv_heads * hd;
        float dot = 0.0f;
        for (uint i = 0; i < ndps; i++) {
            const uint dim = tiisg + i * 32u;
            dot += qh[dim] * (float)krow[dim];
        }
        dot = simd_sum(dot) * args.scale;
        const float m_new = max(m, dot);
        const float p = exp(dot - m_new);
        const float corr = exp(m - m_new);
        l = l * corr + p;
        device const half *vrow = V + (ulong)r * args.n_kv_heads * hd;
        for (uint i = 0; i < ndps; i++) {
            acc[i] = acc[i] * corr + p * (float)vrow[tiisg + i * 32u];
        }
        m = m_new;
    }

    /* merge the 8 per-simdgroup online-softmax partials */
    threadgroup float sh_m[8];
    threadgroup float sh_l[8];
    threadgroup float sh_acc[8][264];
    if (tiisg == 0) {
        sh_m[sgitg] = m;
        sh_l[sgitg] = l;
    }
    for (uint i = 0; i < ndps; i++) {
        sh_acc[sgitg][tiisg + i * 32u] = acc[i];
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
    float m_all = -FLT_MAX/2;
    for (uint s = 0; s < 8u; s++) m_all = max(m_all, sh_m[s]);
    float l_all = 0.0f;
    for (uint s = 0; s < 8u; s++) {
        if (sh_l[s] > 0.0f) l_all += sh_l[s] * exp(sh_m[s] - m_all);
    }
    for (uint i = 0; i < ndps; i++) {
        const uint dim = tiisg + i * 32u;
        float o = 0.0f;
        for (uint s = 0; s < 8u; s++) {
            if (sh_l[s] > 0.0f) o += sh_acc[s][dim] * exp(sh_m[s] - m_all);
        }
        const float gsig = 1.0f / (1.0f + exp(-qg[(ulong)h * 2u * hd + hd + dim]));
        out[(ulong)h * hd + dim] = l_all > 0.0f ? (o / l_all) * gsig : 0.0f;
    }
}

/* Fused FFN entry: residual add, RMS norm (weight from model), router
 * projection, softmax top-8 selection, and the sigmoid shared-expert gate —
 * all in ONE dispatch.  Single threadgroup with n_expert threads; each thread
 * covers n_embd/n_expert residual elements and one expert row. */
struct ds4_metal_args_qwen35_ffn_enter {
    uint32_t n_embd;      /* 2048 */
    uint32_t n_expert;    /* 256 */
    uint32_t n_used;      /* max routed experts per token */
    uint32_t min_used;    /* floor under the threshold cut */
    uint32_t n_used_native; /* model default; ranks above it get decayed */
    float eps;
    float threshold;      /* fraction of rank-8 probability, 0 = disabled */
    uint32_t layer;       /* stats slot (acc[layer+1]); layer 0 counts tokens */
    uint32_t acc_enable;
};

kernel void kernel_qwen35_ffn_enter(
        constant ds4_metal_args_qwen35_ffn_enter &args,
        device float *x,             /* residual, updated in place */
        device const float *proj_out,
        device const float *norm_w,
        device const float *router_w,
        device const float *shexp_w,
        device float *normed,        /* RMS-normed residual for the experts */
        device int *sel,
        device float *sel_w,
        device float *shexp_gate,
        device uint32_t *n_sel,      /* routed experts actually selected */
        device uint32_t *n_sel_acc,  /* [0]=tokens, [layer+1]=selected sums */
        ushort tiitg [[thread_index_in_threadgroup]],
        ushort tiisg [[thread_index_in_simdgroup]],
        ushort sgitg [[simdgroup_index_in_threadgroup]]) {
    threadgroup float sh_prob[512];
    threadgroup float sh_red[16];
    threadgroup float sh_scalar;
    const uint n_sg = (args.n_expert + 31u) / 32u;
    const uint per_thread = args.n_embd / args.n_expert;

    /* residual add + sum of squares */
    float ss = 0.0f;
    for (uint i = 0; i < per_thread; i++) {
        const uint idx = tiitg + i * args.n_expert;
        const float v = x[idx] + proj_out[idx];
        x[idx] = v;
        ss += v * v;
    }
    ss = simd_sum(ss);
    if (tiisg == 0) sh_red[sgitg] = ss;
    threadgroup_barrier(mem_flags::mem_threadgroup);
    if (tiitg == 0) {
        float total = 0.0f;
        for (uint s = 0; s < n_sg; s++) total += sh_red[s];
        sh_scalar = rsqrt(total / (float)args.n_embd + args.eps);
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
    const float inv = sh_scalar;

    /* weighted RMS norm (re-reads the just-written residual; L2-hot) */
    for (uint i = 0; i < per_thread; i++) {
        const uint idx = tiitg + i * args.n_expert;
        normed[idx] = x[idx] * inv * norm_w[idx];
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);

    /* router projection: one expert row per thread */
    float lv = 0.0f;
    device const float *rw = router_w + (ulong)tiitg * args.n_embd;
    for (uint j = 0; j < args.n_embd; j++) {
        lv += rw[j] * normed[j];
    }

    /* softmax */
    if (tiitg == 0) {
        for (uint s = 0; s < 16u; s++) sh_red[s] = -FLT_MAX/2;
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
    const float mx = simd_max(lv);
    if (tiisg == 0) sh_red[sgitg] = mx;
    threadgroup_barrier(mem_flags::mem_threadgroup);
    float m_all = sh_red[0];
    for (uint s = 1; s < n_sg; s++) m_all = max(m_all, sh_red[s]);
    const float pv = exp(lv - m_all);
    const float ps = simd_sum(pv);
    /* all threads read the max partials before sh_red is reused for the
     * exp-sum partials */
    threadgroup_barrier(mem_flags::mem_threadgroup);
    if (tiisg == 0) sh_red[sgitg] = ps;
    threadgroup_barrier(mem_flags::mem_threadgroup);
    float s_all = sh_red[0];
    for (uint s = 1; s < n_sg; s++) s_all += sh_red[s];
    sh_prob[tiitg] = pv / s_all;
    threadgroup_barrier(mem_flags::mem_threadgroup);

    if (tiitg == 0) {
        /* Rank experts by probability.  Ranks 1..n_used/2 are always ranked
         * so p(rank n_used/2) is known; an expert is then kept only while its
         * probability stays above threshold * p(rank n_used/2), and at least
         * min_used experts are always selected.  threshold <= 0 selects
         * exactly n_used. */
        /* Layer-range gate (experiment): expansion/threshold/decay live
         * only in layers 27-39; every other layer runs exact native top-8. */
        const bool lay_in_range = args.layer >= 27u;
        float p_ref = 0.0f;
        uint count = 0;
        const uint k_ref = lay_in_range ? args.n_used / 2u : 8u;
        uint k = 0;
        for (; k < k_ref; k++) {
            uint best = 0;
            float bv = -1.0f;
            for (uint e = 0; e < args.n_expert; e++) {
                if (sh_prob[e] > bv) {
                    bv = sh_prob[e];
                    best = e;
                }
            }
            if (k + 1u == k_ref) p_ref = bv;
            sel[k] = (int)best;
            sel_w[k] = bv;
            sh_prob[best] = -1.0f;
            count++;
        }
        /* sel_w is non-increasing: extend the cut below rank n_used/2 down to
         * the floor (largest c >= min_used with sel_w[c-1] >= threshold * p_ref) */
        uint keep = count;
        if (lay_in_range && args.threshold > 0.0f && k_ref > 0u) {
            keep = args.min_used < count ? args.min_used : count;
            while (keep < count && sel_w[keep] >= args.threshold * p_ref) keep++;
        }
        if (keep < count) {
            count = keep;
        } else {
            for (; k < args.n_used && lay_in_range; k++) {
                uint best = 0;
                float bv = -1.0f;
                for (uint e = 0; e < args.n_expert; e++) {
                    if (sh_prob[e] > bv) {
                        bv = sh_prob[e];
                        best = e;
                    }
                }
                if (k >= args.min_used && args.threshold > 0.0f &&
                    bv < args.threshold * p_ref) {
                    break;
                }
                sel[k] = (int)best;
                sel_w[k] = bv;
                sh_prob[best] = -1.0f;
                count++;
            }
        }
        /* Expansion decay: when n_used exceeds the model's native top-N,
         * every kept expert ranked above the native count gets a linearly
         * decaying influence factor, 0.99 for the first extra rank down to
         * 0.50 for the last one (midpoint when there is a single extra).
         * Applied to the raw probability BEFORE renormalization, so the
         * native experts keep the output scale and the extras fade out. */
        if (lay_in_range && args.n_used > args.n_used_native &&
            args.n_used_native > 0u) {
            const uint extra = args.n_used - args.n_used_native;
            for (uint j = args.n_used_native; j < count; j++) {
                const float t = extra > 1u
                    ? (float)(j - args.n_used_native) / (float)(extra - 1u)
                    : 0.5f;
                sel_w[j] *= 0.99f + (0.50f - 0.99f) * t;
            }
        }
        float wsum = 0.0f;
        for (uint j = 0; j < count; j++) wsum += sel_w[j];
        const float winv = wsum > 0.0f ? 1.0f / wsum : 0.0f;
        for (uint j = 0; j < count; j++) {
            sel_w[j] *= winv;
        }
        n_sel[0] = count;
        if (args.acc_enable != 0u) {
            atomic_fetch_add_explicit(
                (device atomic_uint *)&n_sel_acc[args.layer + 1u], count,
                memory_order_relaxed);
            if (args.layer == 0u) {
                atomic_fetch_add_explicit(
                    (device atomic_uint *)&n_sel_acc[0], 1u,
                    memory_order_relaxed);
            }
        }
    }

    /* shared expert gate: sigmoid(dot(shexp_w, normed)) */
    if (tiitg == 0) {
        for (uint s = 0; s < 16u; s++) sh_red[s] = 0.0f;
    }
    threadgroup_barrier(mem_flags::mem_threadgroup);
    float part = 0.0f;
    for (uint i = 0; i < per_thread; i++) {
        const uint idx = tiitg + i * args.n_expert;
        part += shexp_w[idx] * normed[idx];
    }
    part = simd_sum(part);
    if (tiisg == 0) sh_red[sgitg] = part;
    threadgroup_barrier(mem_flags::mem_threadgroup);
    if (tiitg == 0) {
        float dot = 0.0f;
        for (uint s = 0; s < n_sg; s++) dot += sh_red[s];
        shexp_gate[0] = 1.0f / (1.0f + exp(-dot));
    }
}

/* MoE stage 1: gate+up dots plus SwiGLU for every slot in ONE dispatch.
 * Grid is (row_groups, 1, n_used+1) with (32, 2) threads: each simdgroup
 * owns NR0 rows of one slot (K-quant row convention).  Slots 0..n_used-1
 * address the routed experts tensor on device via sel[]; slot n_used is the
 * shared expert reading the Q8_0 shexp buffers.  Each stream (gate, up) may
 * independently be Q6_K or Q8_0 (UD mixed quant).  The reduction lane
 * writes mid[slot*n_ff+row] = silu(g)*u, so no separate SwiGLU pass runs.
 *
 * Q6_K lane layout (one 256-element block per simdgroup, 8 consecutive
 * elements per lane): tiisg = gh*4 + l8, gh = 0..7 -> (n128 = gh>>2,
 * quarter = gh&3), l8 = 0..3 -> l = l8*8 .. +7 within the quarter. */
struct ds4_metal_args_qwen35_moe_gate_up {
    uint32_t in_dim;         /* 2048 */
    uint32_t n_ff;           /* 512 */
    uint32_t n_used;         /* 8 */
    uint32_t gate_q6;
    uint32_t up_q6;
    uint32_t shexp_gate_q6;
    uint32_t shexp_up_q6;
    uint64_t gate_exp_bytes;
    uint64_t up_exp_bytes;
};

kernel void kernel_qwen35_moe_gate_up(
        constant ds4_metal_args_qwen35_moe_gate_up &args,
        device const float *x,
        device const uchar *gate_w,
        device const uchar *up_w,
        device const uchar *shexp_gate_w,
        device const uchar *shexp_up_w,
        device const int *sel,
        device float *mid,
        device const uint32_t *n_sel,
        uint3 tgpig [[threadgroup_position_in_grid]],
        ushort tiisg [[thread_index_in_simdgroup]],
        ushort sgitg [[simdgroup_index_in_threadgroup]]) {
    const short NSG = 2;
    const short NR0 = 2;
    const int first_row = ((int)tgpig.x * NSG + (int)sgitg) * NR0;
    const uint slot = tgpig.z;
    if (first_row >= (int)args.n_ff) return;
    if (slot < args.n_used && slot >= n_sel[0]) return;

    device const uchar *gbase;
    device const uchar *ubase;
    uint64_t goff;
    uint64_t uoff;
    bool gate_q6;
    bool up_q6;
    if (slot < args.n_used) {
        const uint e = (uint)sel[slot];
        gbase = gate_w;
        ubase = up_w;
        goff = (uint64_t)e * args.gate_exp_bytes;
        uoff = (uint64_t)e * args.up_exp_bytes;
        gate_q6 = args.gate_q6 != 0u;
        up_q6 = args.up_q6 != 0u;
    } else {
        gbase = shexp_gate_w;
        ubase = shexp_up_w;
        goff = 0;
        uoff = 0;
        gate_q6 = args.shexp_gate_q6 != 0u;
        up_q6 = args.shexp_up_q6 != 0u;
    }
    const uint64_t grow_bytes = gate_q6
        ? (uint64_t)(args.in_dim / 256u) * 210u
        : (uint64_t)(args.in_dim / 32u) * 34u;
    const uint64_t urow_bytes = up_q6
        ? (uint64_t)(args.in_dim / 256u) * 210u
        : (uint64_t)(args.in_dim / 32u) * 34u;

    float sg[NR0] = { 0.0f, 0.0f };
    float su[NR0] = { 0.0f, 0.0f };

    if (gate_q6) {
        const short gh = tiisg >> 2;
        const short n128 = gh >> 2;
        const short quarter = gh & 3;
        const short l8 = tiisg & 3;
        const int ql_off = n128 * 64 + (quarter & 1) * 32 + l8 * 8;
        const int qh_off = n128 * 32 + l8 * 8;
        const int ql_shift = (quarter & 1) * 4;
        const int qh_shift = quarter * 2;
        const int sc_idx = n128 * 8 + quarter * 2 + (l8 >> 1);
        const int y_off = n128 * 128 + quarter * 32 + l8 * 8;
        const int nb = (int)(args.in_dim / 256u);
        float yl[8];
        for (int ib = 0; ib < nb; ++ib) {
            device const float *yb = x + (uint64_t)ib * 256u + y_off;
            for (short i = 0; i < 8; ++i) yl[i] = yb[i];
            for (short row = 0; row < NR0; ++row) {
                device const block_q6_K *bx =
                    (device const block_q6_K *)(gbase + goff +
                        (uint64_t)(first_row + row) * grow_bytes) + ib;
                const float ds = (float)bx->d * (float)bx->scales[sc_idx];
                device const uchar *qlp = bx->ql + ql_off;
                device const uchar *qhp = bx->qh + qh_off;
                float s = 0.0f;
                for (short i = 0; i < 8; ++i) {
                    const int q = ((qlp[i] >> ql_shift) & 0xF) |
                                  (((qhp[i] >> qh_shift) & 3) << 4);
                    s += (float)(q - 32) * yl[i];
                }
                sg[row] += ds * s;
            }
        }
    } else {
        const int nb8 = (int)(args.in_dim / 32u);
        for (int b = 0; b < nb8; ++b) {
            const float yv = x[(uint64_t)b * 32u + tiisg];
            for (short row = 0; row < NR0; ++row) {
                device const block_q8_0 *bx =
                    (device const block_q8_0 *)(gbase + goff +
                        (uint64_t)(first_row + row) * grow_bytes) + b;
                sg[row] += (float)bx->qs[tiisg] * (float)bx->d * yv;
            }
        }
    }

    if (up_q6) {
        const short gh = tiisg >> 2;
        const short n128 = gh >> 2;
        const short quarter = gh & 3;
        const short l8 = tiisg & 3;
        const int ql_off = n128 * 64 + (quarter & 1) * 32 + l8 * 8;
        const int qh_off = n128 * 32 + l8 * 8;
        const int ql_shift = (quarter & 1) * 4;
        const int qh_shift = quarter * 2;
        const int sc_idx = n128 * 8 + quarter * 2 + (l8 >> 1);
        const int y_off = n128 * 128 + quarter * 32 + l8 * 8;
        const int nb = (int)(args.in_dim / 256u);
        float yl[8];
        for (int ib = 0; ib < nb; ++ib) {
            device const float *yb = x + (uint64_t)ib * 256u + y_off;
            for (short i = 0; i < 8; ++i) yl[i] = yb[i];
            for (short row = 0; row < NR0; ++row) {
                device const block_q6_K *bx =
                    (device const block_q6_K *)(ubase + uoff +
                        (uint64_t)(first_row + row) * urow_bytes) + ib;
                const float ds = (float)bx->d * (float)bx->scales[sc_idx];
                device const uchar *qlp = bx->ql + ql_off;
                device const uchar *qhp = bx->qh + qh_off;
                float s = 0.0f;
                for (short i = 0; i < 8; ++i) {
                    const int q = ((qlp[i] >> ql_shift) & 0xF) |
                                  (((qhp[i] >> qh_shift) & 3) << 4);
                    s += (float)(q - 32) * yl[i];
                }
                su[row] += ds * s;
            }
        }
    } else {
        const int nb8 = (int)(args.in_dim / 32u);
        for (int b = 0; b < nb8; ++b) {
            const float yv = x[(uint64_t)b * 32u + tiisg];
            for (short row = 0; row < NR0; ++row) {
                device const block_q8_0 *bx =
                    (device const block_q8_0 *)(ubase + uoff +
                        (uint64_t)(first_row + row) * urow_bytes) + b;
                su[row] += (float)bx->qs[tiisg] * (float)bx->d * yv;
            }
        }
    }

    for (short row = 0; row < NR0 && first_row + row < (int)args.n_ff; ++row) {
        const float g = simd_sum(sg[row]);
        const float u = simd_sum(su[row]);
        if (tiisg == 0) {
            mid[(uint64_t)slot * args.n_ff + first_row + row] =
                g / (1.0f + exp(-g)) * u;
        }
    }
}

/* MoE stage 2: down projection for every slot (routed experts selected
 * on device plus the shared expert) into per-slot plain dots.  Same row
 * convention as stage 1; the Q8_0 lane covers elements L, L+32, ... of mid
 * so the qs byte reads stay coalesced, the Q6_K lane uses the same 256-wide
 * block layout as stage 1.  Selection weights are folded later. */
struct ds4_metal_args_qwen35_moe_down {
    uint32_t n_ff;         /* 512 */
    uint32_t n_embd;       /* 2048 */
    uint32_t n_used;       /* 8 */
    uint32_t down_q6;
    uint32_t shexp_q6;
    uint32_t _pad;
    uint64_t exp_down_bytes;
};

kernel void kernel_qwen35_moe_down(
        constant ds4_metal_args_qwen35_moe_down &args,
        device const float *mid,
        device const uchar *down_w,
        device const uchar *shexp_down_w,
        device const int *sel,
        device float *partial,
        device const uint32_t *n_sel,
        uint3 tgpig [[threadgroup_position_in_grid]],
        ushort tiisg [[thread_index_in_simdgroup]],
        ushort sgitg [[simdgroup_index_in_threadgroup]]) {
    const short NSG = 2;
    const short NR0 = 2;
    const int first_row = ((int)tgpig.x * NSG + (int)sgitg) * NR0;
    const uint slot = tgpig.z;
    if (first_row >= (int)args.n_embd) return;
    if (slot < args.n_used && slot >= n_sel[0]) return;

    device const uchar *base;
    uint64_t off;
    bool down_q6;
    if (slot < args.n_used) {
        base = down_w;
        off = (uint64_t)(uint)sel[slot] * args.exp_down_bytes;
        down_q6 = args.down_q6 != 0u;
    } else {
        base = shexp_down_w;
        off = 0;
        down_q6 = args.shexp_q6 != 0u;
    }
    const uint64_t row_bytes = down_q6
        ? (uint64_t)(args.n_ff / 256u) * 210u
        : (uint64_t)(args.n_ff / 32u) * 34u;
    device const float *m = mid + (uint64_t)slot * args.n_ff;

    float sp[NR0] = { 0.0f, 0.0f };
    if (down_q6) {
        const short gh = tiisg >> 2;
        const short n128 = gh >> 2;
        const short quarter = gh & 3;
        const short l8 = tiisg & 3;
        const int ql_off = n128 * 64 + (quarter & 1) * 32 + l8 * 8;
        const int qh_off = n128 * 32 + l8 * 8;
        const int ql_shift = (quarter & 1) * 4;
        const int qh_shift = quarter * 2;
        const int sc_idx = n128 * 8 + quarter * 2 + (l8 >> 1);
        const int y_off = n128 * 128 + quarter * 32 + l8 * 8;
        const int nb = (int)(args.n_ff / 256u);
        float ml[8];
        for (int ib = 0; ib < nb; ++ib) {
            device const float *mb = m + (uint64_t)ib * 256u + y_off;
            for (short i = 0; i < 8; ++i) ml[i] = mb[i];
            for (short row = 0; row < NR0; ++row) {
                device const block_q6_K *bx =
                    (device const block_q6_K *)(base + off +
                        (uint64_t)(first_row + row) * row_bytes) + ib;
                const float ds = (float)bx->d * (float)bx->scales[sc_idx];
                device const uchar *qlp = bx->ql + ql_off;
                device const uchar *qhp = bx->qh + qh_off;
                float s = 0.0f;
                for (short i = 0; i < 8; ++i) {
                    const int q = ((qlp[i] >> ql_shift) & 0xF) |
                                  (((qhp[i] >> qh_shift) & 3) << 4);
                    s += (float)(q - 32) * ml[i];
                }
                sp[row] += ds * s;
            }
        }
    } else {
        const int nb8 = (int)(args.n_ff / 32u);
        for (int b = 0; b < nb8; ++b) {
            const float yv = m[(uint64_t)b * 32u + tiisg];
            for (short row = 0; row < NR0; ++row) {
                device const block_q8_0 *bx =
                    (device const block_q8_0 *)(base + off +
                        (uint64_t)(first_row + row) * row_bytes) + b;
                sp[row] += (float)bx->qs[tiisg] * (float)bx->d * yv;
            }
        }
    }
    for (short row = 0; row < NR0 && first_row + row < (int)args.n_embd; ++row) {
        const float s = simd_sum(sp[row]);
        if (tiisg == 0) {
            partial[(uint64_t)slot * args.n_embd + first_row + row] = s;
        }
    }
}

/* MoE final stage: fold the per-slot down projections into the residual,
 * applying the routed softmax weights (times DS4_EXPERT_WEIGHT_SCALE) and
 * the sigmoid shared-expert gate.  partial rows hold plain dots; the id
 * matvec kernels do not fold selection weights. */
kernel void kernel_qwen35_moe_combine(
        device const float *partial,   /* [n_used+1][n_embd] */
        device const float *sel_w,     /* [n_used] */
        device const float *shexp_gate, /* [1] */
        device float *x,
        constant uint32_t &n_used,
        constant uint32_t &n_embd,
        constant float &weight_scale,
        device const uint32_t *n_sel,
        uint gid [[thread_position_in_grid]]) {
    if (gid >= n_embd) return;
    const uint active = n_sel[0] <= n_used ? n_sel[0] : n_used;
    float v = shexp_gate[0] * partial[(uint64_t)n_used * n_embd + gid];
    for (uint s = 0; s < active; s++) {
        v += sel_w[s] * weight_scale * partial[(uint64_t)s * n_embd + gid];
    }
    x[gid] += v;
}
