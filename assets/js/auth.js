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
        forgot: 'modal-forgot',
        'device-reset': 'modal-device-reset'
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
        if (id === 'modal-forgot' && typeof resetForgotDialog === 'function') { resetForgotDialog(); }

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
            return 'Nope — that email and password don\u2019t match. Check both (and Caps Lock) and try again.';
        }
        if (/email not confirmed/i.test(raw)) {
            return 'This account isn\u2019t switched on yet. Hit Activate account first.';
        }
        if (/rate limit|too many/i.test(raw)) {
            return 'Whoa, too many tries. Take a one-minute breather, then go again.';
        }
        return raw || 'Well, that didn\u2019t work. Let\u2019s try again.';
    }

    async function signIn(opts) {
        clearFormErrors(opts.formId);
        clearStatus(opts.statusId);

        /* The device-limit way out belongs to the attempt that hit the limit;
           a new attempt starts without it. */
        var offer = $('#' + opts.formId + ' [data-device-reset]');
        if (offer) { offer.hidden = true; }

        var email = normalizeEmail($('#' + opts.emailId).value);
        var password = $('#' + opts.passwordId).value;

        var valid = true;
        valid = setFieldError(opts.emailId, isEmail(email) ? '' : 'That doesn\u2019t look like an email address.') && valid;
        valid = setFieldError(opts.passwordId, password ? '' : 'You\u2019ll need your password for this one.') && valid;
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
            console.error('Sign-in failed:', err);
            setStatus(opts.statusId, 'Can\u2019t reach the server. Check your Wi-Fi, then try again.', 'error');
        } finally {
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

    /* ============================================ 4. ACTIVATION ======== */

    /* shouldCreateUser:false is the important argument. Without it a typo
       would silently create an auth user with no profile row — exactly the
       orphan state the admin console has to clean up by hand. */
    async function handleActivate(event) {
        event.preventDefault();
        clearFormErrors('activate-form');
        clearStatus('activate-status');

        var email = normalizeEmail($('#ac-email').value);
        if (!setFieldError('ac-email', isEmail(email) ? '' : 'That doesn\u2019t look like an email address.')) { return; }

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
            setStatus('activate-status', 'Can\u2019t reach the server. Check your Wi-Fi, then try again.', 'error');
        } finally {
            release();
        }
    }

    /* ============================================ 5. PASSWORD RESET ==== */

    /* Self-service recovery, in two steps inside one dialog.

         1. The email. resetPasswordForEmail() sends ONE email carrying both a
            reset link and a one-time code (the Supabase "Reset Password"
            template must include {{ .ConfirmationURL }} and {{ .Token }}).
         2. The code, for whoever finds typing it easier than opening the link
            — a student on a lab PC whose email is on their phone, say.
            verifyOtp(type: 'recovery') turns it into the same recovery
            session the link would, and both routes end on the set-password
            page, which saves the new password and signs them out to sign in
            again normally.

       Neither step ever says whether an address is enrolled: the wording is
       identical either way, so the form cannot be used to test the roster. */
    var forgotEmail = null;
    var resendTimerId = null;
    var RESEND_COOLDOWN = 60;

    function passwordPageAfterCode() {
        return new URL('assets/html/sign-up.html?mode=reset', window.location.href).href;
    }

    /* The footer's one primary button serves whichever step is showing. */
    function showForgotStep(step) {
        var onCode = step === 'code';
        $('#forgot-form').hidden = onCode;
        $('#forgot-code-form').hidden = !onCode;

        var submit = $('#fp-submit');
        submit.setAttribute('form', onCode ? 'forgot-code-form' : 'forgot-form');
        submit.innerHTML = onCode
            ? '<svg class="icon"><use href="#i-check"></use></svg> Verify code'
            : '<svg class="icon"><use href="#i-key"></use></svg> Send reset link';

        var field = onCode ? $('#fp-code') : $('#fp-email');
        if (field) { field.focus({ preventScroll: true }); }
    }

    function resetForgotDialog() {
        clearInterval(resendTimerId);
        forgotEmail = null;
        clearFormErrors('forgot-form');
        clearFormErrors('forgot-code-form');
        clearStatus('forgot-status');
        $('#forgot-code-form').reset();
        showForgotStep('email');
    }

    /* Supabase rate-limits reset emails; the cooldown keeps a student from
       hitting that limit and being told to wait with no explanation. */
    function startResendCooldown() {
        var btn = $('#fp-resend');
        var left = RESEND_COOLDOWN;
        clearInterval(resendTimerId);
        btn.disabled = true;
        btn.textContent = 'Send a new code (' + left + 's)';
        resendTimerId = setInterval(function () {
            left -= 1;
            if (left <= 0) {
                clearInterval(resendTimerId);
                btn.disabled = false;
                btn.textContent = 'Send a new code';
                return;
            }
            btn.textContent = 'Send a new code (' + left + 's)';
        }, 1000);
    }

    async function sendResetEmail(email) {
        return sb.auth.resetPasswordForEmail(email, { redirectTo: activationRedirect() });
    }

    async function handleForgot(event) {
        event.preventDefault();
        clearFormErrors('forgot-form');
        clearStatus('forgot-status');

        var email = normalizeEmail($('#fp-email').value);
        if (!setFieldError('fp-email', isEmail(email) ? '' : 'That doesn\u2019t look like an email address.')) {
            focusFirstInvalid('forgot-form');
            return;
        }

        var release = setBusy($('#fp-submit'), 'Sending…');
        var sent = false;

        try {
            var res = await sendResetEmail(email);
            if (res.error) {
                setStatus('forgot-status', friendlyAuthError(res.error), 'error');
                return;
            }
            sent = true;
        } catch (err) {
            console.error('Reset failed:', err);
            setStatus('forgot-status', 'Can\u2019t reach the server. Check your Wi-Fi, then try again.', 'error');
        } finally {
            release();
        }

        /* After release(): it restores the button's step-1 label, which the
           step switch then replaces. */
        if (sent) {
            forgotEmail = email;
            $('#fp-sent-to').textContent = email;
            showForgotStep('code');
            startResendCooldown();
            toast('Check your email', 'A reset link and code are on their way.');
        }
    }

    async function handleForgotCode(event) {
        event.preventDefault();
        clearFormErrors('forgot-code-form');
        clearStatus('forgot-status');

        var token = ($('#fp-code').value || '').replace(/\s+/g, '');
        if (!setFieldError('fp-code', /^\d{6,10}$/.test(token)
            ? '' : 'Enter the code from the email — numbers only.')) {
            focusFirstInvalid('forgot-code-form');
            return;
        }

        var release = setBusy($('#fp-submit'), 'Checking…');
        var verified = false;

        try {
            var res = await sb.auth.verifyOtp({ email: forgotEmail, token: token, type: 'recovery' });
            if (res.error) {
                /* One message for wrong, used and expired alike: telling them
                   apart helps a guesser, not a student. */
                setFieldError('fp-code', 'That code is wrong or has expired. Check the newest email, or send a new code.');
                focusFirstInvalid('forgot-code-form');
                return;
            }
            verified = true;
        } catch (err) {
            console.error('Code check failed:', err);
            setStatus('forgot-status', 'Can\u2019t reach the server. Check your Wi-Fi, then try again.', 'error');
        } finally {
            release();
        }

        if (verified) {
            clearInterval(resendTimerId);
            setStatus('forgot-status', 'Code accepted. Opening the page to choose your new password…', 'ok');
            window.location.assign(passwordPageAfterCode());
        }
    }

    async function handleForgotResend() {
        if (!forgotEmail) { return; }
        clearStatus('forgot-status');
        var btn = $('#fp-resend');
        btn.disabled = true;
        btn.textContent = 'Sending…';

        try {
            var res = await sendResetEmail(forgotEmail);
            if (res.error) {
                setStatus('forgot-status', friendlyAuthError(res.error), 'error');
                btn.disabled = false;
                btn.textContent = 'Send a new code';
                return;
            }
            setStatus('forgot-status', 'A new email is on its way. Use the newest code.', 'ok');
            $('#fp-code').value = '';
            startResendCooldown();
        } catch (err) {
            console.error('Resend failed:', err);
            setStatus('forgot-status', 'Can\u2019t reach the server. Check your Wi-Fi, then try again.', 'error');
            btn.disabled = false;
            btn.textContent = 'Send a new code';
        }
    }

    /* ============================================ 6. BOOT ============== */

    /* ---- 6.1 A visitor who is already signed in ---------------------------
       Student, teacher or admin, the page stops pitching and greets them:
         - every Sign in becomes "Continue to dashboard", routed by role, and
           in the hero and finale it is promoted to the primary button;
         - "Activate account" and every "Admin sign in" disappear (landing.css
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
            $$('[data-auth-open]').forEach(function (btn) {
                btn.addEventListener('click', function () {
                    toast('Server\u2019s not answering', 'The database didn\u2019t pick up. Refresh and try again.', 'danger');
                });
            });
            return;
        }

        $('#signin-form').addEventListener('submit', handleStudentSignIn);
        $('#staff-form').addEventListener('submit', handleStaffSignIn);
        $('#activate-form').addEventListener('submit', handleActivate);
        $('#forgot-form').addEventListener('submit', handleForgot);
        $('#forgot-code-form').addEventListener('submit', handleForgotCode);
        $('#fp-resend').addEventListener('click', handleForgotResend);
        $('#device-reset-form').addEventListener('submit', handleDeviceResetCode);
        $('#dr-resend').addEventListener('click', sendDeviceResetCode);
        $$('[data-device-reset]').forEach(function (btn) {
            btn.addEventListener('click', openDeviceReset);
        });
        $('#fp-change-email').addEventListener('click', function () { resetForgotDialog(); });

        /* Smooth in-page anchors, without hijacking anything else. */
        $$('a[href^="#"]').forEach(function (link) {
            link.addEventListener('click', function (event) {
                var target = document.querySelector(link.getAttribute('href'));
                if (!target) { return; }
                event.preventDefault();
                target.scrollIntoView({ behavior: 'smooth', block: 'start' });
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

        var key = target === 'staff' ? 'staff' : 'signin';
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
