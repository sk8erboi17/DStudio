// Native q36 parser/renderer, not model inference. Original RED receipts remain.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {artifactRunDir, writeArtifact} from '../support/real_harness.mjs';

const root = path.resolve(import.meta.dirname, '../..'), run = artifactRunDir('q36-http-vision');
const report = {scope: 'Native parser, renderer and HTTP ownership with simulated session work; no model inference', passed: false, cases: [], commands: []};
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
console.log(`Evidence: ${run}`);
try {
  assert(process.argv.length === 3 || (process.argv.length === 4 && process.argv[3] === '--next'),
    'Supply the exact q36 source directory and optional --next ABI');
  const next = process.argv[3] === '--next'; report.nextReview = next;
  const source = fs.realpathSync(process.argv[2]);
  const probe = path.join(root, 'tests/support/q36_http_vision_probe.c');
  const prepareProbe = path.join(root, 'tests/support/q36_http_prepare_probe.c');
  const core = path.join(root, 'tests/support/q36_catalog_core_probe.c');
  const inputs = [probe, prepareProbe, core, import.meta.filename, ...['q36.c', 'q36_server.c', 'q36.h', 'q36_image.c', 'q36_ssd.c', 'rax.c'].map(n => path.join(source, n))];
  report.inputs = Object.fromEntries(inputs.map(file => [file, hash(file)]));
  for (const file of [probe, prepareProbe, core, import.meta.filename]) fs.copyFileSync(file, path.join(run, path.basename(file)));
  const binary = path.join(run, 'http-vision-probe');
  const args = ['-std=c11', '-O1', '-g', '-fsanitize=address,undefined', '-fno-omit-frame-pointer',
    '-ffunction-sections', '-fdata-sections', '-I', source, probe, core, '-lm', '-pthread', '-o', binary,
    process.platform === 'darwin' ? '-Wl,-dead_strip' : '-Wl,--gc-sections'];
  if (process.platform !== 'darwin') args.unshift('-D_GNU_SOURCE');
  if (next) args.unshift('-DDSTUDIO_Q36_NEXT_REVIEW');
  const built = spawnSync('cc', args, {encoding: 'utf8', timeout: 120000, maxBuffer: 2 ** 21});
  report.commands.push({binary: 'cc', args, status: built.status, stderr: built.stderr, error: String(built.error || '')});
  assert.equal(built.status, 0, built.stderr || String(built.error));
  report.binarySHA256 = hash(binary);
  const image = {type: 'image_url', image_url: {url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'}};
  const text = value => ({type: 'text', text: value});
  const marker = '<|vision_start|><|image_pad|><|vision_end|>';
  const prefix = '<|im_start|>user\n';
  const imageBytes = Buffer.from(image.image_url.url.split(',')[1], 'base64');
  const anthropicImage = {type: 'image', source: {type: 'base64', media_type: 'image/png',
    data: image.image_url.url.split(',')[1]}};
  // Assert the actual request-owned nonce and bytes; do not normalize rendered
  // output. The old renderer uses a fixed token wrapper plus typed offsets.
  const ownedMarker = (r, index = 0) => r.images[index].marker;
  const urlImage = url => ({type: 'image_url', image_url: {url}});
  const reject = r => assert.equal(r.accepted, false);
  const imageAt = (r, at, index = 0) => {
    assert.equal(r.accepted, true);
    assert.equal(r.images[index].offset, at);
    assert.equal(r.images[index].bytes, imageBytes.length);
    assert.equal(r.images[index].hex, imageBytes.toString('hex'));
    const actual = ownedMarker(r, index);
    if (next) {
      assert.match(actual, /^\x1eQ36_IMAGE_[0-9a-f]{24}\x1f$/);
      assert.equal(r.rendered.split(actual).length, 2, 'owned marker appears exactly once');
    } else assert.equal(actual, marker);
    assert.equal(Buffer.from(r.rendered).subarray(at, at + Buffer.byteLength(actual)).toString(), actual);
  };
  const cases = [
    ['text is unchanged', 'messages', [{role: 'user', content: 'hello'}], r => {
      assert.equal(r.accepted, true); assert.deepEqual(r.messages, ['hello']);
    }],
    ['an image stays between its surrounding text', 'messages', [{role: 'user', content: [text('before'), image, text('after')]}], r => {
      assert.equal(r.accepted, true); assert.equal(r.messages[0], 'before' + ownedMarker(r) + 'after');
      imageAt(r, Buffer.byteLength(prefix + 'before'));
    }],
    ['text-only content adapter rejects an image instead of dropping it', 'content', [text('question'), image], r => assert.equal(r.accepted, false)],
    ['Anthropic image is retained or explicitly unsupported, never an empty turn', 'anthropic', [{role: 'user', content: [anthropicImage]}],
      r => next ? imageAt(r, Buffer.byteLength(prefix)) : reject(r)],
    ['remote image is rejected without downloading', 'messages', [{role: 'user', content: [{type: 'image_url', image_url: {url: 'https://example.invalid/private.png'}}]}], r => assert.equal(r.accepted, false)],
    ['literal markers do not acquire image identity', 'messages', [{role: 'user', content: [text(marker + ' literal '), image]}], r => {
      assert.equal(r.images.length, 1); imageAt(r, Buffer.byteLength(prefix + marker + ' literal '));
    }],
    ['Unicode offsets refer to bytes, not characters', 'messages', [{role: 'user', content: [text('  α🙂 prima '), image, text(' dopo  ')]}], r => imageAt(r, Buffer.byteLength(prefix + 'α🙂 prima '))],
    ['trim and thinking controls retain the image position', 'messages', [{role: 'user', content: [text(' \n<|think_off|>  prima<|think_off|> '), image, text(' dopo  ')]}], r => imageAt(r, Buffer.byteLength(prefix + 'prima '))],
    ['adjacent images retain separate positions', 'messages', [{role: 'user', content: [image, image, text(' order')]}], r => {
      assert.equal(r.images.length, 2); imageAt(r, Buffer.byteLength(prefix)); imageAt(r, Buffer.byteLength(prefix + ownedMarker(r)), 1);
      if (next) assert.notEqual(ownedMarker(r), ownedMarker(r, 1));
    }],
    ['history retains each user image in its own turn', 'messages', [{role: 'user', content: [image]}, {role: 'assistant', content: 'seen'}, {role: 'user', content: [text('next'), image]}], r => {
      // The embedded GGUF templates preserve even empty reasoning when the
      // probe explicitly sets preserve_thinking=true. Its 19 bytes precede
      // the second image; the earlier offset oracle incorrectly omitted them.
      const beforeSecond = prefix + ownedMarker(r) + '<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\nseen<|im_end|>\n' + prefix + 'next';
      assert.equal(r.images.length, 2); imageAt(r, Buffer.byteLength(prefix));
      imageAt(r, Buffer.byteLength(beforeSecond), 1);
      assert.equal(r.rendered, beforeSecond + ownedMarker(r, 1) + '<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n');
    }],
    ['history with reasoning retains the second image after the complete assistant turn', 'messages', [{role: 'user', content: [image]}, {role: 'assistant', reasoning_content: 'Inspect the pixels.', content: 'seen'}, {role: 'user', content: [text('next'), image]}], r => {
      const beforeSecond = prefix + ownedMarker(r) + '<|im_end|>\n<|im_start|>assistant\n<think>\nInspect the pixels.\n</think>\n\nseen<|im_end|>\n' + prefix + 'next';
      assert.equal(r.images.length, 2); imageAt(r, Buffer.byteLength(prefix));
      imageAt(r, Buffer.byteLength(beforeSecond), 1);
      assert.equal(r.rendered, beforeSecond + ownedMarker(r, 1) + '<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n');
    }],
    ['eight images are admitted', 'messages', [{role: 'user', content: Array(8).fill(image)}], r => {assert.equal(r.accepted, true); assert.equal(r.images.length, 8);}],
    ['nine images are rejected', 'messages', [{role: 'user', content: Array(9).fill(image)}], reject],
    ['image count applies across all messages', 'messages', Array(9).fill({role: 'user', content: [image]}), reject],
    ...['assistant', 'system'].map(role => [`unsupported image role ${role} is rejected`, 'messages', [{role, content: [image]}], reject]),
    ['tool image is retained or explicitly unsupported', 'messages', [{role: 'tool', tool_call_id: 'call_image', content: [image]}], r => {
      if (!next) return reject(r);
      imageAt(r, Buffer.byteLength(prefix + '<tool_response>\n'));
    }],
    ...[
      'file:///private/example.png', 'data:image/svg+xml;base64,PHN2Zz4=',
      'data:image/png;base64,', 'data:image/png;base64,iVBORw0KGgo',
      'data:image/png;base64,iVBORw0KGgp=', 'data:image/png;base64,iVBORw0KGg==',
      'data:image/png;base64,iVBORw0KGgo=AAAA', 'data:image/png;base64,iVBORw0K\nGgo=',
      'data:image/jpeg;base64,iVBORw0KGgo=', 'data:image/png;base64,/9g=',
    ].map((url, index) => [`invalid image encoding ${index} is rejected`, 'messages', [{role: 'user', content: [urlImage(url)]}], reject]),
    ['an image and text in the same typed block is rejected', 'messages', [{role: 'user', content: [{...image, text: 'lost text'}]}], reject],
    ['image without type is rejected', 'messages', [{role: 'user', content: [{image_url: image.image_url}]}], reject],
    ['missing image URL is rejected', 'messages', [{role: 'user', content: [{type: 'image_url'}]}], reject],
    ['embedded NUL cannot truncate the input', 'messages', [{role: 'user', content: 'before\u0000after'}], reject],
    ['Responses image content is rejected by the text-only adapter', 'content', [{type: 'input_image', image_url: image.image_url.url}], reject],
    ['unsupported content object is not an empty message', 'content', {type: 'image_url', image_url: image.image_url}, reject],
  ];
  if (next) cases.push(
    ['Responses input image retains complete bytes and position', 'responses', [{role: 'user',
      content: [{type: 'input_text', text: 'inspect '}, {type: 'input_image', image_url: image.image_url.url}]}],
      r => imageAt(r, Buffer.byteLength(prefix + 'inspect '))],
    ['Anthropic remote image is rejected without downloading', 'anthropic', [{role: 'user',
      content: [{type: 'image', source: {type: 'url', url: 'https://example.invalid/private.png'}}]}], reject],
  );
  const limit = 8 * 1024 * 1024;
  const bounded = Buffer.alloc(limit); imageBytes.copy(bounded);
  const boundedImage = urlImage('data:image/png;base64,' + bounded.toString('base64'));
  cases.push(
    ['encoded byte limit is inclusive', 'messages', [{role: 'user', content: [boundedImage]}], r => {
      assert.equal(r.accepted, true); assert.equal(r.images[0].bytes, limit);
    }],
    ['over encoded byte limit is rejected', 'messages', [{role: 'user', content: [urlImage('data:image/png;base64,' + Buffer.concat([bounded, Buffer.from([0])]).toString('base64'))]}], reject],
    ['aggregate byte limit is inclusive', 'messages', [{role: 'user', content: Array(4).fill(boundedImage)}], r => {
      assert.equal(r.accepted, true); assert.equal(r.images.reduce((n, image) => n + image.bytes, 0), 4 * limit);
    }],
    ['aggregate byte limit applies across turns', 'messages', [{role: 'user', content: Array(4).fill(boundedImage)}, {role: 'user', content: [image]}], reject],
  );
  for (const [name, mode, input, check] of cases) {
    const serialized = JSON.stringify(input);
    const row = {name, mode, input: serialized.length < 65536 ? input : {bytes: Buffer.byteLength(serialized),
      sha256: crypto.createHash('sha256').update(serialized).digest('hex'), recipe: 'Generated by the frozen harness; repeated zero-filled buffers with the fixture PNG prefix'}, passed: false}; report.cases.push(row);
    const measured = spawnSync(binary, [mode], {input: serialized, encoding: 'utf8', timeout: 10000, maxBuffer: 2 ** 20});
    Object.assign(row, {exitCode: measured.status, signal: measured.signal, stdout: measured.stdout, stderr: measured.stderr});
    try {assert.equal(measured.status, 0, measured.stderr || String(measured.error)); row.output = JSON.parse(measured.stdout); check(row.output); row.passed = true;}
    catch (error) {row.error = String(error.stack || error);}
    console.log(`${row.passed ? 'PASS' : 'FAIL'}: ${name}`);
    writeArtifact(run, 'results.json', report);
  }
  const preparedBinary = path.join(run, 'http-prepare-probe');
  const prepareArgs = args.map(arg => arg === probe ? prepareProbe : arg === binary ? preparedBinary : arg);
  prepareArgs.push(...['q36_image.c', 'q36_ssd.c', 'rax.c'].map(file => path.join(source, file)));
  const compiled = spawnSync('cc', prepareArgs, {encoding: 'utf8', timeout: 120000, maxBuffer: 2 ** 21});
  report.commands.push({binary: 'cc', args: prepareArgs, status: compiled.status, stderr: compiled.stderr, error: String(compiled.error || '')});
  assert.equal(compiled.status, 0, compiled.stderr || String(compiled.error));
  report.prepareBinarySHA256 = hash(preparedBinary);
  const modes = ['successful owner publication', 'failed partial preparation preserves prior state', 'expired request cannot prepare',
    'TCP reset during blocked preparation preserves prior state', 'shutdown before publication preserves prior state',
    'stale candidate cannot replace a newer owner result', 'allocation failure preserves prior state',
    'candidate cannot change configured context', 'legal HTTP half-close does not cancel a request',
    'explicit request cancellation preserves the previous session during preparation',
    'explicit cancellation before preparation does not allocate or mutate a session'];
  if (next) modes.push(...modes.map(name => 'prepared image and pending tool identity: ' + name));
  for (const [index, name] of modes.entries()) {
    const measured = spawnSync(preparedBinary, [String(index)], {encoding: 'utf8', timeout: 10000, maxBuffer: 2 ** 20});
    const row = {name, scope: 'Production owner path; simulated native worker with deterministic barrier',
      passed: false, exitCode: measured.status, signal: measured.signal, stdout: measured.stdout, stderr: measured.stderr};
    report.cases.push(row);
    try {
      assert.equal(measured.status, 0, measured.stderr || String(measured.error));
      row.output = JSON.parse(measured.stdout); assert.equal(row.output.failures, 0); row.passed = true;
    } catch (error) {row.error = String(error.stack || error);}
    console.log(`${row.passed ? 'PASS' : 'FAIL'}: ${name}`);
    writeArtifact(run, 'results.json', report);
  }
  for (const [file, expected] of Object.entries(report.inputs)) assert.equal(hash(file), expected, `Input changed: ${file}`);
  report.passed = report.cases.every(row => row.passed);
  if (!report.passed) process.exitCode = 1;
} catch (error) {report.error = String(error.stack || error); console.error(report.error); process.exitCode = 1;}
finally {report.finished = new Date().toISOString(); writeArtifact(run, 'results.json', report);}
