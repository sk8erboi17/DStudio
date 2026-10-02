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

// Relay: one open conversation; replies are appended as text, never as HTML.
const convos=[
 {id:'mira',who:'Mira Okafor',about:'Studio lease · 2 people',unread:2,messages:[{day:'Tuesday 14 October'},{from:'Mira',time:'09:02',text:'Morning! The landlord sent the revised lease, with the heating clause we asked for.'},{from:'Mira',time:'09:14',text:'Could we move the walkthrough to Thursday? Ten o’clock works for me.'}]},
 {id:'halden',who:'Halden Print Works',about:'Proofs for issue 7',unread:0,messages:[{day:'Monday 13 October'},{from:'Halden',time:'16:40',text:'The proofs are ready for collection after four. Page 12 still shows the old caption.'},{from:'You',me:true,time:'16:52',text:'Thank you — I’ll come by tomorrow with the corrected caption.'}]},
 {id:'jonas',who:'Jonas Weber',about:'Saturday ride',unread:1,messages:[{day:'Sunday 12 October'},{from:'Jonas',time:'19:30',text:'Route is 48 km, mostly flat, with a coffee stop at the lock. Leaving at eight.'}]},
 {id:'team',who:'Studio team',about:'Week planning · 4 people',unread:0,messages:[{day:'Friday 10 October'},{from:'Ana',time:'11:05',text:'Monday’s agenda is in the shared notes: the lease, then the print schedule.'},{from:'You',me:true,time:'11:20',text:'Added the delivery dates. Shall we keep it to thirty minutes?'},{from:'Ana',time:'11:22',text:'Thirty minutes, standing up.'}]}
];
let openConvo='mira';
const clip=text=>text.length>86?text.slice(0,84).trimEnd()+'…':text;
function renderConvos(){
 const q=byId('rl-search').value.trim().toLowerCase(),list=byId('rl-convos');let shown=0;list.replaceChildren();
 for(const c of convos){
  if(q&&!(c.who+' '+c.about+' '+c.messages.map(m=>m.text||'').join(' ')).toLowerCase().includes(q))continue;
  shown++;
  const last=c.messages.filter(m=>m.text).pop();
  const row=make('li',undefined,{class:'convo','data-unread':c.unread>0});
  const open=make('button',undefined,{type:'button',class:'convo-open','aria-pressed':c.id===openConvo,'aria-label':'Open conversation with '+c.who+(c.unread?', '+c.unread+' new':'')});
  open.append(make('span',c.who,{class:'convo-who'}),make('span',last.time,{class:'convo-time'}),make('span',clip((last.me?'You: ':'')+last.text),{class:'convo-snippet'}));
  if(c.unread)open.append(make('span',c.unread+' new',{class:'convo-new'}));
  open.addEventListener('click',()=>{openConvo=c.id;c.unread=0;byId('rl-status').textContent='';renderConvos();renderThread();list.querySelector('[aria-pressed="true"]')?.focus();});
  row.append(open);list.append(row);
 }
 const unread=convos.filter(c=>c.unread).length;
 byId('rl-count').textContent=(q?shown+' of '+convos.length:convos.length)+' conversations · '+(unread?unread+' unread':'all read');
 byId('rl-empty').hidden=shown>0;
}
function renderThread(){
 const c=convos.find(x=>x.id===openConvo),list=byId('rl-transcript');list.replaceChildren();
 byId('rl-title').textContent=c.who;byId('rl-sub').textContent=c.about;byId('rl-text-label').textContent='Reply to '+c.who;
 for(const m of c.messages){
  if(m.day){list.append(make('li',m.day,{class:'day'}));continue;}
  const li=make('li',undefined,{class:'msg','data-me':!!m.me}),meta=make('p',undefined,{class:'msg-meta'});
  meta.append(make('strong',m.from),make('time',m.time));li.append(meta,make('p',m.text,{class:'msg-body'}));list.append(li);
 }
}
byId('rl-search').addEventListener('input',renderConvos);
byId('rl-mark').addEventListener('click',()=>{convos.find(x=>x.id===openConvo).unread=1;renderConvos();byId('rl-status').textContent='Marked unread in this preview.';});
const reply=byId('rl-text');
reply.addEventListener('input',()=>{if(reply.value.trim()){reply.removeAttribute('aria-invalid');byId('rl-error').hidden=true;}});
byId('rl-compose').addEventListener('submit',event=>{
 event.preventDefault();
 const text=reply.value.trim();
 const c=convos.find(x=>x.id===openConvo);
 const problem=!text?'Write something before sending.':text.length>1000?'Keep a preview reply within 1000 characters.':(c.addedReplies||0)>=20?'This conversation holds at most 20 new preview replies. Your draft was kept.':'';
 if(problem){reply.setAttribute('aria-invalid','true');byId('rl-error').textContent=problem;byId('rl-error').hidden=false;byId('rl-status').textContent='';reply.focus();return;}
 c.addedReplies=(c.addedReplies||0)+1;
 if(!c.messages.some(m=>m.day==='Today'))c.messages.push({day:'Today'});
 c.messages.push({from:'You',me:true,time:'Now',text});reply.value='';reply.removeAttribute('aria-invalid');byId('rl-error').hidden=true;
 renderThread();renderConvos();byId('rl-status').textContent='Added to this preview only. Nothing was delivered.';
});
convos[0].unread=0;renderConvos();renderThread();
