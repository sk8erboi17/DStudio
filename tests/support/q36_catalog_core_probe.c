/* Fixture initialization only: identity and context are read by real core APIs. */
#define Q36_NO_GPU
#include "q36.c"

q36_engine *dstudio_catalog_engine(unsigned family) {
    static q36_engine engine;
    memset(&engine, 0, sizeof engine);
    engine.variant = family == 1 ? Q36_VARIANT_27B : Q36_VARIANT_35B_A3B;
    engine.kat_coder = family == 2;
    return &engine;
}

q36_session *dstudio_catalog_session(void) {
    static q36_session session;
    session.ctx_size = 8192;
    return &session;
}
