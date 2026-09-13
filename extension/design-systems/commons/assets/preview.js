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
    const row=make('article',undefined,{class:'thread-card'}),byline=make('div',undefined,{class:'thread-byline'});
    const who=make('div');who.append(make('strong',thread.author),make('small','Example member'));
    byline.append(make('span',thread.initials,{class:'avatar','aria-hidden':true}),who);
    const meta=make('div',undefined,{class:'thread-meta'}),open=make('button','Open discussion',{class:'btn secondary','aria-label':'Open '+thread.title});
    open.addEventListener('click',()=>openThread(thread.id,open));
    meta.append(make('span',thread.topic,{class:'topic'}),make('span',thread.replies.length+(thread.replies.length===1?' reply':' replies'),{class:'muted'}),open);
    row.append(byline,make('h2',thread.title),make('p',thread.body),meta);byId('thread-list').append(row);
  }
  byId('thread-empty').hidden=filtered.length>0;byId('thread-filter-status').textContent=filtered.length+' discussions shown.';
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
  const card=make('article',undefined,{class:'context-card'}),status=make('p','Awaiting local review'),button=make('button','Resolve locally',{class:'btn secondary','aria-label':'Resolve '+item.title});
  button.addEventListener('click',()=>{
    item.resolved=!item.resolved;status.textContent=item.resolved?'Resolved in preview':'Awaiting local review';
    button.textContent=item.resolved?'Restore to queue':'Resolve locally';button.setAttribute('aria-label',(item.resolved?'Restore ':'Resolve ')+item.title);
    byId('review-status').textContent=reports.filter(r=>!r.resolved).length+' reports awaiting review. No real content changed.';
  });
  card.append(make('h3',item.title),make('p',item.context),status,button);byId('review-list').append(card);
}
renderThreads();
