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

    function parseExample(text) {
        var m = MULTIPLY.exec(String(text == null ? '' : text));
        return m ? { kind: 'multiply', decimal: m[1], whole: m[2] } : null;
    }

    /* Everything the board shows, as data. `steps` are in order; each says which parts appear and what to read. */
    function build(example) {
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

        return { decimal: d, whole: n, dp: dp, digits: digits, partial: partial, totalText: totalText, resultText: resultText, steps: steps };
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
        var reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
        var index = 0;

        var wrap = el('div', 'hb-inline');
        wrap.setAttribute('role', 'group');
        wrap.setAttribute('aria-label', 'Worked example');

        /* The written work. Every row is right-aligned so the last digits line up. */
        var board = el('div', 'hb-board');
        board.setAttribute('aria-hidden', 'true');
        var grid = el('div', 'hb-grid');

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
        var sumChars = chars(model.totalText);
        rowSum.appendChild(sumChars);
        var dotEl = el('span', 'hb-dot');
        rowSum.appendChild(dotEl);
        grid.appendChild(rowSum);
        board.appendChild(grid);
        wrap.appendChild(board);

        var caption = el('p', 'hb-caption');
        caption.setAttribute('role', 'status');
        caption.setAttribute('aria-live', 'polite');
        wrap.appendChild(caption);

        var controls = el('div', 'hb-controls');
        var back = el('button', 'hb-btn hb-back', 'Back'); back.type = 'button';
        var next = el('button', 'hb-btn hb-next', 'Next'); next.type = 'button';
        var dots = el('span', 'hb-progress');
        controls.appendChild(back);
        controls.appendChild(dots);
        controls.appendChild(next);
        wrap.appendChild(controls);

        function steps() { return model.steps; }

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
            if (!reduced) { caption.textContent = steps()[index].caption; }

            back.disabled = index === 0;
            next.textContent = index === steps().length - 1 ? 'Replay' : 'Next';
            dots.textContent = (index + 1) + ' / ' + steps().length;

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

        function go(to) { index = Math.max(0, Math.min(steps().length - 1, to)); render(); }

        function close() {
            if (wrap.parentNode) { wrap.parentNode.removeChild(wrap); }
            if (options.root) { options.root.classList.remove('has-example'); }
            if (current && current.wrap === wrap) { current = null; }
            if (options.onClose) { options.onClose(); }
        }

        back.addEventListener('click', function () { go(index - 1); });
        next.addEventListener('click', function () { go(index === steps().length - 1 ? 0 : index + 1); });
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
            board.setAttribute('data-shown', ['a', 'b', 'ghost', 'ignore'].concat(model.partial.map(function (p, k) { return 'p' + k; }), ['sum', 'count', 'point', 'done']).join(' '));
            dotEl.style.opacity = '1';
            setDot(model.dp, false);
        }
        /* The page may be scrolled past the chat (a phone): bring it into view. */
        try { host.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' }); } catch (e) { /* old browser: it stays where it is */ }

        current = { wrap: wrap, close: close };
        return current;
    }

    function closeAll() { if (current) { current.close(); } }

    return { parseExample: parseExample, build: build, open: open, close: closeAll };
}));
