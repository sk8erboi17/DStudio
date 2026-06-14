#include <stddef.h>

static const char *case_id = "pwn-impossible-04-integer-boundary-review";
static const char *case_category = "pwn";
static const char *case_difficulty = "impossible";
static const unsigned case_ordinal = 4u;

const char *dstudio_case_id(void) { return case_id; }
const char *dstudio_case_category(void) { return case_category; }
const char *dstudio_case_difficulty(void) { return case_difficulty; }
unsigned dstudio_case_ordinal(void) { return case_ordinal; }
size_t dstudio_case_fingerprint_pwn_impossible_04_integer_boundary_review(void) { return sizeof("integer-boundary-review") + case_ordinal; }
