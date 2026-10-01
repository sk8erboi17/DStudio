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

// Larder: servings rescale every quantity; ingredients and steps are ticked locally.
const baseServings=4;let servings=4;
const pantry=[
 {q:400,unit:'g',name:'cherry tomatoes'},
 {q:2,unit:'',one:'tin of white beans, drained',many:'tins of white beans, drained'},
 {q:1,unit:'',one:'large onion, sliced',many:'large onions, sliced'},
 {q:4,unit:'',one:'garlic clove, sliced',many:'garlic cloves, sliced'},
 {q:3,unit:'tbsp',name:'olive oil'},
 {q:1,unit:'tsp',name:'smoked paprika'},
 {q:150,unit:'ml',name:'vegetable stock'},
 {q:60,unit:'g',name:'coarse breadcrumbs'},
 {q:1,unit:'',one:'small bunch of parsley',many:'small bunches of parsley'}
];
const method=[
 'Heat the oven to 200 °C. Warm the oil in a wide ovenproof pan over a medium heat.',
 'Soften the onion with a pinch of salt for about 8 minutes, then add the garlic and paprika for 1 minute.',
 'Add the tomatoes and stock; simmer until the tomatoes begin to burst, about 6 minutes.',
 'Stir in the beans, season, and scatter the breadcrumbs over the top.',
 'Bake until the crumbs are golden and the sauce bubbles at the edges, about 15 minutes.',
 'Rest for 5 minutes and finish with chopped parsley.'
].map(text=>({text,done:false}));
const nice=(value,unit)=>{
 if(unit==='g'||unit==='ml')return Math.max(5,value>=100?Math.round(value/10)*10:Math.round(value/5)*5)+' '+unit;
 const quarters=Math.max(1,Math.round(value*4)),whole=Math.floor(quarters/4),part=['','¼','½','¾'][quarters%4];
 return (whole?String(whole):'')+part+(unit?' '+unit:'');
};
function gathered(){byId('ld-gathered').textContent=pantry.filter(i=>i.got).length+' of '+pantry.length+' gathered';}
function drawIngredients(){
 const list=byId('ld-list');list.replaceChildren();
 for(const item of pantry){
  const value=item.q*servings/baseServings,row=make('li'),label=make('label',undefined,{class:'choice'}),box=make('input',undefined,{type:'checkbox'});
  box.checked=!!item.got;if(item.got)box.setAttribute('checked','');
  box.addEventListener('change',()=>{item.got=box.checked;gathered();});
  const text=make('span');text.append(make('strong',nice(value,item.unit),{class:'qty'}),document.createTextNode(' '+(item.name||(value<=1?item.one:item.many))));
  label.append(box,text);row.append(label);list.append(row);
 }
 gathered();
}
function drawSteps(){
 const list=byId('ld-steps');list.replaceChildren();
 const next=method.findIndex(s=>!s.done);
 for(const [i,step] of method.entries()){
  const row=make('li',undefined,{class:'method-step','data-done':step.done,'data-now':i===next}),body=make('div');
  if(i===next)body.append(make('span','Now',{class:'now-tag'}));
  body.append(make('p',step.text));
  const label=make('label',undefined,{class:'choice'}),box=make('input',undefined,{type:'checkbox','aria-label':'Step '+(i+1)+' done'});
  box.checked=step.done;if(step.done)box.setAttribute('checked','');
  box.addEventListener('change',()=>{step.done=box.checked;drawSteps();byId('ld-steps').children[i].querySelector('input').focus();});
  label.append(box,make('span','Done'));body.append(label);
  row.append(make('span',String(i+1),{class:'step-no','aria-hidden':true}),body);list.append(row);
 }
 const done=method.filter(s=>s.done).length;
 byId('ld-progress').textContent=done===method.length?'All '+method.length+' steps done.':done+' of '+method.length+' steps done · next: step '+(next+1);
}
function syncServings(){
 byId('ld-servings').textContent=String(servings);byId('ld-serves').textContent='serves '+servings;
 byId('ld-less').setAttribute('aria-disabled',String(servings<=1));byId('ld-more').setAttribute('aria-disabled',String(servings>=12));
}
for(const [id,delta] of [['ld-less',-1],['ld-more',1]])byId(id).addEventListener('click',()=>{
 const next=servings+delta;
 if(next<1||next>12){byId('ld-serv-msg').textContent=(next<1?'One serving is the smallest':'Twelve servings is the largest')+' this recipe scales to.';return;}
 servings=next;syncServings();drawIngredients();
 byId('ld-serv-msg').textContent='Quantities rescaled for '+servings+(servings===1?' serving':' servings')+' and rounded.';
});
syncServings();drawIngredients();drawSteps();
