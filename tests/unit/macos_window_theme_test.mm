// Actual Cocoa window, WKWebView and production theme bridge; no inference.
#include "../../src/webview.h"
#include <stdio.h>
#include <initializer_list>

static void require(BOOL ok, const char *message) {
    if (!ok) { fprintf(stderr, "FAIL: %s\n", message); exit(1); }
}

static id evaluate(WKWebView *view, NSString *script, BOOL asynchronous = NO) {
    __block BOOL done = NO;
    __block id result = nil;
    __block NSError *failure = nil;
    void (^finish)(id, NSError *) = ^(id value, NSError *error) {
        result = [value retain]; failure = [error retain]; done = YES;
    };
    if (asynchronous)
        [view callAsyncJavaScript:script arguments:@{} inFrame:nil inContentWorld:WKContentWorld.pageWorld completionHandler:finish];
    else [view evaluateJavaScript:script completionHandler:finish];
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:8];
    while (!done && [deadline timeIntervalSinceNow] > 0)
        [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    if (failure) fprintf(stderr, "native JavaScript: %s\n", failure.description.UTF8String);
    require(done && !failure, "JavaScript must complete in the actual WebKit view");
    return [result autorelease];
}

int main(int argc, char **argv) {
    (void)webview_navigate; (void)webview_run;
    @autoreleasepool {
        ds4_wv *view = (ds4_wv *)webview_create(760, 600, "DStudio theme test");
        NSWindow *win = view->window;
        [win makeKeyAndOrderFront:nil];
        require((win.styleMask & NSWindowStyleMaskFullSizeContentView) != 0,
                "Web content must extend underneath the native title bar");
        require(fabs(win.contentView.bounds.size.height - win.frame.size.height) < 1,
                "A separate native strip must not shorten the web content");
        require(win.titlebarSeparatorStyle == NSTitlebarSeparatorStyleNone,
                "The native title bar must not draw a separator");
        [view->webview loadHTMLString:@"<!doctype html><html><body>Native theme fixture</body></html>" baseURL:nil];
        NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:8];
        while ((view->webview.loading || !view->webview.URL) && [deadline timeIntervalSinceNow] > 0)
            [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
        NSString *inset = evaluate(view->webview,
            @"getComputedStyle(document.documentElement).getPropertyValue('--native-titlebar-height').trim()");
        require([inset isEqualToString:@"28px"], "Native controls require a reserved content inset");
        const BOOL flipped = win.contentView.isFlipped;
        NSPoint top = NSMakePoint(380, flipped ? 14 : win.contentView.bounds.size.height - 14);
        NSPoint body = NSMakePoint(380, flipped ? 100 : win.contentView.bounds.size.height - 100);
        // NSView hitTest consumes superview coordinates, even for a flipped WKWebView.
        top = [win.contentView convertPoint:top toView:win.contentView.superview];
        body = [win.contentView convertPoint:body toView:win.contentView.superview];
        NSView *strip = [win.contentView hitTest:top];
        require(strip && strip != [win.contentView hitTest:body],
                "The title bar must receive window gestures independently from selectable web content");
        require(!strip.isOpaque && fabs(strip.bounds.size.height - 28) < 1,
                "The drag strip must let each underlying pane continue its own color");
        require(strip.mouseDownCanMoveWindow && !view->webview.mouseDownCanMoveWindow,
                "Native background dragging must exclude WebKit text and controls");
        for (NSWindowButton kind : {NSWindowCloseButton, NSWindowMiniaturizeButton, NSWindowZoomButton}) {
            NSButton *button = [win standardWindowButton:kind];
            NSView *frame = win.contentView.superview;
            NSPoint point = [button convertPoint:NSMakePoint(NSMidX(button.bounds), NSMidY(button.bounds)) toView:frame];
            NSView *hit = [frame hitTest:point];
            require(hit == button || [hit isDescendantOf:button],
                    "The title bar must not cover native close, minimize or zoom buttons");
        }
        for (NSString *theme in @[@"light", @"dark"]) {
            evaluate(view->webview, [NSString stringWithFormat:
                @"window.webkit.messageHandlers.ds4Theme.postMessage('%@'); true", theme]);
            NSColor *color = [win.backgroundColor colorUsingColorSpace:NSColorSpace.sRGBColorSpace];
            BOOL light = [theme isEqualToString:@"light"];
            require(fabs(color.redComponent - (light ? 1.0 : 30.0/255.0)) < 0.001 &&
                    fabs(color.greenComponent - (light ? 1.0 : 34.0/255.0)) < 0.001 &&
                    fabs(color.blueComponent - (light ? 1.0 : 42.0/255.0)) < 0.001,
                    "The native underlay must match the actual app canvas theme");
            require(win.appearance.name == (light ? NSAppearanceNameAqua : NSAppearanceNameDarkAqua) ||
                    [win.appearance.name isEqualToString:(light ? NSAppearanceNameAqua : NSAppearanceNameDarkAqua)],
                    "Window controls must follow the selected appearance");
            NSBitmapImageRep *pixels = [strip bitmapImageRepForCachingDisplayInRect:strip.bounds];
            [strip cacheDisplayInRect:strip.bounds toBitmapImageRep:pixels];
            for (NSInteger x : {(NSInteger)10, (NSInteger)pixels.pixelsWide / 2, (NSInteger)pixels.pixelsWide - 10}) {
                NSColor *pixel = [pixels colorAtX:x y:pixels.pixelsHigh / 2];
                require(pixel.alphaComponent < 0.01,
                        "Native dragging must not paint a conflicting color over either pane");
            }
        }
        [win setContentSize:NSMakeSize(1000, 720)];
        NSPoint resizedTop = NSMakePoint(940, flipped ? 14 : win.contentView.bounds.size.height - 14);
        resizedTop = [win.contentView convertPoint:resizedTop toView:win.contentView.superview];
        require([win.contentView hitTest:resizedTop] == strip,
                "The drag strip must stay across the window top after resize");
        if (argc == 5 && strcmp(argv[1], "--preview") == 0) {
            // Use a fresh window for live rendering after the unit's offscreen
            // cacheDisplay probes. Those probes are not an OS screenshot oracle.
            [win orderOut:nil];
            view = (ds4_wv *)webview_create(1000, 720, "DStudio native UI — simulated runtime");
            win = view->window;
            [NSApp finishLaunching];
            [win makeKeyAndOrderFront:nil];
            strip = [win.contentView hitTest:NSMakePoint(500, 706)];
            // Optional operator-driven OS drag check. The supplied URL must be
            // a model-free fixture; its browser storage belongs to that origin.
            NSString *url = [NSString stringWithUTF8String:argv[2]];
            NSString *receiptPath = [NSString stringWithUTF8String:argv[3]];
            NSData *seedBytes = [NSData dataWithContentsOfFile:[NSString stringWithUTF8String:argv[4]]];
            NSDictionary *seed = [NSJSONSerialization JSONObjectWithData:seedBytes options:0 error:nil];
            require(seed != nil, "Preview requires isolated browser settings and a synthetic image");
            NSString *json = [[[NSString alloc] initWithData:seedBytes encoding:NSUTF8StringEncoding] autorelease];
            NSString *script = [NSString stringWithFormat:
                @"if(window===window.top&&location.origin===%@){const fixture=%@;for(const [key,value] of Object.entries(fixture.storage))localStorage.setItem(key,JSON.stringify(value));}",
                ds4_js_string(url), json];
            WKUserScript *init = [[WKUserScript alloc] initWithSource:script
                injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES];
            [view->webview.configuration.userContentController addUserScript:init]; [init release];
            [win setTitle:@"DStudio native UI — simulated runtime"];
            webview_navigate(view, argv[2]);
            NSDate *loaded = [NSDate dateWithTimeIntervalSinceNow:8];
            while (view->webview.loading && [loaded timeIntervalSinceNow] > 0)
                [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
            id decoded = evaluate(view->webview, [NSString stringWithFormat:
                @"const data=%@;const bytes=Uint8Array.from(atob(data.split(',')[1]),c=>c.charCodeAt(0));const url=URL.createObjectURL(new Blob([bytes],{type:'image/png'}));try{const image=new Image();image.src=url;await image.decode();return [image.naturalWidth,image.naturalHeight];}finally{URL.revokeObjectURL(url);}",
                ds4_js_string(seed[@"image"]) ], YES);
            require([decoded isEqual:@[@652, @1902]], "Actual native WKWebView must decode a blob under the served policy");
            [view->webview takeSnapshotWithConfiguration:nil completionHandler:^(NSImage *image, NSError *error) {
                (void)error;
                NSBitmapImageRep *bitmap = [NSBitmapImageRep imageRepWithData:image.TIFFRepresentation];
                [[bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}]
                    writeToFile:[[receiptPath stringByDeletingLastPathComponent] stringByAppendingPathComponent:@"web.png"] atomically:YES];
            }];
            NSMutableArray *moves = [NSMutableArray array];
            NSMutableArray *events = [NSMutableArray array];
            NSString *initialFrame = NSStringFromRect(win.frame);
            void (^save)(void) = ^{
                NSDictionary *report = @{@"scope": @"Actual native window; simulated HTTP runtime only",
                    @"initialFrame": initialFrame, @"currentFrame": NSStringFromRect(win.frame),
                    @"moves": moves, @"nativeBlobImageDecoded": @YES,
                    @"webFrame": NSStringFromRect(view->webview.frame), @"stripFrame": NSStringFromRect(strip.frame), @"mouseEvents": events};
                [[NSJSONSerialization dataWithJSONObject:report options:NSJSONWritingPrettyPrinted error:nil]
                    writeToFile:receiptPath atomically:YES];
            };
            save();
            id observer = [[NSNotificationCenter defaultCenter] addObserverForName:NSWindowDidMoveNotification
                object:win queue:nil usingBlock:^(NSNotification *note) {
                    (void)note;
                    if (moves.count == 256) [moves removeObjectAtIndex:0];
                    [moves addObject:NSStringFromRect(win.frame)]; save();
                }];
            id monitor = [NSEvent addLocalMonitorForEventsMatchingMask:(NSEventMaskLeftMouseDown | NSEventMaskLeftMouseUp)
                handler:^NSEvent *(NSEvent *event) {
                    if (event.window == win) {
                        if (events.count == 512) [events removeObjectAtIndex:0];
                        [events addObject:@{@"type": @(event.type), @"location": NSStringFromPoint(event.locationInWindow)}]; save();
                    }
                    return event;
                }];
            [NSTimer scheduledTimerWithTimeInterval:300 repeats:NO block:^(NSTimer *timer) {
                (void)timer; save(); [NSApp stop:nil];
            }];
            printf("native UI preview ready; OS drag receipt: %s\n", argv[3]); fflush(stdout);
            [NSApp activateIgnoringOtherApps:YES]; [win makeKeyAndOrderFront:nil]; [NSApp run];
            [[NSNotificationCenter defaultCenter] removeObserver:observer];
            [NSEvent removeMonitor:monitor];
        }
        puts("macos_window_theme_test: PASS (actual Cocoa/WebKit, both themes, no model)");
        [win close];
    }
    return 0;
}
