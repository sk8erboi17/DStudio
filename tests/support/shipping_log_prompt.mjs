// Deterministic synthetic prompts for long-context checks: a numbered shipping
// log (no private data) and an optional needle sentence. The same record count
// and seed always give the same text, so a prompt can be rebuilt from a receipt.
const cities = ['Avora', 'Belmont', 'Caldera', 'Dunmore', 'Elsby', 'Fenwick', 'Galloway', 'Harrow', 'Ilsted', 'Juniper'];
const items = ['valves', 'bearings', 'gaskets', 'sensors', 'cables', 'filters', 'pumps', 'relays'];

export function shippingRecords(count, seed) {
  let x = seed >>> 0; const next = () => (x = (Math.imul(x, 1664525) + 1013904223) >>> 0);
  const out = [];
  for (let i = 1; i <= count; i++) {
    out.push(`Record ${i}: the ${cities[next() % cities.length]} depot shipped ${100 + next() % 900} ${items[next() % items.length]} ` +
      `on day ${1 + next() % 365}; inspector ${String.fromCharCode(65 + next() % 26)}${next() % 100} signed the log, and the batch ` +
      `was stored on shelf ${1 + next() % 40} of aisle ${1 + next() % 12}.`);
  }
  return out;
}

export const NEEDLE = { sentence: 'The vault access code is 4183-KESTREL.', expected: '4183-KESTREL' };

// The needle sits at 60% of the log; the question asks for it alone.
export function needlePrompt(records) {
  const at = Math.floor(records.length * 0.6);
  return `Read the shipping log below.\n\n${[...records.slice(0, at), NEEDLE.sentence, ...records.slice(at)].join('\n')}\n\n` +
    'What is the vault access code mentioned in the log? Reply with the code only.';
}

export function lookupPrompt(records) {
  return `Read the shipping log below.\n\n${records.join('\n')}\n\nWhich depot shipped the batch in Record ` +
    `${Math.max(1, Math.floor(records.length / 2))}, and how many items did it contain? Answer in one sentence.`;
}
