#include <stddef.h>

static const char *case_id = "reverse-engineering-easy-03-protocol-decoder";
static const char *case_category = "reverse-engineering";
static const char *case_difficulty = "easy";
static const unsigned case_ordinal = 3u;

const char *dstudio_case_id(void) { return case_id; }
const char *dstudio_case_category(void) { return case_category; }
const char *dstudio_case_difficulty(void) { return case_difficulty; }
unsigned dstudio_case_ordinal(void) { return case_ordinal; }
size_t dstudio_case_fingerprint_reverse_engineering_easy_03_protocol_decoder(void) { return sizeof("protocol-decoder") + case_ordinal; }
