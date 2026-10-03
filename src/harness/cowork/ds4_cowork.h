#ifndef DS4_COWORK_H
#define DS4_COWORK_H

#include <stddef.h>

typedef struct {
    const char *name;
    const char *value;
} ds4_cowork_arg;

/* Office-tool bridge used by the patched ds4 agent runtime. The returned
 * string is heap allocated and must be released with ds4_cowork_free(). */
int ds4_cowork_tool_known(const char *name);
char *ds4_cowork_execute(const char *tool,
                         const ds4_cowork_arg *args,
                         size_t nargs,
                         const char *workspace);
void ds4_cowork_free(char *result);

#endif
