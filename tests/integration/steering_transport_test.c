/* Real native HTTP + runtime transport, with a deterministic inference owner
 * fixture (no weights, no claim of inference quality). */
#include <assert.h>
#define main dstudio_test_main
#include "../../src/dstudio.c"
#undef main
#include "../../extension/remote/dstudio_remote_llm.h"

static int commands[2], results[2];
static char observed[32768];
static void append_context(void *owner, const char *text) {
    (void)owner;
    assert(strlen(observed) + strlen(text) + 2 < sizeof observed);
    strcat(observed, text); strcat(observed, "|");
}
static void worker_fixture(void) {
    close(commands[1]); close(results[0]); close(g_srv_fd);
    steer_child_env();
    dstudio_steer s = {0}; char command;
    while (read(commands[0], &command, 1) == 1) {
        if (command == 'X') _exit(0);
        if (command == 'B') s = dstudio_steer_begin();
        else dstudio_steer_drain(&s, command == 'F', append_context, NULL);
        char reply[33000]; int n = snprintf(reply,sizeof reply,"%llu:%s",s.turn,observed);
        assert(fd_write_all(results[1], reply, (size_t)n + 1));
    }
    _exit(1);
}
static const char *boundary(char command) {
    assert(write(commands[1], &command, 1) == 1);
    static char reply[33000]; size_t n = 0;
    for (;;) {
        struct pollfd fds[] = {{g_srv_fd,POLLIN,0},{results[0],POLLIN,0}};
        assert(poll(fds,2,5000) > 0);
        if (fds[0].revents & POLLIN) {
            int fd = accept(g_srv_fd,NULL,NULL); assert(fd >= 0); handle_connection(fd);
        }
        if (fds[1].revents & POLLIN) {
            ssize_t got = read(results[0],reply+n,sizeof reply-n); assert(got > 0);
            n += (size_t)got; if (reply[n-1] == 0) return reply;
        }
    }
}
static const char *admit(const char *body) {
    int sockets[2]; assert(socketpair(AF_UNIX,SOCK_STREAM,0,sockets) == 0);
    api_steer(sockets[0],body); close(sockets[0]);
    static char response[32768]; ssize_t n = read(sockets[1],response,sizeof response-1);
    assert(n > 0); response[n] = 0; close(sockets[1]); return response;
}

int main(void) {
    signal(SIGPIPE,SIG_IGN);
    g_abuf = calloc(65536,1); g_acap = 65536;
    g_srv_fd = open_listener("127.0.0.1",0); assert(g_srv_fd >= 0);
    struct sockaddr_in addr; socklen_t size = sizeof addr;
    assert(getsockname(g_srv_fd,(struct sockaddr *)&addr,&size) == 0);
    g_http_port = ntohs(addr.sin_port);
    steer_prepare(); assert(strlen(g_steer.key) == 64);
    assert(pipe(commands) == 0 && pipe(results) == 0);
    g_mode = ENGINE_AGENT; g_agent_working = 1; g_ready = 1; g_active_turn_task = 41;
    pid_t child = fork(); assert(child >= 0);
    if (!child) worker_fixture();
    g_child = child; close(commands[0]); close(results[1]);
    assert(!strcmp(boundary('B'),"41:"));
    const char *first = "{\"expectedTurnId\":\"41\",\"inputId\":\"first\",\"text\":\"Use blue, not red\"}";
    assert(strstr(admit(first),"200 OK"));
    assert(strstr(admit(first),"200 OK"));
    assert(g_steer.count == 1 && g_steer.inputs[0].state == 0);
    assert(g_alen == 0); /* HTTP admission never mutates the worker transcript. */
    assert(strstr(admit("{\"expectedTurnId\":\"40\",\"inputId\":\"stale\",\"text\":\"wrong turn\"}"),"409 Conflict"));
    assert(strstr(admit("{\"expectedTurnId\":41,\"inputId\":\"typed\",\"text\":\"wrong type\"}"),"400 Bad Request"));
    assert(!strcmp(boundary('N'),"41:Use blue, not red|"));
    assert(g_steer.inputs[0].state == 2 && g_active_turn_task == 41 && g_child == child && g_agent_working);
    const char *receipt = "\x1e{\"type\":\"steering_applied\",\"turnId\":\"41\",\"inputId\":\"first\"}\n";
    assert(strstr(g_abuf,receipt));
    assert(strstr(admit(first),"200 OK"));
    assert(!strcmp(boundary('N'),"41:Use blue, not red|")); /* No duplicate append. */
    assert(!strstr(strstr(g_abuf,receipt)+strlen(receipt),receipt));
    for (int i = 0; i < 16; i++) {
        char body[256]; snprintf(body,sizeof body,"{\"expectedTurnId\":\"41\",\"inputId\":\"input-%d\",\"text\":\"context-%d\"}",i,i);
        assert(strstr(admit(body),"200 OK"));
    }
    assert(strstr(admit("{\"expectedTurnId\":\"41\",\"inputId\":\"overflow\",\"text\":\"no\"}"),"429 Too Many Requests"));
    assert(strstr(boundary('F'),"context-0|context-1|context-2|"));
    assert(g_steer.open); /* Finishing with pending input resumes SAME turn. */
    boundary('F'); assert(!g_steer.open);
    assert(strstr(admit("{\"expectedTurnId\":\"41\",\"inputId\":\"late\",\"text\":\"do not start another turn\"}"),"409 Conflict"));
    g_active_turn_task = 42; boundary('B');
    assert(g_steer.count == 0 && g_steer.open);
    g_interrupt_pending = 1;
    assert(strstr(admit("{\"expectedTurnId\":\"42\",\"inputId\":\"cancelled\",\"text\":\"no\"}"),"409 Conflict"));
    assert(write(commands[1],"X",1) == 1);
    int status; assert(waitpid(child,&status,0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 0);
    g_child = -1; steer_prepare(); free(g_abuf); close(g_srv_fd);
    puts("steering_transport_test: PASS — FIFO, owner append/ACK, duplicate/stale/type/bounds rejection, seal race, cancellation; inference simulated");
}
