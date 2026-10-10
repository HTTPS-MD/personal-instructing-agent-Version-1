/* Offline checks of the hint whiteboard's maths (student/js/hint-whiteboard.js): the text of a worked example
   becomes the steps the board draws. Every number is re-derived here, and the parser is run over the text the
   question generator really writes, so the two cannot drift apart. No DOM, no network, synthetic only. */
const assert = require('node:assert/strict');
const path = require('node:path');
const B = require(path.resolve(__dirname, '..', 'student', 'js', 'hint-whiteboard.js'));
const G = require(path.resolve(__dirname, '..', 'admin', 'js', 'math-task-generator.js'));
const results = [];
const check = (name, fn) => { try { fn(); results.push({ name, pass: true }); } catch (e) { results.push({ name, pass: false, message: String(e.message || e).slice(0, 400) }); } };
const seeded = seed => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const dp = s => { const i = String(s).indexOf('.'); return i === -1 ? 0 : String(s).length - i - 1; };

function verify(decimal, whole) {
  const m = B.build({ kind: 'multiply', decimal, whole });
  // the rows are the multiplier's digits, last digit first, each shifted one more place
  const digits = String(Number(decimal.replace('.', '')));
  assert.equal(m.partial.length, digits.length, 'one row per digit of the multiplier');
  let sum = 0;
  m.partial.forEach((p, k) => {
    assert.equal(p.shift, k);
    assert.equal(Number(p.digit), Number(digits[digits.length - 1 - k]));
    assert.equal(Number(p.value), Number(whole) * p.digit, 'row value is whole * digit');
    assert.equal(p.zeros, '0'.repeat(k), 'the shift is shown as zeros');
    sum += Number(p.value + p.zeros);
  });
  assert.equal(sum, Number(whole) * Number(digits), 'the rows add up to the whole-number product');
  assert.equal(m.totalText, String(sum));
  assert.equal(m.dp, dp(decimal), 'decimal places counted');
  assert.ok(Math.abs(Number(m.resultText) - Number(decimal) * Number(whole)) < 1e-9, 'the point lands in the right place: ' + m.resultText);
  assert.equal(dp(m.resultText), m.dp);
  // seven steps plus one per row; each has a caption and parts; the last one says the answer
  assert.equal(m.steps.length, 7 + m.partial.length);
  m.steps.forEach(s => { assert.ok(s.caption.length > 10 && s.caption.length < 140, 'caption length: ' + s.caption); assert.ok(s.parts.length >= 1); });
  assert.ok(m.steps[m.steps.length - 1].caption.includes(m.resultText));
  assert.ok(m.steps.some(s => s.caption.includes('hidden decimal point') && s.caption.includes(whole + '.')));
  const seen = m.steps.flatMap(s => s.parts);
  assert.equal(new Set(seen).size, seen.length, 'each part appears once');
  return m;
}

check('every 1-, 2- and 3-place decimal times a whole number: rows, sum, decimal places and answer are right', () => {
  for (const decimal of ['0.6', '0.7', '0.9', '0.8', '0.25', '0.35', '0.45', '0.65', '0.05', '0.15', '0.75', '0.125']) {
    for (const whole of ['11', '13', '17', '23', '55', '60', '300', '1250']) verify(decimal, whole);
  }
});

check('a decimal with leading zeros after the point (0.05, 0.005) drops them from the rows but keeps the places', () => {
  const a = verify('0.05', '60'); assert.equal(a.digits, '5'); assert.equal(a.dp, 2); assert.equal(a.partial.length, 1);
  const b = verify('0.005', '40'); assert.equal(b.digits, '5'); assert.equal(b.dp, 3);
});

check('the text the generator writes is understood: every multiply step of thousands of problems parses and draws', () => {
  const rng = seeded(11); let drawn = 0;
  for (let i = 0; i < 6000; i++) {
    const diff = 'EASY'; const range = ['tens', 'hundreds', 'thousands'][i % 3];
    const d = G.generate(diff, 10, range, rng);
    const ex = B.parseExample(d.steps[1].hint2);
    assert.ok(ex, 'parses: ' + d.steps[1].hint2);
    const m = verify(ex.decimal, ex.whole);
    // the board agrees with the sentence: the answer at the end of the example text is the board's answer
    assert.ok(d.steps[1].hint2.endsWith(m.resultText + '.'), `board answer ${m.resultText} is the one in: ${d.steps[1].hint2}`);
    drawn++;
  }
  assert.equal(drawn, 6000);
});

check('the board never draws the student\'s own numbers (the example is another problem)', () => {
  const rng = seeded(5);
  for (let i = 0; i < 3000; i++) {
    const d = G.generate('EASY', 10, ['tens', 'hundreds', 'thousands'][i % 3], rng);
    const ex = B.parseExample(d.steps[1].hint2);
    const own = d.steps[1].prompt.match(/\d+(?:\.\d+)?/g).slice(1).map(Number);   // after "Step 2"
    assert.equal(own.includes(Number(ex.decimal)) && own.includes(Number(ex.whole)), false, 'same pair as the question: ' + d.steps[1].prompt);
  }
});

check('text that is not a multiply example is left alone (the game shows the text only)', () => {
  for (const text of ['0.5 * 30', 'Work out 0.5 times 30, then write the result as your final answer.', '', null, undefined,
    'Example: 15 / 60. 15 is smaller than 60, so the answer starts with "0." Then: 150 / 60 = 2. So 15 / 60 = 0.25.',
    'Example: 25 * 55. Ignore the decimal point: 25 * 55 = 1375.', 'Check your calculations carefully.',
    'Example: 0.25 * 55555. Ignore the decimal point: 25 * 55555 = 1388875.']) assert.equal(B.parseExample(text), null, String(text));
});

const failed = results.filter(r => !r.pass);
console.log(JSON.stringify({ pass: results.length - failed.length, fail: failed.length, total: results.length, failures: failed }, null, 1));
process.exit(failed.length ? 1 : 0);
