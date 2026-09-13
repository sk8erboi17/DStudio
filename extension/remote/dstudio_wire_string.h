#ifndef DSTUDIO_WIRE_STRING_H
#define DSTUDIO_WIRE_STRING_H

#include <stddef.h>
#include <stdlib.h>

/* Decode one bounded JSON string, not a key search. Both the host relay and
 * runtime pipe consumer use this exact Unicode boundary. No replacement or
 * truncation is allowed: tool paths/arguments must retain their bytes. NUL
 * cannot be represented by the existing C-string protocol and is rejected. */
static unsigned dstudio_wire_hex4(const char *p) {
    unsigned value = 0;
    for (int i = 0; i < 4; i++) {
        unsigned char c = (unsigned char)p[i];
        unsigned n = c >= '0' && c <= '9' ? c - '0' :
                     c >= 'a' && c <= 'f' ? c - 'a' + 10 :
                     c >= 'A' && c <= 'F' ? c - 'A' + 10 : 16;
        if (n == 16) return 0xffffffffU;
        value = (value << 4) | n;
    }
    return value;
}

static int dstudio_wire_string_decode(const char *begin, const char *end,
                                      char *result, size_t capacity, size_t *decoded) {
    if (!begin || !end || end - begin < 2 || *begin != '"' || end[-1] != '"' || !result) return 0;
    const char *p = begin + 1, *limit = end - 1;
    size_t used = 0;
    while (p < limit) {
        unsigned cp = (unsigned char)*p++;
        if (cp < 0x20 || cp == '"') goto invalid;
        if (cp == '\\') {
            if (p == limit) goto invalid;
            cp = (unsigned char)*p++;
            switch (cp) {
            case '"': case '\\': case '/': break;
            case 'b': cp = '\b'; break;
            case 'f': cp = '\f'; break;
            case 'n': cp = '\n'; break;
            case 'r': cp = '\r'; break;
            case 't': cp = '\t'; break;
            case 'u':
                if (limit - p < 4) goto invalid;
                cp = dstudio_wire_hex4(p); p += 4;
                if (cp == 0xffffffffU) goto invalid;
                if (cp >= 0xd800 && cp <= 0xdbff) {
                    if (limit - p < 6 || p[0] != '\\' || p[1] != 'u') goto invalid;
                    unsigned low = dstudio_wire_hex4(p + 2); p += 6;
                    if (low < 0xdc00 || low > 0xdfff) goto invalid;
                    cp = 0x10000 + ((cp - 0xd800) << 10) + low - 0xdc00;
                } else if (cp >= 0xdc00 && cp <= 0xdfff) goto invalid;
                break;
            default: goto invalid;
            }
        } else if (cp >= 0x80) {
            unsigned count, minimum;
            if (cp >= 0xc2 && cp <= 0xdf) { count = 1; minimum = 0x80; cp &= 31; }
            else if (cp >= 0xe0 && cp <= 0xef) { count = 2; minimum = 0x800; cp &= 15; }
            else if (cp >= 0xf0 && cp <= 0xf4) { count = 3; minimum = 0x10000; cp &= 7; }
            else goto invalid;
            if ((size_t)(limit - p) < count) goto invalid;
            for (unsigned i = 0; i < count; i++) {
                unsigned c = (unsigned char)*p++;
                if ((c & 0xc0) != 0x80) goto invalid;
                cp = (cp << 6) | (c & 63);
            }
            if (cp < minimum || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) goto invalid;
        }
        size_t bytes = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
        if (!cp || used >= capacity || bytes >= capacity - used) goto invalid;
        if (cp < 0x80) result[used++] = (char)cp;
        else {
            if (cp < 0x800) result[used++] = (char)(0xc0 | (cp >> 6));
            else {
                if (cp < 0x10000) result[used++] = (char)(0xe0 | (cp >> 12));
                else {
                    result[used++] = (char)(0xf0 | (cp >> 18));
                    result[used++] = (char)(0x80 | ((cp >> 12) & 63));
                }
                result[used++] = (char)(0x80 | ((cp >> 6) & 63));
            }
            result[used++] = (char)(0x80 | (cp & 63));
        }
    }
    if (used >= capacity) return 0;
    result[used] = 0;
    if (decoded) *decoded = used;
    return 1;
invalid:
    return 0;
}

static char *dstudio_wire_string(const char *begin, const char *end) {
    if (!begin || !end || end - begin < 2) return NULL;
    size_t capacity = (size_t)(end - begin);
    char *result = malloc(capacity);
    if (result && !dstudio_wire_string_decode(begin, end, result, capacity, NULL)) {
        free(result); result = NULL;
    }
    return result;
}
#endif
