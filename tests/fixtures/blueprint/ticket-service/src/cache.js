// A small in-process LRU in front of SQLite reads.
const MAX = 500;
const entries = new Map();

function get(id) {
  if (!entries.has(id)) return null;
  const value = entries.get(id);
  entries.delete(id);
  entries.set(id, value);
  return value;
}

function set(id, value) {
  entries.set(id, value);
  if (entries.size > MAX) entries.delete(entries.keys().next().value);
}

module.exports = { get, set };
