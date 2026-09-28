/**
 * ============================================================================
 * PIA SYSTEM — APP SHELL
 * ============================================================================
 * Behaviour for the hover-expand rail shared by the admin and teacher
 * consoles. Pairs with styles/shell.css.
 *
 * Exposes one entry point:
 *     PIAShell.initRail({ hasOpenModal: fn })
 *
 * `hasOpenModal` lets the host page tell the rail when a dialog owns the
 * Escape key. It is optional; without it Escape always collapses the rail.
 *
 * Extracted from admin-dashboard.js so both consoles run the SAME rail. The
 * click-does-not-collapse fix and the mouseleave verification below were hard
 * won; a second copy would inevitably drift away from them.
 * ==========================================================================*/
(function (global) {
    'use strict';

    var $ = function (sel, root) { return (root || document).querySelector(sel); };
    var $$ = function (sel, root) {
        return Array.prototype.slice.call((root || document).querySelectorAll(sel));
    };

    function debounce(fn, wait) {
        var timer = null;
        return function () {
            var args = arguments, self = this;
            clearTimeout(timer);
            timer = setTimeout(function () { fn.apply(self, args); }, wait || 200);
        };
    }

    var hasOpenModal = function () { return false; };

    /* ---- 3.2 Hover rail ----
       The rail expands on hover and collapses on leave. It is fixed-position
       and overlays the workspace, whose left margin is a constant, so nothing
       in the main content can move when the panel opens.

       THE RULE, and there is only one on desktop:
           while the pointer is inside the rail's bounding box, the rail stays
           expanded — no exception, no matter what is clicked inside it.

       That means clicking is not a collapse trigger at all. `mouseleave` is
       the single desktop collapse path, and even it is verified against the
       pointer's real coordinates before it is believed, because a bare
       mouseleave lies in two common situations:

         * relatedTarget is null when the node under the cursor is replaced by
           a re-render, which reads exactly like a genuine exit;
         * a synthetic or retargeted event (focus moving, an overlay mounting
           above the rail) can fire mouseleave while the cursor has not moved
           a pixel.

       A mousemove listener re-asserts the expanded state as a safety net, so
       if anything ever does collapse the rail out from under the cursor, the
       very next pointer movement puts it back.

       JS rather than a bare CSS :hover, for the intent delay, the leave
       grace, keyboard focus, and the touch fallback where hover cannot exist. */

    var app = $('#app');

    var rail = {
        openDelay: 90,
        closeDelay: 140,
        timer: null,
        pointerInside: false,   /* desktop: the only thing that matters */
        touchOpen: false        /* coarse pointers hold it open until dismissed */
    };

    function isTouchPointer() {
        return window.matchMedia('(hover: none), (pointer: coarse)').matches;
    }

    function isMobileLayout() {
        return window.matchMedia('(max-width: 1024px)').matches;
    }

    function setRail(expanded) {
        app.setAttribute('data-rail', expanded ? 'expanded' : 'collapsed');
        $('#sidebar').setAttribute('aria-expanded', String(expanded));
    }

    function railIsExpanded() {
        return app.getAttribute('data-rail') === 'expanded';
    }

    function scheduleRail(expanded, delay) {
        clearTimeout(rail.timer);
        rail.timer = setTimeout(function () { setRail(expanded); }, delay);
    }

    /* Geometry beats relatedTarget. If the cursor's own coordinates are still
       within the panel, the pointer did not leave, whatever the event says. */
    function pointerWithinRail(event) {
        var sidebar = $('#sidebar');
        if (!event || typeof event.clientX !== 'number') { return false; }
        /* (0,0) is what synthetic events report; treat it as "no information"
           rather than as the top-left corner. */
        if (event.clientX === 0 && event.clientY === 0) { return false; }

        var box = sidebar.getBoundingClientRect();
        return event.clientX >= box.left && event.clientX < box.right &&
            event.clientY >= box.top && event.clientY < box.bottom;
    }

    function initRail() {
        var sidebar = $('#sidebar');
        setRail(false);

        /* --- Enter: expand after the intent delay --- */
        sidebar.addEventListener('mouseenter', function () {
            if (isTouchPointer() || isMobileLayout()) { return; }
            rail.pointerInside = true;
            scheduleRail(true, rail.openDelay);
        });

        /* --- Move: the safety net. Anything that collapses the rail while the
               cursor is still inside is undone on the next movement. --- */
        sidebar.addEventListener('mousemove', function () {
            if (isTouchPointer() || isMobileLayout()) { return; }
            rail.pointerInside = true;
            if (!railIsExpanded()) {
                clearTimeout(rail.timer);
                setRail(true);
            }
        });

        /* --- Leave: the ONLY desktop collapse path, and only once the
               pointer's coordinates confirm it really left. --- */
        sidebar.addEventListener('mouseleave', function (event) {
            if (isTouchPointer() || isMobileLayout()) { return; }

            /* Moving onto a child still counts as being inside. */
            if (event.relatedTarget && sidebar.contains(event.relatedTarget)) { return; }
            if (pointerWithinRail(event)) { return; }

            rail.pointerInside = false;
            scheduleRail(false, rail.closeDelay);
        });

        /* --- Clicks inside the rail never collapse it. ---
               The nav items' own handlers run at target, before this bubble
               listener, so navigation still works normally; stopping
               propagation here just keeps the event from reaching the
               document-level outside-click handler below. */
        sidebar.addEventListener('click', function (event) {
            if (isMobileLayout()) { return; }

            /* Touch has no hover, so the first tap opens the rail and is
               swallowed — a nav item is never activated blind from an
               icon-only strip. */
            if (isTouchPointer() && !railIsExpanded()) {
                event.preventDefault();
                event.stopPropagation();
                rail.touchOpen = true;
                setRail(true);
                return;
            }

            event.stopPropagation();

            /* Re-assert, in case a handler on the clicked element did
               something that would otherwise have closed the panel. */
            if (!isTouchPointer() && rail.pointerInside) {
                clearTimeout(rail.timer);
                setRail(true);
            }
        });

        /* --- Keyboard: focus into the rail expands it. --- */
        sidebar.addEventListener('focusin', function () {
            if (isMobileLayout()) { return; }
            clearTimeout(rail.timer);
            setRail(true);
        });

        /* Focus leaving collapses it only when the pointer is elsewhere too.
           focusout fires before the next focusin, so the check is deferred a
           tick to see where focus actually landed. */
        sidebar.addEventListener('focusout', function () {
            if (isMobileLayout()) { return; }
            setTimeout(function () {
                if (sidebar.contains(document.activeElement)) { return; }
                if (rail.pointerInside) { return; }   /* cursor still inside — stay open */
                setRail(false);
            }, 0);
        });

        /* --- Touch: tapping outside dismisses a tap-opened rail. Guarded by
               stopPropagation above, so inside taps never reach this. --- */
        document.addEventListener('click', function () {
            if (!rail.touchOpen || isMobileLayout()) { return; }
            rail.touchOpen = false;
            setRail(false);
        });

        /* --- Escape collapses it, but not while the cursor is inside (the
               rule above wins) and not while a modal owns the key. --- */
        document.addEventListener('keydown', function (event) {
            if (event.key !== 'Escape') { return; }
            if (!railIsExpanded() || isMobileLayout()) { return; }
            if (hasOpenModal()) { return; }
            if (rail.pointerInside) { return; }

            rail.touchOpen = false;
            setRail(false);
        });

        /* --- Mobile drawer (hover plays no part here) --- */
        $('#mobile-nav-toggle').addEventListener('click', function () {
            var scrim = $('#nav-scrim');
            app.setAttribute('data-mobile-nav', 'open');
            scrim.classList.add('is-mounted');
            void scrim.offsetWidth;
            scrim.classList.add('is-open');
        });

        $('#nav-scrim').addEventListener('click', closeMobileNav);

        /* Crossing the breakpoint must not strand the rail expanded. */
        window.addEventListener('resize', debounce(function () {
            if (isMobileLayout()) {
                clearTimeout(rail.timer);
                rail.pointerInside = false;
                rail.touchOpen = false;
                setRail(false);
            }
        }, 150));
    }

    function closeMobileNav() {
        var scrim = $('#nav-scrim');
        app.removeAttribute('data-mobile-nav');
        scrim.classList.remove('is-open');
        setTimeout(function () { scrim.classList.remove('is-mounted'); }, 160);
    }

    global.PIAShell = {
        initRail: function (options) {
            if (options && typeof options.hasOpenModal === 'function') {
                hasOpenModal = options.hasOpenModal;
            }
            initRail();
        },
        closeMobileNav: closeMobileNav
    };
})(window);
