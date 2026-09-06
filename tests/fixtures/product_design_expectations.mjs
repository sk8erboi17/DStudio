// The brief requires this brand, not uppercase styling. Heading words remain
// required; case/whitespace normalization cannot excuse missing content.
export function hasWorkshopIdentity(text) {
  const normalized = text.replace(/\s+/gu, ' ').trim();
  return /\bNeighbourhood Lab\b/i.test(normalized) && normalized.includes('Make room to learn');
}

// The prompt places the disclosure in final confirmation, not necessarily on
// the initial screen. Require all three meanings in the visible final state.
export function hasHonestWorkshopConfirmation(text) {
  const normalized = text.replace(/\s+/gu, ' ').trim();
  return /\bNo booking was made\b/i.test(normalized) &&
    /\blocal demo\b/i.test(normalized) && /\bsample data\b/i.test(normalized);
}
