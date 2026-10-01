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

// Atlas: one selection shared by map and list, and a bounded, reorderable local route.
// One selection and one bounded route over four fixed places. Both map and list
// are derived from these values; filtering never rewrites the itinerary.
const places=[
 {id:'bookshop',name:'The Corner Bookshop',type:'indoor',x:27,y:25,description:'Shelves, a reading table and time to browse.',note:'Illustrative visit: 20 minutes'},
 {id:'courtyard',name:'Willow Courtyard',type:'quiet',x:55,y:43,description:'A shaded square set back from the street.',note:'Illustrative visit: 15 minutes'},
 {id:'gallery',name:'North Gallery',type:'indoor',x:24,y:72,description:'A small room for local prints and drawings.',note:'Illustrative visit: 30 minutes'},
 {id:'riverside',name:'Riverside Steps',type:'quiet',x:77,y:75,description:'An open place to sit beside the water.',note:'Illustrative visit: 10 minutes'}
];
let selected='bookshop';const route=[];
function selectPlace(id){
 selected=id;
 for(const button of document.querySelectorAll('[data-map-place]'))button.setAttribute('aria-pressed',String(button.dataset.mapPlace===id));
 for(const card of document.querySelectorAll('[data-place-card]'))card.dataset.selected=String(card.dataset.placeCard===id);
 for(const button of document.querySelectorAll('[data-select-place]'))button.setAttribute('aria-pressed',String(button.dataset.selectPlace===id));
 byId('map-selection').textContent='Selected: '+places.find(p=>p.id===id).name+'.';
}
function drawRoute(){
 byId('route-list').replaceChildren();
 for(const [index,id] of route.entries()){
  const place=places.find(p=>p.id===id),row=make('li',undefined,{class:'route-stop'}),tools=make('div',undefined,{class:'route-tools'});
  row.append(make('strong',(index+1)+'. '+place.name));
  for(const [label,delta,glyph] of [['Move earlier',-1,'↑'],['Move later',1,'↓'],['Remove',0,'×']]){
   const button=make('button',glyph,{type:'button','aria-label':label+' '+place.name,title:label});
   button.disabled=(delta===-1&&index===0)||(delta===1&&index===route.length-1);
   button.addEventListener('click',()=>{
    if(delta)[route[index],route[index+delta]]=[route[index+delta],route[index]];else route.splice(index,1);
    drawRoute();byId('route-status').textContent=label+': '+place.name+'. Local route updated.';
    if(route.length)byId('reset-route').focus();else document.querySelector('[data-add-place]').focus();
   });
   tools.append(button);
  }
  row.append(tools);byId('route-list').append(row);
 }
 byId('map-route').setAttribute('points',route.map(id=>{const p=places.find(p=>p.id===id);return p.x*6+','+p.y*4.2;}).join(' '));
 byId('route-empty').hidden=route.length>0;byId('reset-route').disabled=route.length===0;
 for(const button of document.querySelectorAll('[data-add-place]')){button.disabled=route.includes(button.dataset.addPlace);button.textContent=button.disabled?'In route':'+ Add to route';}
}
for(const [index,place] of places.entries()){
 const pin=make('button',String(index+1),{type:'button',class:'map-pin','data-map-place':place.id,'aria-label':'Select '+place.name+' on map','aria-pressed':false});
 pin.style.left=place.x+'%';pin.style.top=place.y+'%';pin.addEventListener('click',()=>selectPlace(place.id));byId('atlas-map').append(pin);
 const row=make('li',undefined,{class:'place-row','data-place-card':place.id});
 const name=make('button',place.name,{type:'button',class:'place-name','data-select-place':place.id,'aria-pressed':false,'aria-label':'Show '+place.name+' on map'});
 name.addEventListener('click',()=>selectPlace(place.id));
 const add=make('button','+ Add to route',{type:'button',class:'add-stop','data-add-place':place.id,'aria-label':'Add '+place.name+' to route'});
 add.addEventListener('click',()=>{if(!route.includes(place.id))route.push(place.id);drawRoute();byId('route-status').textContent=place.name+' added. '+route.length+' stops in your local route.';name.focus();});
 row.append(make('span',String(index+1).padStart(2,'0'),{class:'no','aria-hidden':true}),name,add,make('p',place.description),make('small',place.note));
 byId('place-list').append(row);
}
byId('place-filter').addEventListener('change',event=>{
 const type=event.target.value,shown=places.filter(p=>type==='all'||p.type===type);
 for(const place of places){const visible=shown.includes(place);document.querySelector('[data-place-card="'+place.id+'"]').hidden=!visible;document.querySelector('[data-map-place="'+place.id+'"]').hidden=!visible;}
 if(!shown.some(p=>p.id===selected))selectPlace(shown[0].id);
});
byId('reset-route').addEventListener('click',()=>{route.length=0;drawRoute();byId('route-status').textContent='Route reset. No booking was changed.';document.querySelector('[data-add-place]').focus();});
selectPlace(selected);drawRoute();
