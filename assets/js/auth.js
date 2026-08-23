/**
 * ============================================================================
 * PIA SYSTEM — LANDING / AUTH v2
 * ============================================================================
 * Vanilla JavaScript. Uses the shared `sb` client from assets/js/function.js.
 *
 * Three flows, all against the real backend:
 *   1. Sign in            — signInWithPassword, then role-based redirect
 *   2. Activate account   — signInWithOtp (magic link), never creates a user
 *   3. Reset password     — resetPasswordForEmail
 *
 * There is deliberately NO public sign-up. In this study participants are
 * enrolled by the administrator, who creates the auth user and the profile
 * row together; a self-serve registration path would produce auth users with
 * no profile, which the login flow below treats as a configuration error.
 * "Registration" from the visitor's side therefore means activating an account
 * that already exists.
 * ==========================================================================*/
(function () {
    'use strict';

    var $ = function (sel, root) { return (root || document).querySelector(sel); };
    var $$ = function (sel, root) {
        return Array.prototype.slice.call((root || document).querySelectorAll(sel));
    };

    function esc(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function isEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }
    function normalizeEmail(raw) { return (raw || '').trim().toLowerCase(); }

    /* ============================================ 1. MODAL MECHANICS ==== */
    /* Identical to the admin console: mount, force a style flush, animate.
       Scroll-lock substitutes the measured scrollbar width so opening a
       dialog cannot shift the page sideways. */

    var openLayers = [];
    /* Matches --z-overlay in global.css; see the stacking ladder there. */
    var Z_OVERLAY_BASE = 100;
    var lastFocused = null;
    var FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]),' +
        ' textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

    function lockScroll() {
        var gap = window.innerWidth - document.documentElement.clientWidth;
        document.documentElement.style.setProperty('--scrollbar-w', gap + 'px');
        document.body.classList.add('is-locked');
    }

    function unlockScroll() {
        document.body.classList.remove('is-locked');
        document.documentElement.style.setProperty('--scrollbar-w', '0px');
    }

    function openModal(id) {
        var overlay = document.getElementById(id);
        if (!overlay || openLayers.indexOf(overlay) !== -1) { return; }

        if (!openLayers.length) {
            lastFocused = document.activeElement;
            lockScroll();
        }

        overlay.classList.add('is-mounted');
        openLayers.push(overlay);
        
        /* Raise this layer above every layer already open. All overlays share
           one base z-index in CSS, so without this the winner is decided by DOM
           source order — which is how an open drawer ended up covering a
           confirmation dialog it had itself triggered. z-index does not affect
           layout, so this costs nothing in CLS. */
        overlay.style.zIndex = String(Z_OVERLAY_BASE + openLayers.length);
        void overlay.offsetWidth;
        overlay.classList.add('is-open');

        var first = overlay.querySelector('input:not([type="hidden"]), select, textarea, button');
        if (first) { first.focus({ preventScroll: true }); }
    }

    function closeModal(target) {
        var overlay = (typeof target === 'string') ? document.getElementById(target) : target;
        overlay = overlay || openLayers[openLayers.length - 1];
        if (!overlay) { return; }

        overlay.classList.remove('is-open');
        overlay.style.zIndex = '';
        openLayers = openLayers.filter(function (layer) { return layer !== overlay; });

        setTimeout(function () {
            overlay.classList.remove('is-mounted');
            if (!openLayers.length) {
                unlockScroll();
                if (lastFocused && lastFocused.focus) { lastFocused.focus({ preventScroll: true }); }
            }
        }, 160);
    }

    /* Switching between the three auth dialogs closes the current one first,
       so the scroll lock and focus restore stay balanced. */
    var AUTH_MODALS = { signin: 'modal-signin', activate: 'modal-activate', forgot: 'modal-forgot' };

    function openAuth(key) {
        var id = AUTH_MODALS[key];
        if (!id) { return; }

        var current = openLayers[openLayers.length - 1];
        if (current && current.id !== id) {
            closeModal(current);
            setTimeout(function () { openModal(id); }, 170);
            return;
        }
        openModal(id);
    }

    function initModals() {
        $$('[data-auth-open]').forEach(function (trigger) {
            trigger.addEventListener('click', function () {
                openAuth(trigger.getAttribute('data-auth-open'));
            });
        });

        $$('.overlay').forEach(function (overlay) {
            overlay.addEventListener('mousedown', function (event) {
                if (event.target === overlay) { closeModal(overlay); }
            });
            $$('[data-modal-close]', overlay).forEach(function (btn) {
                btn.addEventListener('click', function () { closeModal(overlay); });
            });
        });

        document.addEventListener('keydown', function (event) {
            if (!openLayers.length) { return; }
            var top = openLayers[openLayers.length - 1];

            if (event.key === 'Escape') {
                event.preventDefault();
                closeModal(top);
                return;
            }

            if (event.key !== 'Tab') { return; }

            var nodes = $$(FOCUSABLE, top).filter(function (n) { return n.offsetParent !== null; });
            if (!nodes.length) { return; }

            var first = nodes[0];
            var last = nodes[nodes.length - 1];

            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        });
    }

    /* ============================================ 2. FEEDBACK ========== */

    /* The status row exists in the DOM at a fixed height at all times. Showing
       or clearing a message only changes colour, never the box — so the form's
       inputs and buttons cannot move under the user's cursor. */
    function setStatus(id, message, tone) {
        var row = document.getElementById(id);
        if (!row) { return; }

        var text = $('[data-status-text]', row);
        var glyph = $('use', row);

        text.textContent = message || '';
        row.classList.toggle('is-error', tone === 'error');
        row.classList.toggle('is-ok', tone === 'ok');
        if (glyph) { glyph.setAttribute('href', tone === 'ok' ? '#i-check' : '#i-alert'); }
    }

    function clearStatus(id) { setStatus(id, '', null); }

    function setFieldError(id, message) {
        var field = document.getElementById(id);
        var msg = $('[data-msg-for="' + id + '"]');
        if (field) { field.classList.toggle('is-invalid', !!message); }
        if (msg) { msg.textContent = message || ''; }
        return !message;
    }

    function clearFormErrors(formId) {
        var form = document.getElementById(formId);
        if (!form) { return; }
        $$('.field-msg', form).forEach(function (n) { n.textContent = ''; });
        $$('.is-invalid', form).forEach(function (n) { n.classList.remove('is-invalid'); });
    }

    /* Label swaps while the measured width is pinned, so footers never jump. */
    function setBusy(button, busyLabel) {
        if (!button) { return function () {}; }
        var html = button.innerHTML;
        var width = button.getBoundingClientRect().width;

        button.style.minWidth = Math.ceil(width) + 'px';
        button.disabled = true;
        button.innerHTML = esc(busyLabel || 'Working…');

        return function release() {
            button.innerHTML = html;
            button.disabled = false;
            button.style.minWidth = '';
        };
    }

    function toast(title, description, tone) {
        var stack = $('#toast-stack');
        if (!stack) { return; }

        var node = document.createElement('div');
        node.className = 'toast toast-' + (tone === 'danger' ? 'danger' : 'accent');
        node.innerHTML =
            '<svg class="icon"><use href="#i-' + (tone === 'danger' ? 'alert' : 'check') + '"></use></svg>' +
            '<div class="toast-text"><p class="toast-title">' + esc(title) + '</p>' +
            (description ? '<p class="toast-desc">' + esc(description) + '</p>' : '') + '</div>';

        stack.appendChild(node);
        void node.offsetWidth;
        node.classList.add('is-open');

        setTimeout(function () {
            node.classList.remove('is-open');
            setTimeout(function () { node.remove(); }, 200);
        }, 4200);
    }

    function activationRedirect() {
        return new URL('assets/html/sign-up.html', window.location.href).href;
    }

    /* ============================================ 3. SIGN IN =========== */

    /* Mirrors the flow the existing landing page uses, so both entry points
       behave identically:
         signInWithPassword → profiles lookup → role → device claim → redirect
       The device claim is skipped for admins, matching enforceDeviceLimit's
       contract in function.js. */
    async function handleSignIn(event) {
        event.preventDefault();
        clearFormErrors('signin-form');
        clearStatus('signin-status');

        var email = normalizeEmail($('#si-email').value);
        var password = $('#si-password').value;

        var valid = true;
        valid = setFieldError('si-email', isEmail(email) ? '' : 'Enter a valid email address.') && valid;
        valid = setFieldError('si-password', password ? '' : 'Password is required.') && valid;
        if (!valid) { return; }

        var release = setBusy($('#si-submit'), 'Signing in…');

        try {
            var auth = await sb.auth.signInWithPassword({ email: email, password: password });

            if (auth.error) {
                setStatus('signin-status', auth.error.message, 'error');
                return;
            }

            var profileRes = await sb.from('profiles').select('*')
                .eq('email', auth.data.user.email).maybeSingle();

            if (profileRes.error || !profileRes.data) {
                /* An auth user with no profile row cannot be routed anywhere.
                   Sign back out rather than leaving a half-session behind. */
                await sb.auth.signOut();
                setStatus('signin-status',
                    'This account is not set up yet. Please contact the study administrator.', 'error');
                return;
            }

            var profile = profileRes.data;
            var role = (profile.role || 'student').trim().toLowerCase();

            try {
                localStorage.setItem('pia_user_email', auth.data.user.email);
                localStorage.setItem('pia_user_role', role);
            } catch (err) { /* private mode */ }

            if (role !== 'admin' && typeof enforceDeviceLimit === 'function') {
                var check = await enforceDeviceLimit(auth.data.user.email, profile);
                if (!check.allowed) {
                    await sb.auth.signOut();
                    setStatus('signin-status', check.reason, 'error');
                    return;
                }
            }

            setStatus('signin-status', 'Signed in. Taking you to your dashboard…', 'ok');

            if (role === 'admin') {
                window.location.replace('admin/html/admin-dashboard.html');
            } else if (role === 'teacher') {
                window.location.replace('teacher/html/teacher-dashboard.html');
            } else if (typeof resolveStudentRedirect === 'function') {
                window.location.replace(await resolveStudentRedirect(profile));
            } else {
                window.location.replace('student/html/waiting-room.html');
            }
        } catch (err) {
            console.error('Sign-in failed:', err);
            setStatus('signin-status', 'Could not reach the server. Check your connection and try again.', 'error');
        } finally {
            release();
        }
    }

    /* ============================================ 4. ACTIVATION ======== */

    /* shouldCreateUser:false is the important argument. Without it a typo
       would silently create an auth user with no profile row — exactly the
       orphan state the admin console has to clean up by hand. */
    async function handleActivate(event) {
        event.preventDefault();
        clearFormErrors('activate-form');
        clearStatus('activate-status');

        var email = normalizeEmail($('#ac-email').value);
        if (!setFieldError('ac-email', isEmail(email) ? '' : 'Enter a valid email address.')) { return; }

        var release = setBusy($('#ac-submit'), 'Sending…');

        try {
            var res = await sb.auth.signInWithOtp({
                email: email,
                options: { shouldCreateUser: false, emailRedirectTo: activationRedirect() }
            });

            if (res.error) {
                setStatus('activate-status', res.error.message, 'error');
                return;
            }

            setStatus('activate-status',
                'Link sent. Check your inbox — it expires shortly, so use it soon.', 'ok');
            toast('Activation link sent', 'Sent to ' + email + '.');
            $('#activate-form').reset();
        } catch (err) {
            console.error('Activation failed:', err);
            setStatus('activate-status', 'Could not reach the server. Please try again.', 'error');
        } finally {
            release();
        }
    }

    /* ============================================ 5. PASSWORD RESET ==== */

    async function handleForgot(event) {
        event.preventDefault();
        clearFormErrors('forgot-form');
        clearStatus('forgot-status');

        var email = normalizeEmail($('#fp-email').value);
        if (!setFieldError('fp-email', isEmail(email) ? '' : 'Enter a valid email address.')) { return; }

        var release = setBusy($('#fp-submit'), 'Sending…');

        try {
            var res = await sb.auth.resetPasswordForEmail(email, { redirectTo: activationRedirect() });

            if (res.error) {
                setStatus('forgot-status', res.error.message, 'error');
                return;
            }

            /* Deliberately does not confirm whether the address exists — that
               would let anyone test the roster for enrolled participants. */
            setStatus('forgot-status',
                'If that address is on the roster, a reset link is on its way.', 'ok');
            toast('Reset link sent', 'Check the inbox for ' + email + '.');
            $('#forgot-form').reset();
        } catch (err) {
            console.error('Reset failed:', err);
            setStatus('forgot-status', 'Could not reach the server. Please try again.', 'error');
        } finally {
            release();
        }
    }

    /* ============================================ 6. BOOT ============== */

    /* Someone already signed in should not have to type their password again
       just because they landed on the marketing page. */
    async function offerResume() {
        if (typeof sb === 'undefined' || !sb) { return; }

        try {
            var session = await sb.auth.getSession();
            if (!session.data.session) { return; }

            var role = 'student';
            try { role = localStorage.getItem('pia_user_role') || 'student'; } catch (err) { /* ignore */ }

            $$('[data-auth-open="signin"]').forEach(function (btn) {
                btn.textContent = 'Continue to dashboard';
                btn.addEventListener('click', function (event) {
                    event.stopImmediatePropagation();
                    if (role === 'admin') { window.location.replace('admin/html/admin-dashboard.html'); }
                    else if (role === 'teacher') { window.location.replace('teacher/html/teacher-dashboard.html'); }
                    else { window.location.replace('student/html/waiting-room.html'); }
                }, true);
            });
        } catch (err) {
            /* No session, or storage unavailable — leave the page as it is. */
        }
    }

    function boot() {
        initModals();

        if (typeof sb === 'undefined' || !sb) {
            $$('[data-auth-open]').forEach(function (btn) {
                btn.addEventListener('click', function () {
                    toast('Service unavailable', 'Could not reach the database. Please refresh.', 'danger');
                });
            });
            return;
        }

        $('#signin-form').addEventListener('submit', handleSignIn);
        $('#activate-form').addEventListener('submit', handleActivate);
        $('#forgot-form').addEventListener('submit', handleForgot);

        /* Smooth in-page anchors, without hijacking anything else. */
        $$('a[href^="#"]').forEach(function (link) {
            link.addEventListener('click', function (event) {
                var target = document.querySelector(link.getAttribute('href'));
                if (!target) { return; }
                event.preventDefault();
                target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
        });

        offerResume();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
