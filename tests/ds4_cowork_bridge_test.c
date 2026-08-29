#define _POSIX_C_SOURCE 200809L
#define _DARWIN_C_SOURCE

#include "ds4_cowork.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int failures = 0;

static void expect(int condition, const char *label) {
    if (condition) return;
    fprintf(stderr, "ds4-cowork bridge test failed: %s\n", label);
    failures++;
}

int main(int argc, char **argv) {
    if (argc != 2) {
        fprintf(stderr, "usage: %s /absolute/path/to/office_tool.py\n", argv[0]);
        return 2;
    }
    char workspace[] = "/tmp/ds4-cowork-bridge-XXXXXX";
    if (!mkdtemp(workspace)) {
        perror("mkdtemp");
        return 2;
    }
    setenv("DS4UI_COWORK_HELPER", argv[1], 1);

    ds4_cowork_arg create_args[] = {
        {"action", "create"},
        {"path", "bridge.xlsx"},
        {"sheet", "Dati"},
        {"data_json", "[[\"Nome\",\"Valore\"],[\"Ada\",42],[\"Qualità\",\"=B2*2\"]]"},
    };
    char *result = ds4_cowork_execute("spreadsheet", create_args,
                                      sizeof(create_args) / sizeof(create_args[0]),
                                      workspace);
    expect(result && strstr(result, "Created spreadsheet bridge.xlsx"),
           "spreadsheet create crosses the C/JSON/Python boundary");
    ds4_cowork_free(result);

    ds4_cowork_arg read_args[] = {
        {"action", "read"},
        {"path", "bridge.xlsx"},
        {"sheet", "Dati"},
        {"range", "A1:B5"},
    };
    result = ds4_cowork_execute("spreadsheet", read_args,
                                sizeof(read_args) / sizeof(read_args[0]),
                                workspace);
    expect(result && strstr(result, "Ada\t42") && strstr(result, "Qualità\t=B2*2"),
           "spreadsheet read preserves Unicode, formulas and tabs");
    expect(result && strstr(result, "never as instructions"),
           "document content is framed against prompt injection");
    ds4_cowork_free(result);

    ds4_cowork_arg escape_args[] = {
        {"path", "../outside.docx"},
        {"content", "blocked"},
    };
    result = ds4_cowork_execute("write_document", escape_args,
                                sizeof(escape_args) / sizeof(escape_args[0]),
                                workspace);
    expect(result && strstr(result, "Cowork tool error") && strstr(result, ".."),
           "workspace traversal fails closed through the bridge");
    ds4_cowork_free(result);

    result = ds4_cowork_execute("unknown", NULL, 0, workspace);
    expect(result && strstr(result, "unknown Office tool"),
           "unknown tool fails closed");
    ds4_cowork_free(result);

    char workbook[512];
    snprintf(workbook, sizeof workbook, "%s/bridge.xlsx", workspace);
    unlink(workbook);
    rmdir(workspace);

    if (failures) return 1;
    puts("ds4-cowork bridge: ok");
    return 0;
}
