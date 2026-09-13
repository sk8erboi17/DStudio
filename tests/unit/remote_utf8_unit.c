#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../../extension/remote/dstudio_remote_llm.h"
#include "../../extension/remote/dstudio_wire_string.h"

static void expect_json_string(const char *input, const char *expected) {
    dstudio_remote_buf out = {0};
    dstudio_remote_json_string(&out, input);
    assert(out.ptr != NULL);
    if (strcmp(out.ptr, expected) != 0) {
        fprintf(stderr, "expected: %s\nactual:   %s\n", expected, out.ptr);
        abort();
    }
    dstudio_remote_buf_free(&out);
}

int main(void) {
    /* Caller-owned bounded output uses the same Unicode decoder as allocating
     * readers. Check exact capacity and guards, including a 4-byte scalar. */
    const char *bounded[] = {"\"x\"", "\"\"", "\"\\ud83e\\udd8a\""};
    const size_t lengths[] = {1, 0, 4};
    for (size_t i = 0; i < sizeof lengths / sizeof *lengths; i++) {
        unsigned char buffer[10]; memset(buffer, 0xa5, sizeof buffer); size_t decoded = 99;
        assert(dstudio_wire_string_decode(bounded[i], bounded[i] + strlen(bounded[i]),
                                          (char *)buffer + 1, lengths[i] + 1, &decoded));
        assert(decoded == lengths[i] && buffer[0] == 0xa5 && buffer[1 + lengths[i]] == 0 &&
               buffer[2 + lengths[i]] == 0xa5);
        memset(buffer, 0xa5, sizeof buffer);
        assert(!dstudio_wire_string_decode(bounded[i], bounded[i] + strlen(bounded[i]),
                                           (char *)buffer + 1, lengths[i], NULL));
        assert(buffer[0] == 0xa5 && buffer[1 + lengths[i]] == 0xa5);
    }
    const char *wire[] = {"\"世界 🦊\"", "\"\\u4e16\\u754c \\ud83e\\udd8a\""};
    for (unsigned i = 0; i < sizeof wire / sizeof *wire; i++) {
        char *decoded = dstudio_wire_string(wire[i], wire[i] + strlen(wire[i]));
        assert(decoded && !strcmp(decoded, "世界 🦊")); free(decoded);
    }
    const char *invalid[] = {"\"\\u0000\"", "\"\\ud800\"", "\"\\udc00\"", "\"\\ud800\\u1234\"",
        "\"\\u12xz\"", "\"\\u\"", "\"\\z\"", "\"\xed\xa0\x80\"", "\"\xf4\x90\x80\x80\"",
        "\"\xc0\xaf\"", "\"\xf0\x9f\"", "\"a\nb\"", "\"trailing\" data\""};
    for (unsigned i = 0; i < sizeof invalid / sizeof *invalid; i++)
        assert(!dstudio_wire_string(invalid[i], invalid[i] + strlen(invalid[i])));
    expect_json_string("plain \"text\"\n", "\"plain \\\"text\\\"\\n\"");
    expect_json_string("valid \xf0\x9f\x90\xb6", "\"valid \xf0\x9f\x90\xb6\"");

    /* UTF-8 encoding of a lone UTF-16 high surrogate: never a Unicode scalar. */
    expect_json_string("bad \xed\xa0\x80 end", "\"bad \xef\xbf\xbd\xef\xbf\xbd\xef\xbf\xbd end\"");
    /* Truncated, overlong, stray continuation and > U+10FFFF sequences. */
    expect_json_string("x\xf0\x9f", "\"x\xef\xbf\xbd\xef\xbf\xbd\"");
    expect_json_string("x\xc0\xaf", "\"x\xef\xbf\xbd\xef\xbf\xbd\"");
    expect_json_string("x\x80", "\"x\xef\xbf\xbd\"");
    expect_json_string("x\xf4\x90\x80\x80", "\"x\xef\xbf\xbd\xef\xbf\xbd\xef\xbf\xbd\xef\xbf\xbd\"");

    dstudio_remote_buf messages = {0};
    int count = 0;
    dstudio_remote_messages_append(&messages, &count, "user", "tool:\xffresult");
    char *snapshot = dstudio_remote_messages_snapshot(&messages);
    assert(strcmp(snapshot,
                  "[{\"role\":\"user\",\"content\":\"tool:\xef\xbf\xbdresult\"}]") == 0);
    free(snapshot);
    dstudio_remote_buf_free(&messages);

    puts("remote_utf8_unit: ok");
    return 0;
}
