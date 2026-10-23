/* Cowork's tool prompt must not declare the shell tools that Cowork refuses.
 * Runs the production filter (patch/ds4-agent-jsonl/cowork-tools.cfrag) on
 * text in both upstream schema formats; no process, network or model.
 *   cc -std=c11 -Ipatch/ds4-agent-jsonl tests/unit/cowork_tools_unit.c -o /tmp/t && /tmp/t */
#include <assert.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void *xmalloc(size_t n) {
    void *p = malloc(n);
    assert(p);
    return p;
}

#include "cowork-tools.cfrag"

static int checks;

static void expect(const char *name, const char *input, const char *expected) {
    char *out = ds4ui_cowork_without_shell(input);
    if (strcmp(out, expected)) {
        fprintf(stderr, "FAIL %s\n--- got\n%s\n--- expected\n%s\n", name, out, expected);
        exit(1);
    }
    assert(strlen(out) <= strlen(input));
    free(out);
    checks++;
    printf("PASS %s\n", name);
}

#define BLOCK(name, extra) \
    "{\n" \
    "  \"type\": \"function\",\n" \
    "  \"function\": {\n" \
    "    \"name\": \"" name "\",\n" \
    "    \"description\": \"" extra "\",\n" \
    "    \"parameters\": {}\n" \
    "  }\n" \
    "}\n"

int main(void) {
    /* The DSML text (pretty blocks separated by a blank line), including the
     * upstream paragraph on bash jobs. */
    expect("pretty schema blocks: shell tools and their paragraph removed, others byte-identical",
        "Use exact old text.\n\n"
        "For long-running bash commands, pass refresh_sec. If a bash job is still running, use "
        "bash_status to check it early or bash_stop to terminate it.\n\n"
        "Use google_search to find web pages.\n\n"
        "### Available Tool Schemas\n\n"
        BLOCK("google_search", "Search.") "\n"
        BLOCK("bash", "Run a shell command.") "\n"
        BLOCK("bash_status", "Report a bash job.") "\n"
        BLOCK("bash_stop", "Terminate a bash job.") "\n"
        BLOCK("read", "Read a file; not a bash replacement.") "\n"
        BLOCK("list", "List a directory.") "\n",
        "Use exact old text.\n\n"
        "Use google_search to find web pages.\n\n"
        "### Available Tool Schemas\n\n"
        BLOCK("google_search", "Search.") "\n"
        BLOCK("read", "Read a file; not a bash replacement.") "\n"
        BLOCK("list", "List a directory.") "\n");

    /* GLM/Laguna text: one schema per line, wrapped or not. */
    expect("one-line schemas, wrapped and unwrapped",
        "{\"name\":\"bash\",\"description\":\"Run a shell command.\",\"parameters\":{}}\n"
        "{\"name\":\"read\",\"description\":\"Read.\",\"parameters\":{}}\n"
        "{\"type\":\"function\",\"function\":{\"name\":\"bash_status\",\"parameters\":{}}}\n"
        "{\"type\":\"function\",\"function\":{\"name\":\"bash_stop\",\"parameters\":{}}}\n"
        "{\"type\":\"function\",\"function\":{\"name\":\"write\",\"description\":\"Create a file, never with bash.\",\"parameters\":{}}}\n",
        "{\"name\":\"read\",\"description\":\"Read.\",\"parameters\":{}}\n"
        "{\"type\":\"function\",\"function\":{\"name\":\"write\",\"description\":\"Create a file, never with bash.\",\"parameters\":{}}}\n");

    /* Only exact tool names: a longer name or a mention in text stays. */
    expect("similar names and mentions are kept",
        "{\"name\":\"bash_history\",\"parameters\":{}}\n"
        "{\"name\":\"read\",\"description\":\"\\\"name\\\": bash\",\"parameters\":{}}\n"
        "bash is unavailable in Cowork.\n",
        "{\"name\":\"bash_history\",\"parameters\":{}}\n"
        "{\"name\":\"read\",\"description\":\"\\\"name\\\": bash\",\"parameters\":{}}\n"
        "bash is unavailable in Cowork.\n");

    /* An unclosed block is not a schema unit: copied unchanged. */
    expect("an unclosed block is copied unchanged",
        "{\n  \"name\": \"bash\",\n  \"parameters\": {}\n",
        "{\n  \"name\": \"bash\",\n  \"parameters\": {}\n");

    expect("text without a final newline and empty text",
        "{\"name\":\"read\",\"parameters\":{}}\n{\"name\":\"bash\",\"parameters\":{}}",
        "{\"name\":\"read\",\"parameters\":{}}\n");
    expect("empty text", "", "");

    printf("cowork_tools_unit: %d/%d passed (production filter; no process or model)\n", checks, checks);
    return 0;
}
