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

// Walkthrough: each step highlights one region of the drawn product view.
const tourSteps=[
 ['team','Add your team','Type names or paste a list. Contracts and roles can come later: Rota starts with who works.'],
 ['week','Draw the week','Drag across days or type E, L or N into a cell. Every block shows its hours, so nobody has to ask.'],
 ['gaps','Fix the gaps','Uncovered shifts are listed under the week in words, before anyone else finds them.'],
 ['publish','Publish once','One action sends the week to the team; later edits are marked as changes. In this preview nothing is sent.']
];
const pattern=['eeellxx','llxxeex','nnnxxnn','xxeeexl'],kind={e:'early',l:'late',n:'night',x:'off'};
for(const row of pattern)for(const ch of row)byId('wt-grid').append(make('span',undefined,{'data-b':kind[ch]}));
let tourAt=0;
function showStep(i){
 tourAt=i;const [region,title,text]=tourSteps[i];
 for(const b of document.querySelectorAll('#wt-steps [data-step]'))b.setAttribute('aria-pressed',String(Number(b.dataset.step)===i));
 for(const r of document.querySelectorAll('.wt-tour [data-region]'))r.dataset.active=String(r.dataset.region===region);
 byId('wt-step-of').textContent='Step '+(i+1)+' of '+tourSteps.length;byId('wt-step-title').textContent=title;byId('wt-step-text').textContent=text;
 byId('wt-next').textContent=i===tourSteps.length-1?'Back to step 1':'Next step';
}
for(const b of document.querySelectorAll('#wt-steps [data-step]'))b.addEventListener('click',()=>showStep(Number(b.dataset.step)));
byId('wt-next').addEventListener('click',()=>showStep((tourAt+1)%tourSteps.length));
showStep(0);
