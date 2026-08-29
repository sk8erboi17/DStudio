import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findChrome, probeInteractiveButtons } from './design_control_probe.mjs';

const probeSource = fs.readFileSync(new URL('./design_control_probe.mjs', import.meta.url), 'utf8');
assert.match(probeSource, /--password-store=basic[\s\S]*--use-mock-keychain/,
  'the Chrome control probe must use an isolated mock keychain');

const chrome = findChrome();
if (!chrome) {
  console.log('design_control_probe_test: skipped (Chrome/Chromium unavailable)');
  process.exit(0);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds4-control-probe-test-'));
const entry = path.join(dir, 'fixture.html');
fs.writeFileSync(entry, `<!doctype html><meta charset="utf-8"><style>
[hidden]{display:none} button{width:100px;height:44px}
</style><body data-state="a">
<section id="conditional" hidden><button type="button" id="action">Create row</button></section>
<button type="button" data-state="a" aria-pressed="true">State A</button>
<button type="button" data-state="b" aria-pressed="false">State B</button>
<button type="button" id="inert">Inert</button><output id="status"></output>
<script>
const states=[...document.querySelectorAll('[data-state]')],conditional=document.querySelector('#conditional');
for(const button of states) button.addEventListener('click',()=>{
  const state=button.dataset.state; document.body.dataset.state=state;
  for(const peer of states) peer.setAttribute('aria-pressed',String(peer===button));
  conditional.hidden=state!=='b';
});
document.querySelector('#action').addEventListener('click',()=>{
  document.querySelector('#status').textContent='row created';
});
</script></body>`);

try {
  const result = await probeInteractiveButtons(chrome, entry);
  assert.equal(result.available, true, result.error || 'control probe unavailable');
  const byLabel = new Map(result.controls.map((control) => [control.label, control.changed]));
  assert.equal(byLabel.get('State B'), true, 'inactive state toggle changes DOM');
  assert.equal(byLabel.get('State A'), true, 'formerly active toggle is exercised after state changes');
  assert.equal(byLabel.get('Create row'), true, 'button revealed by a state transition is exercised');
  assert.equal(byLabel.get('Inert'), false, 'inert visible button is detected');
  assert.deepEqual(result.inert.map((control) => control.label), ['Inert']);
  console.log('design_control_probe_test: ok');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
