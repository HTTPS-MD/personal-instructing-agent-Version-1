/**
 * ============================================================================
 * PIA SYSTEM — TUTORING TUTORIAL (student-dashboard.html)
 * ============================================================================
 * A short guided walkthrough shown automatically ONCE per student account and
 * replayable from the Tutorial button in the top bar.
 *
 * PERSISTENCE. "Seen" is stored on the account, not in the browser, so it holds
 * across devices: the Supabase Auth user's own user_metadata
 * (`pia_tutorial_seen_at`), read with auth.getUser() (a server round trip,
 * never the cached session) and written with auth.updateUser({ data }).
 * No table, column or RPC is involved; nothing here touches research data.
 *
 *   - If the flag cannot be READ, the tutorial is not opened automatically
 *     (we would rather miss one showing than repeat it); the button still works.
 *   - If the flag cannot be WRITTEN, the tutorial still closes. It is treated
 *     as seen for this page view only, so the account may see it again on a
 *     later visit. Nothing claims the save worked.
 *
 * There is no tutorial video in the repository, so there is nothing to
 * autoplay: the walkthrough is text steps and cannot be blocked by a browser's
 * autoplay policy.
 * ==========================================================================*/
(function () {
    'use strict';

    var SEEN_KEY = 'pia_tutorial_seen_at';

    var STEPS = [
        { title: 'Welcome to your tutoring session',
          text: 'You will solve percentage word problems with your tutor. There is no timer, so take your time.' },
        { title: 'Type your answer',
          text: 'Read the problem, type your answer as a number, then press Check. The % sign is optional.' },
        { title: 'You get two tries',
          text: 'Each problem gives you 2 tries. If your first answer is not right, read the problem again and try once more.' },
        { title: 'Hints are there to help',
          text: 'Stuck? Press Give me a hint. Hints arrive one step at a time, so you can stop as soon as you know what to do.' }
    ];

    var sb = null;
    var overlay, titleEl, textEl, stepEl, backBtn, nextBtn, skipBtn, helpBtn, appRoot;
    var index = 0;
    var isOpen = false;
    var returnFocus = null;
    var seenKnown = false;      // true once the account is known to have seen it
    var seenThisPage = false;
    var saving = null;
    var spotlightTimer = null;

    function $(sel) { return document.querySelector(sel); }

    function reducedMotion() {
        return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    }

    /* ------------------------------------------------------ persistence */
    function readSeen() {
        if (!sb || !sb.auth || typeof sb.auth.getUser !== 'function') { return Promise.resolve(null); }
        return sb.auth.getUser().then(function (res) {
            if (res.error || !res.data || !res.data.user) { return null; }
            var meta = res.data.user.user_metadata || {};
            return !!meta[SEEN_KEY];
        }, function () { return null; });
    }

    function markSeen() {
        seenThisPage = true;
        if (seenKnown || saving || !sb || !sb.auth || typeof sb.auth.updateUser !== 'function') { return; }
        var data = {}; data[SEEN_KEY] = new Date().toISOString();
        saving = sb.auth.updateUser({ data: data }).then(function (res) {
            if (!res.error) { seenKnown = true; }
        }, function () { /* unconfirmed: may show again on a later visit */ })
            .then(function () { saving = null; });
    }

    /* ----------------------------------------------------------- dialog */
    function render() {
        var step = STEPS[index];
        stepEl.textContent = 'Step ' + (index + 1) + ' of ' + STEPS.length;
        titleEl.textContent = step.title;
        textEl.textContent = step.text;
        backBtn.disabled = index === 0;
        nextBtn.textContent = index === STEPS.length - 1 ? 'Finish' : 'Next';
    }

    function focusables() {
        return Array.prototype.slice.call(overlay.querySelectorAll('button:not([disabled])'));
    }

    function onKey(e) {
        if (!isOpen) { return; }
        if (e.key === 'Escape') { e.preventDefault(); close(true); return; }
        if (e.key !== 'Tab') { return; }
        var nodes = focusables();
        if (!nodes.length) { return; }
        var first = nodes[0], last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }

    function open() {
        if (isOpen) { return; }
        clearSpotlight();
        isOpen = true;
        index = 0;
        returnFocus = document.activeElement;
        render();
        overlay.classList.add('is-mounted');
        if (appRoot) { appRoot.setAttribute('inert', ''); }
        document.body.classList.add('is-locked');
        void overlay.offsetWidth;
        overlay.classList.add('is-open');
        nextBtn.focus({ preventScroll: true });
    }

    /* `skipped` closes via Skip/Escape; finishing passes false. Both mark seen. */
    function close(skipped) {
        if (!isOpen) { return; }
        isOpen = false;
        markSeen();
        overlay.classList.remove('is-open');
        if (appRoot) { appRoot.removeAttribute('inert'); }
        document.body.classList.remove('is-locked');
        setTimeout(function () { overlay.classList.remove('is-mounted'); }, reducedMotion() ? 0 : 160);
        if (returnFocus && returnFocus.focus) { returnFocus.focus({ preventScroll: true }); }
        if (skipped) { showHelpHint(); }
    }

    /* ---------------------------------------- "where to find it again" */
    function clearSpotlight() {
        clearTimeout(spotlightTimer);
        if (!helpBtn) { return; }
        helpBtn.classList.remove('is-spotlight', 'is-clicked');
        var c = $('.tutorial-cursor'); if (c) { c.remove(); }
        var n = $('.tutorial-callout'); if (n) { n.remove(); }
    }

    /* After Skip: a mock cursor glides to the Tutorial button and "clicks" it.
       With reduced motion there is no cursor: the button is simply outlined
       and a note says where it is. Either way the note is announced. */
    function showHelpHint() {
        if (!helpBtn) { return; }
        clearSpotlight();
        var rect = helpBtn.getBoundingClientRect();

        var note = document.createElement('p');
        note.className = 'tutorial-callout';
        note.setAttribute('role', 'status');
        note.textContent = 'You can replay the tutorial any time with this button.';
        document.body.appendChild(note);
        var left = Math.max(8, Math.min(window.innerWidth - 8 - note.offsetWidth, rect.right - note.offsetWidth));
        note.style.left = left + 'px';
        note.style.top = (rect.bottom + 10) + 'px';

        helpBtn.classList.add('is-spotlight');
        var done = function () { clearSpotlight(); };

        if (reducedMotion() || typeof Element.prototype.animate !== 'function') {
            spotlightTimer = setTimeout(done, 7000);
            return;
        }

        var cursor = document.createElement('span');
        cursor.className = 'tutorial-cursor';
        cursor.setAttribute('aria-hidden', 'true');
        cursor.innerHTML = '<svg viewBox="0 0 24 24" width="28" height="28"><path d="M5 3l14 8-6 1.8L9.8 19 5 3z" fill="currentColor" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>';
        document.body.appendChild(cursor);

        var tx = rect.left + rect.width / 2 - 6, ty = rect.top + rect.height / 2 - 4;
        var sx = Math.max(8, tx - 220), sy = Math.min(window.innerHeight - 40, ty + 190);
        var glide = cursor.animate(
            [{ transform: 'translate(' + sx + 'px,' + sy + 'px)', opacity: 0 },
             { transform: 'translate(' + sx + 'px,' + sy + 'px)', opacity: 1, offset: 0.12 },
             { transform: 'translate(' + tx + 'px,' + ty + 'px)', opacity: 1 }],
            { duration: 1000, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' });
        glide.onfinish = function () {
            helpBtn.classList.add('is-clicked');
            cursor.animate([{ transform: 'translate(' + tx + 'px,' + ty + 'px) scale(1)' },
                            { transform: 'translate(' + tx + 'px,' + ty + 'px) scale(.82)' },
                            { transform: 'translate(' + tx + 'px,' + ty + 'px) scale(1)' }],
                           { duration: 280, fill: 'forwards' });
            spotlightTimer = setTimeout(done, 3200);
        };
    }

    /* ------------------------------------------------------------- init */
    function init(client) {
        sb = client;
        overlay = $('#modal-tutorial');
        helpBtn = $('#tutorial-btn');
        appRoot = $('.learn');
        if (!overlay || !helpBtn) { return Promise.resolve(); }
        titleEl = $('#tutorial-title'); textEl = $('#tutorial-text'); stepEl = $('#tutorial-step');
        backBtn = $('#tutorial-back'); nextBtn = $('#tutorial-next'); skipBtn = $('#tutorial-skip');

        helpBtn.addEventListener('click', open);
        skipBtn.addEventListener('click', function () { close(true); });
        backBtn.addEventListener('click', function () { if (index > 0) { index -= 1; render(); } });
        nextBtn.addEventListener('click', function () {
            if (index < STEPS.length - 1) { index += 1; render(); } else { close(false); }
        });
        document.addEventListener('keydown', onKey);
        document.addEventListener('pointerdown', function () { if (!isOpen) { clearSpotlight(); } }, true);

        return readSeen().then(function (seen) {
            if (seen === null) { return; }        // unknown: do not auto-open
            seenKnown = seen;
            if (!seen && !seenThisPage) { open(); }
        });
    }

    window.PIATutorial = { init: init, open: open };
})();
