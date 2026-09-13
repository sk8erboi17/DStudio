#include <assert.h>
#define main dstudio_test_main
#include "../../src/dstudio.c"
#undef main

static unsigned checks;
static const char source[] = "one\ntwo\nthree\nfour\nfive\n";
static const char patch[] = "--- a/example.c\n+++ b/example.c\n"
    "@@ -1,3 +1,3 @@\n one\n-two\n+second\n three\n"
    "@@ -4,2 +4,3 @@\n four\n+inserted\n five\n";

static void reject(const char *input, const char *delta) {
    size_t n = 123;
    char *out = unified_candidate(input, strlen(input), delta, strlen(delta), "example.c", &n);
    assert(!out && n == 123);
    checks++;
}

static void cleanup_cases(const char *parent) {
    char outside[512], keep[560];
    snprintf(outside, sizeof outside, "%s/unrelated-directory", parent);
    assert(!mkdir(outside, 0700));
    snprintf(keep, sizeof keep, "%s/keep", outside);
    assert(jsonl_write_file(keep, "preserve fixture", 16));
    for (int kind = 0; kind < 3; kind++) {
        char stage[512], retained[544], output[560], link[560], replacement[560];
        snprintf(stage, sizeof stage, "%s/stage-%d", parent, kind);
        snprintf(retained, sizeof retained, "%s-retained", stage);
        snprintf(output, sizeof output, "%s/object", stage);
        snprintf(link, sizeof link, "%s/link", stage);
        assert(!mkdir(stage, 0700));
        int fd = jsonl_open_stage(stage);
        assert(fd >= 0 && (fcntl(fd, F_GETFD) & FD_CLOEXEC));
        assert(jsonl_stage_matches(stage, fd));
        assert(jsonl_write_file(output, "build object", 12));
        assert(!symlink("../unrelated-directory/keep", link));
        if (kind) {
            assert(!rename(stage, retained));
            if (kind == 1) assert(!symlink("unrelated-directory", stage));
            else {
                assert(!mkdir(stage, 0700));
                snprintf(replacement, sizeof replacement, "%s/user-file", stage);
                assert(jsonl_write_file(replacement, "preserve replacement", 20));
            }
            assert(!jsonl_stage_matches(stage, fd));
        }
        jsonl_clean_stage(stage, fd);
        size_t n = 0; char *bytes = unified_read(keep, &n);
        assert(bytes && n == 16 && !memcmp(bytes, "preserve fixture", 16)); free(bytes);
        if (!kind) assert(access(stage, F_OK) != 0);
        else {
            snprintf(output, sizeof output, "%s/object", retained);
            assert(access(output, F_OK) != 0); /* cleanup follows its owned descriptor */
            if (kind == 1) assert(jsonl_open_stage(stage) < 0);
            else {
                bytes = unified_read(replacement, &n);
                assert(bytes && n == 20 && !memcmp(bytes, "preserve replacement", 20)); free(bytes);
            }
        }
        checks++;
    }
    char bounded[512], file[560], nested[560], nested_file[600];
    snprintf(bounded, sizeof bounded, "%s/bounded-stage", parent);
    assert(!mkdir(bounded, 0700));
    for (int i = 0; i < 160; i++) {
        snprintf(file, sizeof file, "%s/object-%03d", bounded, i);
        assert(jsonl_write_file(file, "x", 1));
    }
    int fd = jsonl_open_stage(bounded); assert(fd >= 0);
    jsonl_clean_stage(bounded, fd);
    int remaining = 0;
    for (int i = 0; i < 160; i++) {
        snprintf(file, sizeof file, "%s/object-%03d", bounded, i);
        remaining += access(file, F_OK) == 0;
    }
    assert(remaining >= 32 && remaining < 160); checks++;
    snprintf(nested, sizeof nested, "%s/nested", bounded);
    snprintf(nested_file, sizeof nested_file, "%s/keep", nested);
    assert(!mkdir(nested, 0700) && jsonl_write_file(nested_file, "preserve nested", 15));
    fd = jsonl_open_stage(bounded); assert(fd >= 0);
    jsonl_clean_stage(bounded, fd);
    assert(access(nested_file, F_OK) == 0); checks++;
}

static void file_cases(void) {
    assert(!mkdir("tests/.artifacts", 0700) || errno == EEXIST);
    const char *parent = "tests/.artifacts/unified-patch";
    assert(!mkdir(parent, 0700) || errno == EEXIST);
    char dir[] = "tests/.artifacts/unified-patch/run-XXXXXX";
    assert(mkdtemp(dir));
    cleanup_cases(dir);
    char manifest[256], first[256], second[256];
    snprintf(manifest, sizeof manifest, "%s/manifest", dir);
    snprintf(first, sizeof first, "%s/first.patch", dir);
    snprintf(second, sizeof second, "%s/second.patch", dir);
    assert(jsonl_write_file(first, patch, strlen(patch)));
    assert(jsonl_write_file(second, patch, strlen(patch)));
    const char *valid = "name=fixture\nversion=87\npatch=first.patch\npatch=second.patch\n";
    assert(jsonl_write_file(manifest, valid, strlen(valid)));
    ds4ui_patch_set set;
    assert(patch_load_set(dir, &set));
    size_t n = strlen(source);
    char *input = ds4_strdup_local(source);
    assert(patch_apply_unified(&set, &input, &n, "example.c"));
    assert(!strcmp(input, "one\nsecond\nthree\nfour\ninserted\nfive\n"));
    free(input); checks++; /* Identical variants are one result, not ambiguity. */

    const char *conflict = "--- a/example.c\n+++ b/example.c\n@@ -1,1 +1,1 @@\n-one\n+different\n";
    assert(jsonl_write_file(second, conflict, strlen(conflict)));
    input = ds4_strdup_local(source); n = strlen(source);
    char *identity = input;
    assert(!patch_apply_unified(&set, &input, &n, "example.c"));
    assert(input == identity && n == strlen(source) && !strcmp(input, source));
    free(input); checks++;

    assert(!unlink(second));
    for (int i = 0; i < 4; i++) {
        if (i == 1) assert(!symlink("first.patch", second));
        if (i == 2) { assert(!unlink(second)); assert(!mkfifo(second, 0600)); }
        if (i == 3) {
            assert(!unlink(second));
            int fd = open(second, O_WRONLY | O_CREAT | O_EXCL, 0600);
            assert(fd >= 0 && !ftruncate(fd, DSTUDIO_PATCH_TEXT_LIMIT + 1u)); close(fd);
        }
        input = ds4_strdup_local(source); n = strlen(source); identity = input;
        assert(!patch_apply_unified(&set, &input, &n, "example.c"));
        assert(input == identity && n == strlen(source) && !strcmp(input, source));
        free(input); checks++; /* Missing/link/FIFO/size cannot publish a prior variant. */
    }
    patch_free_set(&set);
    const char *bad[] = {
        "name=fixture\nthis has no equals\npatch=first.patch\n",
        "version=invalid\npatch=first.patch\n",
        "version=0\npatch=first.patch\n",
        "mystery=entry\npatch=first.patch\n",
        "version=87\n",
        "version=87\npatch=../first.patch\n",
        "version=87\npatch=first.c\n",
        "version=87\npatch=first.patch\nedit=001\n",
        ("version=87\npatch=first.patch\npatch=first.patch\npatch=first.patch\npatch=first.patch\n"
            "patch=first.patch\npatch=first.patch\npatch=first.patch\npatch=first.patch\npatch=first.patch\n"),
    };
    for (size_t i = 0; i < sizeof bad / sizeof *bad; i++) {
        assert(jsonl_write_file(manifest, bad[i], strlen(bad[i])));
        assert(!patch_load_set(dir, &set)); patch_free_set(&set); checks++;
    }
    assert(jsonl_write_file(first, valid, strlen(valid)));
    assert(!unlink(manifest) && !symlink("first.patch", manifest));
    assert(!patch_load_set(dir, &set)); patch_free_set(&set); checks++;
    printf("unified_patch_unit: retained file-input cases in %s\n", dir);
}

int main(void) {
    size_t n = 0;
    char *out = unified_candidate(source, strlen(source), patch, strlen(patch), "example.c", &n);
    const char expected[] = "one\nsecond\nthree\nfour\ninserted\nfive\n";
    assert(out && n == strlen(expected) && !memcmp(out, expected, n)); free(out); checks++;
    const char shifted[] = "unrelated prefix\n\none\ntwo\nthree\nfour\nfive\nunrelated suffix\n";
    out = unified_candidate(shifted, strlen(shifted), patch, strlen(patch), "example.c", &n);
    assert(out && !strcmp(out, "unrelated prefix\n\none\nsecond\nthree\nfour\ninserted\nfive\nunrelated suffix\n"));
    free(out); checks++;
    reject(expected, patch); /* repeated/partially applied source */
    reject("one\nsecond\nthree\nfour\nfive\n", patch);
    reject("one\ntwo changed\nthree\nfour\nfive\n", patch);
    reject("one\ntwo\nthree\none\ntwo\nthree\nfour\nfive\n", patch);
    reject("four\nfive\none\ntwo\nthree\n", patch);
    reject("prefixone\ntwo\nthree\nfour\nfive\n", patch); /* Context starts at a line boundary. */
    reject(source, "--- a/../example.c\n+++ b/../example.c\n@@ -1,1 +1,1 @@\n-one\n+changed\n");
    reject(source, "--- a/example.c\n+++ b/elsewhere.c\n@@ -1,1 +1,1 @@\n-one\n+changed\n");
    reject(source, "--- a/example.c\n+++ b/example.c\n@@ -1,2 +1,1 @@\n-one\n+changed\n");
    reject(source, "--- a/example.c\n+++ b/example.c\n@@ -1,1 +1,1 @@\n one\n");
    reject(source, "--- a/example.c\n+++ b/example.c\n@@ -999999999999999999999,1 +1,1 @@\n-one\n+changed\n");
    reject(source, "--- a/example.c\n+++ b/example.c\n@@ -1,0 +1,1 @@\n+changed\n");
    reject(source, "--- a/example.c\n+++ b/example.c\n@@ -1,1 +1,1 @@\n-one\n+changed");
    reject(source, "--- a/example.c\n+++ b/example.c\n@@ -1,1 +1,1 @@\n-one\n+changed\n--- a/other.c\n");
    out = unified_candidate(source, sizeof source, patch, strlen(patch), "example.c", &n);
    assert(!out); checks++; /* embedded/trailing NUL is not source text */
    out = unified_candidate(source, DSTUDIO_PATCH_TEXT_LIMIT + 1u, patch, strlen(patch), "example.c", &n);
    assert(!out); checks++;
    file_cases();
    printf("unified_patch_unit: %u exact-context, ordering, bounds and private-candidate checks passed\n", checks);
    return 0;
}
