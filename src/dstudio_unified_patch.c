/* Single-file unified patches for derived native runtimes. This intentionally
 * supports only text hunks, unchanged file identity and complete exact context:
 * no fuzz, whitespace repair, binary patches, paths from a patch, or partial
 * publication. Source and patch inputs are bounded, cold build-worker data.
 * Git remains the independent application/reversal oracle in migration tests. */
#define DSTUDIO_PATCH_TEXT_LIMIT (16u * 1024u * 1024u)

static int unified_put(json_dyn_buf *b, const char *text, size_t n) {
    return n <= DSTUDIO_PATCH_TEXT_LIMIT && b->len <= DSTUDIO_PATCH_TEXT_LIMIT - n &&
           json_dyn_putn(b, text, n);
}

static int unified_number(const char **p, unsigned long *value) {
    if (!isdigit((unsigned char)**p)) return 0;
    char *end;
    errno = 0;
    unsigned long n = strtoul(*p, &end, 10);
    if (errno || n > DSTUDIO_PATCH_TEXT_LIMIT) return 0;
    *p = end; *value = n;
    return 1;
}

static int unified_range(const char **p, unsigned long *start, unsigned long *count) {
    *count = 1;
    if (!unified_number(p, start)) return 0;
    if (**p == ',') { (*p)++; if (!unified_number(p, count)) return 0; }
    return *start <= DSTUDIO_PATCH_TEXT_LIMIT - *count;
}

/* Return a private candidate or NULL. A mismatch in one alternative is normal;
 * the caller reports one failure only after evaluating the complete patch set. */
static char *unified_candidate(const char *source, size_t size, const char *patch,
                               size_t patch_size, const char *source_name, size_t *out_size) {
    if (!source || !patch || size > DSTUDIO_PATCH_TEXT_LIMIT ||
        patch_size > DSTUDIO_PATCH_TEXT_LIMIT || strlen(source) != size ||
        strlen(patch) != patch_size) return NULL;
    char header[256];
    int hlen = snprintf(header, sizeof header, "--- a/%s\n+++ b/%s\n", source_name, source_name);
    if (hlen <= 0 || (size_t)hlen >= sizeof header || patch_size < (size_t)hlen ||
        memcmp(header, patch, (size_t)hlen)) return NULL;
    const char *p = patch + hlen, *cursor = source;
    unsigned long previous_old_end = 0, previous_new_end = 0;
    unsigned hunks = 0;
    json_dyn_buf output = {0}, before = {0}, after = {0};
    while (*p) {
        const char *line_end = strchr(p, '\n');
        unsigned long old_start, old_count, new_start, new_count;
        if (!line_end || strncmp(p, "@@ -", 4) || ++hunks > 512) goto fail;
        p += 4;
        if (!unified_range(&p, &old_start, &old_count) || strncmp(p, " +", 2)) goto fail;
        p += 2;
        if (!unified_range(&p, &new_start, &new_count) || strncmp(p, " @@", 3) ||
            p + 3 > line_end || !old_start || !old_count ||
            old_start < previous_old_end || new_start < previous_new_end) goto fail;
        previous_old_end = old_start + old_count;
        previous_new_end = new_start + new_count;
        p = line_end + 1;
        unsigned long removed = 0, added = 0;
        int changed = 0;
        while (removed < old_count || added < new_count) {
            line_end = strchr(p, '\n');
            if (!line_end || (*p != ' ' && *p != '-' && *p != '+')) goto fail;
            size_t n = (size_t)(line_end - p); /* includes the newline after the prefix */
            if (*p != '+') {
                if (++removed > old_count || !unified_put(&before, p + 1, n)) goto fail;
            }
            if (*p != '-') {
                if (++added > new_count || !unified_put(&after, p + 1, n)) goto fail;
            }
            changed |= *p != ' ';
            p = line_end + 1;
        }
        if (!changed || !before.len) goto fail;
        const char *match = strstr(source, before.ptr);
        while (match && match > source && match[-1] != '\n') match = strstr(match + 1, before.ptr);
        if (!match || match < cursor) goto fail;
        const char *duplicate = strstr(match + 1, before.ptr);
        while (duplicate && duplicate[-1] != '\n') duplicate = strstr(duplicate + 1, before.ptr);
        if (duplicate) goto fail;
        if (!unified_put(&output, cursor, (size_t)(match - cursor)) ||
            !unified_put(&output, after.ptr ? after.ptr : "", after.len)) goto fail;
        cursor = match + before.len;
        free(before.ptr); memset(&before, 0, sizeof before);
        free(after.ptr); memset(&after, 0, sizeof after);
    }
    if (!hunks || !unified_put(&output, cursor, size - (size_t)(cursor - source))) goto fail;
    *out_size = output.len;
    return output.ptr;
fail:
    free(before.ptr); free(after.ptr); free(output.ptr);
    return NULL;
}

static char *unified_read(const char *path, size_t *size) {
    FILE *f = NULL;
#ifdef _WIN32
    HANDLE h = CreateFileA(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                           NULL, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, NULL);
    BY_HANDLE_FILE_INFORMATION info;
    if (h == INVALID_HANDLE_VALUE) goto fail;
    if (!GetFileInformationByHandle(h, &info) ||
        (info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY))) {
        CloseHandle(h); goto fail;
    }
    int fd = _open_osfhandle((intptr_t)h, _O_RDONLY | _O_BINARY);
    if (fd < 0) { CloseHandle(h); goto fail; }
    f = _fdopen(fd, "rb");
    if (!f) { _close(fd); goto fail; }
#else
    int fd = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    if (fd < 0) goto fail;
    f = fdopen(fd, "rb");
    if (!f) { close(fd); goto fail; }
#endif
    struct stat before, after;
    if (fstat(fd, &before) || !S_ISREG(before.st_mode) || before.st_size < 0 ||
        (uint64_t)before.st_size > DSTUDIO_PATCH_TEXT_LIMIT) goto fail;
    size_t n = (size_t)before.st_size;
    char *body = malloc(n + 1);
    if (!body) goto fail;
    int ok = fread(body, 1, n, f) == n && fgetc(f) == EOF && !ferror(f) &&
             !fstat(fd, &after) && before.st_size == after.st_size &&
             before.st_mtime == after.st_mtime && before.st_ctime == after.st_ctime;
    if (!ok || memchr(body, '\0', n)) { free(body); goto fail; }
    fclose(f);
    body[n] = '\0';
    jsonl_normalize_newlines(body, &n);
    *size = n;
    return body;
fail:
    if (f) fclose(f);
    patch_fail("missing, linked, changing or oversized build input: %s", path);
    return NULL;
}

static int unified_source_unchanged(const char *path, const char *expected, size_t size) {
    size_t n = 0;
    char *current = unified_read(path, &n);
    int same = current && n == size && !memcmp(current, expected, size);
    free(current);
    return same;
}

static int patch_apply_unified(ds4ui_patch_set *set, char **source, size_t *size,
                               const char *source_name) {
    char *selected = NULL;
    size_t selected_size = 0;
    for (int i = 0; i < set->unified_count; i++) {
        size_t patch_size = 0, candidate_size = 0;
        char *patch = unified_read(set->unified_paths[i], &patch_size);
        if (!patch) { free(selected); return 0; }
        char *candidate = unified_candidate(*source, *size, patch, patch_size,
                                            source_name, &candidate_size);
        free(patch);
        if (!candidate) continue;
        if (selected) {
            /* Pins with an unchanged hunk set can differ only in line offsets.
             * Accept equivalent candidates, never a first-match semantic choice. */
            int same = selected_size == candidate_size && !memcmp(selected, candidate, selected_size);
            free(candidate);
            if (!same) {
                free(selected);
                return patch_fail("ambiguous unified patch results for %s", source_name);
            }
        } else { selected = candidate; selected_size = candidate_size; }
    }
    if (!selected)
        return patch_fail("no complete exact-context unified patch matches %s (drift, partial or unsupported source)", source_name);
    free(*source); *source = selected; *size = selected_size;
    return 1;
}
