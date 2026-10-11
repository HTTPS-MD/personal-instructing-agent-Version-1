/* PIA -- hint whiteboard: a worked example, drawn step by step.
 *
 * When a Tier 2 hint is a worked example ("Example: 0.25 * 55. Ignore the decimal point: ..."), this draws it
 * as written column work INSIDE the tutor's chat bubble: the numbers line up on the right, a whole number shows
 * its hidden decimal point, the points are ignored, the rows are multiplied and added, the decimal places
 * are counted, and the point moves into the answer. The student presses Next for each step.
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

    /* The conversion example: "Example: 35 / 100. Divide by 100: move the decimal point 2 places to the left. ..." */
    var DIVIDE_BY_100 = /^Example: (\d{1,2}) \/ 100\. Divide by 100: /;

    function parseExample(text) {
        var t = String(text == null ? '' : text), m = MULTIPLY.exec(t);
        if (m) { return { kind: 'multiply', decimal: m[1], whole: m[2] }; }
        m = DIVIDE_BY_100.exec(t);
        return m ? { kind: 'shift', number: String(Number(m[1])) } : null;
    }

    /* Dividing a whole number by 100: the decimal point moves two places to the left (zeros fill the gaps).
       The digits are written again with a 0 in front, so there is always a place for the point to land. */
    function buildShift(example) {
        var n = example.number, dp = 2;
        var padded = placePoint(n, dp).replace('.', '');          // 35 -> "035", 8 -> "008"
        var resultText = placePoint(n, dp);                       // "0.35", "0.08"
        var steps = [
            { parts: ['a', 'b'], caption: 'Write the number and what you divide by: ' + n + ' \u00f7 100.' },
            { parts: ['ghost'], caption: n + ' is a whole number, so it has a hidden decimal point at the end: ' + n + '.' },
            { parts: ['zeros'], caption: '100 has 2 zeros. Dividing by 100 moves the decimal point 2 places to the left.' },
            { parts: ['sum'], dot: 0, caption: 'Write the digits again with a 0 in front for the empty place: ' + padded + '.' },
            { parts: ['hop1'], dot: 1, caption: 'Move the point 1 place to the left.' },
            { parts: ['hop2'], dot: 2, caption: 'Move it 1 more place: ' + resultText + '.' },
            { parts: ['done'], caption: 'So ' + n + ' \u00f7 100 = ' + resultText + '. Now try it with your numbers!' }
        ];
        return { kind: 'shift', number: n, dp: dp, padded: padded, resultText: resultText, steps: steps,
                 allParts: ['a', 'b', 'ghost', 'zeros', 'sum', 'hop1', 'hop2', 'done'] };
    }

    /* Everything the board shows, as data. `steps` are in order; each says which parts appear and what to read. */
    function build(example) {
        if (example.kind === 'shift') { return buildShift(example); }
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

        var shift = model.kind === 'shift';
        var rowA = el('div', 'hb-row hb-a');
        var numA = el('span', 'hb-num');
        numA.appendChild(chars(shift ? model.number : model.whole));
        numA.appendChild(el('span', 'hb-ghost', '.'));
        rowA.appendChild(numA);

        var rowB = el('div', 'hb-row hb-b');
        if (shift) {
            rowB.appendChild(el('span', 'hb-times', '\u00f7'));
            rowB.appendChild(el('span', 'hb-c'));                   // room for the sign, so it never sits on the 1
            rowB.appendChild(chars('100', function (c, i) { return i ? 'hb-z' : ''; }));
        } else {
            rowB.appendChild(el('span', 'hb-times', '×'));
            var dot = model.decimal.indexOf('.');
            var seenNonZero = false;
            rowB.appendChild(chars(model.decimal, function (c, i) {
                if (i < dot) { return 'hb-ign'; }
                if (i === dot) { return 'hb-ign hb-point'; }
                if (c !== '0') { seenNonZero = true; }
                return 'hb-dec' + (seenNonZero ? '' : ' hb-ign');
            }));
        }

        grid.appendChild(rowA);
        grid.appendChild(rowB);
        grid.appendChild(el('div', 'hb-line hb-line1'));

        (shift ? [] : model.partial).forEach(function (p, k) {
            var row = el('div', 'hb-row hb-p hb-p' + k);
            var text = el('span', 'hb-chars');
            text.appendChild(chars(p.value));
            if (p.zeros) { text.appendChild(chars(p.zeros, function () { return 'hb-zero'; })); }
            row.appendChild(text);
            grid.appendChild(row);
        });

        if (!shift) { grid.appendChild(el('div', 'hb-line hb-line2')); }
        var rowSum = el('div', 'hb-row hb-sum');
        var sumChars = chars(shift ? model.padded : model.totalText);
        rowSum.appendChild(sumChars);
        var dotEl = el('span', 'hb-dot');
        rowSum.appendChild(dotEl);
        grid.appendChild(rowSum);
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

        /* Dividing by 100: the point sits at the right of the new digits, then hops left one place per step. */
        function shiftDot() {
            var now = null, before = 0;
            for (var i = 0; i <= index; i++) {
                if (steps()[i].dot !== undefined) { before = now === null ? 0 : now; now = steps()[i].dot; }
            }
            if (now === null) { dotEl.style.opacity = '0'; return; }
            dotEl.style.opacity = '1';
            if (steps()[index].dot !== undefined && before !== now) {
                setDot(before, false);
                window.requestAnimationFrame(function () { window.requestAnimationFrame(function () { setDot(now, true); }); });
            } else { setDot(now, false); }
        }

        function render() {
            var shown = [];
            var focus = steps()[index].parts;
            for (var i = 0; i <= index; i++) { steps()[i].parts.forEach(function (p) { shown.push(p); }); }
            board.setAttribute('data-shown', shown.join(' '));
            board.setAttribute('data-focus', focus.join(' '));
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

            if (shift) { shiftDot(); return; }
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
            dotEl.style.opacity = '1';
            setDot(model.dp, false);
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
