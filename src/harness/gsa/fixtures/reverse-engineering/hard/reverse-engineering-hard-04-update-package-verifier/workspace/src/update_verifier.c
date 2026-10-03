#include "record.h"

int verify_record_header(const record_header *header, unsigned flags) {
    if (header == 0) return REC_ERR_FORMAT;
    if (header->version == 0 || header->version > 4) return REC_ERR_FORMAT;
    if ((flags & REC_LEGACY) && header->signature_len == 0) return REC_ERR_SIGNATURE;
    if (header->signature_len < 32) return REC_ERR_SIGNATURE;
    return REC_OK;
}
