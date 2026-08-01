#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../extension/remote/dstudio_remote_llm.h"

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
