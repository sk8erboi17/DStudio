import assert from 'node:assert/strict';

// Native server log spans describe tokens actually processed, not total prompt
// length (which can include a reused prefix). Never infer prefill from HTTP time.
export function prefillMetrics(log) {
  const matches=[...log.matchAll(/chat ctx=(\d+)\.\.(\d+):(\d+) prompt done ([0-9.]+)s/g)];
  if(matches.length!==1)return null;
  const [,start,end,count,seconds]=matches[0];
  if(Number(end)-Number(start)!==Number(count) || !(Number(seconds)>0))return null;
  return {tokens:Number(count),seconds:Number(seconds),tokensPerSecond:Number(count)/Number(seconds)};
}

export function workloadSummary(rows) {
  const allCorrect=rows.length===3 && rows.every(r=>r.status==='pass') &&
    [1,2,3].every(repeat=>rows.filter(r=>r.repeat===repeat).length===1);
  const stats=field=>{
    const values=rows.map(r=>r[field]);
    if(!allCorrect || values.some(n=>!Number.isFinite(n)||!(n>0)))return null;
    values.sort((a,b)=>a-b);
    return {median:values[1],min:values[0],max:values[2]};
  };
  return {allCorrect,decode:stats('tokensPerSecond'),prefill:stats('prefillTokensPerSecond')};
}

export function compareWorkloads(before,after) {
  assert.equal(before.mode,after.mode);
  assert.deepEqual(before.model,after.model,'same physical model and revision required');
  assert.deepEqual(before.cases,after.cases,'same frozen workloads required');
  const flags=args=>{
    const result={};
    for(let i=0;i<args.length;i++){
      const key=args[i],value=args[i+1]&&!args[i+1].startsWith('-')?args[++i]:true;
      if(key!=='--port')result[key]=value;
    }
    return result;
  };
  assert.deepEqual(flags(before.args),flags(after.args),'same runtime flags required (except private port)');
  assert.deepEqual(before.runs.map(r=>({id:r.id,repeat:r.repeat,request:r.request})),
    after.runs.map(r=>({id:r.id,repeat:r.repeat,request:r.request})),
    'same request sequence, sampling and output budget required');
  return Object.fromEntries(before.cases.map(c=>{
    const b=workloadSummary(before.runs.filter(r=>r.id===c.id));
    const a=workloadSummary(after.runs.filter(r=>r.id===c.id));
    return [c.id,{before:b,after:a,
      decodeChangePercent:b.decode&&a.decode?(a.decode.median/b.decode.median-1)*100:null,
      prefillChangePercent:b.prefill&&a.prefill?(a.prefill.median/b.prefill.median-1)*100:null}];
  }));
}
