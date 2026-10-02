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

// Docket: one selected task; its status moves it between lanes, bounded by the Doing limit.
const lanes=[['todo','To do'],['doing','Doing'],['done','Done']],doingLimit=3;
const tasks=[
 {id:'DK-118',title:'Proof the cover copy',status:'todo',prio:'high',owner:'A. Moretti',due:'Thu 10 Apr',note:'Check the title, spine and blurb against the approved manuscript before the printer’s cut-off.',check:[['Title and subtitle',true],['Spine text',false],['Back-cover blurb',false]]},
 {id:'DK-121',title:'Write alt text for 14 plates',status:'todo',prio:'normal',owner:'L. Marsh',due:'Wed 9 Apr',note:'Describe what each plate shows, not what it means.',check:[['Plates 1–7',false],['Plates 8–14',false],['Second read',false]]},
 {id:'DK-124',title:'Book the print slot',status:'todo',prio:'normal',owner:'J. Ruiz',due:'Fri 11 Apr',note:'Two slots are offered; the earlier one needs files by Wednesday.',check:[['Confirm quantity',false],['Choose a slot',false]]},
 {id:'DK-112',title:'Retouch plates 3 and 9',status:'doing',prio:'high',owner:'L. Marsh',due:'Tue 8 Apr',note:'Dust on plate 3 and a colour cast on plate 9.',check:[['Plate 3',true],['Plate 9',false]]},
 {id:'DK-115',title:'Index of works',status:'doing',prio:'normal',owner:'A. Moretti',due:'Wed 9 Apr',note:'Title, year, medium and dimensions for every plate.',check:[['Draft',true],['Check dimensions',false]]},
 {id:'DK-104',title:'Choose paper stock',status:'done',prio:'normal',owner:'J. Ruiz',due:'Done 2 Apr',note:'Uncoated 150 g, chosen from three samples.',check:[['Request samples',true],['Decide',true]]},
 {id:'DK-109',title:'Final plate order',status:'done',prio:'normal',owner:'A. Moretti',due:'Done 4 Apr',note:'Agreed with the artist on the call.',check:[['Agree the order',true]]}
];
let picked='DK-118';
const board=byId('dk-board');
function drawBoard(){
 board.replaceChildren();
 for(const [key,label] of lanes){
  const items=tasks.filter(t=>t.status===key),full=key==='doing'&&items.length>=doingLimit;
  const lane=make('section',undefined,{class:'lane','aria-labelledby':'lane-'+key,'data-full':full});
  const heading=make('h2',label+' ',{id:'lane-'+key});
  heading.append(make('span',key==='doing'?items.length+' of '+doingLimit+(full?' · full':''):String(items.length),{class:'lane-count'}));
  lane.append(heading);
  if(!items.length){lane.append(make('p','Nothing here. Move a task in from the inspector.',{class:'empty-lane'}));board.append(lane);continue;}
  const list=make('ol',undefined,{class:'tasks'});
  for(const t of items){
   const row=make('li',undefined,{class:'task','data-status':t.status});
   const open=make('button',t.title,{type:'button',class:'task-open','aria-pressed':t.id===picked});
   open.addEventListener('click',()=>{picked=t.id;byId('dk-msg').textContent='';drawBoard();drawInspector();board.querySelector('[aria-pressed="true"]').focus();});
   row.append(make('span',t.id,{class:'task-id'}));
   if(t.prio==='high')row.append(make('span','!! High',{class:'prio'}));
   row.append(open,make('span',t.owner+' · '+t.due,{class:'task-meta'}));
   list.append(row);
  }
  lane.append(list);board.append(lane);
 }
 const open=tasks.filter(t=>t.status!=='done').length;
 byId('dk-open').textContent=open+(open===1?' task':' tasks');
}
function progress(task){byId('dk-progress').textContent=task.check.filter(c=>c[1]).length+' of '+task.check.length+' done';}
function drawInspector(){
 const task=tasks.find(t=>t.id===picked),busy=tasks.filter(t=>t.status==='doing'&&t.id!==task.id).length,blocked=task.status!=='doing'&&busy>=doingLimit;
 byId('dk-id').textContent=task.id+' · selected';byId('dk-title').textContent=task.title;
 byId('dk-who').textContent=task.owner+' · '+task.due;byId('dk-note').textContent=task.note;
 for(const input of document.querySelectorAll('input[name="dk-status"]')){input.checked=input.value===task.status;input.disabled=input.value==='doing'&&blocked;}
 byId('dk-limit').textContent=blocked?'Doing is full: '+busy+' of '+doingLimit+'. Finish or move a task first.':'Doing holds at most '+doingLimit+' tasks at once.';
 const list=byId('dk-check');list.replaceChildren();
 for(const item of task.check){
  const label=make('label',undefined,{class:'choice'}),box=make('input',undefined,{type:'checkbox'});
  box.checked=item[1];if(item[1])box.setAttribute('checked','');
  box.addEventListener('change',()=>{item[1]=box.checked;progress(task);});
  label.append(box,make('span',item[0]));list.append(label);
 }
 progress(task);
}
for(const input of document.querySelectorAll('input[name="dk-status"]'))input.addEventListener('change',()=>{
 const task=tasks.find(t=>t.id===picked);task.status=input.value;drawBoard();drawInspector();
 byId('dk-msg').textContent='Moved '+task.id+' to '+lanes.find(l=>l[0]===task.status)[1]+' in this preview only.';
});
drawBoard();drawInspector();
