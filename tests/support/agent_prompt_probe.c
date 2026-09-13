#define DS4_AGENT_TEST_NO_MAIN
#include <assert.h>
#include "ds4_agent.c"

static void emit_prompt(const char *id, char *prompt) {
    assert(prompt);
    size_t cap = strlen(prompt) * 6 + 8;
    char *escaped = malloc(cap);
    assert(escaped);
    ds4ui_json_escape(prompt, escaped, cap);
    printf("{\"case\":\"%s\",\"prompt\":\"%s\"}\n", id, escaped);
    free(escaped);
    free(prompt);
}

int main(void) {
    for (int cowork = 0; cowork < 2; cowork++) {
        setenv("DS4UI_RUNTIME_NAME", cowork ? "cowork" : "agent", 1);
#ifdef DSTUDIO_TEST_LAGUNA
        emit_prompt(cowork ? "cowork-laguna" : "agent-laguna", agent_build_laguna_tools_prompt());
        emit_prompt(cowork ? "cowork-dsml" : "agent-dsml", agent_build_dsml_tools_prompt());
#else
        for (int glm = 0; glm < 2; glm++) for (int vision = 0; vision < 2; vision++) {
            char id[64];
            snprintf(id, sizeof id, "%s-%s-%d", cowork ? "cowork" : "agent", glm ? "glm" : "dsml", vision);
            char *prompt = cowork
                ? (glm ? agent_build_cowork_glm_tools_prompt(false, vision)
                       : agent_build_cowork_dsml_tools_prompt(false, vision))
                : (glm ? agent_build_glm_tools_prompt(false, vision)
                       : agent_build_dsml_tools_prompt(false, vision));
            emit_prompt(id, prompt);
        }
#endif
        agent_config cfg = {0};
        emit_prompt(cowork ? "remote-cowork" : "remote-agent", ds4ui_remote_system_prompt(&cfg));
    }
    return 0;
}
