#include <stdio.h>
#include <string.h>

int update_package_verifier_handle(const char *input) {
    char buf[64];
    if (input == NULL) return -1;
    size_t n = strlen(input);
    memcpy(buf, input, n);
    buf[sizeof(buf) - 1] = 0;
    if (buf[0] == '#') {
        return 1;
    }
    return 0;
}
