/* dstudio-ocr: recognize the text of PDF pages that have no text layer.
 *
 *   dstudio-ocr --version
 *   dstudio-ocr <file.pdf> <pages>        pages: "3", "1-4", "2,5,9-11"
 *
 * Each page is rendered locally with PDFKit at 300 dpi and read with the macOS
 * Vision framework (VNRecognizeTextRequest, accurate level, language
 * correction, automatic language detection). Nothing leaves the machine.
 * One JSON line per requested page, written as soon as the page is done:
 *   {"page":3,"width":612,"height":792,"confidence":0.93,"text":"...",
 *    "lines":[{"text":"...","confidence":0.98,"box":[x0,y0,x1,y1]}]}
 * Boxes are PDF points of the page's crop box, origin at the top left (the
 * convention of pdftotext -bbox). A page that cannot be read gives
 * {"page":3,"error":"..."}. The recognized text is a derived reading of the
 * page image: it can misread characters and says nothing the image does not.
 *
 * There is no time limit: slow hardware must not fail valid work. The helper
 * exits when the process that started it is gone, so a cancelled reader does
 * not leave it running. */
#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#import <PDFKit/PDFKit.h>
#import <Vision/Vision.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

#define OCR_DPI 300.0
#define OCR_MAX_PIXELS (12000.0 * 12000.0) /* refuse absurd page sizes */
#define OCR_VERSION "dstudio-ocr 1 (Apple Vision, accurate, 300 dpi)"

static NSString *json_string(NSString *s) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:@[ s ?: @"" ] options:0 error:nil];
    NSString *array = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    return [array substringWithRange:NSMakeRange(1, array.length - 2)];
}

static void emit(NSString *line) {
    fputs(line.UTF8String, stdout);
    fputc('\n', stdout);
    fflush(stdout);
}

/* Pages as 1-based numbers, in the order requested, without duplicates. */
static NSArray<NSNumber *> *parse_pages(const char *spec, NSInteger count) {
    NSMutableOrderedSet<NSNumber *> *out = [NSMutableOrderedSet orderedSet];
    for (NSString *part in [@(spec) componentsSeparatedByString:@","]) {
        NSArray<NSString *> *ends = [part componentsSeparatedByString:@"-"];
        if (ends.count < 1 || ends.count > 2) return nil;
        NSInteger a = ends[0].integerValue, b = ends.count == 2 ? ends[1].integerValue : a;
        if (a < 1 || b < a || b > count) return nil;
        for (NSInteger p = a; p <= b; p++) [out addObject:@(p)];
    }
    return out.array;
}

static NSString *read_page(PDFPage *page, NSInteger number) {
    CGRect box = [page boundsForBox:kPDFDisplayBoxCropBox];
    NSInteger rotation = ((page.rotation % 360) + 360) % 360;
    CGFloat width = rotation % 180 ? box.size.height : box.size.width;
    CGFloat height = rotation % 180 ? box.size.width : box.size.height;
    CGFloat scale = OCR_DPI / 72.0;
    if (width <= 0 || height <= 0 || width * scale * height * scale > OCR_MAX_PIXELS)
        return [NSString stringWithFormat:@"{\"page\":%ld,\"error\":\"page size is not supported for OCR\"}", (long)number];
    size_t w = (size_t)(width * scale), h = (size_t)(height * scale);
    CGColorSpaceRef rgb = CGColorSpaceCreateDeviceRGB();
    CGContextRef ctx = CGBitmapContextCreate(NULL, w, h, 8, 0, rgb, (CGBitmapInfo)kCGImageAlphaPremultipliedLast);
    CGColorSpaceRelease(rgb);
    if (!ctx)
        return [NSString stringWithFormat:@"{\"page\":%ld,\"error\":\"could not allocate the page image\"}", (long)number];
    CGContextSetRGBFillColor(ctx, 1, 1, 1, 1);
    CGContextFillRect(ctx, CGRectMake(0, 0, w, h));
    CGContextScaleCTM(ctx, scale, scale);
    /* drawWithBox applies the page rotation: the image is the page as viewed. */
    [page drawWithBox:kPDFDisplayBoxCropBox toContext:ctx];
    CGImageRef image = CGBitmapContextCreateImage(ctx);
    CGContextRelease(ctx);
    if (!image)
        return [NSString stringWithFormat:@"{\"page\":%ld,\"error\":\"could not render the page\"}", (long)number];

    VNRecognizeTextRequest *request = [[VNRecognizeTextRequest alloc] init];
    request.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
    request.usesLanguageCorrection = YES;
    if (@available(macOS 13.0, *)) request.automaticallyDetectsLanguage = YES;
    VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCGImage:image options:@{}];
    NSError *error = nil;
    BOOL ok = [handler performRequests:@[ request ] error:&error];
    CGImageRelease(image);
    if (!ok)
        return [NSString stringWithFormat:@"{\"page\":%ld,\"error\":%@}", (long)number,
                json_string(error.localizedDescription ?: @"text recognition failed")];

    /* Reading order: top to bottom, then left to right within a line band. */
    NSArray<VNRecognizedTextObservation *> *found = [request.results sortedArrayUsingComparator:
        ^NSComparisonResult(VNRecognizedTextObservation *a, VNRecognizedTextObservation *b) {
            CGFloat ay = a.boundingBox.origin.y + a.boundingBox.size.height / 2;
            CGFloat by = b.boundingBox.origin.y + b.boundingBox.size.height / 2;
            CGFloat band = MIN(a.boundingBox.size.height, b.boundingBox.size.height) / 2;
            if (fabs(ay - by) > band) return ay > by ? NSOrderedAscending : NSOrderedDescending;
            return a.boundingBox.origin.x < b.boundingBox.origin.x ? NSOrderedAscending : NSOrderedDescending;
        }];
    NSMutableString *text = [NSMutableString string];
    NSMutableArray<NSString *> *lines = [NSMutableArray array];
    double confidence = 0;
    NSUInteger counted = 0;
    for (VNRecognizedTextObservation *observation in found) {
        VNRecognizedText *best = [observation topCandidates:1].firstObject;
        if (!best || !best.string.length) continue;
        CGRect r = observation.boundingBox; /* normalized, origin bottom left */
        double x0 = r.origin.x * width, x1 = (r.origin.x + r.size.width) * width;
        double y0 = (1 - r.origin.y - r.size.height) * height, y1 = (1 - r.origin.y) * height;
        if (text.length) [text appendString:@"\n"];
        [text appendString:best.string];
        [lines addObject:[NSString stringWithFormat:@"{\"text\":%@,\"confidence\":%.3f,\"box\":[%.1f,%.1f,%.1f,%.1f]}",
                          json_string(best.string), best.confidence, x0, y0, x1, y1]];
        confidence += best.confidence;
        counted++;
    }
    return [NSString stringWithFormat:@"{\"page\":%ld,\"width\":%.1f,\"height\":%.1f,\"confidence\":%.3f,\"text\":%@,\"lines\":[%@]}",
            (long)number, width, height, counted ? confidence / counted : 0.0, json_string(text),
            [lines componentsJoinedByString:@","]];
}

int main(int argc, char **argv) {
    @autoreleasepool {
        if (argc == 2 && !strcmp(argv[1], "--version")) {
            NSOperatingSystemVersion v = NSProcessInfo.processInfo.operatingSystemVersion;
            printf("%s; macOS %ld.%ld.%ld\n", OCR_VERSION, (long)v.majorVersion, (long)v.minorVersion, (long)v.patchVersion);
            return 0;
        }
        if (argc != 3) {
            fprintf(stderr, "usage: dstudio-ocr <file.pdf> <pages> | --version\n");
            return 2;
        }
        /* The reader that asked owns this work: when it is gone, stop. A
         * parent that exited before this line already left us to launchd
         * (pid 1), and getppid() would then never change. The exit event is
         * immediate; the timer covers a parent that exited between getppid()
         * and the event registration. */
        pid_t owner = getppid();
        if (owner <= 1) _exit(3);
        dispatch_queue_t q = dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0);
        dispatch_source_t gone = dispatch_source_create(DISPATCH_SOURCE_TYPE_PROC, (uintptr_t)owner, DISPATCH_PROC_EXIT, q);
        if (gone) {
            dispatch_source_set_event_handler(gone, ^{ _exit(3); });
            dispatch_resume(gone);
        }
        dispatch_source_t watch = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, q);
        dispatch_source_set_timer(watch, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), NSEC_PER_SEC, NSEC_PER_SEC / 4);
        dispatch_source_set_event_handler(watch, ^{
            if (getppid() != owner) _exit(3);
        });
        dispatch_resume(watch);

        PDFDocument *doc = [[PDFDocument alloc] initWithURL:[NSURL fileURLWithPath:@(argv[1])]];
        if (!doc) { fprintf(stderr, "dstudio-ocr: cannot open the PDF\n"); return 1; }
        if (doc.isLocked) { fprintf(stderr, "dstudio-ocr: the PDF is encrypted\n"); return 1; }
        NSArray<NSNumber *> *pages = parse_pages(argv[2], doc.pageCount);
        if (!pages.count) { fprintf(stderr, "dstudio-ocr: invalid page list for a %ld-page PDF\n", (long)doc.pageCount); return 2; }
        for (NSNumber *number in pages) {
            @autoreleasepool {
                PDFPage *page = [doc pageAtIndex:number.integerValue - 1];
                emit(page ? read_page(page, number.integerValue)
                          : [NSString stringWithFormat:@"{\"page\":%ld,\"error\":\"page not found\"}", (long)number.integerValue]);
            }
        }
    }
    return 0;
}
