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

typedef void *webview_t;

static webview_t webview_create(int width, int height, const char *title);
static void      webview_navigate(webview_t w, const char *url);
static void      webview_run(webview_t w);

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
    WKWebView *wv = [[WKWebView alloc] initWithFrame:frame configuration:cfg];
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
} ds4_wv;

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
#include <shlobj.h>
#include <wrl.h>
#include "WebView2.h"

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
    wc.hIcon = LoadIcon(NULL, IDI_APPLICATION);
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
