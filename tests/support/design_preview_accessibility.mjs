// Measurements of rendered original packs, not assertions about CSS source.
// Solid-color text pairs only; images/gradients are reported as unsupported.
export async function renderedContrast(page) {
  return page.evaluate(() => {
    const rgb = s => {
      if (!/^rgba?\(/.test(s)) throw new Error('Unsupported computed color space: ' + s);
      const n = s.match(/[\d.]+/g)?.map(Number);
      if (!n || n.length < 3) throw new Error('Unsupported rendered color: ' + s);
      return [...n.slice(0, 3), n[3] ?? 1];
    };
    const over = (a, b) => [...a.slice(0, 3).map((v, i) => v * a[3] + b[i] * (1 - a[3])), 1];
    const background = el => {
      const parents = [];
      for (let p = el; p; p = p.parentElement) parents.unshift(p);
      return parents.reduce((color, p) => {
        const s = getComputedStyle(p);
        if (s.backgroundImage !== 'none') throw new Error('Non-solid background: ' + p.className);
        return over(rgb(s.backgroundColor), color);
      }, [255, 255, 255, 1]);
    };
    const luminance = rgb => rgb.slice(0, 3).map(v => {
      v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
    }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
    const ratio = (a, b) => {
      const x = luminance(a), y = luminance(b);
      return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
    };
    const records = [];
    for (const el of document.body.querySelectorAll('*')) {
      const rect = el.getBoundingClientRect(), s = getComputedStyle(el);
      if (!rect.width || !rect.height || rect.bottom < 0 || s.visibility !== 'visible' ||
          el.closest('[hidden],:disabled,.sr-only') || el.closest('dialog:not([open])')) continue;
      const text = [...el.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join('').trim();
      const input = el.matches('input') && (el.value || el.placeholder);
      if (!text && !input) continue;
      const bg = background(el);
      const ps = input && !el.value ? getComputedStyle(el, '::placeholder') : s;
      const fg = rgb(ps.color); fg[3] *= Number(ps.opacity);
      const minimum = parseFloat(s.fontSize) >= 24 || (parseFloat(s.fontSize) >= 18.66 && Number(s.fontWeight) >= 700) ? 3 : 4.5;
      records.push({text: (text || input).slice(0, 80), ratio: ratio(over(fg, bg), bg), minimum});
    }
    return records;
  });
}

// Text-only resize: double every computed font once, including px and vw fonts,
// without doubling the viewport, spacing, or control widths. Reload to restore.
export async function doubleRenderedText(page) {
  return page.evaluate(() => {
    const nodes = [...document.body.querySelectorAll('*'), document.body].map(el => {
      const s = getComputedStyle(el);
      return {el, size: parseFloat(s.fontSize), line: s.lineHeight};
    });
    for (const {el, size, line} of nodes) {
      el.style.setProperty('font-size', size * 2 + 'px', 'important');
      if (line !== 'normal') el.style.setProperty('line-height', String(parseFloat(line) / size), 'important');
    }
    return nodes.length;
  });
}

export async function renderedReflow(page) {
  return page.evaluate(() => {
    const issues = [], width = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth > width + 1)
      issues.push({kind: 'page-overflow', width, scrollWidth: document.documentElement.scrollWidth});
    for (const el of document.body.querySelectorAll('*')) {
      const r = el.getBoundingClientRect(), s = getComputedStyle(el);
      if (!r.width || !r.height || r.bottom < 0 || s.visibility !== 'visible' ||
          el.closest('[hidden],.sr-only') || el.closest('dialog:not([open])')) continue;
      for (const text of [...el.childNodes].filter(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim())) {
        const range = document.createRange(); range.selectNodeContents(text);
        for (const t of range.getClientRects()) {
          if (t.left < -1 || t.right > width + 1) issues.push({kind:'text-outside-page', text:text.textContent.trim().slice(0,80)});
          for (let p = el; p && p !== document.body; p = p.parentElement) {
            const clip = getComputedStyle(p), box = p.getBoundingClientRect();
            if ((['hidden','clip'].includes(clip.overflowX) && (t.left < box.left - 1 || t.right > box.right + 1)) ||
                (['hidden','clip'].includes(clip.overflowY) && (t.top < box.top - 1 || t.bottom > box.bottom + 1))) {
              issues.push({kind:'clipped-text', text:text.textContent.trim().slice(0,80), parent:p.className}); break;
            }
          }
        }
      }
    }
    return issues;
  });
}
