/**
 * ============================================================================
 * PIA SYSTEM — ADMIN CONSOLE v2 (backend-wired)
 * ============================================================================
 * Vanilla JavaScript, no build step. Talks to Supabase through the shared
 * `sb` client created in assets/js/function.js.
 *
 * Ported from admin-dashboard.js. Every RPC name and argument shape is
 * preserved exactly, because the server-side definitions are not versioned in
 * this repository — renaming an argument here would silently 404.
 *
 * Sections
 *   1.  Utilities and shared-helper bridges
 *   2.  Application state
 *   3.  UI kit: sidebar, router, modals, toasts, confirm/notice, busy buttons
 *   4.  Data layer (all Supabase reads)
 *   5.  Presence helpers and Live Sessions
 *   6.  Class Sections
 *   7.  All Students
 *   8.  Participant profile and per-student actions
 *   9.  Faculty
 *   10. Stage Controls (access by section)
 *   11. Profile (password, sessions) and Settings (administrators)
 *   12. Scores encoding
 *   13. Realtime subscriptions
 *   16. (Math Task is a blank page; the question-bank editor was removed in Batch 3)
 *   15. Boot sequence
 * ==========================================================================*/
(function () {
    'use strict';

    /* ================================================== 1. UTILITIES ==== */

    var $ = function (sel, root) { return (root || document).querySelector(sel); };
    var $$ = function (sel, root) {
        return Array.prototype.slice.call((root || document).querySelectorAll(sel));
    };

    /* function.js owns these helpers. Local fallbacks keep this file usable
       even if it is loaded on its own (for example in a design review). */
    var esc = (typeof escapeHTML === 'function') ? escapeHTML : function (value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    };

    var toInt = (typeof safeInt === 'function') ? safeInt : function (value, fallback) {
        var n = parseInt(value, 10);
        return Number.isFinite(n) ? n : fallback;
    };

    /* Each BFPT trait scores 0-40; the drawer shows raw scores out of this. */
    var OCEAN_MAX = (typeof OCEAN_SCORE_MAX !== 'undefined') ? OCEAN_SCORE_MAX : 40;

    function debounce(fn, wait) {
        var timer = null;
        return function () {
            var args = arguments, self = this;
            clearTimeout(timer);
            timer = setTimeout(function () { fn.apply(self, args); }, wait || 200);
        };
    }

    function icon(name, extraClass) {
        return '<svg class="icon ' + (extraClass || '') + '"><use href="#i-' + name + '"></use></svg>';
    }

    /* A small (i) whose text shows on hover, focus or tap (see "Info tips"). */
    function infoTip(text, about) {
        return '<button type="button" class="info-tip" data-tip="' + esc(text) + '" aria-label="About ' +
            esc(about) + '">' + icon('info') + '</button>';
    }

    function initialsOf(fullName, email) {
        /* Honorifics are part of the stored name for faculty, so 'Dr. Alan
           Reyes' would otherwise initial as "DR" instead of "AR". */
        var source = (fullName || '').trim().replace(/^(Dr|Prof|Mr|Mrs|Ms|Engr|Atty)\.?\s+/i, '');
        if (!source) { return (email || '?').slice(0, 2).toUpperCase(); }
        var parts = source.split(/\s+/);
        if (parts.length === 1) { return parts[0].slice(0, 2).toUpperCase(); }
        return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }

    function pct(part, total) {
        return total > 0 ? Math.round((part / total) * 100) : 0;
    }

    /* Ported verbatim: Supabase Auth stores emails lowercased and the app
       matches exactly, so a typed 'Juan@UE.edu.ph' would never match its own
       session. */
    function normalizeEmail(raw) {
        return (raw || '').trim().toLowerCase();
    }

    /* Turns Postgres error codes into readable text. */
    function friendlyDbError(error, fallback) {
        if (!error) { return fallback; }
        var msg = error.message || '';
        /* The database's own refusals ("PIA: an administrator cannot ...",
           migration 0031) already say exactly why; pass them through. */
        if (/^PIA:\s*/.test(msg)) { return msg.replace(/^PIA:\s*/, ''); }
        if (error.code === '23505' || /duplicate key|already exists/i.test(msg)) {
            return 'An account already uses this email. Only one account per email is allowed.';
        }
        if (error.code === '42501' || /permission denied|row-level security/i.test(msg)) {
            return 'You do not have permission for this action. Make sure you are signed in as an admin.';
        }
        return msg || fallback;
    }

    /* ---- Test scores (migration 0034) ----
       Each test is entered as a raw score and the highest possible score, and
       the study reports the transmuted score:

           transmuted = (raw / highest possible) * 50 + 50        (50 – 100)

       The database calculates and stores it (trg_compute_test_scores) and
       refuses one typed by hand; transmute() here only previews it while the
       admin types, rounded to 2 decimals the same way. */
    var TEST_LABELS = { pre: 'pre-test', post: 'post-test' };

    function transmute(raw, max) {
        return Math.round((raw / max * 50 + 50 + Number.EPSILON) * 100) / 100;
    }

    function formatScore(n) {
        return n == null || n === '' ? '—' : String(Math.round(Number(n) * 100) / 100);
    }

    function sameNumber(a, b) {
        if (a == null || a === '' || b == null || b === '') { return (a == null || a === '') && (b == null || b === ''); }
        return Number(a) === Number(b);
    }

    /* One test's two fields. Both blank = not taken yet. With rawDecides (the
       Input scores table, where "Apply to all" fills every row's highest
       possible score) a blank raw score means no score, whatever the other
       field holds. */
    function readScorePair(rawValue, maxValue, rawDecides) {
        var rawText = String(rawValue == null ? '' : rawValue).trim();
        var maxText = String(maxValue == null ? '' : maxValue).trim();
        if (!rawText && (!maxText || rawDecides)) { return { ok: true, raw: null, max: null, score: null }; }
        if (!rawText) { return { ok: false, error: 'Enter the raw score too, or clear both fields.' }; }
        if (!maxText) { return { ok: false, error: 'Enter the highest possible score too.' }; }

        var raw = Number(rawText);
        var max = Number(maxText);
        if (!Number.isFinite(raw) || !Number.isFinite(max)) { return { ok: false, error: 'Scores must be numbers.' }; }
        if (max <= 0) { return { ok: false, error: 'The highest possible score must be more than 0.' }; }
        if (raw < 0 || raw > max) {
            return { ok: false, error: 'The raw score must be between 0 and ' + formatScore(max) + '.' };
        }
        return { ok: true, raw: raw, max: max, score: transmute(raw, max) };
    }

    /* A stored test for display: "90" with "40 / 50", or a score that was
       entered as a single number before raw scores were kept. */
    function scoreParts(s, test) {
        var score = s[test + '_test_score'];
        var raw = s[test + '_test_raw_score'];
        var max = s[test + '_test_max_score'];
        if (score == null) { return { value: 'n/a', detail: '' }; }
        if (raw == null || max == null) { return { value: formatScore(score), detail: 'Legacy' }; }
        return { value: formatScore(score), detail: formatScore(raw) + ' / ' + formatScore(max) };
    }

    var MIGRATION_MISSING = 'The database is missing the newest migrations. Apply 0033 and 0034, then try again.';

    function isEmail(value) {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    }

    /* Commas and parentheses are the delimiters of a PostgREST .or() filter.
       Left in place they break the query or return a 400. */
    function sanitizeFilterTerm(raw) {
        return (raw || '').replace(/[,()*]/g, ' ').trim();
    }

    /* Random, unguessable initial password. Never stored or shown — the owner
       sets their real password through the activation link. */
    function generateSecurePassword(length) {
        var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%';
        var bytes = new Uint32Array(length || 20);
        crypto.getRandomValues(bytes);
        return Array.from(bytes, function (b) { return chars[b % chars.length]; }).join('');
    }

    function formatDuration(startedAt) {
        if (!startedAt) { return 'Not started'; }
        var diff = Date.now() - new Date(startedAt).getTime();
        if (diff < 0) { return 'Just started'; }

        var hrs = Math.floor(diff / 3600000);
        var mins = Math.floor((diff % 3600000) / 60000);
        var secs = Math.floor((diff % 60000) / 1000);

        if (hrs > 0) { return hrs + 'h ' + mins + 'm'; }
        if (mins > 0) { return mins + 'm ' + secs + 's'; }
        return secs + 's';
    }

    /* Device IDs carry the platform in their signature (see getDeviceSignature
       in function.js). */
    function describeDevice(deviceId) {
        var id = String(deviceId || '');
        if (id.indexOf('Android') !== -1) { return { label: 'Android smartphone', glyph: 'phone' }; }
        if (id.indexOf('iPad') !== -1) { return { label: 'iPad tablet', glyph: 'tablet' }; }
        if (id.indexOf('iOS') !== -1) { return { label: 'iOS device', glyph: 'phone' }; }
        if (id.indexOf('macOS') !== -1) { return { label: 'macOS computer', glyph: 'laptop' }; }
        if (id.indexOf('Windows') !== -1) { return { label: 'Windows PC', glyph: 'monitor' }; }
        return { label: 'Unknown device', glyph: 'monitor' };
    }

    /* Always the public site, never this page's own address: an activation
       sent while the console runs on localhost is opened on a student's
       phone, which cannot reach 127.0.0.1. See PUBLIC_SITE_URL, function.js. */
    function activationRedirect() {
        return emailLinkTo('assets/html/sign-up.html');
    }

    /* ============================================ 2. APPLICATION STATE == */

    var STAGE_META = {
        'OCEAN': { label: 'OCEAN test', badge: 'badge-warn', fill: 'f-warn' },
        'Character Selection': { label: 'Character select', badge: 'badge', fill: 'f-muted' },
        'Tutoring Dashboard': { label: 'Tutoring dashboard', badge: '', fill: 'f-muted' },
        'Active Game': { label: 'Active session', badge: 'badge-accent', fill: '' }
    };

    var CONDITIONS = {
        'assigned': { short: 'EXP · Assigned', badge: 'badge-accent', family: 'experimental' },
        'non-assigned': { short: 'EXP · Free choice', badge: 'badge', family: 'experimental' },
        'neutral': { short: 'EXP · Neutral (legacy)', badge: 'badge-warn', family: 'experimental' },
        'control': { short: 'CTRL · Traditional', badge: '', family: 'control' }
    };

    /* Stage gate keys map to settings rows: stage_ocean / stage_char / stage_dash.
       These strings are also the p_stage argument of admin_set_stage_open and
       admin_grant_stage — do not rename them. `label` is the profiles.current_stage
       value of a student inside that stage. */
    var GATES = [
        { key: 'ocean', stage: 'Stage 1', title: 'OCEAN personality test', open: false, label: 'OCEAN' },
        { key: 'char', stage: 'Stage 2', title: 'Character selection', open: false, label: 'Character Selection' },
        { key: 'dash', stage: 'Stage 3', title: 'Tutoring dashboard', open: false, label: 'Tutoring Dashboard' }
    ];

    var PAGE_SIZE = 10;   /* students per page: the server pages, never more than ten rows */

    var state = {
        adminEmail: null,
        adminName: 'Admin',
        sections: [],
        cohort: [],          // lightweight summary of every non-admin profile
        resultEmails: {},    // lower-cased emails with a row in ocean_submissions
        rosterPage: [],      // the current page of the roster table
        faculty: [],
        admins: [],
        totalStudents: 0,
        page: 1,
        filters: { group: 'all', stage: null, search: '' },
        activeStudent: null,
        resetEmail: null,    // the student the Reset password dialog is acting on
        activeSection: null,
        deviceDiag: [],      // the last device-registration problems (see deviceProblem)
        overrides: undefined, // stage_overrides rows; undefined = loading, null = unavailable
        overridesMissing: false,
        gateSelected: { ocean: [], char: [], dash: [] }, // ticked section names per stage card; kept here so a repaint keeps them
        cohortLoaded: false,
        sectionsLoaded: false,
        stageTimes: undefined, // student_stage_time by lower-cased email; undefined = loading, null = table missing (0035)
        loading: { roster: false, cohort: false }
    };

    /* ==================================================== 3. UI KIT ===== */

    /* ---- 3.1 Boot gate and error banner ---- */

    function setBootText(message) {
        var node = $('#boot-text');
        if (node) { node.textContent = message; }
    }

    function revealApp() {
        document.body.removeAttribute('data-boot');
        var veil = $('#boot-veil');
        if (!veil) { return; }
        setTimeout(function () { veil.hidden = true; }, 200);
    }

    function showGlobalError(message) {
        var banner = $('#global-error-banner');
        var text = $('#global-error-message');
        if (!banner || !text) { return; }
        text.textContent = message;
        banner.hidden = false;
    }

    function hideGlobalError() {
        var banner = $('#global-error-banner');
        if (banner) { banner.hidden = true; }
    }

    /* ---- 3.2 Shell ----
       The frame (sidebar, People submenu, breadcrumbs, theme toggle, account
       menu, command palette) lives in admin-shell.js; this file owns routing
       and data and hands it a `host`. */

    function closeMobileNav() { PIAAdminShell.closeMobileNav(); }

    /* ---- 3.3 View router ---- */

    var VIEWS = ['overview', 'live', 'sections', 'students', 'faculty', 'controls', 'mathtask', 'profile', 'settings'];

    function switchView(view) {
        if (VIEWS.indexOf(view) === -1) { view = 'overview'; }

        $$('[data-view-panel]').forEach(function (panel) {
            panel.classList.toggle('is-hidden', panel.getAttribute('data-view-panel') !== view);
        });

        PIAAdminShell.setRoute(view);

        try { sessionStorage.setItem('pia.admin.view', view); } catch (err) { /* ignore */ }
        if (window.location.hash !== '#' + view) {
            history.replaceState(null, '', '#' + view);
        }

        /* Stage counters are the one thing that goes stale between visits. */
        if (view === 'students') { loadStageCounters(); }
        /* The bank loads at boot; a failed load (or one run before 0028
           existed) is retried when the view is opened. */
        if (view === 'live') { renderLiveSessions(); }

        closeMobileNav();
        window.scrollTo({ top: 0, behavior: 'auto' });
    }

    function initRouter() {
        var fromHash = (window.location.hash || '').replace('#', '');
        var stored = '';
        try { stored = sessionStorage.getItem('pia.admin.view') || ''; } catch (err) { /* ignore */ }
        switchView(fromHash || stored || 'overview');

        /* Back / forward and edited addresses follow the hash. */
        window.addEventListener('hashchange', function () {
            var target = (window.location.hash || '').replace('#', '');
            if (target && VIEWS.indexOf(target) !== -1) { switchView(target); }
        });
    }

    /* ---- 3.4 Modal manager ---- */

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

    /* `trigger` is the control that opened the dialog, when the caller knows
       it: Safari does not focus a button on click, so document.activeElement
       would be the wrong place to send focus back to. */
    function openModal(id, trigger) {
        var overlay = document.getElementById(id);
        if (!overlay || openLayers.indexOf(overlay) !== -1) { return; }

        if (!openLayers.length) {
            lastFocused = trigger || document.activeElement;
            lockScroll();
        }

        overlay.classList.add('is-mounted');
        openLayers.push(overlay);
        /* Raise this layer above every layer already open. All overlays share
           one base z-index in CSS, so without this the winner is decided by
           DOM source order — which is how an open drawer ended up covering a
           confirmation dialog it had itself triggered. Setting z-index does
           not affect layout, so this costs nothing in CLS. */
        overlay.style.zIndex = String(Z_OVERLAY_BASE + openLayers.length);

        /* Mount, force a style flush, then animate. Synchronous, unlike
           requestAnimationFrame, which is throttled in background tabs. */
        void overlay.offsetWidth;
        overlay.classList.add('is-open');

        /* Never an (i): focusing one opens its tip the moment the dialog does. */
        var first = overlay.querySelector('input:not([type="hidden"]), select, textarea, button:not(.info-tip)');
        if (first) { first.focus({ preventScroll: true }); }
    }

    function closeModal(target) {
        var overlay = (typeof target === 'string') ? document.getElementById(target) : target;
        overlay = overlay || openLayers[openLayers.length - 1];
        if (!overlay) { return; }

        overlay.classList.remove('is-open');
        overlay.style.zIndex = '';
        openLayers = openLayers.filter(function (layer) { return layer !== overlay; });

        /* Fields holding something sensitive (a temporary password) are
           wiped however the dialog closes: button, X, backdrop or Escape. */
        $$('[data-clear-on-close]', overlay).forEach(function (field) { field.value = ''; });

        /* The password dialog never reopens showing what was typed. */
        if (overlay.id === 'modal-change-password') {
            setPasswordsShown(false);
            clearFormErrors('change-password-form');
        }

        setTimeout(function () {
            overlay.classList.remove('is-mounted');
            if (!openLayers.length) {
                unlockScroll();
                if (lastFocused && lastFocused.focus) { lastFocused.focus({ preventScroll: true }); }
                /* A realtime tick may have been deferred while a form was open. */
                flushDeferredRefresh();
            }
        }, 160);
    }

    function initModals() {
        $$('[data-modal-open]').forEach(function (trigger) {
            trigger.addEventListener('click', function () {
                openModal(trigger.getAttribute('data-modal-open'));
            });
        });

        $$('.overlay').forEach(function (overlay) {
            var noDismiss = overlay.hasAttribute('data-no-dismiss');

            if (!noDismiss) {
                overlay.addEventListener('mousedown', function (event) {
                    if (event.target === overlay) { closeModal(overlay); }
                });
            }

            $$('[data-modal-close]', overlay).forEach(function (btn) {
                btn.addEventListener('click', function () { closeModal(overlay); });
            });
        });

        document.addEventListener('keydown', function (event) {
            if (!openLayers.length) { return; }
            var top = openLayers[openLayers.length - 1];

            if (event.key === 'Escape') {
                if (top.hasAttribute('data-no-dismiss')) { return; }
                event.preventDefault();
                closeModal(top);
                return;
            }

            if (event.key !== 'Tab') { return; }

            var nodes = $$(FOCUSABLE, top).filter(function (node) { return node.offsetParent !== null; });
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

    /* ---- 3.5 Toasts ---- */

    function toast(title, description, tone) {
        var stack = $('#toast-stack');
        if (!stack) { return; }

        var node = document.createElement('div');
        node.className = 'toast toast-' + (tone === 'danger' ? 'danger' : 'accent');
        node.innerHTML =
            icon(tone === 'danger' ? 'alert' : 'check') +
            '<div class="toast-text">' +
            '<p class="toast-title">' + esc(title) + '</p>' +
            (description ? '<p class="toast-desc">' + esc(description) + '</p>' : '') +
            '</div>';

        stack.appendChild(node);
        void node.offsetWidth;
        node.classList.add('is-open');

        setTimeout(function () {
            node.classList.remove('is-open');
            setTimeout(function () { node.remove(); }, 200);
        }, tone === 'danger' ? 6000 : 3800);
    }

    function toastOk(title, description) { toast(title, description, 'accent'); }
    function toastErr(title, description) { toast(title, description, 'danger'); }

    /* ---- 3.6 Confirm and notice dialogs ---- */

    /* Returns a promise so callers can `await confirmAction(...)` instead of
       threading a callback through every handler. */
    function confirmAction(options) {
        return new Promise(function (resolve) {
            var overlay = $('#modal-confirm');
            var accept = $('#confirm-accept');

            $('#confirm-title').textContent = options.title || 'Confirm action';
            $('#confirm-subtitle').textContent = options.subtitle || '';
            $('#confirm-heading').textContent = options.heading || options.title || 'Are you sure?';
            $('#confirm-text').textContent = options.message || '';

            var danger = options.tone !== 'accent';
            $('#confirm-glyph').className = 'modal-hero-glyph' + (danger ? '' : ' g-accent');
            $('#confirm-glyph').innerHTML = '<svg class="icon icon-lg"><use href="#i-' +
                (danger ? 'alert' : 'info') + '"></use></svg>';

            accept.textContent = options.confirmLabel || 'Proceed';
            accept.className = 'btn ' + (danger ? 'btn-danger' : 'btn-primary');

            /* Replacing the node drops every listener from a previous call. */
            var fresh = accept.cloneNode(true);
            accept.parentNode.replaceChild(fresh, accept);

            function settle(result) {
                overlay.removeEventListener('click', onBackdrop, true);
                document.removeEventListener('keydown', onEsc, true);
                resolve(result);
            }

            fresh.addEventListener('click', function () {
                closeModal(overlay);
                settle(true);
            });

            function onBackdrop(event) {
                if (event.target === overlay) { settle(false); }
            }
            function onEsc(event) {
                if (event.key === 'Escape') { settle(false); }
            }

            $$('[data-modal-close]', overlay).forEach(function (btn) {
                btn.addEventListener('click', function () { settle(false); }, { once: true });
            });
            overlay.addEventListener('click', onBackdrop, true);
            document.addEventListener('keydown', onEsc, true);

            openModal('modal-confirm');
        });
    }

    /* For outcomes too long for a toast: partial grants, broadcast summaries,
       orphaned-auth-user warnings. */
    function showNotice(title, body, tone) {
        $('#notice-title').textContent = 'Result';
        $('#notice-heading').textContent = title;
        $('#notice-body').textContent = body;

        var danger = tone === 'danger';
        $('#notice-glyph').className = 'modal-hero-glyph' + (danger ? '' : ' g-accent');
        $('#notice-glyph').innerHTML = '<svg class="icon icon-lg"><use href="#i-' +
            (danger ? 'alert' : 'info') + '"></use></svg>';

        openModal('modal-notice');
    }

    /* ---- 3.6b Info tips ----
       Context that used to sit permanently under titles and labels lives
       behind a small (i) (.info-tip, data-tip="…"). One shared bubble on
       <body>, fixed-positioned, so a scrolling modal body or a clipped card
       never cuts it off. Hover or keyboard focus shows it; a tap pins it,
       since touch has no hover; Escape, a tap elsewhere or any scroll hides
       it. While a tip is open, Escape closes the tip, not the dialog. */
    var tip = { bubble: null, owner: null, pinned: false, hideTimer: null };

    function tipBubble() {
        if (!tip.bubble) {
            tip.bubble = document.createElement('div');
            tip.bubble.className = 'tip-bubble';
            tip.bubble.id = 'pia-tip';
            tip.bubble.setAttribute('role', 'tooltip');
            document.body.appendChild(tip.bubble);
        }
        return tip.bubble;
    }

    function showTip(btn, pinned) {
        clearTimeout(tip.hideTimer);
        var bubble = tipBubble();
        if (tip.owner && tip.owner !== btn) { tip.owner.removeAttribute('aria-describedby'); }
        tip.owner = btn;
        tip.pinned = !!pinned;
        bubble.textContent = btn.getAttribute('data-tip') || '';
        btn.setAttribute('aria-describedby', 'pia-tip');

        /* Above the icon when it fits, otherwise below; never off-screen. */
        var margin = 8;
        var r = btn.getBoundingClientRect();
        var width = bubble.offsetWidth;
        var height = bubble.offsetHeight;
        var viewW = document.documentElement.clientWidth;
        var left = Math.max(margin, Math.min(r.left + r.width / 2 - width / 2, viewW - width - margin));
        var top = r.top - height - margin;
        if (top < margin) { top = r.bottom + margin; }
        bubble.style.left = Math.round(left) + 'px';
        bubble.style.top = Math.round(top) + 'px';
        bubble.classList.add('is-shown');
    }

    function hideTip() {
        clearTimeout(tip.hideTimer);
        if (tip.owner) { tip.owner.removeAttribute('aria-describedby'); }
        tip.owner = null;
        tip.pinned = false;
        if (tip.bubble) { tip.bubble.classList.remove('is-shown'); }
    }

    function tipOf(target) {
        return target && target.closest ? target.closest('.info-tip') : null;
    }

    function initInfoTips() {
        document.addEventListener('mouseover', function (event) {
            var btn = tipOf(event.target);
            if (btn && !tip.pinned) { showTip(btn, false); }
        });
        document.addEventListener('mouseout', function (event) {
            var btn = tipOf(event.target);
            if (!btn || btn !== tip.owner || tip.pinned || btn.contains(event.relatedTarget)) { return; }
            tip.hideTimer = setTimeout(hideTip, 80);
        });
        document.addEventListener('focusin', function (event) {
            var btn = tipOf(event.target);
            if (btn && !tip.pinned) { showTip(btn, false); }
        });
        document.addEventListener('focusout', function (event) {
            if (event.target === tip.owner && !tip.pinned) { hideTip(); }
        });
        document.addEventListener('click', function (event) {
            var btn = tipOf(event.target);
            if (btn) {
                event.preventDefault();
                if (tip.owner === btn && tip.pinned) { hideTip(); } else { showTip(btn, true); }
                return;
            }
            if (tip.owner) { hideTip(); }
        });
        window.addEventListener('keydown', function (event) {
            if (event.key === 'Escape' && tip.owner) {
                event.stopPropagation();
                hideTip();
            }
        }, true);
        window.addEventListener('scroll', function () { if (tip.owner) { hideTip(); } }, true);
        window.addEventListener('resize', function () { if (tip.owner) { hideTip(); } });
    }

    /* ---- 3.7 Busy buttons ----
       The label swaps but the button keeps its measured width, so toolbars and
       modal footers never resize mid-request. */
    function setBusy(button, busyLabel) {
        if (!button) { return function () {}; }
        var originalHTML = button.innerHTML;
        var originalWidth = button.getBoundingClientRect().width;

        button.style.width = Math.ceil(originalWidth) + 'px';
        button.classList.add('is-busy');
        button.disabled = true;
        button.innerHTML = esc(busyLabel || 'Working…');

        return function release() {
            button.innerHTML = originalHTML;
            button.classList.remove('is-busy');
            button.disabled = false;
            button.style.width = '';
        };
    }

    /* ---- 3.8 Field-level validation ---- */

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
        $$('.field-msg', form).forEach(function (node) { node.textContent = ''; });
        $$('.is-invalid', form).forEach(function (node) { node.classList.remove('is-invalid'); });
    }

    /* ---- 3.9 Skeleton helpers ---- */

    function skeletonRows(columns, rows) {
        var out = '';
        for (var r = 0; r < (rows || 5); r++) {
            out += '<tr aria-hidden="true">';
            for (var c = 0; c < columns; c++) {
                out += '<td>' + (c === 0
                    ? '<div class="cell-user"><span class="skeleton skeleton-avatar"></span>' +
                      '<span class="cell-user-text" style="width:160px">' +
                      '<span class="skeleton skeleton-line" style="width:70%"></span>' +
                      '<span class="skeleton skeleton-line" style="width:90%"></span></span></div>'
                    : '<span class="skeleton skeleton-pill"></span>') + '</td>';
            }
            out += '</tr>';
        }
        return out;
    }

    /* ---- 3.10 Loading state ----
       The console always says when it is working, and saying so never moves
       anything. Three layers (styles/pages/admin.css, section 19):

         1. #load-bar     a strip under the top bar while any user-visible
                          fetch is in flight, plus a spinning refresh icon;
         2. data-region   each panel names the loaders that feed it. While one
                          runs, the panel gets aria-busy, its own bar and a
                          dimmed body;
         3. skeletons     a panel with nothing to show holds the exact shape
                          of its content, so data replaces it in place.

       Nothing appears for the first 120ms, so a fast response shows nothing
       at all. Loads the admin did not ask for (the realtime refresh) are
       "quiet": no bar and no dimming, or the bar would never leave a live
       class. A load that fails while its panel still shows placeholders turns
       them into a message and a Try again button, so a placeholder can never
       sit there looking like it is still loading. */

    var Loading = (function () {
        var perKey = {};
        var visible = 0;
        var quietNext = false;
        var announceTimer = null;
        var announced = false;

        function paint() {
            $$('[data-region]').forEach(function (el) {
                var busy = el.getAttribute('data-region').split(/\s+/).some(function (key) {
                    return perKey[key] > 0;
                });
                if (busy && el.getAttribute('aria-busy') !== 'true') { el.setAttribute('aria-busy', 'true'); }
                else if (!busy && el.hasAttribute('aria-busy')) { el.removeAttribute('aria-busy'); }
            });

            if (visible > 0) { document.body.setAttribute('data-loading', 'true'); }
            else { document.body.removeAttribute('data-loading'); }
        }

        /* Screen readers hear about a load only if it is slow enough to
           notice, and hear when it is over. */
        function announce() {
            var status = $('#load-status');
            if (!status) { return; }
            clearTimeout(announceTimer);

            if (visible > 0) {
                announceTimer = setTimeout(function () {
                    status.textContent = 'Loading data…';
                    announced = true;
                }, 600);
            } else if (announced) {
                announced = false;
                status.textContent = 'Data updated.';
                announceTimer = setTimeout(function () { status.textContent = ''; }, 2500);
            }
        }

        function errorBlock(key, message) {
            return '<div class="state-block region-error">' +
                '<p class="state-title">Couldn’t load this</p>' +
                '<p class="state-desc">' + esc(message) + '</p>' +
                '<button class="btn btn-secondary" type="button" data-retry="' + esc(key) + '">Try again</button>' +
                '</div>';
        }

        /* Where a failed load leaves its placeholders. [selector, 'block'] or
           [selector, 'rows', columns]. */
        var FAILURE = {
            cohort: [['#live-tbody', 'rows', 4], ['#sections-tbody', 'rows', 6]],
            sections: [['#sections-tbody', 'rows', 6]],
            roster: [['#student-tbody', 'rows', 5]],
            faculty: [['#faculty-tbody', 'rows', 4]],
            settings: [['#gates-grid', 'block']],
            admins: [['#admin-tbody', 'rows', 2]],
            admindevices: [['#admin-device-list', 'block']]
        };

        function fail(key, err) {
            var message = friendlyDbError(err, 'The data could not be loaded.');

            (FAILURE[key] || []).forEach(function (target) {
                var el = $(target[0]);
                /* Only placeholders are replaced: data already on screen
                   stays, however stale. */
                if (!el || !el.querySelector('.skeleton')) { return; }
                el.innerHTML = target[1] === 'rows'
                    ? '<tr><td colspan="' + target[2] + '">' + errorBlock(key, message) + '</td></tr>'
                    : errorBlock(key, message);
            });

            /* A number that is still a placeholder becomes a dash. */
            var dashed = key === 'stages' ? '[data-stage-count]' : null;
            if (dashed) {
                $$(dashed).forEach(function (node) {
                    if (node.querySelector('.skeleton')) { node.textContent = '—'; }
                });
            }
        }

        function track(key, promise) {
            var quiet = quietNext;

            if (!quiet) {
                perKey[key] = (perKey[key] || 0) + 1;
                visible += 1;
                paint();
                announce();
            }

            function settle() {
                if (quiet) { return; }
                perKey[key] -= 1;
                visible -= 1;
                paint();
                announce();
            }

            return promise.then(function (value) {
                settle();
                return value;
            }, function (err) {
                settle();
                fail(key, err);
                throw err;
            });
        }

        return {
            track: track,
            fail: fail,
            /* Read synchronously by track(), so it covers exactly the loaders
               started before it is cleared again. */
            setQuiet: function (value) { quietNext = !!value; }
        };
    })();

    /* Runs one loader as a background refresh: same work, no bar, no
       dimming. For anything the admin did not just ask for. */
    function quietly(load) {
        Loading.setQuiet(true);
        try { return load(); } finally { Loading.setQuiet(false); }
    }

    /* The "Try again" buttons. Each loader is registered here once it has
       been wrapped for tracking (see "Loader tracking"). */
    var RETRY = {};

    function initRetry() {
        document.addEventListener('click', function (event) {
            var btn = event.target.closest('[data-retry]');
            if (!btn) { return; }
            var load = RETRY[btn.getAttribute('data-retry')];
            if (!load) { return; }

            var release = setBusy(btn, 'Loading…');
            Promise.resolve().then(load).catch(function (err) {
                toastErr('Still couldn’t load it', friendlyDbError(err, 'Check the connection and try again.'));
            }).then(release, release);
        });
    }

    /* ---- 3.11 Placeholders that match what replaces them ----
       Skeleton TEXT is real text with its colour removed and a shimmer behind
       it (.skeleton-text), so a placeholder line is exactly as tall and as
       wide as the words it stands in for. Every container below is built from
       the same classes as the renderer that later replaces it, and the words
       inside come from the same constants (GATES, STAGE_META), so a loaded
       card is the size of its placeholder and nothing moves.

       Only containers that are still empty are painted, and only once,
       before the console is revealed. */

    function sk(text) {
        return '<span class="skeleton skeleton-text">' + esc(text) + '</span>';
    }

    function skeletonPill(width) {
        return '<span class="skeleton skeleton-pill" style="width:' + width + 'px"></span>';
    }

    function skeletonGate(gate) {
        return '<article class="gate" aria-hidden="true"><div class="gate-body">' +
            '<div class="gate-top">' + skeletonPill(64) + skeletonPill(56) + '</div>' +
            '<h3 class="gate-title">' + sk(gate.title) + '</h3>' +
            '<div class="gate-access"><div class="gate-access-head"><p class="gate-access-label">' + sk('Sections') + '</p></div>' +
            '<span class="skeleton-text gate-access-skeleton"></span></div></div>' +
            '<div class="gate-foot"><span class="skeleton skeleton-btn"></span><span class="skeleton skeleton-btn"></span></div>' +
            '</article>';
    }

    /* The same parts as a real device row: glyph, name, the device id
       (which wraps), and the "This device" badge. */
    function skeletonDevice() {
        return '<div class="device-row" aria-hidden="true"><span class="skeleton" style="width:16px;height:16px"></span>' +
            '<div class="device-text"><p class="device-name">' + sk('macOS computer') + '</p></div>' +
            skeletonPill(84) + '</div>';
    }

    function skeletonTraits() {
        var one = '<div class="trait" aria-hidden="true"><div class="trait-top">' +
            '<span class="trait-name">' + sk('Conscientiousness') + '</span>' +
            '<span class="trait-val tnum">' + sk('00 / 40') + '</span></div><div class="bar"></div></div>';
        return '<p class="sr-only">Loading results…</p>' + one + one + one + one + one;
    }

    function paintSkeletons() {
        function fill(selector, markup) {
            var el = $(selector);
            if (el && !el.children.length) { el.innerHTML = markup; }
        }
        var times = function (n, make) {
            var out = '';
            for (var i = 0; i < n; i++) { out += make(i); }
            return out;
        };

        fill('#live-tbody', skeletonRows(4, 4));
        fill('#sections-tbody', skeletonRows(6, 4));
        fill('#gates-grid', GATES.map(skeletonGate).join(''));
        fill('#student-tbody', skeletonRows(5, 6));
        fill('#faculty-tbody', skeletonRows(4, 4));
        fill('#admin-tbody', skeletonRows(2, 2));
        fill('#admin-device-list', skeletonDevice());
    }

    /* A table that scrolls sideways must be reachable without a mouse, and
       a screen reader has to be told it is there. */
    function initScrollRegions() {
        $$('.table-wrap').forEach(function (wrap) {
            /* Page tables are labelled in the markup; dialogs' tables take
               their dialog's or card's title. */
            if (wrap.hasAttribute('aria-label') && wrap.getAttribute('role') === 'region') { return; }
            var host = wrap.closest('.card, .modal');
            var title = host && $('.card-title, .modal-title', host);
            wrap.setAttribute('role', 'region');
            wrap.tabIndex = 0;

            if (title && title.id && host.classList.contains('modal')) {
                wrap.setAttribute('aria-labelledby', title.id);
            } else {
                wrap.setAttribute('aria-label',
                    (title ? title.textContent.trim() : 'Table') + ' — scrolls sideways');
            }
        });
    }

    /* ================================================ 4. DATA LAYER ===== */

    /* Columns the overview aggregates need. Selecting the exact set rather
       than '*' keeps active_devices the only array we pull.

       Since migration 0018 profiles carries no assessment score for anyone;
       results live only in ocean_submissions, which only an admin can read.
       is_ocean_done is still pulled, because a retake clears it while the
       old result stays in the table — see hasCurrentResult(). */
    var COHORT_COLUMNS = 'full_name, email, section, group_type, status, current_stage, is_in_game,' +
        ' stage_started_at, active_devices, is_ocean_done, pre_test_score, post_test_score, selected_character';

    /* Added by migrations 0033 and 0034. Until they run the columns do not
       exist, and naming a missing column fails the whole read -- so the
       cohort drops them, newest first, rather than taking the overview down
       with it. */
    var CONSENT_COLUMNS = ', parental_consent, student_assent';
    var RAW_SCORE_COLUMNS = ', pre_test_raw_score, pre_test_max_score, post_test_raw_score, post_test_max_score';

    function isMissingColumn(error) {
        return !!error && (error.code === '42703' || error.code === 'PGRST204' ||
            /column .* does not exist|could not find the .* column/i.test(error.message || ''));
    }

    /* One pass over the cohort powers the KPI tiles, the pipeline, live
       sessions, section health and the section card counts. The study is a
       single Grade 7 cohort, so this is a small bounded read; the cap is a
       guard rail, not a paging strategy. The roster table below still pages
       server-side. */
    async function loadCohort() {
        state.loading.cohort = true;

        /* The results table answers "who has a stored result"; only an admin
           gets rows back from it. Just the email column: the scores
           themselves are fetched by the participant profile. */
        function readProfiles(columns) {
            return sb.from('profiles').select(columns).neq('role', 'admin').limit(2000);
        }

        var both = await Promise.all([
            readProfiles(COHORT_COLUMNS + CONSENT_COLUMNS + RAW_SCORE_COLUMNS),
            sb.from('ocean_submissions')
                .select('email')
                .limit(5000)
        ]);
        var res = both[0];
        var results = both[1];

        if (res.error && isMissingColumn(res.error)) {
            console.warn('[PIA] raw score columns missing; apply migration 0034. Cohort read without them.');
            res = await readProfiles(COHORT_COLUMNS + CONSENT_COLUMNS);
        }
        if (res.error && isMissingColumn(res.error)) {
            console.warn('[PIA] consent columns missing; apply migration 0033. Cohort read without them.');
            res = await readProfiles(COHORT_COLUMNS);
        }

        state.loading.cohort = false;

        if (res.error) { throw res.error; }
        if (results.error) { throw results.error; }

        state.resultEmails = {};
        (results.data || []).forEach(function (row) {
            state.resultEmails[String(row.email || '').toLowerCase()] = true;
        });

        state.cohort = res.data || [];
        await loadStageTimes();
        state.cohortLoaded = true;
        renderLiveSessions();
        renderSections();
        renderGateAccess();
    }

    /* Active seconds per stage and the last heartbeat (migration 0035). Read
       apart from the cohort and on its own timer: a student's page pings every
       30 seconds, and none of it belongs in the profiles table, whose every
       write makes this console reload. A read that fails leaves the previous
       numbers in place; a table that does not exist yet is remembered as such
       so the card can say what to apply. */
    var STAGE_TIME_FIELD = {
        'OCEAN': 'ocean_time',
        'Character Selection': 'character_select_time',
        'Tutoring Dashboard': 'tutoring_time'
    };
    var LIVE_WINDOW_MS = 60 * 1000;

    async function loadStageTimes() {
        var res = await sb.from('student_stage_time')
            .select('student_email, ocean_time, character_select_time, tutoring_time, heartbeat_stage, last_heartbeat_timestamp')
            .limit(5000);

        if (res.error) {
            if (isMissingTable(res.error)) { state.stageTimes = null; }
            else {
                /* Keep the last good read on screen and say it is not fresh. */
                state.stageTimesStale = true;
                console.error('[PIA] stage times could not be read:', res.error);
            }
            return;
        }

        var byEmail = {};
        (res.data || []).forEach(function (row) { byEmail[String(row.student_email || '').toLowerCase()] = row; });
        state.stageTimes = byEmail;
        state.stageTimesStale = false;
    }

    async function loadSections() {
        var res = await sb.from('sections').select('name').order('name', { ascending: true });
        if (res.error) { throw res.error; }

        state.sections = res.data || [];
        state.sectionsLoaded = true;
        fillSectionSelects();
        renderSections();
        $('#nav-count-sections').textContent = state.sections.length;
    }

    /* Group and stage filters shared by the roster query and the tab counts,
       so a count always describes the same rows the tab would show. */
    function applyGroupFilter(query) {
        var g = state.filters.group;
        if (g === 'experimental') { return query.in('group_type', ['assigned', 'non-assigned', 'neutral']); }
        if (g === 'assigned' || g === 'non-assigned' || g === 'neutral' || g === 'control') {
            return query.eq('group_type', g);
        }
        return query;
    }

    function applyStageFilter(query, stage) {
        if (stage === null || stage === undefined || stage === '') { return query; }
        if (stage === 'Active Game') { return query.eq('is_in_game', true); }
        return query.eq('current_stage', stage).eq('is_in_game', false);
    }

    /* Server-side filtering, paging and counting. A newer request supersedes
       an older one: a slow answer for a previous filter is dropped, so the
       table can never show rows that do not match the controls. */
    var rosterTicket = 0;

    async function loadRoster() {
        var ticket = ++rosterTicket;
        var tbody = $('#student-tbody');
        if (!state.rosterPage.length) {
            tbody.innerHTML = skeletonRows(5, 6);
        }
        state.loading.roster = true;
        $('#pager-info').textContent = 'Loading…';

        var query = sb.from('profiles').select('*', { count: 'exact' }).neq('role', 'admin');

        var term = sanitizeFilterTerm(state.filters.search).toLowerCase();
        if (term) {
            query = query.or('full_name.ilike.%' + term + '%,email.ilike.%' + term + '%');
        }
        query = applyStageFilter(applyGroupFilter(query), state.filters.stage);

        var start = (state.page - 1) * PAGE_SIZE;
        query = query.range(start, start + PAGE_SIZE - 1).order('full_name', { ascending: true });

        var res = await query;
        if (ticket !== rosterTicket) { return; }
        state.loading.roster = false;

        if (res.error) {
            /* Placeholders (or stale rows) become a message with a retry: an
               empty table would read as "no students". */
            tbody.innerHTML = '<tr><td colspan="5"><div class="state-block region-error">' +
                '<p class="state-title">Couldn’t load the students</p>' +
                '<p class="state-desc">' + esc(friendlyDbError(res.error, 'Unknown database error.')) + '</p>' +
                '<button class="btn btn-secondary btn-sm" type="button" data-retry="roster">Try again</button>' +
                '</div></td></tr>';
            $('#student-empty').classList.add('is-hidden');
            $('#pager-info').textContent = 'Could not load the students.';
            $('#page-prev').disabled = true;
            $('#page-next').disabled = true;
            return;
        }

        var total = res.count || 0;
        var pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
        /* The filter shrank the result below this page: clamp and read again. */
        if (total > 0 && state.page > pages) {
            state.page = pages;
            loadRoster();
            return;
        }

        state.rosterPage = res.data || [];
        state.totalStudents = total;
        renderRoster();
    }

    /* Head-only counts over the whole table (honouring the group filter, never
       the page or the search), so each tab's number is what it would list. 'email'
       is selected because 'id' does not exist on profiles — with head:true the
       column is never read, it only has to exist. A count that fails is shown as
       "—", never as 0. */
    var counterTicket = 0;
    var COUNTER_KEYS = ['all', 'OCEAN', 'Character Selection', 'Tutoring Dashboard', 'Active Game'];

    async function loadStageCounters() {
        var ticket = ++counterTicket;
        var base = function (stage) {
            var q = sb.from('profiles').select('email', { count: 'exact', head: true }).neq('role', 'admin');
            return applyStageFilter(applyGroupFilter(q), stage === 'all' ? null : stage);
        };

        try {
            var results = await Promise.all(COUNTER_KEYS.map(function (key) { return base(key); }));
            if (ticket !== counterTicket) { return; }

            var failed = null;
            results.forEach(function (res, index) {
                var node = $('[data-stage-count="' + COUNTER_KEYS[index] + '"]');
                if (res.error) { failed = res.error; }
                if (node) { node.textContent = res.error ? '—' : (res.count || 0); }
            });
            if (failed) { throw failed; }
            var allCount = results[0].count || 0;
            $('#nav-count-students').textContent = allCount;
        } catch (err) {
            console.error('Stage counters failed:', err);
            Loading.fail('stages', err);
        }
    }

    async function loadFaculty() {
        var res = await sb.from('professors').select('*').order('name', { ascending: true });
        if (res.error) { throw res.error; }

        state.faculty = res.data || [];
        $('#nav-count-faculty').textContent = state.faculty.length;
        renderFaculty($('#faculty-search') ? $('#faculty-search').value : '');
        renderSections();     /* the professor column reads this */
    }

    /* settings holds one row per stage flag: stage_ocean / stage_char / stage_dash.
       stage_overrides (0033) lists the sections an admin opened into a closed
       stage; it is read alongside, and its failure never hides the switches. */
    async function loadSettings() {
        var both = await Promise.all([
            sb.from('settings').select('key, value'),
            sb.from('stage_overrides').select('stage, section, granted_count, granted_by, granted_at')
                .order('section', { ascending: true })
        ]);
        var res = both[0];
        var overrides = both[1];
        if (res.error) { throw res.error; }

        (res.data || []).forEach(function (row) {
            if (!row.key || row.key.indexOf('stage_') !== 0) { return; }
            var key = row.key.replace('stage_', '');
            var gate = GATES.filter(function (g) { return g.key === key; })[0];
            if (gate) { gate.open = (row.value === true || row.value === 'true'); }
        });

        state.overridesMissing = !!overrides.error && isMissingTable(overrides.error);
        if (overrides.error && !state.overridesMissing) {
            console.error('[PIA] stage overrides could not be read:', overrides.error);
        }
        state.overrides = overrides.error ? null : (overrides.data || []);

        renderGates();
    }

    function fillSectionSelects() {
        var markup = state.sections.map(function (section) {
            return '<option value="' + esc(section.name) + '">' + esc(section.name) + '</option>';
        }).join('');

        $$('[data-section-select]').forEach(function (select) {
            var current = select.value;
            select.innerHTML = markup || '<option value="">No sections yet</option>';
            if (current) { select.value = current; }
        });
    }

    /* ================================ 5. PRESENCE AND LIVE SESSIONS ===== */

    /* Completed = a stored result in ocean_submissions AND not sent back for
       a retake. A retake clears is_ocean_done but keeps the old result in
       the table, so the table alone would count a student who is mid-retake
       as finished — the old score-on-profiles check never did that, because
       the reset erased the score. */
    function hasCurrentResult(s) {
        return s.is_ocean_done === true &&
            !!(state.resultEmails && state.resultEmails[String(s.email || '').toLowerCase()]);
    }

    function stageOf(profile) {
        if (profile.is_in_game) { return 'Active Game'; }
        return profile.current_stage || null;
    }

    /* "Signed in somewhere": a non-empty active_devices array, maintained
       server-side by claim_device / release_device. It says a login holds a
       device slot, NOT that the student is looking at a page right now, so it
       is only ever labelled "Signed in" / "Signed out" and is never used for
       Live Sessions or section status. A profile fetched without that column
       returns null rather than a misleading "signed out". */
    function isOnline(profile) {
        if (!profile || !Object.prototype.hasOwnProperty.call(profile, 'active_devices')) {
            return null;
        }
        return (profile.active_devices || []).length > 0;
    }

    function avatarMarkup(profile) {
        var online = isOnline(profile);
        var dot = (online === null) ? '' :
            '<span class="avatar-dot' + (online ? ' is-online' : '') +
            '" data-presence="' + esc(profile.email) + '"' +
            ' title="' + (online ? 'Signed in' : 'Signed out') + '"></span>';

        return '<span class="avatar-wrap">' +
            '<span class="avatar">' + esc(initialsOf(profile.full_name, profile.email)) + '</span>' +
            dot + '</span>';
    }

    function userCell(profile) {
        return '' +
            '<div class="cell-user">' +
            avatarMarkup(profile) +
            '<span class="cell-user-text">' +
            '<span class="cell-name">' + esc(profile.full_name || '(no name)') + '</span>' +
            '<span class="cell-mail">' + esc(profile.email) + '</span>' +
            '</span>' +
            '</div>';
    }

    /* Patches every dot for one email in place. Called from the realtime
       handler so a student signing in flips the indicator immediately,
       without waiting for — or triggering — a table re-render. */
    function applyPresence(email, online) {
        $$('[data-presence="' + (email || '').replace(/"/g, '\\"') + '"]').forEach(function (dot) {
            dot.classList.toggle('is-online', !!online);
            dot.title = online ? 'Signed in' : 'Signed out';
        });
    }

    /* profiles.current_stage also holds values outside the four tracked
       stages — 'Waiting Room' most of all. Every lookup falls back to the raw
       string rather than assuming STAGE_META has an entry. */
    function stageLabel(stageKey) {
        if (!stageKey) { return '—'; }
        return STAGE_META[stageKey] ? STAGE_META[stageKey].label : stageKey;
    }

    function stageBadge(stageKey) {
        if (!stageKey) { return '<span class="muted">—</span>'; }
        return '<span class="badge">' + esc(stageLabel(stageKey)) + '</span>';
    }

    /* Whole seconds as hh:mm:ss (hours may exceed two digits). */
    function formatClock(total) {
        var n = Math.max(0, Math.floor(Number(total) || 0));
        var h = Math.floor(n / 3600);
        var m = Math.floor((n % 3600) / 60);
        var sec = n % 60;
        function two(v) { return v < 10 ? '0' + v : String(v); }
        return two(h) + ':' + two(m) + ':' + two(sec);
    }

    /* ---- Connection state -------------------------------------------------
       What an administrator can actually read:

         * the stage heartbeat: a stage page (OCEAN, Character Selection,
           Tutoring Dashboard) calls record_heartbeat every 30 seconds while
           its tab is visible, and the server stamps the time itself
           (student_stage_time.last_heartbeat_timestamp);
         * whether a login holds a device slot (profiles.active_devices,
           claim_device / release_device): signed in, or signed out.

       From those, three states and no more:

         Connected  the last stage check-in is within LIVE_WINDOW_MS.
         Offline    no recent check-in AND no login holds a device slot, so
                    the account is signed out. Only this is verified absence.
         Unknown    no recent check-in but a login is still open. The student
                    may be on the waiting room (which beats touch_presence,
                    readable by teachers only, not by admins), on a page that
                    does not check in, or have closed the tab without signing
                    out. The absence of a heartbeat alone is NOT evidence of
                    being offline, so it is not reported as such.

       Never listed: no recorded stage activity and not signed in.
       There is NO interaction signal: the page's inactivity timer is
       client-side only and never reported, so "Active" and "Idle/Away" cannot
       be told apart and are not shown. The window is compared with the
       administrator's own clock; a badly set clock shifts every row the same
       way. A window that has passed says check-ins stopped, not when the
       connection was lost. */
    var LIVE_PAGE_SIZE = 10;
    var live = { filter: 'all', page: 1, readAt: 0, rows: [], tickId: null, expiry: Infinity, stopped: true };
    var LIVE_FILTERS = ['all', 'connected', 'offline', 'unknown'];

    /* 'connected' | 'unknown' | 'offline' | null (nothing to report). */
    function presenceOf(student, time, now) {
        var beat = (time && STAGE_TIME_FIELD[time.heartbeat_stage])
            ? new Date(time.last_heartbeat_timestamp).getTime() : NaN;
        if (isFinite(beat) && (now - beat) <= LIVE_WINDOW_MS) { return 'connected'; }

        /* Without the devices column there is nothing to say either way. */
        if (!student || !Array.isArray(student.active_devices)) { return isFinite(beat) ? 'unknown' : null; }
        if (student.active_devices.length > 0) { return 'unknown'; }
        return time ? 'offline' : null;
    }

    /* One row per student with something to report. */
    function buildLiveRows() {
        var times = state.stageTimes || {};
        var now = Date.now();
        var rows = [];
        live.expiry = Infinity;
        state.cohort.forEach(function (s) {
            var time = times[String(s.email || '').toLowerCase()];
            var conn = presenceOf(s, time, now);
            if (!conn) { return; }
            var counted = time && STAGE_TIME_FIELD[time.heartbeat_stage] ? time.heartbeat_stage : null;
            if (conn === 'connected') {
                live.expiry = Math.min(live.expiry, new Date(time.last_heartbeat_timestamp).getTime() + LIVE_WINDOW_MS);
            }
            rows.push({
                student: s,
                /* Where they are now: the live heartbeat while connected, otherwise the
                   location recorded on their profile (set when a page is entered). */
                stage: conn === 'connected' ? counted : (stageOf(s) || counted),
                counted: counted,
                conn: conn,
                /* Seconds the server counted in the last stage that checked in; null when
                   none was ever recorded (shown as a dash, never as zero). */
                seconds: counted ? (Number(time[STAGE_TIME_FIELD[counted]]) || 0) : null
            });
        });
        var rank = { connected: 0, unknown: 1, offline: 2 };
        rows.sort(function (a, b) {
            if (a.conn !== b.conn) { return rank[a.conn] - rank[b.conn]; }
            return String(a.student.full_name || a.student.email).localeCompare(String(b.student.full_name || b.student.email));
        });
        live.rows = rows;
        live.readAt = now;
        if (live.tickId !== null && !live.stopped) { scheduleLiveTick(); }
    }

    var PRESENCE_TEXT = { connected: 'Connected', offline: 'Offline', unknown: 'Unknown' };
    var PRESENCE_TITLE = {
        connected: 'Checked in within the last minute',
        offline: 'Signed out',
        unknown: 'No readable signal: signed in, but no stage check-in (for example on the waiting room)'
    };

    function presenceMarkup(conn) {
        var dot = conn === 'connected' ? 'dot-on' : (conn === 'unknown' ? 'dot-unknown' : 'dot-off');
        return '<span class="presence" title="' + esc(PRESENCE_TITLE[conn]) + '"><span class="dot ' + dot +
            '" aria-hidden="true"></span>' + PRESENCE_TEXT[conn] + '</span>';
    }

    function renderLiveSessions() {
        var tbody = $('#live-tbody');
        if (!tbody) { return; }
        var foot = $('#live-foot');

        function message(title, text) {
            tbody.innerHTML = '<tr><td colspan="4"><div class="state-block">' +
                '<p class="state-title">' + esc(title) + '</p>' +
                (text ? '<p class="state-desc">' + esc(text) + '</p>' : '') +
                '</div></td></tr>';
            $('#live-pager-info').textContent = '—';
            $('#live-prev').disabled = true;
            $('#live-next').disabled = true;
            LIVE_FILTERS.forEach(function (k) {
                var n = $('[data-live-count="' + k + '"]'); if (n) { n.textContent = '—'; }
            });
        }

        if (state.stageTimes === null) {
            message('Active time is not available',
                'The stage-time table is not set up on this database. Apply supabase/migrations/20260929_0035_stage_time_tracking.sql, then refresh.');
            return;
        }
        if (!state.cohortLoaded || state.stageTimes === undefined) {
            tbody.innerHTML = skeletonRows(4, 6);
            return;
        }

        buildLiveRows();
        var counts = { all: live.rows.length };
        ['connected', 'offline', 'unknown'].forEach(function (k) {
            counts[k] = live.rows.filter(function (r) { return r.conn === k; }).length;
        });
        Object.keys(counts).forEach(function (k) {
            var n = $('[data-live-count="' + k + '"]'); if (n) { n.textContent = counts[k]; }
        });

        var shown = live.rows.filter(function (r) { return live.filter === 'all' || r.conn === live.filter; });
        var pages = Math.max(1, Math.ceil(shown.length / LIVE_PAGE_SIZE));
        live.page = Math.min(Math.max(1, live.page), pages);       /* clamp after any change */

        if (!shown.length) {
            message(live.rows.length ? 'No students match this filter' : 'No student activity recorded yet',
                live.rows.length ? '' : 'Students appear here after their stage page first checks in.');
            return;
        }

        var start = (live.page - 1) * LIVE_PAGE_SIZE;
        tbody.innerHTML = shown.slice(start, start + LIVE_PAGE_SIZE).map(function (r) {
            var s = r.student;
            return '' +
                '<tr data-live-row="' + esc(s.email) + '">' +
                '<td><div class="cell-user"><span class="avatar" aria-hidden="true">' + esc(initialsOf(s.full_name, s.email)) + '</span>' +
                '<span class="cell-user-text"><span class="cell-name">' + esc(s.full_name || '(no name)') + '</span>' +
                presenceMarkup(r.conn) + '</span></div></td>' +
                '<td>' + esc(s.section || '—') + '</td>' +
                '<td>' + stageBadge(r.stage) + '</td>' +
                (r.seconds === null
                    ? '<td class="duration-cell col-w-time" data-live-conn="' + r.conn + '" title="No stage time recorded">—</td>'
                    : '<td class="duration-cell col-w-time" data-live-clock="' + r.seconds + '" data-live-conn="' + r.conn +
                      '" title="Counted while in ' + esc(stageLabel(r.counted)) + '">' + esc(formatClock(r.seconds)) + '</td>') +
                '</tr>';
        }).join('');

        var from = start + 1, to = Math.min(start + LIVE_PAGE_SIZE, shown.length);
        $('#live-pager-info').textContent = 'Showing ' + from + '–' + to + ' of ' + shown.length +
            (pages > 1 ? ' · page ' + live.page + ' of ' + pages : '');
        $('#live-prev').disabled = live.page <= 1;
        $('#live-next').disabled = live.page >= pages;

        foot.textContent = (state.stageTimesStale
            ? 'Could not refresh just now; showing the last data read. '
            : '') +
            'Connected: the stage page checked in within the last minute. Offline: signed out. Unknown: signed in but no stage check-in, for example on the waiting room. Active time is counted by the server and stops when check-ins stop.';
    }

    /* Connected clocks advance between reads, measured from the clock rather
       than counted (so a throttled tab cannot drift); Offline clocks never
       change. One interval for the whole page. */
    function tickLiveClocks() {
        live.tickId = null;
        if (!document.hidden) {
            var panel = $('#view-live');
            if (panel && !panel.classList.contains('is-hidden')) {
                var now = Date.now();
                if (now > live.expiry) { renderLiveSessions(); }       /* a row just lost its window */
                var elapsed = Math.floor((now - live.readAt) / 1000);
                $$('[data-live-conn="connected"]').forEach(function (cell) {
                    cell.textContent = formatClock(Number(cell.getAttribute('data-live-clock')) + elapsed);
                });
            }
        }
        scheduleLiveTick();
    }

    /* One timer at a time, aimed at the next whole second after the last read,
       so the clocks change on the second and a late timer cannot pile up. */
    function scheduleLiveTick() {
        if (live.stopped) { return; }
        clearTimeout(live.tickId);
        var wait = 1000 - ((Date.now() - live.readAt) % 1000) + 5;
        live.tickId = setTimeout(tickLiveClocks, wait);
    }

    function initLive() {
        $$('[data-live-filter]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                live.filter = btn.getAttribute('data-live-filter');
                live.page = 1;
                $$('[data-live-filter]').forEach(function (b) {
                    var on = b === btn;
                    b.classList.toggle('is-active', on);
                    b.setAttribute('aria-pressed', on ? 'true' : 'false');
                });
                renderLiveSessions();
            });
        });
        $('#live-prev').addEventListener('click', function () { live.page--; renderLiveSessions(); });
        $('#live-next').addEventListener('click', function () { live.page++; renderLiveSessions(); });
    }

    /* The list is re-read every 20 seconds, on its own: a heartbeat is not a
       profiles change, so nothing else here would notice one. Stopped when
       the page goes away. */
    var liveRefreshId = null;

    function refreshStageTimes() {
        if (document.hidden || !state.cohortLoaded) { return; }
        loadStageTimes().then(function () {
            renderLiveSessions();
            renderSections();
        }).catch(function () { /* the next tick tries again */ });
    }

    function startLiveSessionsTimer() {
        if (liveRefreshId !== null) { return; }
        liveRefreshId = setInterval(refreshStageTimes, 20000);
        live.stopped = false;
        scheduleLiveTick();
        document.addEventListener('visibilitychange', function () {
            if (!document.hidden) { refreshStageTimes(); }
        });
        window.addEventListener('pagehide', function () {
            clearInterval(liveRefreshId); clearTimeout(live.tickId);
            liveRefreshId = null; live.tickId = null; live.stopped = true;
        });
    }

    /* ================================================ 6. CLASS SECTIONS === */

    /* A section has exactly two labels. Online: at least one member is
       Connected by the same heartbeat rule Live Sessions uses. Offline: there
       are members and every one of them is verified signed out. Anything else
       (a member signed in without a stage check-in, no members, unreadable
       stage-time data) is not enough evidence for either, so there is no
       label at all: the cell shows a dash with a "Status unavailable"
       explanation. It is never reported as Offline. */
    function sectionStatus(members) {
        if (!state.stageTimes || !members.length) { return null; }
        var now = Date.now();
        var offline = 0;
        for (var i = 0; i < members.length; i++) {
            var c = presenceOf(members[i], state.stageTimes[String(members[i].email || '').toLowerCase()], now);
            if (c === 'connected') { return { online: true }; }
            if (c === 'offline') { offline += 1; }
        }
        return offline === members.length ? { online: false } : null;
    }

    function renderSections() {
        var tbody = $('#sections-tbody');
        if (!tbody) { return; }

        if (!state.sectionsLoaded || !state.cohortLoaded) {
            tbody.innerHTML = skeletonRows(6, 4);
            return;
        }

        if (!state.sections.length) {
            tbody.innerHTML = '<tr><td colspan="6"><div class="state-block">' +
                '<p class="state-title">No sections yet</p></div></td></tr>';
            return;
        }

        tbody.innerHTML = state.sections.map(function (section) {
            var members = state.cohort.filter(function (s) { return s.section === section.name; });
            var done = members.filter(hasCurrentResult).length;
            var status = sectionStatus(members);
            var statusCell = status === null
                ? '<span class="muted status-na" title="Status unavailable">—<span class="sr-only">Status unavailable</span></span>'
                : '<span class="presence"><span class="dot ' + (status.online ? 'dot-on' : 'dot-off') +
                  '" aria-hidden="true"></span>' + (status.online ? 'Online' : 'Offline') + '</span>';
            var prof = state.faculty.filter(function (f) { return f.assigned_section === section.name; })[0];

            return '' +
                '<tr>' +
                '<td><span class="cell-name">' + esc(section.name) + '</span></td>' +
                '<td>' + (prof ? esc(prof.name) : '<span class="muted">—</span>') + '</td>' +
                '<td class="col-right mono">' + members.length + '</td>' +
                '<td class="col-right mono">' + done + (members.length ? ' · ' + pct(done, members.length) + '%' : '') + '</td>' +
                '<td>' + statusCell + '</td>' +
                '<td class="col-right"><button type="button" class="btn btn-secondary btn-sm" data-section-open="' +
                esc(section.name) + '" aria-label="View roster for section ' + esc(section.name) + '">View</button></td>' +
                '</tr>';
        }).join('');
    }

    function initSectionsTable() {
        $('#sections-tbody').addEventListener('click', function (event) {
            var btn = event.target.closest('[data-section-open]');
            if (btn) { openSectionDetails(btn.getAttribute('data-section-open'), btn); }
        });
    }

    function professorFor(sectionName) {
        var match = state.faculty.filter(function (f) { return f.assigned_section === sectionName; })[0];
        return match ? match.name : 'No professor assigned';
    }

    async function openSectionDetails(sectionName, trigger) {
        state.activeSection = sectionName;
        $('#section-details-title').textContent = 'Section ' + sectionName;
        $('#section-details-sub').textContent = 'Loading enrolled students…';
        $('#section-students-tbody').innerHTML = skeletonRows(5, 4);
        openModal('modal-section-details', trigger);

        var res = await sb.from('profiles')
            .select('role, full_name, email, group_type, status, pre_test_score, post_test_score')
            .eq('section', sectionName)
            .order('full_name', { ascending: true });

        if (res.error) {
            $('#section-details-sub').textContent = 'Could not load this section.';
            $('#section-students-tbody').innerHTML = '';
            toastErr('Section failed to load', friendlyDbError(res.error, 'Unknown database error.'));
            return;
        }

        var students = (res.data || []).filter(function (row) {
            return (row.role || '').toLowerCase() !== 'admin';
        });

        $('#section-details-sub').textContent = students.length +
            ' student' + (students.length === 1 ? '' : 's') + ' enrolled.';

        if (!students.length) {
            $('#section-students-tbody').innerHTML = '<tr><td colspan="5">' +
                '<div class="state-block" style="min-height:200px">' +
                '<span class="state-glyph">' + icon('users', 'icon-lg') + '</span>' +
                '<p class="state-title">No students in this section</p>' +
                '</div></td></tr>';
            return;
        }

        $('#section-students-tbody').innerHTML = students.map(function (s) {
            return '' +
                '<tr>' +
                '<td>' + userCell(s) + '</td>' +
                conditionCell(s) +
                '<td>' + activationBadge(s) + '</td>' +
                '<td class="tnum muted">' + esc(s.pre_test_score == null ? '—' : s.pre_test_score) + '</td>' +
                '<td class="tnum muted">' + esc(s.post_test_score == null ? '—' : s.post_test_score) + '</td>' +
                '</tr>';
        }).join('');
    }

    /* ============================================== 7. ALL STUDENTS ===== */

    /* Whether the student has activated their account, in words that say so.
       "Inactive" read as a fault; this is registration state: a registered
       student is Pending until their first sign-in, after which the database
       marks them active and this reads Activated. */
    function activationBadge(s) {
        var activated = (s.status || '') === 'active';
        return '<span class="badge ' + (activated ? 'badge-accent' : '') + '">' +
            (activated ? 'Activated' : 'Pending') + '</span>';
    }

    /* The whole row opens the participant profile; there are no buttons in
       it. With none left, the row takes focus itself (see initRoster). */
    function rosterRow(s, cells) {
        return '<tr class="is-clickable" tabindex="0" data-student="' + esc(s.email) + '"' +
            ' aria-label="Open profile: ' + esc(s.full_name || s.email) + '">' +
            '<td>' + userCell(s) + '</td>' + cells + '</tr>';
    }

    /* The student's experimental group, as the same badge everywhere. */
    function conditionCell(s) {
        var condition = CONDITIONS[s.group_type] || { short: s.group_type || '—', badge: '' };
        return '<td><span class="badge ' + condition.badge + '">' + esc(condition.short) + '</span></td>';
    }

    function filtersActive() {
        return !!(state.filters.stage || state.filters.group !== 'all' || state.filters.search.trim());
    }

    function renderRoster() {
        var tbody = $('#student-tbody');
        var empty = $('#student-empty');

        var none = state.rosterPage.length === 0;
        empty.classList.toggle('is-hidden', !none);
        $('#reset-filters').classList.toggle('is-hidden', !filtersActive());
        $('#student-empty .state-title').textContent = filtersActive() ? 'No matching students' : 'No students yet';

        tbody.innerHTML = state.rosterPage.map(function (s) {
            return rosterRow(s,
                '<td>' + esc(s.section || '—') + '</td>' +
                conditionCell(s) +
                '<td>' + stageBadge(stageOf(s)) + '</td>' +
                '<td>' + activationBadge(s) + '</td>');
        }).join('');

        var pages = Math.max(1, Math.ceil(state.totalStudents / PAGE_SIZE));
        var from = state.totalStudents ? (state.page - 1) * PAGE_SIZE + 1 : 0;
        var to = Math.min(state.page * PAGE_SIZE, state.totalStudents);

        $('#pager-info').textContent = state.totalStudents
            ? 'Showing ' + from + '–' + to + ' of ' + state.totalStudents + (pages > 1 ? ' · page ' + state.page + ' of ' + pages : '')
            : 'No students to show';
        $('#page-prev').disabled = state.page <= 1;
        $('#page-next').disabled = state.page >= pages;
    }

    function setStageTab(key) {
        state.filters.stage = key || null;
        $$('[data-stage-filter]').forEach(function (tab) {
            var on = (tab.getAttribute('data-stage-filter') || '') === (key || '');
            tab.classList.toggle('is-active', on);
            tab.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
    }

    function initRoster() {
        $('#student-search').addEventListener('input', debounce(function (event) {
            state.filters.search = event.target.value;
            state.page = 1;
            loadRoster();
        }, 300));

        $('#group-filter').addEventListener('change', function (event) {
            state.filters.group = event.target.value;
            state.page = 1;
            loadRoster();
            loadStageCounters();       /* the counts follow the group */
        });

        $$('[data-stage-filter]').forEach(function (tab) {
            tab.addEventListener('click', function () {
                setStageTab(tab.getAttribute('data-stage-filter'));
                state.page = 1;
                loadRoster();
            });
        });

        $('#reset-filters').addEventListener('click', function () {
            state.filters = { group: 'all', stage: null, search: '' };
            $('#student-search').value = '';
            $('#group-filter').value = 'all';
            setStageTab('');
            state.page = 1;
            loadRoster();
            loadStageCounters();
        });

        $('#page-prev').addEventListener('click', function () {
            if (state.page > 1) { state.page--; loadRoster(); }
        });

        $('#page-next').addEventListener('click', function () {
            var pages = Math.max(1, Math.ceil(state.totalStudents / PAGE_SIZE));
            if (state.page < pages) { state.page++; loadRoster(); }
        });

        /* One delegated listener covers every row. */
        $('#student-tbody').addEventListener('click', function (event) {
            var row = event.target.closest('[data-student]');
            if (row) { openStudentDrawer(row.getAttribute('data-student'), row); }
        });

        $('#student-tbody').addEventListener('keydown', function (event) {
            if (event.key !== 'Enter' && event.key !== ' ') { return; }
            var row = event.target.closest('[data-student]');
            if (!row || event.target !== row) { return; }
            event.preventDefault();
            openStudentDrawer(row.getAttribute('data-student'), row);
        });
    }

    /* ===================== 8. PARTICIPANT PROFILE AND ACTIONS =========== */

    function findStudent(email) {
        return state.rosterPage.filter(function (s) { return s.email === email; })[0] ||
            state.cohort.filter(function (s) { return s.email === email; })[0] || null;
    }

    function consentLabel(value) {
        return value === true ? 'Received' : value === false ? 'Not received' : 'Not recorded';
    }

    function openStudentDrawer(email, trigger) {
        var s = findStudent(email);
        if (!s) { return; }

        state.activeStudent = s;
        var condition = CONDITIONS[s.group_type] || { short: s.group_type || '—', badge: '' };

        $('#drawer-initials').textContent = initialsOf(s.full_name, s.email);

        var drawerOnline = isOnline(s);
        var drawerDot = $('#drawer-presence');
        if (drawerDot) {
            drawerDot.classList.toggle('is-hidden', drawerOnline === null);
            drawerDot.classList.toggle('is-online', drawerOnline === true);
            drawerDot.setAttribute('data-presence', s.email);
            drawerDot.title = drawerOnline ? 'Signed in' : 'Signed out';
        }
        $('#drawer-student-name').textContent = s.full_name || '(no name)';
        $('#drawer-email').textContent = s.email;
        $('#drawer-condition').textContent = condition.short;
        $('#drawer-condition').className = 'badge ' + (condition.badge || '');
        $('#drawer-section').textContent = s.section || '—';
        $('#drawer-stage').textContent = stageLabel(stageOf(s));
        $('#drawer-tutor').textContent = tutorLabel(s);
        /* Clearing a tutor to re-pick only makes sense where the student picks one. */
        var reselect = $('[data-student-action="retake-character"]');
        if (reselect) { reselect.classList.toggle('is-hidden', s.group_type !== 'non-assigned'); }
        $('#drawer-status').textContent = ((s.status || '') === 'active' ? 'Activated' : 'Not activated') +
            (s.must_change_password === true ? ' · Must change temporary password' : '');
        $('#drawer-assent').textContent = consentLabel(s.student_assent);
        ['pre', 'post'].forEach(function (test) {
            var parts = scoreParts(s, test);
            $('#drawer-' + test).textContent = parts.value;
            $('#drawer-' + test + '-detail').textContent = parts.detail;
        });

        renderTraits(s);
        openModal('drawer-student', trigger);
    }

    /* ---- Assessment results (BFPT) ------------------------------------
       Results live ONLY in ocean_submissions. Its one RLS policy admits an
       admin with a current session (migration 0018); a student or teacher
       asking the same question gets zero rows. profiles carries no score for
       anyone, so the participant profile fetches results from here
       rather than reading them off the roster row. */
    var BFPT = window.PIA_BFPT || null;
    var BFPT_COLUMNS = 'email, responses, ocean_e, ocean_a, ocean_c, ocean_n, ocean_o,' +
        ' submitted_at, scoring_key, source';

    /* The document's order and its names for the five traits. */
    var BFPT_TRAITS = [
        { key: 'ocean_e', name: 'Extroversion' },
        { key: 'ocean_a', name: 'Agreeableness' },
        { key: 'ocean_c', name: 'Conscientiousness' },
        { key: 'ocean_n', name: 'Neuroticism' },
        { key: 'ocean_o', name: 'Openness to Experience' }
    ];

    function noticeHtml(iconName, title, text) {
        return '<div class="notice">' + icon(iconName) + '<div><p class="notice-title">' + esc(title) + '</p>' +
            (text ? '<p class="notice-text">' + esc(text) + '</p>' : '') + '</div></div>';
    }

    function formatStamp(iso) {
        var d = new Date(iso);
        return isNaN(d.getTime()) ? '—'
            : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    }

    /* Newest first, so rows[0] is the result that counts; the rest are the
       history a retake leaves behind. */
    async function fetchResults(email) {
        var query = sb.from('ocean_submissions').select(BFPT_COLUMNS);
        if (email) { query = query.eq('email', email); }
        return query
            .order('submitted_at', { ascending: false })
            .order('id', { ascending: false })
            .limit(5000);
    }

    async function renderTraits(s) {
        var box = $('#drawer-traits');
        box.innerHTML = skeletonTraits();
        box.setAttribute('aria-busy', 'true');

        var res = await fetchResults(s.email);
        box.removeAttribute('aria-busy');

        /* The admin may have opened another student while this was loading. */
        if (state.activeStudent !== s) { return; }

        if (res.error) {
            box.innerHTML = noticeHtml('alert', 'Could not load results',
                friendlyDbError(res.error, 'Unknown database error.'));
            return;
        }

        var rows = res.data || [];
        if (!rows.length) {
            box.innerHTML = noticeHtml('info', 'No result yet', s.is_ocean_done
                ? 'Marked complete, but no stored result was found. Allow a retake to collect one.'
                : '');
            return;
        }

        var r = rows[0];

        var scores = BFPT_TRAITS.map(function (t) {
            var v = r[t.key];
            var width = v == null ? 0 : Math.max(0, Math.min(100, (v / OCEAN_MAX) * 100));
            return '' +
                '<div class="trait">' +
                '<div class="trait-top">' +
                '<span class="trait-name">' + esc(t.name) + '</span>' +
                '<span class="trait-val tnum">' + (v == null ? 'n/a'
                    : esc(v) + '<span class="trait-of"> / ' + OCEAN_MAX + '</span>') + '</span>' +
                '</div>' +
                '<div class="bar"><div class="bar-fill" style="width:' + width + '%"></div></div>' +
                '</div>';
        }).join('');

        var meta = 'Submitted ' + esc(formatStamp(r.submitted_at)) +
            (rows.length > 1 ? ' · latest of ' + rows.length + ' attempts' : '') +
            ' · scored with the BFPT sheet';

        var answers;
        if (Array.isArray(r.responses) && r.responses.length === 50) {
            answers = '<details class="bfpt-answers"><summary>All 50 answers</summary><ol class="bfpt-answer-list">' +
                r.responses.map(function (v, i) {
                    var text = BFPT ? BFPT.items[i] : 'Item ' + (i + 1);
                    var label = BFPT ? BFPT.labelFor(v) : null;
                    return '<li>' +
                        '<span class="bfpt-n tnum">' + (i + 1) + '</span>' +
                        '<span class="bfpt-q">' + esc(text) + '</span>' +
                        '<span class="bfpt-a">' + (label ? esc(label) + ' · ' : '') + '<b class="tnum">' + esc(v) + '</b></span>' +
                        '</li>';
                }).join('') +
                '</ol></details>';
        } else {
            answers = '<p class="bfpt-meta">Item answers were not kept for this result — it predates ' +
                'answer storage and was carried over from the old profile record.</p>';
        }

        box.innerHTML = scores + '<p class="bfpt-meta">' + meta + '</p>' + answers;
    }

    function initDrawerActions() {
        $$('[data-student-action]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var s = state.activeStudent;
                if (!s) { return; }
                var action = btn.getAttribute('data-student-action');

                if (action === 'edit') { closeModal('drawer-student'); openEditStudent(s.email); }
                else if (action === 'retake-ocean') { allowRetakeOcean(s.email); }
                else if (action === 'retake-character') { allowRetakeCharacter(s.email); }
                else if (action === 'reset-password') { closeModal('drawer-student'); openResetPassword(s.email); }
                else if (action === 'delete') { deleteStudent(s.email); }
            });
        });
    }

    /* ---- Password-reset email ---- */

    /* The preferred route: the owner sets their own password through the
       emailed link, and no password is ever known to the admin.
       opts.confirmed skips the confirm step when the caller is already a
       deliberate choice — the Reset password dialog. */
    async function sendPasswordReset(email, sourceBtn, opts) {
        if (!(opts && opts.confirmed)) {
            var ok = await confirmAction({
                title: 'Reset password',
                heading: 'Send a reset link to ' + email + '?',
                message: 'They will choose their own new password through the emailed link. ' +
                    'No password is set or revealed here.',
                confirmLabel: 'Send reset email',
                tone: 'accent'
            });
            if (!ok) { return; }
        }

        var release = setBusy(sourceBtn, 'Sending…');
        var res = await sb.auth.resetPasswordForEmail(email, { redirectTo: activationRedirect() });
        release();

        if (res.error) {
            toastErr('Reset email failed', res.error.message);
            return;
        }
        toastOk('Reset email requested', 'The service accepted the request for ' + email + '. Delivery is not confirmed here.');
    }

    /* ---- Temporary password (admin override) ------------------------------
       For a student who cannot receive the reset email. The password goes to
       the admin-set-temp-password Edge Function, which holds the service-role
       key, verifies this admin, sets it with the Auth Admin API, raises
       must_change_password and signs the student out everywhere. The student
       is then forced to replace it at their next sign-in, so the admin never
       knows the password they end up with. */

    /* No look-alikes (0/O, 1/l/I), so it can be read out across a classroom.
       Three groups of four, with an upper, a lower and a digit guaranteed,
       and hyphens that satisfy a symbol rule if the project enforces one. */
    function generateTempPassword() {
        var upper = 'ABCDEFGHJKMNPQRSTUVWXYZ';
        var lower = 'abcdefghjkmnpqrstuvwxyz';
        var digit = '23456789';
        var all = upper + lower + digit;
        var bytes = new Uint32Array(15);
        crypto.getRandomValues(bytes);

        var chars = [];
        for (var i = 0; i < 12; i++) { chars.push(all[bytes[i] % all.length]); }

        /* Force one of each class into distinct random slots. */
        var slots = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
        [[upper, 12], [lower, 13], [digit, 14]].forEach(function (pair) {
            var pick = slots.splice(bytes[pair[1]] % slots.length, 1)[0];
            chars[pick] = pair[0][bytes[pair[1]] % pair[0].length];
        });

        return chars.slice(0, 4).join('') + '-' + chars.slice(4, 8).join('') + '-' + chars.slice(8).join('');
    }

    /* The same floor the Edge Function enforces; Supabase's own password
       policy applies on top and its message is shown if it is stricter. */
    function tempPasswordProblem(pw) {
        if (pw.length < 8) { return 'Use at least 8 characters.'; }
        if (pw.length > 72) { return 'Use 72 characters or fewer.'; }
        if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) { return 'Use at least one letter and one number.'; }
        return '';
    }

    function openResetPassword(email) {
        state.resetEmail = email;
        $('#reset-pw-sub').textContent = email;
        $('#temp-password').value = '';
        $('#temp-password').readOnly = false;
        $('#temp-password-generate').disabled = false;
        setFieldError('temp-password', '');
        $('#temp-password-done').hidden = true;
        $('#temp-password-submit').disabled = false;
        openModal('modal-reset-password');
    }

    /* supabase-js reports a non-2xx function response as FunctionsHttpError,
       with the Response in error.context; the function puts its reason in
       { error }. A FunctionsFetchError means it never answered at all —
       most often because it has not been deployed yet. */
    async function functionErrorMessage(error) {
        try {
            if (error && error.context && typeof error.context.json === 'function') {
                var body = await error.context.json();
                if (body && body.error) { return body.error; }
            }
        } catch (e) { /* not JSON */ }
        if (error && error.name === 'FunctionsFetchError') {
            return 'Could not reach the password service. Check that the admin-set-temp-password ' +
                'Edge Function is deployed.';
        }
        return (error && error.message) || 'The temporary password could not be set.';
    }

    async function handleSetTempPassword(event) {
        event.preventDefault();
        var email = state.resetEmail;
        var pw = $('#temp-password').value;

        var problem = tempPasswordProblem(pw);
        setFieldError('temp-password', problem);
        if (problem) { $('#temp-password').focus(); return; }

        var release = setBusy($('#temp-password-submit'), 'Setting…');
        var res = await sb.functions.invoke('admin-set-temp-password', {
            body: { email: email, password: pw }
        });
        release();

        if (res.error) {
            setFieldError('temp-password', await functionErrorMessage(res.error));
            return;
        }

        /* Done: freeze the field so what is read out is what was set.
           Generate too, or one stray click would replace it with a
           password the student's account never received. */
        $('#temp-password').readOnly = true;
        $('#temp-password-generate').disabled = true;
        $('#temp-password-submit').disabled = true;
        $('#temp-password-done').hidden = false;
        toastOk('Temporary password set', email + ' must choose a new password at next sign-in.' +
            (res.data && res.data.sessionsRevoked === false ? ' (Their open sessions could not be ended.)' : ''));
        refreshAll();
    }

    async function copyTempPassword() {
        var value = $('#temp-password').value;
        if (!value) { return; }
        try {
            await navigator.clipboard.writeText(value);
            toastOk('Copied', 'Clear it from your clipboard once you have given it to the student.');
        } catch (err) {
            $('#temp-password').select();
            toastErr('Copy blocked', 'Select the password and copy it manually.');
        }
    }

    /* ---- Retakes ---- */

    async function allowRetakeOcean(email) {
        /* A retake no longer erases anything: the new submission is appended
           to ocean_submissions and becomes the current result, and the old
           one stays in the history. profiles holds no score to clear. */
        var ok = await confirmAction({
            title: 'Allow OCEAN retake',
            heading: 'Send ' + email + ' back to the questionnaire?',
            message: 'They can answer all 50 items again. Their current result stays in the ' +
                'results history, and the new submission becomes the current result once they finish.',
            confirmLabel: 'Allow retake'
        });
        if (!ok) { return; }

        var res = await sb.from('profiles').update({
            is_ocean_done: false,
            current_stage: 'OCEAN',
            stage_started_at: new Date().toISOString()
        }).eq('email', email);

        if (res.error) {
            toastErr('Could not allow retake', friendlyDbError(res.error, 'Update rejected.'));
            return;
        }

        toastOk('OCEAN retake enabled', email + ' can take the inventory again.');
        closeModal('drawer-student');
        refreshAll();
    }

    async function allowRetakeCharacter(email) {
        var ok = await confirmAction({
            title: 'Allow character re-selection',
            heading: 'Clear the chosen persona for ' + email + '?',
            message: 'Their selected agent is cleared and they return to the character ' +
                'selection stage.',
            confirmLabel: 'Clear selection'
        });
        if (!ok) { return; }

        var res = await sb.from('profiles').update({
            selected_character: null,
            current_stage: 'Character Selection',
            stage_started_at: new Date().toISOString()
        }).eq('email', email);

        if (res.error) {
            toastErr('Could not allow re-selection', friendlyDbError(res.error, 'Update rejected.'));
            return;
        }

        toastOk('Character re-selection enabled', email + ' can pick a persona again.');
        closeModal('drawer-student');
        refreshAll();
    }

    /* ---- Delete ---- */

    async function deleteStudent(email) {
        var ok = await confirmAction({
            title: 'Delete participant',
            heading: 'Permanently delete ' + email + '?',
            message: 'The profile, the auth user and every collected response for this ' +
                'participant are removed. This cannot be undone and will change your dataset.',
            confirmLabel: 'Delete permanently'
        });
        if (!ok) { return; }

        var res = await sb.rpc('admin_delete_user', { target_email: email });

        if (res.error) {
            toastErr('Deletion failed', friendlyDbError(res.error, 'The account was not deleted.'));
            return;
        }

        closeModal('drawer-student');
        toastOk('Participant deleted', email + ' was removed from the study.');
        refreshAll();
    }

    /* ---- Tutor persona (profiles.selected_character) ----------------------
       A separate field from the research group (profiles.group_type). An
       Assigned student is given a tutor by an admin; a Free choice student
       picks their own in Character Selection; Control has none. Nothing here
       assigns anyone automatically, and a group change never touches the
       tutor. 'pia-neutral' is a tutor like the others, not a group. The keys
       and names are the ones in student/html/character-selection.html. */
    var TUTORS = [
        { key: 'pia-open', name: 'PIA Open' },
        { key: 'pia-conscientious', name: 'PIA Structure' },
        { key: 'pia-extravert', name: 'PIA Dynamic' },
        { key: 'pia-agreeable', name: 'PIA Empath' },
        { key: 'pia-calm', name: 'PIA Stable' },
        { key: 'pia-neutral', name: 'PIA Neutral' }
    ];

    function tutorName(key) {
        var t = TUTORS.filter(function (x) { return x.key === key; })[0];
        return t ? t.name : (key || '');
    }

    function fillTutorSelect(select) {
        select.innerHTML = '';
        var none = document.createElement('option');
        none.value = '';
        none.textContent = 'Not assigned yet';
        select.appendChild(none);
        TUTORS.forEach(function (t) {
            var opt = document.createElement('option');
            opt.value = t.key;
            opt.textContent = t.name;
            select.appendChild(opt);
        });
    }

    /* What the drawer says about the tutor, by group. */
    function tutorLabel(s) {
        if (s.selected_character) { return tutorName(s.selected_character); }
        if (s.group_type === 'assigned') { return 'Not assigned yet'; }
        if (s.group_type === 'non-assigned') { return 'Not chosen yet'; }
        return '—';
    }

    /* Shows the tutor field for the group currently ticked. In Edit, a student
       who has a tutor but is no longer Assigned still sees it, read-only, so
       the admin can see that changing the group does not clear it. */
    function syncTutorField(prefix) {
        var group = ($('input[name="' + prefix + '-condition"]:checked') || {}).value;
        var select = $('#' + prefix + '-tutor');
        var held = select.getAttribute('data-initial') || '';
        var assigned = group === 'assigned';
        $('#' + prefix + '-tutor-field').hidden = !(assigned || held);
        select.disabled = !assigned;
        $('#' + prefix + '-tutor-hint').textContent = assigned
            ? 'Separate from the research group. Leave as "Not assigned yet" to decide later; saving does not choose one for you.'
            : 'Kept as it is. Only Assigned students are given a tutor here; changing the group does not clear this.';
    }

    function initTutorFields() {
        ['rs', 'es'].forEach(function (prefix) {
            fillTutorSelect($('#' + prefix + '-tutor'));
            $$('input[name="' + prefix + '-condition"]').forEach(function (radio) {
                radio.addEventListener('change', function () { syncTutorField(prefix); });
            });
            syncTutorField(prefix);
        });
        $('#register-student-form').addEventListener('reset', function () {
            setTimeout(function () { $('#rs-tutor').value = ''; syncTutorField('rs'); }, 0);
        });
    }

    /* '' = none; otherwise a known key, or an error message. */
    function readTutor(prefix) {
        var select = $('#' + prefix + '-tutor');
        var value = select.value;
        if (value && !TUTORS.some(function (t) { return t.key === value; })) { return { ok: false }; }
        return { ok: true, value: value };
    }

    /* ---- Register student ---- */

    async function handleRegisterStudent(event) {
        event.preventDefault();
        clearFormErrors('register-student-form');

        var first = $('#rs-first').value.trim();
        var middle = $('#rs-middle').value.trim();
        var last = $('#rs-last').value.trim();
        var email = normalizeEmail($('#rs-email').value);
        var section = $('#rs-section').value;
        var groupType = ($('input[name="rs-condition"]:checked') || {}).value;

        var valid = true;
        valid = setFieldError('rs-first', first ? '' : 'First name is required.') && valid;
        valid = setFieldError('rs-last', last ? '' : 'Last name is required.') && valid;
        valid = setFieldError('rs-email', isEmail(email) ? '' : 'Enter a valid school email address.') && valid;
        valid = setFieldError('rs-section', section ? '' : 'Create a section first.') && valid;
        /* Both are required, not just consent: nobody is registered without
           the parent's consent AND the student's own assent. The database
           refuses the row without both as well (migration 0037). */
        valid = setFieldError('rs-consent', $('#rs-consent').checked ? '' : 'Parental consent must be recorded first.') && valid;
        valid = setFieldError('rs-assent', $('#rs-assent').checked ? '' : 'Student assent must be recorded first.') && valid;
        var tutor = { ok: true, value: '' };
        if (groupType === 'assigned') {
            tutor = readTutor('rs');
            valid = setFieldError('rs-tutor', tutor.ok ? '' : 'Choose one of the listed tutors.') && valid;
        }
        if (!valid) { return; }

        var fullName = [first, middle, last].filter(Boolean).join(' ');
        var release = setBusy($('#rs-submit'), 'Registering…');

        try {
            /* Pre-check BEFORE creating the auth user. admin_create_auth_user
               runs first; if the profiles insert then fails (duplicate email,
               for instance) an auth user is left behind with no profile, and
               every later attempt fails with "user already exists" — that
               student can never be registered again. Checking first avoids the
               whole situation.

               It also names the consent columns, so a database without
               migration 0033 is caught here too, before anything is created. */
            var existing = await sb.from('profiles')
                .select('email' + CONSENT_COLUMNS).eq('email', email).maybeSingle();

            if (existing.error) {
                toastErr('Registration stopped', isMissingColumn(existing.error)
                    ? MIGRATION_MISSING
                    : friendlyDbError(existing.error, 'Could not check the roster for this email.'));
                return;
            }

            if (existing.data) {
                setFieldError('rs-email', 'This email is already on the roster.');
                toastErr('Duplicate email', email + ' already has an account.');
                return;
            }

            var authRes = await sb.rpc('admin_create_auth_user', {
                target_email: email,
                default_password: generateSecurePassword()
            });

            if (authRes.error) {
                toastErr('Auth user not created', friendlyDbError(authRes.error, 'Could not create the auth user.'));
                return;
            }

            var newRow = {
                full_name: fullName,
                email: email,
                section: section,
                group_type: groupType,
                parental_consent: true,
                student_assent: true,
                max_devices: 1,   /* one device per student; enforced by the database (0027, 0037) */
                status: 'inactive',
                role: 'student'
            };
            /* Only an explicit choice for an Assigned student is stored. */
            if (groupType === 'assigned' && tutor.value) { newRow.selected_character = tutor.value; }
            var insertRes = await sb.from('profiles').insert([newRow]);

            if (insertRes.error) {
                /* The auth user succeeded but the profile row failed. Say so
                   plainly — an orphan needs cleaning up before retrying. */
                showNotice('Registration incomplete',
                    friendlyDbError(insertRes.error, 'Could not save the profile.') +
                    '\n\nAn auth user was already created for ' + email +
                    '. It must be deleted before registering this student again.',
                    'danger');
                return;
            }

            closeModal('modal-register-student');
            $('#register-student-form').reset();
            clearFormErrors('register-student-form');

            toastOk('Student registered', fullName + ' is on the roster, inactive until they use the activation link.');
            refreshAll();
        } finally {
            release();
        }
    }

    /* ---- Edit student ---- */

    function openEditStudent(email) {
        var s = findStudent(email);
        if (!s) { return; }

        clearFormErrors('edit-student-form');

        var parts = (s.full_name || '').trim().split(/\s+/);
        var first = parts[0] || '', middle = '', last = '';
        if (parts.length === 2) { last = parts[1]; }
        else if (parts.length > 2) { last = parts[parts.length - 1]; middle = parts.slice(1, -1).join(' '); }

        $('#es-original-email').value = s.email;
        $('#es-first').value = first;
        $('#es-middle').value = middle;
        $('#es-last').value = last;
        $('#es-email').value = s.email;
        ['pre', 'post'].forEach(function (test) {
            fillScoreField('es-' + test + '-raw', s[test + '_test_raw_score']);
            fillScoreField('es-' + test + '-max', s[test + '_test_max_score']);
            /* A score entered before 0034 has no raw data; say so under the
               empty fields rather than pretending it is not there. */
            $('#es-' + test + '-result').setAttribute('data-legacy',
                s[test + '_test_score'] != null && s[test + '_test_raw_score'] == null ? formatScore(s[test + '_test_score']) : '');
            paintScorePreview(test);
        });
        fillConsentBox('es-consent', s.parental_consent);
        fillConsentBox('es-assent', s.student_assent);

        /* A section that was deleted from `sections` must still be selectable,
           otherwise saving would silently move the student. */
        var sectionSelect = $('#es-section');
        var known = $$('option', sectionSelect).some(function (opt) { return opt.value === s.section; });
        if (!known && s.section) {
            var opt = document.createElement('option');
            opt.value = s.section;
            opt.textContent = s.section + ' (not in sections list)';
            sectionSelect.appendChild(opt);
        }
        sectionSelect.value = s.section || '';

        /* "Neutral" is a retired condition (0038). Only a student who already has
           it sees it, selected, so saving cannot silently change them. */
        $('#es-neutral-choice').hidden = s.group_type !== 'neutral';
        var radio = $('input[name="es-condition"][value="' + (s.group_type || '') + '"]');
        if (radio) { radio.checked = true; }

        /* The tutor is its own field. An unrecognised stored value is kept
           visible rather than blanked, so saving cannot erase it by accident. */
        var tutorSelect = $('#es-tutor');
        fillTutorSelect(tutorSelect);
        if (s.selected_character && !TUTORS.some(function (t) { return t.key === s.selected_character; })) {
            var odd = document.createElement('option');
            odd.value = s.selected_character;
            odd.textContent = s.selected_character + ' (not in the tutor list)';
            tutorSelect.appendChild(odd);
        }
        tutorSelect.value = s.selected_character || '';
        tutorSelect.setAttribute('data-initial', s.selected_character || '');
        syncTutorField('es');

        openModal('modal-edit-student');
    }

    function fillScoreField(id, value) {
        var input = $('#' + id);
        input.value = value == null ? '' : value;
        input.setAttribute('data-initial', input.value);
    }

    /* The live transmuted score under a test's two fields. */
    function paintScorePreview(test) {
        var out = $('#es-' + test + '-result');
        var raw = $('#es-' + test + '-raw').value;
        var max = $('#es-' + test + '-max').value;
        var pair = readScorePair(raw, max);
        var legacy = out.getAttribute('data-legacy');

        out.classList.toggle('is-error', !pair.ok);
        if (!pair.ok) {
            out.textContent = pair.error;
        } else if (pair.score == null) {
            out.textContent = legacy ? 'Legacy score: ' + legacy : '';
        } else {
            out.innerHTML = 'Transmuted: <strong class="tnum">' + esc(formatScore(pair.score)) + '</strong>';
        }
        markScoreInvalid(test, false);
    }

    /* The preview line doubles as the error message; this marks the fields. */
    function markScoreInvalid(test, invalid) {
        $('#es-' + test + '-raw').classList.toggle('is-invalid', invalid);
        $('#es-' + test + '-max').classList.toggle('is-invalid', invalid);
    }

    /* null = registered before consent was stored (0033), shown as "not
       recorded". The box can only be ticked or not, so the save sends a
       value only when the admin changes the box: opening Edit to add a score
       must not turn "not recorded" into "not received". */
    function fillConsentBox(id, value) {
        var box = $('#' + id);
        box.checked = value === true;
        box.setAttribute('data-initial', box.checked ? 'true' : 'false');
        $('#' + id + '-note').textContent = value == null ? 'Not recorded' : '';
    }

    function consentChange(id) {
        var box = $('#' + id);
        var now = box.checked ? 'true' : 'false';
        return now === box.getAttribute('data-initial') ? undefined : box.checked;
    }

    async function handleUpdateStudent(event) {
        event.preventDefault();
        clearFormErrors('edit-student-form');

        var originalEmail = $('#es-original-email').value;
        var first = $('#es-first').value.trim();
        var middle = $('#es-middle').value.trim();
        var last = $('#es-last').value.trim();
        var section = $('#es-section').value;
        var groupType = ($('input[name="es-condition"]:checked') || {}).value;
        var pairs = {};

        var valid = true;
        valid = setFieldError('es-first', first ? '' : 'First name is required.') && valid;
        valid = setFieldError('es-last', last ? '' : 'Last name is required.') && valid;
        ['pre', 'post'].forEach(function (test) {
            pairs[test] = readScorePair($('#es-' + test + '-raw').value, $('#es-' + test + '-max').value);
            if (!pairs[test].ok) {
                paintScorePreview(test);
                markScoreInvalid(test, true);
                if (valid) { $('#es-' + test + '-raw').focus(); }
                valid = false;
            }
        });
        var tutorSel = $('#es-tutor');
        var tutorInitial = tutorSel.getAttribute('data-initial') || '';
        var tutorChosen = tutorSel.value;
        var tutorKnown = !tutorChosen || tutorChosen === tutorInitial || TUTORS.some(function (t) { return t.key === tutorChosen; });
        if (groupType === 'assigned') {
            valid = setFieldError('es-tutor', tutorKnown ? '' : 'Choose one of the listed tutors.') && valid;
        }
        if (!valid) { return; }

        var fullName = [first, middle, last].filter(Boolean).join(' ');
        var release = setBusy($('#es-submit'), 'Saving…');

        try {
            /* The email is never sent. It is read-only in the form, and this
               save does not read the field at all, so editing it in the
               browser's tools changes nothing. A participant's answers are
               keyed by email, with no foreign key: moving the address would
               strand everything they had already produced. (The function
               that used to change it, admin_update_user_email, does not
               exist in the database, so that path never worked either.) */
            var payload = {
                full_name: fullName,
                section: section
            };
            /* A legacy neutral student who is left as neutral is not re-sent:
               their assignment is not touched by an unrelated edit. */
            if (groupType !== 'neutral') { payload.group_type = groupType; }
            /* The tutor is written only when an Assigned student's tutor was
               actually changed in this dialog; otherwise it is left alone. */
            if (groupType === 'assigned' && tutorChosen !== tutorInitial) {
                payload.selected_character = tutorChosen || null;
            }
            /* Only a test whose fields changed is sent, and only its raw data:
               the database calculates the transmuted score. Untouched fields
               leave a score entered before 0034 as it was. */
            ['pre', 'post'].forEach(function (test) {
                var rawInput = $('#es-' + test + '-raw');
                var maxInput = $('#es-' + test + '-max');
                if (sameNumber(pairs[test].raw, rawInput.getAttribute('data-initial')) &&
                    sameNumber(pairs[test].max, maxInput.getAttribute('data-initial'))) { return; }
                payload[test + '_test_raw_score'] = pairs[test].raw;
                payload[test + '_test_max_score'] = pairs[test].max;
            });
            var consent = consentChange('es-consent');
            var assent = consentChange('es-assent');
            if (consent !== undefined) { payload.parental_consent = consent; }
            if (assent !== undefined) { payload.student_assent = assent; }

            var updateRes = await sb.from('profiles').update(payload).eq('email', originalEmail);

            if (updateRes.error) {
                var updateMsg = isMissingColumn(updateRes.error)
                    ? MIGRATION_MISSING
                    : friendlyDbError(updateRes.error, 'Could not update the profile.');
                toastErr('Update failed', updateMsg);
                if ('selected_character' in payload) { setFieldError('es-tutor', 'The tutor was not saved: ' + updateMsg); }
                return;
            }

            closeModal('modal-edit-student');
            toastOk('Participant updated', fullName + ' was saved.');
            refreshAll();
        } finally {
            release();
        }
    }

    /* ================================================== 9. FACULTY ====== */

    function renderFaculty(term) {
        var needle = sanitizeFilterTerm(term).toLowerCase();
        var rows = state.faculty.filter(function (f) {
            if (!needle) { return true; }
            return ((f.name || '') + ' ' + (f.email || '') + ' ' + (f.department || ''))
                .toLowerCase().indexOf(needle) !== -1;
        });

        $('#faculty-empty').classList.toggle('is-hidden', rows.length !== 0);

        /* The whole row opens the profile dialog, which holds the reset,
           sign-out and remove actions; there are no buttons in the row. With
           them gone the row is the only control, so it takes focus itself
           (see initFaculty) — otherwise a keyboard could not reach any of it. */
        $('#faculty-tbody').innerHTML = rows.map(function (f) {
            var active = (f.status || '') === 'active';
            return '' +
                '<tr class="is-clickable" tabindex="0" data-faculty="' + esc(f.email) + '"' +
                ' aria-label="Open profile: ' + esc(f.name || f.email) + '">' +
                '<td>' + userCell({ full_name: f.name, email: f.email }) + '</td>' +
                '<td class="muted">' + esc(f.department || '—') + '</td>' +
                '<td><span class="badge">' + esc(f.assigned_section || 'Unassigned') + '</span></td>' +
                '<td><span class="badge ' + (active ? 'badge-accent' : '') + '">' +
                (active ? 'Active' : 'Inactive') + '</span></td>' +
                '</tr>';
        }).join('');
    }

    function initFaculty() {
        $('#faculty-search').addEventListener('input', debounce(function (event) {
            renderFaculty(event.target.value);
        }, 200));

        $('#faculty-tbody').addEventListener('click', function (event) {
            var row = event.target.closest('[data-faculty]');
            if (row) { openFacultyProfile(row.getAttribute('data-faculty'), row); }
        });

        $('#faculty-tbody').addEventListener('keydown', function (event) {
            if (event.key !== 'Enter' && event.key !== ' ') { return; }
            var row = event.target.closest('[data-faculty]');
            if (!row || event.target !== row) { return; }
            event.preventDefault();
            openFacultyProfile(row.getAttribute('data-faculty'), row);
        });

        $('#faculty-reset').addEventListener('click', function () {
            if (state.activeFaculty) { resetFacultyPassword(state.activeFaculty.email, this); }
        });

        $('#faculty-signout').addEventListener('click', function () {
            if (state.activeFaculty) { signOutFacultyEverywhere(state.activeFaculty.email, this); }
        });

        $('#faculty-delete').addEventListener('click', function () {
            if (state.activeFaculty) {
                closeModal('modal-faculty');
                deleteFaculty(state.activeFaculty.email);
            }
        });
    }

    function setFacultyStatus(text, tone) {
        var node = $('#faculty-status-msg');
        node.textContent = text;
        node.className = 'form-status' + (tone ? ' is-' + tone : '');
    }

    /* The secure email-link route only: Supabase emails the professor a reset
       link and they choose their own password. No password is set or shown
       here, and nothing is said to have happened until the service answers. */
    async function resetFacultyPassword(email, sourceBtn) {
        var ok = await confirmAction({
            title: 'Reset password',
            heading: 'Send a reset link to ' + email + '?',
            message: 'They will choose their own new password through the emailed link. ' +
                'No password is set or revealed here.',
            confirmLabel: 'Send reset email',
            tone: 'accent'
        });
        if (!ok) { return; }

        var release = setBusy(sourceBtn, 'Sending…');
        setFacultyStatus('Sending the reset email…', '');
        var res;
        try { res = await sb.auth.resetPasswordForEmail(email, { redirectTo: activationRedirect() }); }
        catch (err) { res = { error: { message: (err && err.message) || 'The request did not complete.' } }; }
        release();

        /* The modal may have moved on to another professor meanwhile. */
        if (!state.activeFaculty || state.activeFaculty.email !== email) { return; }
        if (res.error) {
            setFacultyStatus('The reset email was not sent: ' + authFailureText(res.error, ''), 'error');
            return;
        }
        setFacultyStatus('The service accepted the request. ' + email + ' can use the link in the email to choose a new password.', 'ok');
    }

    function openFacultyProfile(email, trigger) {
        var f = state.faculty.filter(function (row) { return row.email === email; })[0];
        if (!f) { return; }

        state.activeFaculty = f;
        $('#faculty-title').textContent = f.name || 'Faculty profile';
        $('#faculty-subject').textContent = f.email;
        $('#faculty-dept').textContent = f.department || '—';
        $('#faculty-section').textContent = f.assigned_section || 'Unassigned';
        $('#faculty-status').textContent = (f.status || '') === 'active' ? 'Active' : 'Inactive';
        $('#faculty-devices').textContent = '…';
        setFacultyStatus('', '');

        openModal('modal-faculty', trigger);
        loadFacultyDevices(f.email);
    }

    /* professors has no device columns; the account's profile does. */
    async function loadFacultyDevices(email) {
        var res = await sb.from('profiles').select('active_devices, max_devices').eq('email', email).maybeSingle();
        if (!state.activeFaculty || state.activeFaculty.email !== email) { return; }
        $('#faculty-devices').textContent = (res.error || !res.data)
            ? '—'
            : (res.data.active_devices || []).length + ' of ' + toInt(res.data.max_devices, 1) + ' in use';
    }

    /* The students' "Sign out everywhere", for a professor: every session
       ends and every device slot is freed (admin_revoke_sessions, which since
       migration 0021 also deletes their refresh tokens). */
    async function signOutFacultyEverywhere(email, sourceBtn) {
        var ok = await confirmAction({
            title: 'Sign out everywhere',
            heading: 'Sign ' + email + ' out everywhere?',
            message: 'Every session for this account ends immediately and each of their devices is ' +
                'freed. They sign in again with their password.',
            confirmLabel: 'Sign out everywhere'
        });
        if (!ok) { return; }

        var release = setBusy(sourceBtn, 'Signing out…');
        var res = await sb.rpc('admin_revoke_sessions', { p_email: email });
        release();

        if (res.error) {
            toastErr('Sign-out failed', friendlyDbError(res.error, 'Their sessions were not ended.'));
            return;
        }

        toastOk('Signed out everywhere', email + ' was signed out of every device.');
        if (state.activeFaculty && state.activeFaculty.email === email) { loadFacultyDevices(email); }
    }

    async function handleRegisterProfessor(event) {
        event.preventDefault();
        clearFormErrors('add-professor-form');

        var name = $('#ap-name').value.trim();
        var email = normalizeEmail($('#ap-email').value);
        var department = $('#ap-dept').value.trim();
        var assignedSection = $('#ap-section').value;

        var valid = true;
        valid = setFieldError('ap-name', name ? '' : 'Full name is required.') && valid;
        valid = setFieldError('ap-email', isEmail(email) ? '' : 'Enter a valid email address.') && valid;
        valid = setFieldError('ap-dept', department ? '' : 'Department is required.') && valid;
        if (!valid) { return; }

        var release = setBusy($('#ap-submit'), 'Registering…');

        try {
            /* Same reasoning as student registration: check first, because
               profiles carries UNIQUE(email) and a late failure would strand
               an auth user that can never be registered again. */
            var existing = await sb.from('profiles').select('email').eq('email', email).maybeSingle();

            if (existing.data) {
                setFieldError('ap-email', 'This email already belongs to another account.');
                toastErr('Duplicate email', email + ' is already in use.');
                return;
            }

            var authRes = await sb.rpc('admin_create_auth_user', {
                target_email: email,
                default_password: generateSecurePassword()
            });

            if (authRes.error) {
                toastErr('Auth user not created', friendlyDbError(authRes.error, 'Could not create the auth user.'));
                return;
            }

            /* One RPC writes BOTH the professors row and the profiles row with
               role='teacher' in a single transaction. Login and the teacher
               guard both look for the profiles row, so writing only the
               professors table would create a teacher who can never sign in. */
            var regRes = await sb.rpc('admin_register_teacher', {
                p_email: email,
                p_name: name,
                p_department: department,
                p_assigned_section: assignedSection
            });

            if (regRes.error) {
                showNotice('Registration incomplete',
                    friendlyDbError(regRes.error, 'Could not save the teacher.') +
                    '\n\nAn auth user was already created for ' + email +
                    '. It must be deleted before registering this professor again.',
                    'danger');
                return;
            }

            closeModal('modal-add-professor');
            $('#add-professor-form').reset();
            clearFormErrors('add-professor-form');

            toastOk('Professor added', name + ' now has observer access.');
            await loadFaculty();
            renderSections();
        } finally {
            release();
        }
    }

    async function deleteFaculty(email) {
        var ok = await confirmAction({
            title: 'Remove faculty',
            heading: 'Permanently delete ' + email + '?',
            message: 'The auth user, the faculty record and the linked profile are all removed. ' +
                'Student data is not affected.',
            confirmLabel: 'Remove faculty'
        });
        if (!ok) { return; }

        var res = await sb.rpc('admin_delete_user', { target_email: email });

        if (res.error) {
            toastErr('Removal failed', friendlyDbError(res.error, 'The account was not deleted.'));
            return;
        }

        toastOk('Faculty removed', email + ' no longer has access.');
        await loadFaculty();
        renderSections();
    }

    /* ============================= 10. STAGE CONTROLS AND TARGETING ===== */

    /* Access is by section. A stage card lists the sections; ticking some and
       pressing "Grant access" runs admin_grant_stage once per section, which
       moves that section's eligible students into the stage now and records
       the section in stage_overrides (0033). A section can be granted again
       to let in students who became eligible later.

       "Revoke access" is the other half, and it is just as targeted: it runs
       admin_revoke_stage (migration 0036) for the ticked sections that are
       open, and for no others. Their students go back to the Waiting Room;
       nothing they have submitted is touched, and a student part-way through
       a test or lesson may finish it (function.js 1C-5c). There is no switch
       that opens a stage for everyone; a stage a previous version left
       globally open (gate.open) shows as open for all sections, and Revoke
       access then closes it for all of them (there is nothing per-section to
       revoke). After a successful Grant or Revoke every tick is cleared, so a
       second press cannot repeat the action on the same sections. */

    /* What the SERVER lets each group enter, from pia_can_enter_stage as
       replaced by migration 0038: OCEAN until it is submitted; Character
       Selection only for the free-choice group (non-assigned) until a tutor is
       chosen; the Tutoring Dashboard for everyone with OCEAN done except
       Control (OCEAN only) and a free-choice student who has not chosen yet.
       Neutral is a tutor persona, not a group: free-choice students can pick
       it, assigned students can be given it. Records still carrying the old
       "neutral" group behave as Assigned. Nothing on this page edits the rule,
       and a stage closed to a section stays closed whatever a group's rule
       says. */
    var GROUP_POLICY = [
        { label: 'Control', ocean: 'Available', char: 'Locked', dash: 'Locked' },
        { label: 'Experimental · Assigned', ocean: 'Available', char: 'Locked', dash: 'Available' },
        { label: 'Experimental · Free choice', ocean: 'Available', char: 'Available', dash: 'Available after choosing a tutor' },
        { label: 'Neutral (legacy records)', ocean: 'Available', char: 'Locked', dash: 'Available' }
    ];

    function renderPolicy() {
        var cell = function (text) {
            return '<td><span class="' + (text === 'Locked' ? 'policy-no' : 'policy-yes') + '">' + esc(text) + '</span></td>';
        };
        $('#policy-tbody').innerHTML = GROUP_POLICY.map(function (g) {
            return '<tr><th scope="row" class="policy-group">' + esc(g.label) + '</th>' +
                cell(g.ocean) + cell(g.char) + cell(g.dash) + '</tr>';
        }).join('');
        $('#policy-foot').textContent = 'Shown from the server’s stage rule (migration 0038). Neutral is a tutor persona, not a group: free-choice students can pick it and assigned students can be given it; records still marked Neutral behave as Assigned. This page cannot change which stages a group can enter; it opens or closes a stage for whole sections below.';
    }

    var GATE_ACCESS_TIP = 'Granting moves a section’s eligible students in right away. Grant a section ' +
        'again to let in students who finished the previous stage later. Revoke access ends access for ' +
        'the ticked sections only; nothing already submitted is affected.';

    function gateByKey(key) {
        return GATES.filter(function (g) { return g.key === key; })[0];
    }

    /* Who can enter a CLOSED stage, from two sources:
         sections  the section grants recorded by admin_grant_stage (0033),
                   each with how many of its students are in the stage now;
         others    every other student in the stage — an individual grant
                   from before this page dropped them, an admin reset, or a
                   grant made before 0033 was applied.
       Returns null while either source is still loading, and for an open
       stage, where nobody needs one. */
    function gateAccess(gate) {
        if (gate.open || state.overrides === undefined || !state.cohortLoaded) { return null; }

        var inStage = state.cohort.filter(function (s) { return s.current_stage === gate.label; });
        var named = {};
        var sections = (state.overrides || []).filter(function (o) { return o.stage === gate.key; })
            .map(function (o) {
                named[o.section] = true;
                return {
                    section: o.section,
                    inStage: inStage.filter(function (s) { return s.section === o.section; }).length,
                    granted: o.granted_count,
                    by: o.granted_by,
                    at: o.granted_at
                };
            });
        var others = inStage.filter(function (s) { return !named[s.section]; });

        return { sections: sections, others: others };
    }

    function sectionOpen(gate, name) {
        if (gate.open) { return true; }
        return Array.isArray(state.overrides) && state.overrides.some(function (o) {
            return o.stage === gate.key && o.section === name;
        });
    }

    /* The badge on a card and on the Overview: closed, some sections, or (a
       stage left globally open) all of them. */
    function gateStatus(gate) {
        if (gate.open) { return { text: 'Open · all sections', tone: 'badge-accent' }; }
        var n = Array.isArray(state.overrides)
            ? state.overrides.filter(function (o) { return o.stage === gate.key; }).length : 0;
        if (n) { return { text: n + (n === 1 ? ' section open' : ' sections open'), tone: 'badge-accent' }; }
        return { text: 'Closed', tone: '' };
    }

    function renderGates() {
        $('#gates-grid').innerHTML = GATES.map(function (gate) {
            return '' +
                '<article class="gate">' +
                '<div class="gate-body">' +
                '<div class="gate-top">' +
                '<span class="badge">' + esc(gate.stage) + '</span>' +
                '<span class="badge" data-gate-status="' + gate.key + '"></span>' +
                '</div>' +
                '<h3 class="gate-title">' + esc(gate.title) + '</h3>' +
                '<div class="gate-access" data-gate-access="' + gate.key + '"></div>' +
                '</div>' +
                '<div class="gate-foot">' +
                '<button class="btn btn-primary btn-sm" type="button" data-gate-grant="' + gate.key + '">Grant access</button>' +
                '<button class="btn btn-danger-soft btn-sm" type="button" data-gate-revoke="' + gate.key + '">Revoke access</button>' +
                '</div>' +
                '</article>';
        }).join('');

        renderGateAccess();
    }

    function paintGateStatus(gate) {
        var label = $('[data-gate-status="' + gate.key + '"]');
        if (!label) { return; }
        var status = gateStatus(gate);
        label.textContent = status.text;
        label.className = 'badge ' + status.tone;
    }

    function gateAccessHtml(gate) {
        var head = function (action) {
            return '<div class="gate-access-head"><div class="with-tip">' +
                '<p class="gate-access-label">Sections</p>' + infoTip(GATE_ACCESS_TIP, 'section access') +
                '</div>' + (action || '') + '</div>';
        };

        if (!state.sectionsLoaded || state.overrides === undefined) {
            return head() + '<span class="skeleton-text gate-access-skeleton" aria-hidden="true"></span>';
        }
        if (!state.sections.length) {
            return head() + '<p class="gate-access-note">No sections yet. Create one under Class Sections.</p>';
        }

        var selected = state.gateSelected[gate.key];
        var allTicked = !gate.open && selected.length === state.sections.length;
        var html = head(gate.open ? '' :
            '<button type="button" class="btn btn-ghost btn-sm" data-gate-all="' + gate.key + '">' +
            (allTicked ? 'Clear' : 'Select all') + '</button>');

        html += '<div class="gate-sections" role="group" aria-label="Sections for ' + esc(gate.title) + '">' +
            state.sections.map(function (section) {
                var members = state.cohort.filter(function (s) { return s.section === section.name; });
                var open = sectionOpen(gate, section.name);
                var inside = members.filter(function (s) { return s.current_stage === gate.label; }).length;
                var detail = state.cohortLoaded
                    ? members.length + (members.length === 1 ? ' student' : ' students') +
                      (open && !gate.open ? ' · ' + inside + ' in stage' : '')
                    : '';
                return '' +
                    '<label class="check gate-section">' +
                    '<input type="checkbox" data-gate-section="' + gate.key + '" value="' + esc(section.name) + '"' +
                    (selected.indexOf(section.name) !== -1 ? ' checked' : '') + (gate.open ? ' disabled' : '') + '>' +
                    '<span class="check-box">' + icon('check') + '</span>' +
                    '<span class="check-text">' + esc(section.name) + '<small>' + esc(detail) + '</small></span>' +
                    (open ? '<span class="badge badge-accent">Open</span>' : '') +
                    '</label>';
            }).join('') + '</div>';

        if (state.overrides === null) {
            html += '<p class="gate-access-note">' + (state.overridesMissing
                ? 'Which sections are open needs migration 0033.'
                : 'Couldn’t load which sections are open. Refresh to retry.') + '</p>';
        }

        var access = gateAccess(gate);
        if (access && access.others.length) {
            var names = access.others.slice(0, 12).map(function (s) {
                return (s.full_name || s.email) + (s.section ? ' (' + s.section + ')' : '');
            }).join('\n') + (access.others.length > 12 ? '\n…and ' + (access.others.length - 12) + ' more' : '');
            html += '<p class="gate-access-note" title="' + esc(names) + '">Also inside: ' +
                access.others.length + ' student' + (access.others.length === 1 ? '' : 's') +
                ' let in one by one</p>';
        }

        return html;
    }

    /* The buttons follow what is ticked and what is open. Grant acts on the
       ticked sections; Revoke on the ticked sections that are open. */
    function tickedOpen(gate) {
        return state.gateSelected[gate.key].filter(function (name) { return sectionOpen(gate, name); });
    }

    function paintGateFoot(gate) {
        var grant = $('[data-gate-grant="' + gate.key + '"]');
        var revoke = $('[data-gate-revoke="' + gate.key + '"]');
        if (!grant || !revoke) { return; }

        var n = state.gateSelected[gate.key].length;
        grant.textContent = n ? 'Grant access · ' + n : 'Grant access';
        grant.disabled = gate.open || n === 0;

        var open = tickedOpen(gate).length;
        revoke.textContent = open ? 'Revoke access · ' + open : 'Revoke access';
        revoke.disabled = !(gate.open || open);
    }

    /* Repaints the section lists, badges and buttons, and the Overview's
       summary, from current state. Called on every data refresh. */
    function renderGateAccess() {
        GATES.forEach(function (gate) {
            /* A section that was deleted since it was ticked is dropped. */
            state.gateSelected[gate.key] = state.gateSelected[gate.key].filter(function (name) {
                return state.sections.some(function (s) { return s.name === name; });
            });
            var box = $('[data-gate-access="' + gate.key + '"]');
            if (box) { box.innerHTML = gateAccessHtml(gate); }
            paintGateStatus(gate);
            paintGateFoot(gate);
        });
    }

    function initGates() {
        var grid = $('#gates-grid');

        grid.addEventListener('change', function (event) {
            var box = event.target.closest('[data-gate-section]');
            if (!box) { return; }
            var gate = gateByKey(box.getAttribute('data-gate-section'));
            var list = state.gateSelected[gate.key];
            var at = list.indexOf(box.value);
            if (box.checked && at === -1) { list.push(box.value); }
            if (!box.checked && at !== -1) { list.splice(at, 1); }
            /* Only the toggle's label and the buttons change; the list stays. */
            var all = $('[data-gate-all="' + gate.key + '"]');
            if (all) { all.textContent = list.length === state.sections.length ? 'Clear' : 'Select all'; }
            paintGateFoot(gate);
        });

        grid.addEventListener('click', function (event) {
            var all = event.target.closest('[data-gate-all]');
            if (all) {
                var gate = gateByKey(all.getAttribute('data-gate-all'));
                var every = state.gateSelected[gate.key].length === state.sections.length;
                state.gateSelected[gate.key] = every ? [] : state.sections.map(function (s) { return s.name; });
                renderGateAccess();
                return;
            }

            var grant = event.target.closest('[data-gate-grant]');
            if (grant) { grantSections(grant.getAttribute('data-gate-grant'), grant); return; }

            var revoke = event.target.closest('[data-gate-revoke]');
            if (revoke) { revokeSections(revoke.getAttribute('data-gate-revoke'), revoke); }
        });
    }

    /* admin_grant_stage resets the correct prerequisite flag per stage and
       reports who it could not grant (an unfinished OCEAN test, for example)
       instead of silently rewriting their data. Writing current_stage alone
       would be undone immediately: the route guard sends the student back to
       the Waiting Room, which overwrites current_stage again. One call per
       section, one after another, so a failure names its section. */
    async function grantSections(gateKey, sourceBtn) {
        var gate = gateByKey(gateKey);
        var names = state.gateSelected[gateKey].slice();
        if (!names.length) { return; }

        var release = setBusy(sourceBtn, 'Granting…');
        var granted = [];
        var skipped = [];
        var failed = [];

        for (var i = 0; i < names.length; i++) {
            var res = await sb.rpc('admin_grant_stage', { p_stage: gateKey, p_emails: null, p_section: names[i] });
            if (res.error) {
                failed.push({ section: names[i], message: res.error.message });
                continue;
            }
            granted = granted.concat((res.data && res.data.granted) || []);
            skipped = skipped.concat((res.data && res.data.skipped) || []);
        }
        release();

        /* Every section that went through is unticked -- all of them, when
           all did -- so the next press cannot repeat this on the same
           sections. A section that failed stays ticked to be retried. */
        state.gateSelected[gateKey] = names.filter(function (name) {
            return failed.some(function (f) { return f.section === name; });
        });
        await refreshAll();

        if (!skipped.length && !failed.length) {
            if (granted.length) {
                toastOk('Access granted',
                    granted.length + ' student' + (granted.length === 1 ? '' : 's') + ' moved to ' + gate.title +
                    ' from ' + names.join(', ') + '.');
            } else {
                toastOk('Nobody new to let in', 'Everyone eligible in ' + names.join(', ') + ' is already in ' + gate.title + '.');
            }
            return;
        }

        var lines = skipped.slice(0, 8).map(function (item) {
            return '• ' + item.email + ' — ' + item.reason;
        }).join('\n');
        var more = skipped.length > 8 ? '\n…and ' + (skipped.length - 8) + ' more.' : '';
        var errors = failed.map(function (f) { return '• ' + f.section + ' — ' + f.message; }).join('\n');

        showNotice(
            granted.length ? 'Partially granted' : 'Nothing granted',
            'Granted: ' + granted.length + '\nSkipped: ' + skipped.length +
            (skipped.length ? '\n\n' + lines + more : '') +
            (failed.length ? '\n\nSections that failed:\n' + errors : ''),
            granted.length ? 'accent' : 'danger'
        );
    }

    /* Revoke: the ticked sections that are open, and no others. The database
       (admin_revoke_stage) removes their records and returns their students
       to the Waiting Room -- and changes nothing else. A stage left globally
       open by the old switch has no per-section access to remove, so there
       it closes the stage for everyone (admin_set_stage_open), which also
       returns those inside to the Waiting Room. Neither touches a submitted
       answer, a score or a tutoring result. */
    async function revokeSections(gateKey, sourceBtn) {
        var gate = gateByKey(gateKey);
        var everyone = gate.open;
        var names = everyone ? [] : tickedOpen(gate);
        if (!everyone && !names.length) { return; }

        var inside = state.cohort.filter(function (s) {
            return s.current_stage === gate.label && (everyone || names.indexOf(s.section) !== -1);
        }).length;

        var ok = await confirmAction({
            title: 'Revoke access',
            heading: everyone
                ? 'Close ' + gate.title + ' for every section?'
                : 'Revoke ' + gate.title + ' for ' + names.join(', ') + '?',
            message: (inside
                ? inside + ' student' + (inside === 1 ? ' is' : 's are') + ' inside now and will return to the ' +
                  'Waiting Room. Anyone part-way through can still finish and submit what they started. '
                : 'Nobody is inside right now. ') +
                'Nothing already submitted is changed or removed.' +
                (everyone ? '' : ' Other sections keep their access.'),
            confirmLabel: 'Revoke access'
        });
        if (!ok) { return; }

        var release = setBusy(sourceBtn, 'Revoking…');
        var res = everyone
            ? await sb.rpc('admin_set_stage_open', { p_stage: gateKey, p_open: false })
            : await sb.rpc('admin_revoke_stage', { p_stage: gateKey, p_sections: names });
        release();

        if (res.error) {
            toastErr('Access not revoked', res.error.code === 'PGRST202' || res.error.code === '42883'
                ? 'The database is missing migration 0036 (admin_revoke_stage). Apply it, then try again.'
                : friendlyDbError(res.error, 'The request did not complete.'));
            return;
        }

        gate.open = false;
        /* Show what the server just did rather than waiting for the refresh. */
        if (Array.isArray(state.overrides)) {
            state.overrides = state.overrides.filter(function (o) {
                return o.stage !== gateKey || (!everyone && names.indexOf(o.section) === -1);
            });
        }
        state.cohort.forEach(function (s) {
            if (s.current_stage === gate.label && (everyone || names.indexOf(s.section) !== -1)) {
                s.current_stage = 'Waiting Room';
            }
        });
        state.gateSelected[gateKey] = [];
        renderGateAccess();

        var moved = (res.data && (res.data.moved != null ? res.data.moved : res.data.evicted)) || 0;
        toastOk(gate.title + ' revoked',
            (everyone ? 'For every section. ' : names.join(', ') + '. ') +
            (moved ? moved + ' student' + (moved === 1 ? '' : 's') + ' returned to the Waiting Room.' : 'Nobody was inside.'));

        refreshAll();
    }

    /* ============= 11. PROFILE (PASSWORD, SESSIONS) AND SETTINGS (ADMINS) === */

    /* ---- Change password ----
       Supabase's updateUser() never asks for the current password, so on its
       own a form would let anyone at an unlocked laptop set a new one. The
       current password is therefore checked against Supabase Auth first, on a
       second client that keeps nothing (no storage, no refresh): signing in
       there cannot replace this console's session or touch its device
       record, and the proof is a fresh login. That same fresh session makes
       the update, which also keeps it valid where the project asks for a
       recent sign-in before a password change. Afterwards the probe signs
       itself out and this account's OTHER sessions are ended -- a password
       change that leaves an old login working would not be much of one. */

    function passwordProblem(next, current) {
        var problem = tempPasswordProblem(next);
        if (problem) { return problem; }
        if (next === current) { return 'Choose a password different from your current one.'; }
        return '';
    }

    function authFailureText(error, wrongPasswordText) {
        var msg = (error && error.message) || '';
        if ((error && error.status === 429) || /rate limit|too many|security purposes/i.test(msg)) {
            return 'Too many attempts. Wait a few minutes, then try again.';
        }
        if ((error && error.status === 400) || /invalid login credentials/i.test(msg)) { return wrongPasswordText; }
        return msg || 'The request did not complete.';
    }

    async function handleChangePassword(event) {
        event.preventDefault();
        clearFormErrors('change-password-form');

        var current = $('#cp-current').value;
        var next = $('#cp-new').value;
        var confirm = $('#cp-confirm').value;

        var valid = true;
        valid = setFieldError('cp-current', current ? '' : 'Enter your current password.') && valid;
        valid = setFieldError('cp-new', passwordProblem(next, current)) && valid;
        valid = setFieldError('cp-confirm', confirm === next ? '' : 'The passwords do not match.') && valid;
        if (!valid) { return; }

        var release = setBusy($('#cp-submit'), 'Updating…');
        var probe = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY, {
            auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'pia-password-check' }
        });

        try {
            var proof;
            try { proof = await probe.auth.signInWithPassword({ email: state.adminEmail, password: current }); }
            catch (err) { proof = { error: { message: (err && err.message) || 'The request did not complete.' } }; }

            if (proof.error) {
                setFieldError('cp-current', authFailureText(proof.error, 'That is not your current password.'));
                return;
            }

            var update = await probe.auth.updateUser({ password: next });
            if (update.error) {
                setFieldError('cp-new', authFailureText(update.error, 'The password was not accepted.'));
                toastErr('Password not changed', update.error.message);
                return;
            }

            /* Done with the probe's login; end it so it does not linger. */
            try { await probe.auth.signOut({ scope: 'local' }); } catch (err) { /* it expires by itself */ }

            var others = null;
            try { others = await sb.auth.signOut({ scope: 'others' }); }
            catch (err) { others = { error: err }; }

            $('#change-password-form').reset();
            setPasswordsShown(false);
            closeModal('modal-change-password');

            if (others && others.error) {
                toastOk('Password updated', 'Your other devices could not be signed out. Revoke them under Active sessions.');
            } else {
                toastOk('Password updated', 'Your other devices were signed out. This one stays signed in.');
            }
            loadAdminDevices().catch(function () { /* the list shows its own error */ });
        } finally {
            release();
        }
    }

    /* One checkbox for all three fields; reset to hidden after a save, so the
       next person at the keyboard does not find them showing. */
    function setPasswordsShown(shown) {
        $('#cp-show').checked = shown;
        ['cp-current', 'cp-new', 'cp-confirm'].forEach(function (id) {
            $('#' + id).type = shown ? 'text' : 'password';
        });
    }

    function initChangePassword() {
        $('#change-password-form').addEventListener('submit', handleChangePassword);
        $('#cp-show').addEventListener('change', function () { setPasswordsShown(this.checked); });
        ['cp-current', 'cp-new', 'cp-confirm'].forEach(function (id) {
            $('#' + id).addEventListener('input', function () { setFieldError(id, ''); });
        });
    }

    /* ---- Device registration diagnostics ----
       A failure here used to end in one console.error and a list that said
       "No registered devices", which reads as "nothing is wrong". Now every
       way this can go wrong is logged with the details needed to tell them
       apart, kept in window.PIA_DEVICE_DIAG (paste it into a bug report), and
       shown in the Signed-in devices card with a retry. */

    function errorFields(err) {
        if (!err) { return {}; }
        return {
            code: err.code || null,
            message: err.message || String(err),
            details: err.details || null,
            hint: err.hint || null,
            status: err.status || null
        };
    }

    function deviceProblem(stage, fields) {
        var record = Object.assign({
            stage: stage,
            at: new Date().toISOString(),
            adminEmail: state.adminEmail,
            online: navigator.onLine,
            page: window.location.pathname
        }, fields);

        console.error('[PIA device] ' + stage + ' failed', record);
        state.deviceDiag.push(record);
        if (state.deviceDiag.length > 20) { state.deviceDiag.shift(); }
        window.PIA_DEVICE_DIAG = state.deviceDiag;
        return record;
    }

    function claimFailureText(fields) {
        var code = fields.code ? ' (' + fields.code + ')' : '';
        if (fields.code === '42501') {
            return 'The server refused the request' + code + ': ' + fields.message;
        }
        if (fields.code === 'PGRST202' || fields.code === '42883') {
            return 'The claim_device function was not found' + code + '. Apply the latest database migrations.';
        }
        return 'claim_device failed' + code + ': ' + (fields.message || 'no reason given') +
            ' Details are in the browser console; search for “[PIA device]”.';
    }

    /* Reads the limit, then registers this browser through claim_device.
       claim_device uses SELECT … FOR UPDATE and enforces the limit server-side,
       so the rule lives in one place instead of two copies that can disagree
       -- and two racing sign-ins cannot both take the last slot. */
    async function loadAdminDevices() {
        var res = await sb.from('profiles')
            .select('active_devices')
            .eq('email', state.adminEmail)
            .maybeSingle();

        if (res.error || !res.data) {
            deviceProblem('read-profile', Object.assign({ rowFound: !!res.data }, errorFields(res.error)));
            renderAdminDevices([], {
                title: 'Could not load your devices',
                message: friendlyDbError(res.error, 'No profile row was found for this account.')
            });
            return;
        }

        var devices = res.data.active_devices || [];

        /* Storage can be blocked (a private window, a strict browser setting);
           without it there is no device ID to register. */
        var deviceId = null;
        try { deviceId = getOrCreateDeviceId(); }
        catch (err) {
            deviceProblem('device-id', { message: err && err.message });
            renderAdminDevices(devices, {
                title: 'This browser can’t be registered',
                message: 'It is blocking local storage (a private window, or storage switched off), ' +
                    'so it has no device ID to register.'
            });
            return;
        }

        /* Claimed on every load, not only when this browser is missing from
           the list: the claim is also where the server forgets devices whose
           login has ended (migration 0032), which keeps this list to the
           browsers that can actually still use the account. */
        var claim;
        try { claim = await sb.rpc('claim_device', { p_device_id: deviceId }); }
        catch (err) { claim = { error: { message: (err && err.message) || 'The request did not complete.' } }; }

        if (claim.error) {
            var fields = errorFields(claim.error);
            deviceProblem('claim_device', Object.assign({ deviceId: deviceId, listedBefore: devices }, fields));
            renderAdminDevices(devices, { title: 'This browser was not registered', message: claimFailureText(fields) });
            toastErr('This browser was not registered', 'claim_device failed' +
                (fields.code ? ' (' + fields.code + ')' : '') + '. Details are in the Signed-in devices card.');
            return;
        }

        if (claim.data && claim.data.allowed === false) {
            renderAdminDevices(claim.data.devices || devices);
            showDeviceLimitModal(claim.data.devices || devices);
            return;
        }

        if (!claim.data || !Array.isArray(claim.data.devices)) {
            deviceProblem('claim_device-response', { deviceId: deviceId, response: claim.data });
            toastErr('This browser was not registered', 'claim_device gave no usable answer. Details are in the Signed-in devices card.');
            renderAdminDevices(devices, {
                title: 'This browser was not registered',
                message: 'claim_device answered without a device list, so the registration cannot be confirmed. ' +
                    'Details are in the browser console.'
            });
            return;
        }

        /* The server says this browser is registered. Read the list back
           before believing it: "accepted, but not in the list" is exactly the
           silent failure this page used to show as an empty list. */
        var verify = await sb.from('profiles').select('active_devices').eq('email', state.adminEmail).maybeSingle();
        var stored = verify.data && verify.data.active_devices;

        if (!verify.error && Array.isArray(stored) && stored.indexOf(deviceId) === -1) {
            deviceProblem('registration-lost', {
                deviceId: deviceId, claimReturned: claim.data.devices, storedNow: stored
            });
            toastErr('The registration did not stick', 'The server accepted this browser but it is not in the saved list. Details are in the Signed-in devices card.');
            renderAdminDevices(stored, {
                title: 'The registration did not stick',
                message: 'The server accepted this browser, but it is not in the saved list. ' +
                    'Something removed it straight away. Details are in the browser console.'
            });
            return;
        }

        renderAdminDevices(!verify.error && Array.isArray(stored) ? stored : claim.data.devices);

        /* The Administrators table counted this account's devices before the
           browser registered; refresh it now rather than waiting for a
           realtime event to arrive. */
        quietly(loadAdmins).catch(function () { /* the next refresh will catch up */ });
    }

    /* `problem` ({ title, message }) is shown above the list when this
       browser could not be registered. It replaces the "registers itself the
       next time" reassurance, which would be false: something is wrong, and
       the console says what. */
    function renderAdminDevices(devices, problem) {
        var container = $('#admin-device-list');
        var currentId = null;
        try { currentId = localStorage.getItem('pia_device_id'); } catch (err) { /* ignore */ }

        var banner = problem
            ? '<div class="notice notice-danger" role="alert">' + icon('alert') +
              '<div><p class="notice-title">' + esc(problem.title) + '</p>' +
              '<p class="notice-text">' + esc(problem.message) + '</p></div></div>' +
              '<div class="device-problem-actions"><button class="btn btn-secondary btn-sm" type="button" ' +
              'data-retry="admindevices">Try registering again</button></div>'
            : '';

        if (!devices || !devices.length) {
            container.innerHTML = banner || ('<div class="notice">' + icon('info') +
                '<div><p class="notice-title">No registered devices</p></div></div>');
            return;
        }

        container.innerHTML = banner + devices.map(function (deviceId) {
            var info = describeDevice(deviceId);
            var isCurrent = (deviceId === currentId);
            return '' +
                '<div class="device-row" data-device="' + esc(deviceId) + '">' +
                '<span class="device-glyph">' + icon(info.glyph, 'icon-sm') + '</span>' +
                '<div class="device-text"><p class="device-name">' + esc(info.label) + '</p></div>' +
                (isCurrent
                    ? '<span class="badge badge-accent">This device</span>'
                    : '<button class="btn btn-danger-soft btn-sm" data-revoke-admin="' + esc(deviceId) +
                      '" aria-label="Revoke ' + esc(info.label) + '">Revoke</button>') +
                '</div>';
        }).join('');

        $$('[data-revoke-admin]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                revokeAdminDevice(btn.getAttribute('data-revoke-admin'), btn);
            });
        });
    }

    /* What a revoke actually did, from what the server reports. The server
       ends the login it recorded for the device (its session and refresh
       tokens are deleted, and the token is refused straight away). A device
       that registered before sessions were recorded can only be taken off the
       list, and the console says so rather than claiming a sign-out. */
    function announceRevoke(data, extra) {
        var ended = toInt(data && data.sessions_ended, 0);
        var unbound = toInt(data && data.unbound, 0);
        var removed = toInt(data && data.removed, 0);
        var tail = extra ? ' ' + extra : '';

        if (unbound > 0) {
            showNotice('Removed from the list — its login was not ended',
                (unbound === 1 ? 'That device' : unbound + ' of those devices') +
                ' signed in before the server started recording which login belongs to which device, ' +
                'so there is no session to end. It is off the list, but it can keep working until it ' +
                'signs out or its login expires. Signing out of this console ends every login of this ' +
                'account, including that one.' + tail, 'danger');
        } else if (ended > 0) {
            toastOk('Device revoked', 'That login was ended on the server; the browser can no longer use it.' + tail);
        } else if (removed === 0) {
            toastOk('Already removed', 'That device was no longer in the list.' + tail);
        } else {
            toastOk('Device revoked', 'Its login had already ended.' + tail);
        }
    }

    async function revokeAdminDevice(deviceId, sourceBtn) {
        var ok = await confirmAction({
            title: 'Revoke device',
            heading: 'End this device’s login?',
            message: 'The login on that device is ended on the server, so it is refused straight away and ' +
                'cannot renew itself. If it is the browser you are using right now, you will be signed out too.',
            confirmLabel: 'End this login'
        });
        if (!ok) { return; }

        var release = setBusy(sourceBtn, 'Revoking…');
        var res = await sb.rpc('admin_revoke_device', {
            p_email: state.adminEmail,
            p_device_id: deviceId
        });
        release();

        if (res.error) {
            toastErr('Revoke failed', res.error.message);
            return;
        }

        renderAdminDevices((res.data && res.data.devices) || []);
        announceRevoke(res.data);
        /* Tell that device to check now rather than within 10 seconds. */
        nudgeDevice(deviceId);

        var currentId = null;
        try { currentId = localStorage.getItem('pia_device_id'); } catch (err) { /* ignore */ }
        if (currentId === deviceId) { await signOut(); }
    }

    /* Forced modal: the admin must free a slot before the console continues.
       Since migration 0032 the server never refuses an administrator a device,
       so this only appears while 0032 has not been applied yet. */
    function showDeviceLimitModal(devices) {
        var currentId = null;
        try { currentId = localStorage.getItem('pia_device_id'); } catch (err) { /* ignore */ }

        $('#device-limit-list').innerHTML = (devices || []).map(function (deviceId) {
            var info = describeDevice(deviceId);
            var isCurrent = (deviceId === currentId);
            return '' +
                '<div class="device-row">' +
                '<span class="stat-glyph">' + icon(info.glyph, 'icon-sm') + '</span>' +
                '<div class="device-text">' +
                '<p class="device-name">' + esc(info.label) +
                (isCurrent ? ' <span class="badge">This device</span>' : '') + '</p>' +
                '<p class="device-meta cell-mail">' + esc(deviceId) + '</p>' +
                '</div>' +
                '<button class="btn btn-danger-soft btn-sm" data-limit-revoke="' + esc(deviceId) + '">Revoke</button>' +
                '</div>';
        }).join('');

        $$('[data-limit-revoke]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                revokeFromLimitModal(btn.getAttribute('data-limit-revoke'), btn);
            });
        });

        openModal('modal-device-limit');
    }

    /* Two atomic steps instead of one read-filter-write: free the slot, then
       claim it for this device. Writing the whole array at once would silently
       erase any login that happened in between. */
    async function revokeFromLimitModal(deviceId, sourceBtn) {
        var release = setBusy(sourceBtn, 'Revoking…');

        var revoke = await sb.rpc('admin_revoke_device', {
            p_email: state.adminEmail,
            p_device_id: deviceId
        });

        if (revoke.error) {
            release();
            toastErr('Revoke failed', revoke.error.message);
            return;
        }

        var currentId = (typeof getOrCreateDeviceId === 'function') ? getOrCreateDeviceId() : null;
        var updated = [];

        if (deviceId !== currentId) {
            var claim = await sb.rpc('claim_device', { p_device_id: currentId });
            if (claim.error) {
                release();
                toastErr('Could not register this device', claim.error.message);
                return;
            }
            updated = (claim.data && claim.data.devices) || [];
        } else {
            var after = await sb.from('profiles')
                .select('active_devices').eq('email', state.adminEmail).maybeSingle();
            updated = (after.data && after.data.active_devices) || [];
        }

        release();
        closeModal('modal-device-limit');
        renderAdminDevices(updated);
        announceRevoke(revoke.data, 'This browser is now registered.');
        if (deviceId !== currentId) { nudgeDevice(deviceId); }

        var storedId = null;
        try { storedId = localStorage.getItem('pia_device_id'); } catch (err) { /* ignore */ }
        if (storedId === deviceId) { await signOut(); }
    }

    /* Sign out ends the session on the server, then leaves.

       Order matters and nothing is claimed early:
         1. the device slot is released (best effort; a failure here must not
            keep someone signed in);
         2. a global sign-out ends every session and deletes the refresh
            tokens. If the server refuses it, the console stays where it is and
            says so (the menu item can be used again). This device is never
            left half signed out;
         3. only then is local storage cleared (the device id is kept: it
            belongs to the machine) and the browser sent to the front door.
       function.js's executeForceLogout is NOT used here: it swallows a failed
       sign-out and navigates anyway, which would leave a live refresh token
       behind while the page claimed otherwise. */
    var signingOut = false;

    async function signOut() {
        if (signingOut) { return; }
        signingOut = true;

        var status = $('#signout-status');
        var item = $('#user-signout');
        if (item) { item.disabled = true; }
        if (status) { status.textContent = 'Signing out…'; }

        /* Tell the session watchers this sign-out is deliberate. */
        try { sessionStorage.setItem('is_signing_out', 'true'); } catch (err) { /* ignore */ }
        if (typeof piaUserSigningOut !== 'undefined') { piaUserSigningOut = true; }

        var deviceId = null;
        try { deviceId = localStorage.getItem('pia_device_id'); } catch (err) { /* ignore */ }

        if (deviceId) {
            try { await sb.rpc('release_device', { p_device_id: deviceId }); }
            catch (err) { console.error('Device release failed:', err); }
        }

        var result;
        try { result = await sb.auth.signOut({ scope: 'global' }); }
        catch (err) { result = { error: err }; }

        if (result && result.error) {
            signingOut = false;
            try { sessionStorage.removeItem('is_signing_out'); } catch (err) { /* ignore */ }
            if (typeof piaUserSigningOut !== 'undefined') { piaUserSigningOut = false; }
            if (item) { item.disabled = false; }
            var message = 'Sign-out failed: ' + ((result.error && result.error.message) || 'the server did not answer') +
                '. You are still signed in. Try again.';
            if (status) { status.textContent = message; }
            showGlobalError(message);
            return;
        }

        try {
            var theme = localStorage.getItem('pia_theme');
            localStorage.clear();
            sessionStorage.clear();
            if (deviceId) { localStorage.setItem('pia_device_id', deviceId); }
            if (theme) { localStorage.setItem('pia_theme', theme); }   /* a display choice, not a credential */
        } catch (err) { /* storage blocked: the token is already revoked */ }

        window.location.replace('../../index.html');
    }

    /* ---- Administrators ------------------------------------------------
       Adding one is the student-registration path with role 'admin':
       admin_create_auth_user with a random password nobody sees, then the
       profile row, then the same one-time activation link students get,
       where they choose their own password. No password is ever known here.

       Only NEW accounts. An email that already belongs to a professor or a
       participant is refused rather than promoted: a promoted professor
       would keep a "Remove faculty" button that deletes their whole account,
       admin access included, and a participant's row is research data. */

    async function loadAdmins() {
        var res = await sb.from('profiles')
            .select('full_name, email, status, max_devices, active_devices')
            .eq('role', 'admin')
            .order('full_name', { ascending: true });
        if (res.error) { throw res.error; }

        state.admins = res.data || [];
        renderAdmins();
    }

    /* Two columns: who, and a status that says only what is known. An account
       whose link has not been used yet is "Awaiting activation"; otherwise the
       only signal available for an administrator is whether a login holds a
       device slot (claim_device / release_device), so it reads "Signed in" or
       "Signed out". There is no heartbeat or interaction signal for
       administrators, so nothing here says Active, Idle or Connected. */
    function renderAdmins() {
        $('#admin-tbody').innerHTML = state.admins.map(function (a) {
            var pending = (a.status || '') === 'inactive';
            var signedIn = (a.active_devices || []).length > 0;
            var isYou = a.email === state.adminEmail;
            var status = pending
                ? '<span class="badge">Awaiting activation</span>'
                : '<span class="presence"><span class="dot ' + (signedIn ? 'dot-on' : 'dot-off') +
                  '" aria-hidden="true"></span>' + (signedIn ? 'Signed in' : 'Signed out') + '</span>';
            return '<tr>' +
                '<td><div class="cell-user"><span class="avatar" aria-hidden="true">' + esc(initialsOf(a.full_name, a.email)) + '</span>' +
                '<span class="cell-user-text"><span class="cell-name">' + esc(a.full_name || '(no name)') +
                (isYou ? ' <span class="muted">(you)</span>' : '') + '</span>' +
                '<span class="cell-mail">' + esc(a.email) + '</span></span></div></td>' +
                '<td>' + status + '</td>' +
                '</tr>';
        }).join('');
        if (!state.admins.length) {
            $('#admin-tbody').innerHTML = '<tr><td colspan="2"><div class="state-block"><p class="state-title">No administrators found</p></div></td></tr>';
        }
    }

    function sendAdminLinkEmail(email) {
        return sb.auth.signInWithOtp({
            email: email,
            options: { shouldCreateUser: false, emailRedirectTo: activationRedirect() }
        });
    }


    /* There is no "remove administrator" here any more. Since migration 0031
       the database refuses it for any signed-in user: one compromised
       administrator must not be able to lock the others out. The project
       owner removes an administrator from the Supabase dashboard. */

    async function handleAddAdmin(event) {
        event.preventDefault();
        clearFormErrors('add-admin-form');

        var name = $('#aa-name').value.trim();
        var email = normalizeEmail($('#aa-email').value);

        var valid = true;
        valid = setFieldError('aa-name', name ? '' : 'Full name is required.') && valid;
        valid = setFieldError('aa-email', isEmail(email) ? '' : 'Enter a valid email address.') && valid;
        if (!valid) { return; }

        /* Checked BEFORE the auth user exists: profiles carries UNIQUE(email),
           so a late failure would strand a sign-in account. */
        var existing = await sb.from('profiles').select('role').eq('email', email).maybeSingle();
        if (existing.error) {
            toastErr('Could not check the email', friendlyDbError(existing.error, 'Unknown database error.'));
            return;
        }
        if (existing.data) {
            var role = String(existing.data.role || 'student').trim().toLowerCase();
            setFieldError('aa-email', role === 'admin'
                ? 'This account is already an administrator.'
                : role === 'teacher'
                    ? 'This email belongs to a professor account. Use a different email for administrator access.'
                    : 'This email belongs to a study participant. Participants cannot be administrators.');
            return;
        }

        var ok = await confirmAction({
            title: 'Add administrator',
            heading: 'Give ' + email + ' administrator access?',
            message: 'Administrators see every participant and result, open and close stages, and can ' +
                'delete participant and professor accounts. Once added, they can only be removed by the ' +
                'project owner, from the Supabase dashboard. They will get a one-time link to choose ' +
                'their own password.',
            confirmLabel: 'Create administrator',
            tone: 'accent'
        });
        if (!ok) { return; }

        var release = setBusy($('#aa-submit'), 'Creating…');

        try {
            var authRes = await sb.rpc('admin_create_auth_user', {
                target_email: email,
                default_password: generateSecurePassword()
            });
            if (authRes.error) {
                toastErr('Account not created', friendlyDbError(authRes.error, 'Could not create the sign-in account.'));
                return;
            }

            var insertRes = await sb.from('profiles').insert([{
                full_name: name,
                email: email,
                role: 'admin',
                status: 'inactive'
            }]);
            if (insertRes.error) {
                showNotice('Administrator not finished',
                    friendlyDbError(insertRes.error, 'Could not save the profile.') +
                    '\n\nA sign-in account was already created for ' + email +
                    '. Delete it in Supabase (Authentication → Users) before trying again.',
                    'danger');
                return;
            }

            closeModal('modal-add-admin');
            $('#add-admin-form').reset();
            clearFormErrors('add-admin-form');

            var mail = await sendAdminLinkEmail(email);
            if (mail.error) {
                showNotice('Administrator created, email not sent',
                    email + ' is set up, but the link could not be sent: ' + mail.error.message +
                    '\n\nThey can ask for a new link themselves with Activate account on the sign-in page.',
                    'danger');
            } else {
                toastOk('Administrator added', email + ' will get a link to choose their password.');
            }

            await loadAdmins();
        } finally {
            release();
        }
    }

    /* ============================================ 12. SCORES ENCODING === */

    /* The value most rows share, to prefill a test's "highest possible". */
    function commonValue(values) {
        var counts = {};
        var best = null;
        values.forEach(function (v) {
            if (v == null) { return; }
            var key = String(v);
            counts[key] = (counts[key] || 0) + 1;
            if (best === null || counts[key] > counts[best]) { best = key; }
        });
        return best === null ? '' : best;
    }

    /* One raw-score field per test. The highest possible score is the
       section's (the field above the table), so it is only shown here, as the
       denominator, with the resulting transmuted score beside it. */
    function scorePairCell(s, test) {
        var raw = s[test + '_test_raw_score'];
        var max = s[test + '_test_max_score'];
        var legacy = s[test + '_test_score'] != null && raw == null ? formatScore(s[test + '_test_score']) : '';
        var who = s.full_name || s.email;
        var label = test === 'pre' ? 'Pre-test' : 'Post-test';
        return '' +
            '<td class="col-score" data-label="' + label + '">' +
            '<div class="score-pair" data-test="' + test + '" data-legacy="' + esc(legacy) + '"' +
            ' data-initial-raw="' + esc(raw == null ? '' : raw) + '" data-initial-max="' + esc(max == null ? '' : max) + '">' +
            '<input class="input score-input" type="number" step="any" min="0" inputmode="decimal" data-part="raw"' +
            ' aria-label="' + esc(label + ' raw score, ' + who) + '" value="' + esc(raw == null ? '' : raw) + '">' +
            '<span class="score-of tnum" aria-hidden="true">/ <span data-max-out>—</span></span>' +
            '<output class="score-out tnum"></output>' +
            '</div>' +
            '</td>';
    }

    /* The section's highest possible score for one test, as typed. */
    function sectionMax(test) {
        return $('#scores-max-' + test).value;
    }

    /* The transmuted score beside one raw field, from the section's maximum. */
    function paintScorePair(pair) {
        var test = pair.getAttribute('data-test');
        var out = pair.querySelector('.score-out');
        var maxText = sectionMax(test).trim();
        var read = readScorePair(pair.querySelector('[data-part="raw"]').value, maxText, true);
        var legacy = pair.getAttribute('data-legacy');

        pair.querySelector('[data-max-out]').textContent = maxText || '—';
        pair.classList.toggle('is-invalid', !read.ok);
        pair.querySelector('[data-part="raw"]').classList.toggle('is-invalid', !read.ok);
        out.classList.remove('is-legacy');
        out.removeAttribute('title');
        if (!read.ok) {
            out.textContent = read.error;
        } else if (read.score != null) {
            out.textContent = '= ' + formatScore(read.score);
        } else if (legacy) {
            out.textContent = legacy + ' · legacy';
            out.title = 'Entered before raw scores were kept. Type the raw score to replace it.';
            out.classList.add('is-legacy');
        } else {
            out.textContent = '—';
        }
    }

    async function openScoresModal(sectionName) {
        state.activeSection = sectionName;
        $('#scores-title').textContent = 'Input scores — ' + sectionName;
        $('#scores-tbody').innerHTML = skeletonRows(3, 5);
        $('#scores-max-pre').value = '';
        $('#scores-max-post').value = '';
        $('#scores-save').disabled = true;
        openModal('modal-scores');

        var res = await sb.from('profiles')
            .select('role, full_name, email, group_type, pre_test_score, post_test_score' + RAW_SCORE_COLUMNS)
            .eq('section', sectionName)
            .order('full_name', { ascending: true });

        if (res.error) {
            var missing = isMissingColumn(res.error);
            $('#scores-tbody').innerHTML = '<tr><td colspan="3">' +
                '<div class="state-block" style="min-height:200px">' +
                '<p class="state-title">' + (missing ? 'Raw scores are not set up yet' : 'Could not load scores') + '</p>' +
                '<p class="state-desc">' + esc(missing
                    ? 'Apply supabase/migrations/20260929_0034_raw_and_transmuted_test_scores.sql, then reopen this dialog.'
                    : friendlyDbError(res.error, 'Unknown database error.')) + '</p>' +
                '</div></td></tr>';
            return;
        }

        var students = (res.data || []).filter(function (row) {
            return (row.role || '').toLowerCase() !== 'admin';
        });

        if (!students.length) {
            $('#scores-tbody').innerHTML = '<tr><td colspan="3">' +
                '<div class="state-block" style="min-height:200px">' +
                '<p class="state-title">No students in this section</p>' +
                '</div></td></tr>';
            return;
        }

        $('#scores-save').disabled = false;
        $('#scores-note').textContent = 'Applies to all ' + students.length + ' student' + (students.length === 1 ? '' : 's');
        clearFormErrors('scores-toolbar');
        $('#scores-max-pre').value = commonValue(students.map(function (s) { return s.pre_test_max_score; }));
        $('#scores-max-post').value = commonValue(students.map(function (s) { return s.post_test_max_score; }));

        $('#scores-tbody').innerHTML = students.map(function (s) {
            return '' +
                '<tr data-email="' + esc(s.email) + '" data-name="' + esc(s.full_name || s.email) + '">' +
                '<td>' + userCell(s) + '</td>' +
                scorePairCell(s, 'pre') +
                scorePairCell(s, 'post') +
                '</tr>';
        }).join('');

        $$('#scores-tbody .score-pair').forEach(paintScorePair);
    }

    /* A new section maximum re-scores every row beneath it. */
    function repaintScores(test) {
        setFieldError('scores-max-' + test, '');
        $$('#scores-tbody .score-pair[data-test="' + test + '"]').forEach(paintScorePair);
    }

    /* UPDATE per row, never upsert. An upsert INSERTS when nothing matches: if
       another admin deletes a student while this modal is open, saving would
       resurrect them as a ghost row — email and score only, NULL name, and
       role defaulting to 'student' — which then shows up in the research
       export. An UPDATE that matches nothing simply touches zero rows.

       Only the raw data of a test that changed is sent; the database
       calculates the transmuted score (0034). A blank raw score is "no score":
       it leaves an untouched row alone, and clears a test that had one. */
    async function saveBatchScores() {
        var rows = $$('#scores-tbody tr[data-email]');
        var updates = [];

        for (var i = 0; i < rows.length; i++) {
            var email = rows[i].getAttribute('data-email');
            var change = {};

            var pairs = $$('.score-pair', rows[i]);
            for (var j = 0; j < pairs.length; j++) {
                var pair = pairs[j];
                var test = pair.getAttribute('data-test');
                var read = readScorePair(pair.querySelector('[data-part="raw"]').value, sectionMax(test), true);

                paintScorePair(pair);
                if (!read.ok) {
                    /* No highest possible score is a problem with the section's
                       field, not with the row that happened to reach it first. */
                    var rawText = pair.querySelector('[data-part="raw"]').value.trim();
                    if (rawText && !sectionMax(test).trim()) {
                        setFieldError('scores-max-' + test, 'Enter the highest possible score.');
                        $('#scores-max-' + test).focus();
                        toastErr('Check the ' + TEST_LABELS[test], 'Enter the highest possible score above the table.');
                    } else {
                        pair.querySelector('[data-part="raw"]').focus();
                        toastErr('Check the ' + TEST_LABELS[test],
                            rows[i].getAttribute('data-name') + ': ' + read.error);
                    }
                    return;
                }

                /* Unchanged, or still blank (a blank raw score means no score,
                   whatever the section's maximum says). */
                if (sameNumber(read.raw, pair.getAttribute('data-initial-raw')) &&
                    sameNumber(read.max, read.raw == null ? '' : pair.getAttribute('data-initial-max'))) { continue; }

                change[test + '_test_raw_score'] = read.raw;
                change[test + '_test_max_score'] = read.max;
            }

            if (Object.keys(change).length) { updates.push({ email: email, change: change }); }
        }

        if (!updates.length) {
            closeModal('modal-scores');
            toastOk('Nothing to save', 'No score was changed.');
            return;
        }

        var release = setBusy($('#scores-save'), 'Saving…');

        var results = await Promise.all(updates.map(function (u) {
            return sb.from('profiles').update(u.change).eq('email', u.email);
        }));

        release();

        var failed = results.filter(function (r) { return r.error; });

        if (failed.length) {
            console.error('Batch score save failed:', failed[0].error);
            toastErr('Scores not saved',
                (isMissingColumn(failed[0].error) ? MIGRATION_MISSING
                    : friendlyDbError(failed[0].error, 'Could not save the scores.')) +
                (failed.length > 1 ? ' (' + failed.length + ' rows failed)' : ''));
            return;
        }

        closeModal('modal-scores');
        toastOk('Scores saved', updates.length + ' student' + (updates.length === 1 ? '' : 's') +
            ' updated for ' + state.activeSection + '.');
        refreshAll();
    }

    /* ============================================== 13. REALTIME ======== */

    var deferredRefresh = false;
    var refreshTimer = null;
    var backoffMs = 1000;

    function isUserBusy() {
        var active = document.activeElement;
        var typing = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT');
        return !!(typing || openLayers.length);
    }

    /* A realtime tick while a form is open would rewrite the table under the
       admin's cursor. Defer instead, doubling the wait up to 8s so a modal
       left open for ten minutes does not schedule 600 wake-ups. */
    function scheduleRefresh() {
        if (deferredRefresh) { return; }
        deferredRefresh = true;

        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(function () {
            deferredRefresh = false;

            if (isUserBusy()) {
                backoffMs = Math.min(backoffMs * 2, 8000);
                scheduleRefresh();
                return;
            }

            backoffMs = 1000;
            refreshAll({ quiet: true });
        }, backoffMs);
    }

    function flushDeferredRefresh() {
        if (!deferredRefresh || isUserBusy()) { return; }
        clearTimeout(refreshTimer);
        deferredRefresh = false;
        backoffMs = 1000;
        refreshAll({ quiet: true });
    }

    function setupRealtime() {
        if (typeof registerChannel !== 'function') {
            console.warn('registerChannel unavailable — realtime updates are off.');
            return;
        }

        registerChannel('admin-realtime-profiles', function (channel) {
            return channel
                .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, function (payload) {
                    scheduleRefresh();

                    /* Presence is the one thing too time-sensitive to wait for
                       the debounced refresh — flip the dot now. */
                    if (payload.new && payload.new.email) {
                        applyPresence(payload.new.email, (payload.new.active_devices || []).length > 0);
                    }

                    /* And the admin's own device list. */
                    if (state.adminEmail && payload.new && payload.new.email === state.adminEmail) {
                        /* A payload that lacks the column is not an empty list:
                           rendering it as one is how a working registration
                           could be painted as "No registered devices". */
                        if (Array.isArray(payload.new.active_devices)) { renderAdminDevices(payload.new.active_devices); }
                        else { console.warn('[PIA device] realtime update had no active_devices; list left as is'); }
                    }
                })
                .subscribe();
        });

        /* Students listen to `settings`; the admin never did, so the three
           stage switches went stale whenever another admin or another tab
           changed them. */
        registerChannel('admin-realtime-settings', function (channel) {
            return channel
                .on('postgres_changes', { event: '*', schema: 'public', table: 'settings' }, function () {
                    quietly(loadSettings).catch(function (err) { console.error('Settings reload failed:', err); });
                })
                .subscribe();
        });
    }

    /* True when a read failed because the table is not set up on this database. */
    function isMissingTable(error) {
        return !!error && (error.code === '42P01' || error.code === 'PGRST205' ||
            /does not exist|could not find the table/i.test(error.message || ''));
    }

    /* ---- Command palette data (admin-shell.js asks for these) ----
       Students are searched on the server, ten at most, and a newer keystroke
       aborts the older request; the shell drops any late answer. */
    async function searchStudentsRemote(term, signal) {
        var t = sanitizeFilterTerm(term).toLowerCase();
        if (!t) { return []; }
        var query = sb.from('profiles').select('full_name, email, section').neq('role', 'admin')
            .or('full_name.ilike.%' + t + '%,email.ilike.%' + t + '%')
            .order('full_name', { ascending: true }).limit(6);
        if (signal && typeof query.abortSignal === 'function') { query = query.abortSignal(signal); }
        var res = await query;
        if (res.error) { throw res.error; }
        return res.data || [];
    }

    /* The profile panel reads the roster page or the cohort; a student found by
       search may be in neither, so fetch the full row first. */
    async function openStudentByEmail(email) {
        if (!findStudent(email)) {
            var res = await sb.from('profiles').select('*').eq('email', email).maybeSingle();
            if (res.error || !res.data) {
                toastErr('Could not open the profile', friendlyDbError(res.error, 'That student was not found.'));
                return;
            }
            state.cohort.push(res.data);
        }
        switchView('students');
        openStudentDrawer(email);
    }

    /* ============================================ 15. BOOT SEQUENCE ===== */

    /* Every read the dashboard needs, in parallel. A failure here shows the
       error banner but never signs the admin out — their identity is already
       verified at this point. */
    /* ---- Loader tracking ----
       Each loader is wrapped ONCE, here, so every call to it -- boot, the
       Refresh button, a filter change, Try again -- drives the loading state
       without any call site remembering to. `key` is the data-region name. */
    function tracked(key, load) {
        return function () { return Loading.track(key, load.apply(this, arguments)); };
    }

    loadCohort = tracked('cohort', loadCohort);
    loadSections = tracked('sections', loadSections);
    loadRoster = tracked('roster', loadRoster);
    loadStageCounters = tracked('stages', loadStageCounters);
    loadFaculty = tracked('faculty', loadFaculty);
    loadAdmins = tracked('admins', loadAdmins);
    loadSettings = tracked('settings', loadSettings);
    loadAdminDevices = tracked('admindevices', loadAdminDevices);

    RETRY = {
        cohort: loadCohort, sections: loadSections, roster: loadRoster, stages: loadStageCounters,
        faculty: loadFaculty, admins: loadAdmins, settings: loadSettings,
        admindevices: loadAdminDevices
    };

    async function refreshAll(opts) {
        try {
            /* Started in this tick, so the flag covers exactly these. */
            var jobs;
            try {
                Loading.setQuiet(opts && opts.quiet);
                jobs = [
                    loadCohort(),
                    loadSections(),
                    loadRoster(),
                    loadStageCounters(),
                    loadFaculty(),
                    loadAdmins(),
                    loadSettings()
                ];
            } finally {
                Loading.setQuiet(false);
            }
            await Promise.all(jobs);
            hideGlobalError();
        } catch (err) {
            console.error('Dashboard data failed to load:', err);
            showGlobalError((err && err.message)
                ? 'Some data failed to load: ' + err.message
                : 'Some data failed to load. Please refresh the page.');
        }
    }

    async function initAdminIdentity(email) {
        state.adminEmail = email;

        var name = email.split('@')[0];
        var res = await sb.from('profiles').select('full_name').eq('email', email).maybeSingle();
        if (res.data && res.data.full_name) { name = res.data.full_name.trim(); }

        state.adminName = name;

        $('#admin-name').textContent = name;
        $('#admin-email').textContent = email;
        $('#profile-name').textContent = name;
        $('#profile-email').textContent = email;
        $('#admin-initials').textContent = initialsOf(name, email);
    }

    function initForms() {
        $('#reset-pw-form').addEventListener('submit', handleSetTempPassword);
        $('#temp-password-generate').addEventListener('click', function () {
            $('#temp-password').value = generateTempPassword();
            setFieldError('temp-password', '');
        });
        $('#temp-password-copy').addEventListener('click', copyTempPassword);
        $('#reset-pw-email').addEventListener('click', function () {
            sendPasswordReset(state.resetEmail, $('#reset-pw-email'), { confirmed: true });
        });

        initTutorFields();
        $('#register-student-form').addEventListener('submit', handleRegisterStudent);
        $('#edit-student-form').addEventListener('submit', handleUpdateStudent);
        $$('#edit-student-form [data-score-test]').forEach(function (input) {
            input.addEventListener('input', function () { paintScorePreview(input.getAttribute('data-score-test')); });
        });
        $('#add-professor-form').addEventListener('submit', handleRegisterProfessor);
        $('#add-admin-form').addEventListener('submit', handleAddAdmin);
        initChangePassword();

        $('#new-section-form').addEventListener('submit', async function (event) {
            event.preventDefault();
            var name = $('#ns-name').value.trim();

            if (!name) { setFieldError('ns-name', 'Section name is required.'); return; }

            var duplicate = state.sections.some(function (s) {
                return s.name.toLowerCase() === name.toLowerCase();
            });
            if (duplicate) { setFieldError('ns-name', 'A section with that name already exists.'); return; }
            setFieldError('ns-name', '');

            var release = setBusy($('#ns-submit'), 'Creating…');
            var res = await sb.from('sections').insert([{ name: name }]);
            release();

            if (res.error) {
                setFieldError('ns-name', friendlyDbError(res.error, 'Could not create the section.'));
                toastErr('Section not created', friendlyDbError(res.error, 'Insert rejected.'));
                return;
            }

            closeModal('modal-new-section');
            $('#new-section-form').reset();
            toastOk('Section created', name + ' is ready for enrolment.');
            refreshAll();
        });

        $('#scores-save').addEventListener('click', saveBatchScores);
        $('#scores-tbody').addEventListener('input', function (event) {
            var pair = event.target.closest('.score-pair');
            if (pair) { paintScorePair(pair); }
        });
        ['pre', 'post'].forEach(function (test) {
            $('#scores-max-' + test).addEventListener('input', function () { repaintScores(test); });
        });
        $('#device-limit-signout').addEventListener('click', signOut);

        $('#section-scores-btn').addEventListener('click', function () {
            var section = state.activeSection;
            closeModal('modal-section-details');
            setTimeout(function () { openScoresModal(section); }, 200);
        });

    }

    async function boot() {
        /* The shared client must exist before anything else runs. */
        if (typeof sb === 'undefined' || !sb) {
            setBootText('Database connection failed.');
            showGlobalError('Database connection failed. Please refresh the page.');
            return;
        }

        /* --- Phase 1: AUTH. A failure here is a genuine authorization
           problem, so redirecting is correct. --- */
        /* Three different failures, three different outcomes. The old code
           treated them all as "unauthorized": it removed pia_user_email but
           left the dead token in storage, so the homepage greeted a session
           the server had already ended, and "Continue to dashboard" bounced
           off page-guard forever.
             - the session is gone or refused   -> clear THIS browser, staff sign-in
             - a live session that is not admin -> that person's own console
             - no answer (offline)              -> say so, keep the session */
        var email;
        setBootText('Verifying administrator access…');

        var sessionRes;
        try { sessionRes = await sb.auth.getSession(); }
        catch (err) { sessionRes = { error: err, data: { session: null } }; }

        if (sessionRes.error || !sessionRes.data.session) {
            setBootText('Your session ended. Taking you to sign in…');
            endStaffSession('ended');
            return;
        }

        email = sessionRes.data.session.user.email;

        var profileRes;
        try { profileRes = await sb.from('profiles').select('role').eq('email', email).maybeSingle(); }
        catch (err) { profileRes = { error: { message: (err && err.message) || 'Network error' } }; }

        if (profileRes.error && isNetworkFailure(profileRes.error)) {
            setBootText('Can’t reach the server. Check the connection, then reload.');
            showGlobalError('Can’t reach the server. Your session is kept; reload when you are back online.');
            return;
        }

        /* A live session can always read its own profile row. None at all
           means the server no longer accepts this login. */
        if (profileRes.error || !profileRes.data) {
            var current = await isSessionCurrentOnServer();
            console.error('Admin console: access check refused.', profileRes.error || 'no profile row', 'session current:', current);
            setBootText('Your session ended. Taking you to sign in…');
            endStaffSession(current === false ? 'revoked' : 'ended');
            return;
        }

        var role = String(profileRes.data.role || '').trim().toLowerCase();
        if (role !== 'admin') {
            /* Signed in, just not an administrator: their own console, with
               their session intact. */
            setBootText('This console is for administrators. Taking you to yours…');
            window.location.replace(role === 'teacher'
                ? '../../teacher/html/teacher-dashboard.html'
                : '../../student/html/waiting-room.html');
            return;
        }

        try { localStorage.setItem('pia_user_email', email); } catch (err) { /* ignore */ }

        /* --- Phase 2: UI. Wire the shell before data arrives so the skeletons
           are interactive. --- */
        PIAAdminShell.init({
            go: switchView,
            openModal: openModal,
            openStudent: openStudentByEmail,
            openSection: function (name) { switchView('sections'); openSectionDetails(name); },
            getSections: function () { return state.sections; },
            searchStudents: searchStudentsRemote,
            signOut: signOut,
            isModalOpen: function () { return openLayers.length > 0; }
        });
        initRouter();
        initModals();
        initInfoTips();
        initRoster();
        initLive();
        initSectionsTable();
        initDrawerActions();
        initFaculty();
        initGates();
        renderPolicy();
        initForms();
        initRetry();
        initScrollRegions();
        paintSkeletons();

        setBootText('Loading dashboard…');
        await initAdminIdentity(email);

        revealApp();

        /* --- Phase 3: DATA. A failure here shows the banner and keeps the
           verified admin on the page. --- */
        await refreshAll();

        setupRealtime();
        startLiveSessionsTimer();
        /* Ends this console the moment the server stops accepting its login
           (function.js 1C-7) -- a revoke from another device lands here. */
        startStaffSessionWatch();
        await loadAdminDevices();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
