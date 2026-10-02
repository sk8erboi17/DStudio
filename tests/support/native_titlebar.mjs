// The macOS host gives the window a transparent 28px title-bar strip: the
// traffic-light controls sit in it and a native view over it turns clicks into
// window drags (src/webview.h). The host tells the page through
// --native-titlebar-height, injected into the top frame only. Browsers have no
// such strip, so tests set the same variable the same way.
export const NATIVE_TITLEBAR_PX = 28;

export async function simulateNativeTitlebar(page) {
  await page.addInitScript((px) => {
    if (window.top !== window) return;
    const apply = () => document.documentElement.style.setProperty('--native-titlebar-height', `${px}px`);
    if (document.documentElement) apply();
    else document.addEventListener('DOMContentLoaded', apply, { once: true });
  }, NATIVE_TITLEBAR_PX);
}

// Inside `root`, nothing the user operates may reach into the strip (the
// native view above it takes those clicks and the window controls cover its
// left end). With `bar`, that top bar must also paint across the strip, so
// the controls sit on a bar rather than on the page's content.
export async function windowStripReport(page, root, bar = null) {
  return page.evaluate(async ({ root, bar, px }) => {
    // Measure the resting layout: finite transitions (e.g. a control sliding
    // into place) finish first; endless ones such as a caret blink are ignored.
    await Promise.all(document.getAnimations()
      .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
      .map((a) => a.finished.catch(() => {})));
    const scope = document.querySelector(root);
    const operable = 'button, a[href], input, textarea, select, iframe, [role="button"], [tabindex]:not([tabindex="-1"])';
    const inStrip = [...scope.querySelectorAll(operable)]
      .filter((n) => {
        const cs = getComputedStyle(n);
        return n.getClientRects().length && cs.visibility !== 'hidden' && cs.pointerEvents !== 'none';
      })
      .filter((n) => {
        const r = n.getBoundingClientRect();
        return r.width > 0 && r.top < px && r.bottom > 0 && r.left < innerWidth && r.right > 0;
      })
      .map((n) => n.outerHTML.slice(0, 90));
    const report = {
      inset: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--native-titlebar-height')),
      controlsInStrip: inStrip,
    };
    if (bar) {
      const b = document.querySelector(bar).getBoundingClientRect();
      report.barTop = Math.round(b.top);
      // The traffic lights' area and the far end of the strip.
      report.barCoversStrip = [12, 40, 68, innerWidth - 12].every((x) => !!document.elementFromPoint(x, px / 2)?.closest(bar));
    }
    return report;
  }, { root, bar, px: NATIVE_TITLEBAR_PX });
}
