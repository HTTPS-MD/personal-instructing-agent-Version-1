/* PIA -- hint whiteboard: a worked example, drawn step by step.
 *
 * When a Tier 2 hint is a worked example, this draws it as written work INSIDE the tutor's chat bubble. Two kinds:
 *   multiply ("Example: 0.25 * 55. Ignore the decimal point: ..."): the numbers line up on the right, a whole number
 *     shows its hidden decimal point, the points are ignored, the rows are multiplied and added, the decimal places
 *     are counted, and the point moves into the answer.
 *   divide ("Example: 15 / 60. 15 is smaller than 60, ..."): long division in the bracket: the divisor outside, the
 *     number inside with a point and zeros, and for each digit of the answer: how many fit, multiply, subtract,
 *     bring down a 0.
 * The student presses Next for each step.
 *
 * It only SHOWS the example. The hint text still comes from the server; the tutor introduces it in the chat
 * and the work is drawn under that, in the same bubble (no separate board). Nothing here reads or sends an
 * answer, counts anything, or touches the clock. If the text is not an example this knows how to draw,
 * parseExample() returns null and the game shows the text alone.
 *
 * Two layers, so the maths can be tested without a browser:
 *   parseExample(text) and build(example)   pure: text -> numbers -> the steps and what each one says
 *   open(example, options)                  the board itself (needs a DOM)
 * Works in the browser (window.PIAHintBoard) and in Node (require).
 */
(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) { module.exports = api; } else { root.PIAHintBoard = api; }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    /* ---- The maths: no DOM ----------------------------------------------------------------------- */

    function decimalPlaces(s) { var i = String(s).indexOf('.'); return i === -1 ? 0 : String(s).length - i - 1; }

    function placePoint(int, dp) {
        var s = String(int);
        while (s.length <= dp) { s = '0' + s; }
        return dp ? s.slice(0, -dp) + '.' + s.slice(-dp) : s;
    }

    /* The multiply example the question generator writes: "Example: 0.25 * 55. Ignore the decimal point: ..." */
    var MULTIPLY = /^Example: (\d+\.\d{1,3}) \* (\d{1,4})\. Ignore the decimal point: /;

    /* The divide example: "Example: 15 / 60. 15 is smaller than 60, so the answer starts with "0." Then: ..." */
    var DIVIDE = /^Example: (\d{1,3}) \/ (\d{1,3})\. \1 is smaller than \2, so the answer starts with "0\." Then: /;

    function parseExample(text) {
        var t = String(text == null ? '' : text), m = MULTIPLY.exec(t);
        if (m) { return { kind: 'multiply', decimal: m[1], whole: m[2] }; }
        m = DIVIDE.exec(t);
        return m && Number(m[1]) > 0 && Number(m[1]) < Number(m[2]) ? { kind: 'divide', top: m[1], bottom: m[2] } : null;
    }

    /* Long division of a smaller number by a bigger one (the answer starts "0."): each turn brings down a 0, says how
       many times the divisor fits, multiplies, subtracts. */
    function buildDivide(example) {
        var a = Number(example.top), b = Number(example.bottom);
        var turns = [], cur = a * 10, guard = 0, q, rem;
        while (guard++ < 4) {
            q = Math.floor(cur / b); rem = cur - q * b;
            turns.push({ cur: cur, q: q, product: q * b, rem: rem });
            if (!rem) { break; }
            cur = rem * 10;
        }
        var digits = turns.map(function (t) { return t.q; }).join('');
        var resultText = '0.' + digits;
        var steps = [
            { parts: ['dv'], caption: 'Write ' + a + ' inside and ' + b + ' outside: ' + a + ' \u00f7 ' + b + '.' },
            { parts: ['zeros'], caption: 'Add a point and zeros after ' + a + ', so we can keep dividing.' },
            { parts: ['q0'], caption: a + ' is smaller than ' + b + ', so write 0 and a point on top.' }
        ];
        turns.forEach(function (t, i) {
            var n = i + 1;
            steps.push({ parts: ['q' + n], caption: t.q ? 'How many ' + b + 's fit in ' + t.cur + '? ' + t.q + '. Write ' + t.q + ' on top.'
                                                      : 'How many ' + b + 's fit in ' + t.cur + '? None yet. Write 0 on top.' });
            steps.push({ parts: ['p' + n], caption: t.q + ' \u00d7 ' + b + ' = ' + t.product + '. Write ' + t.product + ' under ' + t.cur + '.' });
            steps.push({ parts: ['r' + n], caption: t.cur + ' \u2212 ' + t.product + ' = ' + t.rem + '.' + (t.rem ? ' Bring down a 0: ' + t.rem + '0.' : ' Nothing is left over, so we are done.') });
        });
        steps.push({ parts: ['done'], caption: 'So ' + a + ' \u00f7 ' + b + ' = ' + resultText + '.' + (b === 100 ? ' Shortcut: \u00f7 100 moves the point 2 places left.' : '') + ' Now you try!' });
        var all = [];
        steps.forEach(function (s) { all = all.concat(s.parts); });
        return { kind: 'divide', top: String(a), bottom: String(b), turns: turns, digits: digits, resultText: resultText, steps: steps, allParts: all };
    }

    /* Everything the board shows, as data. `steps` are in order; each says which parts appear and what to read. */
    function build(example) {
        if (example.kind === 'divide') { return buildDivide(example); }
        var d = example.decimal, n = example.whole;
        var dp = decimalPlaces(d);
        var digits = String(Number(d.replace('.', '')));                  // 0.25 -> "25", 0.05 -> "5"
        var whole = Number(n);

        var partial = [];
        for (var i = 0; i < digits.length; i++) {
            var digit = Number(digits.charAt(digits.length - 1 - i));
            partial.push({ digit: digit, shift: i, value: String(whole * digit), zeros: new Array(i + 1).join('0') });
        }
        var total = whole * Number(digits);
        var totalText = String(total);
        var resultText = placePoint(total, dp);
        var places = dp + ' place' + (dp === 1 ? '' : 's');

        var steps = [
            { parts: ['a', 'b'], caption: 'Write the numbers. Line up the right side.' },
            { parts: ['ghost'], caption: 'A whole number has a hidden decimal point at the end: ' + n + '.' },
            { parts: ['ignore'], caption: 'Ignore the decimal points. Multiply like whole numbers.' }
        ];
        partial.forEach(function (p, k) {
            var more = p.shift ? ', then add ' + (p.shift === 1 ? 'a 0' : p.shift + ' zeros') + ' on the right: ' + p.value + p.zeros : '';
            steps.push({ parts: ['p' + k], caption: n + ' × ' + p.digit + ' = ' + p.value + more });
        });
        steps.push({ parts: ['sum'], caption: partial.length > 1 ? 'Add the rows: ' + totalText + '.' : 'That makes ' + totalText + '.' });
        steps.push({ parts: ['count'], caption: 'Count the decimal places in what you multiplied: ' + d + ' has ' + dp + ', ' + n + ' has 0. Total: ' + dp + '.' });
        steps.push({ parts: ['point'], caption: 'Start at the right and move the decimal point ' + places + ' to the left: ' + resultText + '.' });
        steps.push({ parts: ['done'], caption: 'So ' + d + ' × ' + n + ' = ' + resultText + '. Now try it with your numbers!' });

        return { kind: 'multiply', allParts: ['a', 'b', 'ghost', 'ignore'].concat(partial.map(function (p, k) { return 'p' + k; }), ['sum', 'count', 'point', 'done']),
                 decimal: d, whole: n, dp: dp, digits: digits, partial: partial, totalText: totalText, resultText: resultText, steps: steps };
    }

    /* ---- The board: needs a DOM ------------------------------------------------------------------ */

    var current = null;     // only one example at a time

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) { node.className = className; }
        if (text != null) { node.textContent = text; }
        return node;
    }

    function chars(text, classify) {
        var row = el('span', 'hb-chars');
        String(text).split('').forEach(function (c, i, all) {
            row.appendChild(el('span', 'hb-c ' + (classify ? classify(c, i, all) : ''), c));
        });
        return row;
    }

    /* ---- The long-division board ---------------------------------------------------------------------
       The bracket: the divisor outside on the left, the number inside with a point and zeros. Columns are the
       digits of the number with its zeros (the point has a narrow column of its own); every row is placed on
       those columns, so the answer's digits sit over the digits they belong to, and each row ends under the
       digit it was brought down to. */
    function buildDivideBoard(grid, model) {
        var a = model.top, b = model.bottom, Q = model.turns.length;
        var u = a.length - 1;                                           // the units digit's column
        var total = a.length + Q;                                       // digit columns
        var cellAt = function (col) { return col <= u ? col : col + 1; }; // the point sits between u and u + 1
        grid.classList.add('hb-long');
        grid.style.setProperty('--hb-rows', String((2 + 2 * Q) * 1.15));          // rows at the grid's line height
        grid.style.setProperty('--hb-pad', (14 + 4 * Q) + 'px');                 // the rules, and a little to spare
        grid.style.setProperty('--hb-gut', (b.length * 0.62 + 0.45) + 'em');

        function row(cls, gutterText, cells, wrapCls, wrapPart) {
            var r = el('div', 'hb-dr ' + cls);
            r.appendChild(el('span', 'hb-gut', gutterText || ''));
            var w = el('span', 'hb-cells ' + (wrapCls || ''));
            if (wrapPart) { w.setAttribute('data-part', wrapPart); }
            for (var i = 0; i <= total; i++) { w.appendChild(cells[i] || el('span', i === cellAt(u) + 1 ? 'hb-c hb-point' : 'hb-c')); }
            r.appendChild(w);
            grid.appendChild(r);
            return r;
        }
        function cell(text, part, hl, extra) {
            var c = el('span', 'hb-c ' + (extra || ''), text);
            if (part) { c.setAttribute('data-part', part); }
            if (hl) { c.setAttribute('data-hl', hl); }
            return c;
        }
        function pointCell(part, extra) { var c = el('span', 'hb-c hb-point ' + (extra || ''), '.'); if (part) { c.setAttribute('data-part', part); } return c; }
        /* A number written so that its last digit is in column `endCol`. */
        function placed(text, endCol, part, extra) {
            var cells = [], s = String(text);
            for (var k = 0; k < s.length; k++) {
                var col = endCol - (s.length - 1 - k);
                cells[cellAt(col)] = cell(s.charAt(k), part, null, typeof extra === 'function' ? extra(k, s.length) : extra);
            }
            return cells;
        }

        // the answer, on top: 0 over the units digit, then the point, then one digit per turn
        var qc = [];
        qc[cellAt(u)] = cell('0', 'q0');
        qc[cellAt(u) + 1] = pointCell('q0');
        model.turns.forEach(function (t, i) { qc[cellAt(u + i + 1)] = cell(String(t.q), 'q' + (i + 1)); });
        row('hb-qrow', '', qc);

        // the number inside the bracket, with its point and zeros; the digits each turn works on are tinted while it is explained
        var hlFor = function (col) { var l = []; for (var i = 1; i <= Q; i++) { if (u + i >= col) { l.push('q' + i); } } return l.join(' '); };
        var dc = [];
        a.split('').forEach(function (d, k) { dc[cellAt(k)] = cell(d, 'dv', hlFor(k)); });
        dc[cellAt(u) + 1] = pointCell('zeros');
        for (var z = 1; z <= Q; z++) { dc[cellAt(u + z)] = cell('0', 'zeros', hlFor(u + z)); }
        var dv = row('hb-dv', '', dc, 'hb-bracket', 'dv');
        dv.firstChild.textContent = b;
        dv.firstChild.setAttribute('data-part', 'dv');

        model.turns.forEach(function (t, i) {
            var n = i + 1, endCol = u + n;
            var pr = row('hb-prow', '\u2212', placed(t.product, endCol, 'p' + n));
            pr.firstChild.setAttribute('data-part', 'p' + n);
            var text = t.rem ? String(t.rem * 10) : '0';
            row('hb-rrow', '', placed(text, t.rem ? endCol + 1 : endCol, 'r' + n, function (k, len) { return t.rem && k === len - 1 ? 'hb-bring' : ''; }), 'hb-sub', 'r' + n);
        });
    }

    /* Which parts are showing, and which one the caption is talking about. */
    function markDivide(board, shown, focus) {
        Array.prototype.forEach.call(board.querySelectorAll('[data-part]'), function (e) {
            e.classList.toggle('is-on', shown.indexOf(e.getAttribute('data-part')) !== -1);
        });
        Array.prototype.forEach.call(board.querySelectorAll('[data-part], [data-hl]'), function (e) {
            var tokens = (e.getAttribute('data-part') || '').split(' ').concat((e.getAttribute('data-hl') || '').split(' '));
            e.classList.toggle('is-focus', tokens.some(function (t) { return t && focus.indexOf(t) !== -1; }));
        });
    }

    /* Draws the example INSIDE `options.host` (the tutor's chat bubble), after whatever the tutor said. It is part of
       the chat, not a window: there is no close button, and it goes when the tutor next speaks (the game calls
       close()), like any other hint. `options.root` gets the class "has-example" while it is open, so the page can
       give the bubble the room it needs. */
    function open(example, options) {
        options = options || {};
        var host = options.host;
        if (!host) { return null; }
        if (current) { current.close(); }

        var model = build(example);
        /* The tutor's introduction is the first screen (an empty board), so nothing needs its own room in the bubble. */
        var allSteps = (options.intro ? [{ parts: [], caption: options.intro }] : []).concat(model.steps);
        var reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
        var index = 0;

        var wrap = el('div', 'hb-inline');
        wrap.setAttribute('role', 'group');
        wrap.setAttribute('aria-label', 'Worked example');

        /* The written work. Every row is right-aligned so the last digits line up. */
        var board = el('div', 'hb-board');
        board.setAttribute('aria-hidden', 'true');
        var grid = el('div', 'hb-grid');
        var divide = model.kind === 'divide';
        var sumChars = null, dotEl = el('span', 'hb-dot');

        if (divide) { buildDivideBoard(grid, model); } else {

        var rowA = el('div', 'hb-row hb-a');
        var numA = el('span', 'hb-num');
        numA.appendChild(chars(model.whole));
        numA.appendChild(el('span', 'hb-ghost', '.'));
        rowA.appendChild(numA);

        var rowB = el('div', 'hb-row hb-b');
        rowB.appendChild(el('span', 'hb-times', '×'));
        var dot = model.decimal.indexOf('.');
        var seenNonZero = false;
        rowB.appendChild(chars(model.decimal, function (c, i) {
            if (i < dot) { return 'hb-ign'; }
            if (i === dot) { return 'hb-ign hb-point'; }
            if (c !== '0') { seenNonZero = true; }
            return 'hb-dec' + (seenNonZero ? '' : ' hb-ign');
        }));

        grid.appendChild(rowA);
        grid.appendChild(rowB);
        grid.appendChild(el('div', 'hb-line hb-line1'));

        model.partial.forEach(function (p, k) {
            var row = el('div', 'hb-row hb-p hb-p' + k);
            var text = el('span', 'hb-chars');
            text.appendChild(chars(p.value));
            if (p.zeros) { text.appendChild(chars(p.zeros, function () { return 'hb-zero'; })); }
            row.appendChild(text);
            grid.appendChild(row);
        });

        grid.appendChild(el('div', 'hb-line hb-line2'));
        var rowSum = el('div', 'hb-row hb-sum');
        sumChars = chars(model.totalText);
        rowSum.appendChild(sumChars);
        rowSum.appendChild(dotEl);
        grid.appendChild(rowSum);
        }
        board.appendChild(grid);
        wrap.appendChild(board);

        /* The words sit beside the work; the arrows and the step count are one row along the bottom. Every one of
           these has a fixed place and size, so nothing moves from one step to the next. */
        var caption = el('p', 'hb-caption');
        caption.setAttribute('role', 'status');
        caption.setAttribute('aria-live', 'polite');
        wrap.appendChild(caption);

        var controls = el('div', 'hb-controls');
        var back = el('button', 'hb-btn hb-back', '\u2190'); back.type = 'button';
        back.setAttribute('aria-label', 'Previous step');
        var next = el('button', 'hb-btn hb-next'); next.type = 'button';
        var count = el('span', 'hb-progress');
        var countText = el('span'); countText.setAttribute('aria-hidden', 'true');
        var countSpoken = el('span', 'hb-sr');
        count.appendChild(countText);
        count.appendChild(countSpoken);
        controls.appendChild(count);
        controls.appendChild(back);
        controls.appendChild(next);
        wrap.appendChild(controls);

        function steps() { return allSteps; }

        /* Where the decimal point goes: just left of the digit `dp` places from the right. It starts at the far
           right, then slides there. */
        function dotX(slotsFromRight) {
            var digits = sumChars.querySelectorAll('.hb-c');
            var last = digits[digits.length - 1];
            var base = last.offsetLeft + last.offsetWidth;
            if (!slotsFromRight) { return base; }
            var target = digits[digits.length - slotsFromRight];
            return target ? target.offsetLeft : base;
        }

        function setDot(slotsFromRight, animate) {
            dotEl.style.transition = animate && !reduced ? 'transform 700ms cubic-bezier(0.2, 0.9, 0.1, 1)' : 'none';
            dotEl.style.transform = 'translateX(' + (dotX(slotsFromRight) - dotEl.offsetWidth / 2) + 'px)';
        }

        function render() {
            var shown = [];
            var focus = steps()[index].parts;
            for (var i = 0; i <= index; i++) { steps()[i].parts.forEach(function (p) { shown.push(p); }); }
            board.setAttribute('data-shown', shown.join(' '));
            board.setAttribute('data-focus', focus.join(' '));
            if (divide) { markDivide(board, shown, focus); }
            if (!reduced) { caption.textContent = steps()[index].caption; }

            back.disabled = index === 0;
            var last = index === steps().length - 1;
            next.textContent = last ? '\u21bb' : '\u2192';
            next.title = last ? 'Replay' : '';
            next.setAttribute('aria-label', last ? 'Replay the example' : 'Next step');
            /* Padded to the width of the total ("01 / 10"), so the count is the same width on every step. */
            var width = String(steps().length).length;
            countText.textContent = ('00' + (index + 1)).slice(-width) + ' / ' + steps().length;
            countSpoken.textContent = 'Step ' + (index + 1) + ' of ' + steps().length;

            if (divide) { return; }
            var atPoint = shown.indexOf('point') !== -1;
            if (shown.indexOf('sum') === -1) { dotEl.style.opacity = '0'; }
            else {
                dotEl.style.opacity = atPoint || focus.indexOf('point') !== -1 ? '1' : '0';
                if (focus.indexOf('point') !== -1) {
                    setDot(0, false);
                    window.requestAnimationFrame(function () { window.requestAnimationFrame(function () { setDot(model.dp, true); }); });
                } else { setDot(atPoint ? model.dp : 0, false); }
            }
        }

        /* The words are centred up and down WITHOUT moving between steps: measure the tallest caption of the example once, and
           centre a box that tall; every caption then starts at the same height, at the top of that box. */
        var measure = el('p', 'hb-caption hb-measure');
        function fitCaption() {
            if (reduced || !caption.clientHeight) { return; }
            measure.style.width = caption.clientWidth + 'px';
            wrap.appendChild(measure);
            var tallest = 0;
            steps().forEach(function (s) { measure.textContent = s.caption; tallest = Math.max(tallest, measure.scrollHeight); });
            wrap.removeChild(measure);
            caption.style.paddingTop = Math.max(0, Math.floor((caption.clientHeight - tallest) / 2)) + 'px';
        }
        var watcher = null;

        function go(to) { index = Math.max(0, Math.min(steps().length - 1, to)); render(); }

        function close() {
            if (watcher) { watcher.disconnect(); watcher = null; }
            if (wrap.parentNode) { wrap.parentNode.removeChild(wrap); }
            if (options.root) { options.root.classList.remove('has-example'); }
            if (current && current.wrap === wrap) { current = null; }
            if (options.onClose) { options.onClose(); }
        }

        back.addEventListener('click', function () { go(index - 1); });
        next.addEventListener('click', function () { go(index === steps().length - 1 ? 0 : index + 1); });
        /* Tapping anywhere on the example goes to the next step (the buttons do their own thing). */
        wrap.addEventListener('click', function (e) {
            if (reduced || (e.target.closest && e.target.closest('.hb-btn'))) { return; }
            next.click();
        });
        /* Arrow keys only while focus is on the example: in the answer box they move the caret. */
        wrap.addEventListener('keydown', function (e) {
            if (e.key === 'ArrowRight') { e.preventDefault(); next.click(); }
            else if (e.key === 'ArrowLeft') { e.preventDefault(); back.click(); }
        });

        if (reduced) {
            /* Everything at once: no motion, the whole example and every line of explanation. */
            controls.hidden = true;
            caption.hidden = true;
            index = steps().length - 1;
            var list = el('ol', 'hb-all');
            steps().forEach(function (s) { list.appendChild(el('li', '', s.caption)); });
            wrap.insertBefore(list, caption);
        }

        host.appendChild(wrap);
        if (options.root) { options.root.classList.add('has-example'); }
        render();
        if (reduced) {
            board.setAttribute('data-shown', model.allParts.join(' '));
            if (divide) { markDivide(board, model.allParts, []); }
            else { dotEl.style.opacity = '1'; setDot(model.dp, false); }
        }
        fitCaption();
        if (window.ResizeObserver) { watcher = new ResizeObserver(fitCaption); watcher.observe(wrap); }
        if (document.fonts && document.fonts.ready) { document.fonts.ready.then(fitCaption); }
        /* The page may be scrolled past the chat (a phone): bring it into view. */
        try { host.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' }); } catch (e) { /* old browser: it stays where it is */ }

        current = { wrap: wrap, close: close };
        return current;
    }

    function closeAll() { if (current) { current.close(); } }
    function isOpen() { return !!current; }

    return { parseExample: parseExample, build: build, open: open, close: closeAll, isOpen: isOpen };
}));
