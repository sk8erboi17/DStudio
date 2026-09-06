// Bounded geometry check for the published workshop fixture. A working radio
// control alone does not prove its wrapped label stays outside the indicator.
// This is a layout assertion, not an aesthetic or general accessibility score.
export async function measureWorkshopRadioLayout(page) {
  return page.evaluate(() => [...document.querySelectorAll('label')].flatMap(label => {
    const input = label.querySelector('input[type="radio"]');
    if (!input || !label.getClientRects().length) return [];
    const indicator = label.querySelector('[aria-hidden="true"]') || input;
    const marker = indicator.getBoundingClientRect();
    if (!marker.width || !marker.height) return [];
    const textRects = [];
    const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.textContent.trim() || indicator.contains(node)) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects())
        if (rect.width > 1 && rect.height > 1) textRects.push({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
    }
    return [{ choice: input.value, indicator: { left: marker.left, right: marker.right, top: marker.top, height: marker.height },
      textRects, textClearsIndicatorColumn: textRects.length > 0 && textRects.every(rect => rect.left >= marker.right + 3) }];
  }));
}
