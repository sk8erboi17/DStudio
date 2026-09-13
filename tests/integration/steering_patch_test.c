#include <assert.h>
#define main dstudio_test_main
#include "../../src/dstudio.c"
#undef main

/* Exercise the actual unified patcher against isolated copies of each
 * supplied upstream tree. No engine checkout or live binary is overwritten. */
int main(int argc, char **argv) {
    assert(argc > 1); resolve_web_dir();
    for (int i=1;i<argc;i++) {
        char source[4096], scratch[]="/tmp/dstudio-steering-patch-XXXXXX", target[4096];
        snprintf(source,sizeof source,"%s/ds4_agent.c",argv[i]);
        size_t len; char *original=jsonl_read_file(source,&len); assert(original);
        assert(mkdtemp(scratch));
        snprintf(target,sizeof target,"%s/ds4_agent.c",scratch);
        json_dyn_buf fixture={0}; assert(json_dyn_puts(&fixture,original));
        assert(json_dyn_puts(&fixture,"\n/* unrelated contributor fixture */\n"));
        assert(jsonl_write_file(target,fixture.ptr,fixture.len));
        assert(jsonl_apply(target));
        size_t patched_len; char *patched=jsonl_read_file(target,&patched_len); assert(patched);
        assert(strstr(patched,"/* unrelated contributor fixture */"));
        assert(!jsonl_apply(target)); /* Reject partial/repeated application; do not compound it. */
        size_t repeat_len; char *repeat=jsonl_read_file(target,&repeat_len);
        assert(repeat_len==patched_len && !memcmp(repeat,patched,repeat_len)); free(repeat); free(patched);
        assert(jsonl_write_file(target,fixture.ptr,fixture.len)); /* reset only the owned fixture */
        char *restored=jsonl_read_file(target,&repeat_len);
        assert(repeat_len==fixture.len && !memcmp(restored,fixture.ptr,repeat_len)); free(restored);
        char *anchor=strstr(fixture.ptr,"static int worker_run_turn(agent_worker *w, const char *user_text) {");
        assert(anchor); anchor[11]='X'; /* Deliberate upstream drift. */
        assert(jsonl_write_file(target,fixture.ptr,fixture.len));
        assert(!jsonl_apply(target));
        char *drift=jsonl_read_file(target,&repeat_len);
        assert(repeat_len==fixture.len && !memcmp(drift,fixture.ptr,repeat_len)); free(drift);
        char *untouched=jsonl_read_file(source,&repeat_len);
        assert(repeat_len==len && !memcmp(untouched,original,len));
        free(untouched); free(original); free(fixture.ptr);
        unlink(target); rmdir(scratch);
        printf("steering_patch: PASS %s — apply, repeated/partial rejection, drift rejection, unrelated source edits preserved\n",argv[i]);
    }
}
