/* Model-free native job/descriptor lifetime test, not an inference benchmark. */
#define Q36_AGENT_TEST
#define Q36_AGENT_TEST_NO_MAIN
#include "q36_agent.c"

static int open_descriptors(void) {
    int count = 0;
    for (int fd = 0; fd < 4096; fd++)
        if (fcntl(fd, F_GETFD) >= 0 || errno != EBADF) count++;
    return count;
}

int main(int argc, char **argv) {
    if (argc == 2 && !strcmp(argv[1], "--layout")) {
        printf("{\"jobBytes\":%zu,\"workerBytes\":%zu}\n",
               sizeof(agent_bash_job), sizeof(agent_worker));
        return 0;
    }
    if (!isatty(STDIN_FILENO)) return 2;
    agent_config cfg = {.non_interactive = false};
    agent_worker w = {0}; w.cfg = &cfg;
    pthread_mutex_init(&w.mu, NULL); pthread_cond_init(&w.cond, NULL);
    if (pipe(w.wake_fd) != 0) return 3;
    set_nonblock(w.wake_fd[0], true, NULL); set_nonblock(w.wake_fd[1], true, NULL);
    int baseline = open_descriptors();
    int checks = 0;
    for (int i = 0; i < 32; i++) {
        char err[160], owned_path[PATH_MAX];
        bool cancel = i % 2 != 0;
        agent_bash_job *job = agent_bash_start(&w,
            cancel ? "exec sleep 30" : "printf bounded-job", cancel ? 30 : 3,
            err, sizeof(err));
        if (!job) { fprintf(stderr, "%s\n", err); return 4; }
        snprintf(owned_path, sizeof(owned_path), "%s", job->path);
        if (!cancel) {
            agent_bash_refresh_for(&w, job, 3);
            if (job->running || job->exit_status != 0) return 5;
#ifdef Q36_TTY_MONITOR_TEST
            /* Observe the monitor's completed lifetime before removing the
             * historical job. Join is outside every owner/job mutex. The
             * native master still belongs to history; our retained slave
             * must already be closed, without waiting for history cleanup. */
            if (!job->thread_started || pthread_join(job->thread, NULL) != 0) return 7;
            job->thread_started = false;
            if (open_descriptors() != baseline + 1) return 8;
#endif
        }
        agent_bash_remove_job(&w, job);
        unlink(owned_path); /* only this just-created test job's receipt */
        if (w.bash_jobs || open_descriptors() != baseline) return 6;
        checks++;
    }
    printf("{\"jobs\":%d,\"normalExits\":16,\"cancelled\":16,\"leakedDescriptors\":0,\"jobBytes\":%zu,\"workerBytes\":%zu}\n",
           checks, sizeof(agent_bash_job), sizeof(agent_worker));
    close(w.wake_fd[0]); close(w.wake_fd[1]);
    pthread_mutex_destroy(&w.mu); pthread_cond_destroy(&w.cond);
    return 0;
}
