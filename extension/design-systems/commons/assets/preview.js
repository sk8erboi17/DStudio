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

// Commons: fixed example threads, local replies (plain text only) and a reversible review queue.
// Fixed fixtures plus at most ten 500-character replies per thread. No network.
const threads=[
  {id:'bookbinding',title:'A first notebook, made together',author:'Ada Lane',initials:'AL',topic:'Making',body:'I am putting together a beginner bookbinding afternoon. What would make a first session feel welcoming?',replies:['A small practice fold before starting the cover would help.']},
  {id:'garden',title:'A little shade for the shared courtyard',author:'Mo Torres',initials:'MT',topic:'Neighborhood',body:'Which plants would you choose for a small, shaded courtyard? We are collecting ideas, not a final planting plan.',replies:['Start by noting where the light reaches in the morning.']},
  {id:'repair',title:'What is on your repair bench?',author:'Rae Park',initials:'RP',topic:'Repair',body:'A wobbly chair, a loose jacket button, a stubborn lamp. Share the small repair you want to understand.',replies:[]}
];
let currentThread=null, threadOpener=null;
function communityView(name){
  for(const panel of document.querySelectorAll('[data-community-panel]'))panel.hidden=panel.dataset.communityPanel!==name;
  for(const button of document.querySelectorAll('[data-community-view]'))button.setAttribute('aria-pressed',String(button.dataset.communityView===name));
}
for(const button of document.querySelectorAll('[data-community-view]'))button.addEventListener('click',()=>communityView(button.dataset.communityView));
byId('join-community').addEventListener('click',event=>{
  const joined=event.currentTarget.getAttribute('aria-pressed')!=='true';
  event.currentTarget.setAttribute('aria-pressed',String(joined));
  event.currentTarget.textContent=joined?'Leave preview community':'Join preview community';
  byId('membership-status').textContent=joined?'Joined locally. No account created.':'Left locally. No account changed.';
});
function showReplies(){
  byId('reply-list').replaceChildren(...currentThread.replies.map(text=>make('li',text)));
  byId('reply-form').querySelector('button').disabled=currentThread.replies.length>=10;
}
function openThread(id,opener){
  currentThread=threads.find(t=>t.id===id);threadOpener=opener;communityView('discussions');
  byId('discussion-index').hidden=true;byId('thread-detail').hidden=false;
  byId('thread-title').textContent=currentThread.title;byId('thread-body').textContent=currentThread.body;
  byId('reply-text').value='';byId('reply-status').textContent='';showReplies();byId('thread-title').focus();
}
for(const button of document.querySelectorAll('[data-thread-open]'))button.addEventListener('click',()=>openThread(button.dataset.threadOpen,button));
function renderThreads(){
  byId('thread-list').replaceChildren();
  const query=byId('thread-search').value.trim().toLowerCase();
  const filtered=threads.filter(t=>(t.title+' '+t.topic+' '+t.author+' '+t.body+' '+t.id).toLowerCase().includes(query));
  for(const thread of filtered){
    const row=make('article',undefined,{class:'thread-row'}),n=thread.replies.length;
    const open=make('button',thread.title,{type:'button',class:'thread-title','aria-label':'Open '+thread.title});
    open.addEventListener('click',()=>openThread(thread.id,open));
    row.append(make('span',thread.initials,{class:'avatar','aria-hidden':true,'data-tone':threads.indexOf(thread)%4+1}),open,make('span',n+(n===1?' reply':' replies'),{class:'thread-count'}),make('p',thread.body),make('p',thread.author+' · '+thread.topic,{class:'thread-by'}));
    byId('thread-list').append(row);
  }
  byId('thread-empty').hidden=filtered.length>0;
  byId('thread-filter-status').textContent=filtered.length+(filtered.length===1?' discussion':' discussions')+' shown.';
}
byId('thread-search').addEventListener('input',renderThreads);
byId('back-threads').addEventListener('click',()=>{byId('thread-detail').hidden=true;byId('discussion-index').hidden=false;renderThreads();if(threadOpener?.isConnected)threadOpener.focus();else byId('thread-search').focus();});
byId('reply-form').addEventListener('submit',event=>{
  event.preventDefault();if(!currentThread || !event.currentTarget.reportValidity())return;
  const text=byId('reply-text').value.trim();
  if(!text || text.length>500){byId('reply-status').textContent='Write a reply of 1–500 characters before adding it.';return;}
  if(currentThread.replies.length>=10){byId('reply-status').textContent='Preview limit: ten replies per thread.';return;}
  currentThread.replies.push(text);byId('reply-text').value='';showReplies();byId('reply-status').textContent='Reply added locally. Nothing was published.';
});
const reports=[{title:'Duplicate workshop announcement',context:'Check whether two fixture posts describe the same event.',resolved:false},{title:'Missing image description',context:'The example report asks for context, not removal of the author.',resolved:false}];
for(const item of reports){
  const row=make('article',undefined,{class:'report'}),status=make('p','Awaiting local review',{class:'report-state'});
  const button=make('button','Resolve locally',{type:'button',class:'link-btn','aria-label':'Resolve '+item.title});
  button.addEventListener('click',()=>{
    item.resolved=!item.resolved;status.textContent=item.resolved?'Resolved in preview':'Awaiting local review';
    button.textContent=item.resolved?'Restore to queue':'Resolve locally';button.setAttribute('aria-label',(item.resolved?'Restore ':'Resolve ')+item.title);
    byId('review-status').textContent=reports.filter(r=>!r.resolved).length+' reports awaiting review. No real content changed.';
  });
  row.append(make('h3',item.title),button,make('p',item.context),status);byId('review-list').append(row);
}
renderThreads();
