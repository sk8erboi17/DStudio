#include <stddef.h>

static const char *case_id = "pwn-hard-01-stack-parser-review";
static const char *case_category = "pwn";
static const char *case_difficulty = "hard";
static const unsigned case_ordinal = 1u;

const char *dstudio_case_id(void) { return case_id; }
const char *dstudio_case_category(void) { return case_category; }
const char *dstudio_case_difficulty(void) { return case_difficulty; }
unsigned dstudio_case_ordinal(void) { return case_ordinal; }
size_t dstudio_case_fingerprint_pwn_hard_01_stack_parser_review(void) { return sizeof("stack-parser-review") + case_ordinal; }
