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

// This document is the owner. A drag is a private candidate until pointer-up;
// cancellation discards it. History holds at most 30 snapshots of 12 small objects.
let state={selected:1,objects:[{id:1,kind:'text',label:'Make room.',x:5,y:6},{id:2,kind:'block',label:'For an idea.',x:48,y:44}]};
let nextId=3, drag=null;
const past=[],future=[];
const copy=value=>({selected:value.selected,objects:value.objects.map(o=>({...o}))});
const object=()=>state.objects.find(o=>o.id===state.selected);
const clamp=(value,max)=>Math.min(max,Math.max(0,Math.round(value)));
function valid(candidate){
 return candidate.objects.length<=12 && new Set(candidate.objects.map(o=>o.id)).size===candidate.objects.length &&
 candidate.objects.every(o=>['text','block'].includes(o.kind)&&typeof o.label==='string'&&o.label.trim().length>0&&o.label.length<=32&&Number.isInteger(o.x)&&o.x>=0&&o.x<=50&&Number.isInteger(o.y)&&o.y>=0&&o.y<=45);
}
function commit(candidate,message){
 if(!valid(candidate)){byId('canvas-status').textContent='Invalid object edit. The previous state is unchanged.';return false;}
 if(JSON.stringify(candidate.objects)===JSON.stringify(state.objects))return false;
 past.push(copy(state));if(past.length>30)past.shift();future.length=0;
 state=copy(candidate);renderCanvas();byId('canvas-status').textContent=message+' Local preview only.';return true;
}
function updateInspector(){
 const selected=object();byId('selection-empty').hidden=!!selected;byId('inspector-form').hidden=!selected;
 byId('selection-title').textContent=selected?'Object '+selected.id:'Nothing selected';
 if(selected){byId('object-label').value=selected.label;byId('object-x').value=String(selected.x);byId('object-y').value=String(selected.y);}
 byId('delete-object').disabled=!selected;
}
function selectObject(id){
 state.selected=id;
 for(const node of byId('artboard').querySelectorAll('[data-object-id]'))node.setAttribute('aria-pressed',String(Number(node.dataset.objectId)===id));
 updateInspector();
}
function focusSelected(){
 const node=byId('artboard').querySelector('[data-object-id="'+state.selected+'"]');
 (node||byId('add-note')).focus();
}
function renderCanvas(){
 byId('artboard').replaceChildren();
 for(const item of state.objects){
  const node=make('button',undefined,{class:'canvas-object','data-object-id':item.id,'data-kind':item.kind,'aria-label':'Select object '+item.id+': '+item.label,'aria-pressed':item.id===state.selected});
  node.style.left=item.x+'%';node.style.top=item.y+'%';
  node.append(make('small',(item.kind==='text'?'NOTE':'BLOCK')+' / '+String(item.id).padStart(2,'0')),make('strong',item.label));
  byId('artboard').append(node);
 }
 byId('object-count').textContent=state.objects.length+' objects';
 byId('canvas-undo').disabled=!past.length;byId('canvas-redo').disabled=!future.length;
 byId('add-note').disabled=byId('add-block').disabled=state.objects.length>=12;
 updateInspector();
}
function addObject(kind){
 if(state.objects.length>=12)return;
 const candidate=copy(state),id=nextId++;
 candidate.objects.push({id,kind,label:kind==='text'?'New thought':'New block',x:10+(state.objects.length%3)*12,y:10+(state.objects.length%3)*12});candidate.selected=id;
 commit(candidate,'Object added.');focusSelected();
}
byId('add-note').addEventListener('click',()=>addObject('text'));
byId('add-block').addEventListener('click',()=>addObject('block'));
byId('delete-object').addEventListener('click',()=>{
 if(!object())return;const candidate=copy(state);candidate.objects=candidate.objects.filter(o=>o.id!==state.selected);candidate.selected=candidate.objects.at(-1)?.id||null;
 commit(candidate,'Object deleted. Undo is available.');focusSelected();
});
byId('inspector-form').addEventListener('submit',event=>{
 event.preventDefault();if(!object()||!event.currentTarget.reportValidity())return;
 const candidate=copy(state),target=candidate.objects.find(o=>o.id===state.selected);
 target.label=byId('object-label').value.trim();target.x=Number(byId('object-x').value);target.y=Number(byId('object-y').value);
 commit(candidate,'Object changes applied.');
});
function travel(from,to,message){
 if(!from.length)return;drag=null;to.push(copy(state));if(to.length>30)to.shift();state=from.pop();renderCanvas();byId('canvas-status').textContent=message+' Local preview only.';
}
byId('canvas-undo').addEventListener('click',()=>{travel(past,future,'Edit undone.');focusSelected();});
byId('canvas-redo').addEventListener('click',()=>{travel(future,past,'Edit restored.');focusSelected();});
byId('artboard').addEventListener('click',event=>{const target=event.target.closest('[data-object-id]');if(target)selectObject(Number(target.dataset.objectId));});
// Keyboard focus is a selection too; arrows must never move a different object
// just because the user reached this one with Tab rather than a pointer click.
byId('artboard').addEventListener('focusin',event=>{const target=event.target.closest('[data-object-id]');if(target)selectObject(Number(target.dataset.objectId));});
byId('artboard').addEventListener('keydown',event=>{
 const delta={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key];
 if(!delta || !object())return;event.preventDefault();
 const candidate=copy(state),target=candidate.objects.find(o=>o.id===state.selected);target.x=clamp(target.x+delta[0],50);target.y=clamp(target.y+delta[1],45);
 commit(candidate,'Object moved.');focusSelected();
});
byId('artboard').addEventListener('pointerdown',event=>{
 const node=event.target.closest('[data-object-id]');if(!node || event.button!==0)return;
 selectObject(Number(node.dataset.objectId));const bounds=byId('artboard').getBoundingClientRect();
 drag={id:state.selected,pointer:event.pointerId,startX:event.clientX,startY:event.clientY,initial:{...object()},candidate:{...object()},width:bounds.width,height:bounds.height};
 byId('artboard').setPointerCapture(event.pointerId);
});
byId('artboard').addEventListener('pointermove',event=>{
 if(!drag || event.pointerId!==drag.pointer)return;
 drag.candidate.x=clamp(drag.initial.x+(event.clientX-drag.startX)*100/drag.width,50);
 drag.candidate.y=clamp(drag.initial.y+(event.clientY-drag.startY)*100/drag.height,45);
 const node=byId('artboard').querySelector('[data-object-id="'+drag.id+'"]');node.style.left=drag.candidate.x+'%';node.style.top=drag.candidate.y+'%';
});
byId('artboard').addEventListener('pointerup',event=>{
 if(!drag || event.pointerId!==drag.pointer)return;
 const prepared=drag;drag=null;byId('artboard').releasePointerCapture(event.pointerId);
 const candidate=copy(state),target=candidate.objects.find(o=>o.id===prepared.id);
 if(target && target.x===prepared.initial.x && target.y===prepared.initial.y){Object.assign(target,prepared.candidate);commit(candidate,'Object moved.');}
 focusSelected();
});
function cancelDrag(){
 if(!drag)return;const pointer=drag.pointer;drag=null;
 if(byId('artboard').hasPointerCapture(pointer))byId('artboard').releasePointerCapture(pointer);
 renderCanvas();byId('canvas-status').textContent='Drag cancelled. No object change committed.';focusSelected();
}
byId('artboard').addEventListener('pointercancel',cancelDrag);
byId('artboard').addEventListener('lostpointercapture',cancelDrag);
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&drag){event.preventDefault();cancelDrag();}});
renderCanvas();
