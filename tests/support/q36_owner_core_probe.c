/* Fixture engine/session only; production introspection reads real open files.
 * No weights, inference or quality claim. Separate TU preserves native names. */
#define Q36_NO_GPU
#include "q36.c"

q36_engine *dstudio_owner_fixture(const char *model, const char *vision, const char *mtp) {
    static q36_engine engine;
    memset(&engine, 0, sizeof engine);
    engine.model.fd = open(model, O_RDONLY);
    engine.vision_model.fd = vision ? open(vision, O_RDONLY) : -1;
    engine.mtp_model.fd = mtp ? open(mtp, O_RDONLY) : -1;
    engine.vision_ready = vision != NULL;
    engine.mtp_ready = mtp != NULL;
    engine.backend = Q36_BACKEND_CPU;
    engine.variant = Q36_VARIANT_27B;
    engine.cache_type_k = Q36_KV_CACHE_F16;
    engine.cache_type_v = Q36_KV_CACHE_Q8_0;
    return &engine;
}

q36_session *dstudio_owner_fixture_session(void) {
    static q36_session session;
    session.ctx_size = 8192;
    return &session;
}

int dstudio_owner_identity_failure_preserves(q36_engine *engine) {
    q36_engine_launch_info before, after;
    memset(&before, 0xa5, sizeof before);
    after = before;
    return !q36_engine_get_launch_info(engine, &after) &&
           !memcmp(&before, &after, sizeof before);
}
