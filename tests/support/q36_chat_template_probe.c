/* Execute the pinned native parser and Qwen renderer, no model/GPU execution. */
#define Q36_SERVER_TEST
#define Q36_SERVER_TEST_NO_MAIN
#include "q36_server.c"

int main(int argc, char **argv) {
    if (argc != 2 || (strcmp(argv[1], "0") && strcmp(argv[1], "1"))) return 2;
    char input[16384];
    size_t n = fread(input, 1, sizeof input - 1, stdin);
    if (ferror(stdin) || !feof(stdin)) return 2;
    input[n] = '\0';
    const char *p = input;
    chat_msgs msgs = {0};
    if (!parse_messages(&p, &msgs)) { chat_msgs_free(&msgs); return 3; }
    while (*p && isspace((unsigned char)*p)) p++;
    if (*p) { chat_msgs_free(&msgs); return 3; }
    char *rendered = render_qwen_chat_prompt_text(&msgs, NULL, NULL,
                                                  Q36_THINK_NONE, argv[1][0] == '1');
    fputs(rendered, stdout);
    free(rendered); chat_msgs_free(&msgs);
    return 0;
}
