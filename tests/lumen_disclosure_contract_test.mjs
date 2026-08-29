import assert from 'node:assert/strict';
import {
  hasFictionalLocalDemoDisclosure,
  visibleHtmlText,
} from './lumen_disclosure_contract.mjs';

assert.equal(hasFictionalLocalDemoDisclosure(`
  <p>Lumen Observatory is a fictional design study.</p>
  <p>This form is local: no reservation is created.</p>
`), true, 'equivalent visible local-demo wording must pass');

assert.equal(hasFictionalLocalDemoDisclosure(`
  <footer>A fictional design study — no real reservation is created.</footer>
`), true, 'the benchmark wording must pass');

assert.equal(hasFictionalLocalDemoDisclosure(`
  <style>.note::after { content: "fictional design study; no real reservation is created"; }</style>
  <main>Reserve now.</main>
`), false, 'CSS-only wording is not a public disclosure');

assert.equal(hasFictionalLocalDemoDisclosure(`
  <!-- fictional design study; no real reservation is created -->
  <main>Reserve now.</main>
`), false, 'comment-only wording is not a public disclosure');

assert.equal(hasFictionalLocalDemoDisclosure(`
  <main>Lumen Observatory is a fictional design study. Your reservation is confirmed.</main>
`), false, 'a fictional label without the no-reservation statement must fail');

assert.equal(visibleHtmlText('<p>A &amp; B</p><script>ignored()</script>'), 'A & B');

console.log('lumen_disclosure_contract_test: ok');
