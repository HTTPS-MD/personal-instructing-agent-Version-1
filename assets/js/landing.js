/**
 * ============================================================================
 * PIA SYSTEM — SCROLLYTELLING LANDING
 * ============================================================================
 * Presentation only. Nothing in this file touches auth, the database, or any
 * element auth.js owns. Delete it and the page still signs people in — the
 * reveals resolve to their visible state, the video parks on its poster, and
 * every button still works.
 *
 * PERFORMANCE CONTRACT
 *   * Exactly ONE requestAnimationFrame loop and ONE passive scroll listener
 *     for the whole page. The listener does nothing but set a flag; every
 *     layout read happens inside the frame, so a fast wheel can never force a
 *     synchronous layout flush per event.
 *   * The rAF loop parks itself when nothing is animating and is restarted by
 *     the next scroll. An idle page schedules no frames at all.
 *   * Reveals and the nav state are IntersectionObserver callbacks, which
 *     cost nothing per frame.
 *   * Every property animated anywhere is `opacity`, `transform` or `color`.
 *     None participate in layout, so none of this can produce layout shift.
 *
 * SECURITY
 *   * No innerHTML. Every string that reaches the DOM goes through
 *     textContent or document.createTextNode, so a hostile heading can never
 *     become markup.
 *   * No inline style attributes are written, so the page's CSP never needs
 *     style-src-attr 'unsafe-inline'.
 * ==========================================================================*/
(function () {
    'use strict';

    var $ = function (s, r) { return (r || document).querySelector(s); };
    var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

    var motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    var reduceMotion = motionQuery.matches;

    var clamp = function (v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); };

    /* ==================================================================== *
     * 1. THE FRAME LOOP                                                    *
     * ==================================================================== *
     * One loop, shared. Anything that must track scroll registers a reader
     * here instead of adding its own listener. The loop stops itself once
     * every reader reports "settled", and the scroll listener wakes it.     */

    var readers = [];
    var running = false;
    var dirty = true;

    function addReader(fn) { readers.push(fn); }

    function frame() {
        var wantMore = false;

        for (var i = 0; i < readers.length; i++) {
            /* A reader returns true while it still has work to interpolate. */
            if (readers[i](dirty) === true) { wantMore = true; }
        }

        dirty = false;

        if (wantMore) {
            requestAnimationFrame(frame);
        } else {
            running = false;
        }
    }

    function wake() {
        dirty = true;
        if (running) { return; }
        running = true;
        requestAnimationFrame(frame);
    }

    /* passive: the handler never calls preventDefault, and saying so lets the
       browser scroll without waiting to find out. */
    window.addEventListener('scroll', wake, { passive: true });
    window.addEventListener('resize', wake, { passive: true });
    window.addEventListener('orientationchange', wake, { passive: true });


    /* ==================================================================== *
     * 2. VIDEO SCRUBBING ENGINE                                            *
     * ==================================================================== *
     * Maps scroll position through .reel onto video.currentTime.
     *
     *   progress = (how far the reel's top edge has passed the viewport top)
     *              / (reel height - one viewport)
     *
     * That denominator is exactly the distance the sticky stage stays pinned,
     * so progress runs 0 -> 1 over precisely the pinned span.
     *
     * The raw value is then eased toward with a lerp. Seeking straight to the
     * raw target makes a trackpad flick look like a slideshow, because each
     * seek waits on a decode; interpolating means we ask for frames we can
     * actually reach and the motion reads as continuous.
     *
     * Nothing here writes a layout-affecting property. currentTime is a media
     * property, not a style, so the scrub cannot shift the page.             */

    function initScrub() {
        var reel = $('#reel');
        var video = $('#reel-video');
        if (!reel || !video) { return; }

        var target = 0;      /* where the scroll says we should be, 0..1 */
        var eased = 0;       /* where we actually are                    */
        var duration = 0;
        var visible = true;
        var ready = false;

        /* A seek costs a decode. Below a quarter-frame of difference it is
           not visible, so we skip it and let the loop park. */
        var EPSILON = 1 / 96;

        function onMeta() {
            duration = video.duration;
            if (!isFinite(duration) || duration <= 0) { return; }
            ready = true;
            video.classList.add('is-live');
            wake();
        }

        if (video.readyState >= 1) { onMeta(); }
        video.addEventListener('loadedmetadata', onMeta);

        /* If the file 404s, is an unsupported codec, or the network dies
           mid-buffer, the poster is already painted underneath — so the
           failure state is "a still frame", not a black box. */
        function onDead() {
            ready = false;
            video.classList.remove('is-live');
        }
        video.addEventListener('error', onDead);
        video.addEventListener('emptied', onDead);

        /* Stop doing any of this when the reel is off screen. */
        if ('IntersectionObserver' in window) {
            new IntersectionObserver(function (entries) {
                visible = entries[0].isIntersecting;
                if (visible) { wake(); }
            }, { rootMargin: '10% 0px' }).observe(reel);
        }

        /* Honour a preference change made after load, not just at boot. */
        function onMotionChange() {
            reduceMotion = motionQuery.matches;
            if (reduceMotion && ready) {
                try { video.currentTime = 0; } catch (e) { /* not seekable yet */ }
            }
            wake();
        }
        if (motionQuery.addEventListener) { motionQuery.addEventListener('change', onMotionChange); }

        addReader(function () {
            if (!ready || !visible) { return false; }

            /* Reduced motion: the video is a still. No seeking, no loop. */
            if (reduceMotion) { return false; }

            var rect = reel.getBoundingClientRect();
            var span = reel.offsetHeight - window.innerHeight;
            if (span <= 0) { return false; }

            target = clamp(-rect.top / span, 0, 1);

            var delta = target - eased;
            if (Math.abs(delta) < 0.0005) {
                eased = target;
            } else {
                /* 0.18 is the whole feel of the thing: lower drags behind the
                   scroll, higher reintroduces the stutter we are smoothing. */
                eased += delta * 0.18;
            }

            var want = eased * duration;
            if (Math.abs(want - video.currentTime) > EPSILON) {
                try { video.currentTime = want; } catch (e) { /* seek raced a reload */ }
            }

            /* Keep the loop alive only while we are still catching up. */
            return Math.abs(target - eased) > 0.0005;
        });
    }


    /* ==================================================================== *
     * 2B. HERO BACKGROUND VIDEO                                            *
     * ==================================================================== *
     * A plain loop, not a scrub — nothing here reads scroll position, so it
     * adds no work to the frame loop above.
     *
     * The <video> ships with preload="none" and no autoplay attribute, so
     * NOTHING is downloaded until this function decides to play. It plays
     * only when all of these hold:
     *   * the visitor has not paused it (a choice remembered per browser),
     *   * they have not asked for reduced motion — unless they explicitly
     *     pressed Play, which outranks the OS default,
     *   * the connection is not in Save-Data or 2G mode,
     *   * the hero is on screen and the tab is visible.
     * The last two are resource rules, not preferences: a paused video
     * costs no decode, no GPU and no battery while the visitor reads the
     * rest of the page.
     *
     * Every failure path — autoplay refused (iOS Low Power Mode), every
     * source unplayable, JS absent — leaves the poster in place. The poster
     * is frame 0 of the loop, so success and failure look the same at rest. */

    function initHeroVideo() {
        var hero = $('#hero');
        var video = $('#hero-video');
        var toggle = $('#hero-video-toggle');
        if (!hero || !video) { return; }

        var conn = navigator.connection || {};
        if (conn.saveData === true || /(^|-)2g$/.test(conn.effectiveType || '')) { return; }

        var STORE = 'pia_hero_video';
        var choice = null;
        try { choice = localStorage.getItem(STORE); } catch (e) { /* private mode */ }

        var userPaused = choice === 'paused' || (choice !== 'playing' && reduceMotion);
        var onScreen = true;
        var label = toggle ? $('[data-video-label]', toggle) : null;

        /* The property, not only the attribute. Autoplay policy checks the
           live muted state, and a muted attribute alone has been known not
           to count when the element is touched by script first. */
        video.muted = true;

        function render() {
            if (!toggle) { return; }
            var paused = video.paused;
            toggle.classList.toggle('is-paused', paused);
            if (label) { label.textContent = paused ? 'Play background video' : 'Pause background video'; }
        }

        function sync() {
            var want = !userPaused && onScreen && !document.hidden;

            if (want && video.paused) {
                var attempt = video.play();
                /* A refused play() is not an error worth reporting — it is
                   the browser saying "not now". The poster stays and the
                   button offers Play. Swallowed here so the page's error
                   boundary (section 8) does not mistake it for a crash. */
                if (attempt && attempt.catch) { attempt.catch(render); }
            } else if (!want && !video.paused) {
                video.pause();
            }
        }

        video.addEventListener('play', render);
        video.addEventListener('pause', render);

        /* Source errors fire on the <source> elements, not on the <video>.
           Only the LAST one failing means nothing is left to try, and the
           control would then be a button that does nothing. */
        var sources = $$('source', video);
        if (sources.length && toggle) {
            sources[sources.length - 1].addEventListener('error', function () { toggle.hidden = true; });
        }

        if (toggle) {
            toggle.hidden = false;
            toggle.addEventListener('click', function () {
                userPaused = !video.paused;
                choice = userPaused ? 'paused' : 'playing';
                try { localStorage.setItem(STORE, choice); } catch (e) { /* private mode */ }
                sync();
                render();
            });
        }

        if ('IntersectionObserver' in window) {
            new IntersectionObserver(function (entries) {
                onScreen = entries[0].isIntersecting;
                sync();
            }).observe(hero);
        }

        document.addEventListener('visibilitychange', sync);

        /* A reduced-motion switch made mid-visit pauses the loop, unless the
           visitor had explicitly chosen to play it. */
        if (motionQuery.addEventListener) {
            motionQuery.addEventListener('change', function (event) {
                if (event.matches && choice !== 'playing') { userPaused = true; sync(); }
            });
        }

        render();
        sync();
    }


    /* ==================================================================== *
     * 3. WORD-BY-WORD SCRUB                                                *
     * ==================================================================== *
     * Splits a heading into words and lights them one at a time as the
     * heading crosses the viewport, which is the effect in the reference
     * recording. Colour only — the words never move, so a headline cannot
     * reflow mid-scroll.
     *
     * The split preserves the heading's existing element structure (the drop
     * title is three <span> lines), and rebuilds text nodes with
     * createTextNode, never innerHTML.                                       */

    function splitWords(root) {
        var words = [];

        function walk(node) {
            var kids = Array.prototype.slice.call(node.childNodes);

            kids.forEach(function (child) {
                if (child.nodeType === 3) {                       /* text */
                    var parts = child.nodeValue.split(/(\s+)/);
                    var frag = document.createDocumentFragment();

                    parts.forEach(function (part) {
                        if (!part) { return; }
                        if (/^\s+$/.test(part)) {
                            frag.appendChild(document.createTextNode(part));
                            return;
                        }
                        var span = document.createElement('span');
                        span.className = 'scrub-w';
                        span.appendChild(document.createTextNode(part));
                        frag.appendChild(span);
                        words.push(span);
                    });

                    node.replaceChild(frag, child);
                } else if (child.nodeType === 1) {                /* element */
                    walk(child);
                }
            });
        }

        walk(root);
        return words;
    }

    /* Headings that are ALREADY on screen at load cannot be scroll-scrubbed:
       there is no scroll left to drive them, so the tail of the sentence
       would sit greyed out under the visitor's nose. They light on a short
       stagger instead — same effect, triggered by arrival rather than by
       scroll.

       The stagger is a chain of timeouts rather than per-word transition
       delays, so no inline style attribute is ever written and the CSP never
       has to allow style-src-attr. */
    function initWordEntrance() {
        $$('[data-lit-words]').forEach(function (head) {
            var words = splitWords(head);
            if (!words.length) { return; }

            if (reduceMotion) {
                words.forEach(function (w) { w.classList.add('is-lit'); });
                return;
            }

            var STEP = 55;
            words.forEach(function (w, i) {
                setTimeout(function () { w.classList.add('is-lit'); }, 120 + i * STEP);
            });
        });
    }


    function initWordScrub() {
        var heads = $$('[data-scrub-words]');
        if (!heads.length) { return; }

        if (reduceMotion) { return; }   /* the CSS already lights them all */

        heads.forEach(function (head) {
            var words = splitWords(head);
            if (!words.length) { return; }

            var lit = -1;
            var active = false;

            if ('IntersectionObserver' in window) {
                new IntersectionObserver(function (entries) {
                    active = entries[0].isIntersecting;
                    if (active) { wake(); }
                }, { rootMargin: '25% 0px' }).observe(head);
            } else {
                active = true;
            }

            addReader(function () {
                if (!active) { return false; }

                var rect = head.getBoundingClientRect();
                var vh = window.innerHeight;

                /* Lighting starts when the heading's top crosses 85% of the
                   viewport and finishes when it reaches 30%. Measured off the
                   TOP edge only, not the height: a headline that fills the
                   screen would otherwise still be dark by the time it left,
                   and the last word would never be read.

                   The consequence at the top of the document is deliberate.
                   The <h1> sits above 85% at rest, so it is fully lit at
                   first paint — dimming the first sentence a visitor sees
                   would be an effect at the expense of the page. Only
                   headings that genuinely scroll INTO view get scrubbed. */
                var startAt = vh * 0.85;
                var endAt = vh * 0.30;
                var p = clamp((startAt - rect.top) / Math.max(1, startAt - endAt), 0, 1);

                var want = Math.round(p * words.length) - 1;
                if (want === lit) { return false; }

                /* Only touch the spans that actually changed state. */
                var from = Math.min(lit, want) + 1;
                var to = Math.max(lit, want);
                for (var i = from; i <= to; i++) {
                    if (words[i]) { words[i].classList.toggle('is-lit', i <= want); }
                }
                lit = want;

                return false;
            });
        });
    }


    /* ==================================================================== *
     * 4. SCROLL REVEALS                                                    *
     * ==================================================================== *
     * `once` semantics: an element that has arrived is never re-animated, so
     * scrolling back up does not replay a wave.                              */

    function initReveals() {
        var targets = $$('[data-reveal]');
        if (!targets.length) { return; }

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

                el.addEventListener('transitionend', function done(e) {
                    if (e.propertyName !== 'transform') { return; }
                    el.classList.add('is-done');
                    el.removeEventListener('transitionend', done);
                });
            });
        }, {
            /* Fire slightly before the element is fully on screen, so the
               motion reads as "already happening" rather than as a pop. */
            rootMargin: '0px 0px -12% 0px',
            threshold: 0.01
        });

        targets.forEach(function (el) { io.observe(el); });
    }


    /* ==================================================================== *
     * 5. HOVER INTENT                                                      *
     * ==================================================================== *
     * 150ms of sustained hover before the state applies, so dragging the
     * pointer across six rows does not strobe all six.
     *
     * Deliberately NOT applied to buttons. A button that waits 150ms before
     * acknowledging the pointer reads as a dropped frame, not as intent —
     * the delay belongs on ambient surfaces, not on controls.
     *
     * Gated on a real hover-capable pointer: on touch, :hover latches after a
     * tap and the state would stick.                                         */

    function initHoverIntent() {
        if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) { return; }

        var DWELL = 150;

        $$('[data-hover-intent]').forEach(function (el) {
            var timer = null;

            el.addEventListener('mouseenter', function () {
                timer = setTimeout(function () { el.classList.add('is-keen'); }, DWELL);
            });

            el.addEventListener('mouseleave', function () {
                clearTimeout(timer);
                timer = null;
                el.classList.remove('is-keen');
            });

            /* Keyboard users get the same affordance without the dwell —
               focus is already an explicit act of intent. */
            el.addEventListener('focusin', function () { el.classList.add('is-keen'); });
            el.addEventListener('focusout', function () { el.classList.remove('is-keen'); });
        });
    }


    /* ==================================================================== *
     * 6. THEME                                                             *
     * ==================================================================== *
     * Three states, deliberately: an explicit choice in localStorage always
     * wins; with nothing stored the page follows the operating system. The
     * inline script in <head> applies the stored value before first paint, so
     * there is never a flash of the wrong theme.
     *
     * The write is optimistic — the attribute flips immediately and the
     * persist is attempted afterwards. In private mode the persist throws and
     * the theme still changes for this session, which is the right failure.  */

    /* Two toggles share the job: the icon button in the bar and the labelled
       switch in the phone sheet (the bar drops its own below 30rem). Every
       [data-theme-toggle] flips the same attribute and all of them re-sync,
       so the two can never show different states. */
    function initTheme() {
        var toggles = $$('[data-theme-toggle]');
        if (!toggles.length) { return; }

        function current() {
            return document.documentElement.getAttribute('data-theme') || 'dark';
        }

        function sync() {
            var dark = String(current() === 'dark');
            toggles.forEach(function (t) { t.setAttribute('aria-pressed', dark); });
        }

        toggles.forEach(function (toggle) {
            toggle.addEventListener('click', function () {
                var next = current() === 'dark' ? 'light' : 'dark';
                document.documentElement.setAttribute('data-theme', next);
                sync();
                try { localStorage.setItem('pia_theme', next); } catch (e) { /* private mode */ }
            });
        });

        sync();
    }


    /* ==================================================================== *
     * 7. SKIP LINK                                                         *
     * ==================================================================== *
     * auth.js intercepts every a[href^="#"] to scroll it smoothly, which
     * moves the viewport but NOT the focus — and a skip link that does not
     * move focus is decorative. <main> carries tabindex="-1" so it can take
     * focus programmatically without joining the tab order.                  */

    function initSkipLink() {
        var link = $('[data-skip]');
        var main = $('#main');
        if (!link || !main) { return; }

        link.addEventListener('click', function () {
            main.focus({ preventScroll: true });
        });
    }


    /* ==================================================================== *
     * 8. CONNECTION + ERROR SURFACE                                        *
     * ==================================================================== *
     * The page is static, so it survives being offline; the auth calls do
     * not. Say so rather than letting a sign-in spin forever.
     *
     * The same strip doubles as the error boundary. A thrown exception in any
     * script on the page would otherwise be invisible — the reveals would
     * simply never fire and the page would look blank and broken. This turns
     * a silent failure into a stated one, and force-resolves the reveals so
     * the content is readable even when its animation never ran.             */

    function initWire() {
        var wire = $('#wire');
        if (!wire) { return; }

        var text = $('[data-wire-text]', wire);
        var offline = false;
        var crashed = false;

        function render() {
            if (crashed) { return; }              /* a crash outranks the network */
            wire.hidden = !offline;
            wire.classList.remove('is-error');
            if (offline && text) {
                text.textContent = "You're offline. The page still works — signing in won't.";
            }
        }

        function goOffline() { offline = true; render(); }
        function goOnline() { offline = false; render(); }

        window.addEventListener('offline', goOffline);
        window.addEventListener('online', goOnline);
        if (navigator.onLine === false) { goOffline(); }

        function crash(detail) {
            if (crashed) { return; }
            crashed = true;
            console.error('[PIA] landing page error:', detail);

            wire.hidden = false;
            wire.classList.add('is-error');
            if (text) {
                text.textContent = 'Part of this page tripped over itself. Reload, or carry on — sign-in still works.';
            }

            /* Fail visible, not blank. */
            $$('[data-reveal]').forEach(function (el) { el.classList.add('is-in', 'is-done'); });
            $$('.scrub-w').forEach(function (el) { el.classList.add('is-lit'); });
        }

        window.addEventListener('error', function (e) { crash(e.error || e.message); });
        window.addEventListener('unhandledrejection', function (e) { crash(e.reason); });
    }


    /* ==================================================================== *
     * 9. BOOT                                                              *
     * ==================================================================== */

    function boot() {
        initWire();          /* first, so it can catch a throw from any of the rest */
        initTheme();
        initSkipLink();
        initReveals();
        initWordEntrance();
        initWordScrub();
        initScrub();
        initHeroVideo();
        initHoverIntent();
        wake();

        /* For whoever opens the console. Every project should have one. */
        console.log(
            '%c PIA %c Personal Instructing Agent\n' +
            '  Six agents. One of them teaches the way you think.\n' +
            '  Built at the University of the East. Hello to the one student who checked.',
            /* Console styling cannot read CSS variables, so the palette
               literals from landing.css are repeated here, once. */
            'background:#D4FF3A;color:#0E0B16;font-weight:700;padding:2px 6px',
            'color:#A259FF'
        );
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
