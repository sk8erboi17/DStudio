/* webview.h — minimal cross-platform native webview.
 *
 *   macOS : WKWebView + Cocoa (WebKit.framework, zero install)
 *   Linux : WebKitGTK + GTK3 (webkit2gtk-4.1)
 *
 * API surface reduced to what DStudio needs: create a window, set its
 * title/size, navigate to a URL, run the loop. On macOS it must be compiled
 * as Objective-C++ (clang++ -x objective-c++).
 *
 * NOTE: WKWebView does NOT implement window.alert/confirm/prompt by itself —
 * without a WKUIDelegate confirm() silently returns false (e.g. the sidebar
 * delete button would never delete). DS4UIDelegate maps them to NSAlert.
 * WebKitGTK handles script dialogs natively, nothing to do there.
 */
#ifndef DS4_WEBVIEW_H
#define DS4_WEBVIEW_H

#include <stdlib.h>
#include <string.h>

typedef void *webview_t;

static webview_t webview_create(int width, int height, const char *title);
static void      webview_navigate(webview_t w, const char *url);
static void      webview_run(webview_t w);

#define DS4_DIRECTORY_PICKER_SCRIPT \
"(() => {" \
"  if (window.ds4PickDirectory) return;" \
"  let seq = 1;" \
"  const pending = new Map();" \
"  window.__ds4NativeDirectoryPicked = (id, path) => {" \
"    const key = String(id);" \
"    const resolve = pending.get(key);" \
"    if (!resolve) return;" \
"    pending.delete(key);" \
"    resolve(path || '');" \
"  };" \
"  window.ds4PickDirectory = () => new Promise((resolve) => {" \
"    const id = String(seq++);" \
"    pending.set(id, resolve);" \
"    try {" \
"      window.webkit.messageHandlers.ds4PickDirectory.postMessage(id);" \
"    } catch (e) {" \
"      pending.delete(id);" \
"      resolve('');" \
"    }" \
"  });" \
"})();"

/* ============================ macOS ============================ */
#ifdef __APPLE__
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

/* Quit the app when the window is closed. */
@interface DS4WindowDelegate : NSObject <NSWindowDelegate>
@end
@implementation DS4WindowDelegate
- (void)windowWillClose:(NSNotification *)note { (void)note; [NSApp terminate:nil]; }
@end

/* JS dialogs (alert/confirm/prompt) → native NSAlert panels. */
@interface DS4UIDelegate : NSObject <WKUIDelegate>
@end
@implementation DS4UIDelegate
- (void)webView:(WKWebView *)webView
    runJavaScriptAlertPanelWithMessage:(NSString *)message
                      initiatedByFrame:(WKFrameInfo *)frame
                     completionHandler:(void (^)(void))completionHandler {
    (void)webView; (void)frame;
    NSAlert *a = [[NSAlert alloc] init];
    a.messageText = message;
    [a addButtonWithTitle:@"OK"];
    [a runModal];
    completionHandler();
}
- (void)webView:(WKWebView *)webView
    runJavaScriptConfirmPanelWithMessage:(NSString *)message
                        initiatedByFrame:(WKFrameInfo *)frame
                       completionHandler:(void (^)(BOOL))completionHandler {
    (void)webView; (void)frame;
    NSAlert *a = [[NSAlert alloc] init];
    a.messageText = message;
    [a addButtonWithTitle:@"OK"];
    [a addButtonWithTitle:@"Cancel"];
    completionHandler([a runModal] == NSAlertFirstButtonReturn);
}
- (void)webView:(WKWebView *)webView
    runJavaScriptTextInputPanelWithPrompt:(NSString *)prompt
                              defaultText:(NSString *)defaultText
                         initiatedByFrame:(WKFrameInfo *)frame
                        completionHandler:(void (^)(NSString *))completionHandler {
    (void)webView; (void)frame;
    NSAlert *a = [[NSAlert alloc] init];
    a.messageText = prompt;
    [a addButtonWithTitle:@"OK"];
    [a addButtonWithTitle:@"Cancel"];
    NSTextField *tf = [[NSTextField alloc] initWithFrame:NSMakeRect(0, 0, 260, 24)];
    tf.stringValue = defaultText ? defaultText : @"";
    a.accessoryView = tf;
    completionHandler([a runModal] == NSAlertFirstButtonReturn ? tf.stringValue : nil);
}
- (void)webView:(WKWebView *)webView
    runOpenPanelWithParameters:(WKOpenPanelParameters *)parameters
              initiatedByFrame:(WKFrameInfo *)frame
             completionHandler:(void (^)(NSArray<NSURL *> *URLs))completionHandler {
    (void)frame;
    NSOpenPanel *panel = [NSOpenPanel openPanel];
    panel.canChooseFiles = YES;
    panel.canChooseDirectories = NO;
    panel.allowsMultipleSelection = parameters.allowsMultipleSelection;
    panel.canCreateDirectories = NO;
    panel.prompt = @"Attach";
    panel.message = @"Choose file(s) to attach to the chat.";
    void (^finish)(NSModalResponse) = ^(NSModalResponse r) {
        completionHandler(r == NSModalResponseOK ? panel.URLs : nil);
    };
    NSWindow *win = webView.window;
    if (win) [panel beginSheetModalForWindow:win completionHandler:finish];
    else [panel beginWithCompletionHandler:finish];
}
@end

/* Downloads (<a download> on blob: URLs — the design Export): WKWebView does
 * NOTHING with them unless a navigation delegate turns the navigation into a
 * WKDownload (macOS 11.3+). The destination goes through an NSSavePanel, so
 * the user picks where to save. */
@interface DS4NavDelegate : NSObject <WKNavigationDelegate, WKDownloadDelegate>
@end
@implementation DS4NavDelegate
- (void)webView:(WKWebView *)webView
    decidePolicyForNavigationAction:(WKNavigationAction *)action
                    decisionHandler:(void (^)(WKNavigationActionPolicy))handler {
    (void)webView;
    if (action.shouldPerformDownload) handler(WKNavigationActionPolicyDownload);
    else handler(WKNavigationActionPolicyAllow);
}
- (void)webView:(WKWebView *)webView
    decidePolicyForNavigationResponse:(WKNavigationResponse *)response
                      decisionHandler:(void (^)(WKNavigationResponsePolicy))handler {
    (void)webView;
    if (!response.canShowMIMEType) handler(WKNavigationResponsePolicyDownload);
    else handler(WKNavigationResponsePolicyAllow);
}
- (void)webView:(WKWebView *)webView navigationAction:(WKNavigationAction *)action
    didBecomeDownload:(WKDownload *)download {
    (void)webView; (void)action;
    download.delegate = self;
}
- (void)webView:(WKWebView *)webView navigationResponse:(WKNavigationResponse *)response
    didBecomeDownload:(WKDownload *)download {
    (void)webView; (void)response;
    download.delegate = self;
}
- (void)download:(WKDownload *)download
    decideDestinationUsingResponse:(NSURLResponse *)response
                 suggestedFilename:(NSString *)suggestedFilename
                 completionHandler:(void (^)(NSURL *))completionHandler {
    (void)response;
    NSSavePanel *panel = [NSSavePanel savePanel];
    panel.nameFieldStringValue = suggestedFilename;
    panel.canCreateDirectories = YES;
    void (^finish)(NSModalResponse) = ^(NSModalResponse r) {
        if (r == NSModalResponseOK && panel.URL) {
            /* WKDownload refuses an existing destination: replace silently
             * (the save panel already asked the user about overwriting). */
            [[NSFileManager defaultManager] removeItemAtURL:panel.URL error:nil];
            completionHandler(panel.URL);
        } else {
            completionHandler(nil);
        }
    };
    NSWindow *win = download.webView.window;
    if (win) [panel beginSheetModalForWindow:win completionHandler:finish];
    else [panel beginWithCompletionHandler:finish];
}
@end

/* Theme bridge: the page posts "light"/"dark" (window.webkit.messageHandlers
 * .ds4Theme) when the theme changes in Settings, and the title bar recolours
 * to match — light page → light chrome, dark page → dark chrome. */
@interface DS4ThemeHandler : NSObject <WKScriptMessageHandler>
@property (assign) NSWindow *win;
@end
@implementation DS4ThemeHandler
- (void)userContentController:(WKUserContentController *)ucc
      didReceiveScriptMessage:(WKScriptMessage *)message {
    (void)ucc;
    if (!self.win) return;
    BOOL light = [message.body isKindOfClass:[NSString class]] &&
                 [(NSString *)message.body isEqualToString:@"light"];
    self.win.appearance = [NSAppearance appearanceNamed:
        light ? NSAppearanceNameAqua : NSAppearanceNameDarkAqua];
    self.win.backgroundColor = light
        ? [NSColor colorWithSRGBRed:0.961 green:0.961 blue:0.965 alpha:1.0]  /* #f5f5f6 */
        : [NSColor colorWithSRGBRed:0.086 green:0.086 blue:0.086 alpha:1.0]; /* #161616 */
}
@end

static NSString *ds4_js_string(NSString *s) {
    if (!s) return @"null";
    NSData *data = [NSJSONSerialization dataWithJSONObject:@[s] options:0 error:nil];
    if (!data) return @"\"\"";
    NSString *arr = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    if (!arr || arr.length < 2) return @"\"\"";
    return [arr substringWithRange:NSMakeRange(1, arr.length - 2)];
}

/* Native folder picker bridge for Agent/Design workspaces. Browser directory
 * pickers do not expose absolute filesystem paths; the native shell can. */
@interface DS4DirectoryPickerHandler : NSObject <WKScriptMessageHandler>
@property (assign) NSWindow *win;
@property (assign) WKWebView *webview;
@end
@implementation DS4DirectoryPickerHandler
- (void)resolveRequest:(NSString *)rid withPath:(NSString *)path {
    if (!self.webview || !rid) return;
    NSString *js = [NSString stringWithFormat:
        @"window.__ds4NativeDirectoryPicked&&window.__ds4NativeDirectoryPicked(%@,%@)",
        ds4_js_string(rid), path ? ds4_js_string(path) : @"null"];
    [self.webview evaluateJavaScript:js completionHandler:nil];
}
- (void)userContentController:(WKUserContentController *)ucc
      didReceiveScriptMessage:(WKScriptMessage *)message {
    (void)ucc;
    NSString *rid = [message.body isKindOfClass:[NSString class]] ? (NSString *)message.body : nil;
    if (!rid.length) return;
    NSOpenPanel *panel = [NSOpenPanel openPanel];
    panel.canChooseFiles = NO;
    panel.canChooseDirectories = YES;
    panel.allowsMultipleSelection = NO;
    panel.canCreateDirectories = YES;
    panel.prompt = @"Choose";
    panel.message = @"Choose a folder for DStudio.";
    void (^finish)(NSModalResponse) = ^(NSModalResponse r) {
        NSString *path = (r == NSModalResponseOK && panel.URL) ? panel.URL.path : nil;
        [self resolveRequest:rid withPath:path];
    };
    if (self.win) [panel beginSheetModalForWindow:self.win completionHandler:finish];
    else [panel beginWithCompletionHandler:finish];
}
@end

typedef struct {
    NSWindow *window;
    WKWebView *webview;
} ds4_wv;

/* Menu bar with the standard key equivalents. Without an Edit menu, Cocoa
 * gives WKWebView NO ⌘C/⌘V/⌘X/⌘A/⌘Z — key equivalents are routed through
 * the menu — and ⌘Q/⌘W/⌘M/⌘H would be dead too. App-specific shortcuts
 * (⌘N, ⌘1-3, ⌘,) are deliberately NOT claimed here: they reach the page,
 * which handles them in JS (cross-platform with Ctrl on Linux).
 */
static void ds4_build_menubar(const char *title) {
    NSString *name = [NSString stringWithUTF8String:title];
    NSMenu *bar = [[NSMenu alloc] init];
    [NSApp setMainMenu:bar];

    NSMenuItem *appItem = [bar addItemWithTitle:@"" action:nil keyEquivalent:@""];
    NSMenu *appMenu = [[NSMenu alloc] init];
    [appMenu addItemWithTitle:[@"Hide " stringByAppendingString:name]
                       action:@selector(hide:) keyEquivalent:@"h"];
    [appMenu addItem:[NSMenuItem separatorItem]];
    [appMenu addItemWithTitle:[@"Quit " stringByAppendingString:name]
                       action:@selector(terminate:) keyEquivalent:@"q"];
    [appItem setSubmenu:appMenu];

    NSMenuItem *editItem = [bar addItemWithTitle:@"Edit" action:nil keyEquivalent:@""];
    NSMenu *editMenu = [[NSMenu alloc] initWithTitle:@"Edit"];
    [editMenu addItemWithTitle:@"Undo" action:@selector(undo:) keyEquivalent:@"z"];
    [editMenu addItemWithTitle:@"Redo" action:@selector(redo:) keyEquivalent:@"Z"];
    [editMenu addItem:[NSMenuItem separatorItem]];
    [editMenu addItemWithTitle:@"Cut" action:@selector(cut:) keyEquivalent:@"x"];
    [editMenu addItemWithTitle:@"Copy" action:@selector(copy:) keyEquivalent:@"c"];
    [editMenu addItemWithTitle:@"Paste" action:@selector(paste:) keyEquivalent:@"v"];
    [editMenu addItemWithTitle:@"Select All" action:@selector(selectAll:) keyEquivalent:@"a"];
    [editItem setSubmenu:editMenu];

    NSMenuItem *winItem = [bar addItemWithTitle:@"Window" action:nil keyEquivalent:@""];
    NSMenu *winMenu = [[NSMenu alloc] initWithTitle:@"Window"];
    [winMenu addItemWithTitle:@"Minimize" action:@selector(performMiniaturize:) keyEquivalent:@"m"];
    [winMenu addItemWithTitle:@"Close" action:@selector(performClose:) keyEquivalent:@"w"];
    [winItem setSubmenu:winMenu];
    [NSApp setWindowsMenu:winMenu];
}

static webview_t webview_create(int width, int height, const char *title) {
    [NSApplication sharedApplication];
    /* Regular: Dock icon + menu bar like a real app. */
    [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
    ds4_build_menubar(title);

    ds4_wv *w = (ds4_wv *)calloc(1, sizeof(ds4_wv));
    NSRect frame = NSMakeRect(0, 0, width, height);
    NSUInteger style = NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                       NSWindowStyleMaskResizable | NSWindowStyleMaskMiniaturizable;
    NSWindow *win = [[NSWindow alloc] initWithContentRect:frame
                                               styleMask:style
                                                 backing:NSBackingStoreBuffered
                                                   defer:NO];
    [win setTitle:[NSString stringWithUTF8String:title]];
    [win setReleasedWhenClosed:NO];
    [win center];

    /* Title bar that matches the app's black theme instead of the default
     * light-gray macOS chrome: a transparent title bar over a dark window
     * background, forced dark appearance so the traffic lights and the strip
     * they sit in blend with the UI. The lights stay (kept on macOS); the
     * content sits just below, so window dragging still works natively.
     * The bar color is the app's --surface (#161616) — the exact color of
     * the sidebar and the header that sit directly under the bar, so they
     * read as one continuous surface. (The page body below is --bg #0a0a0a.) */
    NSColor *ink = [NSColor colorWithSRGBRed:0.086 green:0.086 blue:0.086 alpha:1.0]; /* #161616 */
    win.titleVisibility = NSWindowTitleHidden;
    win.titlebarAppearsTransparent = YES;
    win.appearance = [NSAppearance appearanceNamed:NSAppearanceNameDarkAqua];
    win.backgroundColor = ink;

    WKWebViewConfiguration *cfg = [[WKWebViewConfiguration alloc] init];
    /* let the page recolour the title bar when the theme changes */
    DS4ThemeHandler *themeHandler = [[DS4ThemeHandler alloc] init];
    themeHandler.win = win;
    [cfg.userContentController addScriptMessageHandler:themeHandler name:@"ds4Theme"];
    DS4DirectoryPickerHandler *dirHandler = [[DS4DirectoryPickerHandler alloc] init];
    dirHandler.win = win;
    [cfg.userContentController addScriptMessageHandler:dirHandler name:@"ds4PickDirectory"];
    WKUserScript *dirScript = [[WKUserScript alloc]
        initWithSource:[NSString stringWithUTF8String:DS4_DIRECTORY_PICKER_SCRIPT]
        injectionTime:WKUserScriptInjectionTimeAtDocumentStart
        forMainFrameOnly:YES];
    [cfg.userContentController addUserScript:dirScript];
    WKWebView *wv = [[WKWebView alloc] initWithFrame:frame configuration:cfg];
    dirHandler.webview = wv;
    [wv setAutoresizingMask:(NSViewWidthSizable | NSViewHeightSizable)];
    /* dark layer under the page: no white flash before the first paint */
    wv.wantsLayer = YES;
    wv.layer.backgroundColor = ink.CGColor;
    [wv setUIDelegate:[[DS4UIDelegate alloc] init]];
    /* no-ARC: alloc/init keeps the delegates alive (WKWebView holds them weakly) */
    [wv setNavigationDelegate:[[DS4NavDelegate alloc] init]];
    [win setContentView:wv];
    [win setDelegate:[[DS4WindowDelegate alloc] init]];

    w->window = win;
    w->webview = wv;
    return (webview_t)w;
}

static void webview_navigate(webview_t handle, const char *url) {
    ds4_wv *w = (ds4_wv *)handle;
    NSURL *u = [NSURL URLWithString:[NSString stringWithUTF8String:url]];
    [w->webview loadRequest:[NSURLRequest requestWithURL:u]];
}

static void webview_run(webview_t handle) {
    ds4_wv *w = (ds4_wv *)handle;
    [w->window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
    [NSApp run];
}

/* ============================ Linux ============================ */
#elif defined(__linux__)
#include <gtk/gtk.h>
#include <webkit2/webkit2.h>
#include <gdk-pixbuf/gdk-pixbuf.h>
#include "logo_data.h"   /* generated: the logo PNG bytes (LOGO_PNG / LOGO_PNG_LEN) */

#define DS4_LINUX_APP_ID "dev.ds4.DStudio"

typedef struct {
    GtkWidget *window;
    GtkWidget *webview;
    GtkWidget *titlebar;
} ds4_wv;

static void ds4_install_linux_chrome_css(void) {
    GtkCssProvider *css = gtk_css_provider_new();
    static const char data[] =
        "headerbar.ds4-titlebar {"
        "  min-height: 34px;"
        "  padding: 0 10px;"
        "  border: 0;"
        "  border-bottom: 1px solid #272727;"
        "  box-shadow: none;"
        "  background-image: none;"
        "}"
        "headerbar.ds4-titlebar.ds4-dark {"
        "  background: #161616;"
        "  color: #ededed;"
        "  border-bottom-color: #272727;"
        "}"
        "headerbar.ds4-titlebar.ds4-light {"
        "  background: #f5f5f6;"
        "  color: #18181b;"
        "  border-bottom-color: #dedee3;"
        "}"
        "headerbar.ds4-titlebar button.titlebutton {"
        "  min-width: 16px;"
        "  min-height: 16px;"
        "  margin: 0 4px;"
        "  padding: 0;"
        "  border: 0;"
        "  border-radius: 999px;"
        "  box-shadow: none;"
        "  background: rgba(255,255,255,0.16);"
        "  background-image: none;"
        "  color: transparent;"
        "}"
        "headerbar.ds4-titlebar button.titlebutton image {"
        "  opacity: 0;"
        "}"
        "headerbar.ds4-titlebar button.titlebutton.close {"
        "  background: #ff5f57;"
        "}"
        "headerbar.ds4-titlebar button.titlebutton.minimize {"
        "  background: #febc2e;"
        "}"
        "headerbar.ds4-titlebar button.titlebutton.maximize {"
        "  background: #28c840;"
        "}"
        "headerbar.ds4-titlebar button.titlebutton:hover {"
        "  box-shadow: inset 0 0 0 999px rgba(255,255,255,0.16);"
        "}";

    gtk_css_provider_load_from_data(css, data, -1, NULL);
    GdkScreen *screen = gdk_screen_get_default();
    if (screen) {
        gtk_style_context_add_provider_for_screen(
            screen, GTK_STYLE_PROVIDER(css), GTK_STYLE_PROVIDER_PRIORITY_APPLICATION);
    }
    g_object_unref(css);
}

static void ds4_apply_linux_titlebar_theme(ds4_wv *w, gboolean light) {
    if (!w || !w->titlebar) return;
    GtkStyleContext *ctx = gtk_widget_get_style_context(w->titlebar);
    if (light) {
        gtk_style_context_remove_class(ctx, "ds4-dark");
        gtk_style_context_add_class(ctx, "ds4-light");
    } else {
        gtk_style_context_remove_class(ctx, "ds4-light");
        gtk_style_context_add_class(ctx, "ds4-dark");
    }
}

static void ds4_on_linux_theme_message(WebKitUserContentManager *manager,
                                       WebKitJavascriptResult *result,
                                       gpointer user_data) {
    (void)manager;
    ds4_wv *w = (ds4_wv *)user_data;
    JSCValue *value = webkit_javascript_result_get_js_value(result);
    char *theme = value ? jsc_value_to_string(value) : NULL;
    ds4_apply_linux_titlebar_theme(w, theme && !strcmp(theme, "light"));
    g_free(theme);
}

static char *ds4_js_quote_utf8(const char *s) {
    if (!s) return g_strdup("null");
    size_t n = strlen(s);
    char *out = (char *)g_malloc(n * 6 + 3);
    if (!out) return g_strdup("\"\"");
    char *p = out;
    *p++ = '"';
    for (const unsigned char *c = (const unsigned char *)s; *c; c++) {
        if (*c == '"' || *c == '\\') { *p++ = '\\'; *p++ = (char)*c; }
        else if (*c == '\n') { *p++ = '\\'; *p++ = 'n'; }
        else if (*c == '\r') { *p++ = '\\'; *p++ = 'r'; }
        else if (*c == '\t') { *p++ = '\\'; *p++ = 't'; }
        else if (*c < 0x20) { p += sprintf(p, "\\u%04x", *c); }
        else *p++ = (char)*c;
    }
    *p++ = '"';
    *p = '\0';
    return out;
}

static void ds4_on_linux_directory_message(WebKitUserContentManager *manager,
                                           WebKitJavascriptResult *result,
                                           gpointer user_data) {
    (void)manager;
    ds4_wv *w = (ds4_wv *)user_data;
    JSCValue *value = webkit_javascript_result_get_js_value(result);
    char *rid = value ? jsc_value_to_string(value) : NULL;
    if (!rid || !rid[0]) { g_free(rid); return; }

    GtkWidget *dialog = gtk_file_chooser_dialog_new(
        "Choose Folder",
        GTK_WINDOW(w->window),
        GTK_FILE_CHOOSER_ACTION_SELECT_FOLDER,
        "_Cancel", GTK_RESPONSE_CANCEL,
        "_Choose", GTK_RESPONSE_ACCEPT,
        NULL);
    gtk_file_chooser_set_create_folders(GTK_FILE_CHOOSER(dialog), TRUE);

    char *path = NULL;
    if (gtk_dialog_run(GTK_DIALOG(dialog)) == GTK_RESPONSE_ACCEPT)
        path = gtk_file_chooser_get_filename(GTK_FILE_CHOOSER(dialog));
    gtk_widget_destroy(dialog);

    char *rid_js = ds4_js_quote_utf8(rid);
    char *path_js = path ? ds4_js_quote_utf8(path) : g_strdup("null");
    char *js = g_strdup_printf(
        "window.__ds4NativeDirectoryPicked&&window.__ds4NativeDirectoryPicked(%s,%s)",
        rid_js, path_js);
    webkit_web_view_run_javascript(WEBKIT_WEB_VIEW(w->webview), js, NULL, NULL, NULL);

    g_free(js);
    g_free(path_js);
    g_free(rid_js);
    g_free(path);
    g_free(rid);
}

static GdkPixbuf *ds4_load_logo_pixbuf(void) {
    GdkPixbuf *pb = NULL;
    GdkPixbufLoader *loader = gdk_pixbuf_loader_new();
    if (!loader) return NULL;

    gboolean ok = gdk_pixbuf_loader_write(loader, LOGO_PNG, LOGO_PNG_LEN, NULL);
    if (ok) ok = gdk_pixbuf_loader_close(loader, NULL);
    else gdk_pixbuf_loader_close(loader, NULL);

    if (ok) {
        GdkPixbuf *loaded = gdk_pixbuf_loader_get_pixbuf(loader);
        if (loaded) pb = (GdkPixbuf *)g_object_ref(loaded);
    }
    g_object_unref(loader);
    return pb;
}

static webview_t webview_create(int width, int height, const char *title) {
    g_set_prgname(DS4_LINUX_APP_ID);
    g_set_application_name("DStudio");
    gdk_set_program_class(DS4_LINUX_APP_ID);
    gtk_init_check(0, NULL);
    ds4_install_linux_chrome_css();
    /* Linux/Windows look (my call): prefer the dark theme so the window
     * decorations (the WM/GTK title bar with its close/min/max buttons)
     * render dark and match the app's black UI, instead of a light bar. */
    g_object_set(gtk_settings_get_default(),
                 "gtk-application-prefer-dark-theme", TRUE, NULL);
    ds4_wv *w = (ds4_wv *)calloc(1, sizeof(ds4_wv));
    w->window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
    gtk_window_set_title(GTK_WINDOW(w->window), title);
    gtk_window_set_default_size(GTK_WINDOW(w->window), width, height);
    gtk_window_set_icon_name(GTK_WINDOW(w->window), DS4_LINUX_APP_ID);
    w->titlebar = gtk_header_bar_new();
    gtk_header_bar_set_show_close_button(GTK_HEADER_BAR(w->titlebar), TRUE);
    gtk_header_bar_set_decoration_layout(GTK_HEADER_BAR(w->titlebar), "close,minimize,maximize:");
    gtk_header_bar_set_custom_title(GTK_HEADER_BAR(w->titlebar), gtk_box_new(GTK_ORIENTATION_HORIZONTAL, 0));
    gtk_style_context_add_class(gtk_widget_get_style_context(w->titlebar), "ds4-titlebar");
    ds4_apply_linux_titlebar_theme(w, FALSE);
    gtk_window_set_titlebar(GTK_WINDOW(w->window), w->titlebar);
    /* Window icon (taskbar / alt-tab / WM title bar) from the embedded logo:
     * the PNG bytes are baked into logo_data.h, decoded into a pixbuf at runtime
     * — same logo as the macOS .icns, no asset file needed. (macOS sets its icon
     * via the .icns in the bundle/resource fork, so this path is Linux-only.) */
    {
        GdkPixbuf *pb = ds4_load_logo_pixbuf();
        if (pb) {
            gtk_window_set_default_icon(pb);
            gtk_window_set_icon(GTK_WINDOW(w->window), pb);
            g_object_unref(pb);
        }
    }
    w->webview = webkit_web_view_new();
    WebKitUserContentManager *manager =
        webkit_web_view_get_user_content_manager(WEBKIT_WEB_VIEW(w->webview));
    g_signal_connect(manager, "script-message-received::ds4Theme",
                     G_CALLBACK(ds4_on_linux_theme_message), w);
    webkit_user_content_manager_register_script_message_handler(manager, "ds4Theme");
    g_signal_connect(manager, "script-message-received::ds4PickDirectory",
                     G_CALLBACK(ds4_on_linux_directory_message), w);
    webkit_user_content_manager_register_script_message_handler(manager, "ds4PickDirectory");
    WebKitUserScript *dir_script = webkit_user_script_new(
        DS4_DIRECTORY_PICKER_SCRIPT,
        WEBKIT_USER_CONTENT_INJECT_TOP_FRAME,
        WEBKIT_USER_SCRIPT_INJECT_AT_DOCUMENT_START,
        NULL,
        NULL);
    webkit_user_content_manager_add_script(manager, dir_script);
    webkit_user_script_unref(dir_script);
    gtk_container_add(GTK_CONTAINER(w->window), w->webview);
    g_signal_connect(w->window, "destroy", G_CALLBACK(gtk_main_quit), NULL);
    return (webview_t)w;
}

static void webview_navigate(webview_t handle, const char *url) {
    ds4_wv *w = (ds4_wv *)handle;
    webkit_web_view_load_uri(WEBKIT_WEB_VIEW(w->webview), url);
}

static void webview_run(webview_t handle) {
    ds4_wv *w = (ds4_wv *)handle;
    gtk_widget_show_all(w->window);
    gtk_main();
}

/* ============================ Windows ============================ */
#elif defined(_WIN32)
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <dwmapi.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <wrl.h>
#include "WebView2.h"
#pragma comment(lib, "dwmapi.lib")

#ifndef DWMWA_USE_IMMERSIVE_DARK_MODE
#define DWMWA_USE_IMMERSIVE_DARK_MODE 20
#endif
#ifndef DWMWA_BORDER_COLOR
#define DWMWA_BORDER_COLOR 34
#endif
#ifndef DWMWA_CAPTION_COLOR
#define DWMWA_CAPTION_COLOR 35
#endif
#ifndef DWMWA_TEXT_COLOR
#define DWMWA_TEXT_COLOR 36
#endif
#define DS4_WIN_ICON_ID 101

typedef struct {
    HWND hwnd;
    ICoreWebView2Controller *controller;
    ICoreWebView2 *webview;
    char pending_url[1024];
} ds4_wv;

static void ds4_wv_resize(ds4_wv *w) {
    if (!w || !w->controller) return;
    RECT bounds;
    GetClientRect(w->hwnd, &bounds);
    w->controller->put_Bounds(bounds);
}

static void ds4_apply_windows_chrome(HWND hwnd, int light) {
    BOOL dark = light ? FALSE : TRUE;
    if (FAILED(DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, &dark, sizeof dark))) {
        const DWORD legacy_dark_mode = 19;
        DwmSetWindowAttribute(hwnd, legacy_dark_mode, &dark, sizeof dark);
    }
    COLORREF caption = light ? RGB(245, 245, 246) : RGB(22, 22, 22);
    COLORREF border = light ? RGB(204, 207, 214) : RGB(22, 22, 22);
    COLORREF text = light ? RGB(24, 24, 27) : RGB(242, 242, 242);
    DwmSetWindowAttribute(hwnd, DWMWA_CAPTION_COLOR, &caption, sizeof caption);
    DwmSetWindowAttribute(hwnd, DWMWA_BORDER_COLOR, &border, sizeof border);
    DwmSetWindowAttribute(hwnd, DWMWA_TEXT_COLOR, &text, sizeof text);
}

static LRESULT CALLBACK ds4_wndproc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    ds4_wv *w = (ds4_wv *)GetWindowLongPtr(hwnd, GWLP_USERDATA);
    switch (msg) {
    case WM_SIZE:
        ds4_wv_resize(w);
        return 0;
    case WM_CLOSE:
        DestroyWindow(hwnd);
        return 0;
    case WM_DESTROY:
        PostQuitMessage(0);
        return 0;
    default:
        return DefWindowProc(hwnd, msg, wp, lp);
    }
}

static wchar_t *ds4_utf8_to_wide(const char *s) {
    int n = MultiByteToWideChar(CP_UTF8, 0, s ? s : "", -1, NULL, 0);
    wchar_t *w = (wchar_t *)calloc((size_t)n, sizeof(wchar_t));
    if (!w) return NULL;
    MultiByteToWideChar(CP_UTF8, 0, s ? s : "", -1, w, n);
    return w;
}

static wchar_t *ds4_win_json_get_string(const wchar_t *json, const wchar_t *key) {
    if (!json || !key) return NULL;
    const wchar_t *p = wcsstr(json, key);
    if (!p) return NULL;
    p = wcschr(p, L':');
    if (!p) return NULL;
    p++;
    while (*p == L' ' || *p == L'\t' || *p == L'\r' || *p == L'\n') p++;
    if (*p != L'"') return NULL;
    p++;
    size_t cap = wcslen(p) + 1;
    wchar_t *out = (wchar_t *)calloc(cap, sizeof(wchar_t));
    if (!out) return NULL;
    size_t o = 0;
    for (; *p && o + 1 < cap; p++) {
        if (*p == L'"') break;
        if (*p == L'\\' && p[1]) {
            p++;
            if (*p == L'n') out[o++] = L'\n';
            else if (*p == L'r') out[o++] = L'\r';
            else if (*p == L't') out[o++] = L'\t';
            else out[o++] = *p;
        } else {
            out[o++] = *p;
        }
    }
    out[o] = L'\0';
    return out;
}

static wchar_t *ds4_win_js_quote(const wchar_t *s) {
    if (!s) {
        wchar_t *nulls = (wchar_t *)calloc(5, sizeof(wchar_t));
        if (nulls) wcscpy(nulls, L"null");
        return nulls;
    }
    size_t n = wcslen(s);
    wchar_t *out = (wchar_t *)calloc(n * 6 + 3, sizeof(wchar_t));
    if (!out) return NULL;
    wchar_t *p = out;
    *p++ = L'"';
    for (const wchar_t *c = s; *c; c++) {
        if (*c == L'"' || *c == L'\\') { *p++ = L'\\'; *p++ = *c; }
        else if (*c == L'\n') { *p++ = L'\\'; *p++ = L'n'; }
        else if (*c == L'\r') { *p++ = L'\\'; *p++ = L'r'; }
        else if (*c == L'\t') { *p++ = L'\\'; *p++ = L't'; }
        else if (*c < 0x20) { p += swprintf(p, 7, L"\\u%04x", (unsigned)*c); }
        else *p++ = *c;
    }
    *p++ = L'"';
    *p = L'\0';
    return out;
}

static PWSTR ds4_windows_pick_directory(HWND hwnd) {
    IFileOpenDialog *dlg = NULL;
    HRESULT hr = CoCreateInstance(CLSID_FileOpenDialog, NULL, CLSCTX_INPROC_SERVER,
                                  IID_PPV_ARGS(&dlg));
    if (FAILED(hr) || !dlg) return NULL;
    DWORD opts = 0;
    if (SUCCEEDED(dlg->GetOptions(&opts))) {
        dlg->SetOptions(opts | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
    }
    dlg->SetTitle(L"Choose Folder");
    PWSTR path = NULL;
    if (SUCCEEDED(dlg->Show(hwnd))) {
        IShellItem *item = NULL;
        if (SUCCEEDED(dlg->GetResult(&item)) && item) {
            item->GetDisplayName(SIGDN_FILESYSPATH, &path);
            item->Release();
        }
    }
    dlg->Release();
    return path;
}

static void ds4_windows_resolve_directory(ds4_wv *w, const wchar_t *rid, const wchar_t *path) {
    if (!w || !w->webview || !rid) return;
    wchar_t *rid_js = ds4_win_js_quote(rid);
    wchar_t *path_js = path ? ds4_win_js_quote(path) : ds4_win_js_quote(NULL);
    if (!rid_js || !path_js) { free(rid_js); free(path_js); return; }
    size_t cap = wcslen(rid_js) + wcslen(path_js) + 128;
    wchar_t *js = (wchar_t *)calloc(cap, sizeof(wchar_t));
    if (js) {
        swprintf(js, cap,
            L"window.__ds4NativeDirectoryPicked&&window.__ds4NativeDirectoryPicked(%ls,%ls)",
            rid_js, path_js);
        w->webview->ExecuteScript(js, NULL);
        free(js);
    }
    free(path_js);
    free(rid_js);
}

static void ds4_init_webview2(ds4_wv *w) {
    wchar_t user_data[MAX_PATH];
    PWSTR local = NULL;
    if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, NULL, &local))) {
        swprintf(user_data, MAX_PATH, L"%ls\\DStudio\\WebView2", local);
        CoTaskMemFree(local);
    } else {
        swprintf(user_data, MAX_PATH, L".\\DStudio-WebView2");
    }
    CreateCoreWebView2EnvironmentWithOptions(
        NULL, user_data, NULL,
        Microsoft::WRL::Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
            [w](HRESULT result, ICoreWebView2Environment *env) -> HRESULT {
                if (FAILED(result) || !env) return result;
                env->CreateCoreWebView2Controller(
                    w->hwnd,
                    Microsoft::WRL::Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
                        [w](HRESULT result, ICoreWebView2Controller *controller) -> HRESULT {
                            if (FAILED(result) || !controller) return result;
                            w->controller = controller;
                            w->controller->AddRef();
                            controller->get_CoreWebView2(&w->webview);
                            w->webview->AddScriptToExecuteOnDocumentCreated(
                                L"(() => {"
                                L"  const target = {"
                                L"    ds4Theme: { postMessage: (theme) =>"
                                L"      chrome.webview.postMessage({ ds4Theme: String(theme) }) },"
                                L"    ds4PickDirectory: { postMessage: (id) =>"
                                L"      chrome.webview.postMessage({ ds4PickDirectory: String(id) }) }"
                                L"  };"
                                L"  window.webkit = window.webkit || {};"
                                L"  window.webkit.messageHandlers = Object.assign({}, window.webkit.messageHandlers, target);"
                                L"})();"
                                L"(() => {"
                                L"  if (window.ds4PickDirectory) return;"
                                L"  let seq = 1;"
                                L"  const pending = new Map();"
                                L"  window.__ds4NativeDirectoryPicked = (id, path) => {"
                                L"    const key = String(id);"
                                L"    const resolve = pending.get(key);"
                                L"    if (!resolve) return;"
                                L"    pending.delete(key);"
                                L"    resolve(path || '');"
                                L"  };"
                                L"  window.ds4PickDirectory = () => new Promise((resolve) => {"
                                L"    const id = String(seq++);"
                                L"    pending.set(id, resolve);"
                                L"    try {"
                                L"      window.webkit.messageHandlers.ds4PickDirectory.postMessage(id);"
                                L"    } catch (e) {"
                                L"      pending.delete(id);"
                                L"      resolve('');"
                                L"    }"
                                L"  });"
                                L"})();",
                                NULL);
                            EventRegistrationToken token;
                            w->webview->add_WebMessageReceived(
                                Microsoft::WRL::Callback<ICoreWebView2WebMessageReceivedEventHandler>(
                                    [w](ICoreWebView2 *sender, ICoreWebView2WebMessageReceivedEventArgs *args) -> HRESULT {
                                        (void)sender;
                                        LPWSTR json = NULL;
                                        if (SUCCEEDED(args->get_WebMessageAsJson(&json)) && json) {
                                            if (wcsstr(json, L"ds4Theme")) {
                                                ds4_apply_windows_chrome(w->hwnd, wcsstr(json, L"light") != NULL);
                                            } else if (wcsstr(json, L"ds4PickDirectory")) {
                                                wchar_t *rid = ds4_win_json_get_string(json, L"ds4PickDirectory");
                                                if (rid) {
                                                    PWSTR path = ds4_windows_pick_directory(w->hwnd);
                                                    ds4_windows_resolve_directory(w, rid, path);
                                                    if (path) CoTaskMemFree(path);
                                                    free(rid);
                                                }
                                            }
                                            CoTaskMemFree(json);
                                        }
                                        return S_OK;
                                    }).Get(),
                                &token);
                            ds4_wv_resize(w);
                            if (w->pending_url[0]) {
                                wchar_t *url = ds4_utf8_to_wide(w->pending_url);
                                if (url) { w->webview->Navigate(url); free(url); }
                            }
                            return S_OK;
                        }).Get());
                return S_OK;
            }).Get());
}

static webview_t webview_create(int width, int height, const char *title) {
    CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);
    HINSTANCE inst = GetModuleHandle(NULL);
    WNDCLASSA wc;
    memset(&wc, 0, sizeof wc);
    wc.lpfnWndProc = ds4_wndproc;
    wc.hInstance = inst;
    wc.lpszClassName = "DStudioWindow";
    wc.hCursor = LoadCursor(NULL, IDC_ARROW);
    wc.hIcon = LoadIcon(inst, MAKEINTRESOURCE(DS4_WIN_ICON_ID));
    if (!wc.hIcon) wc.hIcon = LoadIcon(NULL, IDI_APPLICATION);
    RegisterClassA(&wc);

    ds4_wv *w = (ds4_wv *)calloc(1, sizeof(ds4_wv));
    RECT r = {0, 0, width, height};
    AdjustWindowRect(&r, WS_OVERLAPPEDWINDOW, FALSE);
    w->hwnd = CreateWindowExA(0, wc.lpszClassName, title ? title : "DS4",
                              WS_OVERLAPPEDWINDOW,
                              CW_USEDEFAULT, CW_USEDEFAULT,
                              r.right - r.left, r.bottom - r.top,
                              NULL, NULL, inst, NULL);
    SetWindowLongPtr(w->hwnd, GWLP_USERDATA, (LONG_PTR)w);
    HICON big_icon = (HICON)LoadImage(inst, MAKEINTRESOURCE(DS4_WIN_ICON_ID),
                                      IMAGE_ICON, 32, 32, LR_DEFAULTCOLOR);
    HICON small_icon = (HICON)LoadImage(inst, MAKEINTRESOURCE(DS4_WIN_ICON_ID),
                                        IMAGE_ICON, 16, 16, LR_DEFAULTCOLOR);
    if (big_icon) SendMessage(w->hwnd, WM_SETICON, ICON_BIG, (LPARAM)big_icon);
    if (small_icon) SendMessage(w->hwnd, WM_SETICON, ICON_SMALL, (LPARAM)small_icon);
    ds4_apply_windows_chrome(w->hwnd, 0);
    ds4_init_webview2(w);
    return (webview_t)w;
}

static void webview_navigate(webview_t handle, const char *url) {
    ds4_wv *w = (ds4_wv *)handle;
    snprintf(w->pending_url, sizeof w->pending_url, "%s", url ? url : "");
    if (w->webview) {
        wchar_t *u = ds4_utf8_to_wide(w->pending_url);
        if (u) { w->webview->Navigate(u); free(u); }
    }
}

static void webview_run(webview_t handle) {
    ds4_wv *w = (ds4_wv *)handle;
    ShowWindow(w->hwnd, SW_SHOW);
    UpdateWindow(w->hwnd);
    MSG msg;
    while (GetMessage(&msg, NULL, 0, 0) > 0) {
        TranslateMessage(&msg);
        DispatchMessage(&msg);
    }
    if (w->webview) w->webview->Release();
    if (w->controller) w->controller->Release();
    CoUninitialize();
}

#else
#error "webview.h: unsupported platform (macOS, Linux, or Windows required)"
#endif

#endif /* DS4_WEBVIEW_H */
