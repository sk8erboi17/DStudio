export function summarize(rows) {
  const totals = new Map();
  for (const row of rows) {
    const date = new Date(row.timestamp);
    if (Number.isNaN(date.getTime())) continue;
    const amount = Number(row.amount);
    if (!Number.isFinite(amount)) continue;
    const key = date.toISOString().slice(0, 10);
    totals.set(key, (totals.get(key) || 0) + amount);
  }
  return [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, total]) => ({ date, total }));
}
