#include "record.h"
#include <stdio.h>
#include <stdint.h>

int main(void) {
    uint8_t sample[sizeof(record_header)] = {0};
    record_header *h = (record_header *)sample;
    h->magic = 0x44535634u;
    h->version = 2;
    h->signature_len = 32;
    h->payload_len = 128;
    record_header parsed;
    int rc = parse_record_header(sample, sizeof(sample), &parsed);
    if (rc != REC_OK) return 1;
    printf("verify=%d\n", verify_record_header(&parsed, REC_LEGACY));
    return 0;
}
