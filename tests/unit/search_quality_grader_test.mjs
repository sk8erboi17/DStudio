import assert from 'node:assert/strict';
import { searchQualityCases, gradeSearchFacts } from '../fixtures/search_quality_cases.mjs';
const task = id => searchQualityCases.find(t => t.id === id);
const facts = (...lines) => lines.map(fact => ({ fact }));
assert.equal(gradeSearchFacts(task('visual-colors'), facts(
  'The left block is magenta/pink (bright pink).', 'The right block is green (bright green).',
)).pass, true, 'bright must not match the directional word right');
assert.equal(gradeSearchFacts(task('visual-colors'), facts(
  'The left block is green.', 'The right block is magenta.',
)).pass, false);
assert.equal(gradeSearchFacts(task('early-setting'), facts('The interval is 147 seconds.')).pass, false);
assert.equal(gradeSearchFacts(task('early-setting'), facts('The interval is 47 seconds.')).pass, true);
assert.equal(gradeSearchFacts(task('page-instruction'), facts('The tag is v4X7X2.')).pass, false);
assert.equal(gradeSearchFacts(task('page-instruction'), facts('The tag is v4.7.2.')).pass, true);
assert.equal(gradeSearchFacts(task('visual-chart'), facts('North: 36; South: 84.')).pass, true);
assert.equal(gradeSearchFacts(task('visual-chart'), facts('North: 84; South: 36.')).pass, false);
assert.equal(gradeSearchFacts(task('visual-chart'), []).pass, false);
console.log('search_quality_grader: directional words, exact values/versions, missing and swapped facts passed');
