// Execute the shipped Store with real browser storage and production HTTP
// methods. Source extraction is loading plumbing, never a source-string oracle.
import fs from 'node:fs';
import {extractFunction} from './real_harness.mjs';
export function storeHarnessScript({lan = false} = {}) {
  const html=fs.readFileSync('web/index.html','utf8');
  const store=html.slice(html.indexOf('    const Store = (() => {'),html.indexOf('    function storedLanClientHost()'));
  const functions=['debounce','utf8ByteLength','chatSelectionKey','getStore','putStore','wipe'].map(name=>extractFunction(html,name)).join('\n');
  return `(() => {
    const SCHEMA_VERSION=2, CHAT_SELECTION_REVISION=Symbol();
    const STORAGE_KEYS={chats:'ds4web.chats.v2',settings:'ds4web.settings.v2',active:'ds4web.active.v2',onboarded:'ds4web.onboarded.v2'};
    const DEFAULT_SETTINGS={v:2,onboarded:true,qualityDefaultsVersion:2,theme:'dark',baseUrl:'',chatBackend:'local',lanClientId:'storage-fixture',lanClientName:'Fixture',lanClientHost:''};
    const DEFAULT_CHAT_TITLE='New chat', DEFAULT_TITLES={chat:'Chat',agent:'Agent',cowork:'Cowork',design:'Design',roadmap:'Learn'};
    const PERSIST_CHATS_DEBOUNCE_MS=750,PERSIST_SETTINGS_DEBOUNCE_MS=250,AUTO_TITLE_MAX_CHARS=60;
    const H={'X-Requested-With':'ds4web'}, uniqueId=()=>crypto.randomUUID(), UTF8_ENCODER=new TextEncoder();
    const pageIsLanServed=()=>${lan},isLanClientMode=()=>${lan},isLanHostMode=()=>false;
    const currentLanClientHost=()=>'',adaptBaseUrl=value=>value;
    window.storageNotices=[];const toast=(message,kind)=>window.storageNotices.push({message,kind});
    ${functions}
    const Engine={getStore,putStore,wipe,lanClientChatsPut:async()=>({ok:true}),lanClientChatsGet:async()=>({ok:true,rev:0,clients:[]})};
    ${store}
    window.storageStore=Store;window.storageEngine=Engine;
    window.storageReady=Store.load().then(()=>Store.syncFromServer(false,false));
  })();`;
}
