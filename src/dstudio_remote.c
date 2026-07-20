/* ============================================================================
 * Remote model transport + remote page + LAN path gating.
 *
 * When a LAN client (or the /remote page) drives a conversation, its model
 * requests are relayed from here to the configured remote/LAN model host,
 * and the exposed /remote and /loading pages are served. Also holds the
 * loopback/LAN path allow-list (client_is_loopback, lan_public_path_allowed)
 * that gates which endpoints non-host clients may reach.
 *
 * Extracted from dstudio.c into a per-domain file (one translation unit, all
 * static; same pattern as the GSA/RSA .cfrag includes).
 * ==========================================================================*/

static char *json_get_string_alloc(const char *body, const char *key) {
    char pat[96];
    snprintf(pat, sizeof pat, "\"%s\"", key);
    const char *p = strstr(body, pat);
    if (!p) return NULL;
    p += strlen(pat);
    while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r') p++;
    if (*p != ':') return NULL;
    p++;
    while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r') p++;
    if (*p != '"') return NULL;
    p++;
    json_dyn_buf b = {0};
    while (*p && *p != '"') {
        char c = *p++;
        if (c == '\\' && *p) {
            char e = *p++;
            switch (e) {
                case 'n': c = '\n'; break;
                case 't': c = '\t'; break;
                case 'r': c = '\r'; break;
                case '"': c = '"';  break;
                case '\\': c = '\\'; break;
                case '/': c = '/';  break;
                case 'u': {
                    if (p[0] && p[1] && p[2] && p[3]) {
                        char hx[5] = { p[0], p[1], p[2], p[3], 0 };
                        long v = strtol(hx, NULL, 16);
                        p += 4;
                        if (v < 0x80) c = (char)v;
                        else c = '?';
                    } else c = '?';
                    break;
                }
                default: c = e; break;
            }
        }
        if (!json_dyn_putn(&b, &c, 1)) { free(b.ptr); return NULL; }
    }
    return b.ptr ? b.ptr : ds4_strdup_local("");
}

static int remote_json_ok(const char *body, size_t len) {
    size_t i = 0;
    while (i < len && isspace((unsigned char)body[i])) i++;
    return i < len && body[i] == '{';
}

static const char *json_value_end_ptr(const char *p) {
    p += strspn(p, " \t\r\n");
    if (*p == '"') {
        for (p++; *p; p++) {
            if (*p == '\\' && p[1]) { p++; continue; }
            if (*p == '"') return p + 1;
        }
        return NULL;
    }
    if (*p == '{' || *p == '[') {
        char open = *p, close = open == '{' ? '}' : ']';
        int depth = 0, in_str = 0, esc = 0;
        for (; *p; p++) {
            if (in_str) {
                if (esc) esc = 0;
                else if (*p == '\\') esc = 1;
                else if (*p == '"') in_str = 0;
                continue;
            }
            if (*p == '"') in_str = 1;
            else if (*p == open) depth++;
            else if (*p == close && --depth == 0) return p + 1;
        }
        return NULL;
    }
    const char *s = p;
    while (*p && *p != ',' && *p != '}' && *p != ']' &&
           !isspace((unsigned char)*p)) p++;
    return p > s ? p : NULL;
}

static char *json_top_value_dup(const char *json, const char *key, char required_first) {
    const char *p = json;
    if (!p) return NULL;
    p += strspn(p, " \t\r\n");
    if (*p++ != '{') return NULL;
    size_t key_len = strlen(key);
    while (*p) {
        p += strspn(p, " \t\r\n");
        if (*p == '}') return NULL;
        if (*p != '"') return NULL;
        const char *ks = ++p;
        while (*p && !(*p == '"' && p[-1] != '\\')) p++;
        if (!*p) return NULL;
        size_t kl = (size_t)(p - ks);
        p++;
        p += strspn(p, " \t\r\n");
        if (*p++ != ':') return NULL;
        p += strspn(p, " \t\r\n");
        const char *vs = p;
        const char *ve = json_value_end_ptr(vs);
        if (!ve) return NULL;
        if (kl == key_len && !strncmp(ks, key, key_len) &&
            (!required_first || *vs == required_first)) {
            return ds4_strndup_local(vs, (size_t)(ve - vs));
        }
        p = ve;
        p += strspn(p, " \t\r\n");
        if (*p == ',') { p++; continue; }
        if (*p == '}') return NULL;
    }
    return NULL;
}

static void remote_ensure_empty_chat(void) {
    if (g_remote_chat) return;
    const char *empty = "{\"id\":\"remote\",\"title\":\"Remote\",\"model\":\"\",\"settings\":{},\"messages\":[]}";
    g_remote_chat = ds4_strdup_local(empty);
    if (g_remote_chat) g_remote_chat_len = strlen(empty);
}

static char *remote_messages_only_update(char *body) {
    remote_ensure_empty_chat();
    char *messages = json_top_value_dup(body, "messages", '[');
    if (!messages) return NULL;
    char *id = json_top_value_dup(g_remote_chat, "id", '"');
    char *title = json_top_value_dup(g_remote_chat, "title", '"');
    char *model = json_top_value_dup(g_remote_chat, "model", '"');
    char *settings = json_top_value_dup(g_remote_chat, "settings", '{');
    if (!id) id = strdup("\"remote\"");
    if (!title) title = strdup("\"Remote\"");
    if (!model) model = strdup("\"\"");
    if (!settings) settings = strdup("{}");
    json_dyn_buf out = {0};
    int ok = id && title && model && settings &&
             json_dyn_puts(&out, "{\"id\":") &&
             json_dyn_puts(&out, id) &&
             json_dyn_puts(&out, ",\"title\":") &&
             json_dyn_puts(&out, title) &&
             json_dyn_puts(&out, ",\"model\":") &&
             json_dyn_puts(&out, model) &&
             json_dyn_puts(&out, ",\"settings\":") &&
             json_dyn_puts(&out, settings) &&
             json_dyn_puts(&out, ",\"messages\":") &&
             json_dyn_puts(&out, messages) &&
             json_dyn_puts(&out, "}");
    free(id); free(title); free(model); free(settings); free(messages);
    if (!ok) { free(out.ptr); return NULL; }
    free(body);
    return out.ptr;
}

static void remote_addr_url(char *addr, size_t addrsz, char *url, size_t urlsz) {
    int on = lan_status(addr, addrsz);
    if (on && addr[0]) snprintf(url, urlsz, "http://%s/remote", addr);
    else url[0] = '\0';
}

static void api_remote_status(int fd) {
    char addr[80], url[128];
    remote_addr_url(addr, sizeof addr, url, sizeof url);
    json_dyn_buf out = {0};
    if (!json_dyn_puts(&out, "{\"ok\":true,\"enabled\":") ||
        !json_dyn_puts(&out, g_remote_enabled ? "true" : "false") ||
        !json_dyn_printf(&out, ",\"rev\":%ld,\"lan\":", g_remote_rev) ||
        !json_dyn_puts(&out, strcmp(g_bind_host, "127.0.0.1") ? "true" : "false") ||
        !json_dyn_puts(&out, ",\"lanAddr\":") ||
        !json_dyn_put_escaped(&out, addr) ||
        !json_dyn_puts(&out, ",\"url\":") ||
        !json_dyn_put_escaped(&out, url) ||
        !json_dyn_puts(&out, "}")) {
        free(out.ptr);
        send_json(fd, "500 Internal Server Error", "{\"ok\":false}");
        return;
    }
    send_json(fd, "200 OK", out.ptr);
    free(out.ptr);
}

static void api_remote_control(int fd, const char *body) {
    int enable = json_get_bool(body, "enable");
    if (enable) {
        if (!rebind_http_listener("0.0.0.0")) {
            send_json(fd, "500 Internal Server Error", "{\"ok\":false,\"error\":\"could not rebind the listener\"}");
            return;
        }
        remote_ensure_empty_chat();
        g_remote_enabled = 1;
        g_remote_rev++;
        char ip[INET_ADDRSTRLEN] = "";
        lan_ip(ip, sizeof ip);
        printf("\n  !  REMOTE CHAT ENABLED (%s:%d/remote): shared chat is available at /remote.\n\n",
               ip[0] ? ip : "0.0.0.0", g_http_port);
    } else {
        g_remote_enabled = 0;
        g_remote_rev++;
        printf("DStudio: remote chat disabled.\n");
    }
    api_remote_status(fd);
}

static void api_remote_chat_get(int fd) {
    char addr[80], url[128];
    remote_addr_url(addr, sizeof addr, url, sizeof url);
    json_dyn_buf out = {0};
    int ok = json_dyn_puts(&out, "{\"ok\":true,\"enabled\":") &&
             json_dyn_puts(&out, g_remote_enabled ? "true" : "false") &&
             json_dyn_printf(&out, ",\"rev\":%ld,\"url\":", g_remote_rev) &&
             json_dyn_put_escaped(&out, url) &&
             json_dyn_puts(&out, ",\"chat\":");
    if (ok && g_remote_chat && g_remote_chat_len) ok = json_dyn_putn(&out, g_remote_chat, g_remote_chat_len);
    else if (ok) ok = json_dyn_puts(&out, "null");
    if (ok) ok = json_dyn_puts(&out, "}");
    if (!ok) {
        free(out.ptr);
        send_json(fd, "500 Internal Server Error", "{\"ok\":false}");
        return;
    }
    send_json(fd, "200 OK", out.ptr);
    free(out.ptr);
}

static void api_remote_chat_set(int fd, char *body, size_t len, int local_client) {
    if (!g_remote_enabled) {
        free(body);
        send_json(fd, "409 Conflict", "{\"ok\":false,\"error\":\"remote chat is not enabled\"}");
        return;
    }
    if (!remote_json_ok(body, len)) {
        free(body);
        send_json(fd, "400 Bad Request", "{\"ok\":false,\"error\":\"remote chat must be a JSON object\"}");
        return;
    }
    if (!local_client) {
        char *merged = remote_messages_only_update(body);
        if (!merged) {
            free(body);
            send_json(fd, "400 Bad Request", "{\"ok\":false,\"error\":\"remote clients can only update messages\"}");
            return;
        }
        body = merged;
        len = strlen(body);
    }
    free(g_remote_chat);
    g_remote_chat = body;
    g_remote_chat_len = len;
    g_remote_rev++;
    char out[64];
    snprintf(out, sizeof out, "{\"ok\":true,\"rev\":%ld}", g_remote_rev);
    send_json(fd, "200 OK", out);
}

static const char REMOTE_PAGE[] =
"<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
"<title>DStudio Remote</title><style>"
":root{color-scheme:dark;--bg:#070809;--panel:#111317;--line:#2b3038;--text:#f4f5f7;--muted:#969ca6;--accent:#8fb7ff}"
"*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif}"
".app{min-height:100vh;display:flex;flex-direction:column}.top{height:58px;display:flex;align-items:center;gap:12px;padding:0 18px;border-bottom:1px solid var(--line);background:#0b0c0f}"
".mark{width:24px;height:24px;border-radius:50%;display:inline-block;background:radial-gradient(circle at 50% 50%,#dbe8ff 0 14%,transparent 15%),conic-gradient(from 20deg,var(--accent) 0 14%,transparent 14% 25%,var(--accent) 25% 39%,transparent 39% 50%,var(--accent) 50% 64%,transparent 64% 75%,var(--accent) 75% 89%,transparent 89%)}"
".brand{font-weight:650}.tag{font-size:12px;color:var(--accent);border:1px solid #315386;border-radius:999px;padding:2px 8px}.status{margin-left:auto;color:var(--muted);font-size:13px}"
".messages{flex:1;overflow:auto;padding:28px 16px 120px}.empty{max-width:760px;margin:20vh auto 0;color:var(--muted);text-align:center}"
".msg{max-width:920px;margin:0 auto 24px}.msg.user{display:flex;flex-direction:column;align-items:flex-end}.start{display:flex;align-items:center;gap:8px;color:var(--muted);font:12px ui-monospace,monospace;margin-bottom:7px}.msg.user .start{justify-content:flex-end}"
".bubble{white-space:pre-wrap;overflow-wrap:anywhere}.msg.user .bubble{max-width:min(760px,88vw);background:#233044;border-radius:18px;padding:12px 16px}.msg.assistant .bubble{font-size:17px;color:#f0f1f4}"
".composer{position:fixed;left:0;right:0;bottom:0;padding:14px 16px 18px;background:linear-gradient(180deg,rgba(7,8,9,0),#070809 22%)}"
".bar{max-width:920px;margin:auto;display:flex;align-items:flex-end;gap:10px;border:1px solid var(--line);border-radius:18px;padding:8px;background:#090a0c}"
"textarea{flex:1;min-height:42px;max-height:160px;resize:none;background:transparent;border:0;color:var(--text);font:inherit;outline:0;padding:8px}button{width:42px;height:42px;border:0;border-radius:13px;background:var(--accent);color:#07101e;font-size:20px;font-weight:700;cursor:pointer}button:disabled{opacity:.45;cursor:not-allowed}"
".settings-btn{width:auto;height:34px;border:1px solid var(--line);border-radius:10px;background:#151922;color:var(--text);font-size:13px;font-weight:600;padding:0 12px}.modal[hidden]{display:none}.modal{position:fixed;inset:0;background:rgba(0,0,0,.62);display:grid;place-items:center;padding:20px;z-index:20}.modal-card{width:min(92vw,430px);background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:18px;box-shadow:0 24px 80px rgba(0,0,0,.55)}.modal-card h2{font-size:18px;margin:0 0 6px}.modal-card p{margin:0 0 14px;color:var(--muted);font-size:13px}.modal-row{display:flex;gap:8px}.modal-row input{flex:1;min-width:0;background:#08090b;border:1px solid var(--line);border-radius:10px;color:var(--text);font:14px ui-monospace,monospace;padding:10px}.modal-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}.modal-actions button,.modal-row button{width:auto;height:38px;font-size:13px;border-radius:10px;padding:0 12px}.btn-plain{background:#171a20!important;color:var(--text)!important}.btn-danger{background:#3a1720!important;color:#ffdce5!important}.lan-msg{min-height:18px;margin-top:8px;color:#ff9d91;font-size:12px}"
"</style></head><body><div class=\"app\"><header class=\"top\"><span class=\"mark\"></span><span class=\"brand\">DStudio</span><span class=\"tag\">Remote</span><span id=\"status\" class=\"status\">Connecting...</span><button id=\"settings\" type=\"button\" class=\"settings-btn\">Settings</button></header><main id=\"messages\" class=\"messages\"></main><div id=\"modal\" class=\"modal\" hidden><div class=\"modal-card\"><h2>LAN connection</h2><p>This Remote client cannot change the host model or host settings. It can only switch LAN address or switch this device to host mode.</p><label><p>LAN address</p><div class=\"modal-row\"><input id=\"lanaddr\" type=\"text\" spellcheck=\"false\" placeholder=\"192.168.1.207:5500\"><button id=\"lanconnect\" type=\"button\">Connect</button></div></label><div id=\"lanmsg\" class=\"lan-msg\"></div><div class=\"modal-actions\"><button id=\"lanexit\" type=\"button\" class=\"btn-danger\">Switch to host</button><button id=\"modalclose\" type=\"button\" class=\"btn-plain\">Close</button></div></div></div><form id=\"form\" class=\"composer\"><div class=\"bar\"><textarea id=\"input\" placeholder=\"Write a message...\" rows=\"1\"></textarea><button id=\"send\" type=\"submit\">&#8593;</button></div></form></div>"
"<script>"
"const $=s=>document.querySelector(s);let chat=null,rev=-1,busy=false,saveTimer=null;"
"const uid=()=>crypto.randomUUID?crypto.randomUUID():('m_'+Date.now().toString(36)+Math.random().toString(36).slice(2));"
"function setStatus(t){$('#status').textContent=t||''}"
"function remoteUrl(raw){let v=String(raw||'').trim();if(!v)throw new Error('Insert the LAN address.');if(!/^https?:\\/\\//i.test(v))v='http://'+v;let u;try{u=new URL(v)}catch{throw new Error('Use an address like 192.168.1.207:5500.')}if(!u.hostname)throw new Error('Use an address like 192.168.1.207:5500.');if(!u.port)u.port='5500';u.pathname='/remote';u.search='';u.hash='';return u.toString()}"
"function openSettings(){ $('#lanaddr').value=location.host||''; $('#lanmsg').textContent=''; $('#modal').hidden=false }"
"function closeSettings(){ $('#modal').hidden=true }"
"function connectLan(){try{location.href=remoteUrl($('#lanaddr').value)}catch(e){$('#lanmsg').textContent=e.message||'Invalid LAN address.'}}"
"function exitLan(){location.href='http://127.0.0.1:'+((location&&location.port)||'5500')+'/loading.html'}"
"function start(role){const d=document.createElement('div');d.className='start';d.innerHTML='<span class=\"mark\"></span><span>'+(role==='user'?'You':'DStudio')+'</span>';return d}"
"function render(){const box=$('#messages');box.innerHTML='';if(!chat){const p=document.createElement('p');p.className='empty';p.textContent='Remote chat is not active. Run /remote on the host.';box.append(p);return}for(const m of chat.messages||[]){if(m.role!=='user'&&m.role!=='assistant')continue;const a=document.createElement('article');a.className='msg '+(m.role==='user'?'user':'assistant');const b=document.createElement('div');b.className='bubble';b.textContent=m.content||'';a.append(start(m.role),b);box.append(a)}box.scrollTop=box.scrollHeight}"
"async function load(){try{const j=await (await fetch('/api/remote/chat',{cache:'no-store'})).json();if(!j.enabled){chat=null;rev=j.rev;setStatus('Waiting for /remote');render();return}if(j.rev!==rev){chat=j.chat||{title:'Remote',settings:{},messages:[]};rev=j.rev;setStatus(chat.title||'Remote');render()}}catch(e){setStatus('Disconnected')}}"
"async function save(){if(!chat)return;const j=await (await fetch('/api/remote/chat',{method:'POST',headers:{'X-Requested-With':'ds4web','Content-Type':'application/json'},body:JSON.stringify(chat)})).json();if(typeof j.rev==='number')rev=j.rev}"
"function queueSave(){clearTimeout(saveTimer);saveTimer=setTimeout(()=>save().catch(()=>{}),600)}"
"function sse(block,a){for(const line of block.split('\\n')){if(!line.startsWith('data:'))continue;const data=line.slice(5).trim();if(!data||data==='[DONE]')continue;try{const j=JSON.parse(data);const d=(j.choices&&j.choices[0]&&j.choices[0].delta)||{};const t=d.content||d.reasoning_content||d.reasoning||'';if(t){a.content+=t;render();queueSave()}}catch{}}}"
"async function stream(res,a){const reader=res.body.getReader();const dec=new TextDecoder();let buf='';for(;;){const x=await reader.read();if(x.done)break;buf+=dec.decode(x.value,{stream:true});const parts=buf.split('\\n\\n');buf=parts.pop()||'';for(const p of parts)sse(p,a)}if(buf)sse(buf,a)}"
"async function send(text){if(!chat||busy||!text.trim())return;busy=true;$('#send').disabled=true;chat.messages=chat.messages||[];chat.messages.push({id:uid(),role:'user',content:text.trim(),createdAt:Date.now()});const a={id:uid(),role:'assistant',content:'',createdAt:Date.now(),streaming:true};chat.messages.push(a);render();await save().catch(()=>{});try{const msgs=[];const sys=chat.settings&&chat.settings.systemPrompt;if(sys)msgs.push({role:'system',content:sys});for(const m of chat.messages){if(m.role==='user'||(m.role==='assistant'&&m.content&&!m.streaming))msgs.push({role:m.role,content:m.content})}const body={model:chat.model||'ds4',messages:msgs,stream:true,temperature:(chat.settings&&chat.settings.temperature)||0.6};if(chat.settings&&chat.settings.maxTokens)body.max_tokens=chat.settings.maxTokens;const res=await fetch('/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});if(!res.ok)throw new Error('HTTP '+res.status);await stream(res,a)}catch(e){a.content+=(a.content?'\\n\\n':'')+'[Remote error: '+(e.message||e)+']'}finally{delete a.streaming;busy=false;$('#send').disabled=false;await save().catch(()=>{});render()}}"
"$('#form').addEventListener('submit',e=>{e.preventDefault();const i=$('#input');const t=i.value;i.value='';send(t)});$('#input').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();$('#form').requestSubmit()}});"
"$('#settings').addEventListener('click',openSettings);$('#modalclose').addEventListener('click',closeSettings);$('#modal').addEventListener('click',e=>{if(e.target.id==='modal')closeSettings()});$('#lanconnect').addEventListener('click',connectLan);$('#lanaddr').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();connectLan()}});$('#lanexit').addEventListener('click',exitLan);"
"load();setInterval(()=>{if(!busy)load()},1500);"
"</script></body></html>";

static void serve_remote_page(int fd, int head_only) {
    send_response(fd, "200 OK", "text/html; charset=utf-8", REMOTE_PAGE, strlen(REMOTE_PAGE), head_only);
}

static int client_is_loopback(int fd) {
    struct sockaddr_storage ss;
#ifdef _WIN32
    int slen = (int)sizeof ss;
#else
    socklen_t slen = sizeof ss;
#endif
    if (getpeername(fd, (struct sockaddr *)&ss, &slen) != 0) return 0;
    if (ss.ss_family == AF_INET) {
        struct sockaddr_in *sin = (struct sockaddr_in *)&ss;
        uint32_t ip = ntohl(sin->sin_addr.s_addr);
        return (ip >> 24) == 127;
    }
#ifdef AF_INET6
    if (ss.ss_family == AF_INET6) {
        struct sockaddr_in6 *sin6 = (struct sockaddr_in6 *)&ss;
        return IN6_IS_ADDR_LOOPBACK(&sin6->sin6_addr);
    }
#endif
    return 0;
}
static int path_eq_clean(const char *path, const char *want) {
    size_t n = strcspn(path, "?");
    return strlen(want) == n && !strncmp(path, want, n);
}

static int lan_root_path(const char *path) {
    return path_eq_clean(path, "/") || path_eq_clean(path, "/index.html");
}

static int loading_page_path(const char *path) {
    return path_eq_clean(path, "/loading.html");
}

static int remote_page_path(const char *path) {
    return path_eq_clean(path, "/remote") || path_eq_clean(path, "/remote/") ||
           path_eq_clean(path, "/remote/index.html");
}

static int lan_web_tool_path(const char *path) {
    return path_eq_clean(path, "/api/web-search") ||
           path_eq_clean(path, "/api/web-read") ||
           path_eq_clean(path, "/api/http-probe");
}

static int lan_public_path_allowed(const char *method, const char *path) {
    int get = !strcmp(method, "GET") || !strcmp(method, "HEAD");
    int lan_on = strcmp(g_bind_host, "127.0.0.1") != 0;
    if (!strcmp(method, "OPTIONS") &&
        (!strncmp(path, "/v1/", 4) || path_eq_clean(path, "/api/lan-client/chats") ||
         path_eq_clean(path, "/api/lan-health") || (lan_on && lan_web_tool_path(path)) ||
         (lan_on && (path_eq_clean(path, "/api/vision/describe") ||
                     path_eq_clean(path, "/api/image/generate") ||
                     path_eq_clean(path, "/api/pdf/thumb") || path_eq_clean(path, "/api/pdf/describe"))))) return 1;
    if (get && (remote_page_path(path) || lan_root_path(path))) return 1;
    if (get && (path_eq_clean(path, "/api/remote/status") || path_eq_clean(path, "/api/remote/chat"))) return 1;
    if (get && path_eq_clean(path, "/api/lan-health")) return 1;
    if (!strcmp(method, "POST") && path_eq_clean(path, "/api/remote/chat")) return 1;
    if (!strcmp(method, "POST") && path_eq_clean(path, "/api/lan-client/chats")) return 1;
    if (lan_on && !strcmp(method, "POST") && lan_web_tool_path(path)) return 1;
    /* Image describe for LAN clients (inline data only: the handler rejects
     * `path` sources from non-loopback peers). Setup/stop/status stay host-local. */
    if (lan_on && !strcmp(method, "POST") && path_eq_clean(path, "/api/vision/describe")) return 1;
    if (lan_on && !strcmp(method, "POST") && path_eq_clean(path, "/api/image/generate")) return 1;
    if (lan_on && get && path_eq_clean(path, "/api/image/file")) return 1;
    /* PDF preview/read for LAN clients (inline data only, same guard). */
    if (lan_on && !strcmp(method, "POST") &&
        (path_eq_clean(path, "/api/pdf/thumb") || path_eq_clean(path, "/api/pdf/describe"))) return 1;
    if (lan_on && !strncmp(path, "/v1/", 4)) return 1;
    return 0;
}
