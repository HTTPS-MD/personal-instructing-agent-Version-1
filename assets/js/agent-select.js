/**
 * ============================================================================
 * PIA SYSTEM — AGENT SELECT
 * ============================================================================
 * Drives "Meet your tutors" in Act 2: the row of tutor tabs, the figure on
 * the stage, the detail panel and the faded name behind the figure.
 *
 * Deliberately its own file, on the same rule the rest of this codebase
 * follows: landing.js owns the scroll engine, the reveals and the video
 * scrub, and none of that is touched here. Delete this file and the select
 * screen becomes a static display of whichever agent is marked selected in
 * the markup — every panel is real HTML, so nothing disappears.
 *
 * WHAT IT IS, STRUCTURALLY
 * A textbook ARIA tablist. The tutor row is the tabs, the detail panels are the
 * tabpanels, and selection moves with the arrow keys as well as the pointer
 * — which the six scrolling sections this replaced could not offer at all,
 * because "scroll further" is not an affordance you can tab to.
 *
 * ROVING TABINDEX
 * Exactly one roster button is tabbable at a time (tabindex 0); the rest are
 * -1. That is the required pattern for a tablist: Tab moves you INTO and OUT
 * of the rail, arrows move you WITHIN it. Without it a keyboard user has to
 * press Tab six times to get past the roster.
 *
 * WHY THE FIGURES ARE TOGGLED WITH [hidden] AND NOT REBUILT
 * models.js observes every .model-canvas-wrapper on the page and mounts a
 * <model-viewer> the first time one comes near the viewport. A display:none
 * box has no box, so it can never intersect — which means each agent's model
 * is requested the first time that agent is SELECTED, and stays mounted after.
 * That gives lazy per-agent loading for free, with no change to the loader.
 * ==========================================================================*/
(function () {
    'use strict';

    var root = document.getElementById('agent-select');
    if (!root) { return; }

    var tabs = Array.prototype.slice.call(root.querySelectorAll('.roster-item[role="tab"]'));
    if (!tabs.length) { return; }

    var counter = document.getElementById('select-counter');
    var ghost = document.getElementById('stage-ghost');

    function figureFor(id) { return root.querySelector('.stage-figure[data-figure="' + id + '"]'); }
    function panelFor(id) { return document.getElementById('panel-' + id); }

    /* Text only, via textContent — the agent name reaches this function from
       a data attribute, and it is never allowed to become markup. */
    function select(tab, opts) {
        var id = tab.getAttribute('data-agent');
        if (!id) { return; }

        tabs.forEach(function (t) {
            var on = t === tab;
            var tid = t.getAttribute('data-agent');

            t.setAttribute('aria-selected', on ? 'true' : 'false');
            t.tabIndex = on ? 0 : -1;

            var fig = figureFor(tid);
            var pan = panelFor(tid);
            if (fig) { fig.hidden = !on; }
            if (pan) { pan.hidden = !on; }
        });

        var name = (tab.querySelector('.roster-name') || {}).textContent || '';
        if (ghost) { ghost.textContent = name.trim(); }

        /* The "01 / 06" readout was removed with the number badges; kept
           null-safe so markup that still carries one keeps working. */
        if (counter) {
            var n = tabs.indexOf(tab) + 1;
            counter.textContent = (n < 10 ? '0' : '') + n;
        }

        /* Focus follows selection only for keyboard-driven changes. Moving
           focus on a plain click would scroll-jump a long page under the
           pointer, which is exactly the jitter this section is trying not to
           have. */
        if (opts && opts.focus) { tab.focus(); }
    }

    tabs.forEach(function (tab) {
        tab.addEventListener('click', function () { select(tab, { focus: false }); });
    });

    /* Arrow keys wrap. Both axes are bound: the row reads left-to-right, but
       a student who reaches for Down to mean "next" should not find it dead. */
    root.addEventListener('keydown', function (e) {
        var current = document.activeElement;
        var i = tabs.indexOf(current);
        if (i === -1) { return; }

        var next = null;

        switch (e.key) {
            case 'ArrowDown':
            case 'ArrowRight':
                next = tabs[(i + 1) % tabs.length];
                break;
            case 'ArrowUp':
            case 'ArrowLeft':
                next = tabs[(i - 1 + tabs.length) % tabs.length];
                break;
            case 'Home':
                next = tabs[0];
                break;
            case 'End':
                next = tabs[tabs.length - 1];
                break;
            default:
                return;
        }

        e.preventDefault();
        select(next, { focus: true });
    });
})();
