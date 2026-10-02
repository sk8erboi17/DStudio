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

// Transit: a fixed example timetable. Searching renames the stops; it never claims live data.
const services=[
 {at:4,dur:27,changes:1,plat:'3',late:0,legs:[['ride','1','4 stops',11],['change','Central','Change · 4 min walk to platform 6',4],['ride','4','5 stops',12]]},
 {at:12,dur:31,changes:0,plat:'1',late:4,legs:[['ride','3','9 stops',31]]},
 {at:20,dur:28,changes:1,plat:'3',late:0,legs:[['ride','1','4 stops',11],['change','Central','Change · 3 min walk to platform 2',3],['ride','2','6 stops',14]]},
 {at:31,dur:25,changes:0,plat:'5',late:0,legs:[['ride','2','8 stops',25]]}
];
const lineNames={'1':'L1 Harbour','2':'L2 Valley','3':'L3 Coast','4':'L4 Ring'},startMinutes=8*60+10;
let chosen=0;
const hm=m=>String(Math.floor(m/60)%24).padStart(2,'0')+':'+String(m%60).padStart(2,'0');
const leaveAt=()=>startMinutes+Number(byId('tr-when').value);
const badge=id=>make('span',lineNames[id],{class:'line','data-line':id});
const changesText=s=>s.changes?s.changes+(s.changes===1?' change':' changes'):'direct';
function drawJourneys(){
 const list=byId('tr-journeys');list.replaceChildren();
 for(const [i,s] of services.entries()){
  const dep=leaveAt()+s.at,arr=dep+s.dur+s.late;
  const row=make('li',undefined,{class:'journey','data-selected':i===chosen});
  const open=make('button',hm(dep),{type:'button',class:'j-open','aria-pressed':i===chosen,'aria-label':'Journey leaving '+hm(dep)+', arriving '+hm(arr)});
  open.addEventListener('click',()=>{chosen=i;drawJourneys();drawDetail();byId('tr-journeys').children[i].querySelector('button').focus();});
  const lines=make('span',undefined,{class:'j-lines'});for(const leg of s.legs)if(leg[0]==='ride')lines.append(badge(leg[1]));
  const plat=make('span','Platform',{class:'j-plat'});plat.prepend(make('span',s.plat,{class:'plat'}));
  row.append(open,lines,make('span','Arrive '+hm(arr)+' · '+(s.dur+s.late)+' min · '+changesText(s),{class:'j-dur'}),plat,make('span',s.late?'+'+s.late+' min':'On time',{class:'state j-state','data-state':s.late?'late':'ontime'}));
  list.append(row);
 }
 byId('tr-count').textContent=services.length+' journeys from '+hm(leaveAt());
}
function drawDetail(){
 const s=services[chosen],legs=byId('tr-legs');legs.replaceChildren();
 let t=leaveAt()+s.at+s.late;
 byId('tr-detail-title').textContent=hm(t)+' → '+hm(t+s.dur);
 byId('tr-detail-sub').textContent=s.dur+' min · '+changesText(s)+(s.late?' · leaves '+s.late+' min late':' · on time');
 const stop=(time,name,note)=>{const li=make('li',undefined,{class:'stop'}),text=make('div',undefined,{class:'stop-text'});text.append(make('strong',name),make('span',note));li.append(make('time',hm(time)),make('span',undefined,{class:'rail','aria-hidden':true}),text);legs.append(li);};
 stop(t,byId('tr-from').value.trim(),'Platform '+s.plat);
 for(const leg of s.legs){
  if(leg[0]==='ride'){const li=make('li',undefined,{class:'ride','data-line':leg[1]}),text=make('div',undefined,{class:'ride-text'});text.append(badge(leg[1]),make('span',leg[2]+' · '+leg[3]+' min'));li.append(make('span'),make('span',undefined,{class:'rail','aria-hidden':true}),text);legs.append(li);}
  else stop(t,leg[1],leg[2]);
  t+=leg[3];
 }
 stop(t,byId('tr-to').value.trim(),'Arrive');
}
function plan(message){
 const from=byId('tr-from'),to=byId('tr-to'),error=byId('tr-error'),a=from.value.trim(),b=to.value.trim();
 const problem=!a||!b?'Enter both a start and a destination.':a.toLowerCase()===b.toLowerCase()?'Choose two different stops.':'';
 error.textContent=problem;error.hidden=!problem;
 if(problem){to.setAttribute('aria-invalid','true');byId('tr-msg').textContent='';return;}
 to.removeAttribute('aria-invalid');
 byId('tr-route-from').textContent=a;byId('tr-route-to').textContent=b;
 drawJourneys();drawDetail();
 if(message)byId('tr-msg').textContent=message;
}
byId('tr-form').addEventListener('submit',event=>{event.preventDefault();plan('Example journeys from '+byId('tr-from').value.trim()+' to '+byId('tr-to').value.trim()+'. Times are illustrative, not live.');});
byId('tr-swap').addEventListener('click',()=>{const a=byId('tr-from'),b=byId('tr-to');[a.value,b.value]=[b.value,a.value];plan('Stops swapped. Times are illustrative, not live.');});
byId('tr-when').addEventListener('change',()=>plan('Showing departures from '+hm(leaveAt())+'.'));
for(const input of document.querySelectorAll('input[name="tr-fare"]'))input.addEventListener('change',()=>{byId('tr-total').textContent='€'+(Number(input.value)/100).toFixed(2);});
plan();
