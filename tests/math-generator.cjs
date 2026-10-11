/* Heavy, offline checks of the Math Task generator (admin/js/math-task-generator.js): every size, every
   topic, thousands of problems each. The maths is re-derived here from the TEXT of each problem, not
   from the generator's own numbers, so a wrong step, hint or answer cannot hide. Synthetic only. */
const assert = require('node:assert/strict');
const path = require('node:path');
const G = require(path.resolve(__dirname, '..', 'admin', 'js', 'math-task-generator.js'));
const results = [];
const check = (name, fn) => { try { fn(); results.push({ name, pass: true }); } catch (e) { results.push({ name, pass: false, message: String(e.message || e).slice(0, 400) }); } };
const seeded = seed => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const num = s => Number(String(s).replace(/,/g, ''));
const BOUNDS = { tens: [10, 99], hundreds: [100, 999], thousands: [1000, 9999] };
const COMMON = [5, 10, 15, 20, 25, 30, 40, 50, 60, 75];
const N = 3000;
const leaks = (hint, answers) => {   // a number shown as a RESULT ("= 140", "the answer is 140") that is a step answer
  const nums = answers.map(a => Number(String(a).replace(/[%,]/g, ''))).filter(Number.isFinite);
  const re = /((?:=|\b(?:answers?|results?|equals?|gives?|gets?)\b)\s*(?:is|are|:|=)?\s*)(-?\d[\d,]*(?:\.\d+)?)/gi;
  let m; while ((m = re.exec(hint))) if (nums.some(n => Math.abs(n - num(m[2])) < 1e-9)) return true;
  return false;
};

const numsIn = t => (String(t).match(/\d+(?:\.\d+)?/g) || []).map(Number);
const decimals = x => { const t = String(x), i = t.indexOf('.'); return i === -1 ? 0 : t.length - i - 1; };

/* The hint of a multiply step teaches the method with a worked example that uses OTHER numbers. The example's own
   maths is re-derived here from its text. `answers`: every answer of the question; none may appear as an example result. */
function workedMult(step, dec, other, answers) {
  const m = step.hint2.match(/^Example: ([\d.]+) \* (\d+)\. Ignore the decimal point: (\d+) \* (\d+) = (\d+)\. [\d.]+ has (\d) decimal places?, so put the point back (\d) places? from the right: ([\d.]+)\.$/);
  assert.ok(m, 'hint2 of a multiply step is a worked example: "' + step.hint2 + '"');
  const [, d, n, whole, n2, prod, dp, dp2, result] = m;
  assert.equal(n, n2); assert.equal(dp, dp2); assert.equal(decimals(d), Number(dp), 'decimal places stated correctly');
  assert.equal(Number(whole), Math.round(Number(d) * 10 ** Number(dp)), 'the whole number is the decimal without its point');
  assert.equal(Number(whole) * Number(n), Number(prod), 'the multiplication in the example is right');
  assert.ok(Math.abs(Number(prod) / 10 ** Number(dp) - Number(result)) < 1e-9, 'the point goes back to the right place');
  assert.ok(Math.abs(Number(d) * Number(n) - Number(result)) < 1e-9, 'the example result is d * n');
  assert.equal([dec, other].some(x => Math.abs(x - Number(d)) < 1e-9 || Math.abs(x - Number(n)) < 1e-9), false, 'the example works on the question\'s own numbers: "' + step.hint2 + '"');
  for (const r of [Number(prod), Number(result)]) assert.equal(answers.some(a => Math.abs(a - r) < 1e-9), false, 'the example shows an answer of the question: ' + r);
  assert.equal(Number(dp), decimals(dec), 'the example has as many decimal places as the question: ' + step.hint2 + ' for ' + dec);
  assert.ok(step.hint3.includes(String(dec)) && step.hint3.includes(' by ' + other + ','), 'hint3 sends the student back to their own numbers: ' + step.hint3);
  assert.equal(/\d\s*=\s*\d/.test(step.hint3), false, 'hint3 writes no result');
}

/* The same for a divide step (top / bottom, a decimal below 1). */
function workedDiv(step, top, bottom, answers, own) {
  own = own || { ops: [top, bottom], hint3: 'divide ' + top + ' by ' + bottom };
  const m = step.hint2.match(/^Example: (\d+) \/ (\d+)\. \1 is smaller than \2, so the answer starts with "0\." Then: (.+)\. So \1 \/ \2 = (0\.\d+)\.$/);
  assert.ok(m, 'hint2 of a divide step is a worked example: "' + step.hint2 + '"');
  const [, a, b, steps, result] = m;
  assert.ok(Math.abs(Number(a) / Number(b) - Number(result)) < 1e-9, 'the example result is a / b: ' + step.hint2);
  let digits = ''; const shown = [Number(result)];
  for (const part of steps.split(', then ')) {
    const k = part.match(/^(\d+) \/ (\d+) = (\d+)(?: \(remainder (\d+)\))?$/); assert.ok(k, 'a long-division line: ' + part);
    assert.equal(Number(k[2]), Number(b)); assert.equal(Number(k[3]) * Number(b) + Number(k[4] || 0), Number(k[1]), 'long division line is right: ' + part);
    digits += k[3]; shown.push(Number(k[3]));
  }
  assert.equal('0.' + digits, result, 'the digits spell the result');
  assert.equal(own.ops.some(x => Math.abs(x - Number(a)) < 1e-9 || Math.abs(x - Number(b)) < 1e-9), false, 'the example works on the question\'s own numbers: "' + step.hint2 + '"');
  for (const r of shown) assert.equal(answers.some(x => Math.abs(x - r) < 1e-9), false, 'the example shows an answer of the question: ' + r);
  assert.ok(step.hint3.includes(own.hint3), 'hint3 sends the student back to their own numbers: ' + step.hint3);
  assert.equal(/\d\s*=\s*\d/.test(step.hint3), false, 'hint3 writes no result');
}

/* Step 1 of the two "percentage of a number" problems: dividing the percentage by 100, as a worked long division. */
function workedPct(step, pct, answers) {
  workedDiv(step, pct, 100, answers, { ops: [pct], hint3: 'Work out ' + pct + ' divided by 100' });
  const m = step.hint2.match(/^Example: (\d+) \/ 100\./);
  assert.ok(m && Number(m[1]) !== pct, 'the example is not the question\'s own percentage: ' + step.hint2);
  assert.equal(m[1].length, String(pct).length, 'as many digits as the percentage: ' + step.hint2);
  assert.equal(m[1].endsWith('0'), false, 'no trailing zero in the example');
}

/* Checks one generated problem completely and returns { main, pct } for range checks. */
function verify(d, diff, range) {
  const [lo, hi] = BOUNDS[range];
  assert.equal(d.range, range);
  assert.equal(typeof d.q, 'string'); assert.ok(d.q.length > 20);
  assert.equal(d.points, 10, 'points are passed through');
  const stepsExpected = diff === 'EASY' ? 2 : 3;
  assert.equal(d.steps.length, stepsExpected, 'step count');
  for (const s of d.steps) for (const k of ['prompt', 'answer', 'hint1', 'hint2', 'hint3']) assert.ok(String(s[k]).trim(), k + ' is filled in: ' + d.q);
  let main, pct, extra = {};
  if (diff === 'EASY') {
    let m = d.q.match(/of ([\d,]+) students, (\d+)% joined/);
    if (m) {
      main = num(m[1]); pct = Number(m[2]);
      const res = main * pct / 100; assert.ok(Number.isInteger(res) && res >= 1, 'whole answer ' + d.q);
      assert.equal(d.final, String(res));
      assert.equal(d.steps[0].answer, String(pct / 100));
      assert.equal(d.steps[1].answer, String(res));
      assert.ok(d.steps[0].prompt.includes(pct + '%'));
      assert.ok(d.steps[1].prompt.includes('(' + (pct / 100) + ')') && d.steps[1].prompt.includes('(' + main + ')'), 'step 2 prompt uses the generated values: ' + d.steps[1].prompt);
      workedPct(d.steps[0], pct, [pct / 100, res]);
      workedMult(d.steps[1], pct / 100, main, [pct / 100, res]);
    } else {
      m = d.q.match(/PHP ([\d,]+) is on sale with a (\d+)% discount/); assert.ok(m, 'a known EASY template: ' + d.q);
      main = num(m[1]); pct = Number(m[2]);
      const res = main * pct / 100; assert.ok(Number.isInteger(res) && res >= 1, 'whole discount ' + d.q);
      assert.equal(d.final, String(res));
      assert.equal(d.steps[0].answer, String(pct / 100));
      assert.equal(d.steps[1].answer, String(res));
      assert.ok(d.steps[1].prompt.includes(String(main)) && d.steps[1].prompt.includes(String(pct / 100)));
      workedPct(d.steps[0], pct, [pct / 100, res]);
      workedMult(d.steps[1], pct / 100, main, [pct / 100, res]);
    }
  } else if (diff === 'MEDIUM') {
    const m = d.q.match(/PHP ([\d,]+) increased in price to PHP ([\d,]+)/); assert.ok(m, d.q);
    main = num(m[1]); const to = num(m[2]); const inc = to - main; pct = inc / main * 100;
    assert.ok(Number.isInteger(inc) && inc >= 1, 'whole increase');
    assert.ok(Math.abs(pct - Math.round(pct)) < 1e-9, 'a whole percentage: ' + d.q);
    assert.ok(COMMON.includes(Math.round(pct)), 'a common percentage ' + pct);
    assert.ok(to >= lo && to <= hi, 'the increased value stays in the same size: ' + d.q);
    assert.equal(d.final, Math.round(pct) + '%');
    assert.equal(d.steps[0].answer, String(inc)); assert.equal(d.steps[1].answer, String(inc / main)); assert.equal(d.steps[2].answer, Math.round(pct) + '%');
    assert.ok(d.steps[0].prompt.includes('(' + to + ' - ' + main + ')'));
    assert.ok(d.steps[1].prompt.includes('(' + inc + ')') && d.steps[1].prompt.includes('(' + main + ')'));
    assert.equal(d.steps[0].hint2, to + ' - ' + main); workedDiv(d.steps[1], inc, main, [inc, inc / main, Math.round(pct)]);
    extra.other = to;
  } else {
    const m = d.q.match(/PHP ([\d,]+) is marked down to PHP ([\d,]+)/); assert.ok(m, d.q);
    main = num(m[1]); const to = num(m[2]); const dec = main - to; pct = dec / main * 100;
    assert.ok(Number.isInteger(dec) && dec >= 1, 'whole decrease');
    assert.ok(Math.abs(pct - Math.round(pct)) < 1e-9, 'a whole percentage: ' + d.q);
    assert.ok(COMMON.includes(Math.round(pct)), 'a common percentage ' + pct);
    assert.ok(to >= lo && to <= hi, 'the reduced value stays in the same size: ' + d.q);
    assert.equal(d.final, Math.round(pct) + '%');
    assert.equal(d.steps[0].answer, String(dec)); assert.equal(d.steps[1].answer, String(dec / main)); assert.equal(d.steps[2].answer, Math.round(pct) + '%');
    assert.ok(d.steps[0].prompt.includes('(' + main + ' - ' + to + ')'));
    assert.equal(d.steps[0].hint2, main + ' - ' + to); workedDiv(d.steps[1], dec, main, [dec, dec / main, Math.round(pct)]);
    extra.other = to;
  }
  assert.ok(main >= lo && main <= hi, `the main value ${main} is a ${range} number: ${d.q}`);
  // hints guide: none shows a step answer or the final answer as a result
  const answers = d.steps.map(s => s.answer).concat([d.final]);
  for (const s of d.steps) for (const k of ['hint1', 'hint2', 'hint3']) assert.equal(leaks(s[k], answers), false, `${k} gives the answer away: "${s[k]}" in ${d.q}`);
  return { main, pct, ...extra };
}

for (const range of ['tens', 'hundreds', 'thousands']) {
  for (const diff of ['EASY', 'MEDIUM', 'HARD']) {
    check(`${range} / ${diff}: ${N} problems are valid, in range, whole-number, with matching steps, answers and hints`, () => {
      const rng = seeded(range.length * 31 + diff.length);
      const seen = new Set(); let multiples = 0;
      for (let i = 0; i < N; i++) {
        const d = G.generate(diff, 10, range, rng);
        const r = verify(d, diff, range); seen.add(d.q);
        const step = G.RANGES[range].step; if (r.main % step === 0) multiples++;
      }
      assert.ok(seen.size > 30, 'not predictable: ' + seen.size + ' distinct problems');
      assert.ok(multiples / N >= 0.9, 'main values are round for their size: ' + multiples / N);
    });
  }
}

check('percentages vary and are common ones for every topic and size', () => {
  const rng = seeded(7);
  for (const diff of ['EASY', 'MEDIUM', 'HARD']) for (const range of ['tens', 'hundreds', 'thousands']) {
    const set = new Set();
    for (let i = 0; i < 600; i++) set.add(verify(G.generate(diff, 10, range, rng), diff, range).pct);
    assert.ok(set.size >= 5, `${diff}/${range}: only ${set.size} different percentages`);
    for (const p of set) assert.ok(COMMON.includes(p), 'uncommon percentage ' + p);
  }
});

check('a Hundreds increase never turns into Thousands, and a Tens increase stays two-digit', () => {
  const rng = seeded(11);
  for (let i = 0; i < 4000; i++) {
    const t = G.generate('MEDIUM', 10, 'tens', rng), h = G.generate('MEDIUM', 10, 'hundreds', rng);
    assert.ok(num(t.q.match(/to PHP ([\d,]+)/)[1]) <= 99, t.q);
    assert.ok(num(h.q.match(/to PHP ([\d,]+)/)[1]) <= 999, h.q);
    const d = G.generate('HARD', 10, 'hundreds', rng); assert.ok(num(d.q.match(/down to PHP ([\d,]+)/)[1]) >= 100, d.q);
  }
});

check('only the chosen sizes appear: Tens only, Hundreds only, Thousands only', () => {
  for (const only of ['tens', 'hundreds', 'thousands']) {
    const batch = G.generateBatch('EASY', 10, 40, [only], seeded(3));
    assert.equal(batch.length, 40);
    for (const d of batch) verify(d, 'EASY', only);
  }
});

check('Tens + Hundreds gives both; all three gives a mixture; the odd ones out are balanced', () => {
  const two = G.generateBatch('MEDIUM', 10, 10, ['tens', 'hundreds'], seeded(5)).map(d => d.range);
  assert.equal(two.filter(r => r === 'tens').length, 5); assert.equal(two.filter(r => r === 'hundreds').length, 5);
  assert.equal(two.includes('thousands'), false);
  const nine = G.generateBatch('HARD', 10, 9, ['tens', 'hundreds', 'thousands'], seeded(5)).map(d => d.range);
  for (const r of ['tens', 'hundreds', 'thousands']) assert.equal(nine.filter(x => x === r).length, 3, '9 questions = 3 + 3 + 3');
  for (const count of [1, 2, 3, 4, 5, 7, 10, 11, 25]) {
    const plan = G.planRanges(['tens', 'hundreds', 'thousands'], count, seeded(count));
    assert.equal(plan.length, count);
    const c = r => plan.filter(x => x === r).length;
    assert.ok(Math.max(c('tens'), c('hundreds'), c('thousands')) - Math.min(c('tens'), c('hundreds'), c('thousands')) <= 1, 'balanced for ' + count);
  }
  // order is randomised, not grouped
  let grouped = 0; for (let s = 1; s <= 50; s++) { const p = G.planRanges(['tens', 'hundreds', 'thousands'], 9, seeded(s)).join(','); if (p === 'tens,tens,tens,hundreds,hundreds,hundreds,thousands,thousands,thousands') grouped++; }
  assert.ok(grouped < 3, 'the order is shuffled');
  assert.ok(new Set(Array.from({ length: 30 }, (_, s) => G.planRanges(['tens', 'hundreds', 'thousands'], 9, seeded(s + 100)).join(','))).size > 10);
});

check('no chosen size generates nothing (no silent default); unknown names are ignored', () => {
  assert.deepEqual(G.planRanges([], 5), []); assert.deepEqual(G.planRanges(null, 5), []); assert.deepEqual(G.planRanges(['bogus'], 5), []);
  assert.deepEqual(G.generateBatch('EASY', 10, 5, []), []);
  assert.equal(G.generateBatch('EASY', 10, 0, ['tens']).length, 0);
});

check('older callers that name no size still work (a mix of Tens and Hundreds), on every topic', () => {
  const rng = seeded(21); const seen = new Set();
  for (let i = 0; i < 400; i++) for (const diff of ['EASY', 'MEDIUM', 'HARD']) { const d = G.generate(diff, 10, undefined, rng); assert.ok(['tens', 'hundreds'].includes(d.range)); verify(d, diff, d.range); seen.add(d.range); }
  assert.equal(seen.size, 2);
});

check('no hint of any generated problem shows the result (thousands more, all sizes)', () => {
  const rng = seeded(99);
  for (let i = 0; i < 6000; i++) { const diff = ['EASY', 'MEDIUM', 'HARD'][i % 3], range = ['tens', 'hundreds', 'thousands'][(i >> 1) % 3]; verify(G.generate(diff, 10, range, rng), diff, range); }
});

const failed = results.filter(r => !r.pass);
console.log(JSON.stringify({ pass: results.length - failed.length, fail: failed.length, total: results.length, failures: failed }, null, 1));
process.exit(failed.length ? 1 : 0);
