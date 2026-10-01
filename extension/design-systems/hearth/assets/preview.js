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

// Hearth: one room at a time. Switches, brightness, target heat and scenes change local state only.
const rooms={
 living:{name:'Living room',now:19.5,target:21,devices:[{id:'ceiling',name:'Ceiling light',kind:'light',on:true,level:40},{id:'lamp',name:'Floor lamp',kind:'light',on:true,level:40},{id:'tv',name:'Television socket',kind:'plug',on:false}]},
 kitchen:{name:'Kitchen',now:20.5,target:20,devices:[{id:'pendant',name:'Pendant lights',kind:'light',on:true,level:80},{id:'under',name:'Under-cabinet strip',kind:'light',on:false,level:50},{id:'kettle',name:'Kettle socket',kind:'plug',on:false}]},
 bedroom:{name:'Bedroom',now:18,target:18.5,devices:[{id:'bedside',name:'Bedside lamp',kind:'light',on:false,level:30},{id:'rail',name:'Towel rail',kind:'plug',on:true}]}
};
let roomKey='living';
const degrees=t=>t.toFixed(1)+' °C';
const stateText=d=>d.kind==='light'?(d.on?d.level+'% brightness':'Off'):(d.on?'Socket on':'Socket off');
function roomSummary(message){
 const room=rooms[roomKey],on=room.devices.filter(d=>d.on).length;
 byId('ht-room-sub').textContent=on+' of '+room.devices.length+' on · '+degrees(room.now)+' now';
 if(message)byId('ht-msg').textContent=message;
}
function drawClimate(message){
 const room=rooms[roomKey];
 byId('ht-target').textContent=room.target.toFixed(1);byId('ht-now').textContent='Now '+degrees(room.now);
 byId('ht-dial').style.setProperty('--pct',String((room.target-16)/8));
 byId('ht-lower').setAttribute('aria-disabled',String(room.target<=16));byId('ht-raise').setAttribute('aria-disabled',String(room.target>=24));
 byId('ht-climate-note').textContent=(room.target>room.now?'Heating to ':'Holding at ')+degrees(room.target)+'. Range 16–24 °C.';
 if(message)byId('ht-msg').textContent=message;
}
function drawRoom(){
 const room=rooms[roomKey],list=byId('ht-devices');list.replaceChildren();
 for(const button of document.querySelectorAll('[data-room]'))button.setAttribute('aria-pressed',String(button.dataset.room===roomKey));
 byId('ht-room-title').textContent=room.name;
 for(const d of room.devices){
  const row=make('li',undefined,{class:'device'}),text=make('div'),state=make('span',stateText(d),{class:'device-state'});
  text.append(make('strong',d.name),state);
  const toggle=make('button',undefined,{type:'button',role:'switch',class:'switch','aria-checked':d.on,'aria-label':d.name}),word=make('span',d.on?'On':'Off',{class:'switch-text'});
  toggle.append(make('span',undefined,{class:'switch-track','aria-hidden':true}),word);
  row.append(text,toggle);
  let dim=null;
  if(d.kind==='light'){
   const id='dim-'+d.id,input=make('input',undefined,{type:'range',id,min:5,max:100,step:5,value:d.level});
   dim=make('div',undefined,{class:'field device-dim'});dim.append(make('label',d.name+' brightness',{for:id}),input);dim.hidden=!d.on;
   input.addEventListener('input',()=>{d.level=Number(input.value);state.textContent=stateText(d);});
   row.append(dim);
  }
  toggle.addEventListener('click',()=>{
   d.on=!d.on;toggle.setAttribute('aria-checked',String(d.on));word.textContent=d.on?'On':'Off';state.textContent=stateText(d);if(dim)dim.hidden=!d.on;
   roomSummary(d.name+' turned '+(d.on?'on':'off')+' in this preview. No device was changed.');
  });
  list.append(row);
 }
 drawClimate();roomSummary();
}
for(const [id,delta] of [['ht-lower',-.5],['ht-raise',.5]])byId(id).addEventListener('click',()=>{
 const room=rooms[roomKey],next=room.target+delta;
 if(next<16||next>24){drawClimate((delta<0?'16.0 °C is the lowest':'24.0 °C is the highest')+' target in this preview.');return;}
 room.target=next;drawClimate('Target '+degrees(next)+' for the '+room.name.toLowerCase()+'. Nothing was sent to a thermostat.');
});
for(const button of document.querySelectorAll('[data-room]'))button.addEventListener('click',()=>{roomKey=button.dataset.room;byId('ht-msg').textContent='';drawRoom();});
const scenes={evening:{lights:40,target:21},reading:{lights:80,target:21.5},away:{lights:0,target:16}};
for(const input of document.querySelectorAll('input[name="ht-scene"]'))input.addEventListener('change',()=>{
 const scene=scenes[input.value];
 for(const room of Object.values(rooms)){room.target=scene.target;for(const d of room.devices)if(d.kind==='light'){d.on=scene.lights>0;if(scene.lights)d.level=scene.lights;}}
 drawRoom();byId('ht-msg').textContent=input.parentElement.querySelector('span').textContent.split(' · ')[0]+' scene set in this preview. No device was changed.';
});
for(const sample of document.querySelectorAll('[data-sample-switch]'))sample.addEventListener('click',()=>{const on=sample.getAttribute('aria-checked')!=='true';sample.setAttribute('aria-checked',String(on));sample.querySelector('.switch-text').textContent=on?'On':'Off';});
drawRoom();
