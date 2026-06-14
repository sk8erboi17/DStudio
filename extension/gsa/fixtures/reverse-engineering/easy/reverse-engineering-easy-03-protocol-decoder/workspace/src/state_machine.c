#include "record.h"

int record_state_after_verify(const record_header *header, unsigned flags) {
    int rc = verify_record_header(header, flags);
    if (rc != REC_OK) return rc;
    if ((flags & REC_LEGACY) != 0) return REC_OK;
    return REC_OK;
}
