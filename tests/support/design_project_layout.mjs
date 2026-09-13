// Rendered indicator/text geometry. A missing or invisible indicator is not a
// successful measurement. Native labels linked with `for` are covered too.
export async function measureProjectChoices(scope) {
  return scope.locator('body').evaluate(body => {
    const records = [], controls = body.querySelectorAll('input[type="radio"],input[type="checkbox"]');
    if (controls.length > 100) throw Error('Choice measurement count exceeds 100');
    for (const input of controls) {
      const labels = [...(input.labels || [])].filter(label => {
        const box = label.getBoundingClientRect(); return box.width && box.height && getComputedStyle(label).visibility === 'visible';
      });
      if (!labels.length) continue; // Hidden steps are measured when entered.
      for (const label of labels) {
        if (label.closest('[hidden],dialog:not([open])')) continue;
        let marker = input, rect = marker.getBoundingClientRect(), style = getComputedStyle(marker);
        if (rect.width < 6 || rect.height < 6 || Number(style.opacity) === 0 || style.visibility !== 'visible' || style.clipPath !== 'none') {
          const candidates = [...label.querySelectorAll('[aria-hidden="true"]')].filter(node => {
            const box = node.getBoundingClientRect(), css = getComputedStyle(node);
            return box.width >= 6 && box.width <= 40 && box.height >= 6 && box.height <= 40 && Number(css.opacity) > 0 && css.visibility === 'visible';
          });
          if (candidates.length !== 1) {
            records.push({name: label.innerText.slice(0, 128), measured: false, reason: 'No unique visible choice indicator'}); continue;
          }
          marker = candidates[0]; rect = marker.getBoundingClientRect();
        }
        const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT), boxes = [];
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (!node.textContent.trim() || marker.contains(node)) continue;
          const range = document.createRange(); range.selectNodeContents(node);
          for (const r of range.getClientRects()) if (r.width > 1 && r.height > 1) boxes.push({left: r.left, right: r.right, top: r.top, bottom: r.bottom});
          if (boxes.length > 1000) throw Error('Choice text measurement exceeds 1000 fragments');
        }
        const clears = boxes.length > 0 && (boxes.every(r => r.left >= rect.right + 2) || boxes.every(r => r.right <= rect.left - 2));
        records.push({name: label.innerText.slice(0, 128), measured: true, clearsIndicatorColumn: clears,
          indicator: {left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom}, text: boxes});
      }
    }
    return records;
  });
}
