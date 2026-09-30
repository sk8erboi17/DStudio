#ifndef Q36_HELP_H
#define Q36_HELP_H

#include <stdio.h>

typedef enum {
    Q36_HELP_Q36,
    Q36_HELP_SERVER,
    Q36_HELP_AGENT,
    Q36_HELP_BENCH,
    Q36_HELP_EVAL,
} q36_help_tool;

void q36_help_print(FILE *fp, q36_help_tool tool, const char *topic);

#endif
