/* Emit the exact JavaScript used by the native search tool. The browser gate
 * executes it against controlled pages; this does not launch Chrome or a model. */
#include "q36_web.c"

int main(void) {
    if (fputs(web_extract_search_js, stdout) == EOF || fflush(stdout) != 0)
        return 1;
    return 0;
}
