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

// Tempo: one current track and a playing/paused state. No audio plays and time does not advance.
const album=[['Low Light',214],['Lantern Street',232],['Night Bus',198],['Second Floor',251],['The Quiet Hour',187],['Signal Box',263],['Morning Edit',205],['Last Train Home',318]];
let now=1,playing=false,shuffle=false,repeat=false;
const clock=s=>Math.floor(s/60)+':'+String(s%60).padStart(2,'0');
const seek=byId('tp-seek');
function drawTracks(){
 const list=byId('tp-tracks');list.replaceChildren();
 for(const [i,[title,length]] of album.entries()){
  const row=make('li',undefined,{class:'track','aria-current':i===now});
  const play=make('button',title,{type:'button',class:'track-play','aria-label':'Play '+title});
  play.addEventListener('click',()=>{now=i;playing=true;seek.value=0;update('Playing '+title+'. Preview only: no audio, and time does not advance.');byId('tp-tracks').children[i].querySelector('button').focus();});
  row.append(make('span',String(i+1).padStart(2,'0'),{class:'track-no'}),play,make('span',clock(length),{class:'track-len'}));
  if(i===now)row.append(make('span',playing?'Playing':'Paused',{class:'led','data-on':playing}));
  list.append(row);
 }
}
function update(message){
 const [title,length]=album[now];
 seek.max=length;const position=Number(seek.value);
 byId('tp-now').textContent=title;byId('tp-now-sub').textContent='Track '+(now+1)+' of '+album.length+' · The Low Hours';
 byId('tp-elapsed').textContent=clock(position);byId('tp-remaining').textContent='−'+clock(length-position);
 seek.setAttribute('aria-valuetext',clock(position)+' of '+clock(length));
 byId('tp-play-label').textContent=playing?'Pause':'Play';
 byId('tp-play-icon').className='ico '+(playing?'pause':'play');
 drawTracks();
 if(message)byId('tp-status').textContent=message;
}
byId('tp-play').addEventListener('click',()=>{playing=!playing;update(playing?'Playing '+album[now][0]+'. Preview only: no audio, and time does not advance.':'Paused at '+clock(Number(seek.value))+'.');});
byId('tp-prev').addEventListener('click',()=>{
 if(Number(seek.value)>3||now===0){seek.value=0;update('Back to the start of '+album[now][0]+'.');return;}
 now--;seek.value=0;update('Previous track: '+album[now][0]+'.');
});
byId('tp-next').addEventListener('click',()=>{
 if(now===album.length-1&&!repeat&&!shuffle){update('End of the album. Turn on repeat to start again.');return;}
 now=shuffle?(now+3)%album.length:(now+1)%album.length;seek.value=0;
 update('Next track: '+album[now][0]+(shuffle?'. Shuffle follows a fixed order in this preview.':'.'));
});
seek.addEventListener('input',()=>update());
for(const [id,label] of [['tp-shuffle','Shuffle'],['tp-repeat','Repeat']])byId(id).addEventListener('click',event=>{
 const on=event.currentTarget.getAttribute('aria-pressed')!=='true';event.currentTarget.setAttribute('aria-pressed',String(on));
 if(id==='tp-shuffle')shuffle=on;else repeat=on;update(label+(on?' on.':' off.'));
});
byId('tp-volume').addEventListener('input',event=>{byId('tp-volume-out').textContent=event.target.value+' of 10';});
update();
