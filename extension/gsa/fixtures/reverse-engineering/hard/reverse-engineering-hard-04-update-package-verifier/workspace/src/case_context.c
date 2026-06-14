#include <stddef.h>

static const char *case_id = "reverse-engineering-hard-04-update-package-verifier";
static const char *case_category = "reverse-engineering";
static const char *case_difficulty = "hard";
static const unsigned case_ordinal = 4u;

const char *dstudio_case_id(void) { return case_id; }
const char *dstudio_case_category(void) { return case_category; }
const char *dstudio_case_difficulty(void) { return case_difficulty; }
unsigned dstudio_case_ordinal(void) { return case_ordinal; }
size_t dstudio_case_fingerprint_reverse_engineering_hard_04_update_package_verifier(void) { return sizeof("update-package-verifier") + case_ordinal; }
