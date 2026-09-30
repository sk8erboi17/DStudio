// Laguna-specific CUDA/HIP attention primitives. The model graph and tensor
// scheduling live in ds4.c; this module covers the weighted per-head RoPE and
// gated GQA operations that are not shared with DeepSeek or GLM.

__device__ __forceinline__ static float laguna_softplus(float x) {
    return x > 20.0f ? x : log1pf(expf(x));
}

__device__ __forceinline__ static float laguna_warp_broadcast(float x) {
#if defined(__HIP_PLATFORM_AMD__) || defined(__HIPCC__)
    return __shfl(x, 0, 32);
#else
    return __shfl_sync(0xffffffffu, x, 0, 32);
#endif
}

__device__ static void laguna_head_norm_rope_neox(
        float *row,
        const float *weight,
        uint32_t head_dim,
        uint32_t n_rot,
        uint32_t pos,
        uint32_t n_ctx_orig,
        float freq_base,
        float freq_scale,
        float ext_factor,
        float attn_factor,
        float beta_fast,
        float beta_slow,
        float eps,
        float *scratch) {
    const uint32_t tid = threadIdx.x;
    float ss = 0.0f;
    for (uint32_t i = tid; i < head_dim; i += blockDim.x) {
        const float v = row[i];
        ss += v * v;
    }
    scratch[tid] = ss;
    __syncthreads();
    for (uint32_t step = blockDim.x >> 1u; step != 0u; step >>= 1u) {
        if (tid < step) scratch[tid] += scratch[tid + step];
        __syncthreads();
    }

    const float inv = rsqrtf(scratch[0] / (float)head_dim + eps);
    for (uint32_t i = tid; i < head_dim; i += blockDim.x) {
        row[i] = row[i] * inv * weight[i];
    }
    __syncthreads();

    const uint32_t half_rot = n_rot >> 1u;
    if (tid >= half_rot) return;

    float corr0 = 0.0f;
    float corr1 = 0.0f;
    if (ext_factor != 0.0f) {
        const float denom = 2.0f * logf(freq_base);
        corr0 = floorf((float)n_rot *
                       logf((float)n_ctx_orig /
                            (beta_fast * 2.0f * (float)M_PI)) /
                       denom);
        corr1 = ceilf((float)n_rot *
                      logf((float)n_ctx_orig /
                           (beta_slow * 2.0f * (float)M_PI)) /
                      denom);
        corr0 = fmaxf(0.0f, corr0);
        corr1 = fminf((float)(n_rot - 1u), corr1);
    }

    const uint32_t rel_i0 = tid << 1u;
    const float theta_extrap =
        (float)pos * powf(freq_base,
                          -(float)rel_i0 / (float)n_rot);
    const float theta_interp = freq_scale * theta_extrap;
    float theta = theta_interp;
    float mscale = attn_factor;
    if (ext_factor != 0.0f) {
        const float ramp =
            rope_yarn_ramp_dev(corr0, corr1, (int)rel_i0) * ext_factor;
        theta = theta_interp * (1.0f - ramp) + theta_extrap * ramp;
        mscale *= 1.0f + 0.1f * logf(1.0f / freq_scale);
    }
    const float c = cosf(theta) * mscale;
    const float s = sinf(theta) * mscale;
    const float x0 = row[tid];
    const float x1 = row[tid + half_rot];
    row[tid] = x0 * c - x1 * s;
    row[tid + half_rot] = x0 * s + x1 * c;
}

__global__ static void laguna_head_norm_rope_neox_kernel(
        float *x,
        const float *weight,
        uint32_t n_tokens,
        uint32_t n_head,
        uint32_t head_dim,
        uint32_t n_rot,
        uint32_t pos0,
        uint32_t n_ctx_orig,
        float freq_base,
        float freq_scale,
        float ext_factor,
        float attn_factor,
        float beta_fast,
        float beta_slow,
        float eps) {
    const uint32_t row_index = blockIdx.x;
    if (row_index >= n_tokens * n_head) return;
    const uint32_t token = row_index / n_head;
    float *row = x + (uint64_t)row_index * head_dim;
    __shared__ float scratch[128];
    laguna_head_norm_rope_neox(row, weight, head_dim, n_rot, pos0 + token,
                               n_ctx_orig, freq_base, freq_scale, ext_factor,
                               attn_factor, beta_fast, beta_slow, eps, scratch);
}

__global__ static void laguna_qk_head_norm_rope_neox_kernel(
        float *q,
        float *k,
        const float *q_weight,
        const float *k_weight,
        uint32_t n_tokens,
        uint32_t n_q_head,
        uint32_t n_k_head,
        uint32_t head_dim,
        uint32_t n_rot,
        uint32_t pos0,
        uint32_t n_ctx_orig,
        float freq_base,
        float freq_scale,
        float ext_factor,
        float attn_factor,
        float beta_fast,
        float beta_slow,
        float eps) {
    const uint32_t total_heads = n_q_head + n_k_head;
    const uint32_t row_index = blockIdx.x;
    if (row_index >= n_tokens * total_heads) return;
    const uint32_t token = row_index / total_heads;
    const uint32_t combined_head = row_index - token * total_heads;
    const bool is_q = combined_head < n_q_head;
    const uint32_t head = is_q ? combined_head : combined_head - n_q_head;
    const uint32_t n_head = is_q ? n_q_head : n_k_head;
    float *row = (is_q ? q : k) +
        ((uint64_t)token * n_head + head) * head_dim;
    const float *weight = is_q ? q_weight : k_weight;
    __shared__ float scratch[128];
    laguna_head_norm_rope_neox(row, weight, head_dim, n_rot, pos0 + token,
                               n_ctx_orig, freq_base, freq_scale, ext_factor,
                               attn_factor, beta_fast, beta_slow, eps, scratch);
}

__global__ static void laguna_store_kv_f16_kernel(
        __half *key_cache,
        __half *value_cache,
        const float *k,
        const float *v,
        uint32_t cache_row,
        uint32_t cache_cap,
        uint32_t width) {
    const uint32_t i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= width || cache_row >= cache_cap) return;
    const uint64_t dst = (uint64_t)cache_row * width + i;
    key_cache[dst] = __float2half(k[i]);
    value_cache[dst] = __float2half(v[i]);
}

__global__ static void laguna_stage_kv_f16_kernel(
        __half *staged_key,
        __half *staged_value,
        const float *k,
        const float *v,
        uint64_t values) {
    const uint64_t i = (uint64_t)blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= values) return;
    staged_key[i] = __float2half(k[i]);
    staged_value[i] = __float2half(v[i]);
}

__global__ static void laguna_commit_kv_f16_kernel(
        __half *key_cache,
        __half *value_cache,
        const __half *staged_key,
        const __half *staged_value,
        uint32_t pos0,
        uint32_t n_tokens,
        uint32_t cache_cap,
        uint32_t width,
        uint32_t keep_tokens) {
    const uint64_t values = (uint64_t)keep_tokens * width;
    const uint64_t i = (uint64_t)blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= values) return;
    const uint32_t kept_token = (uint32_t)(i / width);
    const uint32_t col = (uint32_t)(i - (uint64_t)kept_token * width);
    const uint32_t token = n_tokens - keep_tokens + kept_token;
    const uint32_t cache_row = (pos0 + token) % cache_cap;
    const uint64_t src = (uint64_t)token * width + col;
    const uint64_t dst = (uint64_t)cache_row * width + col;
    key_cache[dst] = staged_key[src];
    value_cache[dst] = staged_value[src];
}

template <uint32_t HEAD_GROUP>
__global__ static void laguna_attention_prefill_gqa_kernel(
        float *out,
        const float *q,
        const float *gate,
        const __half *key_cache,
        const __half *value_cache,
        const __half *staged_key,
        const __half *staged_value,
        uint32_t pos0,
        uint32_t n_tokens,
        uint32_t cache_cap,
        uint32_t n_head,
        uint32_t n_head_kv,
        uint32_t head_dim,
        float scale) {
    const uint32_t lane = threadIdx.x;
    const uint32_t head0 = blockIdx.x * HEAD_GROUP;
    const uint32_t token = blockIdx.y;
    if (lane >= 32u || head0 + HEAD_GROUP > n_head ||
        token >= n_tokens || n_head_kv == 0u || head_dim != 128u) {
        return;
    }
    const uint32_t heads_per_kv = n_head / n_head_kv;
    const uint32_t kv_head = head0 / heads_per_kv;
    if ((head0 + HEAD_GROUP - 1u) / heads_per_kv != kv_head) return;

    const uint32_t cache_width = n_head_kv * head_dim;
    const uint32_t query_pos = pos0 + token;
    const uint32_t key_count =
        query_pos + 1u < cache_cap ? query_pos + 1u : cache_cap;
    const uint32_t key_start = query_pos + 1u - key_count;
    float acc[HEAD_GROUP][4] = {};
    float max_score[HEAD_GROUP];
    float score_sum[HEAD_GROUP] = {};
#pragma unroll
    for (uint32_t h = 0; h < HEAD_GROUP; h++) {
        max_score[h] = -INFINITY;
    }

    for (uint32_t key_pos = key_start; key_pos <= query_pos; key_pos++) {
        const bool current = key_pos >= pos0;
        const uint32_t source_row =
            current ? key_pos - pos0 : key_pos % cache_cap;
        const uint64_t kv_base =
            (uint64_t)source_row * cache_width +
            (uint64_t)kv_head * head_dim;
        const __half *key_src = current ? staged_key : key_cache;
        const __half *value_src = current ? staged_value : value_cache;
        const float key0 = __half2float(key_src[kv_base + lane]);
        const float key1 = __half2float(key_src[kv_base + lane + 32u]);
        const float key2 = __half2float(key_src[kv_base + lane + 64u]);
        const float key3 = __half2float(key_src[kv_base + lane + 96u]);
        const float value0 = __half2float(value_src[kv_base + lane]);
        const float value1 = __half2float(value_src[kv_base + lane + 32u]);
        const float value2 = __half2float(value_src[kv_base + lane + 64u]);
        const float value3 = __half2float(value_src[kv_base + lane + 96u]);

#pragma unroll
        for (uint32_t h = 0; h < HEAD_GROUP; h++) {
            const float *qh = q +
                ((uint64_t)token * n_head + head0 + h) * head_dim;
            float partial =
                qh[lane] * key0 +
                qh[lane + 32u] * key1 +
                qh[lane + 64u] * key2 +
                qh[lane + 96u] * key3;
            float score = warp_sum_f32(partial) * scale;
            score = laguna_warp_broadcast(score);
            const float next_max = fmaxf(max_score[h], score);
            const float old_scale = max_score[h] == -INFINITY ?
                0.0f : expf(max_score[h] - next_max);
            const float value_scale = expf(score - next_max);
            score_sum[h] = score_sum[h] * old_scale + value_scale;
            acc[h][0] = acc[h][0] * old_scale + value0 * value_scale;
            acc[h][1] = acc[h][1] * old_scale + value1 * value_scale;
            acc[h][2] = acc[h][2] * old_scale + value2 * value_scale;
            acc[h][3] = acc[h][3] * old_scale + value3 * value_scale;
            max_score[h] = next_max;
        }
    }

#pragma unroll
    for (uint32_t h = 0; h < HEAD_GROUP; h++) {
        const float inv_sum =
            score_sum[h] > 0.0f ? 1.0f / score_sum[h] : 0.0f;
        const float gate_scale =
            laguna_softplus(gate[(uint64_t)token * n_head + head0 + h]);
        float *oh = out +
            ((uint64_t)token * n_head + head0 + h) * head_dim;
        oh[lane] = acc[h][0] * inv_sum * gate_scale;
        oh[lane + 32u] = acc[h][1] * inv_sum * gate_scale;
        oh[lane + 64u] = acc[h][2] * inv_sum * gate_scale;
        oh[lane + 96u] = acc[h][3] * inv_sum * gate_scale;
    }
}

/* Fill the block with independent online-softmax partials. The previous
 * key-count heuristic left most waves idle for short and sliding-window
 * decode, even though merging more partials remains numerically accurate. */
enum { DS4_LAGUNA_ATTN_SPLITS = 16u };

__global__ static void laguna_attention_decode_split_kernel(
        float *out,
        const float *q,
        const float *gate,
        const __half *key_cache,
        const __half *value_cache,
        uint32_t cache_cap,
        uint32_t key_start,
        uint32_t key_count,
        uint32_t n_head,
        uint32_t n_head_kv,
        uint32_t head_dim,
        float scale,
        uint32_t n_splits) {
    const uint32_t lane = threadIdx.x & 31u;
    const uint32_t split = threadIdx.x >> 5u;
    const uint32_t head = blockIdx.x;
    if (head >= n_head || split >= DS4_LAGUNA_ATTN_SPLITS ||
        head_dim != 128u) {
        return;
    }
    const uint32_t heads_per_kv = n_head / n_head_kv;
    const uint32_t kv_head = head / heads_per_kv;
    const uint32_t cache_width = n_head_kv * head_dim;
    const float *qh = q + (uint64_t)head * head_dim;

    float acc[4] = {};
    float max_score = -INFINITY;
    float score_sum = 0.0f;
    if (split < n_splits) {
        for (uint32_t i = split; i < key_count; i += n_splits) {
            const uint32_t cache_row = (key_start + i) % cache_cap;
            const uint64_t kv_base =
                (uint64_t)cache_row * cache_width +
                (uint64_t)kv_head * head_dim;
            const float key0 = __half2float(key_cache[kv_base + lane]);
            const float key1 =
                __half2float(key_cache[kv_base + lane + 32u]);
            const float key2 =
                __half2float(key_cache[kv_base + lane + 64u]);
            const float key3 =
                __half2float(key_cache[kv_base + lane + 96u]);
            float partial =
                qh[lane] * key0 +
                qh[lane + 32u] * key1 +
                qh[lane + 64u] * key2 +
                qh[lane + 96u] * key3;
            float score = warp_sum_f32(partial) * scale;
            score = laguna_warp_broadcast(score);
            const float next_max = fmaxf(max_score, score);
            const float old_scale = max_score == -INFINITY ?
                0.0f : expf(max_score - next_max);
            const float value_scale = expf(score - next_max);
            score_sum = score_sum * old_scale + value_scale;
            acc[0] = acc[0] * old_scale +
                __half2float(value_cache[kv_base + lane]) * value_scale;
            acc[1] = acc[1] * old_scale +
                __half2float(value_cache[kv_base + lane + 32u]) * value_scale;
            acc[2] = acc[2] * old_scale +
                __half2float(value_cache[kv_base + lane + 64u]) * value_scale;
            acc[3] = acc[3] * old_scale +
                __half2float(value_cache[kv_base + lane + 96u]) * value_scale;
            max_score = next_max;
        }
    }

    __shared__ float partial_max[DS4_LAGUNA_ATTN_SPLITS];
    __shared__ float partial_sum[DS4_LAGUNA_ATTN_SPLITS];
    __shared__ float partial_value[DS4_LAGUNA_ATTN_SPLITS][128];
    if (lane == 0u) {
        partial_max[split] = max_score;
        partial_sum[split] = score_sum;
    }
    partial_value[split][lane] = acc[0];
    partial_value[split][lane + 32u] = acc[1];
    partial_value[split][lane + 64u] = acc[2];
    partial_value[split][lane + 96u] = acc[3];
    __syncthreads();
    if (split != 0u) return;

    float global_max = partial_max[0];
    for (uint32_t s = 1u; s < n_splits; s++) {
        global_max = fmaxf(global_max, partial_max[s]);
    }
    float merged[4] = {};
    float merged_sum = 0.0f;
    for (uint32_t s = 0u; s < n_splits; s++) {
        const float merge_scale = partial_sum[s] > 0.0f ?
            expf(partial_max[s] - global_max) : 0.0f;
        merged_sum += partial_sum[s] * merge_scale;
        merged[0] += partial_value[s][lane] * merge_scale;
        merged[1] += partial_value[s][lane + 32u] * merge_scale;
        merged[2] += partial_value[s][lane + 64u] * merge_scale;
        merged[3] += partial_value[s][lane + 96u] * merge_scale;
    }
    const float inv_sum = merged_sum > 0.0f ? 1.0f / merged_sum : 0.0f;
    const float gate_scale = laguna_softplus(gate[head]);
    float *oh = out + (uint64_t)head * head_dim;
    oh[lane] = merged[0] * inv_sum * gate_scale;
    oh[lane + 32u] = merged[1] * inv_sum * gate_scale;
    oh[lane + 64u] = merged[2] * inv_sum * gate_scale;
    oh[lane + 96u] = merged[3] * inv_sum * gate_scale;
}

#if !defined(__HIP_PLATFORM_AMD__) && !defined(__HIPCC__)
/* CUDA decode specialization for Laguna GQA.  Multiple query heads sharing
 * one KV head are evaluated by each split warp, so every key/value cache load
 * is reused.  The per-head key traversal and split merge order are identical
 * to laguna_attention_decode_split_kernel.  The launcher uses groups of two
 * for the 48/8 layout and three for 72/8, retaining enough blocks for GB10. */
template <uint32_t HEAD_GROUP>
__global__ static void laguna_attention_decode_gqa_split_kernel(
        float *out,
        const float *q,
        const float *gate,
        const __half *key_cache,
        const __half *value_cache,
        uint32_t cache_cap,
        uint32_t key_start,
        uint32_t key_count,
        uint32_t n_head,
        uint32_t n_head_kv,
        uint32_t head_dim,
        float scale,
        uint32_t n_splits) {
    const uint32_t lane = threadIdx.x & 31u;
    const uint32_t split = threadIdx.x >> 5u;
    const uint32_t head0 = blockIdx.x * HEAD_GROUP;
    if (head0 + HEAD_GROUP > n_head ||
        split >= DS4_LAGUNA_ATTN_SPLITS || head_dim != 128u) {
        return;
    }
    const uint32_t heads_per_kv = n_head / n_head_kv;
    const uint32_t kv_head = head0 / heads_per_kv;
    if ((head0 + HEAD_GROUP - 1u) / heads_per_kv != kv_head) return;
    const uint32_t cache_width = n_head_kv * head_dim;

    float acc[HEAD_GROUP][4] = {};
    float max_score[HEAD_GROUP];
    float score_sum[HEAD_GROUP] = {};
#pragma unroll
    for (uint32_t h = 0; h < HEAD_GROUP; h++) {
        max_score[h] = -INFINITY;
    }
    if (split < n_splits) {
        for (uint32_t i = split; i < key_count; i += n_splits) {
            const uint32_t cache_row = (key_start + i) % cache_cap;
            const uint64_t kv_base =
                (uint64_t)cache_row * cache_width +
                (uint64_t)kv_head * head_dim;
            const float key0 = __half2float(key_cache[kv_base + lane]);
            const float key1 =
                __half2float(key_cache[kv_base + lane + 32u]);
            const float key2 =
                __half2float(key_cache[kv_base + lane + 64u]);
            const float key3 =
                __half2float(key_cache[kv_base + lane + 96u]);
            const float value0 =
                __half2float(value_cache[kv_base + lane]);
            const float value1 =
                __half2float(value_cache[kv_base + lane + 32u]);
            const float value2 =
                __half2float(value_cache[kv_base + lane + 64u]);
            const float value3 =
                __half2float(value_cache[kv_base + lane + 96u]);
#pragma unroll
            for (uint32_t h = 0; h < HEAD_GROUP; h++) {
                const float *qh =
                    q + (uint64_t)(head0 + h) * head_dim;
                float partial =
                    qh[lane] * key0 +
                    qh[lane + 32u] * key1 +
                    qh[lane + 64u] * key2 +
                    qh[lane + 96u] * key3;
                float score = warp_sum_f32(partial) * scale;
                score = laguna_warp_broadcast(score);
                const float next_max = fmaxf(max_score[h], score);
                const float old_scale = max_score[h] == -INFINITY ?
                    0.0f : expf(max_score[h] - next_max);
                const float value_scale = expf(score - next_max);
                score_sum[h] =
                    score_sum[h] * old_scale + value_scale;
                acc[h][0] =
                    acc[h][0] * old_scale + value0 * value_scale;
                acc[h][1] =
                    acc[h][1] * old_scale + value1 * value_scale;
                acc[h][2] =
                    acc[h][2] * old_scale + value2 * value_scale;
                acc[h][3] =
                    acc[h][3] * old_scale + value3 * value_scale;
                max_score[h] = next_max;
            }
        }
    }

    __shared__ float partial_max[HEAD_GROUP][DS4_LAGUNA_ATTN_SPLITS];
    __shared__ float partial_sum[HEAD_GROUP][DS4_LAGUNA_ATTN_SPLITS];
    __shared__ float
        partial_value[HEAD_GROUP][DS4_LAGUNA_ATTN_SPLITS][128];
#pragma unroll
    for (uint32_t h = 0; h < HEAD_GROUP; h++) {
        if (lane == 0u) {
            partial_max[h][split] = max_score[h];
            partial_sum[h][split] = score_sum[h];
        }
        partial_value[h][split][lane] = acc[h][0];
        partial_value[h][split][lane + 32u] = acc[h][1];
        partial_value[h][split][lane + 64u] = acc[h][2];
        partial_value[h][split][lane + 96u] = acc[h][3];
    }
    __syncthreads();
    if (split != 0u) return;

#pragma unroll
    for (uint32_t h = 0; h < HEAD_GROUP; h++) {
        float global_max = partial_max[h][0];
        for (uint32_t s = 1u; s < n_splits; s++) {
            global_max = fmaxf(global_max, partial_max[h][s]);
        }
        float merged[4] = {};
        float merged_sum = 0.0f;
        for (uint32_t s = 0u; s < n_splits; s++) {
            const float merge_scale = partial_sum[h][s] > 0.0f ?
                expf(partial_max[h][s] - global_max) : 0.0f;
            merged_sum += partial_sum[h][s] * merge_scale;
            merged[0] += partial_value[h][s][lane] * merge_scale;
            merged[1] +=
                partial_value[h][s][lane + 32u] * merge_scale;
            merged[2] +=
                partial_value[h][s][lane + 64u] * merge_scale;
            merged[3] +=
                partial_value[h][s][lane + 96u] * merge_scale;
        }
        const float inv_sum =
            merged_sum > 0.0f ? 1.0f / merged_sum : 0.0f;
        const float gate_scale = laguna_softplus(gate[head0 + h]);
        float *oh = out + (uint64_t)(head0 + h) * head_dim;
        oh[lane] = merged[0] * inv_sum * gate_scale;
        oh[lane + 32u] = merged[1] * inv_sum * gate_scale;
        oh[lane + 64u] = merged[2] * inv_sum * gate_scale;
        oh[lane + 96u] = merged[3] * inv_sum * gate_scale;
    }
}
#endif

static int laguna_rope_args_valid(
        uint32_t n_tokens,
        uint32_t n_head,
        uint32_t head_dim,
        uint32_t n_rot,
        uint32_t pos0,
        float freq_base,
        float freq_scale,
        float eps) {
    return n_tokens != 0u && n_head != 0u && head_dim == 128u &&
           n_rot != 0u && n_rot <= head_dim && (n_rot & 1u) == 0u &&
           pos0 <= UINT32_MAX - n_tokens &&
           isfinite(freq_base) && freq_base > 0.0f &&
           isfinite(freq_scale) && freq_scale > 0.0f &&
           isfinite(eps) && eps > 0.0f;
}

extern "C" int ds4_gpu_laguna_head_rms_norm_rope_tensor(
        ds4_gpu_tensor *x, const void *model_map, uint64_t model_size,
        uint64_t weight_offset, uint32_t n_tokens, uint32_t n_head,
        uint32_t head_dim, uint32_t n_rot, uint32_t pos0,
        uint32_t n_ctx_orig, float freq_base, float freq_scale,
        float ext_factor, float attn_factor, float beta_fast,
        float beta_slow, float eps) {
    if (!x || !model_map ||
        !laguna_rope_args_valid(n_tokens, n_head, head_dim, n_rot, pos0,
                                freq_base, freq_scale, eps) ||
        !isfinite(ext_factor) || !isfinite(attn_factor) ||
        !isfinite(beta_fast) || !isfinite(beta_slow)) {
        return 0;
    }
    const uint64_t values = (uint64_t)n_tokens * n_head * head_dim;
    const uint64_t weight_bytes = (uint64_t)head_dim * sizeof(float);
    if (x->bytes < values * sizeof(float) ||
        weight_offset > model_size ||
        weight_bytes > model_size - weight_offset) {
        return 0;
    }
    const float *weight = (const float *)cuda_model_range_ptr(
        model_map, weight_offset, weight_bytes, "Laguna head norm");
    if (!weight) return 0;
    laguna_head_norm_rope_neox_kernel<<<n_tokens * n_head, 128>>>(
        (float *)x->ptr, weight, n_tokens, n_head, head_dim, n_rot, pos0,
        n_ctx_orig, freq_base, freq_scale, ext_factor, attn_factor,
        beta_fast, beta_slow, eps);
    return cuda_ok(cudaGetLastError(), "Laguna head norm/RoPE launch");
}

extern "C" int ds4_gpu_laguna_qk_head_rms_norm_rope_tensor(
        ds4_gpu_tensor *q, ds4_gpu_tensor *k, const void *model_map,
        uint64_t model_size, uint64_t q_weight_offset,
        uint64_t k_weight_offset, uint32_t n_tokens, uint32_t n_q_head,
        uint32_t n_k_head, uint32_t head_dim, uint32_t n_rot,
        uint32_t pos0, uint32_t n_ctx_orig, float freq_base,
        float freq_scale, float ext_factor, float attn_factor,
        float beta_fast, float beta_slow, float eps) {
    if (!q || !k || !model_map ||
        !laguna_rope_args_valid(n_tokens, n_q_head, head_dim, n_rot, pos0,
                                freq_base, freq_scale, eps) ||
        n_k_head == 0u ||
        !isfinite(ext_factor) || !isfinite(attn_factor) ||
        !isfinite(beta_fast) || !isfinite(beta_slow)) {
        return 0;
    }
    const uint64_t q_values = (uint64_t)n_tokens * n_q_head * head_dim;
    const uint64_t k_values = (uint64_t)n_tokens * n_k_head * head_dim;
    const uint64_t weight_bytes = (uint64_t)head_dim * sizeof(float);
    if (q->bytes < q_values * sizeof(float) ||
        k->bytes < k_values * sizeof(float) ||
        q_weight_offset > model_size ||
        weight_bytes > model_size - q_weight_offset ||
        k_weight_offset > model_size ||
        weight_bytes > model_size - k_weight_offset) {
        return 0;
    }
    const float *q_weight = (const float *)cuda_model_range_ptr(
        model_map, q_weight_offset, weight_bytes, "Laguna Q norm");
    const float *k_weight = (const float *)cuda_model_range_ptr(
        model_map, k_weight_offset, weight_bytes, "Laguna K norm");
    if (!q_weight || !k_weight) return 0;
    const uint64_t rows = (uint64_t)n_tokens * (n_q_head + n_k_head);
    if (rows > UINT32_MAX) return 0;
    laguna_qk_head_norm_rope_neox_kernel<<<(uint32_t)rows, 128>>>(
        (float *)q->ptr, (float *)k->ptr, q_weight, k_weight, n_tokens,
        n_q_head, n_k_head, head_dim, n_rot, pos0, n_ctx_orig, freq_base,
        freq_scale, ext_factor, attn_factor, beta_fast, beta_slow, eps);
    return cuda_ok(cudaGetLastError(), "Laguna Q/K head norm/RoPE launch");
}

extern "C" int ds4_gpu_laguna_store_attention_tensor(
        ds4_gpu_tensor *heads, ds4_gpu_tensor *key_cache,
        ds4_gpu_tensor *value_cache, const ds4_gpu_tensor *q,
        const ds4_gpu_tensor *k, const ds4_gpu_tensor *v,
        const ds4_gpu_tensor *gate, uint32_t pos, uint32_t cache_cap,
        uint32_t key_start, uint32_t key_count, uint32_t n_head,
        uint32_t n_head_kv, uint32_t head_dim, float scale) {
    if (!heads || !key_cache || !value_cache || !q || !k || !v || !gate ||
        cache_cap == 0u || key_count == 0u || key_count > cache_cap ||
        n_head == 0u || n_head_kv == 0u || n_head % n_head_kv != 0u ||
        head_dim != 128u || !isfinite(scale) || scale <= 0.0f) {
        return 0;
    }
    const uint64_t q_values = (uint64_t)n_head * head_dim;
    const uint64_t kv_values = (uint64_t)n_head_kv * head_dim;
    const uint64_t cache_values = (uint64_t)cache_cap * kv_values;
    if (q->bytes < q_values * sizeof(float) ||
        k->bytes < kv_values * sizeof(float) ||
        v->bytes < kv_values * sizeof(float) ||
        gate->bytes < (uint64_t)n_head * sizeof(float) ||
        heads->bytes < q_values * sizeof(float) ||
        key_cache->bytes < cache_values * sizeof(__half) ||
        value_cache->bytes < cache_values * sizeof(__half)) {
        return 0;
    }
    const uint32_t width = n_head_kv * head_dim;
    laguna_store_kv_f16_kernel<<<(width + 255u) / 256u, 256>>>(
        (__half *)key_cache->ptr, (__half *)value_cache->ptr,
        (const float *)k->ptr, (const float *)v->ptr,
        pos % cache_cap, cache_cap, width);
    if (!cuda_ok(cudaGetLastError(), "Laguna KV store launch")) return 0;
    const uint32_t n_splits = key_count < DS4_LAGUNA_ATTN_SPLITS ?
        key_count : DS4_LAGUNA_ATTN_SPLITS;
#if !defined(__HIP_PLATFORM_AMD__) && !defined(__HIPCC__)
    const uint32_t heads_per_kv = n_head / n_head_kv;
    if (n_head == 48u && (heads_per_kv % 2u) == 0u &&
        getenv("DS4_CUDA_LAGUNA_NO_GQA_DECODE") == NULL) {
        laguna_attention_decode_gqa_split_kernel<2u><<<
                n_head / 2u, DS4_LAGUNA_ATTN_SPLITS * 32u>>>(
            (float *)heads->ptr,
            (const float *)q->ptr, (const float *)gate->ptr,
            (const __half *)key_cache->ptr,
            (const __half *)value_cache->ptr,
            cache_cap, key_start, key_count,
            n_head, n_head_kv, head_dim, scale, n_splits);
    } else if ((n_head % 3u) == 0u &&
               (heads_per_kv % 3u) == 0u &&
               getenv("DS4_CUDA_LAGUNA_NO_GQA_DECODE") == NULL) {
        laguna_attention_decode_gqa_split_kernel<3u><<<
                n_head / 3u, DS4_LAGUNA_ATTN_SPLITS * 32u>>>(
            (float *)heads->ptr,
            (const float *)q->ptr, (const float *)gate->ptr,
            (const __half *)key_cache->ptr,
            (const __half *)value_cache->ptr,
            cache_cap, key_start, key_count,
            n_head, n_head_kv, head_dim, scale, n_splits);
    } else
#endif
    {
        laguna_attention_decode_split_kernel<<<
                n_head, DS4_LAGUNA_ATTN_SPLITS * 32u>>>(
            (float *)heads->ptr,
            (const float *)q->ptr, (const float *)gate->ptr,
            (const __half *)key_cache->ptr,
            (const __half *)value_cache->ptr,
            cache_cap, key_start, key_count,
            n_head, n_head_kv, head_dim, scale, n_splits);
    }
    return cuda_ok(cudaGetLastError(), "Laguna decode attention launch");
}

extern "C" int ds4_gpu_laguna_attention_prefill_tensor(
        ds4_gpu_tensor *heads, ds4_gpu_tensor *key_cache,
        ds4_gpu_tensor *value_cache, ds4_gpu_tensor *staged_key,
        ds4_gpu_tensor *staged_value, const ds4_gpu_tensor *q,
        const ds4_gpu_tensor *k, const ds4_gpu_tensor *v,
        const ds4_gpu_tensor *gate, uint32_t pos0, uint32_t n_tokens,
        uint32_t cache_cap, uint32_t n_head, uint32_t n_head_kv,
        uint32_t head_dim, float scale, int split_decode_rows) {
    if (!heads || !key_cache || !value_cache || !staged_key ||
        !staged_value || !q || !k || !v || !gate || n_tokens == 0u ||
        pos0 > UINT32_MAX - n_tokens || cache_cap == 0u || n_head == 0u ||
        n_head_kv == 0u || n_head % n_head_kv != 0u ||
        head_dim != 128u || !isfinite(scale) || scale <= 0.0f) {
        return 0;
    }
    const uint64_t q_values = (uint64_t)n_tokens * n_head * head_dim;
    const uint64_t kv_values =
        (uint64_t)n_tokens * n_head_kv * head_dim;
    const uint64_t cache_values =
        (uint64_t)cache_cap * n_head_kv * head_dim;
    if (q->bytes < q_values * sizeof(float) ||
        k->bytes < kv_values * sizeof(float) ||
        v->bytes < kv_values * sizeof(float) ||
        gate->bytes < (uint64_t)n_tokens * n_head * sizeof(float) ||
        heads->bytes < q_values * sizeof(float) ||
        staged_key->bytes < kv_values * sizeof(__half) ||
        staged_value->bytes < kv_values * sizeof(__half) ||
        key_cache->bytes < cache_values * sizeof(__half) ||
        value_cache->bytes < cache_values * sizeof(__half)) {
        return 0;
    }

    /* A speculative verifier has only a handful of query rows.  Replay the
     * decode store-then-attend sequence once per row instead of running the
     * batched causal kernel: storing rows in order preserves causal and SWA
     * ring semantics, and reusing the decode kernel is what makes each row's
     * result identical to what plain decoding would have produced -- which is
     * the whole contract of speculative decoding. */
    if (split_decode_rows && n_tokens <= 16u) {
        const uint32_t width = n_head_kv * head_dim;
        const uint32_t q_row = n_head * head_dim;
        for (uint32_t row = 0; row < n_tokens; row++) {
            const uint32_t pos = pos0 + row;
            const uint32_t key_count =
                pos + 1u < cache_cap ? pos + 1u : cache_cap;
            const uint32_t key_start = pos + 1u - key_count;
            laguna_store_kv_f16_kernel<<<(width + 255u) / 256u, 256>>>(
                (__half *)key_cache->ptr, (__half *)value_cache->ptr,
                (const float *)k->ptr + (uint64_t)row * width,
                (const float *)v->ptr + (uint64_t)row * width,
                pos % cache_cap, cache_cap, width);
            if (!cuda_ok(cudaGetLastError(),
                         "Laguna verifier KV store launch")) {
                return 0;
            }
            const uint32_t n_splits = key_count < DS4_LAGUNA_ATTN_SPLITS ?
                key_count : DS4_LAGUNA_ATTN_SPLITS;
#if !defined(__HIP_PLATFORM_AMD__) && !defined(__HIPCC__)
            const uint32_t heads_per_kv = n_head / n_head_kv;
            if (n_head == 48u &&
                (heads_per_kv % 2u) == 0u &&
                getenv("DS4_CUDA_LAGUNA_NO_GQA_DECODE") == NULL) {
                laguna_attention_decode_gqa_split_kernel<2u><<<
                        n_head / 2u,
                        DS4_LAGUNA_ATTN_SPLITS * 32u>>>(
                    (float *)heads->ptr + (uint64_t)row * q_row,
                    (const float *)q->ptr + (uint64_t)row * q_row,
                    (const float *)gate->ptr +
                        (uint64_t)row * n_head,
                    (const __half *)key_cache->ptr,
                    (const __half *)value_cache->ptr,
                    cache_cap, key_start, key_count,
                    n_head, n_head_kv, head_dim, scale, n_splits);
            } else if ((n_head % 3u) == 0u &&
                       (heads_per_kv % 3u) == 0u &&
                       getenv("DS4_CUDA_LAGUNA_NO_GQA_DECODE") == NULL) {
                laguna_attention_decode_gqa_split_kernel<3u><<<
                        n_head / 3u,
                        DS4_LAGUNA_ATTN_SPLITS * 32u>>>(
                    (float *)heads->ptr + (uint64_t)row * q_row,
                    (const float *)q->ptr + (uint64_t)row * q_row,
                    (const float *)gate->ptr +
                        (uint64_t)row * n_head,
                    (const __half *)key_cache->ptr,
                    (const __half *)value_cache->ptr,
                    cache_cap, key_start, key_count,
                    n_head, n_head_kv, head_dim, scale, n_splits);
            } else
#endif
            {
                laguna_attention_decode_split_kernel<<<
                        n_head, DS4_LAGUNA_ATTN_SPLITS * 32u>>>(
                    (float *)heads->ptr + (uint64_t)row * q_row,
                    (const float *)q->ptr + (uint64_t)row * q_row,
                    (const float *)gate->ptr +
                        (uint64_t)row * n_head,
                    (const __half *)key_cache->ptr,
                    (const __half *)value_cache->ptr,
                    cache_cap, key_start, key_count,
                    n_head, n_head_kv, head_dim, scale, n_splits);
            }
            if (!cuda_ok(cudaGetLastError(),
                         "Laguna verifier decode attention launch")) {
                return 0;
            }
        }
        return 1;
    }

    laguna_stage_kv_f16_kernel<<<(kv_values + 255u) / 256u, 256>>>(
        (__half *)staged_key->ptr, (__half *)staged_value->ptr,
        (const float *)k->ptr, (const float *)v->ptr, kv_values);
    if (!cuda_ok(cudaGetLastError(), "Laguna prefill KV stage launch")) {
        return 0;
    }

    const uint32_t heads_per_kv = n_head / n_head_kv;
    const dim3 block(32u, 1u, 1u);
    if (n_head % 6u == 0u && heads_per_kv % 6u == 0u) {
        const dim3 grid(n_head / 6u, n_tokens, 1u);
        laguna_attention_prefill_gqa_kernel<6><<<grid, block>>>(
            (float *)heads->ptr, (const float *)q->ptr,
            (const float *)gate->ptr, (const __half *)key_cache->ptr,
            (const __half *)value_cache->ptr,
            (const __half *)staged_key->ptr,
            (const __half *)staged_value->ptr, pos0, n_tokens, cache_cap,
            n_head, n_head_kv, head_dim, scale);
    } else if (n_head % 3u == 0u && heads_per_kv % 3u == 0u) {
        const dim3 grid(n_head / 3u, n_tokens, 1u);
        laguna_attention_prefill_gqa_kernel<3><<<grid, block>>>(
            (float *)heads->ptr, (const float *)q->ptr,
            (const float *)gate->ptr, (const __half *)key_cache->ptr,
            (const __half *)value_cache->ptr,
            (const __half *)staged_key->ptr,
            (const __half *)staged_value->ptr, pos0, n_tokens, cache_cap,
            n_head, n_head_kv, head_dim, scale);
    } else {
        const dim3 grid(n_head, n_tokens, 1u);
        laguna_attention_prefill_gqa_kernel<1><<<grid, block>>>(
            (float *)heads->ptr, (const float *)q->ptr,
            (const float *)gate->ptr, (const __half *)key_cache->ptr,
            (const __half *)value_cache->ptr,
            (const __half *)staged_key->ptr,
            (const __half *)staged_value->ptr, pos0, n_tokens, cache_cap,
            n_head, n_head_kv, head_dim, scale);
    }
    if (!cuda_ok(cudaGetLastError(), "Laguna prefill attention launch")) {
        return 0;
    }

    const uint32_t width = n_head_kv * head_dim;
    const uint32_t keep_tokens =
        n_tokens < cache_cap ? n_tokens : cache_cap;
    const uint64_t keep_values = (uint64_t)keep_tokens * width;
    laguna_commit_kv_f16_kernel<<<(keep_values + 255u) / 256u, 256>>>(
        (__half *)key_cache->ptr, (__half *)value_cache->ptr,
        (const __half *)staged_key->ptr,
        (const __half *)staged_value->ptr, pos0, n_tokens, cache_cap, width,
        keep_tokens);
    return cuda_ok(cudaGetLastError(), "Laguna prefill KV commit launch");
}
