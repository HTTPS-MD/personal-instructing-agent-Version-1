/**
 * ============================================================================
 * PIA SYSTEM — LANDING / AUTH v2
 * ============================================================================
 * Vanilla JavaScript. Uses the shared `sb` client from assets/js/function.js.
 *
 * Three flows, all against the real backend:
 *   1. Sign in            — two doors: the student form, and "Admin sign in"
 *                           for every staff account (teachers AND admins).
 *                           Each accepts only its own kind of account; the
 *                           redirect then routes by role
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

        /* [data-autofocus] first, so the email field wins over anything that
           precedes it in source order. When the email is already filled in
           (carried over from another dialog) the password is the next thing
           to type, so focus goes there instead. */
        var first = overlay.querySelector('[data-autofocus]');
        if (first && first.type === 'email' && first.value) {
            first = overlay.querySelector('input[type="password"]') || first;
        }
        first = first || overlay.querySelector('input:not([type="hidden"]), select, textarea, button');
        if (first) { first.focus({ preventScroll: true }); }
    }

    function closeModal(target) {
        var overlay = (typeof target === 'string') ? document.getElementById(target) : target;
        overlay = overlay || openLayers[openLayers.length - 1];
        if (!overlay) { return; }

        overlay.classList.remove('is-open');
        overlay.style.zIndex = '';
        openLayers = openLayers.filter(function (layer) { return layer !== overlay; });

        /* These are shared school laptops. A password left in a closed dialog
           is one "show password" click away from the next person to sit down,
           so it is wiped and re-masked the moment the dialog goes. The email
           is kept — retyping it is friction, and it is not a secret. */
        $$('input[type="password"], input[data-pw-shown]', overlay).forEach(function (input) {
            input.value = '';
        });
        maskPasswords(overlay);

        setTimeout(function () {
            overlay.classList.remove('is-mounted');
            if (!openLayers.length) {
                unlockScroll();
                if (lastFocused && lastFocused.focus) { lastFocused.focus({ preventScroll: true }); }
            }
        }, 160);
    }

    /* Switching between the auth dialogs closes the current one first, so
       the scroll lock and focus restore stay balanced.

       "student" is an alias of "signin" for links INSIDE the dialogs:
       offerResume() relabels every data-auth-open="signin" trigger for a
       returning session, which is right for the page's entry points and
       wrong for "Student sign in" inside the staff dialog. */
    var AUTH_MODALS = {
        signin: 'modal-signin',
        student: 'modal-signin',
        staff: 'modal-staff',
        activate: 'modal-activate',
        forgot: 'modal-forgot'
    };

    /* "Back to sign in" (data-auth-open="back") returns to whichever sign-in
       the visitor actually came from. A teacher who clicked "Forgot
       password?" in the staff dialog expects to land back in the staff
       dialog, not on the student form. */
    var lastSignin = 'signin';

    function openAuth(key) {
        if (key === 'back') { key = lastSignin; }

        var id = AUTH_MODALS[key];
        if (!id) { return; }

        if (id === 'modal-signin') { lastSignin = 'signin'; }
        if (id === 'modal-staff') { lastSignin = 'staff'; }

        var current = openLayers[openLayers.length - 1];
        if (current && current.id !== id) {
            closeModal(current);
            setTimeout(function () { carryEmail(id); openModal(id); }, 170);
            return;
        }
        carryEmail(id);
        openModal(id);
    }

    /* The last address typed into ANY auth dialog is offered to the next
       one that opens with its email field empty — so a teacher sent from
       the student form to the staff form, or a student sent to "Forgot
       password?", does not have to type it twice. In memory only: nothing
       is persisted, and the next visitor to this laptop starts clean. */
    var lastEmail = '';

    function carryEmail(id) {
        var overlay = document.getElementById(id);
        var field = overlay && $('input[type="email"]', overlay);
        if (field && !field.value && lastEmail) { field.value = lastEmail; }
    }

    function initModals() {
        $$('[data-auth-open]').forEach(function (trigger) {
            trigger.addEventListener('click', function () {
                openAuth(trigger.getAttribute('data-auth-open'));
            });
        });

        $$('.overlay input[type="email"]').forEach(function (field) {
            field.addEventListener('input', function () { lastEmail = normalizeEmail(field.value); });
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

    /* aria-invalid rides along with the visual class, and every input names
       its .field-msg in aria-describedby — so a screen reader hears the
       error when it lands on the field, not just a red outline it cannot see. */
    function setFieldError(id, message) {
        var field = document.getElementById(id);
        var msg = $('[data-msg-for="' + id + '"]');
        if (field) {
            field.classList.toggle('is-invalid', !!message);
            if (message) { field.setAttribute('aria-invalid', 'true'); } else { field.removeAttribute('aria-invalid'); }
        }
        if (msg) {
            msg.classList.remove('is-hint');
            msg.textContent = message || '';
        }
        return !message;
    }

    function clearFormErrors(formId) {
        var form = document.getElementById(formId);
        if (!form) { return; }
        $$('.field-msg', form).forEach(function (n) { n.textContent = ''; n.classList.remove('is-hint'); });
        $$('.is-invalid', form).forEach(function (n) {
            n.classList.remove('is-invalid');
            n.removeAttribute('aria-invalid');
        });
    }

    /* Validate on submit, forgive on edit: the moment the visitor starts
       fixing a flagged field, the flag comes off. Leaving it red while they
       type the correction reads as the form still disagreeing with them. */
    function initLiveClear() {
        $$('.overlay form').forEach(function (form) {
            form.addEventListener('input', function (event) {
                var field = event.target;
                if (field && field.id && field.classList.contains('is-invalid')) { setFieldError(field.id, ''); }
            });
        });
    }

    function focusFirstInvalid(formId) {
        var bad = $('#' + formId + ' .is-invalid');
        if (bad) { bad.focus(); }
    }

    /* ---- Show / hide password -------------------------------------------
       A toggle button with a constant name ("Show password") and aria-pressed
       for the state, rather than a label that flips: the flip makes a screen
       reader announce "Hide password, pressed", which contradicts itself.
       data-pw-shown marks a revealed field so closeModal() can still find it
       and wipe it once its type is "text". */
    function setPasswordShown(input, button, shown) {
        input.type = shown ? 'text' : 'password';
        if (shown) { input.setAttribute('data-pw-shown', ''); } else { input.removeAttribute('data-pw-shown'); }
        button.setAttribute('aria-pressed', String(shown));
    }

    function maskPasswords(root) {
        $$('[data-pw-toggle]', root).forEach(function (button) {
            var input = document.getElementById(button.getAttribute('data-pw-toggle'));
            if (input) { setPasswordShown(input, button, false); }
        });
    }

    function initPasswordToggles() {
        $$('[data-pw-toggle]').forEach(function (button) {
            var input = document.getElementById(button.getAttribute('data-pw-toggle'));
            if (!input) { return; }
            button.addEventListener('click', function () {
                setPasswordShown(input, button, input.type === 'password');
            });
        });
    }

    /* ---- Caps Lock --------------------------------------------------------
       The single most common cause of "my password is wrong". Shown in the
       field's reserved message slot, so it costs no layout, and only while
       that slot has no real error to show. */
    function setCapsHint(input, on) {
        var msg = $('[data-msg-for="' + input.id + '"]');
        if (!msg || input.classList.contains('is-invalid')) { return; }
        if (!on && !msg.classList.contains('is-hint')) { return; }
        msg.classList.toggle('is-hint', on);
        msg.textContent = on ? 'Caps Lock is on.' : '';
    }

    function initCapsLock() {
        $$('[data-pw-toggle]').forEach(function (button) {
            var input = document.getElementById(button.getAttribute('data-pw-toggle'));
            if (!input) { return; }
            var check = function (event) {
                if (event.getModifierState) { setCapsHint(input, event.getModifierState('CapsLock')); }
            };
            input.addEventListener('keydown', check);
            input.addEventListener('keyup', check);
            input.addEventListener('blur', function () { setCapsHint(input, false); });
        });
    }

    /* Label swaps while the measured width is pinned, so footers never jump. */
    function setBusy(button, busyLabel) {
        if (!button) { return function () {}; }
        var html = button.innerHTML;
        var width = button.getBoundingClientRect().width;

        /* width, not min-width: min-width is only a floor, so a longer busy
           label ("Signing in…" vs "Sign in") still grew the button and
           nudged its neighbours. Pinning width locks it both ways. */
        button.style.width = Math.ceil(width) + 'px';
        button.disabled = true;
        button.innerHTML = esc(busyLabel || 'Working…');

        return function release() {
            button.innerHTML = html;
            button.disabled = false;
            button.style.width = '';
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

    /* Two areas — student, and staff (teacher or admin) — and one pipeline:
         signInWithPassword → profiles lookup → role → AREA CHECK
           → device claim → redirect
       The device claim is skipped for admins, matching enforceDeviceLimit's
       contract in function.js. */

    /* Anything that is not explicitly staff routes as a student, exactly as
       the redirect below always has. Normalising once means the area check
       and the redirect can never disagree about who someone is. */
    function normalizeRole(raw) {
        var role = String(raw || 'student').trim().toLowerCase();
        return (role === 'admin' || role === 'teacher') ? role : 'student';
    }

    /* The area check. Teachers and admins share the staff door, so the only
       wrong turns left are student-into-staff and staff-into-student — and
       each message names the right door, which sits one link away. */
    function areaMismatch(area, role) {
        var isStaff = role === 'teacher' || role === 'admin';
        if (area === 'staff' && !isStaff) {
            return 'This is a student account. Use Student sign in instead.';
        }
        if (area === 'student' && isStaff) {
            return 'This is a staff account. Use Admin sign in, below.';
        }
        return '';
    }

    /* Supabase's raw strings are written for developers. Rewritten for a
       twelve-year-old, and still deliberately vague about WHICH half was
       wrong — "incorrect email or password", never "no such user" — so the
       form cannot be used to test whether an address is on the roster. */
    function friendlyAuthError(error) {
        var raw = String((error && error.message) || '');
        if (/invalid login credentials/i.test(raw)) {
            return 'Incorrect email or password. Check both and try again.';
        }
        if (/email not confirmed/i.test(raw)) {
            return 'This account is not activated yet. Use Activate account first.';
        }
        if (/rate limit|too many/i.test(raw)) {
            return 'Too many attempts. Wait a minute, then try again.';
        }
        return raw || 'Sign-in failed. Please try again.';
    }

    async function signIn(opts) {
        clearFormErrors(opts.formId);
        clearStatus(opts.statusId);

        var email = normalizeEmail($('#' + opts.emailId).value);
        var password = $('#' + opts.passwordId).value;

        var valid = true;
        valid = setFieldError(opts.emailId, isEmail(email) ? '' : 'Enter a valid email address.') && valid;
        valid = setFieldError(opts.passwordId, password ? '' : 'Password is required.') && valid;
        if (!valid) {
            focusFirstInvalid(opts.formId);
            return;
        }

        /* Re-mask before the request. Browsers only offer to save a password
           that was submitted from a type="password" field. */
        maskPasswords($('#' + opts.formId));

        var release = setBusy($('#' + opts.submitId), 'Signing in…');

        try {
            var auth = await sb.auth.signInWithPassword({ email: email, password: password });

            if (auth.error) {
                setStatus(opts.statusId, friendlyAuthError(auth.error), 'error');
                return;
            }

            var profileRes = await sb.from('profiles').select('*')
                .eq('email', auth.data.user.email).maybeSingle();

            if (profileRes.error || !profileRes.data) {
                /* An auth user with no profile row cannot be routed anywhere.
                   Sign back out rather than leaving a half-session behind. */
                await sb.auth.signOut();
                setStatus(opts.statusId,
                    'This account is not set up yet. Please contact the study administrator.', 'error');
                return;
            }

            var profile = profileRes.data;
            var role = normalizeRole(profile.role);

            /* BEFORE anything is stored or claimed: a sign-in through the
               wrong area writes nothing to localStorage and never takes one
               of the account's device slots. The area is a routing promise,
               not the security boundary — row-level security is — but a
               teacher in the student area should be told, not silently sent
               somewhere they did not ask to go. */
            var mismatch = areaMismatch(opts.area, role);
            if (mismatch) {
                await sb.auth.signOut();
                setStatus(opts.statusId, mismatch, 'error');
                return;
            }

            try {
                localStorage.setItem('pia_user_email', auth.data.user.email);
                localStorage.setItem('pia_user_role', role);
            } catch (err) { /* private mode */ }

            if (role !== 'admin' && typeof enforceDeviceLimit === 'function') {
                var check = await enforceDeviceLimit(auth.data.user.email, profile);
                if (!check.allowed) {
                    await sb.auth.signOut();
                    setStatus(opts.statusId, check.reason, 'error');
                    return;
                }
            }

            setStatus(opts.statusId, 'Signed in. Taking you to your dashboard…', 'ok');

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
            setStatus(opts.statusId, 'Could not reach the server. Check your connection and try again.', 'error');
        } finally {
            release();
        }
    }

    function handleStudentSignIn(event) {
        event.preventDefault();
        return signIn({
            area: 'student',
            formId: 'signin-form',
            emailId: 'si-email',
            passwordId: 'si-password',
            submitId: 'si-submit',
            statusId: 'signin-status'
        });
    }

    /* One door for teachers and admins. The redirect below the area check
       sends each to their own dashboard by the role on their profile. */
    function handleStaffSignIn(event) {
        event.preventDefault();
        return signIn({
            area: 'staff',
            formId: 'staff-form',
            emailId: 'st-email',
            passwordId: 'st-password',
            submitId: 'st-submit',
            statusId: 'staff-status'
        });
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
                /* data-resume-label lets a tight spot (the phone navbar) ask
                   for a shorter label than the default. Buttons with a
                   .cta-label keep their icon: only the label is rewritten. */
                var label = btn.querySelector('.cta-label') || btn;
                label.textContent = btn.getAttribute('data-resume-label') || 'Continue to dashboard';
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

        /* Presentation-only field behaviour: works with or without a backend. */
        initPasswordToggles();
        initCapsLock();
        initLiveClear();

        if (typeof sb === 'undefined' || !sb) {
            $$('[data-auth-open]').forEach(function (btn) {
                btn.addEventListener('click', function () {
                    toast('Service unavailable', 'Could not reach the database. Please refresh.', 'danger');
                });
            });
            return;
        }

        $('#signin-form').addEventListener('submit', handleStudentSignIn);
        $('#staff-form').addEventListener('submit', handleStaffSignIn);
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
