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

// Pipeline: stage strip filters the list; one dossier advances a deal and logs activity locally.
const stages=['Lead','Qualified','Proposal','Negotiation','Won'];
const deals=[
 {co:'Saltmarsh Hotels',who:'Inès Moreau · Head of operations',value:35000,stage:2,next:'Answer security questions',due:'Fri 10',late:true,log:[['Thu','Meeting','Walked through the proposal with operations.'],['Mon','Email','Sent the proposal and two references.']]},
 {co:'Harlow & Daughters',who:'Ruth Harlow · Owner',value:12000,stage:1,next:'Send pricing for three shops',due:'Mon 13',late:true,log:[['Fri','Call','Wants one system for three shops.']]},
 {co:'Calder Logistics',who:'Priya Nair · Finance',value:28000,stage:3,next:'Agree payment terms',due:'Wed 15',log:[['Tue','Call','Asked for quarterly billing.']]},
 {co:'Northgate Clinics',who:'Owen Pike · Practice manager',value:26000,stage:2,next:'Review the proposal together',due:'Thu 16',log:[['Wed','Email','Booked a review for Thursday.']]},
 {co:'Tidewater Foods',who:'Sara Lind · Finance director',value:26000,stage:1,next:'Demo for the finance team',due:'Tue 14',log:[['Mon','Call','Budget confirmed for this quarter.']]},
 {co:'Brightwater Dental',who:'Dr Amal Haddad · Partner',value:8400,stage:0,next:'First call',due:'Tue 14',log:[['Fri','Note','Referred by Northgate Clinics.']]},
 {co:'Quarry Lane Garage',who:'Bill Okoro · Owner',value:6200,stage:0,next:'Qualify the budget',due:'Mon 20',log:[['Thu','Email','Downloaded the price list.']]},
 {co:'Fennel Street Bakery',who:'Tom Reyes · Owner',value:4800,stage:0,next:'Book a visit',due:'Thu 16',log:[['Wed','Call','Prefers a visit after closing time.']]},
 {co:'Moss & Mill Studio',who:'Lena Brandt · Director',value:15500,stage:4,next:'Kick-off meeting',due:'Fri 17',log:[['Tue','Note','Contract signed.']]}
];
let openDeal=deals[0],stageFilter=null;
const euro=n=>'€'+n.toLocaleString('en-GB');
function drawStages(){
 const strip=byId('pl-stages');strip.replaceChildren();
 for(const [i,name] of [[null,'All open']].concat(stages.map((s,k)=>[k,s]))){
  const set=deals.filter(d=>d.stage!=='lost'&&(i===null?d.stage<4:d.stage===i));
  const button=make('button',undefined,{type:'button',class:'stage','aria-pressed':stageFilter===i});
  const sum=make('span',String(set.length)+' ',{class:'stage-sum'});sum.append(make('small',euro(set.reduce((s,d)=>s+d.value,0))));
  button.append(make('span',name,{class:'stage-name'}),sum);
  button.addEventListener('click',()=>{stageFilter=i;drawAll();byId('pl-stages').children[i===null?0:i+1].focus();});
  strip.append(button);
 }
}
function drawDeals(){
 const list=byId('pl-deals');list.replaceChildren();
 const shown=deals.filter(d=>d.stage!=='lost'&&(stageFilter===null?d.stage<4:d.stage===stageFilter));
 for(const d of shown){
  const row=make('li',undefined,{class:'deal','aria-current':d===openDeal}),co=make('div',undefined,{class:'deal-co'});
  const open=make('button',d.co,{type:'button',class:'deal-open','aria-label':'Open dossier for '+d.co});
  open.addEventListener('click',()=>{openDeal=d;byId('pl-status').textContent='';drawAll();byId('pl-co').focus();});
  co.append(open,make('span',d.who));
  const next=make('div',undefined,{class:'next','data-late':!!d.late});next.append(make('time',d.due+(d.late?' · overdue':'')),make('span',d.next));
  row.append(co,make('span',stages[d.stage],{class:'deal-stage'}),make('span',euro(d.value),{class:'num'}),next);list.append(row);
 }
 byId('pl-list-title').textContent=stageFilter===null?'All open stages':stages[stageFilter];
 byId('pl-count').textContent=shown.length+(shown.length===1?' deal':' deals');
 const open=deals.filter(d=>d.stage!=='lost'&&d.stage<4);
 byId('pl-meta').textContent=open.length+' open deals · '+euro(open.reduce((s,d)=>s+d.value,0));
}
function drawDossier(){
 const d=openDeal,lost=d.stage==='lost';
 byId('pl-eyebrow').textContent=(lost?'Lost':stages[d.stage])+' · selected deal';byId('pl-co').textContent=d.co;
 byId('pl-contact').textContent=d.who;byId('pl-value').textContent=euro(d.value);byId('pl-next').textContent=d.next;byId('pl-due').textContent=d.due+(d.late?' · overdue':'');
 const path=byId('pl-path');path.replaceChildren();
 for(const [k,name] of stages.entries()){const attrs={};if(!lost&&k<d.stage)attrs['data-done']='true';if(!lost&&k===d.stage)attrs['aria-current']='step';path.append(make('li',name,attrs));}
 const advance=byId('pl-advance');
 advance.disabled=lost||d.stage===4;advance.textContent=lost?'Deal lost':d.stage===4?'Won':'Move to '+stages[d.stage+1];
 byId('pl-lost').hidden=lost||d.stage===4;
 const tl=byId('pl-timeline');tl.replaceChildren();
 for(const [time,type,note] of d.log){const li=make('li'),body=make('div');body.append(make('strong',type),make('p',note));li.append(make('time',time),body);tl.append(li);}
}
function drawAll(){drawStages();drawDeals();drawDossier();}
byId('pl-advance').addEventListener('click',()=>{
 const d=openDeal;if(d.stage==='lost'||d.stage>=4)return;
 d.stage++;d.log.unshift(['Now','Stage','Moved to '+stages[d.stage]+'.']);drawAll();
 byId('pl-status').textContent=d.co+' moved to '+stages[d.stage]+' in this preview only.';
 if(d.stage===4)byId('pl-co').focus();
});
byId('pl-lost').addEventListener('click',()=>{
 const d=openDeal;d.stage='lost';d.log.unshift(['Now','Stage','Marked as lost.']);drawAll();
 byId('pl-status').textContent=d.co+' marked as lost in this preview only. It no longer counts as open.';byId('pl-co').focus();
});
byId('pl-form').addEventListener('submit',event=>{
 event.preventDefault();const note=byId('pl-note'),text=note.value.trim();
 const problem=!text?'Write a note before adding it.':text.length>1000?'Keep a preview activity within 1000 characters.':(openDeal.addedActivities||0)>=20?'This deal holds at most 20 new preview activities. Your draft was kept.':'';
 byId('pl-error').hidden=!problem;
 if(problem){byId('pl-error').textContent=problem;note.setAttribute('aria-invalid','true');note.focus();return;}
 openDeal.addedActivities=(openDeal.addedActivities||0)+1;
 note.removeAttribute('aria-invalid');openDeal.log.unshift(['Now',byId('pl-type').value,text]);note.value='';drawDossier();
 byId('pl-status').textContent='Added to the timeline in this preview only.';
});
byId('pl-co').setAttribute('tabindex','-1');
drawAll();
