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

// Ledger: one list of entries drives the running balance, the filter and reconciliation.
const opening=108105;
const ledgerLabels={income:'Income',home:'Home',groceries:'Groceries',transport:'Transport'};
const entries=[
 {d:'01 Oct',payee:'Harbour & Finch Ltd',memo:'Salary, October',cat:'income',amt:285000,rec:true},
 {d:'02 Oct',payee:'Elm Street Lettings',memo:'Rent, October',cat:'home',amt:-115000,rec:true},
 {d:'04 Oct',payee:'Corner Grocer',memo:'Weekly shop',cat:'groceries',amt:-8640,rec:true},
 {d:'07 Oct',payee:'City Rail',memo:'Monthly pass top-up',cat:'transport',amt:-6000,rec:true},
 {d:'09 Oct',payee:'Riverside Utilities',memo:'Water and power',cat:'home',amt:-11825,rec:true},
 {d:'12 Oct',payee:'Saturday market',memo:'Vegetables and bread',cat:'groceries',amt:-3480,rec:true},
 {d:'15 Oct',payee:'Studio North',memo:'Invoice 041, paid',cat:'income',amt:40000,rec:true},
 {d:'18 Oct',payee:'Corner Grocer',memo:'Monthly stock-up',cat:'groceries',amt:-19120,rec:false},
 {d:'21 Oct',payee:'Night taxi',memo:'Home from the station',cat:'transport',amt:-3600,rec:false},
 {d:'24 Oct',payee:'Linden Mutual',memo:'Home contents cover',cat:'home',amt:-23600,rec:false}
];
const money=cents=>'€'+(Math.abs(cents)/100).toLocaleString('en-GB',{minimumFractionDigits:2,maximumFractionDigits:2});
const book=byId('ledger-book');
function summarise(changed){
 const open=entries.filter(e=>!e.rec).length;
 byId('ledger-cleared').textContent=money(opening+entries.filter(e=>e.rec).reduce((sum,e)=>sum+e.amt,0));
 byId('ledger-recon').textContent=(open?open+(open===1?' entry':' entries')+' still to reconcile.':'Every entry is reconciled.')+(changed?' '+changed.payee+' '+(changed.rec?'ticked':'unticked')+' in this preview only.':'');
}
let running=opening;
for(const e of entries){
 running+=e.amt;
 const row=make('li',undefined,{class:'entry','data-cat':e.cat});
 const payee=make('div',undefined,{class:'e-payee'});payee.append(make('strong',e.payee),make('span',e.memo));
 const tick=make('input',undefined,{type:'checkbox','aria-label':'Reconciled: '+e.payee+', '+e.d});tick.checked=e.rec;if(e.rec)tick.setAttribute('checked','');
 tick.addEventListener('change',()=>{e.rec=tick.checked;summarise(e);});
 const cell=make('span',undefined,{class:'e-tick'});cell.append(tick);
 row.append(make('span',e.d,{class:'e-date'}),payee,make('span',ledgerLabels[e.cat],{class:'e-cat'}),
  make('span',e.amt<0?money(e.amt):'',{class:'amt out'}),make('span',e.amt>0?money(e.amt):'',{class:'amt in'}),
  make('span',money(running),{class:'amt bal'}),make('span',(e.amt<0?'−':'+')+money(e.amt),{class:'e-signed '+(e.amt<0?'is-out':'is-in'),'aria-hidden':true}),cell);
 book.append(row);
}
byId('ledger-category').addEventListener('change',event=>{
 const value=event.target.value;let shown=0;
 for(const row of book.children){row.hidden=value!=='all'&&row.dataset.cat!==value;if(!row.hidden)shown++;}
 byId('ledger-count').textContent='Showing '+shown+' of '+entries.length+' entries';
});
summarise();
