import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {summarize} from './summarize.mjs';
const input=path.resolve(process.argv[2]||''),output=path.resolve(process.argv[3]||'');
if(!process.argv[2]||!process.argv[3])throw new Error('usage: node publish.mjs RUN/results.json PUBLIC.json');
if(fs.existsSync(output))throw new Error('Refusing to overwrite published results');
const source=JSON.parse(fs.readFileSync(input,'utf8')),summary=summarize(source);
if(!summary.complete)throw new Error('Run is incomplete; do not publish it as a completed comparison');
const sharedHost=source.method.hostMode==='shared';
if((source.hostContention?.length||sharedHost)&&!(sharedHost&&process.argv.includes('--shared-host')))
  throw new Error('Shared-host timings require recorded shared-host methodology and explicit --shared-host publication');
if(summary.overlap.length)throw new Error('A competing model was observed; do not publish as a single-engine comparison');
// Inputs are synthetic. Remove machine-specific absolute checkout/run paths
// from recorded commands; keep timings, outputs, failures and hashes unchanged.
const sanitize=value=>typeof value==='string'?value.replaceAll(path.dirname(input),'$RUN_DIR').replaceAll(process.cwd(),'$DSTUDIO_ROOT').replaceAll(os.homedir(),'$USER_HOME'):
  Array.isArray(value)?value.map(sanitize):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,sanitize(v)])):value;
const report=sanitize(source);
report.summary=summary;
report.publication={rawTracePolicy:'Per-request token traces and process logs remain in the local run directory. This file retains measured results, output artifacts, independent checks, PLD counters, timing and provenance.',
  analysisHashes:Object.fromEntries(['publish.mjs','summarize.mjs','plot-results.py'].map(file=>
    [file,crypto.createHash('sha256').update(fs.readFileSync(new URL(file,import.meta.url))).digest('hex')])),
  hostMode:sharedHost?'shared':'isolated',
  timingInterpretation:sharedHost?'Descriptive measurements with the recorded desktop workload running. Variable CPU/GPU/memory contention prevents attributing every timing difference to PLD. Not an isolated speed guarantee.':'Descriptive single-host measurements; not a general speed guarantee.',
  comparisonScope:'Chat compares response text and tool arguments, excluding random API tool IDs. Agent/Cowork compare resulting file bytes; tool trajectories and transcript hashes are recorded but need not match. This is not a full engine-state or token-trajectory equivalence test.',
  pilotsExcluded:['Transport/calibration pilots are not merged into this result.'],
  allMeasuredTasksPassed:source.runs.length>0&&source.runs.every(r=>r.correct),
  noObservedTaskRegressions:summary.groups.every(g=>g.regressedCases.length===0),
  noCompetingModelObserved:summary.overlap.length===0,
  productionQualification:false};
fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(output);
