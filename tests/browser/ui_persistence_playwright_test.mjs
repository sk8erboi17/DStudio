// Production Store, actual IndexedDB/localStorage, real native HTTP/files.
// Authored payloads and simulated persistence faults; no model executes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {artifactRunDir,freePort,sleep,writeArtifact} from '../support/real_harness.mjs';
import {storeHarnessScript} from '../support/store_functions.mjs';
const browserName=process.env.DSTUDIO_TEST_BROWSER||'chromium';
const { [browserName]:browserType }=await import('playwright');
const run=artifactRunDir('history-persistence'),port=await freePort(),base=`http://127.0.0.1:${port}`;
const profile=path.join(run,'profile'),binary=path.resolve(process.argv[2]||'tests/.build/dstudio-server-test');
fs.mkdirSync(profile,{recursive:true});
const report={scope:'Real browser history and native file persistence; authored fixtures, no inference',browser:browserName,cases:[],status:'RUNNING'};
console.log('Persistence evidence:',run);
let host,browser;
async function startHost() {
  const log=fs.openSync(path.join(run,'host.log'),'a');
  host=spawn(binary,[String(port),path.join(run,'unused-engine')],{env:{...process.env,DS4UI_DATA_DIR:profile,DS4UI_HOST:'127.0.0.1',DS4UI_NO_WINDOW:'1',DS4UI_TEST_MODE:'1',DS4UI_DEFER_ENGINE_START:'1'},stdio:['ignore',log,log]});
  fs.closeSync(log);
  for(let i=0;i<100;i++) {
    if(host.exitCode!==null)throw Error('Native test host exited');
    try {if((await fetch(base+'/api/storerev')).ok)return;}catch{}
    await sleep(50);
  }
  throw Error('Native test host did not start');
}
async function stopHost() {
  if(!host||host.exitCode!==null)return;
  const done=once(host,'exit');host.kill('SIGTERM');await done;
}
async function check(name,test) {
  const row={name};report.cases.push(row);
  try {await test();row.status='PASS';console.log('PASS:',name);}
  catch(error){row.status='FAIL';row.error=String(error.stack||error);throw error;}
  finally{writeArtifact(run,'results.json',report);}
}
async function makePage(context,lan=false) {
  const page=await context.newPage();
  await page.route(base+'/persistence-fixture',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Isolated persistence fixture</title>'}));
  await page.goto(base+'/persistence-fixture');
  await page.addScriptTag({content:storeHarnessScript({lan})});
  await page.evaluate(()=>window.storageReady);
  return page;
}
const native=async()=> (await(await fetch(base+'/api/store')).json()).data;
try {
  await startHost();browser=await browserType.launch();
  const context=await browser.newContext(),page=await makePage(context);
  let ids;
  await check('quota migration preserves Chat, Agent, Cowork, Design, Learn and Tutor payloads',async()=>{
    ids=await page.evaluate(async()=>{
      const Store=window.storageStore,ids={};
      for(const mode of ['chat','agent','cowork','design','roadmap']) {
        const chat=Store.createChat(mode);ids[mode]=chat.id;
        Store.appendMessage(chat.id,{id:mode+'-message',role:'assistant',content:mode==='chat'?'x'.repeat(6*1024*1024):'Authored '+mode,
          reasoning:'Retain these independent notes. '.repeat(3000),createdAt:Date.now(),
          ...(mode==='roadmap'?{roadmapBuild:{version:1,outline:{stages:[{id:'saved'}]},stages:[{id:'saved'}]},
            roadmapStudyThreads:{topic:{messages:[{role:'assistant',content:'Saved Tutor explanation'}]}}}:{})});
        if(['agent','cowork','design'].includes(mode))Store.setChatMeta(chat.id,{transcript:'Do not truncate this native transcript. '.repeat(4000)});
      }
      if(!await Store.persistChatsNow())throw Error(Store.persistenceMessage());
      return ids;
    });
    const saved=await native();
    assert.equal(saved.chats.find(c=>c.id===ids.chat).messages[0].content.length,6*1024*1024);
    for(const mode of ['agent','cowork','design'])assert.ok(saved.chats.find(c=>c.id===ids[mode]).transcript.length>50000);
    assert.equal(saved.chats.find(c=>c.id===ids.roadmap).messages[0].roadmapStudyThreads.topic.messages[0].content,'Saved Tutor explanation');
    assert.ok(saved.chats.every(c=>c.messages.every(m=>m.reasoning.length>65000)));
    await page.waitForFunction(async()=>{
      const request=indexedDB.open('dstudio-history',1);
      return new Promise(resolve=>{request.onsuccess=()=>{const db=request.result,tx=db.transaction('snapshots','readonly'),get=tx.objectStore('snapshots').get('chats.v2');get.onsuccess=()=>resolve(typeof get.result==='string'&&get.result.length>6*1024*1024);tx.oncomplete=()=>db.close();};});
    });
    assert.equal(await page.evaluate(()=>localStorage.getItem('ds4web.chats.v2')),null);
    await page.evaluate(()=>storageStore.setSettingsNow({theme:'light'}));
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('ds4web.settings.v2')).theme),'light');
  });
  await check('native durable acknowledgement does not wait on a blocked browser cache',async()=>{
    await page.evaluate(async()=>{
      const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('dstudio-history',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
      window.cacheBlocked=true;window.cacheBlockFinished=false;
      const tx=db.transaction('snapshots','readwrite'),store=tx.objectStore('snapshots');
      const pump=()=>{const r=store.get('hold');r.onsuccess=()=>{if(window.cacheBlocked)pump();};};pump();
      tx.oncomplete=()=>{window.cacheBlockFinished=true;db.close();};
      const chat=storageStore.getState().chats.find(c=>c.mode==='chat');
      storageStore.setChatMeta(chat.id,{cacheBlockedReceipt:'native-ack'});
      if(!await storageStore.persistChatsNow())throw Error(storageStore.persistenceMessage());
      if(window.cacheBlockFinished)throw Error('The deterministic cache gate ended before native acknowledgement');
    });
    assert.equal((await native()).chats.find(c=>c.id===ids.chat).cacheBlockedReceipt,'native-ack');
    await page.evaluate(()=>{window.cacheBlocked=false;});
    await page.waitForFunction(()=>window.cacheBlockFinished);
  });
  await check('one native writer serializes immutable snapshots and later promises resolve',async()=>{
    const result=await page.evaluate(async()=>{
      const Store=storageStore,original=storageEngine.putStore;let release,entered;
      const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r);let active=0,max=0,count=0;const snapshots=[];
      storageEngine.putStore=async(blob,...args)=>{active++;max=Math.max(max,active);snapshots.push(JSON.parse(blob));try{if(++count===1){entered();await gate;}return await original(blob,...args);}finally{active--;}};
      const chat=Store.getState().chats.find(c=>c.mode==='chat');
      Store.setChatMeta(chat.id,{first:1});const first=Store.persistChatsNow();await ready;
      Store.setChatMeta(chat.id,{second:2});const second=Store.persistChatsNow();
      Store.setChatMeta(chat.id,{third:3});const third=Store.persistChatsNow();
      if(count!==1)throw Error('A second native save started before the first completed');
      release();const results=await Promise.all([first,second,third]);
      const after=await Store.persistChatsNow();storageEngine.putStore=original;
      return {results,after,max,firstHadSecond:snapshots[0].chats.find(c=>c.id===chat.id).second,last:snapshots.at(-1).chats.find(c=>c.id===chat.id).third};
    });
    assert.deepEqual(result.results,[true,true,true]);assert.equal(result.after,true);assert.equal(result.max,1);
    assert.equal(result.firstHadSecond,undefined);assert.equal(result.last,3);
  });
  await check('native disk errors retain browser history and do not disable settings',async()=>{
    fs.chmodSync(profile,0o500);
    try {
      assert.equal(await page.evaluate(async()=>{const c=storageStore.getState().chats.find(c=>c.mode==='cowork');storageStore.setChatMeta(c.id,{nativeFailure:'browser-durable'});return storageStore.persistChatsNow();}),true);
      assert.equal((await native()).chats.find(c=>c.id===ids.cowork).nativeFailure,undefined);
      assert.ok(await page.evaluate(()=>storageNotices.some(n=>/saved in this browser/.test(n.message))));
      await page.evaluate(()=>storageStore.setSettingsNow({theme:'dark'}));
      assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('ds4web.settings.v2')).theme),'dark');
    } finally{fs.chmodSync(profile,0o700);}
    assert.equal(await page.evaluate(()=>storageStore.persistChatsNow()),true);
    assert.equal((await native()).chats.find(c=>c.id===ids.cowork).nativeFailure,'browser-durable');
  });
  await check('malformed revision headers cannot bypass a native conflict check',async()=>{
    const before=await(await fetch(base+'/api/store')).json();
    for(const revision of ['', '-1', '0bad', '1, 1', '9'.repeat(80)]) {
      const response=await fetch(base+'/api/store',{method:'POST',headers:{'X-Requested-With':'ds4web','X-DStudio-Store-Revision':revision},body:'{"v":2,"chats":[],"deleted":[]}'});
      assert.equal(response.status,400,JSON.stringify(revision));
    }
    assert.deepEqual(await(await fetch(base+'/api/store')).json(),before);
  });
  await check('simultaneous native/browser failure is explicit and recoverable without shedding data',async()=>{
    fs.chmodSync(profile,0o500);
    try {
      const result=await page.evaluate(async()=>{
        window.originalIdbTransaction=IDBDatabase.prototype.transaction;
        IDBDatabase.prototype.transaction=function(...args){if(args[1]==='readwrite')throw new DOMException('Injected browser write denial','SecurityError');return originalIdbTransaction.apply(this,args);};
        const c=storageStore.getState().chats.find(c=>c.mode==='design');storageStore.setChatMeta(c.id,{bothFailure:'retained-memory'});
        return {saved:await storageStore.persistChatsNow(),error:storageStore.persistenceMessage(),reasoning:c.messages[0].reasoning.length,transcript:c.transcript.length};
      });
      assert.equal(result.saved,false);assert.ok(result.error);assert.ok(result.reasoning>65000&&result.transcript>50000);
    }finally{fs.chmodSync(profile,0o700);await page.evaluate(()=>{IDBDatabase.prototype.transaction=originalIdbTransaction;});}
    assert.equal(await page.evaluate(()=>storageStore.persistChatsNow()),true);
  });
  await check('restart restores the real file and large browser cache across every mode',async()=>{
    await stopHost();await startHost();
    const restored=await makePage(context);
    const result=await restored.evaluate(()=>storageStore.getState().chats.map(c=>({mode:c.mode,id:c.id,body:c.messages[0]?.content.length,reasoning:c.messages[0]?.reasoning.length,transcript:c.transcript?.length})));
    for(const mode of Object.keys(ids))assert.ok(result.some(c=>c.id===ids[mode]&&c.mode===mode));
    assert.equal(result.find(c=>c.id===ids.chat).body,6*1024*1024);
    await restored.close();
    assert.equal(await page.evaluate(()=>storageStore.persistChatsNow()),true,'A reset host revision is reconciled before saving');
  });
  await check('two windows merge independent chats and refuse to replace an active draft',async()=>{
    const other=await makePage(context);
    await other.evaluate(async id=>{storageStore.setChatMeta(id,{otherWindow:'retained'});if(!await storageStore.persistChatsNow())throw Error(storageStore.persistenceMessage());},ids.agent);
    assert.equal(await page.evaluate(async id=>{storageStore.setChatMeta(id,{thisWindow:'retained'});return storageStore.persistChatsNow();},ids.cowork),true);
    let data=await native();assert.equal(data.chats.find(c=>c.id===ids.agent).otherWindow,'retained');assert.equal(data.chats.find(c=>c.id===ids.cowork).thisWindow,'retained');
    await page.evaluate(id=>storageStore.setChatStreaming(id,new AbortController()),ids.chat);
    await other.evaluate(async id=>{await storageStore.syncFromServer(false,false);storageStore.setChatMeta(id,{activeConflict:'remote'});if(!await storageStore.persistChatsNow())throw Error(storageStore.persistenceMessage());},ids.chat);
    const result=await page.evaluate(async id=>{storageStore.setChatMeta(id,{activeConflict:'local'});return {saved:await storageStore.persistChatsNow(),value:storageStore.getChat(id).activeConflict};},ids.chat);
    assert.equal(result.saved,false);assert.equal(result.value,'local');
    assert.equal((await native()).chats.find(c=>c.id===ids.chat).activeConflict,'remote');
    await page.evaluate(id=>storageStore.setChatStreaming(id,null),ids.chat);
    await other.close();
  });
  await check('LAN/offline browser history migrates without reaching the host-private store',async()=>{
    const client=await browser.newContext(),lan=await makePage(client,true);let privateRequests=0;
    lan.on('request',request=>{if(new URL(request.url()).pathname==='/api/store')privateRequests++;});
    const id=await lan.evaluate(async()=>{const c=storageStore.createChat('chat');storageStore.appendMessage(c.id,{id:'lan-message',role:'user',content:'z'.repeat(6*1024*1024),createdAt:Date.now()});if(!await storageStore.persistChatsNow())throw Error(storageStore.persistenceMessage());return c.id;});
    assert.equal(privateRequests,0);assert.ok(!(await native()).chats.some(c=>c.id===id));
    const reload=await makePage(client,true);
    assert.equal(await reload.evaluate(id=>storageStore.getChat(id).messages[0].content.length,id),6*1024*1024);
    await client.close();
  });
  await check('durable clear is not undone by an older window',async()=>{
    const stale=await makePage(context),clearer=await makePage(context);
    await clearer.evaluate(()=>storageStore.clearAll());
    const cleared=await native();assert.equal(cleared.chats.filter(c=>c.messages.length||c.transcript).length,0);assert.ok(cleared.clearedAt>0);
    assert.equal(await stale.evaluate(()=>storageStore.persistChatsNow()),true);
    assert.equal((await native()).chats.filter(c=>c.messages.length||c.transcript).length,0,'Old cached conversations must not reappear after Clear all');
    await clearer.close();await stale.close();
  });
  report.status='PASS';
}catch(error){report.status='FAIL';report.error=String(error.stack||error);throw error;}
finally {
  fs.chmodSync(profile,0o700);
  writeArtifact(run,'results.json',report);
  await browser?.close().catch(()=>{});await stopHost();
}
