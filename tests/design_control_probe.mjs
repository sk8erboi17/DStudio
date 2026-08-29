import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function findChrome() {
  return [
    process.env.DS4_CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome', '/usr/bin/chromium',
  ].find((candidate) => candidate && fs.existsSync(candidate));
}

function stopProcessTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch {}
  }
}

/* Exercise controls in DOM order, re-querying after every click. This matters
 * for state demos: clicking Empty/Error can reveal action buttons that were
 * not visible when the page first loaded. Active aria-pressed buttons are
 * tested after a sibling makes them inactive, avoiding false failures for a
 * no-op click on the already-selected state. */
export async function probeInteractiveButtons(chrome, entry) {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds4-design-controls-'));
  const instrumented = path.join(profileDir, 'controls.html');
  const probeScript = `<script>
(async function(){
  try {
    const seen=new Set(),results=[];
    function visible(button){
      const style=getComputedStyle(button),rect=button.getBoundingClientRect();
      return !button.disabled && !button.hidden && style.display!=='none' &&
        style.visibility!=='hidden' && rect.width>0 && rect.height>0;
    }
    for(let step=0;step<64;step++){
      let button=null;
      for(const candidate of document.querySelectorAll('button')){
        if(!candidate.dataset.ds4ProbeId)
          candidate.dataset.ds4ProbeId='control-'+[...document.querySelectorAll('button')].indexOf(candidate);
        if(seen.has(candidate.dataset.ds4ProbeId) || !visible(candidate) ||
           candidate.getAttribute('aria-pressed')==='true') continue;
        button=candidate; break;
      }
      if(!button) break;
      const id=button.dataset.ds4ProbeId;
      seen.add(id);
      if((button.type||'').toLowerCase()==='submit'&&button.form){
        for(const field of button.form.querySelectorAll('input[required],select[required],textarea[required]')){
          if(field.disabled)continue;
          const type=(field.type||'').toLowerCase();
          if(type==='checkbox'||type==='radio')field.checked=true;
          else if(field.tagName==='SELECT'){
            const option=[...field.options].find(item=>item.value&&!item.disabled);
            if(option)field.value=option.value;
          }else if(type==='email')field.value='probe@example.test';
          else if(type==='url')field.value='https://example.test/';
          else if(type==='number'||type==='range')field.value=field.min||'1';
          else if(type==='date')field.value='2030-01-02';
          else if(type==='time')field.value='20:00';
          else field.value='Interaction probe value';
          field.dispatchEvent(new Event('input',{bubbles:true}));
          field.dispatchEvent(new Event('change',{bubbles:true}));
        }
      }
      const label=(button.getAttribute('aria-label')||button.textContent||'').trim().replace(/\\s+/g,' ').slice(0,120);
      const before=document.documentElement.outerHTML,beforeUrl=location.href;
      button.click();
      await new Promise((resolve)=>setTimeout(resolve,40));
      const after=document.documentElement.outerHTML;
      results.push({label,changed:before!==after || beforeUrl!==location.href ||
        button.getAttribute('aria-pressed')==='true'});
    }
    document.documentElement.setAttribute('data-probe',encodeURIComponent(JSON.stringify(results)));
  } catch(error) {
    document.documentElement.setAttribute('data-probe-error',encodeURIComponent(String(error)));
  }
})();
</script>`;
  const source = fs.readFileSync(entry, 'utf8');
  fs.writeFileSync(instrumented, /<\/body\s*>/i.test(source)
    ? source.replace(/<\/body\s*>/i, `${probeScript}</body>`)
    : `${source}${probeScript}`);

  const child = spawn(chrome, [
    '--headless', '--disable-gpu', '--no-first-run', '--disable-extensions',
    '--password-store=basic', '--use-mock-keychain',
    '--allow-file-access-from-files', '--virtual-time-budget=5000',
    `--user-data-dir=${profileDir}`, '--window-size=1280,900', '--dump-dom',
    pathToFileURL(instrumented).href,
  ], { stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  let stdout = '';
  let stderr = '';
  let finishProbe;
  const probeReady = new Promise((resolve) => { finishProbe = resolve; });
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (/data-probe(?:-error)?="[^"]*"/i.test(stdout)) finishProbe('captured');
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.once('exit', (code) => finishProbe(code));
  child.once('error', () => finishProbe(null));
  const timer = setTimeout(() => finishProbe(null), 25_000);
  const outcome = await probeReady;
  clearTimeout(timer);
  stopProcessTree(child);
  await new Promise((resolve) => setTimeout(resolve, 100));
  fs.rmSync(profileDir, { recursive: true, force: true });

  const encoded = stdout.match(/data-probe="([^"]*)"/i)?.[1];
  const encodedError = stdout.match(/data-probe-error="([^"]*)"/i)?.[1];
  if (!encoded) {
    return {
      available: false,
      error: encodedError ? decodeURIComponent(encodedError) :
        `Chrome control probe failed (outcome=${outcome}; ${stderr.slice(-500)})`,
      controls: [], inert: [],
    };
  }
  try {
    const controls = JSON.parse(decodeURIComponent(encoded));
    return { available: true, controls, inert: controls.filter((control) => !control.changed) };
  } catch (error) {
    return { available: false, error: String(error), controls: [], inert: [] };
  }
}

const invokedDirectly = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const entry = process.argv[2] ? path.resolve(process.argv[2]) : '';
  const chrome = findChrome();
  if (!entry || !fs.existsSync(entry)) throw new Error('usage: node tests/design_control_probe.mjs <entry.html>');
  if (!chrome) throw new Error('Chrome/Chromium not found');
  const result = await probeInteractiveButtons(chrome, entry);
  const rendered = `${JSON.stringify(result, null, 2)}\n`;
  if (process.env.DSTUDIO_CONTROL_PROBE_OUTPUT) {
    const output = path.resolve(process.env.DSTUDIO_CONTROL_PROBE_OUTPUT);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, rendered);
  }
  process.stdout.write(rendered);
  if (!result.available || result.inert.length) process.exitCode = 1;
}
