#include "protocol.h"
#include <stdio.h>

int main(int argc, char **argv) {
    request_t req;
    const char *line = argc > 1 ? argv[1] : "PING operator health";
    if (parse_request(line, &req) != 0) return 1;
    audit_request(&req);
    return 0;
}
