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

// Tally: a register filtered by status and one invoice sheet; draft quantities recompute totals locally.
const invoices=[
 {no:'2026-041',client:'Orsini Freight',contact:'Accounts · Dock Road 4, Genoa',issued:'1 Oct',due:'31 Oct',status:'draft',lines:[['Workshop day on site',2,950],['Process map and written report',1,1400],['Travel, flat rate',1,180]]},
 {no:'2026-040',client:'Hotel Lido Nord',contact:'Administration · Lungomare 9, Rimini',issued:'15 Sep',due:'15 Oct',status:'sent',lines:[['Monthly retainer, September',1,2400]]},
 {no:'2026-038',client:'Clinica Vela',contact:'Practice office · Via Po 31, Turin',issued:'31 Aug',due:'30 Sep',status:'overdue',lines:[['Staff training session',3,620]]},
 {no:'2026-036',client:'Atelier Brera',contact:'Studio · Via Solferino 2, Milan',issued:'20 Aug',due:'20 Sep',status:'paid',lines:[['Setup and data import',1,1850],['Annual licences',5,120]]},
 {no:'2026-035',client:'Panificio Sole',contact:'Owner · Corso Italia 77, Bari',issued:'12 Aug',due:'11 Sep',status:'paid',lines:[['Consultation hours',4,150]]}
];
const label={draft:'Draft',sent:'Sent',overdue:'Overdue',paid:'Paid'},vatRate=.22;
let shownInv=invoices[0],statusFilter='all';
const eur=n=>'€'+n.toLocaleString('en-GB',{minimumFractionDigits:2,maximumFractionDigits:2});
const subtotal=inv=>inv.lines.reduce((s,[,q,p])=>s+q*p,0);
const totalOf=inv=>Math.round(subtotal(inv)*(1+vatRate)*100)/100;
function drawRegister(){
 const list=byId('tl-register');list.replaceChildren();
 const shown=invoices.filter(i=>statusFilter==='all'||i.status===statusFilter);
 for(const inv of shown){
  const row=make('li',undefined,{class:'inv','aria-current':inv===shownInv}),open=make('button',inv.no,{type:'button',class:'inv-no','aria-label':'Open invoice '+inv.no+' for '+inv.client});
  open.addEventListener('click',()=>{shownInv=inv;byId('tl-status').textContent='';drawRegister();drawSheet();byId('tl-register').querySelector('[aria-current="true"] button').focus();});
  const client=make('div',undefined,{class:'inv-client'});client.append(make('strong',inv.client),make('span','Due '+inv.due));
  row.append(open,client,make('span',eur(totalOf(inv)),{class:'inv-amt'}),make('span',label[inv.status],{class:'inv-state','data-state':inv.status}));list.append(row);
 }
 if(!shown.length)list.append(make('li','No '+label[statusFilter].toLowerCase()+' invoices.',{class:'tl-count'}));
 byId('tl-count').textContent=shown.length+(shown.length===1?' invoice':' invoices');
 for(const b of document.querySelectorAll('[data-status]'))b.setAttribute('aria-pressed',String(b.dataset.status===statusFilter));
}
function drawTotals(){
 const inv=shownInv,sub=subtotal(inv);
 byId('tl-sub').textContent=eur(sub);byId('tl-vat').textContent=eur(Math.round(sub*vatRate*100)/100);byId('tl-total').textContent=eur(totalOf(inv));
}
function drawSheet(){
 const inv=shownInv,draft=inv.status==='draft',box=byId('tl-lines');box.replaceChildren();byId('tl-error').hidden=true;
 byId('tl-no').textContent='No. '+inv.no;byId('tl-to').textContent=inv.client+' · '+inv.contact;byId('tl-issued').textContent=inv.issued;byId('tl-due').textContent=inv.due;
 for(const line of inv.lines){
  const row=make('div',undefined,{class:'line-row'}),amount=make('span',eur(line[1]*line[2]),{class:'num'});
  let qty;
  if(draft){
   qty=make('input',undefined,{type:'number',min:1,max:999,step:1,value:line[1],'aria-label':'Quantity for '+line[0],'aria-describedby':'tl-error'});
   qty.addEventListener('input',()=>{
    const n=Number(qty.value),ok=Number.isInteger(n)&&n>=1&&n<=999,error=byId('tl-error');
    if(ok)qty.removeAttribute('aria-invalid');else qty.setAttribute('aria-invalid','true');error.hidden=ok;
    if(!ok){error.textContent='Quantity for “'+line[0]+'” must be a whole number from 1 to 999. Totals keep the last valid value.';return;}
    line[1]=n;amount.textContent=eur(n*line[2]);drawTotals();drawRegister();
   });
  } else qty=make('span',String(line[1]),{class:'num'});
  row.append(make('span',line[0]),qty,make('span',eur(line[2]),{class:'num'}),amount);box.append(row);
 }
 drawTotals();
 const act=byId('tl-act'),state=byId('tl-state');
 state.textContent=label[inv.status];state.dataset.state=inv.status;
 act.hidden=inv.status==='paid';act.textContent=draft?'Send invoice':'Mark as paid';
}
byId('tl-act').addEventListener('click',()=>{
 const invalid=byId('tl-lines').querySelector('input[aria-invalid="true"]');
 if(invalid){byId('tl-status').textContent='Correct the invalid quantity before sending. The draft was kept.';invalid.focus();return;}
 const inv=shownInv,was=inv.status;
 if(was==='draft'){inv.status='sent';byId('tl-status').textContent='Invoice '+inv.no+' marked as sent in this preview. No email or e-invoice was sent.';}
 else if(was==='sent'||was==='overdue'){inv.status='paid';byId('tl-status').textContent='Invoice '+inv.no+' marked as paid in this preview. No bank was checked.';}
 drawRegister();drawSheet();(inv.status==='paid'?byId('tl-state'):byId('tl-act')).focus();
});
byId('tl-state').setAttribute('tabindex','-1');
for(const b of document.querySelectorAll('[data-status]'))b.addEventListener('click',()=>{statusFilter=b.dataset.status;drawRegister();});
drawRegister();drawSheet();
