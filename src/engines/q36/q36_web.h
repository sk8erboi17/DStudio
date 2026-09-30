#ifndef Q36_WEB_H
#define Q36_WEB_H

#include <stddef.h>
#include <stdbool.h>

typedef int (*q36_web_confirm_fn)(void *privdata, const char *message,
                                  char *err, size_t err_len);
typedef void (*q36_web_log_fn)(void *privdata, const char *message);
typedef bool (*q36_web_cancel_fn)(void *privdata);

typedef struct {
    const char *home_dir;
    int port;
    q36_web_confirm_fn confirm;
    void *confirm_privdata;
    q36_web_log_fn log;
    void *log_privdata;
    q36_web_cancel_fn cancel;
    void *cancel_privdata;
} q36_web_config;

typedef struct q36_web q36_web;

q36_web *q36_web_create(const q36_web_config *cfg);
void q36_web_free(q36_web *web);

char *q36_web_google_search(q36_web *web, const char *query,
                            char *err, size_t err_len);
char *q36_web_visit_page(q36_web *web, const char *url,
                         char *err, size_t err_len);

#endif
