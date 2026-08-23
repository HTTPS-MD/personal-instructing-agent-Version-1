/**
 * ============================================================================
 * PIA SYSTEM — LANDING SCROLL NARRATIVE
 * ============================================================================
 * Presentation only. Nothing here touches auth, the database, or any element
 * auth.js owns — it can be removed and the page still signs people in.
 *
 * PERFORMANCE CONTRACT
 *   * No scroll event listener drives layout. Reveals, the nav state and the
 *     pinned sequence are all IntersectionObserver callbacks, which fire off
 *     the main thread's critical path and cost nothing per frame.
 *   * The one thing that must track scroll continuously — the hero's parallax
 *     — reads scrollY inside requestAnimationFrame and writes only a
 *     `transform`. Reading in rAF (never in the listener) avoids forcing a
 *     synchronous layout on every wheel tick.
 *   * Every property animated anywhere is `opacity` or `transform`. Neither
 *     triggers layout or paint, so none of this can produce layout shift and
 *     all of it stays on the compositor.
 * ==========================================================================*/
(function () {
    'use strict';

    var $ = function (s, r) { return (r || document).querySelector(s); };
    var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

    var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    /* ============================================ 1. REVEALS =========== */

    /* Elements lift into place once, when their top edge clears the lower
       quarter of the viewport. `once` semantics: an element that has arrived
       is never re-animated, so scrolling back up does not re-trigger a wave. */
    function initReveals() {
        var targets = $$('[data-reveal]');

        if (reduceMotion || !('IntersectionObserver' in window)) {
            targets.forEach(function (el) { el.classList.add('is-in', 'is-done'); });
            return;
        }

        var io = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (!entry.isIntersecting) { return; }
                var el = entry.target;
                el.classList.add('is-in');
                io.unobserve(el);

                /* Release the compositor layer once the transition finishes.
                   Leaving `will-change` on hundreds of nodes is itself a
                   performance problem — it holds GPU memory forever. */
                el.addEventListener('transitionend', function onDone(e) {
                    if (e.propertyName !== 'transform') { return; }
                    el.classList.add('is-done');
                    el.removeEventListener('transitionend', onDone);
                });
            });
        }, {
            /* Fire a little before the element is fully on screen so the
               motion reads as "already happening" rather than as a pop. */
            rootMargin: '0px 0px -12% 0px',
            threshold: 0.01
        });

        targets.forEach(function (el) { io.observe(el); });
    }

    /* ============================================ 2. NAV STATE ========= */

    /* A 1px sentinel at the top of the document. When it leaves the viewport
       the page has scrolled — no scroll listener, no per-frame work. */
    function initNav() {
        var nav = $('#site-nav');
        var sentinel = $('#nav-sentinel');
        if (!nav || !sentinel || !('IntersectionObserver' in window)) { return; }

        new IntersectionObserver(function (entries) {
            nav.classList.toggle('is-stuck', !entries[0].isIntersecting);
        }, { threshold: 0 }).observe(sentinel);
    }

    /* ============================================ 3. SEQUENCE ========== */

    /* The stage is pinned by CSS `position: sticky`; this only decides which
       of its stacked layers is opaque. A narrow horizontal band across the
       middle of the viewport acts as the playhead: whichever step is crossing
       it owns the stage. */
    function initSequence() {
        var steps = $$('#seq-steps .seq-step');
        var layers = $$('#seq-stage .stage-layer');
        if (!steps.length || !layers.length) { return; }

        var pinnedQuery = window.matchMedia('(min-width: 1025px)');
        var io = null;

        function activate(index) {
            steps.forEach(function (s, i) { s.classList.toggle('is-active', i === index); });
            layers.forEach(function (l, i) { l.classList.toggle('is-shown', i === index); });
        }

        function teardown() {
            if (io) { io.disconnect(); io = null; }
        }

        /* Unpinned (narrow or reduced-motion): every step reads at full
           strength and the stage rests on its first layer. */
        function showAll() {
            teardown();
            steps.forEach(function (s) { s.classList.add('is-active'); });
            layers.forEach(function (l, i) { l.classList.toggle('is-shown', i === 0); });
        }

        /* Pinned: a narrow band across the middle of the viewport is the
           playhead — whichever step is crossing it owns the stage. */
        function startPlayhead() {
            teardown();
            activate(0);

            io = new IntersectionObserver(function (entries) {
                entries.forEach(function (entry) {
                    if (!entry.isIntersecting) { return; }
                    var idx = Number(entry.target.getAttribute('data-step'));
                    if (!Number.isNaN(idx)) { activate(idx); }
                });
            }, { rootMargin: '-48% 0px -48% 0px', threshold: 0 });

            steps.forEach(function (s) { io.observe(s); });
        }

        function apply() {
            if (reduceMotion || !('IntersectionObserver' in window) || !pinnedQuery.matches) {
                showAll();
            } else {
                startPlayhead();
            }
        }

        apply();

        /* The mode was previously decided once at boot, which stranded anyone
           who rotated a tablet or resized a window in the wrong layout — the
           CSS had unpinned the stage while the playhead was still driving it,
           or vice versa. Re-evaluated whenever the breakpoint is crossed. */
        if (pinnedQuery.addEventListener) {
            pinnedQuery.addEventListener('change', apply);
        } else if (pinnedQuery.addListener) {
            pinnedQuery.addListener(apply);           /* Safari < 14 */
        }
    }

    /* ============================================ 4. HERO PARALLAX ===== */

    /* The only scroll-linked effect. scrollY is read inside rAF rather than in
       the listener, so a fast wheel cannot force a layout flush per event; the
       listener does nothing but set a flag. */
    function initParallax() {
        var visual = $('#hero-visual');
        var cue = $('#scroll-cue');
        if (!visual || reduceMotion) { return; }

        var ticking = false;

        function frame() {
            ticking = false;
            var y = window.scrollY || window.pageYOffset;

            /* Stop doing work entirely once the hero is off screen. */
            if (y > window.innerHeight * 1.2) { return; }

            visual.style.transform = 'translate3d(0,' + (y * -0.06).toFixed(2) + 'px,0)';
            if (cue) { cue.style.opacity = String(Math.max(0, 1 - y / 220)); }
        }

        window.addEventListener('scroll', function () {
            if (ticking) { return; }
            ticking = true;
            requestAnimationFrame(frame);
        }, { passive: true });

        frame();
    }

    /* ============================================ 5. COUNTERS ========== */

    /* Counts up when the number scrolls into view. The value's box is fixed by
       `min-width: 4ch` plus tabular figures in the stylesheet, so the digits
       can change every frame without moving anything around them. */
    function initCounters() {
        var nodes = $$('[data-count]');
        if (!nodes.length) { return; }

        if (reduceMotion || !('IntersectionObserver' in window)) {
            nodes.forEach(function (n) { n.textContent = n.getAttribute('data-count'); });
            return;
        }

        var io = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (!entry.isIntersecting) { return; }
                var node = entry.target;
                io.unobserve(node);

                var target = Number(node.getAttribute('data-count')) || 0;
                var start = performance.now();
                var DURATION = 900;

                function tick(now) {
                    var t = Math.min(1, (now - start) / DURATION);
                    /* ease-out cubic: fast start, gentle landing */
                    var eased = 1 - Math.pow(1 - t, 3);
                    node.textContent = String(Math.round(target * eased));
                    if (t < 1) { requestAnimationFrame(tick); }
                }

                requestAnimationFrame(tick);
            });
        }, { threshold: 0.5 });

        nodes.forEach(function (n) { io.observe(n); });
    }

    /* ============================================ 6. BOOT ============== */

    function boot() {
        initReveals();
        initNav();
        initSequence();
        initParallax();
        initCounters();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
