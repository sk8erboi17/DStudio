// Original DStudio component interactions. Preview only: no network or persistence.
const root = document.documentElement;
const theme = document.querySelector('[data-theme-toggle]');
theme.addEventListener('click', () => {
  const dark = root.dataset.theme !== 'dark';
  root.dataset.theme = dark ? 'dark' : 'light';
  theme.setAttribute('aria-pressed', String(dark));
  theme.textContent = dark ? 'Light appearance' : 'Dark appearance';
});
const views = [...document.querySelectorAll('[data-view]')];
for (const button of views) button.addEventListener('click', () => {
  for (const b of views) b.setAttribute('aria-pressed', String(b === button));
  for (const panel of document.querySelectorAll('[data-panel]')) panel.hidden = panel.dataset.panel !== button.dataset.view;
});
const dialog = document.querySelector('dialog');
let opener;
for (const button of document.querySelectorAll('[data-open]')) button.addEventListener('click', () => {
  opener = button;
  document.querySelector('#request-topic').value = button.dataset.open;
  document.querySelector('#request-status').textContent = '';
  dialog.showModal();
});
document.querySelector('[data-close]').addEventListener('click', () => dialog.close());
dialog.addEventListener('close', () => opener?.focus());
document.querySelector('#request-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!event.currentTarget.reportValidity()) return;
  document.querySelector('#request-status').textContent = 'Preview complete. Nothing was sent or booked.';
});
const filter = document.querySelector('[data-filter]');
if (filter) filter.addEventListener('input', () => {
  const q = filter.value.trim().toLowerCase();
  let found = 0;
  for (const row of document.querySelectorAll('[data-record]')) {
    row.hidden = !row.textContent.toLowerCase().includes(q);
    if (!row.hidden) found++;
  }
  document.querySelector('[data-filter-status]').textContent = found ? found + ' matching items' : 'No matching items. Try another search.';
});
for (const choice of document.querySelectorAll('[data-choice]')) choice.addEventListener('click', () => {
  for (const other of document.querySelectorAll('[data-choice]')) other.setAttribute('aria-pressed', String(other === choice));
  document.querySelector('[data-choice-status]').textContent = 'Selected: ' + choice.textContent.trim() + '. Preview only; no booking made.';
});
