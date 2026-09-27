/**
 * ============================================================================
 * PIA SYSTEM — 3D AGENT MODELS
 * ============================================================================
 * Mounts a <model-viewer> into each .model-canvas-wrapper on the landing page,
 * one at a time, as the slot approaches the viewport.
 *
 * This file is deliberately separate from landing.js. The scroll engine, the
 * IntersectionObserver reveals and the video scrub all live there and are not
 * touched by anything here — delete this file and the page loses its 3D
 * models and nothing else.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * TO ADD A MODEL
 *   1. Export an uncompressed .glb (see NOTE ON COMPRESSION below).
 *   2. Save it as assets/models/<id>.glb, where <id> is the agent's
 *      data-model value — they are listed in AVAILABLE just below.
 *   3. Uncomment that id.
 * That is the whole procedure. Nothing else in the codebase changes.
 *
 * An id left commented out costs nothing at all: no request is made, and its
 * slot keeps the "coming soon" display case it already shows. So the six can
 * land one at a time over as many weeks as they need to.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * WHY LAZY
 *   The renderer is ~935 KB and each model is another 1–2 MB. Loading six of
 *   them at first paint would cost a Grade 7 lab machine several seconds
 *   before the page even moves. Instead the library is dynamically imported
 *   the first time any slot comes within a screen of the viewport, and each
 *   model is fetched only when its own slot does.
 *
 * WHY IT CANNOT SHIFT THE PAGE
 *   .model-canvas-wrapper locks `aspect-ratio: 3 / 4` in landing.css, so the
 *   box is already at its final size before this script runs. The mounted
 *   element is absolutely positioned at inset:0 inside it. Nothing here
 *   participates in layout, so a model arriving — or failing — moves nothing.
 * ==========================================================================*/
(function () {
    'use strict';

    /* ══════════════════════════════════ 1. WHAT EXISTS ═══════════════════
       Uncomment an id once its .glb is sitting in assets/models/.
       Everything commented out stays a "coming soon" case, silently. */
    var AVAILABLE = [
        'pia-open'

        /* The five below have no .glb in assets/models/ yet. Listing an id
           whose file does not exist is not free: the slot fires a request,
           takes the 404, and settles on "could not load" — an ERROR state,
           shown to a visitor, for a model that was simply never delivered.
           Commented out they cost nothing at all (no request) and the slot
           keeps its "coming soon" display case, which is the honest reading.

           Uncomment each one as its file lands. */
        // 'pia-conscientious',
        // 'pia-extravert',
        // 'pia-agreeable',
        // 'pia-calm',
        // 'pia-neutral'
    ];

    /* TEMPORARY — 3D loading is switched off for the test deploy.
       pia-open.glb (66 MiB) is over Cloudflare Pages' 25 MiB per-file limit
       and has been taken out of assets/models/. While this is false no slot
       requests the renderer or a model; the slots listed in AVAILABLE show
       DISABLED_LABEL instead. To turn 3D back on: put a slimmed-down
       pia-open.glb (under 25 MiB) back in assets/models/ and set this to
       true. Nothing else changes. */
    var MODELS_ENABLED = false;
    var DISABLED_LABEL = '3D Model Loading Disabled for Testing';

    var MODEL_DIR = 'assets/models/';
    var MODEL_EXT = '.glb';

    /* Vendored, not CDN. Same reasoning as the Supabase SDK: a filtered
       school network must not be able to break the page, and script-src
       stays 'self'.

       All three paths are resolved to ABSOLUTE urls against this file's own
       location, which is the only form that is correct for both consumers:

         * import() resolves a relative specifier against the SCRIPT's url,
           so './assets/js/vendor/...' from inside /assets/js/models.js
           becomes /assets/js/assets/js/vendor/... — a real bug, and a quiet
           one, because the failure looks exactly like a missing file.
         * three.js's decoder loaders concatenate their location onto a
           filename and fetch it, which resolves against the DOCUMENT.

       An absolute url satisfies both, and survives this folder being moved
       or the site being served from a subpath. */
    var HERE = (document.currentScript && document.currentScript.src) ||
        (window.location.origin + '/assets/js/models.js');
    var VENDOR = new URL('vendor/', HERE).href;

    var RENDERER = VENDOR + 'model-viewer.min.js';
    var DRACO_DIR = VENDOR + 'draco/';
    var BASIS_DIR = VENDOR + 'basis/';

    /* NOTE ON COMPRESSION
       model-viewer reaches out to www.gstatic.com for Draco and KTX2
       decoders the first time it meets a compressed model. Those decoders
       are vendored into assets/js/vendor/ and pointed at locally below, so
       that request never happens — but they are only fetched at all if a
       model actually uses compression.

       Export UNCOMPRESSED if you can (in Blender: glTF Binary, and leave
       "Draco mesh compression" unticked). Six low-poly characters do not
       need it, and it keeps the page down to one wasm-free path. */

    /* ══════════════════════════════════ 2. HELPERS ═══════════════════════ */

    var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
    var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    /* Text is written with textContent throughout — never innerHTML — so a
       filename can never become markup. */
    function setSlotState(wrapper, label) {
        var ratio = wrapper.querySelector('.slot-ratio');
        if (ratio) { ratio.textContent = label; }
    }

    /* ══════════════════════════════════ 3. MOUNT ═════════════════════════ */

    function mount(wrapper, id) {
        var src = MODEL_DIR + id + MODEL_EXT;
        var name = wrapper.getAttribute('data-model-name') || id;

        var mv = document.createElement('model-viewer');

        /* ATTRIBUTES, never properties. <model-viewer> is a custom element
           loaded as a module: assigning mv.cameraOrbit before it upgrades
           creates an own-property that permanently shadows the class
           accessor. setAttribute is correct at every point in its life. */
        mv.setAttribute('src', src);
        mv.setAttribute('alt', name + ', shown in 3D. Drag to look around it.');
        mv.setAttribute('camera-controls', '');
        mv.setAttribute('interaction-prompt', 'none');
        mv.setAttribute('shadow-intensity', '0.7');
        mv.setAttribute('environment-image', 'neutral');
        mv.setAttribute('loading', 'eager');
        mv.setAttribute('reveal', 'auto');

        /* disable-zoom and touch-action are not cosmetic. camera-controls
           otherwise eats the mouse wheel and the vertical swipe, so scrolling
           with the pointer over a model would zoom the model instead of
           moving the page — on a page that is ENTIRELY a scroll experience.
           Drag-to-rotate is unaffected by either. */
        mv.setAttribute('disable-zoom', '');
        mv.setAttribute('touch-action', 'pan-y');

        /* Continuous motion answers to the same preference as everything
           else on the page. The attribute is omitted rather than paused, so
           no animation frame is scheduled at all. */
        if (!reduceMotion) {
            mv.setAttribute('auto-rotate', '');
            mv.setAttribute('auto-rotate-delay', '600');
            mv.setAttribute('rotation-per-second', '16deg');
        }

        wrapper.classList.add('is-loading');
        setSlotState(wrapper, 'loading…');

        mv.addEventListener('load', function () {
            wrapper.classList.remove('is-loading');
            wrapper.classList.add('has-model');

            /* Put the caption back to its resting text. It is about to be
               hidden, but if the model is ever torn down the case should
               not be left claiming to be loading something. */
            setSlotState(wrapper, '3 : 4 · drag to rotate');

            /* Hand accessibility over to the element that now owns the
               content. While the wrapper carried role="img" every descendant
               was excluded from the accessibility tree, which would have
               hidden the viewer's own label and its keyboard controls. */
            wrapper.removeAttribute('role');
            wrapper.removeAttribute('aria-label');
        });

        mv.addEventListener('error', function (e) {
            console.warn('[PIA] 3D model failed to load:', src, (e && e.detail) || e);
            wrapper.classList.remove('is-loading', 'has-model');
            if (mv.parentNode) { mv.parentNode.removeChild(mv); }

            /* Straight back to the state the slot was already in, with the
               reason swapped in. The case never becomes an empty hole. */
            setSlotState(wrapper, 'could not load');
            wrapper.setAttribute('role', 'img');
            wrapper.setAttribute('aria-label', '3D model of ' + name + ' — could not be loaded');
        });

        wrapper.appendChild(mv);
    }

    /* ══════════════════════════════════ 4. BOOT ══════════════════════════ */

    function start() {
        var slots = $$('.model-canvas-wrapper[data-model]').filter(function (el) {
            return AVAILABLE.indexOf(el.getAttribute('data-model')) !== -1;
        });

        /* Switched off (see MODELS_ENABLED): say so in the case and stop,
           before the renderer or any model is requested. */
        if (!MODELS_ENABLED) {
            slots.forEach(function (el) { setSlotState(el, DISABLED_LABEL); });
            return;
        }

        /* Nothing to do: every slot keeps the case it is already showing and
           the 935 KB renderer is never requested. This is the state the page
           ships in. */
        if (!slots.length) { return; }

        /* Capture the readable name before the load handler strips the
           label, so an error message can still say which agent it was. */
        slots.forEach(function (el) {
            var label = el.getAttribute('aria-label') || '';
            var m = label.match(/3D model of (.+?)(?: —|$)/);
            if (m) { el.setAttribute('data-model-name', m[1]); }
        });

        if (!('IntersectionObserver' in window)) {
            /* No observer: load them all rather than showing nothing. Rare
               enough not to be worth a scroll fallback. */
            loadRenderer().then(function () {
                slots.forEach(function (el) { mount(el, el.getAttribute('data-model')); });
            });
            return;
        }

        var io = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (!entry.isIntersecting) { return; }
                var el = entry.target;
                io.unobserve(el);

                loadRenderer().then(function () {
                    mount(el, el.getAttribute('data-model'));
                }, function () {
                    /* The renderer itself is missing or blocked. Every slot
                       stays as it is; say so once, not six times. */
                    setSlotState(el, '3D unavailable');
                });
            });
        }, {
            /* A full screen of warning. The renderer plus a model is a
               second or two on a school connection, and the slot should be
               finished loading by the time it is actually looked at. */
            rootMargin: '100% 0px',
            threshold: 0
        });

        slots.forEach(function (el) { io.observe(el); });
    }

    /* One import, shared by every slot. The promise is cached, so six slots
       entering at once still fetch the library exactly once. */
    var rendererPromise = null;

    function loadRenderer() {
        if (rendererPromise) { return rendererPromise; }

        rendererPromise = import(RENDERER).then(function () {
            return customElements.whenDefined('model-viewer');
        }).then(function (Ctor) {
            /* Point the compressed-mesh decoders at the vendored copies
               BEFORE any model is parsed. Left at their defaults these fetch
               from www.gstatic.com, which the page's CSP does not allow and
               a filtered network may not reach. */
            try {
                if (Ctor && 'dracoDecoderLocation' in Ctor) { Ctor.dracoDecoderLocation = DRACO_DIR; }
                if (Ctor && 'ktx2TranscoderLocation' in Ctor) { Ctor.ktx2TranscoderLocation = BASIS_DIR; }
            } catch (e) {
                console.warn('[PIA] could not pin local 3D decoders:', e);
            }
            return Ctor;
        });

        rendererPromise.catch(function (err) {
            console.warn('[PIA] 3D renderer unavailable:', err);
        });

        return rendererPromise;
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
