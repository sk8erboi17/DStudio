#pragma once
#include <stddef.h>

typedef struct {
    char command[16];
    char user[32];
    char payload[128];
} request_t;

int parse_request(const char *line, request_t *req);
void audit_request(const request_t *req);
