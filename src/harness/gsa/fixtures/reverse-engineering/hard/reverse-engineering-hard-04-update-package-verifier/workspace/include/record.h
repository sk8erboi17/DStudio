#pragma once
#include <stddef.h>
#include <stdint.h>

#define REC_OK 0
#define REC_ERR_FORMAT -1
#define REC_ERR_SIGNATURE -2
#define REC_LEGACY 0x01u

typedef struct {
    uint32_t magic;
    uint16_t version;
    uint16_t signature_len;
    uint32_t payload_len;
} record_header;

int parse_record_header(const uint8_t *buf, size_t len, record_header *out);
int verify_record_header(const record_header *header, unsigned flags);
