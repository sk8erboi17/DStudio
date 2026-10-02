// DStudio originals: local preview behavior shared by every pack.
// No network, storage, accounts or persistence: state is lost on reload.
const root = document.documentElement;
const byId = id => document.getElementById(id);
const make = (tag, text, attributes = {}) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  return node;
};

const theme = document.querySelector('[data-theme-toggle]');
const syncTheme = () => {
  const dark = root.dataset.theme === 'dark';
  theme.setAttribute('aria-pressed', String(dark));
  theme.textContent = dark ? 'Light appearance' : 'Dark appearance';
};
theme.addEventListener('click', () => {
  root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
  syncTheme();
});
syncTheme();

const views = [...document.querySelectorAll('[data-view]')];
for (const button of views) button.addEventListener('click', () => {
  for (const other of views) other.setAttribute('aria-pressed', String(other === button));
  for (const panel of document.querySelectorAll('[data-panel]')) panel.hidden = panel.dataset.panel !== button.dataset.view;
});

// Named dialogs: [data-dialog="id"] opens, [data-close] closes, focus returns to the opener.
for (const dialog of document.querySelectorAll('dialog:not(#request-dialog)')) {
  let opener = null;
  dialog.addEventListener('close', () => opener?.focus());
  for (const button of document.querySelectorAll('[data-dialog="' + dialog.id + '"]')) button.addEventListener('click', () => {
    opener = button;
    dialog.showModal();
  });
  for (const button of dialog.querySelectorAll('[data-close]')) button.addEventListener('click', () => dialog.close());
}

// The shared request dialog. It validates and confirms only what really happened.
const requestDialog = byId('request-dialog');
let requestOpener = null;
for (const button of document.querySelectorAll('[data-open]')) button.addEventListener('click', () => {
  requestOpener = button;
  byId('request-topic').value = button.dataset.open;
  byId('request-status').textContent = '';
  requestDialog.showModal();
});
requestDialog.querySelector('[data-close]').addEventListener('click', () => requestDialog.close());
requestDialog.addEventListener('close', () => requestOpener?.focus());
byId('request-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!event.currentTarget.reportValidity()) return;
  byId('request-status').textContent = 'Preview complete. Nothing was sent or booked.';
});

// Optional list filter: [data-filter] input, [data-record] rows, [data-filter-status] message.
const filter = document.querySelector('[data-filter]');
if (filter) filter.addEventListener('input', () => {
  const query = filter.value.trim().toLowerCase();
  let found = 0;
  for (const row of document.querySelectorAll('[data-record]')) {
    row.hidden = !row.textContent.toLowerCase().includes(query);
    if (!row.hidden) found++;
  }
  document.querySelector('[data-filter-status]').textContent = found
    ? found + (found === 1 ? ' matching item' : ' matching items')
    : 'No matching items. Try another search.';
});

// Optional single choice: [data-choice] buttons, [data-choice-status] live message.
for (const choice of document.querySelectorAll('[data-choice]')) choice.addEventListener('click', () => {
  for (const other of document.querySelectorAll('[data-choice]')) other.setAttribute('aria-pressed', String(other === choice));
  document.querySelector('[data-choice-status]').textContent =
    'Selected: ' + (choice.dataset.label || choice.textContent.trim()) + '. Preview only; no booking made.';
});

// Signal: inspecting a row selects it and fills the detail panel. Example data only.
const items = {
  1042: {title: 'Prepare field recordings', state: ['active', 'In progress'], owner: 'R. Kaur', opened: 'Tue 06:30', source: 'Batch 07', note: 'Eighteen files are being trimmed and renamed. Nothing is uploaded from this preview.'},
  1039: {title: 'Review sample labels', state: ['review', 'In review'], owner: 'M. Osei', opened: 'Tue 03:40', source: 'Labelling pass 2', note: 'Two labels disagree between reviewers. Compare both before accepting either.'},
  1036: {title: 'Resolve missing metadata', state: ['blocked', 'Blocked'], owner: 'Unassigned', opened: 'Mon 09:12', source: 'Station 4', note: 'Three recordings arrived without depth or time zone. Decide whether to re-request them or mark them partial.'},
  1031: {title: 'Calibrate hydrophone B', state: ['queued', 'Queued'], owner: 'J. Lund', opened: 'Mon 14:05', source: 'Instrument log', note: 'Calibration must finish before Thursday. The preview does not schedule anything.'},
  1027: {title: 'Publish weekly summary', state: ['ready', 'Ready'], owner: 'R. Kaur', opened: 'Sun 17:20', source: 'Weekly report', note: 'The draft is ready for sign-off. Publishing is not available in this example.'}
};
for (const button of document.querySelectorAll('[data-inspect]')) button.addEventListener('click', () => {
  const id = button.dataset.inspect, item = items[id];
  for (const row of document.querySelectorAll('.sg-row')) row.setAttribute('aria-current', String(row.dataset.id === id));
  byId('detail-id').textContent = 'NL-' + id + ' · selected';
  byId('detail-title').textContent = item.title;
  byId('detail-state').dataset.state = item.state[0];
  byId('detail-state').textContent = item.state[1];
  byId('detail-owner').textContent = item.owner;
  byId('detail-opened').textContent = item.opened;
  byId('detail-source').textContent = item.source;
  byId('detail-note').textContent = item.note;
});
