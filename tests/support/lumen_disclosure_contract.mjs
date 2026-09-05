export function visibleHtmlText(html) {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;|&#38;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export function hasFictionalLocalDemoDisclosure(html) {
  const text = visibleHtmlText(html);
  return /\bfictional\s+design\s+study\b/i.test(text) &&
    /\bno\s+(?:real\s+)?reservation\s+(?:is|was|will\s+be)\s+(?:actually\s+)?(?:created|made)\b/i.test(text);
}
