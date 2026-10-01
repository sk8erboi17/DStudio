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

// Roster: one selected cell; choices obey a weekly limit and an 11-hour rest rule. Nothing is published.
const days=['Mon 13','Tue 14','Wed 15','Thu 16','Fri 17','Sat 18','Sun 19'];
const shiftInfo={early:['Early','07–15'],late:['Late','15–23'],night:['Night','23–07'],leave:['Leave','approved']};
const need={early:1,late:1,night:1};
const staff=[
 {name:'Sam Achebe',role:'Shift lead',contract:37.5,week:['early','early','early','late','late','','']},
 {name:'Mira Costa',role:'Kitchen',contract:32,week:['late','late','','','early','early','']},
 {name:'Jonah Reyes',role:'Nights',contract:40,week:['night','night','night','','','night','night']},
 {name:'Ines Varga',role:'Kitchen',contract:32,week:['','','early','early','early','','late']},
 {name:'Theo Laine',role:'Front of house',contract:40,week:['early','late','late','leave','','late','early']}
];
const requests=[{who:1,days:[4,5],why:'Family event',state:'pending'},{who:4,days:[3],why:'Appointment',state:'approved'}];
let pick={p:0,d:2};
const worked=p=>p.week.filter(s=>s&&s!=='leave').length;
// Hours are measured on the same day axis, including a night shift ending on
// the following day. Check both neighbours before publishing the selected cell.
const shiftHours={early:[7,15],late:[15,23],night:[23,31]};
function blockedShift(p,day,value){
 if(p.week[day]==='leave')return 'Approved leave cannot be replaced here.';
 if(value==='off')return '';
 if(!shiftHours[value])return 'Choose a named shift.';
 if(worked(p)>=5&&!shiftHours[p.week[day]])return 'At most 5 shifts are allowed this week.';
 const previous=shiftHours[p.week[day-1]],next=shiftHours[p.week[day+1]],candidate=shiftHours[value];
 if(previous&&24+candidate[0]-previous[1]<11)return 'This shift needs 11 hours’ rest after the previous shift.';
 if(next&&24+next[0]-candidate[1]<11)return 'This shift needs 11 hours’ rest before the next shift.';
 return '';
}
function drawWeek(){
 const body=byId('rs-week');body.replaceChildren();
 for(const [pi,p] of staff.entries()){
  const hours=worked(p)*8,row=make('div',undefined,{class:'person','data-over':hours>p.contract});
  const who=make('div',undefined,{class:'who'});who.append(make('strong',p.name),make('span',p.role));row.append(who);
  for(const [di,s] of p.week.entries()){
   const label=s?shiftInfo[s][0]+' '+shiftInfo[s][1]:'Off';
   const cell=make('button',undefined,{type:'button',class:'cell','data-day':days[di],'aria-pressed':pick.p===pi&&pick.d===di,'aria-label':p.name+', '+days[di]+': '+label});
   if(s){const tag=make('span',shiftInfo[s][0],{class:'shift','data-shift':s});tag.append(make('small',shiftInfo[s][1]));cell.append(tag);}
   else cell.append(make('span','Off',{class:'off'}));
   cell.addEventListener('click',()=>{pick={p:pi,d:di};byId('rs-status').textContent='';drawWeek();drawPick();byId('rs-week').querySelector('[aria-pressed="true"]').focus();});
   row.append(cell);
  }
  const total=make('div',undefined,{class:'hours'});
  total.append(document.createTextNode(hours+' h'),make('span','of '+p.contract+(hours>p.contract?' · +'+(hours-p.contract)+' over':'')));
  row.append(total);body.append(row);
 }
 const cover=byId('rs-cover');cover.replaceChildren(make('strong','Cover'));let short=0;
 for(const di of days.keys()){
  const cell=make('span',undefined,{class:'cover-day','data-day':days[di]});
  for(const k of ['early','late','night']){
   const n=staff.filter(p=>p.week[di]===k).length,gap=n<need[k];if(gap)short++;
   cell.append(make('span',shiftInfo[k][0][0]+' '+n+'/'+need[k],gap?{class:'short','aria-label':shiftInfo[k][0]+' uncovered on '+days[di]}:{}));
  }
  cover.append(cell);
 }
 cover.append(make('span'));
 byId('rs-summary').textContent=short?short+(short===1?' shift is':' shifts are')+' uncovered this week.':'Every shift is covered this week.';
}
function drawPick(){
 const p=staff[pick.p],s=p.week[pick.d],reasons=new Set();
 byId('rs-pick-title').textContent=days[pick.d]+' · '+p.name;
 for(const input of document.querySelectorAll('input[name="rs-shift"]')){
  const v=input.value;
  const reason=blockedShift(p,pick.d,v);input.disabled=!!reason;if(reason)reasons.add(reason);
  input.checked=v===(s||'off');
 }
 byId('rs-rule').textContent='This draft uses 8-hour shifts, at most 5 a week and 11 hours’ rest between adjacent days. '+[...reasons].join(' ');
}
for(const input of document.querySelectorAll('input[name="rs-shift"]'))input.addEventListener('change',()=>{
 const p=staff[pick.p],reason=blockedShift(p,pick.d,input.value);
 if(reason){drawPick();byId('rs-status').textContent=reason+' The previous shift was kept.';return;}
 p.week[pick.d]=input.value==='off'?'':input.value;drawWeek();drawPick();
 byId('rs-status').textContent=p.name+' set to '+(input.value==='off'?'off':shiftInfo[input.value][0].toLowerCase())+' on '+days[pick.d]+' in this draft. Nothing was published.';
});
function drawRequests(){
 const list=byId('rs-requests');list.replaceChildren();
 for(const r of requests){
  const p=staff[r.who],row=make('li',undefined,{class:'request'}),text=make('div');
  text.append(make('strong',p.name),make('span',r.days.map(d=>days[d]).join(' – ')+' · '+r.why));row.append(text);
  if(r.state==='pending'){
   const acts=make('div',undefined,{class:'actions'});
   for(const [label,state] of [['Approve','approved'],['Decline','declined']]){
    const button=make('button',label,{type:'button',class:'link-btn','aria-label':label+' leave for '+p.name});
    button.addEventListener('click',()=>{
     r.state=state;if(state==='approved')for(const d of r.days)p.week[d]='leave';
     drawRequests();drawWeek();drawPick();byId('rs-leave-title').focus();
     byId('rs-status').textContent='Leave '+state+' for '+p.name+' in this draft.'+(state==='approved'?' Their shifts on those days were cleared.':'');
    });
    acts.append(button);
   }
   row.append(acts);
  } else row.append(make('span',r.state==='approved'?'Approved':'Declined',{class:'request-state','data-state':r.state}));
  list.append(row);
 }
}
drawWeek();drawPick();drawRequests();
