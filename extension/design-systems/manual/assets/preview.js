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

// Manual: language tabs, code selection, section search and page feedback. Nothing is sent.
const codeSamples={
 curl:[['c-key','curl'],[null,' https://api.example.test/v3/projects \\\n  -H '],['c-str','"Authorization: Bearer $MANUAL_KEY"']],
 js:[['c-key','const'],[null,' response = '],['c-key','await'],[null,' fetch('],['c-str','"https://api.example.test/v3/projects"'],[null,', {\n  headers: { Authorization: '],['c-str','"Bearer "'],[null,' + process.env.MANUAL_KEY }\n});']],
 py:[['c-key','import'],[null,' os, requests\n\nresponse = requests.get(\n    '],['c-str','"https://api.example.test/v3/projects"'],[null,',\n    headers={'],['c-str','"Authorization"'],[null,': '],['c-str','"Bearer "'],[null,' + os.environ['],['c-str','"MANUAL_KEY"'],[null,']},\n)']]
};
const codeBlock=byId('mn-code');
function showCode(lang){
 codeBlock.replaceChildren();
 for(const [cls,text] of codeSamples[lang])codeBlock.append(cls?make('span',text,{class:cls}):document.createTextNode(text));
 for(const button of document.querySelectorAll('[data-lang]'))button.setAttribute('aria-pressed',String(button.dataset.lang===lang));
 byId('mn-code-status').textContent='';
}
for(const button of document.querySelectorAll('[data-lang]'))button.addEventListener('click',()=>showCode(button.dataset.lang));
byId('mn-select').addEventListener('click',()=>{
 const range=document.createRange();range.selectNodeContents(codeBlock);
 const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
 byId('mn-code-status').textContent='Code selected. Press Ctrl+C or ⌘C to copy it.';
});
byId('mn-search').addEventListener('input',event=>{
 const q=event.target.value.trim().toLowerCase();let shown=0;
 for(const item of document.querySelectorAll('#mn-nav-list li')){
  const hit=!q||[...item.querySelectorAll('a')].some(a=>a.textContent.toLowerCase().includes(q));
  item.hidden=!hit;if(hit)shown++;
 }
 byId('mn-nav-count').textContent=q?(shown?shown+(shown===1?' section matches.':' sections match.'):'No section matches. Try another term.'):'';
});
for(const button of document.querySelectorAll('[data-useful]'))button.addEventListener('click',()=>{
 byId('mn-feedback').textContent=(button.dataset.useful==='yes'?'Thanks. ':'Thanks — say what was missing in the full product. ')+'Recorded in this preview only; nothing was sent.';
});
showCode('curl');
