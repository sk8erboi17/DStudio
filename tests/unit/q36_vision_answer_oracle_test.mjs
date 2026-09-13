import assert from 'node:assert/strict';
import {gradeQ36VisionAnswer as grade} from '../support/q36_vision_answer_oracle.mjs';

const row = (text, overrides = {}) => ({kind: 'imageAnswer', eos: true, finite: true,
  textHex: Buffer.from(text).toString('hex'), ...overrides});
const cases = [
  ['blue, red', 'blue,red', 'pass'], // Original real-model false negative.
  ['blue,red', 'blue,red', 'pass'],
  [' blue ,\tred\n', 'blue,red', 'pass'],
  [' red', 'red', 'pass'],
  ['red,blue', 'blue,red', 'fail'],
  ['blue,green', 'blue,red', 'fail'],
  ['blue, red, blue', 'blue,red', 'fail'],
  ['blue, red because the right half is red', 'blue,red', 'fail'],
  ['blue red', 'blue,red', 'fail'],
  ['Blue, red', 'blue,red', 'fail'],
  ['blue,,red', 'blue,red', 'fail'],
  ['blue,red,', 'blue,red', 'fail'],
  ['blue,', 'blue,red', 'fail'],
  ['blue.','blue','fail'],
  ['', 'red', 'fail'],
  ['red', 'red', 'fail', {eos: false}],
  ['red', 'red', 'fail', {finite: false}],
  ['red', 'red', 'fail', {eos: 'true'}],
  ['red', 'red', 'fail', {kind: 'unrecognized'}],
  ['red', 'red', 'fail', {textHex: '726564f'}],
  ['red', 'red', 'fail', {textHex: '726564xx'}],
  ['red', 'red', 'fail', {textHex: '726564ff'}],
  ['14\n', '14', 'pass', {kind: 'textRecovery'}],
  ['1 4', '14', 'fail', {kind: 'textRecovery'}],
  ['14,', '14', 'fail', {kind: 'textRecovery'}],
  ['14 because 6+8=14', '14', 'fail', {kind: 'textRecovery'}],
];
for (const [text, expected, status, overrides] of cases) {
  assert.equal(grade(row(text, overrides), expected).status, status, JSON.stringify({text, expected, overrides}));
}
assert.equal(grade(null, 'red').status, 'fail');
assert.equal(grade(row('red'), null).status, 'fail');
console.log(`q36 vision answer oracle: ${cases.length + 2}/${cases.length + 2} PASS`);
