/* DStudio Design visual-selection bridge.
 *
 * This file runs only inside a generated preview iframe. The iframe has
 * `sandbox="allow-scripts"` without `allow-same-origin`, so the artifact stays
 * isolated from the DStudio shell. The bridge reports bounded DOM evidence to
 * the parent and never reads app state or calls app APIs. */
(() => {
  'use strict';
  if (window.__dstudioDesignAnnotator) return;
  window.__dstudioDesignAnnotator = true;

  let enabled = false;
  let channel = '';
  let selected = null;
  let refreshRaf = 0;

  const style = document.createElement('style');
  style.dataset.dstudioAnnotator = 'style';
  style.textContent = [
    'html.dstudio-annotating,html.dstudio-annotating *{cursor:crosshair!important}',
    '[data-dstudio-annotator]{position:fixed;display:none;pointer-events:none;box-sizing:border-box;z-index:2147483646}',
    '[data-dstudio-annotator="hover"]{border:2px solid rgba(55,112,241,.72);background:rgba(55,112,241,.08)}',
    '[data-dstudio-annotator="selected"]{border:2px solid #3770f1;background:rgba(55,112,241,.12);box-shadow:0 0 0 1px rgba(255,255,255,.9) inset,0 8px 30px rgba(22,49,112,.2)}',
    '[data-dstudio-annotator-label]{position:absolute;left:-2px;bottom:100%;max-width:240px;padding:4px 7px;border-radius:6px 6px 0 0;background:#3770f1;color:#fff;font:600 11px/1.25 ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  ].join('');
  (document.head || document.documentElement).append(style);

  function overlay(kind) {
    const node = document.createElement('div');
    node.dataset.dstudioAnnotator = kind;
    if (kind === 'selected') {
      const label = document.createElement('span');
      label.dataset.dstudioAnnotatorLabel = '';
      node.append(label);
    }
    document.documentElement.append(node);
    return node;
  }

  const hoverBox = overlay('hover');
  const selectedBox = overlay('selected');
  const post = (type, detail = {}) => {
    if (!channel) return;
    parent.postMessage({ type, channel, ...detail }, '*');
  };
  const compact = (value, max) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
  const esc = (value) => window.CSS && typeof CSS.escape === 'function'
    ? CSS.escape(String(value))
    : String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);

  function selectorFor(node) {
    if (!(node instanceof Element)) return '';
    const parts = [];
    let cur = node;
    for (let depth = 0; cur && cur.nodeType === 1 && depth < 8; depth++, cur = cur.parentElement) {
      const tag = cur.tagName.toLowerCase();
      if (cur.id) {
        const byId = `#${esc(cur.id)}`;
        try {
          if (document.querySelectorAll(byId).length === 1) {
            parts.unshift(byId);
            break;
          }
        } catch { /* fall through to a structural selector */ }
      }
      const classes = [...cur.classList]
        .filter((name) => name && name.length < 64 && !/^dstudio-/i.test(name))
        .slice(0, 2);
      let part = tag + classes.map((name) => `.${esc(name)}`).join('');
      const siblings = cur.parentElement
        ? [...cur.parentElement.children].filter((item) => item.tagName === cur.tagName)
        : [];
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(cur) + 1})`;
      parts.unshift(part);
      if (tag === 'body') break;
    }
    return parts.join(' > ');
  }

  function describe(node) {
    if (!(node instanceof Element)) return null;
    const rect = node.getBoundingClientRect();
    const attributes = {};
    for (const key of ['id', 'class', 'role', 'aria-label', 'alt', 'name', 'href', 'src', 'poster']) {
      if (node.hasAttribute(key)) attributes[key] = compact(node.getAttribute(key), 500);
    }
    return {
      selector: selectorFor(node),
      tag: node.tagName.toLowerCase(),
      text: compact(node.innerText || node.textContent || node.getAttribute('alt') || '', 500),
      attributes,
      html: compact(node.outerHTML, 1600),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY },
    };
  }

  function draw(box, node, label = '') {
    if (!(node instanceof Element) || !node.isConnected) {
      box.style.display = 'none';
      return;
    }
    const rect = node.getBoundingClientRect();
    box.style.display = rect.width || rect.height ? 'block' : 'none';
    box.style.transform = `translate(${Math.round(rect.x)}px,${Math.round(rect.y)}px)`;
    box.style.width = `${Math.max(0, Math.round(rect.width))}px`;
    box.style.height = `${Math.max(0, Math.round(rect.height))}px`;
    const caption = box.querySelector('[data-dstudio-annotator-label]');
    if (caption) caption.textContent = label;
  }

  function targetOf(event) {
    const node = event.target instanceof Element ? event.target : event.target?.parentElement;
    return node?.closest?.('[data-dstudio-annotator]') ? null : node;
  }

  function refreshSelection() {
    refreshRaf = 0;
    if (!selected || !selected.isConnected) {
      selected = null;
      selectedBox.style.display = 'none';
      post('dstudio:annotator:cleared');
      return;
    }
    const detail = describe(selected);
    draw(selectedBox, selected, detail?.selector || selected.tagName.toLowerCase());
    if (detail) post('dstudio:annotator:geometry', { selection: detail });
  }

  function scheduleRefresh() {
    if (!refreshRaf) refreshRaf = requestAnimationFrame(refreshSelection);
  }

  document.addEventListener('pointermove', (event) => {
    if (!enabled) return;
    const node = targetOf(event);
    if (node) draw(hoverBox, node);
  }, true);

  document.addEventListener('pointerdown', (event) => {
    if (!enabled || event.button !== 0) return;
    const node = targetOf(event);
    if (!node) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    selected = node;
    hoverBox.style.display = 'none';
    const detail = describe(node);
    draw(selectedBox, node, detail?.selector || node.tagName.toLowerCase());
    if (detail) post('dstudio:annotator:selected', { selection: detail });
  }, true);

  document.addEventListener('click', (event) => {
    if (!enabled) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  document.addEventListener('keydown', (event) => {
    if (!enabled || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    selected = null;
    selectedBox.style.display = 'none';
    post('dstudio:annotator:cancel');
  }, true);

  addEventListener('scroll', scheduleRefresh, true);
  addEventListener('resize', scheduleRefresh);
  addEventListener('message', (event) => {
    if (event.source !== parent || !event.data || typeof event.data !== 'object') return;
    const message = event.data;
    if (message.type === 'dstudio:annotator:mode') {
      channel = String(message.channel || '').slice(0, 96);
      enabled = message.enabled === true;
      document.documentElement.classList.toggle('dstudio-annotating', enabled);
      hoverBox.style.display = 'none';
      if (selected) draw(selectedBox, selected, selectorFor(selected));
      post('dstudio:annotator:ready');
    } else if (message.type === 'dstudio:annotator:clear' && String(message.channel || '') === channel) {
      selected = null;
      hoverBox.style.display = 'none';
      selectedBox.style.display = 'none';
    }
  });
})();
