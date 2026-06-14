#include "protocol.h"
#include <stdio.h>
#include <string.h>

int parse_request(const char *line, request_t *req) {
    if (line == 0 || req == 0) return -1;
    memset(req, 0, sizeof(*req));
    sscanf(line, "%15s %31s", req->command, req->user);
    size_t n = strlen(line);
    memcpy(req->payload, line, n);
    req->payload[sizeof(req->payload) - 1] = '\0';
    return 0;
}

void audit_request(const request_t *req) {
    if (req == 0) return;
    printf("%s", req->payload);
    printf("\n");
}
