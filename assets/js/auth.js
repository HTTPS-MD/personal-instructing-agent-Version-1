/**
 * ============================================================================
 * PIA SYSTEM — LANDING / AUTH v2
 * ============================================================================
 * Vanilla JavaScript. Uses the shared `sb` client from assets/js/function.js.
 *
 * Three flows, all against the real backend:
 *   1. Sign in            — two doors: the student form, and "Teacher / Admin sign in"
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
    var FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]),' +
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

    var authReturn = null;
    var backgroundNodes = [];

    function setBackgroundInert(on) {
        if (on && !backgroundNodes.length) {
            backgroundNodes = Array.from(document.body.children).filter(function (el) {
                return !el.classList.contains('overlay') && !['SCRIPT', 'SVG'].includes(el.tagName) && !el.inert;
            });
            backgroundNodes.forEach(function (el) { el.inert = true; });
        } else if (!on) {
            backgroundNodes.forEach(function (el) { el.inert = false; });
            backgroundNodes = [];
        }
    }

    function openModal(id) {
        var overlay = document.getElementById(id);
        if (!overlay || openLayers.includes(overlay)) { return; }
        if (!openLayers.length) {
            if (!lastFocused) { lastFocused = document.activeElement; }
            lockScroll();
            setBackgroundInert(true);
        }
        overlay.inert = false;
        overlay.classList.add('is-mounted', 'is-open');
        openLayers.push(overlay);
        var first = overlay.querySelector('[data-autofocus]');
        if (first && first.closest('[hidden]')) { first = null; }
        if (first && first.type === 'email' && first.value) {
            first = overlay.querySelector('input[type="password"]') || first;
        }
        first = first || overlay.querySelector('button:not([disabled])');
        if (first) { first.focus({ preventScroll: true }); }
    }

    function closeModal(target, switching) {
        var overlay = typeof target === 'string' ? document.getElementById(target) : target;
        overlay = overlay || openLayers[openLayers.length - 1];
        if (!overlay) { return; }
        invalidateEmailView(overlay.id);
        overlay.dataset.authVersion = String(Number(overlay.dataset.authVersion || 0) + 1);
        overlay.classList.remove('is-open', 'is-mounted');
        overlay.inert = true;
        openLayers = openLayers.filter(function (layer) { return layer !== overlay; });
        $$('input[type="password"], input[data-pw-shown]', overlay).forEach(function (input) { input.value = ''; });
        maskPasswords(overlay);
        if (switching) { return; }
        if (authReturn && ['modal-forgot', 'modal-activate', 'modal-device-reset'].includes(overlay.id)) {
            var context = authReturn;
            authReturn = null;
            openModal(context.id);
            if (context.focus && context.focus.isConnected) { context.focus.focus(); }
            return;
        }
        authReturn = null;
        if (!openLayers.length) {
            unlockScroll();
            setBackgroundInert(false);
            var focus = lastFocused;
            lastFocused = null;
            if (focus && focus.isConnected) { focus.focus({ preventScroll: true }); }
        }
    }

    var AUTH_MODALS = {
        signin: 'modal-signin', student: 'modal-signin', staff: 'modal-staff',
        activate: 'modal-activate', forgot: 'modal-forgot', 'device-reset': 'modal-device-reset'
    };
    var lastSignin = 'signin';

    function openAuth(key) {
        if (key === 'back') { key = lastSignin; }
        var id = AUTH_MODALS[key];
        if (!id) { return; }
        var current = openLayers[openLayers.length - 1];
        if (current && current.id === id) { return; }
        if (current && ['modal-signin', 'modal-staff'].includes(current.id) &&
            ['modal-forgot', 'modal-activate', 'modal-device-reset'].includes(id)) {
            authReturn = { id: current.id, focus: document.activeElement };
        } else if (!current || ['modal-signin', 'modal-staff'].includes(id)) {
            authReturn = null;
        }
        if (id === 'modal-signin') { lastSignin = 'signin'; }
        if (id === 'modal-staff') { lastSignin = 'staff'; }
        if (current) { closeModal(current, true); }
        carryEmail(id);
        openModal(id);
        renderEmailRequests();
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

    /* Always the public site, never this page's own address: the email is
       opened on the student's phone, not on the machine that sent it. */
    function activationRedirect() {
        return emailLinkTo('assets/html/sign-up.html');
    }

    /* ============================================ 3. SIGN IN =========== */

    /* Two areas — student, and staff (teacher or admin) — and one pipeline:
         signInWithPassword → profiles lookup → role → AREA CHECK
           → device claim (claimSeat) → redirect
       Students take the account's one active session; teachers take a
       device slot; admins skip the claim. */

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
            return 'This is a staff account. Use Teacher / Admin sign in, below.';
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
            return 'The email or password is incorrect. Check both and try again.';
        }
        if (/email not confirmed/i.test(raw)) {
            return 'Activate your account before signing in.';
        }
        if (/rate limit|too many/i.test(raw)) {
            return 'Too many sign-in attempts. Please wait before trying again.';
        }
        return 'Sign in could not be completed. Check your connection or try again later.';
    }

    var signInPending = false;
    async function signIn(opts) {
        if (signInPending) { return; }
        if ($('#' + opts.submitId).disabled) { return; }
        clearFormErrors(opts.formId);
        clearStatus(opts.statusId);

        /* The device-limit way out belongs to the attempt that hit the limit;
           a new attempt starts without it. */
        var offer = $('#' + opts.formId + ' [data-device-reset]');
        if (offer) { offer.hidden = true; }

        var email = normalizeEmail($('#' + opts.emailId).value);
        var password = $('#' + opts.passwordId).value;

        var valid = true;
        valid = setFieldError(opts.emailId, isEmail(email) ? '' : 'Enter a valid school email address.') && valid;
        valid = setFieldError(opts.passwordId, password ? '' : 'Enter your password.') && valid;
        if (!valid) {
            focusFirstInvalid(opts.formId);
            return;
        }

        /* Re-mask before the request. Browsers only offer to save a password
           that was submitted from a type="password" field. */
        maskPasswords($('#' + opts.formId));

        var overlay = $('#' + opts.formId).closest('.overlay');
        var version = overlay.dataset.authVersion || '0';
        var current = function () { return overlay.classList.contains('is-open') && (overlay.dataset.authVersion || '0') === version; };
        signInPending = true;
        var release = setBusy($('#' + opts.submitId), 'Signing in…');

        try {
            var auth = await sb.auth.signInWithPassword({ email: email, password: password });

            if (!current()) {
                if (!auth.error) { await sb.auth.signOut({ scope: 'local' }); }
                return;
            }
            if (auth.error) {
                setStatus(opts.statusId, friendlyAuthError(auth.error), 'error');
                return;
            }

            var profileRes = await sb.from('profiles').select('*')
                .eq('email', auth.data.user.email).maybeSingle();

            if (!current()) { await sb.auth.signOut({ scope: 'local' }); return; }

            /* Every refusal below undoes the session signInWithPassword just
               created ON THIS DEVICE, and nothing more. scope 'local' matters:
               supabase-js defaults to 'global', which revokes the account's
               refresh tokens everywhere — so one refused attempt on a lab PC
               used to sign the student out of the device they were actually
               using, while that device still held its slot. */
            if (profileRes.error || !profileRes.data) {
                /* An auth user with no profile row cannot be routed anywhere.
                   Sign back out rather than leaving a half-session behind. */
                await sb.auth.signOut({ scope: 'local' });
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
                await sb.auth.signOut({ scope: 'local' });
                setStatus(opts.statusId, mismatch, 'error');
                return;
            }

            try {
                localStorage.setItem('pia_user_email', auth.data.user.email);
                localStorage.setItem('pia_user_role', role);
            } catch (err) { /* private mode */ }

            var check = await claimSeat(auth.data.user.email, profile, role);
            if (!current()) { await sb.auth.signOut({ scope: 'local' }); return; }
            if (!check.allowed) {
                /* Only this refused attempt is undone; any other device
                   keeps its session. */
                await sb.auth.signOut({ scope: 'local' });
                try {
                    localStorage.removeItem('pia_user_email');
                    localStorage.removeItem('pia_user_role');
                } catch (err) { /* private mode */ }
                setStatus(opts.statusId, check.reason, 'error');

                /* At the device limit, the "other device" is most often a lab
                   PC whose browser was closed without signing out. Offer the
                   way out that needs no admin: an email code (section 3b). */
                if (check.deviceLimit) {
                    deviceReset.email = email;
                    deviceReset.area = opts.area;
                    if (offer) { offer.hidden = false; }
                }
                return;
            }

            await routeAfterSignIn(profile, role, function (message, tone) {
                setStatus(opts.statusId, message, tone);
            });
        } catch (err) {
            if (current()) { setStatus(opts.statusId, 'Can\u2019t reach the server. Check your Wi-Fi, then try again.', 'error'); }
        } finally {
            signInPending = false;
            release();
        }
    }

    /* Who may hold how many devices:
         student  one active session; this sign-in takes the account over and
                  the older device is signed out within ten seconds (0027);
         teacher  the device slots of claim_device (max_devices);
         admin    no limit.
       If 0027 is not applied yet, students fall back to the device slots, so
       the order in which the SQL and this file ship does not matter. */
    async function claimSeat(email, profile, role) {
        if (role === 'admin') { return { allowed: true }; }

        if (role === 'student' && typeof claimStudentSession === 'function') {
            var claim = await claimStudentSession();
            if (!claim.missing) { return claim; }
        }

        if (typeof enforceDeviceLimit !== 'function') { return { allowed: true }; }
        var slots = await enforceDeviceLimit(email, profile);
        return slots.allowed ? slots : { allowed: false, reason: slots.reason, deviceLimit: true };
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

    /* The end of every successful sign-in -- by password, or by the email
       code of section 3b. `report(message, tone)` is wherever this sign-in
       shows its progress: a dialog's status row, or a toast. */
    async function routeAfterSignIn(profile, role, report) {
        /* An admin set a temporary password for this student (the
           admin-set-temp-password Edge Function). They must replace it
           before anything else: the admin knows it, and the next one
           should be known to the student alone. Every other student page
           sends them back here too (requireStudentSession). */
        if (role === 'student' && profile.must_change_password === true) {
            report('Signed in. Choose a new password to continue…', 'ok');
            window.location.replace('student/html/set-new-password.html');
            return;
        }

        report('Signed in. Taking you to your dashboard…', 'ok');

        if (role === 'admin') {
            window.location.replace('admin/html/admin-dashboard.html');
        } else if (role === 'teacher') {
            window.location.replace('teacher/html/teacher-dashboard.html');
        } else if (typeof resolveStudentRedirect === 'function') {
            window.location.replace(await resolveStudentRedirect(profile));
        } else {
            window.location.replace('student/html/waiting-room.html');
        }
    }

    /* ======================================= 3b. SIGN OUT OF OTHER DEVICES */

    /* A sign-in refused at the device limit offers "Sign out of other
       devices". Its dialog emails a one-time code (signInWithOtp); entering
       it opens a session on THIS device (verifyOtp), and reset_my_devices()
       (migration 0025) then signs every other device out and registers this
       one. The database checks the email proof itself -- the session must
       come from an email code or link in the last 15 minutes -- so a password
       alone cannot do this, not even from the browser console.

       The same email carries a link. It comes back to this page with
       ?flow=device-reset (auth-callback.js lets it through) and finishes the
       same way on whichever device opens it. */
    var deviceReset = { email: null, area: null };
    var drTimerId = null;

    function friendlyResetError(error) {
        var raw = String((error && error.message) || '');
        if (/code from your email/i.test(raw)) { return 'Confirm it’s you with the code from your email first.'; }
        if (/signed out/i.test(raw)) { return 'This sign-in expired. Send a new code and try again.'; }
        return 'We couldn’t sign your other devices out. Try again, or ask your teacher.';
    }

    function startDeviceResetCooldown() {
        var btn = $('#dr-resend');
        var left = RESEND_COOLDOWN;
        clearInterval(drTimerId);
        btn.disabled = true;
        btn.textContent = 'Send a new code (' + left + 's)';
        drTimerId = setInterval(function () {
            left -= 1;
            if (left <= 0) {
                clearInterval(drTimerId);
                btn.disabled = false;
                btn.textContent = 'Send a new code';
                return;
            }
            btn.textContent = 'Send a new code (' + left + 's)';
        }, 1000);
    }

    async function sendDeviceResetCode() {
        clearStatus('device-reset-status');
        var res;
        try {
            res = await sb.auth.signInWithOtp({
                email: deviceReset.email,
                options: { shouldCreateUser: false, emailRedirectTo: emailLinkTo('index.html?flow=device-reset') }
            });
        } catch (err) {
            res = { error: { message: 'Can’t reach the server. Check your Wi-Fi, then try again.' } };
        }

        if (res.error) {
            setStatus('device-reset-status', friendlyAuthError(res.error), 'error');
            $('#dr-resend').disabled = false;
            $('#dr-resend').textContent = 'Send a new code';
            return;
        }
        setStatus('device-reset-status', 'Code sent. It can take a minute to arrive.', 'ok');
        startDeviceResetCooldown();
    }

    function openDeviceReset() {
        if (!deviceReset.email) { return; }
        $('#device-reset-form').reset();
        clearFormErrors('device-reset-form');
        clearStatus('device-reset-status');
        $('#dr-sent-to').textContent = deviceReset.email;
        openAuth('device-reset');
        sendDeviceResetCode();
    }

    /* Shared by the code and the link: this device now holds a session that
       came from the email. Sign the others out, then carry on like any
       sign-in. Any refusal undoes this device's session too. */
    async function completeDeviceReset(area, report) {
        var fail = async function (message) {
            await sb.auth.signOut({ scope: 'local' });
            report(message, 'error');
            return false;
        };

        var reset = await sb.rpc('reset_my_devices', { p_device_id: getOrCreateDeviceId() });
        if (reset.error) { return fail(friendlyResetError(reset.error)); }

        var session = (await sb.auth.getSession()).data.session;
        var email = session && session.user ? session.user.email : null;
        if (!email) { return fail('This sign-in expired. Send a new code and try again.'); }

        var profileRes = await sb.from('profiles').select('*').eq('email', email).maybeSingle();
        if (profileRes.error || !profileRes.data) {
            return fail('This account is not set up yet. Please contact the study administrator.');
        }

        var profile = profileRes.data;
        var role = normalizeRole(profile.role);
        var mismatch = area ? areaMismatch(area, role) : '';
        if (mismatch) { return fail(mismatch); }

        /* reset_my_devices registered this device, but a student's account
           also names ONE active session (0027). Without this, the student's
           own heartbeat would read the older session as the active one and
           sign this device straight back out. */
        if (role === 'student' && typeof claimStudentSession === 'function') {
            var claim = await claimStudentSession();
            if (!claim.allowed && !claim.missing) { return fail(claim.reason); }
        }

        try {
            localStorage.setItem('pia_user_email', email);
            localStorage.setItem('pia_user_role', role);
        } catch (err) { /* private mode */ }

        clearInterval(drTimerId);
        await routeAfterSignIn(profile, role, report);
        return true;
    }

    async function handleDeviceResetCode(event) {
        event.preventDefault();
        clearFormErrors('device-reset-form');
        clearStatus('device-reset-status');

        var token = ($('#dr-code').value || '').replace(/\s+/g, '');
        if (!setFieldError('dr-code', /^\d{6,10}$/.test(token)
            ? '' : 'Enter the code from the email — numbers only.')) {
            focusFirstInvalid('device-reset-form');
            return;
        }

        var release = setBusy($('#dr-submit'), 'Checking…');

        try {
            var res = await sb.auth.verifyOtp({ email: deviceReset.email, token: token, type: 'email' });
            if (res.error) {
                /* One message for wrong, used and expired alike: telling them
                   apart helps a guesser, not a student. */
                setFieldError('dr-code', 'That code is wrong or has expired. Check the newest email, or send a new code.');
                focusFirstInvalid('device-reset-form');
                return;
            }

            await completeDeviceReset(deviceReset.area, function (message, tone) {
                setStatus('device-reset-status', message, tone);
            });
        } catch (err) {
            console.error('Device reset failed:', err);
            setStatus('device-reset-status', 'Can’t reach the server. Check your Wi-Fi, then try again.', 'error');
        } finally {
            release();
        }
    }

    /* The link in the same email lands here as ?flow=device-reset#tokens.
       supabase-js turns the tokens into a session while it starts, so this
       waits for getSession() BEFORE tidying the address bar -- clearing the
       hash first would throw the tokens away. Returns true when this visit
       was that link, so the boot skips the returning-visitor treatment. */
    async function handleDeviceResetLink() {
        var entry = new URL(window.PIA_ENTRY_URL || window.location.href);
        if (entry.searchParams.get('flow') !== 'device-reset') { return false; }

        var hash = new URLSearchParams(entry.hash.replace(/^#/, ''));
        var session = null;
        try { session = (await sb.auth.getSession()).data.session; } catch (err) { /* handled below */ }
        history.replaceState(null, '', entry.pathname);

        var linkToast = function (message, tone) {
            toast(tone === 'error' ? 'Couldn’t sign you in' : 'Signing you in',
                message, tone === 'error' ? 'danger' : 'accent');
        };

        if (hash.get('error') || hash.get('error_code') || !session) {
            linkToast(hash.get('error_code') === 'otp_expired'
                ? 'That link expired or was already used. Sign in again to get a new one.'
                : 'That link didn’t work. Sign in again to get a new one.', 'error');
            return true;
        }

        linkToast('Signing out your other devices…', 'ok');
        await completeDeviceReset(null, linkToast);
        return true;
    }

    /* Shared email-link requests. The existing 60-second UI cooldown is a
       convenience only; the service remains responsible for rate limits.
       Timestamps (not tick counts) survive backgrounding. State survives
       closing and changing the destination; no emails/tokens are persisted. */
    var emailRequests = {
        activate: { prefix: 'ac', title: 'Activate your account', pending: false, until: 0, version: 0, accepted: false },
        forgot: { prefix: 'fp', title: 'Reset your password', pending: false, until: 0, version: 0, accepted: false }
    };
    var emailTimer = null;

    function invalidateEmailView(id) {
        Object.keys(emailRequests).forEach(function (kind) {
            if (id === 'modal-' + kind) { emailRequests[kind].version++; }
        });
    }

    function renderEmailRequests() {
        clearTimeout(emailTimer);
        var ticking = false;
        Object.keys(emailRequests).forEach(function (kind) {
            var state = emailRequests[kind], p = state.prefix;
            var remaining = Math.max(0, Math.ceil((state.until - Date.now()) / 1000));
            var open = $('#modal-' + kind).classList.contains('is-open');
            $('#' + kind + '-form').hidden = state.accepted;
            $('#' + p + '-accepted').hidden = !state.accepted;
            $('#' + p + '-footer').hidden = state.accepted;
            $('#' + kind + '-title').textContent = state.accepted ? 'Check your email' : state.title;
            $('#' + kind + '-description').hidden = state.accepted;
            $('#' + p + '-submit').disabled = state.pending || remaining > 0;
            $('#' + p + '-submit').textContent = state.pending ? 'Sending…' :
                (kind === 'activate' ? 'Send activation link' : 'Send reset email');
            $('#' + p + '-resend').disabled = state.pending || remaining > 0;
            $('#' + p + '-change-email').disabled = state.pending;
            $('#' + p + '-resend').textContent = state.pending ? 'Sending…' : 'Resend email';
            $('#' + p + '-email').disabled = state.pending;
            // Deliberately outside the live region: do not announce every second.
            $('#' + p + '-cooldown').textContent = remaining ? 'You can request another email in ' + remaining + ' seconds.' : '';
            if (remaining && open) { ticking = true; }
        });
        if (ticking) { emailTimer = setTimeout(renderEmailRequests, 1000); }
    }

    function retryDelay(error) {
        var raw = error && (error.retry_after || error.retryAfter ||
            (error.headers && error.headers.get && error.headers.get('Retry-After')));
        if (raw && Number.isFinite(Number(raw))) { return Math.max(0, Number(raw) * 1000); }
        if (raw && Number.isFinite(Date.parse(raw))) { return Math.max(0, Date.parse(raw) - Date.now()); }
        var match = String(error && error.message || '').match(/after\s+(\d+)\s+seconds?/i);
        return match ? Number(match[1]) * 1000 : 60000;
    }

    function emailRequestError(error) {
        var message = String(error && error.message || '');
        if (Number(error && error.status) === 429 || /rate.limit|too many|after.*seconds/i.test(message)) {
            return 'Too many email requests. Wait for the cooldown, then try again.';
        }
        if (navigator.onLine === false || /fetch|network|connection/i.test(message)) {
            return 'The request could not be confirmed. Check your connection and your inbox before trying again.';
        }
        return 'The email request was not accepted. Try again later or contact your admin.';
    }

    async function requestEmail(kind, resend) {
        var state = emailRequests[kind], p = state.prefix;
        if (state.pending || Date.now() < state.until) { return; }
        clearFormErrors(kind + '-form');
        clearStatus(kind + '-status');
        var email = resend ? state.email : normalizeEmail($('#' + p + '-email').value);
        if (!setFieldError(p + '-email', isEmail(email) ? '' : 'Enter a valid school email address.')) {
            focusFirstInvalid(kind + '-form'); return;
        }
        var version = ++state.version;
        state.pending = true;
        renderEmailRequests();
        try {
            var res = kind === 'activate'
                ? await sb.auth.signInWithOtp({ email: email, options: { shouldCreateUser: false, emailRedirectTo: activationRedirect() } })
                : await sb.auth.resetPasswordForEmail(email, { redirectTo: activationRedirect() });
            if (res.error) {
                if (Number(res.error.status) === 429 || /rate.limit|too many|after.*seconds/i.test(res.error.message || '')) {
                    state.until = Date.now() + retryDelay(res.error);
                }
                if (version === state.version) { setStatus(kind + '-status', emailRequestError(res.error), 'error'); }
                return;
            }
            // Acceptance still starts the cooldown if the dialog was closed.
            state.until = Date.now() + 60000;
            if (version !== state.version) { return; }
            state.email = email;
            state.accepted = true;
            $('#' + p + '-sent-to').textContent = email;
            setStatus(kind + '-status', 'Email request accepted. Check your email.', 'ok');
            renderEmailRequests();
            $('#' + p + '-change-email').focus();
        } catch (error) {
            if (version === state.version) { setStatus(kind + '-status', emailRequestError(error), 'error'); }
        } finally {
            state.pending = false;
            renderEmailRequests();
        }
    }

    function initEmailRequests() {
        Object.keys(emailRequests).forEach(function (kind) {
            var state = emailRequests[kind], p = state.prefix;
            $('#' + kind + '-form').addEventListener('submit', function (event) {
                event.preventDefault(); requestEmail(kind, false);
            });
            $('#' + p + '-resend').addEventListener('click', function () { requestEmail(kind, true); });
            $('#' + p + '-change-email').addEventListener('click', function () {
                state.version++;
                state.accepted = false;
                clearStatus(kind + '-status');
                renderEmailRequests();
                $('#' + p + '-email').focus();
            });
        });
        document.addEventListener('visibilitychange', renderEmailRequests);
        renderEmailRequests();
    }

    /* ============================================ 6. BOOT ============== */

    /* ---- 6.1 A visitor who is already signed in ---------------------------
       Student, teacher or admin, the page stops pitching and greets them:
         - every Sign in becomes "Continue to dashboard", routed by role, and
           in the hero and finale it is promoted to the primary button;
         - "Activate account" and every "Teacher / Admin sign in" disappear (landing.css
           7.1b, keyed on data-session);
         - the kicker reads "Personal Instructing Agent" and the headline
           becomes "Good / Morning, / <first name>".
       theme-boot.js guessed before paint (data-session="pending"); this
       confirms the guess or withdraws it. */

    /* Remembered per email, so the greeting is written the moment the
       session is confirmed rather than after the profile round trip.
       executeForceLogout() clears localStorage, so it leaves with the user. */
    var GREETING_NAME_KEY = 'pia_greeting_name';

    /* Same boundaries as the dashboards' own greetings. */
    function partOfDay() {
        var hour = new Date().getHours();
        return hour < 12 ? 'Morning' : (hour < 18 ? 'Afternoon' : 'Evening');
    }

    /* "JUAN" from an all-caps roster is not shouted back: "Juan". */
    function tidyWord(word) {
        if (word.length < 2 || word !== word.toUpperCase() || word === word.toLowerCase()) { return word; }
        return word.toLowerCase().replace(/(^|[-'])(\S)/g, function (m, sep, ch) { return sep + ch.toUpperCase(); });
    }

    var STAFF_TITLE = /^(dr|prof|mr|mrs|ms|mx|sir|ma'?am|engr|atty)\.?$/i;

    /* The first word of the display name: "Juan Miguel Dela Cruz" → Juan.
       Two roster formats would break a plain split, so they are handled:
         "Dela Cruz, Juan"  surname first → the given name after the comma;
         "Dr. Maria Reyes"  a title keeps the surname → "Dr. Reyes", exactly
                            how the admin and teacher dashboards address them.
       No name on file: the email's first part ("juan.delacruz@…" → Juan). */
    function greetingName(fullName, email) {
        var name = String(fullName || '').trim();
        var comma = name.indexOf(',');
        if (comma !== -1) { name = name.slice(comma + 1).trim() || name.slice(0, comma).trim(); }

        var words = name.split(/\s+/).filter(Boolean);
        if (!words.length) {
            var local = String(email || '').split('@')[0].split(/[._+\-]/)[0];
            if (!local) { return 'there'; }
            return local.charAt(0).toUpperCase() + local.slice(1).toLowerCase();
        }

        words = words.map(tidyWord);
        if (words.length > 1 && STAFF_TITLE.test(words[0])) {
            return words[0] + ' ' + words[words.length - 1];
        }
        return words[0];
    }

    /* The staircase is sized so "Instructing" fills the column. "Afternoon,"
       or a long name can run wider, so measure and scale down just enough —
       never up. Re-run on resize and once the webfonts land. */
    function fitGreeting() {
        var title = $('#drop-title');
        if (!title || !title.classList.contains('is-greeting')) { return; }

        title.style.fontSize = '';

        /* Not everything scales in step with the type (the staircase indents
           are in container units, the volt box's tilt adds a sliver), so one
           proportional step can land just short. A few passes settle it. */
        for (var pass = 0; pass < 4; pass++) {
            var room = title.clientWidth;
            var need = title.scrollWidth;
            if (need <= room + 1) { break; }
            var size = parseFloat(window.getComputedStyle(title).fontSize);
            title.style.fontSize = Math.floor(size * (room / need) * 0.97) + 'px';
        }
    }

    var fitWired = false;

    function wireGreetingFit() {
        if (fitWired) { return; }
        fitWired = true;

        var queued = false;
        window.addEventListener('resize', function () {
            if (queued) { return; }
            queued = true;
            window.requestAnimationFrame(function () { queued = false; fitGreeting(); });
        });
        if (document.fonts && document.fonts.ready) { document.fonts.ready.then(fitGreeting); }
    }

    /* Rebuilds the three lines with the .scrub-w word spans landing.js lights,
       then lights them on the same stagger as the page's entrance. Text is
       set through textContent only, never innerHTML: the name comes from the
       database. */
    function writeGreeting(name) {
        var title = $('#drop-title');
        if (!title) { return; }

        var lines = [
            ['drop-l1', 'Good'],
            ['drop-l2', partOfDay() + ','],
            ['drop-l3', name]
        ];

        title.textContent = '';
        lines.forEach(function (line, n) {
            /* A space between the block lines keeps the accessible name
               "Good Morning, Juan" rather than "GoodMorning,Juan". */
            if (n) { title.appendChild(document.createTextNode(' ')); }
            var row = document.createElement('span');
            row.className = line[0];
            line[1].split(/\s+/).forEach(function (word, i) {
                if (i) { row.appendChild(document.createTextNode(' ')); }
                var w = document.createElement('span');
                w.className = 'scrub-w';
                w.textContent = word;
                row.appendChild(w);
            });
            title.appendChild(row);
        });
        title.classList.add('is-greeting');

        var kicker = $('.hero-kicker');
        if (kicker) { kicker.textContent = 'Personal Instructing Agent'; }

        fitGreeting();
        wireGreetingFit();
        document.documentElement.setAttribute('data-greeted', '');

        var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        $$('.scrub-w', title).forEach(function (w, i) {
            if (still) { w.classList.add('is-lit'); return; }
            setTimeout(function () { w.classList.add('is-lit'); }, 120 + i * 55);
        });
    }

    /* Is the session in storage one the SERVER still accepts? getSession()
       only reads localStorage, so a login ended elsewhere -- a device revoked
       from another device, "Sign out everywhere", a deleted account -- still
       looked signed in here. 'invalid' only on a definite answer; offline is
       'unknown' and keeps the greeting, as before. */
    async function sessionVerdict() {
        try {
            var user = await sb.auth.getUser();
            if (user.error) {
                var status = Number(user.error.status || 0);
                if (status === 401 || status === 403 || /session.*(missing|not found)|invalid.*(jwt|token)|jwt expired/i
                    .test(String(user.error.message || user.error.name || ''))) {
                    return 'invalid';
                }
                return 'unknown';
            }
            if (!user.data || !user.data.user) { return 'invalid'; }
        } catch (err) {
            return 'unknown';
        }

        /* The auth server knows about deleted sessions; the database also
           knows about "Sign out everywhere" (sessions_revoked_at). */
        if (typeof isSessionCurrentOnServer === 'function' && (await isSessionCurrentOnServer()) === false) {
            return 'invalid';
        }
        return 'valid';
    }

    async function forgetDeadSession() {
        try {
            await Promise.race([
                sb.auth.signOut({ scope: 'local' }),     /* this browser only: the server already ended it */
                new Promise(function (resolve) { setTimeout(resolve, 3000); })
            ]);
        } catch (err) { /* the storage clear below is what matters */ }
        if (typeof clearLocalSession === 'function') { clearLocalSession(); }
    }

    async function offerResume() {
        var root = document.documentElement;
        var session = null;

        try {
            session = (await sb.auth.getSession()).data.session;
        } catch (err) {
            /* Storage unavailable — treat as signed out. */
        }

        if (session && (await sessionVerdict()) === 'invalid') {
            /* A session the server has already ended: remove this browser's
               copy instead of greeting it. */
            await forgetDeadSession();
            session = null;
        }

        if (!session) {
            /* The pre-paint guess was stale (signed out in another tab, an
               expired or ended session): hand back the normal page. */
            root.removeAttribute('data-session');
            return;
        }
        root.setAttribute('data-session', 'in');

        var email = (session.user && session.user.email) || '';
        var role = null;
        try {
            var roleRes = await sb.from('profiles').select('role').eq('email', email).maybeSingle();
            if (!roleRes.error && roleRes.data) { role = normalizeRole(roleRes.data.role); }
        } catch (err) { /* continuation stays unavailable until verified */ }
        var finale = $('.finale-sub');
        if (finale) { finale.textContent = 'You are signed in. Continue to the activities available to your account.'; }
        var heroCopy = $('.drop-sub');
        if (heroCopy) { heroCopy.textContent = 'Continue to your dashboard and the activities available to your account.'; }

        $$('[data-auth-open="signin"]').forEach(function (btn) {
            /* data-resume-label lets a tight spot (the phone navbar) ask
               for a shorter label than the default. Buttons with a
               .cta-label keep their icon: only the label is rewritten. */
            var label = btn.querySelector('.cta-label') || btn;
            label.textContent = btn.getAttribute('data-resume-label') || 'Continue to dashboard';
            btn.addEventListener('click', function (event) {
                event.stopImmediatePropagation();
                if (!role) { toast('Dashboard unavailable', 'Your account role could not be verified. Check your connection and reload.', 'danger'); return; }
                /* page-guard.js admits only with this set. Written from the
                   session just verified, so the dashboard can never bounce
                   this click back here. */
                try { localStorage.setItem('pia_user_email', email); } catch (err) { /* private mode */ }
                if (role === 'admin') { window.location.replace('admin/html/admin-dashboard.html'); }
                else if (role === 'teacher') { window.location.replace('teacher/html/teacher-dashboard.html'); }
                else { window.location.replace('student/html/waiting-room.html'); }
            }, true);
        });

        /* With Activate gone, the hero's and finale's pair is down to one
           button, so it takes the primary style and a forward arrow. */
        $$('.hero-cta .cta-quiet[data-auth-open="signin"], .finale-actions .cta-quiet[data-auth-open="signin"]')
            .forEach(function (btn) {
                btn.classList.remove('cta-quiet');
                btn.classList.add('cta-primary');
                var glyph = btn.querySelector('.cta-orb use');
                if (glyph) { glyph.setAttribute('href', '#i-arrow-right'); }
            });

        var shown = '';
        try {
            var cached = JSON.parse(localStorage.getItem(GREETING_NAME_KEY) || 'null');
            if (cached && cached.email === email && cached.name) {
                shown = cached.name;
                writeGreeting(shown);
            }
        } catch (err) { /* nothing cached */ }

        var name = shown;
        try {
            var res = await sb.from('profiles').select('full_name').eq('email', email).maybeSingle();
            if (res.data && res.data.full_name) { name = greetingName(res.data.full_name, email); }
        } catch (err) { /* offline: keep the cached name, or fall back below */ }
        if (!name) { name = greetingName('', email); }

        if (name !== shown) { writeGreeting(name); }
        try { localStorage.setItem(GREETING_NAME_KEY, JSON.stringify({ email: email, name: name })); } catch (err) { /* ignore */ }
    }

    function boot() {
        initModals();

        /* Presentation-only field behaviour: works with or without a backend. */
        initPasswordToggles();
        initCapsLock();
        initLiveClear();

        if (typeof sb === 'undefined' || !sb) {
            /* Without the SDK the session cannot be confirmed: show the
               ordinary signed-out page rather than a half-greeting. */
            document.documentElement.removeAttribute('data-session');
            $$('.overlay form').forEach(function (form) {
                form.addEventListener('submit', function (event) {
                    event.preventDefault();
                    var row = form.closest('.overlay').querySelector('.auth-status');
                    if (row) { setStatus(row.id, 'The sign-in service is unavailable. Check your connection and reload.', 'error'); }
                });
            });
            return;
        }

        $('#signin-form').addEventListener('submit', handleStudentSignIn);
        $('#staff-form').addEventListener('submit', handleStaffSignIn);
        initEmailRequests();
        $('#device-reset-form').addEventListener('submit', handleDeviceResetCode);
        $('#dr-resend').addEventListener('click', sendDeviceResetCode);
        $$('[data-device-reset]').forEach(function (btn) {
            btn.addEventListener('click', openDeviceReset);
        });

        /* Smooth in-page anchors, without hijacking anything else. */
        $$('a[href^="#"]').forEach(function (link) {
            link.addEventListener('click', function (event) {
                var target = document.querySelector(link.getAttribute('href'));
                if (!target) { return; }
                event.preventDefault();
                target.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
            });
        });

        /* A "Sign out of other devices" link finishes here and navigates on;
           if it could not, this device is signed out again, so the page must
           not keep the signed-in guess theme-boot.js made. Otherwise, the
           usual welcome for a visitor who is already signed in. */
        handleDeviceResetLink().then(function (handled) {
            if (handled) { document.documentElement.removeAttribute('data-session'); return; }
            return offerResume().then(handleEntryIntent);
        });
    }

    /* ---- 6.2 Arriving with an intent ----
       index.html?signin=staff opens the staff sign-in (the consoles and
       page-guard send people here); &reason= says why they are signing in
       again. The address is tidied first so a reload does not repeat it. */
    var ENTRY_REASONS = {
        revoked: 'This device was signed out from another device. Sign in again to continue here.',
        ended: 'Your session ended. Sign in again to continue.'
    };

    function handleEntryIntent() {
        var entry;
        try { entry = new URL(window.PIA_ENTRY_URL || window.location.href); } catch (err) { return; }

        var target = entry.searchParams.get('signin');
        var reason = entry.searchParams.get('reason');
        if (!target && !reason) { return; }

        entry.searchParams.delete('signin');
        entry.searchParams.delete('reason');
        history.replaceState(null, '', entry.pathname + (entry.search || '') + entry.hash);

        /* Still signed in with a session the server accepts: the page already
           offers "Continue to dashboard". */
        if (document.documentElement.getAttribute('data-session') === 'in') { return; }

        var key = ['staff', 'activate', 'forgot'].includes(target) ? target : 'signin';
        var statusId = key === 'staff' ? 'staff-status' : 'signin-status';
        openAuth(key);
        if (ENTRY_REASONS[reason]) {
            /* After the dialog has mounted, so opening it cannot clear it. */
            setTimeout(function () { setStatus(statusId, ENTRY_REASONS[reason], 'error'); }, 200);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
