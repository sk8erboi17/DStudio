/* Test-owned host for browser tests of the Open IDE view. Serves the REAL
 * connection dispatcher and the /api/agent/fs/ handlers from src/dstudio.c over
 * 127.0.0.1 for one task-owned workspace. No engine or model runs: a
 * task-owned idle child stands in for the Agent process, and the test toggles
 * the host's agent-working state through stdin ("working 1" / "working 0",
 * acknowledged with "ok"). Prints "PORT <n>" once listening; exits on stdin EOF.
 * With a second argument "design" it stands in for the Design runtime instead:
 * the same folder is then also the project served by /api/design/preview/. */
#define _GNU_SOURCE
#define main dstudio_embedded_main_for_tests
#include "../../src/dstudio.c"
#undef main

#ifndef _WIN32
int main(int argc, char **argv) {
    if (argc < 2) { fprintf(stderr, "usage: %s <workspace> [agent|design]\n", argv[0]); return 2; }
    const int design = argc > 2 && !strcmp(argv[2], "design");
    signal(SIGPIPE, SIG_IGN);
    int lifeline[2];
    if (pipe(lifeline) != 0) return 1;
    pid_t agent = fork();
    if (agent < 0) return 1;
    if (!agent) {
        close(lifeline[1]);
        char byte;
        while (read(lifeline[0], &byte, 1) > 0) {}
        _exit(0);
    }
    close(lifeline[0]);
    g_mode = design ? ENGINE_DESIGN : ENGINE_AGENT;
    g_child = agent;
    cstr_copy(g_workdir, sizeof g_workdir, argv[1]);
    if (design) cstr_copy(g_design_dir, sizeof g_design_dir, argv[1]);

    int ls = socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in a = { 0 };
    a.sin_family = AF_INET;
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (ls < 0 || bind(ls, (struct sockaddr *)&a, sizeof a) != 0 || listen(ls, 16) != 0) return 1;
    socklen_t al = sizeof a;
    if (getsockname(ls, (struct sockaddr *)&a, &al) != 0) return 1;
    printf("PORT %d\n", ntohs(a.sin_port));
    fflush(stdout);

    char line[64];
    size_t used = 0;
    for (;;) {
        struct pollfd fds[2] = { { ls, POLLIN, 0 }, { STDIN_FILENO, POLLIN, 0 } };
        if (poll(fds, 2, -1) < 0) { if (errno == EINTR) continue; break; }
        if (fds[1].revents) {
            ssize_t n = read(STDIN_FILENO, line + used, sizeof line - 1 - used);
            if (n <= 0) break;
            used += (size_t)n;
            line[used] = '\0';
            char *nl;
            while ((nl = strchr(line, '\n')) != NULL) {
                *nl = '\0';
                if (!strcmp(line, "working 1")) g_agent_working = 1;
                else if (!strcmp(line, "working 0")) g_agent_working = 0;
                printf("ok\n");
                fflush(stdout);
                size_t rest = used - (size_t)(nl + 1 - line);
                memmove(line, nl + 1, rest + 1);
                used = rest;
            }
            if (used >= sizeof line - 1) used = 0;
        }
        if (fds[0].revents & POLLIN) {
            int c = accept(ls, NULL, NULL);
            if (c >= 0) handle_connection(c);
        }
    }
    kill(agent, SIGKILL);
    waitpid(agent, NULL, 0);
    return 0;
}
#else
int main(void) { puts("agent_workspace_host: not supported on Windows"); return 1; }
#endif
