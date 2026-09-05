import fs from 'node:fs';
export function summarize(report){
  const median=values=>{const a=[...values].sort((a,b)=>a-b),n=a.length;return n?(a[Math.floor(n/2)]+a[Math.floor((n-1)/2)])/2:null;};
  const expected=new Set(report.method.caseIds.flatMap(id=>report.method.modes.flatMap(mode=>
    Array.from({length:report.method.repeats},(_,repeat)=>JSON.stringify([id,mode,repeat])))));
  const actual=report.runs.map(r=>JSON.stringify([r.caseId,r.mode,r.repeat]));
  const validRows=report.runs.every(r=>report.method.surfaces.includes(r.surface)&&typeof r.correct==='boolean'&&
    Number.isFinite(r.wallMs)&&r.wallMs>0&&Number.isInteger(r.pld?.batches)&&r.pld.batches>=0);
  const groups=[];
  for(const surface of report.method.surfaces)for(const mode of report.method.modes){
    const runs=report.runs.filter(r=>r.surface===surface&&r.mode===mode);
    const pairs=runs.flatMap(run=>{
      const baseline=report.runs.find(r=>r.caseId===run.caseId&&r.repeat===run.repeat&&r.mode==='off');
      return baseline?[{run,baseline}]:[];
    });
    const identical=pairs.filter(p=>p.run.correct&&p.baseline.correct&&p.run.outputSha===p.baseline.outputSha);
    groups.push({surface,mode,runs:runs.length,correct:runs.filter(r=>r.correct).length,
      errors:runs.filter(r=>r.error).length,batches:runs.reduce((a,r)=>a+r.pld.batches,0),
      runsWithBatches:runs.filter(r=>r.pld.batches>0).length,
      medianWallSeconds:median(runs.map(r=>r.wallMs/1000)),
      comparableCorrectIdenticalPairs:identical.length,
      medianPairedSpeedup:median(identical.map(p=>p.baseline.wallMs/p.run.wallMs)),
      identicalCorrectPairsWithBatches:identical.filter(p=>p.run.pld.batches>0).length,
      medianPairedSpeedupWithBatches:median(identical.filter(p=>p.run.pld.batches>0).map(p=>p.baseline.wallMs/p.run.wallMs)),
      regressedCases:pairs.filter(p=>p.baseline.correct&&!p.run.correct).map(p=>({caseId:p.run.caseId,repeat:p.run.repeat})),
      differentOutputs:pairs.filter(p=>p.run.outputSha!==p.baseline.outputSha).map(p=>({caseId:p.run.caseId,repeat:p.run.repeat})),
    });
  }
  return {schemaVersion:1,benchmark:report.benchmark,startedAt:report.startedAt,finishedAt:report.finishedAt||null,
    complete:!!report.finishedAt&&!report.fatalError&&!report.interrupted&&
      validRows&&expected.size>0&&expected.size===report.method.caseIds.length*report.method.modes.length*report.method.repeats&&
      actual.length===expected.size&&new Set(actual).size===expected.size&&actual.every(key=>expected.has(key)),
    overlap:report.overlap||[],hardware:report.hardware,model:report.model,groups};
}
if(process.argv[1]?.endsWith('/summarize.mjs')){
  const report=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
  process.stdout.write(JSON.stringify(summarize(report),null,2)+'\n');
}
