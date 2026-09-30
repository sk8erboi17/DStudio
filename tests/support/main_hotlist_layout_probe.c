/* Execute the patched native hotlist builder against a separate int32 oracle.
 * Cold startup scratch only: no weights, model-quality or speed claim. */
#include "ds4.c"
#include <assert.h>

typedef struct {
    int32_t experts[DS4_MAX_LAYER][DS4_MAX_EXPERT];
    uint32_t priorities[DS4_MAX_LAYER][DS4_MAX_EXPERT];
    uint32_t counts[DS4_MAX_LAYER];
    uint64_t seen[DS4_MAX_LAYER][DS4_EXPERT_BIT_WORDS];
} previous_layout;

int main(void) {
    metal_graph_streaming_expert_hotlist_workspace *w = calloc(1, sizeof(*w));
    previous_layout *ref = calloc(1, sizeof(*ref));
    assert(w && ref);
    g_ds4_shape.n_layer = DS4_MAX_LAYER;
    g_ds4_shape.n_expert = DS4_MAX_EXPERT;
    assert(DS4_MAX_EXPERT == 512);
    uint32_t loaded = 0;
    for (uint32_t layer = 0; layer < DS4_MAX_LAYER; layer++) {
        for (uint32_t i = 0; i < DS4_MAX_EXPERT; i++) {
            uint32_t expert = (i * 137u) % DS4_MAX_EXPERT;
            uint32_t priority = i % 3 == 0 ? 0 : i % 3 == 1 ? UINT32_MAX : i;
            assert(metal_graph_streaming_expert_hotlist_add(layer, expert, priority,
                w->experts, w->priorities, w->counts, w->seen, &loaded));
            /* Independent ordered list oracle; no production bitset helper. */
            uint32_t count = ref->counts[layer];
            for (uint32_t j = 0; j < count; j++) assert(ref->experts[layer][j] != (int32_t)expert);
            ref->experts[layer][count] = (int32_t)expert;
            ref->priorities[layer][count] = priority ? priority : 1;
            ref->counts[layer]++;
            ref->seen[layer][expert / 64] |= UINT64_C(1) << (expert % 64);
            /* Duplicate with a different priority must not change order/count. */
            const uint32_t before = loaded;
            assert(metal_graph_streaming_expert_hotlist_add(layer, expert, 17,
                w->experts, w->priorities, w->counts, w->seen, &loaded));
            assert(loaded == before);
        }
    }
    assert(loaded == DS4_MAX_LAYER * DS4_MAX_EXPERT);
    for (uint32_t layer = 0; layer < DS4_MAX_LAYER; layer++) {
        assert(w->counts[layer] == ref->counts[layer]);
        assert(!memcmp(w->seen[layer], ref->seen[layer], sizeof(w->seen[layer])));
        for (uint32_t i = 0; i < w->counts[layer]; i++) {
            /* The GPU API still receives lossless int32 IDs. */
            int32_t gpu_id = w->experts[layer][i];
            assert(gpu_id == ref->experts[layer][i]);
            assert(w->priorities[layer][i] == ref->priorities[layer][i]);
        }
    }
    const uint32_t before = loaded;
    assert(metal_graph_streaming_expert_hotlist_add(DS4_MAX_LAYER, 0, 1,
        w->experts, w->priorities, w->counts, w->seen, &loaded));
    assert(metal_graph_streaming_expert_hotlist_add(0, DS4_MAX_EXPERT, 1,
        w->experts, w->priorities, w->counts, w->seen, &loaded));
    assert(loaded == before);
    assert(sizeof(*w) <= 256u * 1024u && sizeof(*ref) > 256u * 1024u);
    printf("hotlist: %u ordered IDs + duplicate/invalid input parity PASS; workspace %zu -> %zu bytes, budget 262144 bytes\n",
        loaded, sizeof(*ref), sizeof(*w));
    free(ref); free(w);
    return 0;
}
