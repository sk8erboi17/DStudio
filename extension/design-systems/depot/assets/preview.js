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

// Depot: one selected item; adjustments change on-hand stock, its state and the movement log locally.
const stock=[
 {sku:'TB-1042',name:'Oak trestle legs',variant:'Pair · 72 cm',bin:'A-03-2',on:46,reorder:20,unit:['pair','pairs'],moves:[['09:12','Picked 4 for order 5521'],['Mon','Received 30 from Lindqvist Timber']]},
 {sku:'TB-1050',name:'Steel corner brackets',variant:'Box of 50',bin:'B-11-1',on:12,reorder:15,unit:['box','boxes'],moves:[['08:40','Picked 3 for order 5519'],['Fri','Count correction −1']]},
 {sku:'LP-2210',name:'Linen lampshade',variant:'30 cm · natural',bin:'C-02-4',on:0,reorder:8,unit:['piece','pieces'],moves:[['Tue','Picked 2 for order 5502'],['Tue','Supplier delay noted']]},
 {sku:'LP-2216',name:'Brass lamp base',variant:'Satin finish',bin:'C-02-1',on:31,reorder:10,unit:['piece','pieces'],moves:[['Wed','Received 24 from Ferro & Figli']]},
 {sku:'PK-0007',name:'Corrugated mailer',variant:'40 × 30 × 10 cm',bin:'D-01-3',on:240,reorder:300,unit:['piece','pieces'],moves:[['07:55','Picked 60 for packing']]},
 {sku:'PK-0012',name:'Paper void fill',variant:'Roll · 50 m',bin:'D-01-5',on:18,reorder:6,unit:['roll','rolls'],moves:[['Thu','Received 12']]}
];
let currentSku='TB-1050';
const stateOf=i=>i.on===0?'out':i.on<=i.reorder?'low':'ok';
const stateWord={ok:'In stock',low:'Low',out:'Out of stock'};
const units=(i,n)=>n+' '+(n===1?i.unit[0]:i.unit[1]);
function drawStock(){
 const q=byId('dp-search').value.trim().toLowerCase(),only=byId('dp-show').value,list=byId('dp-list');list.replaceChildren();let shown=0;
 for(const i of stock){
  const state=stateOf(i);
  if(q&&!(i.sku+' '+i.name+' '+i.variant+' '+i.bin).toLowerCase().includes(q))continue;
  if(only==='attention'&&state==='ok')continue;
  shown++;
  const row=make('li',undefined,{class:'sku-row','data-state':state,'aria-current':i.sku===currentSku});
  const item=make('div',undefined,{class:'sku-item'}),open=make('button',i.name,{type:'button',class:'sku-open','aria-label':'Open bin card for '+i.name});
  open.addEventListener('click',()=>{currentSku=i.sku;byId('dp-status').textContent='';drawStock();drawCard();byId('dp-delta').focus();});
  item.append(open,make('span',i.variant));
  const binCell=make('span',undefined,{class:'bin-cell'});binCell.append(make('span',i.bin,{class:'bin'}));
  const qty=make('span',String(i.on),{class:'qty num'});qty.append(make('small',i.on===1?i.unit[0]:i.unit[1]));
  const max=Math.max(i.reorder*2.5,i.on,1),level=make('div',undefined,{class:'level'}),bar=make('span',undefined,{class:'level-bar','aria-hidden':true});
  const fill=make('span');fill.style.width=Math.min(100,i.on/max*100)+'%';
  const tick=make('i');tick.style.left=Math.min(99,i.reorder/max*100)+'%';
  bar.append(fill,tick);level.append(bar,make('span',stateWord[state],{class:'stock-state','data-state':state}));
  row.append(make('span',i.sku,{class:'sku-code'}),item,binCell,qty,level);list.append(row);
 }
 byId('dp-count').textContent=shown+' of '+stock.length+' items';byId('dp-empty').hidden=shown>0;
}
function drawCard(){
 const i=stock.find(x=>x.sku===currentSku);
 byId('dp-sku').textContent=i.sku+' · bin card';byId('dp-name').textContent=i.name;byId('dp-bin').textContent=i.bin;
 byId('dp-onhand').textContent=units(i,i.on)+' · '+stateWord[stateOf(i)].toLowerCase();byId('dp-reorder').textContent=units(i,i.reorder);
 const moves=byId('dp-moves');moves.replaceChildren();
 for(const [time,text] of i.moves){const li=make('li');li.append(make('time',time),make('span',text));moves.append(li);}
}
byId('dp-form').addEventListener('submit',event=>{
 event.preventDefault();
 const i=stock.find(x=>x.sku===currentSku),field=byId('dp-delta'),error=byId('dp-error');
 const raw=field.value.trim().replace('−','-'),n=Number(raw);
 let problem='';
 if(!/^[+-]?\d+$/.test(raw)||n===0)problem='Enter a whole number other than 0, such as −2 or 10.';
 else if(!Number.isSafeInteger(n)||!Number.isSafeInteger(i.on+n)||i.on+n>999999)problem='On hand must stay within 0 to 999999 whole units. Nothing was changed.';
 else if(i.on+n<0)problem='On hand cannot go below 0. There are '+units(i,i.on)+'.';
 else if(i.moves.length>=32)problem='This bin card holds at most 32 preview movements. Your adjustment was kept.';
 error.textContent=problem;error.hidden=!problem;
 if(problem){field.setAttribute('aria-invalid','true');byId('dp-status').textContent='';field.focus();return;}
 field.removeAttribute('aria-invalid');
 i.on+=n;i.moves.unshift(['Now',byId('dp-reason').value+' '+(n>0?'+':'−')+Math.abs(n)]);field.value='';
 drawStock();drawCard();
 byId('dp-status').textContent='Recorded in this preview only: '+units(i,i.on)+' on hand. No stock system was changed.';
});
byId('dp-search').addEventListener('input',drawStock);
byId('dp-show').addEventListener('change',drawStock);
drawStock();drawCard();
