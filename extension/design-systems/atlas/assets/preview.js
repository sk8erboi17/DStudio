// Local catalog preview. All state belongs to this document and is lost on reload.
// There are no requests, account changes, purchases or durable saves.
const root = document.documentElement;
const theme = document.querySelector('[data-theme-toggle]');
theme.addEventListener('click', () => {
  const dark = root.dataset.theme !== 'dark';
  root.dataset.theme = dark ? 'dark' : 'light';
  theme.setAttribute('aria-pressed', String(dark));
  theme.textContent = dark ? 'Light appearance' : 'Dark appearance';
});
for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => {
  for (const b of document.querySelectorAll('[data-view]')) b.setAttribute('aria-pressed', String(b === button));
  for (const panel of document.querySelectorAll('[data-panel]')) panel.hidden = panel.dataset.panel !== button.dataset.view;
});
for (const dialog of document.querySelectorAll('dialog')) {
  let opener;
  dialog.addEventListener('close', () => opener?.focus());
  for (const button of document.querySelectorAll('[data-dialog="'+dialog.id+'"]')) button.addEventListener('click', () => {
    opener = button; dialog.showModal();
  });
  for (const button of dialog.querySelectorAll('[data-close]')) button.addEventListener('click', () => dialog.close());
}
const requestDialog = document.querySelector('#request-dialog');
let requestOpener;
for (const button of document.querySelectorAll('[data-open]')) button.addEventListener('click', () => {
  requestOpener = button;
  document.querySelector('#request-topic').value = button.dataset.open;
  document.querySelector('#request-status').textContent = '';
  requestDialog.showModal();
});
requestDialog.addEventListener('close', () => requestOpener?.focus());
document.querySelector('#request-form').addEventListener('submit', event => {
  event.preventDefault();
  if (event.currentTarget.reportValidity()) document.querySelector('#request-status').textContent = 'Preview complete. Nothing was sent or booked.';
});
const byId = id => document.getElementById(id);
const make = (tag, text, attributes = {}) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  return node;
};

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
  const place=places.find(p=>p.id===id),row=make('li',undefined,{class:'route-stop'}),controls=make('div',undefined,{class:'actions'});
  row.append(make('strong',(index+1)+'. '+place.name));
  for(const [label,delta] of [['Move earlier',-1],['Move later',1],['Remove',0]]){
   const button=make('button',label,{class:'btn secondary','aria-label':label+' '+place.name});
   button.disabled=(delta===-1 && index===0)||(delta===1 && index===route.length-1);
   button.addEventListener('click',()=>{
    if(delta)[route[index],route[index+delta]]=[route[index+delta],route[index]];
    else route.splice(index,1);
    drawRoute();byId('route-status').textContent=label+': '+place.name+'. Local route updated.';
    if(route.length)byId('reset-route').focus();else document.querySelector('[data-add-place]').focus();
   });
   controls.append(button);
  }
  row.append(controls);byId('route-list').append(row);
 }
 byId('map-route').setAttribute('points',route.map(id=>{const p=places.find(p=>p.id===id);return p.x*6+','+p.y*4.2;}).join(' '));
 byId('route-empty').hidden=route.length>0;byId('reset-route').disabled=route.length===0;
 for(const button of document.querySelectorAll('[data-add-place]')){button.disabled=route.includes(button.dataset.addPlace);button.textContent=button.disabled?'Added to route':'Add to route';}
}
for(const [index,place] of places.entries()){
 const pin=make('button',String(index+1),{class:'map-pin','data-map-place':place.id,'aria-label':'Select '+place.name+' on map','aria-pressed':false});
 pin.style.left=place.x+'%';pin.style.top=place.y+'%';pin.addEventListener('click',()=>selectPlace(place.id));byId('atlas-map').append(pin);
 const card=make('article',undefined,{class:'place-card','data-place-card':place.id});
 const controls=make('div',undefined,{class:'actions'}),select=make('button','Show on map',{class:'btn secondary','data-select-place':place.id,'aria-pressed':false,'aria-label':'Show '+place.name+' on map'});
 select.addEventListener('click',()=>selectPlace(place.id));
 const add=make('button','Add to route',{class:'btn','data-add-place':place.id,'aria-label':'Add '+place.name+' to route'});
 add.addEventListener('click',()=>{if(!route.includes(place.id))route.push(place.id);drawRoute();byId('route-status').textContent=place.name+' added. '+route.length+' stops in your local route.';select.focus();});
 controls.append(select,add);card.append(make('h2',(index+1)+'. '+place.name),make('p',place.description),make('small',place.note),controls);byId('place-list').append(card);
}
byId('place-filter').addEventListener('change',event=>{
 const type=event.target.value,shown=places.filter(p=>type==='all'||p.type===type);
 for(const place of places){const visible=shown.includes(place);document.querySelector('[data-place-card="'+place.id+'"]').hidden=!visible;document.querySelector('[data-map-place="'+place.id+'"]').hidden=!visible;}
 if(!shown.some(p=>p.id===selected))selectPlace(shown[0].id);
});
byId('reset-route').addEventListener('click',()=>{route.length=0;drawRoute();byId('route-status').textContent='Route reset. No booking was changed.';document.querySelector('[data-add-place]').focus();});
selectPlace(selected);drawRoute();
