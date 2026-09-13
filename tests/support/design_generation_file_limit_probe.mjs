// Executed in an isolated process with an OS file-size limit. FileHandle.write
// really fails; no mocked filesystem and no changes to the user's disk limits.
import {runDesignGeneration} from './design_generation_process.mjs';
const [directory, peer] = process.argv.slice(2);
const receipt = await runDesignGeneration({binary: process.execPath, args: [peer],
  cwd: directory, directory, prompt: 'Bounded file-error fixture',
  env: {...process.env, DESIGN_CAPTURE_FIXTURE: 'backpressure', DESIGN_CAPTURE_WORKSPACE: directory},
  limits: {startupMs: 10000, turnMs: 10000}});
process.stdout.write(JSON.stringify(receipt));
