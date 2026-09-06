/* Exercise the native patcher/output adapter, not assertions about source text.
 * The integration runner compiles and executes the resulting web implementation. */
#define _GNU_SOURCE
#include <assert.h>
#define main dstudio_embedded_main_for_tests
#include "../../src/dstudio.c"
#undef main

int main(int argc, char **argv) {
    if (argc == 3) return web_cdp_write_temp(argv[1], argv[2]) ? 0 : 1;
    json_dyn_buf output = {0};
    assert(web_append_visual_result(&output, NULL, 0, 0, "https://example.test"));
    assert(!output.len);
    const char *helper = "{\"imageDataUrl\":\"data:image/jpeg;base64,/9j/AAAA\",\"imageUrl\":\"https://example.test\"}";
    assert(web_append_visual_result(&output, helper, 1, 0, "https://example.test"));
    char status[64];
    assert(json_get_string(output.ptr, "status", status, sizeof status) && !strcmp(status, "captured"));
    free(output.ptr); output = (json_dyn_buf){0};
    assert(web_append_visual_result(&output, helper, 1, 0, "https://other.test"));
    assert(json_get_string(output.ptr, "status", status, sizeof status) && !strcmp(status, "unavailable"));
    assert(!json_get_string_alloc(output.ptr, "dataUrl"));
    free(output.ptr); output = (json_dyn_buf){0};
    assert(web_append_visual_result(&output, helper, 1, 1, "https://example.test"));
    assert(json_get_string(output.ptr, "status", status, sizeof status) && !strcmp(status, "unavailable"));
    free(output.ptr);
    puts("web_visual_patch_unit: same-page pixels, text fallback, no-request path passed (no model)");
    return 0;
}
