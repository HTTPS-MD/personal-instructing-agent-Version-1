/* PIA -- the header of the student "paper" pages: the light / dark switch, and Quit.

   The theme is the one the landing page uses: stored as pia_theme and put on <html> before first paint by
   theme-boot.js, so this only has to flip it.

   Quit asks first, then signs the student out (so the next person at a shared computer starts clean). It listens in
   the capture phase, ahead of the page-wide Sign out wiring in function.js, which would sign out at once. A page that
   has its own confirmation (the questionnaire, the game) says so with <body data-own-quit> and keeps it. */
(function () {
    'use strict';

    var root = document.documentElement;

    /* ---- light / dark ---- */
    var toggle = document.getElementById('theme-toggle');
    if (toggle) {
        var sync = function () {
            toggle.setAttribute('aria-label', root.getAttribute('data-theme') === 'light' ? 'Switch to dark theme' : 'Switch to light theme');
        };
        toggle.addEventListener('click', function () {
            var next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
            root.setAttribute('data-theme', next);
            try { localStorage.setItem('pia_theme', next); } catch (e) { /* private mode: it just will not be remembered */ }
            sync();
        });
        sync();
    }

    /* ---- Quit ---- */
    if (document.body.hasAttribute('data-own-quit')) { return; }

    function confirmQuit() {
        return new Promise(function (resolve) {
            var overlay = document.createElement('div');
            overlay.className = 'overlay';
            overlay.id = 'quit-modal';
            overlay.setAttribute('role', 'dialog');
            overlay.setAttribute('aria-modal', 'true');
            overlay.setAttribute('aria-labelledby', 'quit-heading');
            overlay.innerHTML =
                '<div class="modal modal-sm">' +
                '<header class="modal-head"><div class="modal-head-text">' +
                '<h2 class="modal-title" id="quit-heading">Quit for now?</h2>' +
                '<p class="modal-sub">You will be signed out.</p></div></header>' +
                '<div class="modal-body"><p class="modal-text">You can sign in again any time with your school email.</p></div>' +
                '<footer class="modal-foot">' +
                '<button type="button" class="btn btn-secondary" data-quit="stay">Stay</button>' +
                '<button type="button" class="btn btn-primary" data-quit="leave">Quit</button>' +
                '</footer></div>';
            document.body.appendChild(overlay);

            var returnTo = document.activeElement;
            var stay = overlay.querySelector('[data-quit="stay"]');
            var leave = overlay.querySelector('[data-quit="leave"]');
            var box = overlay.querySelector('.modal');

            function done(answer) {
                document.removeEventListener('keydown', onKey, true);
                overlay.remove();
                if (returnTo && returnTo.focus && !returnTo.disabled) { returnTo.focus({ preventScroll: true }); }
                resolve(answer);
            }
            function onKey(e) {
                if (e.key === 'Escape') { e.preventDefault(); done(false); return; }
                if (e.key !== 'Tab') { return; }
                var first = stay, last = leave;
                if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
                else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
            }
            stay.addEventListener('click', function () { done(false); });
            leave.addEventListener('click', function () { done(true); });
            document.addEventListener('keydown', onKey, true);

            /* The same open state the other dialogs on these pages use (see student-journey.css). */
            overlay.classList.add('modal-active');
            box.classList.add('modal-content-active');
            stay.focus({ preventScroll: true });
        });
    }

    document.addEventListener('click', function (e) {
        var quit = e.target.closest && e.target.closest('#signout-btn');
        if (!quit) { return; }
        e.preventDefault();
        e.stopImmediatePropagation();
        confirmQuit().then(function (leave) {
            if (!leave) { return; }
            quit.disabled = true;
            if (typeof executeForceLogout === 'function') { executeForceLogout(); }
        });
    }, true);
})();
