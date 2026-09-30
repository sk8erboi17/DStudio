// DFlash-specific CUDA/HIP data movement. The draft and target
// graphs otherwise reuse Laguna's dense, normalization, RoPE, attention, and
// FFN kernels; only these three shapes are unique to speculative decoding.

__global__ static void dflash_capture_rows_kernel(
        float *features,
        const float *src,
        uint32_t n_rows,
        uint32_t n_embd,
        uint32_t n_aux,
        uint32_t aux_index,
        uint32_t src_row0,
        uint32_t dst_row0) {
    const uint64_t count = (uint64_t)n_rows * n_embd;
    const uint64_t gid = (uint64_t)blockIdx.x * blockDim.x + threadIdx.x;
    if (gid >= count) return;
    const uint32_t row = (uint32_t)(gid / n_embd);
    const uint32_t col = (uint32_t)(gid - (uint64_t)row * n_embd);
    float value = src[(uint64_t)(src_row0 + row) * n_embd + col];
    /* The target graph can hand back inf/NaN features when a layer saturates.
     * Clamp them to the f16 range the draft encoder expects instead of letting
     * a non-finite value poison every draft position. */
    const uint32_t value_bits = __float_as_uint(value);
    if ((value_bits & 0x7f800000u) == 0x7f800000u) {
        value = (value_bits & 0x007fffffu) != 0u ? 0.0f :
            ((value_bits & 0x80000000u) != 0u ? -65504.0f : 65504.0f);
    }
    const uint64_t dst =
        (uint64_t)(dst_row0 + row) * n_aux * n_embd +
        (uint64_t)aux_index * n_embd + col;
    features[dst] = value;
}

__global__ static void dflash_aux_rms_norm_kernel(
        float *features,
        const float *weights,
        uint32_t n_rows,
        uint32_t n_embd,
        uint32_t n_aux,
        float eps) {
    const uint32_t row = blockIdx.x;
    const uint32_t aux = blockIdx.y;
    if (row >= n_rows || aux >= n_aux || n_embd == 0u) return;
    float *x = features + ((uint64_t)row * n_aux + aux) * n_embd;
    const uint32_t tid = threadIdx.x;
    float sum = 0.0f;
    for (uint32_t col = tid; col < n_embd; col += blockDim.x) {
        const float value = x[col];
        sum += value * value;
    }
    __shared__ float scratch[256];
    scratch[tid] = sum;
    __syncthreads();
    for (uint32_t step = blockDim.x >> 1u; step != 0u; step >>= 1u) {
        if (tid < step) scratch[tid] += scratch[tid + step];
        __syncthreads();
    }
    const float scale = rsqrtf(scratch[0] / (float)n_embd + eps);
    const float *weight = weights + (uint64_t)aux * n_embd;
    for (uint32_t col = tid; col < n_embd; col += blockDim.x) {
        x[col] = x[col] * scale * weight[col];
    }
}

__global__ static void dflash_commit_kv_f16_kernel(
        __half *key_cache,
        __half *value_cache,
        const float *k,
        const float *v,
        uint32_t n_rows,
        uint32_t pos0,
        uint32_t cache_cap,
        uint32_t width) {
    const uint64_t count = (uint64_t)n_rows * width;
    const uint64_t gid = (uint64_t)blockIdx.x * blockDim.x + threadIdx.x;
    if (gid >= count || cache_cap == 0u) return;
    const uint32_t row = (uint32_t)(gid / width);
    const uint32_t col = (uint32_t)(gid - (uint64_t)row * width);
    const uint32_t cache_row = (pos0 + row) % cache_cap;
    const uint64_t src = (uint64_t)row * width + col;
    const uint64_t dst = (uint64_t)cache_row * width + col;
    key_cache[dst] = __float2half(k[src]);
    value_cache[dst] = __float2half(v[src]);
}

__global__ static void dflash_probabilities_kernel(
        float *probabilities,
        const float *logits,
        const int32_t *argmax,
        uint32_t n_rows,
        uint32_t n_vocab) {
    const uint32_t row = blockIdx.x;
    const uint32_t tid = threadIdx.x;
    if (row >= n_rows || n_vocab == 0u) return;
    const int32_t top = argmax[row];
    if (top < 0 || (uint32_t)top >= n_vocab) {
        if (tid == 0u) probabilities[row] = 0.0f;
        return;
    }
    const float *row_logits = logits + (uint64_t)row * n_vocab;
    const float top_logit = row_logits[top];
    float sum = 0.0f;
    if (isfinite(top_logit)) {
        for (uint32_t col = tid; col < n_vocab; col += blockDim.x) {
            const float term = expf(row_logits[col] - top_logit);
            if (isfinite(term)) sum += term;
        }
    }
    __shared__ float scratch[256];
    scratch[tid] = sum;
    __syncthreads();
    for (uint32_t step = blockDim.x >> 1u; step != 0u; step >>= 1u) {
        if (tid < step) scratch[tid] += scratch[tid + step];
        __syncthreads();
    }
    if (tid == 0u) {
        probabilities[row] =
            scratch[0] > 0.0f ? 1.0f / scratch[0] : 0.0f;
    }
}

extern "C" int ds4_gpu_dflash_capture_rows_tensor(
        ds4_gpu_tensor       *features,
        const ds4_gpu_tensor *src,
        uint32_t              src_row0,
        uint32_t              dst_row0,
        uint32_t              n_rows,
        uint32_t              n_embd,
        uint32_t              n_aux,
        uint32_t              aux_index) {
    if (!features || !src || n_rows == 0u || n_embd == 0u ||
        n_aux == 0u || aux_index >= n_aux) {
        return 0;
    }
    const uint64_t src_values = ((uint64_t)src_row0 + n_rows) * n_embd;
    const uint64_t dst_values =
        ((uint64_t)dst_row0 + n_rows) * n_aux * n_embd;
    if (src_values > UINT64_MAX / sizeof(float) ||
        dst_values > UINT64_MAX / sizeof(float) ||
        src->bytes < src_values * sizeof(float) ||
        features->bytes < dst_values * sizeof(float)) {
        fprintf(stderr,
                "ds4: GPU DFlash capture received undersized buffers\n");
        return 0;
    }
    const uint64_t count = (uint64_t)n_rows * n_embd;
    dflash_capture_rows_kernel<<<(unsigned)((count + 255u) / 256u), 256>>>(
            (float *)features->ptr, (const float *)src->ptr, n_rows, n_embd,
            n_aux, aux_index, src_row0, dst_row0);
    return cuda_ok(cudaGetLastError(), "DFlash feature capture launch");
}

extern "C" int ds4_gpu_dflash_aux_norm_tensor(
        ds4_gpu_tensor *features,
        const void     *model_map,
        uint64_t        model_size,
        uint64_t        weight_offset,
        uint32_t        n_rows,
        uint32_t        n_embd,
        uint32_t        n_aux,
        float           eps) {
    if (!features || !model_map || n_rows == 0u || n_embd == 0u ||
        n_aux == 0u || !isfinite(eps) || eps < 0.0f) {
        return 0;
    }
    const uint64_t feature_values = (uint64_t)n_rows * n_aux * n_embd;
    const uint64_t weight_values = (uint64_t)n_aux * n_embd;
    const uint64_t weight_bytes = weight_values * sizeof(float);
    if (feature_values > UINT64_MAX / sizeof(float) ||
        weight_values > UINT64_MAX / sizeof(float) ||
        features->bytes < feature_values * sizeof(float) ||
        weight_offset > model_size ||
        weight_bytes > model_size - weight_offset) {
        fprintf(stderr,
                "ds4: GPU DFlash auxiliary norm received invalid ranges\n");
        return 0;
    }
    const float *weights = (const float *)cuda_model_range_ptr(
        model_map, weight_offset, weight_bytes, "dflash aux norm");
    if (!weights) return 0;
    const dim3 grid(n_rows, n_aux, 1);
    dflash_aux_rms_norm_kernel<<<grid, 256>>>(
            (float *)features->ptr, weights, n_rows, n_embd, n_aux, eps);
    return cuda_ok(cudaGetLastError(), "DFlash auxiliary norm launch");
}

extern "C" int ds4_gpu_dflash_commit_kv_tensor(
        ds4_gpu_tensor       *key_cache,
        ds4_gpu_tensor       *value_cache,
        const ds4_gpu_tensor *k,
        const ds4_gpu_tensor *v,
        uint32_t              pos0,
        uint32_t              n_rows,
        uint32_t              cache_cap,
        uint32_t              n_head_kv,
        uint32_t              head_dim) {
    if (!key_cache || !value_cache || !k || !v || n_rows == 0u ||
        cache_cap == 0u || n_head_kv == 0u || head_dim == 0u) {
        return 0;
    }
    const uint64_t width = (uint64_t)n_head_kv * head_dim;
    const uint64_t src_values = (uint64_t)n_rows * width;
    const uint64_t cache_values = (uint64_t)cache_cap * width;
    if (width > UINT32_MAX ||
        src_values > UINT64_MAX / sizeof(float) ||
        cache_values > UINT64_MAX / sizeof(uint16_t) ||
        k->bytes < src_values * sizeof(float) ||
        v->bytes < src_values * sizeof(float) ||
        key_cache->bytes < cache_values * sizeof(__half) ||
        value_cache->bytes < cache_values * sizeof(__half)) {
        fprintf(stderr,
                "ds4: GPU DFlash KV commit received undersized buffers\n");
        return 0;
    }
    dflash_commit_kv_f16_kernel<<<
            (unsigned)((src_values + 255u) / 256u), 256>>>(
            (__half *)key_cache->ptr, (__half *)value_cache->ptr,
            (const float *)k->ptr, (const float *)v->ptr, n_rows, pos0,
            cache_cap, (uint32_t)width);
    return cuda_ok(cudaGetLastError(), "DFlash KV commit launch");
}

extern "C" int ds4_gpu_dflash_probabilities_tensor(
        ds4_gpu_tensor       *probabilities,
        const ds4_gpu_tensor *logits,
        const ds4_gpu_tensor *argmax,
        uint32_t              n_rows,
        uint32_t              n_vocab) {
    if (!probabilities || !logits || !argmax ||
        n_rows == 0u || n_vocab == 0u ||
        probabilities->bytes < (uint64_t)n_rows * sizeof(float) ||
        logits->bytes < (uint64_t)n_rows * n_vocab * sizeof(float) ||
        argmax->bytes < (uint64_t)n_rows * sizeof(int32_t)) {
        return 0;
    }
    dflash_probabilities_kernel<<<n_rows, 256>>>(
            (float *)probabilities->ptr,
            (const float *)logits->ptr,
            (const int32_t *)argmax->ptr,
            n_rows,
            n_vocab);
    return cuda_ok(cudaGetLastError(),
                   "DFlash draft probabilities launch");
}
