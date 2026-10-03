#include "record.h"
#include <string.h>

int parse_record_header(const uint8_t *buf, size_t len, record_header *out) {
    if (buf == 0 || out == 0 || len < sizeof(record_header)) return REC_ERR_FORMAT;
    memcpy(out, buf, sizeof(record_header));
    if (out->magic != 0x44535634u) return REC_ERR_FORMAT;
    if (out->payload_len > 1024u * 1024u * 8u) return REC_ERR_FORMAT;
    return REC_OK;
}
