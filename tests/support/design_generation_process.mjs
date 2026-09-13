// One native Design process, one brief. This is benchmark plumbing, not an
// inference adapter. In particular, idle is not artifact/quality acceptance.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';

// Per case, not per tool or per chunk. Exceeding a bound fails the run; raw
// prefixes and exact byte counts remain evidence, never a truncated PASS.
export const designGenerationLimits = Object.freeze({
  stdoutBytes: 128 * 1024 * 1024, stderrBytes: 32 * 1024 * 1024,
  lineBytes: 2 * 1024 * 1024, eventBytes: 16 * 1024 * 1024,
  events: 16384, promptBytes: 64 * 1024,
  startupMs: 900000, turnMs: 1800000, terminateMs: 5000, cleanupMs: 10000,
});

export async function runDesignGeneration({binary, args, cwd, env, directory,
  prompt, signal, onEvent = () => {}, onReady = () => {}, limits = {}}) {
  assert.notEqual(process.platform, 'win32', 'the Metal benchmark uses POSIX process groups');
  const bound = {...designGenerationLimits, ...limits};
  for (const [key, value] of Object.entries(bound))
    assert.ok(Object.hasOwn(designGenerationLimits, key) && Number.isSafeInteger(value)
      && value > 0 && value <= designGenerationLimits[key], `invalid Design capture bound: ${key}`);
  assert.ok(bound.cleanupMs > bound.terminateMs, 'cleanup must allow termination grace');
  assert.ok(typeof prompt === 'string' && Buffer.byteLength(prompt + '\n') <= bound.promptBytes,
    'Design brief exceeds the admitted input size');
  const result = {status: 'starting', startedAt: new Date().toISOString(), limits: bound,
    errors: [], errorCount: 0, eventCount: 0, eventBytes: 0, promptSubmitted: false,
    output: Object.fromEntries(['stdout', 'stderr'].map(name => [name,
      {receivedBytes: 0, persistedBytes: 0, complete: false}]))};
  if (signal?.aborted) return {...result, status: 'interrupted', cleanupComplete: true, ms: 0};
  const files = {};
  // All handles are private, exclusive, and closed on admission failure too.
  try {
    for (const name of ['stdout', 'stderr'])
      files[name] = await fs.open(path.join(directory, `${name}.txt`), 'wx', 0o600);
  } catch (error) {
    await Promise.all(Object.values(files).map(file => file.close()));
    throw error;
  }
  const started = performance.now();
  let child, closed = false, idle = false, ready = false, interrupted = false;
  let finish, timer, terminateTimer, cleanupTimer;
  const terminal = new Promise(resolve => { finish = resolve; });
  const fail = (status, error) => {
    if (result.errorCount++ === 0) result.failure = status;
    if (result.errors.length < 8) result.errors.push({status,
      message: String(error?.message || error).slice(0, 2048)});
    finish(status);
  };
  const arm = (ms, status) => {
    clearTimeout(timer);
    timer = setTimeout(() => { fail(status, `Original ${ms} ms deadline expired`); }, ms);
  };
  const abort = () => { interrupted = true; finish('interrupted'); };
  const killOwnedGroup = sig => {
    if (!child?.pid || closed) return;
    try { process.kill(-child.pid, sig); }
    catch (error) { if (error.code !== 'ESRCH') fail('cleanup-error', error); }
  };
  // One bounded line is assembled at a time. UTF-8 is decoded only after all
  // bytes arrive; JSON framing errors cannot disappear in a catch-and-continue.
  function lines(name, accept) {
    let parts = [], size = 0, invalid = false;
    function append(bytes) {
      if (size + bytes.length > bound.lineBytes) {
        invalid = true; parts = []; size = 0;
        fail(`${name}-line-limit`, `Line exceeds ${bound.lineBytes} bytes`);
        return;
      }
      if (bytes.length) { parts.push(bytes); size += bytes.length; }
    }
    return {
      feed(chunk) {
        for (let offset = 0; offset < chunk.length && !invalid;) {
          const end = chunk.indexOf(10, offset);
          append(chunk.subarray(offset, end < 0 ? chunk.length : end));
          if (invalid || end < 0) return;
          const line = Buffer.concat(parts, size); parts = []; size = 0;
          try { accept(line); }
          catch (error) { invalid = true; fail(`${name}-protocol-error`, error); }
          offset = end + 1;
        }
      },
      end() {
        if (!invalid && name === 'stdout' && size && parts[0][0] === 0x1e)
          fail('stdout-incomplete-event', 'Native JSONL event lacks its terminating newline');
      },
    };
  }
  const outLines = lines('stdout', line => {
    if (line[0] !== 0x1e) return; // Unstructured model prose is still saved verbatim.
    if (result.eventCount >= bound.events || result.eventBytes + line.length > bound.eventBytes)
      throw new Error('Design structured-event count/byte budget exceeded');
    result.eventCount++; result.eventBytes += line.length;
    const event = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(line.subarray(1)));
    assert.ok(event && !Array.isArray(event) && typeof event.type === 'string' && event.type.length,
      'Native JSONL must contain an event object with a type');
    onEvent(event);
  });
  const errLines = lines('stderr', line => {
    if (!line.equals(Buffer.from('+DWARFSTAR_WAITING'))) return;
    if (!ready) {
      if (interrupted || result.failure) return; // A late readiness cannot start cancelled work.
      ready = true; result.readyMs = performance.now() - started;
      arm(bound.turnMs, 'turn-timeout');
      child.stdin.write(prompt + '\n', error => {
        if (error) fail('stdin-error', error);
        else result.promptSubmitted = true;
      });
      onReady(result.readyMs);
    } else { idle = true; result.idleMs = performance.now() - started; finish('idle'); }
  });
  async function capture(name, parser) {
    const observed = result.output[name], cap = bound[`${name}Bytes`];
    let writable = true, reachedLimit = false;
    try {
      // Await each filesystem write before requesting more pipe bytes. At most
      // one chunk per pipe and its bounded line are in flight; no growing log queue.
      for await (const chunk of child[name]) {
        observed.receivedBytes += chunk.length;
        if (writable) {
          const take = Math.min(chunk.length, cap - observed.persistedBytes);
          try {
            for (let offset = 0; offset < take;) {
              const {bytesWritten} = await files[name].write(chunk, offset, take - offset);
              if (!bytesWritten) throw new Error('Log write made no progress');
              offset += bytesWritten; observed.persistedBytes += bytesWritten;
            }
          } catch (error) { writable = false; fail(`${name}-write-error`, error); }
        }
        if (observed.receivedBytes > cap && !reachedLimit) {
          reachedLimit = true; fail(`${name}-log-limit`, `Raw output exceeds ${cap} bytes`);
        }
        if (writable && !reachedLimit) parser.feed(chunk);
      }
      parser.end();
      observed.complete = writable && observed.persistedBytes === observed.receivedBytes;
    } catch (error) { fail(`${name}-read-error`, error); }
  }
  let pumps = [];
  try {
    child = spawn(binary, args, {cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe']});
    result.pid = child.pid ?? null;
    const close = new Promise(resolve => child.once('close', (code, sig) => {
      closed = true; result.exitCode = code; result.signal = sig;
      result.closedAt = new Date().toISOString(); finish('exited'); resolve();
    }));
    child.once('error', error => fail('process-error', error));
    child.stdin.on('error', error => fail('stdin-error', error));
    pumps = [capture('stdout', outLines), capture('stderr', errLines)];
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) abort();
    arm(bound.startupMs, 'startup-timeout');
    result.terminalReason = await terminal;
    result.terminalMs = performance.now() - started;
    clearTimeout(timer);
    // Native out_text writes the artifact before stderr announces idle. Separate
    // pipes can be delivered in either order. TERM is only teardown: drain BOTH
    // pipes and close the log files before the caller inspects the artifact.
    killOwnedGroup('SIGTERM');
    terminateTimer = setTimeout(() => {
      if (!closed) {
        result.escalated = true; fail('cleanup-escalated', 'Owned process group ignored SIGTERM');
        killOwnedGroup('SIGKILL');
      }
    }, bound.terminateMs);
    const clean = Promise.all([close, ...pumps]).then(() => true);
    const deadline = new Promise(resolve => { cleanupTimer = setTimeout(() => resolve(false), bound.cleanupMs); });
    result.cleanupComplete = await Promise.race([clean, deadline]);
    if (!result.cleanupComplete) {
      fail('cleanup-timeout', 'Native process or output did not finish within cleanup deadline');
      killOwnedGroup('SIGKILL');
      child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy(); child.unref();
    }
  } catch (error) {
    fail('process-error', error); killOwnedGroup('SIGTERM');
  } finally {
    clearTimeout(timer); clearTimeout(terminateTimer); clearTimeout(cleanupTimer);
    signal?.removeEventListener('abort', abort);
    const closedFiles = await Promise.allSettled(Object.values(files).map(file => file.close()));
    for (const item of closedFiles) if (item.status === 'rejected') fail('log-close-error', item.reason);
  }
  result.totalMs = performance.now() - started;
  result.ms = idle ? result.idleMs : (result.terminalMs ?? result.totalMs);
  result.cleanupElapsedMs = result.totalMs - result.ms;
  if (idle && (result.exitCode !== 0 && result.signal !== 'SIGTERM'))
    fail('process-exit-error', `Unexpected native exit: code=${result.exitCode}, signal=${result.signal}`);
  result.status = interrupted ? 'interrupted' : result.failure || (idle ? 'idle' : 'exited');
  return result;
}
