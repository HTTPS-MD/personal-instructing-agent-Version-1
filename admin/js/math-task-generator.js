/* PIA -- Math Task question generator (no DOM, no network).
 *
 * Builds the sentence problems the admin's "Auto-generate" offers: topic 1 (finding a percentage),
 * topic 2 (percentage increase), topic 3 (percentage decrease), each with its worked steps and three
 * tiers of hints. The admin chooses the size of the numbers: Tens (10-99), Hundreds (100-999),
 * Thousands (1,000-9,999) -- one or several; a batch is spread across the chosen sizes.
 *
 * The size is not "a random number in a range". Every value is chosen so the answer is a whole number
 * and the percentage is a common one (5, 10, 15, 20, 25, 30, 40, 50, 60, 75): the total is a multiple
 * of the smallest step that makes "pct of total" whole, kept to round values for its size, and for an
 * increase / decrease the changed value stays inside the same size (a Hundreds question never turns
 * into a Thousands one). Hints guide; they never show the result.
 *
 * The steps that need real skill -- turning a percentage into a decimal (divide by 100), multiplying by a
 * decimal and dividing into a decimal -- teach the
 * METHOD with a worked example that uses OTHER numbers (0.25 * 55, 15 / 60), never the student's own. Hint 1
 * says the method, hint 2 shows the example, hint 3 sends the student back to their own numbers without
 * writing the result. An example is used only if it does not work on the question's own two numbers and
 * none of its results is an answer of the question, so it can never be mistaken for, or masked as, the answer.
 *
 * Works in the browser (window.PIAMathGen) and in Node (require), so it can be tested heavily.
 */
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) { module.exports = api; } else { root.PIAMathGen = api; }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    /* lo / hi: the size. step: how round the main value is for that size (so "400", not "387"). */
    var RANGES = {
        tens:      { lo: 10,   hi: 99,   step: 10,  label: 'Tens' },
        hundreds:  { lo: 100,  hi: 999,  step: 50,  label: 'Hundreds' },
        thousands: { lo: 1000, hi: 9999, step: 500, label: 'Thousands' }
    };
    var ORDER = ['tens', 'hundreds', 'thousands'];
    /* Older callers that name no size get a sensible mix. */
    var DEFAULT_RANGES = ['tens', 'hundreds'];

    var PCT_FIND = [5, 10, 15, 20, 25, 30, 40, 50, 60, 75];
    var PCT_DISCOUNT = [5, 10, 15, 20, 25, 30, 40, 50];
    var PCT_CHANGE = [5, 10, 15, 20, 25, 30, 40, 50, 60, 75];

    /* Things that cost about what their size says. */
    var ITEMS = {
        tens:      ['notebook', 'pen set', 'lunch box', 'umbrella'],
        hundreds:  ['jacket', 'pair of shoes', 'backpack', 'watch'],
        thousands: ['smartphone', 'bicycle', 'monitor', 'guitar']
    };
    var GOODS = {
        tens:      ['notebook', 'pen set', 'lunch box', 'umbrella'],
        hundreds:  ['jacket', 'pair of sneakers', 'backpack', 'watch'],
        thousands: ['television', 'tablet', 'camera', 'laptop']
    };
    var GROUP = { tens: 'class', hundreds: 'school', thousands: 'university' };
    var ACTIVITIES = ['sports club', 'art workshop', 'math olympiad', 'science fair'];

    function pick(rng, list) { return list[Math.floor(rng() * list.length)]; }
    function gcd(a, b) { return b ? gcd(b, a % b) : a; }
    function lcm(a, b) { return a / gcd(a, b) * b; }
    function money(n) { return Number(n).toLocaleString('en-US'); }

    function shuffle(rng, list) {
        var a = list.slice();
        for (var i = a.length - 1; i > 0; i--) {
            var j = Math.floor(rng() * (i + 1));
            var t = a[i]; a[i] = a[j]; a[j] = t;
        }
        return a;
    }

    function multiples(lo, hi, m) {
        var out = [];
        for (var v = Math.ceil(lo / m) * m; v <= hi; v += m) { out.push(v); }
        return out;
    }

    /* The smallest total for which pct% of it is a whole number. */
    function wholeStep(pct) { return 100 / gcd(pct, 100); }

    /* Round values inside the size for which pct% is whole and `ok(value)` holds; null if none. */
    function valuesFor(range, pct, ok) {
        var r = RANGES[range];
        var tries = [lcm(wholeStep(pct), r.step), wholeStep(pct)];
        for (var i = 0; i < tries.length; i++) {
            var found = multiples(r.lo, r.hi, tries[i]).filter(ok);
            if (found.length) { return found; }
        }
        return null;
    }

    /* A (percentage, value) pair for the size; percentages are tried in random order. */
    function chooseWithValue(rng, range, pcts, ok) {
        var order = shuffle(rng, pcts);
        for (var i = 0; i < order.length; i++) {
            var found = valuesFor(range, order[i], function (v) { return ok(v, order[i]); });
            if (found) { return { pct: order[i], value: pick(rng, found) }; }
        }
        return null;
    }

    /* ---- Worked examples for the hints ---------------------------------------------------------------- */

    /* [decimal, whole number] and [top, bottom]. Chosen so the working never ends in a zero and every
       division finishes within three digits. The first one that does not clash with the question is used,
       so students with the same kind of question see the same example. */
    var MULT_EXAMPLES = [[0.25, 55], [0.35, 17], [0.45, 13], [0.55, 17], [0.65, 13], [0.35, 23], [0.45, 17], [0.65, 17],
                         [0.6, 13], [0.7, 12], [0.9, 11], [0.8, 17], [0.7, 23], [0.9, 13], [0.6, 17], [0.8, 13]];
    var DIV_EXAMPLES = [[15, 60], [9, 60], [12, 48], [18, 45], [21, 60], [8, 32], [14, 56], [27, 60], [33, 60], [39, 60],
                        [16, 64], [24, 32], [13, 52], [36, 48], [27, 36], [14, 40], [26, 40],
                        [12, 60], [18, 60], [36, 60], [42, 60], [48, 60], [54, 60]];

    /* Whole percentages to practise "divide by 100", as a long division: one digit and two digits, none ending in 0
       (so 0.35, not 0.30). */
    var PCT_EXAMPLES = [[35, 100], [45, 100], [65, 100], [12, 100], [18, 100], [28, 100], [8, 100], [7, 100], [3, 100], [6, 100],
                        [9, 100], [55, 100], [22, 100], [16, 100]];

    function decimalPlaces(x) { var s = String(x), i = s.indexOf('.'); return i === -1 ? 0 : s.length - i - 1; }
    function placePoint(int, dp) {
        var s = String(int);
        while (s.length <= dp) { s = '0' + s; }
        return dp ? s.slice(0, -dp) + '.' + s.slice(-dp) : s;
    }
    function same(a, list) { return list.some(function (x) { return Math.abs(x - a) < 1e-9; }); }

    /* Each builder returns the text, the two numbers the example works on (`ops`) and every number it shows as
       a result (`res`). */
    function multExample(d, n) {
        var dp = decimalPlaces(d), whole = Math.round(d * Math.pow(10, dp)), prod = whole * n, result = placePoint(prod, dp);
        var places = dp + ' decimal place' + (dp === 1 ? '' : 's');
        return {
            ops: [d, n], res: [prod, Number(result)],
            text: 'Example: ' + d + ' * ' + n + '. Ignore the decimal point: ' + whole + ' * ' + n + ' = ' + prod + '. ' + d + ' has ' +
                places + ', so put the point back ' + dp + ' place' + (dp === 1 ? '' : 's') + ' from the right: ' + result + '.'
        };
    }

    function divExample(a, b) {
        var steps = [], res = [], cur = a * 10, digits = '', guard = 0, q, rem;
        while (guard++ < 4) {
            q = Math.floor(cur / b); rem = cur - q * b;
            steps.push(cur + ' / ' + b + ' = ' + q + (rem ? ' (remainder ' + rem + ')' : ''));
            res.push(q);
            digits += q;
            if (!rem) { break; }
            cur = rem * 10;
        }
        res.push(Number('0.' + digits));
        return {
            ops: [a, b], res: res,
            text: 'Example: ' + a + ' / ' + b + '. ' + a + ' is smaller than ' + b + ', so the answer starts with "0." Then: ' +
                steps.join(', then ') + '. So ' + a + ' / ' + b + ' = 0.' + digits + '.'
        };
    }

    /* The first example whose two numbers are not the question's (`ops`) and whose results are not any of its
       answers (`answers`), so it can never be mistaken for the answer or blanked out as one. */
    function pickExample(list, build, ops, answers) {
        for (var i = 0; i < list.length; i++) {
            var ex = build(list[i][0], list[i][1]);
            var usesTheirNumbers = ex.ops.some(function (x) { return same(x, ops); });
            var showsTheirAnswer = ex.res.some(function (x) { return same(x, answers); });
            if (!usesTheirNumbers && !showsTheirAnswer) { return ex.text; }
        }
        return null;
    }

    /* `ops`: the two numbers of the student's step. `answers`: every answer of the question. */
    function multiplyHints(dec, other, answers) {
        var dp = decimalPlaces(dec), whole = Math.round(dec * Math.pow(10, dp));
        /* An example with the same number of decimal places as the student's decimal, so the "count the places"
           step is the one they will need and the work is the same size. */
        var sameSize = MULT_EXAMPLES.filter(function (e) { return decimalPlaces(e[0]) === dp; });
        var ex = pickExample(sameSize, multExample, [dec, other], answers) || pickExample(MULT_EXAMPLES, multExample, [dec, other], answers);
        return {
            hint1: 'Multiply as if there were no decimal point, then count the decimal places and put the point back.',
            hint2: ex || 'Count the decimal places in the decimal number, multiply without the point, then put the point back that many places from the right.',
            hint3: 'Now do the same with your numbers: ignore the point in ' + dec + ', multiply ' + whole + ' by ' + other + ', then put the decimal point back.'
        };
    }

    /* Step 1 of the two "percentage of a number" problems. The example has as many digits as the student's
       percentage (so a one-digit percentage sees the extra zero), and is never their percentage or their answers. */
    function convertHints(pct, answers, hint1) {
        var sameSize = PCT_EXAMPLES.filter(function (e) { return String(e[0]).length === String(pct).length; });
        var ex = pickExample(sameSize, divExample, [pct], answers) || pickExample(PCT_EXAMPLES, divExample, [pct], answers);
        return {
            hint1: hint1,
            hint2: ex || pct + ' / 100',
            hint3: 'Work out ' + pct + ' divided by 100 and write it as a decimal.'
        };
    }

    function divideHints(top, bottom, answers) {
        var ex = pickExample(DIV_EXAMPLES, divExample, [top, bottom], answers);
        return {
            hint1: 'Divide the top number by the bottom number. The top number is smaller, so the answer starts with "0." and you keep dividing with extra zeros.',
            hint2: ex || 'The top number is smaller, so write "0." and keep dividing with extra zeros until nothing is left over.',
            hint3: 'Now do the same with your numbers: divide ' + top + ' by ' + bottom + ', adding a zero each time it does not fit, until nothing is left over.'
        };
    }

    function findPercentageSchool(rng, range, pts) {
        var c = chooseWithValue(rng, range, PCT_FIND, function (v, p) { return v * p / 100 >= 1; });
        var total = c.value, pct = c.pct, result = total * pct / 100;
        var mh = multiplyHints(pct / 100, total, [pct / 100, result]);
        var ch = convertHints(pct, [pct / 100, result], 'Divide percentage by 100 to convert to decimal.');
        return {
            q: 'In a ' + GROUP[range] + ' of ' + money(total) + ' students, ' + pct + '% joined the ' + pick(rng, ACTIVITIES) +
                '. How many students joined?',
            final: String(result),
            points: pts,
            steps: [
                { prompt: 'Step 1: Convert ' + pct + '% into a decimal.', answer: String(pct / 100),
                  hint1: ch.hint1, hint2: ch.hint2, hint3: ch.hint3 },
                { prompt: 'Step 2: Multiply decimal (' + (pct / 100) + ') by total students (' + total + ').',
                  answer: String(result),
                  hint1: mh.hint1, hint2: mh.hint2, hint3: mh.hint3 }
            ]
        };
    }

    function findPercentageDiscount(rng, range, pts) {
        var c = chooseWithValue(rng, range, PCT_DISCOUNT, function (v, p) { return v * p / 100 >= 1; });
        var price = c.value, pct = c.pct, discount = price * pct / 100;
        var mh = multiplyHints(pct / 100, price, [pct / 100, discount]);
        var ch = convertHints(pct, [pct / 100, discount], 'Divide the rate by 100.');
        return {
            q: 'A ' + pick(rng, ITEMS[range]) + ' originally priced at PHP ' + money(price) + ' is on sale with a ' + pct +
                '% discount. What is the discount amount in PHP?',
            final: String(discount),
            points: pts,
            steps: [
                { prompt: 'Step 1: Convert ' + pct + '% into decimal form.', answer: String(pct / 100),
                  hint1: ch.hint1, hint2: ch.hint2, hint3: ch.hint3 },
                { prompt: 'Step 2: Calculate discount amount by multiplying ' + price + ' by ' + (pct / 100) + '.',
                  answer: String(discount),
                  hint1: mh.hint1, hint2: mh.hint2, hint3: mh.hint3 }
            ]
        };
    }

    function percentageIncrease(rng, range, pts) {
        var hi = RANGES[range].hi;
        var c = chooseWithValue(rng, range, PCT_CHANGE, function (v, p) { return v * p / 100 >= 1 && v + v * p / 100 <= hi; });
        var orig = c.value, pctUp = c.pct, inc = orig * pctUp / 100, newPrice = orig + inc;
        var dh = divideHints(inc, orig, [inc, inc / orig, pctUp]);
        return {
            q: 'A ' + pick(rng, ITEMS[range]) + ' originally priced at PHP ' + money(orig) + ' increased in price to PHP ' +
                money(newPrice) + '. What is the percentage increase?',
            final: pctUp + '%',
            points: pts,
            steps: [
                { prompt: 'Step 1: Calculate the amount of price increase (' + newPrice + ' - ' + orig + ').',
                  answer: String(inc), hint1: 'Subtract original price from new price.',
                  hint2: newPrice + ' - ' + orig, hint3: 'Subtract ' + orig + ' from ' + newPrice + ' to find the increase.' },
                { prompt: 'Step 2: Divide increase (' + inc + ') by original price (' + orig + ').',
                  answer: String(inc / orig), hint1: dh.hint1, hint2: dh.hint2, hint3: dh.hint3 },
                { prompt: 'Step 3: Convert decimal (' + (inc / orig) + ') to percentage by multiplying by 100.',
                  answer: pctUp + '%', hint1: 'Multiply decimal by 100 and add % sign.',
                  hint2: (inc / orig) + ' * 100', hint3: 'Multiply by 100 and add the % sign.' }
            ]
        };
    }

    function percentageDecrease(rng, range, pts) {
        var lo = RANGES[range].lo;
        var c = chooseWithValue(rng, range, PCT_CHANGE, function (v, p) { return v * p / 100 >= 1 && v - v * p / 100 >= lo; });
        var base = c.value, pctDown = c.pct, dec = base * pctDown / 100, sale = base - dec;
        var dh = divideHints(dec, base, [dec, dec / base, pctDown]);
        return {
            q: 'An item (' + pick(rng, GOODS[range]) + ') originally priced at PHP ' + money(base) + ' is marked down to PHP ' +
                money(sale) + '. What is the percentage decrease?',
            final: pctDown + '%',
            points: pts,
            steps: [
                { prompt: 'Step 1: Calculate the amount of price decrease (' + base + ' - ' + sale + ').',
                  answer: String(dec), hint1: 'Subtract new sale price from original price.',
                  hint2: base + ' - ' + sale, hint3: 'Subtract ' + sale + ' from ' + base + ' to find the decrease.' },
                { prompt: 'Step 2: Divide decrease (' + dec + ') by original price (' + base + ').',
                  answer: String(dec / base), hint1: dh.hint1, hint2: dh.hint2, hint3: dh.hint3 },
                { prompt: 'Step 3: Convert decimal (' + (dec / base) + ') to percentage by multiplying by 100.',
                  answer: pctDown + '%', hint1: 'Multiply decimal by 100.',
                  hint2: (dec / base) + ' * 100', hint3: 'Multiply by 100 and add the % sign.' }
            ]
        };
    }

    /* One problem. diff: EASY | MEDIUM | HARD. range: tens | hundreds | thousands (omitted: a mix of the default sizes). */
    function generate(diff, pts, range, rng) {
        rng = rng || Math.random;
        if (!RANGES[range]) { range = pick(rng, DEFAULT_RANGES); }
        var draft;
        if (diff === 'EASY') { draft = pick(rng, [findPercentageSchool, findPercentageDiscount])(rng, range, pts); }
        else if (diff === 'MEDIUM') { draft = percentageIncrease(rng, range, pts); }
        else { draft = percentageDecrease(rng, range, pts); }
        draft.range = range;
        return draft;
    }

    /* Which size each of `count` problems uses: spread evenly over the chosen sizes (the odd ones out go to
       random sizes), then put in random order. */
    function planRanges(selected, count, rng) {
        rng = rng || Math.random;
        var chosen = ORDER.filter(function (r) { return selected && selected.indexOf(r) !== -1; });
        if (!chosen.length || !(count > 0)) { return []; }
        var each = Math.floor(count / chosen.length), extra = count % chosen.length, plan = [];
        chosen.forEach(function (r) { for (var i = 0; i < each; i++) { plan.push(r); } });
        shuffle(rng, chosen).slice(0, extra).forEach(function (r) { plan.push(r); });
        return shuffle(rng, plan);
    }

    /* A whole batch. Returns [] when no size is chosen (the caller shows the message). */
    function generateBatch(diff, pts, count, selected, rng) {
        return planRanges(selected, count, rng).map(function (r) { return generate(diff, pts, r, rng); });
    }

    return { RANGES: RANGES, ORDER: ORDER, DEFAULT_RANGES: DEFAULT_RANGES, generate: generate, planRanges: planRanges, generateBatch: generateBatch };
}));
