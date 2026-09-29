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
 *   5.  Overview renderers
 *   6.  Sections
 *   7.  Student roster
 *   8.  Student drawer and per-student actions
 *   9.  Faculty
 *   10. Stage controls (access by section)
 *   11. Profile (password, sessions) and Settings (administrators)
 *   12. Scores encoding
 *   13. Realtime subscriptions
 *   14. CSV export
 *   16. Math task bank (question_bank + app_config, migration 0028)
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
        'neutral': { short: 'EXP · Neutral', badge: 'badge-warn', family: 'experimental' },
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

    var PAGE_SIZE = 50;

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
        filters: { group: 'all', sub: 'all', stage: null, search: '' },
        activeStudent: null,
        managingEmail: null,
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

    /* ---- 3.2 Rail ----
       Behaviour lives in assets/js/shell.js, shared with the teacher console.
       The rail is told when a modal owns the Escape key so the two do not
       fight over it. */

    var app = $('#app');

    function closeMobileNav() { PIAShell.closeMobileNav(); }

    /* ---- 3.3 View router ---- */

    var VIEW_TITLES = {
        overview: 'Overview',
        sections: 'Sections',
        students: 'Student Roster',
        faculty: 'Faculty',
        controls: 'Stage Controls',
        profile: 'Profile',
        settings: 'Settings',
        mathtask: 'Math Task'
    };

    function switchView(view) {
        if (!VIEW_TITLES[view]) { view = 'overview'; }

        $$('[data-view-panel]').forEach(function (panel) {
            panel.classList.toggle('is-hidden', panel.getAttribute('data-view-panel') !== view);
        });
        /* The account block at the foot of the rail is the Profile link. */
        $$('.nav-item, .sidebar-user').forEach(function (item) {
            item.classList.toggle('is-active', item.getAttribute('data-view') === view);
        });

        $('#crumb-current').textContent = VIEW_TITLES[view];
        document.title = VIEW_TITLES[view] + ' — PIA Admin Console';

        try { sessionStorage.setItem('pia.admin.view', view); } catch (err) { /* ignore */ }
        if (window.location.hash !== '#' + view) {
            history.replaceState(null, '', '#' + view);
        }

        /* Stage counters are the one thing that goes stale between visits. */
        if (view === 'students') { loadStageCounters(); }
        /* The bank loads at boot; a failed load (or one run before 0028
           existed) is retried when the view is opened. */
        if (view === 'mathtask' && (qb.status === 'missing' || qb.status === 'error')) { loadMathTask(); }

        closeMobileNav();
        window.scrollTo({ top: 0, behavior: 'auto' });
    }

    function initRouter() {
        $$('.nav-item[data-view], .sidebar-user').forEach(function (item) {
            item.addEventListener('click', function () {
                switchView(item.getAttribute('data-view'));
            });
        });
        $$('[data-view-link]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                switchView(btn.getAttribute('data-view-link'));
            });
        });

        var fromHash = (window.location.hash || '').replace('#', '');
        var stored = '';
        try { stored = sessionStorage.getItem('pia.admin.view') || ''; } catch (err) { /* ignore */ }
        switchView(fromHash || stored || 'overview');
    }

    /* ---- 3.4 Modal manager ---- */

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
                '<span class="state-glyph">' + icon('alert', 'icon-lg') + '</span>' +
                '<p class="state-title">Couldn’t load this</p>' +
                '<p class="state-desc">' + esc(message) + '</p>' +
                '<button class="btn btn-secondary" type="button" data-retry="' + esc(key) + '">Try again</button>' +
                '</div>';
        }

        /* Where a failed load leaves its placeholders. [selector, 'block'] or
           [selector, 'rows', columns]. */
        var FAILURE = {
            cohort: [['#pipeline-strip', 'block'], ['#live-tbody', 'rows', 4],
                     ['#section-health', 'block'], ['#sections-grid', 'block']],
            sections: [['#sections-grid', 'block'], ['#section-health', 'block']],
            roster: [['#student-tbody', 'rows', 5]],
            faculty: [['#faculty-tbody', 'rows', 4]],
            settings: [['#gates-grid', 'block'], ['#gate-summary', 'block']],
            admins: [['#admin-tbody', 'rows', 4]],
            audit: [['#audit-tbody', 'rows', 4]],
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
            var dashed = key === 'cohort' ? '#view-overview .stat-value'
                : (key === 'stages' ? '[data-stage-count]' : null);
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

    function skeletonStep(label) {
        return '<div class="funnel-step" aria-hidden="true">' +
            '<div><p class="funnel-num">' + sk('00') + '</p><p class="funnel-name">' + sk(label) + '</p></div>' +
            '<div class="funnel-foot"><div class="bar"></div>' +
            '<p class="funnel-meta">' + sk('00% of 00 participants') + '</p></div></div>';
    }

    function skeletonGateRow(gate) {
        return '<div class="device-row" aria-hidden="true">' +
            '<span class="skeleton" style="width:8px;height:8px;border-radius:50%;flex:0 0 8px"></span>' +
            '<div class="device-text"><p class="device-name">' + sk(gate.title) + '</p>' +
            '<p class="device-meta">' + sk(gate.stage) + '</p></div>' + skeletonPill(56) + '</div>';
    }

    function skeletonHealth() {
        return '<div class="health-tile" aria-hidden="true"><div class="health-top">' +
            '<span class="health-name">' + sk('Section name') + '</span>' +
            '<span class="health-val tnum">' + sk('00%') + '</span></div><div class="bar"></div>' +
            '<p class="health-meta">' + sk('00 of 00 done') + '</p></div>';
    }

    function skeletonSectionCard() {
        var metric = function (label) {
            return '<div><p class="metric-label">' + sk(label) + '</p><p class="metric-value tnum">' + sk('00') + '</p></div>';
        };
        return '<article class="section-card" aria-hidden="true"><div class="section-card-body">' +
            '<div class="section-card-top"><div><h3 class="section-name">' + sk('Section name') + '</h3>' +
            '<p class="section-prof">' + sk('Professor name here') + '</p></div>' + skeletonPill(72) + '</div>' +
            '<div class="section-metrics">' + metric('Students') + metric('OCEAN') + metric('Complete') + '</div>' +
            '<div class="bar"></div></div>' +
            '<div class="section-card-foot"><div class="avatar-stack">' +
            '<span class="avatar skeleton"></span><span class="avatar skeleton"></span><span class="avatar skeleton"></span></div>' +
            '<span class="skeleton skeleton-btn" style="width:120px"></span></div></article>';
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
        return '<div class="device-row" aria-hidden="true"><span class="stat-glyph skeleton"></span>' +
            '<div class="device-text"><p class="device-name">' + sk('macOS computer') + '</p>' +
            '<p class="device-meta cell-mail">' + sk('abc123 [macOS Computer]') + '</p></div>' +
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

        fill('#pipeline-strip', ['OCEAN', 'Character Selection', 'Tutoring Dashboard', 'Active Game']
            .map(function (key) { return skeletonStep(STAGE_META[key].label); }).join(''));
        fill('#live-tbody', skeletonRows(4, 3));
        fill('#gate-summary', GATES.map(skeletonGateRow).join(''));
        fill('#section-health', times(4, skeletonHealth));
        fill('#sections-grid', times(3, skeletonSectionCard));
        fill('#gates-grid', GATES.map(skeletonGate).join(''));
        fill('#student-tbody', skeletonRows(5, 6));
        fill('#faculty-tbody', skeletonRows(4, 4));
        fill('#admin-tbody', skeletonRows(4, 2));
        fill('#audit-tbody', skeletonRows(4, 4));
        fill('#admin-device-list', skeletonDevice());
    }

    /* A table that scrolls sideways must be reachable without a mouse, and
       a screen reader has to be told it is there. */
    function initScrollRegions() {
        $$('.table-wrap').forEach(function (wrap) {
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
        ' stage_started_at, active_devices, is_ocean_done, pre_test_score, post_test_score';

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
           themselves are fetched by the drawer and the export. */
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
        renderKpis();
        renderPipeline();
        renderLiveSessions();
        renderSectionHealth();
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
            if (qbMissingTable(res.error)) { state.stageTimes = null; }
            else { console.error('[PIA] stage times could not be read:', res.error); }
            return;
        }

        var byEmail = {};
        (res.data || []).forEach(function (row) { byEmail[String(row.student_email || '').toLowerCase()] = row; });
        state.stageTimes = byEmail;
    }

    async function loadSections() {
        var res = await sb.from('sections').select('name').order('name', { ascending: true });
        if (res.error) { throw res.error; }

        state.sections = res.data || [];
        state.sectionsLoaded = true;
        fillSectionSelects();
        renderSections();
        renderSectionHealth();
        renderKpis();        /* the KPI footer quotes the section count */
        $('#nav-count-sections').textContent = state.sections.length;
    }

    /* Server-side filtering, paging and counting — the same query shape the
       original dashboard used. */
    async function loadRoster() {
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

        if (state.filters.stage !== null) {
            if (state.filters.stage === 'Active Game') {
                query = query.eq('is_in_game', true);
            } else {
                query = query.eq('current_stage', state.filters.stage).eq('is_in_game', false);
            }
        } else if (state.filters.group === 'experimental') {
            if (state.filters.sub === 'all') {
                query = query.in('group_type', ['assigned', 'non-assigned', 'neutral']);
            } else {
                query = query.eq('group_type', state.filters.sub);
            }
        } else if (state.filters.group === 'control') {
            query = query.eq('group_type', 'control');
        }

        var start = (state.page - 1) * PAGE_SIZE;
        query = query.range(start, start + PAGE_SIZE - 1).order('full_name', { ascending: true });

        var res = await query;
        state.loading.roster = false;

        if (res.error) {
            /* Placeholders (or stale rows) become a message with a retry: an
               empty table would read as "no students". */
            tbody.innerHTML = '<tr><td colspan="5"><div class="state-block region-error">' +
                '<span class="state-glyph">' + icon('alert', 'icon-lg') + '</span>' +
                '<p class="state-title">Couldn’t load the roster</p>' +
                '<p class="state-desc">' + esc(friendlyDbError(res.error, 'Unknown database error.')) + '</p>' +
                '<button class="btn btn-secondary" type="button" data-retry="roster">Try again</button>' +
                '</div></td></tr>';
            $('#pager-info').textContent = 'Could not load the roster.';
            toastErr('Roster failed to load', friendlyDbError(res.error, 'Unknown database error.'));
            return;
        }

        state.rosterPage = res.data || [];
        state.totalStudents = res.count || 0;
        $('#nav-count-students').textContent = state.totalStudents;
        renderRoster();
    }

    /* Four head-only counts. 'email' is selected because 'id' does not exist
       on profiles — with head:true the column is never read, it only has to
       exist. */
    async function loadStageCounters() {
        var base = function () {
            return sb.from('profiles').select('email', { count: 'exact', head: true }).neq('role', 'admin');
        };

        try {
            var results = await Promise.all([
                base().eq('current_stage', 'OCEAN').eq('is_in_game', false),
                base().eq('current_stage', 'Character Selection').eq('is_in_game', false),
                base().eq('current_stage', 'Tutoring Dashboard').eq('is_in_game', false),
                base().eq('is_in_game', true)
            ]);

            var keys = ['OCEAN', 'Character Selection', 'Tutoring Dashboard', 'Active Game'];
            results.forEach(function (res, index) {
                var node = $('[data-stage-count="' + keys[index] + '"]');
                if (node) { node.textContent = res.count || 0; }
            });
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
        renderFaculty('');
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

        state.overridesMissing = !!overrides.error && qbMissingTable(overrides.error);
        if (overrides.error && !state.overridesMissing) {
            console.error('[PIA] stage overrides could not be read:', overrides.error);
        }
        state.overrides = overrides.error ? null : (overrides.data || []);

        renderGates();
        renderGateSummary();
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

    /* ======================================= 5. OVERVIEW RENDERERS ====== */

    /* Completed = a stored result in ocean_submissions AND not sent back for
       a retake. A retake clears is_ocean_done but keeps the old result in
       the table, so the table alone would count a student who is mid-retake
       as finished — the old score-on-profiles check never did that, because
       the reset erased the score. */
    function hasCurrentResult(s) {
        return s.is_ocean_done === true &&
            !!(state.resultEmails && state.resultEmails[String(s.email || '').toLowerCase()]);
    }

    function renderKpis() {
        var cohort = state.cohort;
        var total = cohort.length;
        var oceanDone = cohort.filter(hasCurrentResult).length;
        var online = cohort.filter(function (s) { return (s.active_devices || []).length > 0; }).length;
        var inactive = cohort.filter(function (s) { return (s.status || '') !== 'active'; }).length;

        $('#kpi-enrolled').textContent = total;
        $('#kpi-online').textContent = online;
        $('#kpi-ocean').textContent = pct(oceanDone, total) + '%';
        $('#kpi-ocean-bar').style.width = pct(oceanDone, total) + '%';
        $('#kpi-inactive').textContent = inactive;
    }

    function stageOf(profile) {
        if (profile.is_in_game) { return 'Active Game'; }
        return profile.current_stage || null;
    }

    function renderPipeline() {
        var total = state.cohort.length;
        var order = ['OCEAN', 'Character Selection', 'Tutoring Dashboard', 'Active Game'];

        $('#pipeline-strip').innerHTML = order.map(function (key) {
            var count = state.cohort.filter(function (s) { return stageOf(s) === key; }).length;
            var share = pct(count, total);
            return '' +
                '<div class="funnel-step">' +
                '<div>' +
                '<p class="funnel-num">' + count + '</p>' +
                '<p class="funnel-name">' + esc(STAGE_META[key].label) + '</p>' +
                '</div>' +
                '<div class="funnel-foot">' +
                '<div class="bar"><div class="bar-fill ' + STAGE_META[key].fill +
                '" style="width:' + share + '%"></div></div>' +
                '<p class="funnel-meta">' + share + '% of ' + total + ' participants</p>' +
                '</div>' +
                '</div>';
        }).join('');
    }

    /* Presence is derived from the same field the rest of the app treats as
       "signed in somewhere": a non-empty active_devices array, maintained
       server-side by claim_device / release_device. A profile fetched without
       that column returns null rather than a misleading "offline". */
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
            ' title="' + (online ? 'Online' : 'Offline') + '"></span>';

        return '<span class="avatar-wrap">' +
            '<span class="avatar">' + esc(initialsOf(profile.full_name, profile.email)) + '</span>' +
            dot + '</span>';
    }

    function userCell(profile) {
        return '' +
            '<div class="cell-user">' +
            avatarMarkup(profile) +
            '<span class="cell-user-text">' +
            '<span class="cell-name" title="' + esc(profile.full_name || '(no name)') + '">' +
            esc(profile.full_name || '(no name)') + '</span>' +
            '<span class="cell-mail" title="' + esc(profile.email) + '">' + esc(profile.email) + '</span>' +
            '</span>' +
            '</div>';
    }

    /* Patches every dot for one email in place. Called from the realtime
       handler so a student going online flips the indicator immediately,
       without waiting for — or triggering — a table re-render. */
    function applyPresence(email, online) {
        $$('[data-presence="' + (email || '').replace(/"/g, '\\"') + '"]').forEach(function (dot) {
            dot.classList.toggle('is-online', !!online);
            dot.title = online ? 'Online' : 'Offline';
        });
    }

    /* profiles.current_stage also holds values outside the four tracked
       stages — 'Waiting Room' most of all. Every lookup falls back to the raw
       string rather than assuming STAGE_META has an entry. */
    function stageLabel(stageKey) {
        if (!stageKey) { return 'Idle'; }
        return STAGE_META[stageKey] ? STAGE_META[stageKey].label : stageKey;
    }

    function stageBadge(stageKey) {
        if (!stageKey || !STAGE_META[stageKey]) {
            return '<span class="badge">' + esc(stageKey || 'Idle') + '</span>';
        }
        return '<span class="badge ' + STAGE_META[stageKey].badge + '">' +
            esc(STAGE_META[stageKey].label) + '</span>';
    }

    /* Whole seconds as "4m 20s" / "1h 5m". */
    function formatSeconds(total) {
        var n = Math.max(0, Math.floor(Number(total) || 0));
        var h = Math.floor(n / 3600);
        var m = Math.floor((n % 3600) / 60);
        if (h > 0) { return h + 'h ' + m + 'm'; }
        if (m > 0) { return m + 'm ' + (n % 60) + 's'; }
        return n + 's';
    }

    /* Only students whose page has checked in during the last minute: the
       heartbeat (function.js 1C-5b) stops when a tab is hidden, closed or
       offline, so this list is who is working right now, not who once was.
       Active time is the counted time for the stage they are in. */
    function renderLiveSessions() {
        var tbody = $('#live-tbody');

        function message(glyph, title, text) {
            tbody.innerHTML = '<tr><td colspan="4"><div class="state-block" style="min-height:180px">' +
                '<span class="state-glyph">' + icon(glyph, 'icon-lg') + '</span>' +
                '<p class="state-title">' + esc(title) + '</p>' +
                (text ? '<p class="state-desc">' + esc(text) + '</p>' : '') +
                '</div></td></tr>';
        }

        if (state.stageTimes === null) {
            message('clock', 'Active time is not set up yet',
                'Apply supabase/migrations/20260929_0035_stage_time_tracking.sql, then refresh.');
            return;
        }

        var times = state.stageTimes || {};
        var cutoff = Date.now() - LIVE_WINDOW_MS;
        var rows = state.cohort.map(function (s) {
            return { student: s, time: times[String(s.email || '').toLowerCase()] };
        }).filter(function (r) {
            return r.time && STAGE_TIME_FIELD[r.time.heartbeat_stage] &&
                new Date(r.time.last_heartbeat_timestamp).getTime() >= cutoff;
        }).sort(function (a, b) {
            return String(a.student.full_name || a.student.email).localeCompare(String(b.student.full_name || b.student.email));
        }).slice(0, 10);

        if (!rows.length) {
            message('clock', 'No students active right now');
            return;
        }

        tbody.innerHTML = rows.map(function (r) {
            var stage = r.time.heartbeat_stage;
            return '' +
                '<tr>' +
                '<td>' + userCell(r.student) + '</td>' +
                '<td class="muted">' + esc(r.student.section || '—') + '</td>' +
                '<td>' + stageBadge(stage) + '</td>' +
                '<td class="duration-cell tnum">' + esc(formatSeconds(r.time[STAGE_TIME_FIELD[stage]])) + '</td>' +
                '</tr>';
        }).join('');
    }

    /* The list is re-read every 20 seconds, on its own: a heartbeat is not a
       profiles change, so nothing else here would notice one. */
    function startLiveSessionsTimer() {
        setInterval(function () {
            if (document.hidden || !state.cohortLoaded) { return; }
            loadStageTimes().then(renderLiveSessions).catch(function () { /* the next tick tries again */ });
        }, 20000);
    }

    function renderGateSummary() {
        $('#gate-summary').innerHTML = GATES.map(function (gate) {
            var access = gateAccess(gate);
            var status = gateStatus(gate);
            var meta = gate.stage;
            if (access && access.sections.length) {
                meta += ' · ' + access.sections.map(function (o) { return o.section; }).join(', ');
            }
            return '' +
                '<div class="device-row">' +
                '<span class="dot ' + (status.tone ? 'dot-live' : 'dot-off') + '"></span>' +
                '<div class="device-text">' +
                '<p class="device-name">' + esc(gate.title) + '</p>' +
                '<p class="device-meta">' + esc(meta) + '</p>' +
                '</div>' +
                '<span class="badge ' + status.tone + '">' + esc(status.text) + '</span>' +
                '</div>';
        }).join('');
    }

    /* One tile per section. Sections and the cohort load separately; until
       both are in, every section would read "0%", which means "not loaded
       yet" rather than "no progress", so the placeholders stay. */
    function renderSectionHealth() {
        var container = $('#section-health');
        if (!state.sectionsLoaded || !state.cohortLoaded) { return; }

        if (!state.sections.length) {
            container.innerHTML = '<p class="state-desc health-empty">No sections yet</p>';
            return;
        }

        container.innerHTML = state.sections.map(function (section) {
            var members = state.cohort.filter(function (s) { return s.section === section.name; });
            var done = members.filter(hasCurrentResult).length;
            var share = pct(done, members.length);
            return '' +
                '<div class="health-tile">' +
                '<div class="health-top">' +
                '<span class="health-name" title="' + esc(section.name) + '">' + esc(section.name) + '</span>' +
                '<span class="health-val tnum">' + share + '%</span>' +
                '</div>' +
                '<div class="bar"><div class="bar-fill" style="width:' + share + '%"></div></div>' +
                '<p class="health-meta">' +
                (members.length ? done + ' of ' + members.length + ' done' : 'No students') + '</p>' +
                '</div>';
        }).join('');
    }

    /* ==================================================== 6. SECTIONS === */

    function renderSections() {
        var grid = $('#sections-grid');

        if (!state.sections.length) {
            grid.innerHTML = '<div class="card"><div class="state-block">' +
                '<span class="state-glyph">' + icon('layers', 'icon-lg') + '</span>' +
                '<p class="state-title">No sections yet</p>' +
                '</div></div>';
            return;
        }

        grid.innerHTML = state.sections.map(function (section) {
            var members = state.cohort.filter(function (s) { return s.section === section.name; });
            var online = members.filter(function (s) { return (s.active_devices || []).length > 0; }).length;
            var done = members.filter(hasCurrentResult).length;

            var stack = members.slice(0, 4).map(function (s) {
                return '<span class="avatar">' + esc(initialsOf(s.full_name, s.email)) + '</span>';
            }).join('');
            var more = members.length > 4
                ? '<span class="avatar avatar-more">+' + (members.length - 4) + '</span>' : '';

            return '' +
                '<article class="section-card">' +
                '<div class="section-card-body">' +
                '<div class="section-card-top">' +
                '<div>' +
                '<h3 class="section-name">' + esc(section.name) + '</h3>' +
                '<p class="section-prof">' + esc(professorFor(section.name)) + '</p>' +
                '</div>' +
                '<span class="badge ' + (online ? 'badge-accent' : '') + '">' +
                '<span class="dot ' + (online ? 'dot-live' : 'dot-off') + '"></span>' +
                (online ? online + ' online' : 'Idle') + '</span>' +
                '</div>' +
                '<div class="section-metrics">' +
                '<div><p class="metric-label">Students</p><p class="metric-value tnum">' + members.length + '</p></div>' +
                '<div><p class="metric-label">OCEAN</p><p class="metric-value tnum">' + done + '</p></div>' +
                '<div><p class="metric-label">Complete</p><p class="metric-value tnum">' + pct(done, members.length) + '%</p></div>' +
                '</div>' +
                '<div class="bar"><div class="bar-fill" style="width:' + pct(done, members.length) + '%"></div></div>' +
                '</div>' +
                '<div class="section-card-foot">' +
                '<div class="avatar-stack">' + stack + more + '</div>' +
                '<button class="btn btn-secondary btn-sm" data-section-open="' + esc(section.name) + '">' +
                'View roster ' + icon('chev-right') + '</button>' +
                '</div>' +
                '</article>';
        }).join('');

        $$('[data-section-open]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                openSectionDetails(btn.getAttribute('data-section-open'));
            });
        });
    }

    function professorFor(sectionName) {
        var match = state.faculty.filter(function (f) { return f.assigned_section === sectionName; })[0];
        return match ? match.name : 'No professor assigned';
    }

    async function openSectionDetails(sectionName) {
        state.activeSection = sectionName;
        $('#section-details-title').textContent = 'Section ' + sectionName;
        $('#section-details-sub').textContent = 'Loading enrolled students…';
        $('#section-students-tbody').innerHTML = skeletonRows(5, 4);
        openModal('modal-section-details');

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

    /* ============================================== 7. STUDENT ROSTER === */

    /* Whether the student has activated their account, in words that say so.
       "Inactive" read as a fault; this is registration state: a registered
       student is Pending until their first sign-in, after which the database
       marks them active and this reads Activated. */
    function activationBadge(s) {
        var activated = (s.status || '') === 'active';
        return '<span class="badge ' + (activated ? 'badge-accent' : '') + '">' +
            '<span class="dot ' + (activated ? 'dot-live' : 'dot-off') + '"></span>' +
            (activated ? 'Activated' : 'Pending') + '</span>';
    }

    var ROSTER_HEADS = {
        default:
            '<tr><th>Student</th><th>Section</th><th>Condition</th><th>Stage</th><th>Status</th></tr>',
        'Active Game':
            '<tr><th>Student</th><th>Condition</th><th>Problem</th><th>Difficulty</th><th>Hints</th>' +
            '<th>Streak</th><th>Duration</th></tr>',
        stage:
            '<tr><th>Student</th><th>Section</th><th>Condition</th><th>Activity</th><th>Duration</th></tr>'
    };

    /* A row has no buttons: it opens the participant panel, whose Actions
       list holds Edit details, Delete and the rest. Deleting destroys
       collected responses, so it stays one deliberate step away in there.
       With no buttons left the row takes focus itself (see initRoster). */
    function rosterRow(s, cells) {
        var started = s.stage_started_at || '';
        return '<tr class="is-clickable" tabindex="0" data-student="' + esc(s.email) + '"' +
            ' data-started-at="' + esc(started) + '" aria-label="Open profile: ' + esc(s.full_name || s.email) + '">' +
            '<td>' + userCell(s) + '</td>' + cells + '</tr>';
    }

    /* The student's experimental group, as the same badge everywhere. */
    function conditionCell(s) {
        var condition = CONDITIONS[s.group_type] || { short: s.group_type || '—', badge: '' };
        return '<td><span class="badge ' + condition.badge + '">' + esc(condition.short) + '</span></td>';
    }

    function renderRoster() {
        var tbody = $('#student-tbody');
        var empty = $('#student-empty');
        var thead = $('#roster-thead');
        var drill = state.filters.stage;

        thead.innerHTML = drill === 'Active Game' ? ROSTER_HEADS['Active Game']
            : (drill ? ROSTER_HEADS.stage : ROSTER_HEADS.default);

        empty.classList.toggle('is-hidden', state.rosterPage.length !== 0);

        tbody.innerHTML = state.rosterPage.map(function (s) {
            var started = s.stage_started_at || '';

            if (drill === 'Active Game') {
                return rosterRow(s,
                    conditionCell(s) +
                    '<td class="tnum muted">Question ' + toInt(s.current_problem, 1) + '</td>' +
                    '<td><span class="badge badge">' + esc(s.current_difficulty || 'Normal') + '</span></td>' +
                    '<td class="tnum muted">' + toInt(s.hints_used, 0) + '</td>' +
                    '<td class="tnum muted">' + toInt(s.consecutive_correct, 0) + '</td>' +
                    '<td class="duration-cell" data-duration>' + esc(formatDuration(started)) + '</td>');
            }

            if (drill) {
                var activity = 'Reading instructions';
                if (drill === 'OCEAN') { activity = 'Answering item ' + toInt(s.ocean_current_item, 1) + '/50'; }
                if (drill === 'Character Selection') { activity = 'Browsing personas'; }
                if (drill === 'Tutoring Dashboard') { activity = 'Browsing dashboard'; }

                return rosterRow(s,
                    '<td class="muted">' + esc(s.section || '—') + '</td>' +
                    conditionCell(s) +
                    '<td><span class="badge badge-accent">' + esc(activity) + '</span></td>' +
                    '<td class="duration-cell" data-duration>' + esc(formatDuration(started)) + '</td>');
            }

            return rosterRow(s,
                '<td class="muted">' + esc(s.section || '—') + '</td>' +
                conditionCell(s) +
                '<td>' + stageBadge(stageOf(s)) + '</td>' +
                '<td>' + activationBadge(s) + '</td>');
        }).join('');

        var pages = Math.max(1, Math.ceil(state.totalStudents / PAGE_SIZE));
        var from = state.totalStudents ? (state.page - 1) * PAGE_SIZE + 1 : 0;
        var to = Math.min(state.page * PAGE_SIZE, state.totalStudents);

        $('#pager-info').textContent = 'Showing ' + from + '–' + to + ' of ' + state.totalStudents +
            (pages > 1 ? '  ·  page ' + state.page + ' of ' + pages : '');
        $('#page-prev').disabled = state.page <= 1;
        $('#page-next').disabled = state.page >= pages;
    }

    function initRoster() {
        $('#student-search').addEventListener('input', debounce(function (event) {
            state.filters.search = event.target.value;
            state.page = 1;
            loadRoster();
        }, 300));

        $$('[data-group-filter]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                $$('[data-group-filter]').forEach(function (b) { b.classList.remove('is-active'); });
                btn.classList.add('is-active');

                state.filters.group = btn.getAttribute('data-group-filter');
                state.filters.sub = 'all';
                $$('[data-sub-filter]').forEach(function (b) {
                    b.classList.toggle('is-active', b.getAttribute('data-sub-filter') === 'all');
                });
                $('#subgroup-segment').classList.toggle('is-hidden', state.filters.group !== 'experimental');

                state.page = 1;
                loadRoster();
            });
        });

        $$('[data-sub-filter]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                $$('[data-sub-filter]').forEach(function (b) { b.classList.remove('is-active'); });
                btn.classList.add('is-active');
                state.filters.sub = btn.getAttribute('data-sub-filter');
                state.page = 1;
                loadRoster();
            });
        });

        /* The four tiles are the stage filter, and they toggle: pressing the
           lit one clears it and returns the full roster. There is no separate
           "clear filter" button. */
        $$('[data-stage-filter]').forEach(function (tile) {
            tile.addEventListener('click', function () {
                var key = tile.getAttribute('data-stage-filter');
                var isSame = state.filters.stage === key;
                state.filters.stage = isSame ? null : key;

                $$('[data-stage-filter]').forEach(function (t) {
                    var on = !isSame && t === tile;
                    t.classList.toggle('is-active', on);
                    t.setAttribute('aria-pressed', on ? 'true' : 'false');
                });

                applyDrilldownChrome();
                state.page = 1;
                loadRoster();
            });
        });

        $('#reset-filters').addEventListener('click', function () {
            state.filters = { group: 'all', sub: 'all', stage: null, search: '' };
            $('#student-search').value = '';
            $$('[data-group-filter]').forEach(function (b) {
                b.classList.toggle('is-active', b.getAttribute('data-group-filter') === 'all');
            });
            $$('[data-stage-filter]').forEach(function (t) {
                t.classList.remove('is-active');
                t.setAttribute('aria-pressed', 'false');
            });
            $('#subgroup-segment').classList.add('is-hidden');
            applyDrilldownChrome();
            state.page = 1;
            loadRoster();
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
            if (row) { openStudentDrawer(row.getAttribute('data-student')); }
        });

        $('#student-tbody').addEventListener('keydown', function (event) {
            if (event.key !== 'Enter' && event.key !== ' ') { return; }
            var row = event.target.closest('[data-student]');
            if (!row || event.target !== row) { return; }
            event.preventDefault();
            openStudentDrawer(row.getAttribute('data-student'));
        });
    }

    function applyDrilldownChrome() {
        var drill = state.filters.stage;
        $('#roster-filter-bar').classList.toggle('is-hidden', !!drill);
        $('#roster-title').textContent = drill ? stageLabel(drill) + ' — live view' : 'All students';
    }

    /* Ticks every second so live durations stay honest without a refetch. */
    setInterval(function () {
        $$('tr[data-started-at]').forEach(function (row) {
            var startedAt = row.getAttribute('data-started-at');
            var cell = row.querySelector('[data-duration]');
            if (cell && startedAt) { cell.textContent = formatDuration(startedAt); }
        });
    }, 1000);

    /* ========================== 8. STUDENT DRAWER AND ACTIONS =========== */

    function findStudent(email) {
        return state.rosterPage.filter(function (s) { return s.email === email; })[0] ||
            state.cohort.filter(function (s) { return s.email === email; })[0] || null;
    }

    function consentLabel(value) {
        return value === true ? 'Received' : value === false ? 'Not received' : 'Not recorded';
    }

    function openStudentDrawer(email) {
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
            drawerDot.title = drawerOnline ? 'Online' : 'Offline';
        }
        $('#drawer-student-name').textContent = s.full_name || '(no name)';
        $('#drawer-email').textContent = s.email;
        $('#drawer-condition').textContent = condition.short;
        $('#drawer-condition').className = 'badge ' + (condition.badge || '');
        $('#drawer-section').textContent = s.section || '—';
        $('#drawer-stage').textContent = stageLabel(stageOf(s));
        $('#drawer-devices').textContent = (s.active_devices || []).length + ' of ' + toInt(s.max_devices, 1);
        $('#drawer-status').textContent = (drawerOnline ? 'Online' : 'Offline') +
            ' · ' + ((s.status || '') === 'active' ? 'Activated' : 'Not activated') +
            (s.must_change_password === true ? ' · Must change temporary password' : '');
        $('#drawer-consent').textContent = consentLabel(s.parental_consent);
        $('#drawer-assent').textContent = consentLabel(s.student_assent);
        ['pre', 'post'].forEach(function (test) {
            var parts = scoreParts(s, test);
            $('#drawer-' + test).textContent = parts.value;
            $('#drawer-' + test + '-detail').textContent = parts.detail;
        });

        renderTraits(s);
        openModal('drawer-student');
    }

    /* ---- Assessment results (BFPT) ------------------------------------
       Results live ONLY in ocean_submissions. Its one RLS policy admits an
       admin with a current session (migration 0018); a student or teacher
       asking the same question gets zero rows. profiles carries no score for
       anyone, so the drawer and the CSV export fetch results from here
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

        /* Scored as the sheet is written, N runs opposite to its own prose
           definition. Said beside the number, where it is read. */
        var nNote = '<p class="bfpt-note"><b>How N is scored:</b> exactly as the BFPT sheet specifies. ' +
            'Its N formula adds “Am relaxed most of the time” and “Seldom feel blue” and subtracts the ' +
            'eight stress items, so a higher N here reflects calmer answers.</p>';

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

        box.innerHTML = scores + '<p class="bfpt-meta">' + meta + '</p>' + nNote + answers;
    }

    function initDrawerActions() {
        $$('[data-student-action]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var s = state.activeStudent;
                if (!s) { return; }
                var action = btn.getAttribute('data-student-action');

                if (action === 'activate') { sendActivationEmail(s.email, btn); }
                else if (action === 'edit') { closeModal('drawer-student'); openEditStudent(s.email); }
                else if (action === 'devices') { openDeviceManager(s.email); }
                else if (action === 'retake-ocean') { allowRetakeOcean(s.email); }
                else if (action === 'retake-character') { allowRetakeCharacter(s.email); }
                else if (action === 'reset-password') { closeModal('drawer-student'); openResetPassword(s.email); }
                else if (action === 'delete') { deleteStudent(s.email); }
            });
        });
    }

    /* ---- Activation and password-reset email ---- */

    async function sendActivationEmail(email, sourceBtn) {
        var ok = await confirmAction({
            title: 'Send activation email',
            heading: 'Email ' + email + '?',
            message: 'The student receives a one-time link where they set their own password. ' +
                'Their account becomes active once they use it.',
            confirmLabel: 'Send email',
            tone: 'accent'
        });
        if (!ok) { return; }

        var release = setBusy(sourceBtn, 'Sending…');
        var res = await sb.auth.signInWithOtp({
            email: email,
            options: { shouldCreateUser: false, emailRedirectTo: activationRedirect() }
        });
        release();

        if (res.error) {
            toastErr('Activation email failed', res.error.message);
            return;
        }
        toastOk('Activation email sent', 'Delivered to ' + email + '.');
    }

    /* The preferred route: the owner sets their own password through the
       emailed link or code, and no password is ever known to the admin.
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
        toastOk('Reset email sent', email + ' can now set a new password.');
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

            var insertRes = await sb.from('profiles').insert([{
                full_name: fullName,
                email: email,
                section: section,
                group_type: groupType,
                parental_consent: true,
                student_assent: true,
                max_devices: 1,   /* one device per student; enforced by the database (0027, 0037) */
                status: 'inactive',
                role: 'student'
            }]);

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

        var radio = $('input[name="es-condition"][value="' + (s.group_type || '') + '"]');
        if (radio) { radio.checked = true; }

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
                section: section,
                group_type: groupType
            };
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
                toastErr('Update failed', isMissingColumn(updateRes.error)
                    ? MIGRATION_MISSING
                    : friendlyDbError(updateRes.error, 'Could not update the profile.'));
                return;
            }

            closeModal('modal-edit-student');
            toastOk('Participant updated', fullName + ' was saved.');
            refreshAll();
        } finally {
            release();
        }
    }

    /* ---- Student device manager ---- */

    async function openDeviceManager(email) {
        state.managingEmail = email;
        $('#devices-subject').textContent = email;
        $('#student-device-list').innerHTML =
            '<div class="device-row"><span class="skeleton skeleton-avatar"></span>' +
            '<div class="device-text"><span class="skeleton skeleton-line" style="width:140px"></span>' +
            '<span class="skeleton skeleton-line" style="width:200px"></span></div></div>';
        openModal('modal-devices');

        var res = await sb.from('profiles').select('active_devices').eq('email', email).maybeSingle();

        if (res.error) {
            $('#student-device-list').innerHTML = '';
            toastErr('Could not read devices', friendlyDbError(res.error, 'Unknown database error.'));
            return;
        }

        renderStudentDevices((res.data && res.data.active_devices) || []);
    }

    function renderStudentDevices(devices) {
        var container = $('#student-device-list');
        $('#revoke-all-btn').disabled = !devices.length;

        if (!devices.length) {
            container.innerHTML = '<div class="state-block" style="min-height:160px">' +
                '<span class="state-glyph">' + icon('monitor', 'icon-lg') + '</span>' +
                '<p class="state-title">No active devices</p></div>';
            return;
        }

        container.innerHTML = devices.map(function (deviceId) {
            var info = describeDevice(deviceId);
            return '' +
                '<div class="device-row">' +
                '<span class="stat-glyph">' + icon(info.glyph, 'icon-sm') + '</span>' +
                '<div class="device-text">' +
                '<p class="device-name">' + esc(info.label) + '</p>' +
                '<p class="device-meta cell-mail">' + esc(deviceId) + '</p>' +
                '</div>' +
                '</div>';
        }).join('');
    }

    /* Revoking one row only edited an array; the student's access token stayed
       valid until it expired on its own. admin_revoke_sessions is the only
       call that actually ends their access, so the control says what it does:
       it signs them out everywhere. */
    async function revokeAllStudentSessions() {
        var email = state.managingEmail;
        if (!email) { return; }

        var ok = await confirmAction({
            title: 'Sign out all devices',
            heading: 'Sign ' + email + ' out everywhere?',
            message: 'Every session for this account ends immediately and they will have to ' +
                'log in again. Any unsaved answer in progress may be lost.',
            confirmLabel: 'Sign out everywhere'
        });
        if (!ok) { return; }

        var release = setBusy($('#revoke-all-btn'), 'Revoking…');
        var res = await sb.rpc('admin_revoke_sessions', { p_email: email });
        release();

        if (res.error) {
            toastErr('Revoke failed', res.error.message);
            return;
        }

        renderStudentDevices([]);
        toastOk('Sessions revoked', email + ' was signed out of all devices.');
        refreshAll();
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
                '<span class="dot ' + (active ? 'dot-live' : 'dot-off') + '"></span>' +
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
            if (row) { openFacultyProfile(row.getAttribute('data-faculty')); }
        });

        $('#faculty-tbody').addEventListener('keydown', function (event) {
            if (event.key !== 'Enter' && event.key !== ' ') { return; }
            var row = event.target.closest('[data-faculty]');
            if (!row || event.target !== row) { return; }
            event.preventDefault();
            openFacultyProfile(row.getAttribute('data-faculty'));
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

    function openFacultyProfile(email) {
        var f = state.faculty.filter(function (row) { return row.email === email; })[0];
        if (!f) { return; }

        state.activeFaculty = f;
        $('#faculty-title').textContent = f.name || 'Faculty profile';
        $('#faculty-subject').textContent = f.email;
        $('#faculty-dept').textContent = f.department || '—';
        $('#faculty-section').textContent = f.assigned_section || 'Unassigned';
        $('#faculty-status').textContent = (f.status || '') === 'active' ? 'Active' : 'Inactive';
        $('#faculty-devices').textContent = '…';

        openModal('modal-faculty');
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
            return head() + '<p class="gate-access-note">No sections yet. Create one under Sections.</p>';
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
        if ($('#gate-summary')) { renderGateSummary(); }
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
                '<div class="device-row">' +
                '<span class="stat-glyph">' + icon(info.glyph, 'icon-sm') + '</span>' +
                '<div class="device-text">' +
                '<p class="device-name">' + esc(info.label) + '</p>' +
                '<p class="device-meta cell-mail">' + esc(deviceId) + '</p>' +
                '</div>' +
                (isCurrent
                    ? '<span class="badge badge-accent">This device</span>'
                    : '<button class="btn btn-danger-soft btn-sm" data-revoke-admin="' + esc(deviceId) + '">Revoke</button>') +
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

    /* executeForceLogout (function.js) releases the device slot, signs out
       globally so refresh tokens die on the server, then clears storage. */
    async function signOut() {
        if (typeof executeForceLogout === 'function') {
            await executeForceLogout();
            return;
        }
        await sb.auth.signOut({ scope: 'global' });
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

    /* ---- Security log (migration 0031) ----
       Written only by the database; this page reads the latest 50, and only
       when the dialog is opened -- nobody needs it on every page load. */
    var AUDIT_ACTIONS = {
        'account.created': 'Account created',
        'account.deleted': 'Account deleted',
        'role.changed': 'Role changed',
        'device_limit.changed': 'Device limit changed',
        'email.changed': 'Email changed',
        'devices.removed': 'Devices removed',
        'sessions.revoked': 'Signed out everywhere'
    };

    function auditDetail(row) {
        var d = row.detail || {};
        if (row.action === 'role.changed' || row.action === 'device_limit.changed' || row.action === 'email.changed') {
            return (d.from == null ? '—' : d.from) + ' → ' + (d.to == null ? '—' : d.to);
        }
        if (row.action === 'devices.removed') {
            var n = Array.isArray(d.devices) ? d.devices.length : 0;
            return n + (n === 1 ? ' device' : ' devices');
        }
        if (row.action === 'account.created' || row.action === 'account.deleted') { return d.role || ''; }
        return '';
    }

    function auditMessage(title, text, glyph) {
        return '<tr><td colspan="4"><div class="state-block" style="min-height:180px">' +
            '<span class="state-glyph">' + icon(glyph || 'shield', 'icon-lg') + '</span>' +
            '<p class="state-title">' + esc(title) + '</p>' +
            (text ? '<p class="state-desc">' + esc(text) + '</p>' : '') + '</div></td></tr>';
    }

    async function loadAudit() {
        var res = await sb.from('security_audit_log')
            .select('at, actor_email, actor_role, action, target_email, detail')
            .order('at', { ascending: false })
            .limit(50);

        if (res.error) {
            /* Not a failure of this page: the log does not exist until 0031
               is applied. Say so instead of showing an error. */
            if (res.error.code === '42P01' || res.error.code === 'PGRST205' ||
                /does not exist|could not find the table/i.test(res.error.message || '')) {
                $('#audit-tbody').innerHTML = auditMessage('No security log yet',
                    'Apply supabase/migrations/20260929_0031_admin_boundaries_and_audit.sql, then refresh.', 'info');
                return;
            }
            throw res.error;
        }

        var rows = res.data || [];
        if (!rows.length) {
            $('#audit-tbody').innerHTML = auditMessage('Nothing recorded yet', '');
            return;
        }

        $('#audit-tbody').innerHTML = rows.map(function (r) {
            var detail = auditDetail(r);
            var by = r.actor_email
                ? '<span class="cell-mail" title="' + esc(r.actor_email) + '">' + esc(r.actor_email) + '</span>'
                : '<span class="badge">Project owner</span>';
            return '<tr>' +
                '<td class="muted tnum">' + esc(formatStamp(r.at)) + '</td>' +
                '<td><span class="cell-name">' + esc(AUDIT_ACTIONS[r.action] || r.action) + '</span>' +
                (detail ? '<span class="cell-mail" title="' + esc(detail) + '">' + esc(detail) + '</span>' : '') + '</td>' +
                '<td><span class="cell-mail" title="' + esc(r.target_email || '') + '">' + esc(r.target_email || '—') + '</span></td>' +
                '<td>' + by + '</td>' +
                '</tr>';
        }).join('');
    }

    function openAuditLog(event) {
        openModal('modal-audit', event && event.currentTarget);
        loadAudit().catch(function (err) { console.error('Security log failed to load:', err); });
    }

    async function loadAdmins() {
        var res = await sb.from('profiles')
            .select('full_name, email, status, max_devices, active_devices')
            .eq('role', 'admin')
            .order('full_name', { ascending: true });
        if (res.error) { throw res.error; }

        state.admins = res.data || [];
        renderAdmins();
    }

    function renderAdmins() {
        $('#admin-tbody').innerHTML = state.admins.map(function (a) {
            /* Only a new account is 'inactive' until its link is used; admins
               added by hand before this form may have no status at all. */
            var pending = (a.status || '') === 'inactive';
            var isYou = a.email === state.adminEmail;
            return '' +
                '<tr>' +
                '<td>' + userCell(a) + '</td>' +
                '<td><span class="badge ' + (pending ? '' : 'badge-accent') + '">' +
                '<span class="dot ' + (pending ? 'dot-off' : 'dot-live') + '"></span>' +
                (pending ? 'Awaiting activation' : 'Active') + '</span>' +
                (isYou ? ' <span class="badge">You</span>' : '') + '</td>' +
                '<td class="tnum muted">' + (function (n) { return n + (n === 1 ? ' device' : ' devices'); })((a.active_devices || []).length) + '</td>' +
                '<td class="col-right"><span class="row-actions">' +
                /* No remove, revoke or edit for another administrator: the
                   database refuses them (migration 0031), so the console does
                   not offer them. The one-time link only emails THEM. */
                (isYou ? '' :
                    '<button class="btn-icon" title="Email them a one-time link to set their password" ' +
                    'aria-label="Email ' + esc(a.email) + ' a one-time sign-in link" ' +
                    'data-admin-act="link" data-email="' + esc(a.email) + '">' + icon('send', 'icon-sm') + '</button>' +
                    '<span class="btn-icon admin-protected" role="img" tabindex="0" ' +
                    'title="Protected: only the project owner can remove or change another administrator" ' +
                    'aria-label="Protected account: only the project owner can remove or change it">' +
                    icon('shield', 'icon-sm') + '</span>') +
                '</span></td>' +
                '</tr>';
        }).join('');
    }

    function sendAdminLinkEmail(email) {
        return sb.auth.signInWithOtp({
            email: email,
            options: { shouldCreateUser: false, emailRedirectTo: activationRedirect() }
        });
    }

    async function resendAdminLink(email, sourceBtn) {
        var ok = await confirmAction({
            title: 'Send sign-in link',
            heading: 'Email ' + email + ' a one-time link?',
            message: 'It opens a page where they choose a new password. Their current password ' +
                'stops working once they save the new one.',
            confirmLabel: 'Send link',
            tone: 'accent'
        });
        if (!ok) { return; }

        var release = setBusy(sourceBtn, '…');
        var res = await sendAdminLinkEmail(email);
        release();

        if (res.error) {
            toastErr('Link not sent', res.error.message);
            return;
        }
        toastOk('Link sent', 'Delivered to ' + email + '.');
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
                    '\n\nUse the send-link button next to their name under Administrators to try again.',
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

                    /* Keep an open device manager in sync with the same row. */
                    if (state.managingEmail && payload.new && payload.new.email === state.managingEmail) {
                        if (Array.isArray(payload.new.active_devices)) { renderStudentDevices(payload.new.active_devices); }
                        else { console.warn('[PIA device] realtime update had no active_devices; list left as is', payload.new.email); }
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

    /* ================================================ 14. CSV EXPORT ==== */

    function toCsvValue(value) {
        var text = value == null ? '' : String(value);
        return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
    }

    /* Exports the cohort summary already in memory, joined to each student's
       CURRENT assessment result (their newest submission) and its 50 item
       answers — the raw data for scale reliability and item analysis. The
       results are fetched fresh from ocean_submissions, the only place they
       exist, so this is the one export that needs a round trip. */
    async function exportCohortCsv() {
        if (!state.cohort.length) {
            toastErr('Nothing to export', 'The cohort has not loaded yet.');
            return;
        }

        var res = await fetchResults(null);
        if (res.error) {
            toastErr('Export failed', friendlyDbError(res.error, 'Could not read the assessment results.'));
            return;
        }

        var latest = {};
        var attempts = {};
        (res.data || []).forEach(function (row) {
            var key = String(row.email || '').toLowerCase();
            attempts[key] = (attempts[key] || 0) + 1;
            if (!latest[key]) { latest[key] = row; }   // rows arrive newest first
        });

        var base = ['full_name', 'email', 'section', 'group_type', 'status',
            'current_stage', 'is_in_game', 'pre_test_score', 'post_test_score', 'is_ocean_done',
            'parental_consent', 'student_assent',
            'pre_test_raw_score', 'pre_test_max_score', 'post_test_raw_score', 'post_test_max_score'];
        var scores = ['ocean_e', 'ocean_a', 'ocean_c', 'ocean_n', 'ocean_o'];
        var items = [];
        for (var i = 1; i <= 50; i++) { items.push('item_' + (i < 10 ? '0' : '') + i); }

        var headers = base.concat(scores, ['ocean_submitted_at', 'ocean_attempts', 'ocean_scoring_key'], items);

        var lines = [headers.join(',')];
        state.cohort.forEach(function (row) {
            var key = String(row.email || '').toLowerCase();
            var result = latest[key] || {};
            var answers = Array.isArray(result.responses) ? result.responses : [];
            var values = base.map(function (k) { return row[k]; })
                .concat(scores.map(function (k) { return result[k]; }))
                .concat([result.submitted_at, attempts[key] || 0, result.scoring_key])
                .concat(items.map(function (_, idx) { return answers[idx]; }));
            lines.push(values.map(toCsvValue).join(','));
        });

        var blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
        var url = URL.createObjectURL(blob);
        var link = document.createElement('a');
        var stamp = new Date().toISOString().slice(0, 10);

        link.href = url;
        link.download = 'pia-cohort-' + stamp + '.csv';
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);

        toastOk('Export ready', state.cohort.length + ' rows written to pia-cohort-' + stamp +
            '.csv, with each student’s current assessment result.');
    }

    /* ========================================= 16. MATH TASK BANK ====== */

    /* The question bank and the adaptive rules per topic (view "mathtask").
       Tables and access: migration 0028 -- admin only, reads included,
       because every row carries its answers.

       Ported from a team member's standalone page (list-equation.js). Kept:
       the question_bank / app_config reads and writes with the same column
       names, the hint JSON ({defaultHint, steps: [{prompt, answer, hint1,
       hint2, hint3}]}), the sentence generator for all three topics, the
       bulk points update with its mixed-points warning, and one max_points
       for every topic. Changed on the way in:
         * the mastery slider set ALL three topics to the value on screen,
           and ran on every topic switch -- so switching topics silently
           copied one threshold onto the others. Each topic now keeps its own,
           as the three app_config columns intend.
         * unsaved edits to one topic's rules survive switching topics; Save
           writes all three.
         * bulk points saved on 'change', so tabbing out of the field could
           overwrite every question. It now takes an explicit Apply.
         * rows are built with textContent and .value; no stored text reaches
           innerHTML, and ids travel in data attributes, not inline onclick.

       Loaded once at boot and by the Refresh button -- NOT by refreshAll(),
       which the realtime roster feed calls on every profile change. */

    var QB_TOPICS = {
        EASY: { num: 1, short: 'Finding %', title: 'Finding a percentage' },
        MEDIUM: { num: 2, short: '% Increase', title: 'Percentage increase' },
        HARD: { num: 3, short: '% Decrease', title: 'Percentage decrease' }
    };
    var QB_ORDER = ['EASY', 'MEDIUM', 'HARD'];
    var QB_POINTS_MAX = 500;
    var QB_COLUMNS = 'id, difficulty, question, final_answer, hint, points';

    function qbDefaultRules() { return { mastery: 80, minQuestions: 3, maxErrors: 3 }; }

    var qb = {
        topic: 'EASY',
        status: 'idle',          /* idle | loading | ready | missing | error */
        error: '',
        bank: { EASY: [], MEDIUM: [], HARD: [] },
        rules: { EASY: qbDefaultRules(), MEDIUM: qbDefaultRules(), HARD: qbDefaultRules() },
        maxPoints: 10,
        dirty: false,
        editingId: null,
        drafts: [],
        stepSeq: 0,
        busy: { edit: false, config: false, bulk: false, drafts: false },
        renderPending: false
    };

    function qbTopicLabel(topic) {
        var t = QB_TOPICS[topic];
        return 'Topic ' + t.num + ' · ' + t.title;
    }

    /* ---- 16.1 Data shape ---- */

    /* The hint column holds JSON; rows from before the step builder hold a
       plain sentence, which becomes the default hint with no steps. */
    function qbParseHint(hintStr) {
        if (!hintStr) { return { defaultHint: '', steps: [] }; }
        try {
            var parsed = JSON.parse(hintStr);
            if (parsed && typeof parsed === 'object') {
                return {
                    defaultHint: typeof parsed.defaultHint === 'string' ? parsed.defaultHint : '',
                    steps: Array.isArray(parsed.steps) ? parsed.steps.map(qbCleanStep) : []
                };
            }
        } catch (err) { /* legacy plain-text hint */ }
        return { defaultHint: String(hintStr), steps: [] };
    }

    function qbCleanStep(step) {
        var s = step || {};
        return {
            prompt: String(s.prompt || ''), answer: String(s.answer || ''),
            hint1: String(s.hint1 || ''), hint2: String(s.hint2 || ''), hint3: String(s.hint3 || '')
        };
    }

    /* The default hint is step 1's first hint. With no such hint, the row's
       existing default is kept: an older question whose only hint is plain
       text must not lose it just because it was edited. */
    function qbSerializeHint(steps, keepDefault) {
        var fromSteps = steps.length ? steps[0].hint1 : '';
        return JSON.stringify({ defaultHint: fromSteps || keepDefault || '', steps: steps });
    }

    function qbFromRow(row) {
        var hint = qbParseHint(row.hint);
        return {
            id: row.id,
            topic: String(row.difficulty || 'EASY').toUpperCase(),
            q: row.question || '',
            final: row.final_answer || '',
            hint: hint.defaultHint,
            steps: hint.steps,
            points: toInt(row.points, 10)
        };
    }

    /* A whole number in 1..500, or null. */
    function qbPoints(raw) {
        var text = String(raw == null ? '' : raw).trim();
        if (!/^\d+$/.test(text)) { return null; }
        var n = parseInt(text, 10);
        return (n >= 1 && n <= QB_POINTS_MAX) ? n : null;
    }

    function qbIntIn(raw, min, max) {
        var text = String(raw == null ? '' : raw).trim();
        if (!/^\d+$/.test(text)) { return null; }
        var n = parseInt(text, 10);
        return (n >= min && n <= max) ? n : null;
    }

    /* The one value every question in the list shares, or null if mixed. */
    function qbUniformPoints(list) {
        if (!list.length) { return null; }
        var first = list[0].points;
        return list.every(function (q) { return q.points === first; }) ? first : null;
    }

    function qbMissingTable(error) {
        return !!error && (error.code === '42P01' || error.code === 'PGRST205' ||
            /does not exist|could not find the table/i.test(error.message || ''));
    }

    function qbStepSummary(item) {
        var steps = item.steps.length;
        if (!steps) { return 'No steps yet'; }
        var hints = item.steps.reduce(function (n, s) {
            return n + (s.hint1 ? 1 : 0) + (s.hint2 ? 1 : 0) + (s.hint3 ? 1 : 0);
        }, 0);
        return steps + (steps === 1 ? ' step' : ' steps') + ' · ' + hints + (hints === 1 ? ' hint' : ' hints');
    }

    /* ---- 16.2 Load ---- */

    async function loadMathTask() {
        if (qb.status === 'loading') { return; }
        var wasReady = qb.status === 'ready';
        qb.status = 'loading';
        if (!wasReady) { renderQbAll(); }

        var questions, config;
        try {
            var results = await Promise.all([
                sb.from('question_bank').select(QB_COLUMNS).order('id'),
                sb.from('app_config').select('*').eq('id', 1).maybeSingle()
            ]);
            questions = results[0];
            config = results[1];
        } catch (err) {
            questions = { error: { message: 'Could not reach the database.' } };
        }

        if (questions.error) {
            qb.status = qbMissingTable(questions.error) ? 'missing' : 'error';
            qb.error = friendlyDbError(questions.error, 'The question bank could not be loaded.');
            renderQbAll();
            return;
        }

        qb.bank = { EASY: [], MEDIUM: [], HARD: [] };
        (questions.data || []).forEach(function (row) {
            var item = qbFromRow(row);
            if (qb.bank[item.topic]) { qb.bank[item.topic].push(item); }
        });

        /* A missing config row keeps the defaults; unsaved edits are never
           overwritten by a refresh. */
        if (config && !config.error && config.data && !qb.dirty) {
            var c = config.data;
            QB_ORDER.forEach(function (topic) {
                var key = topic.toLowerCase();
                qb.rules[topic] = {
                    mastery: toInt(c[key + '_mastery'], 80),
                    minQuestions: toInt(c[key + '_min_questions'], 3),
                    maxErrors: toInt(c[key + '_max_errors'], 3)
                };
            });
            qb.maxPoints = toInt(c.max_points, 10);
        }

        qb.status = 'ready';
        qb.error = '';
        renderQbAll();
    }

    /* ---- 16.3 Render ---- */

    function renderQbAll() {
        renderQbChrome();
        renderQbTable();
        renderQbRules();
    }

    function renderQbChrome() {
        var topic = qb.topic;
        var ready = qb.status === 'ready';

        $$('[data-qb-topic]').forEach(function (btn) {
            var on = btn.getAttribute('data-qb-topic') === topic;
            btn.classList.toggle('is-active', on);
            btn.setAttribute('aria-pressed', String(on));
        });

        $('#qb-title').textContent = qbTopicLabel(topic);
        $('#qb-caption').textContent = 'Questions in ' + qbTopicLabel(topic);
        $('#qb-config-sub').textContent = 'Topic ' + QB_TOPICS[topic].num + ' · ' + QB_TOPICS[topic].short;

        $('#qb-add-btn').disabled = !ready;
        $('#qb-generate-btn').disabled = !ready;

        var total = QB_ORDER.reduce(function (n, t) { return n + qb.bank[t].length; }, 0);
        $('#nav-count-mathtask').textContent = ready ? String(total) : '—';
    }

    /* Never re-render under a field the admin is typing in; catch up as soon
       as focus leaves the table. */
    function renderQbTable() {
        var tbody = $('#qb-tbody');
        if (tbody.contains(document.activeElement) && qb.status === 'ready') {
            qb.renderPending = true;
            return;
        }
        qb.renderPending = false;

        var list = qb.bank[qb.topic];
        var ready = qb.status === 'ready';
        var loading = qb.status === 'idle' || qb.status === 'loading';
        var empty = $('#qb-empty');

        tbody.textContent = '';
        empty.classList.add('is-hidden');

        if (loading) {
            for (var i = 0; i < 3; i++) { tbody.appendChild(qbSkeletonRow()); }
            $('#qb-sub').textContent = 'Loading questions…';
        } else if (!ready) {
            empty.classList.remove('is-hidden');
            $('#qb-empty-title').textContent = qb.status === 'missing'
                ? 'The question bank is not set up yet'
                : 'The question bank could not be loaded';
            $('#qb-empty-desc').textContent = qb.status === 'missing'
                ? 'Run supabase/migrations/20260929_0028_math_task_bank.sql in the Supabase SQL Editor, then press Refresh.'
                : qb.error + ' Press Refresh to try again.';
            $('#qb-sub').textContent = 'Unavailable';
        } else if (!list.length) {
            empty.classList.remove('is-hidden');
            $('#qb-empty-title').textContent = 'No questions in this topic yet';
            $('#qb-empty-desc').textContent = '';
            $('#qb-sub').textContent = 'No questions';
        } else {
            var frag = document.createDocumentFragment();
            list.forEach(function (item, index) { frag.appendChild(qbRow(item, index)); });
            tbody.appendChild(frag);
            var withSteps = list.filter(function (q) { return q.steps.length > 0; }).length;
            $('#qb-sub').textContent = list.length + (list.length === 1 ? ' question' : ' questions') +
                ' · ' + withSteps + ' with steps';
        }

        renderQbToolbar();
    }

    function renderQbToolbar() {
        var list = qb.bank[qb.topic];
        var usable = qb.status === 'ready' && list.length > 0;
        var input = $('#qb-bulk-points');
        var uniform = qbUniformPoints(list);

        $('#qb-delete-all').disabled = !usable || qb.busy.bulk;
        $('#qb-bulk-apply').disabled = !usable || qb.busy.bulk;
        input.disabled = !usable;
        if (document.activeElement !== input) {
            input.value = uniform === null ? '' : String(uniform);
        }
        input.placeholder = usable && uniform === null ? 'Mixed' : '';
    }

    function qbCell(className) {
        var td = document.createElement('td');
        td.className = className;
        return td;
    }

    function qbRow(item, index) {
        var n = index + 1;
        var tr = document.createElement('tr');
        tr.className = 'qb-row';
        tr.setAttribute('data-id', String(item.id));

        var tdQ = qbCell('qb-cell-q');
        var q = document.createElement('p');
        q.className = 'qb-q';
        q.id = 'qb-q-' + item.id;
        q.textContent = item.q || 'Untitled question';
        q.title = item.q || '';
        var meta = document.createElement('p');
        meta.className = 'qb-meta';
        meta.textContent = qbStepSummary(item);
        tdQ.append(q, meta);

        tr.append(
            tdQ,
            qbInlineField(item, 'final', 'Final answer', 'qb-cell-answer'),
            qbInlineField(item, 'points', 'Points', 'qb-cell-points'),
            qbActions(item, n)
        );
        return tr;
    }

    function qbInlineField(item, field, labelText, cellClass) {
        var td = qbCell(cellClass);
        var id = 'qb-' + field + '-' + item.id;

        var label = document.createElement('label');
        label.className = 'qb-cell-label';
        label.htmlFor = id;
        label.textContent = labelText;

        var input = document.createElement('input');
        input.className = 'input qb-inline' + (field === 'points' ? ' tnum' : '');
        input.id = id;
        input.setAttribute('data-qb-field', field);
        input.setAttribute('aria-describedby', 'qb-q-' + item.id);
        input.autocomplete = 'off';

        if (field === 'points') {
            input.type = 'number';
            input.min = '1';
            input.max = String(QB_POINTS_MAX);
            input.step = '1';
            input.inputMode = 'numeric';
            input.value = String(item.points);
        } else {
            input.type = 'text';
            input.maxLength = 200;
            input.placeholder = '—';
            input.value = item.final;
        }

        td.append(label, input);
        return td;
    }

    function qbActions(item, n) {
        var td = qbCell('qb-cell-actions');
        var wrap = document.createElement('div');
        wrap.className = 'row-actions';

        [['edit', 'pencil', 'Edit question ' + n, 'Edit question, steps and hints'],
         ['delete', 'trash', 'Delete question ' + n, 'Delete question']].forEach(function (spec) {
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn-icon';
            btn.setAttribute('data-qb-act', spec[0]);
            btn.setAttribute('aria-label', spec[2]);
            btn.title = spec[3];
            btn.innerHTML = icon(spec[1]);
            wrap.appendChild(btn);
        });

        td.appendChild(wrap);
        return td;
    }

    /* Same markup, same boxes as a real row: nothing moves when data lands. */
    function qbSkeletonRow() {
        var tr = document.createElement('tr');
        tr.className = 'qb-row';
        tr.setAttribute('aria-hidden', 'true');
        tr.innerHTML =
            '<td class="qb-cell-q">' +
                '<div class="qb-q qb-skel-q"><span class="skeleton skeleton-line" style="width:92%"></span>' +
                '<span class="skeleton skeleton-line" style="width:64%"></span></div>' +
                '<div class="qb-meta"><span class="skeleton qb-skel-meta"></span></div>' +
            '</td>' +
            '<td class="qb-cell-answer"><span class="qb-cell-label">&nbsp;</span><span class="skeleton qb-skel-field"></span></td>' +
            '<td class="qb-cell-points"><span class="qb-cell-label">&nbsp;</span><span class="skeleton qb-skel-field"></span></td>' +
            '<td class="qb-cell-actions"><div class="row-actions"><span class="skeleton qb-skel-btn"></span>' +
                '<span class="skeleton qb-skel-btn"></span></div></td>';
        return tr;
    }

    function renderQbRules() {
        var ready = qb.status === 'ready';
        var rules = qb.rules[qb.topic];
        var range = $('#qb-mastery');

        range.value = String(rules.mastery);
        qbPaintRange();
        $('#qb-min-questions').value = rules.minQuestions == null ? '' : String(rules.minQuestions);
        $('#qb-max-errors').value = rules.maxErrors == null ? '' : String(rules.maxErrors);
        if (document.activeElement !== $('#qb-max-points')) {
            $('#qb-max-points').value = qb.maxPoints == null ? '' : String(qb.maxPoints);
        }

        ['#qb-mastery', '#qb-min-questions', '#qb-max-errors', '#qb-max-points'].forEach(function (sel) {
            $(sel).disabled = !ready;
        });
        $('#qb-config-save').disabled = !ready || qb.busy.config;
        $('#qb-dirty').classList.toggle('is-on', qb.dirty);
    }

    function qbPaintRange() {
        var range = $('#qb-mastery');
        var min = toInt(range.min, 50), max = toInt(range.max, 100), val = toInt(range.value, 80);
        range.style.setProperty('--qb-fill', (((val - min) / (max - min)) * 100) + '%');
        $('#qb-mastery-out').textContent = val + '%';
        range.setAttribute('aria-valuetext', val + ' percent');
    }

    function qbSwitchTopic(topic) {
        if (!QB_TOPICS[topic] || topic === qb.topic) { return; }
        qb.topic = topic;
        clearFormErrors('qb-config-form');
        setFieldError('qb-bulk-points', '');
        renderQbAll();
    }

    /* ---- 16.4 Inline edits: final answer and points ---- */

    /* Saves on one row run one after another. Editing the points while the
       answer is still saving used to be dropped without a word; now it waits
       its turn and compares against what the first save left behind. */
    var qbRowQueue = {};

    function qbSaveInline(input) {
        var tr = input.closest('.qb-row');
        var id = toInt(tr && tr.getAttribute('data-id'), null);
        if (id === null) { return; }
        var run = (qbRowQueue[id] || Promise.resolve()).then(function () { return qbSaveInlineNow(input, id); });
        qbRowQueue[id] = run.catch(function () { /* reported inside */ });
    }

    function qbRowEl(id) { return $('#qb-tbody .qb-row[data-id="' + id + '"]'); }

    async function qbSaveInlineNow(input, id) {
        var item = null;
        QB_ORDER.some(function (t) {
            item = qb.bank[t].find(function (q) { return q.id === id; }) || null;
            return !!item;
        });
        if (!item) { return; }

        var field = input.getAttribute('data-qb-field');
        var patch, next;

        if (field === 'points') {
            next = qbPoints(input.value);
            if (next === null) {
                input.value = String(item.points);
                toastErr('Points not saved', 'Use a whole number from 1 to ' + QB_POINTS_MAX + '.');
                return;
            }
            if (next === item.points) { return; }
            patch = { points: next };
        } else {
            next = input.value.trim();
            input.value = next;
            if (next === item.final) { return; }
            patch = { final_answer: next };
        }

        var row = qbRowEl(id);
        if (row) { row.setAttribute('aria-busy', 'true'); }
        var res = await sb.from('question_bank').update(patch).eq('id', id).select('id');
        row = qbRowEl(id);
        if (row) { row.removeAttribute('aria-busy'); }

        if (res.error || !res.data || !res.data.length) {
            input.value = field === 'points' ? String(item.points) : item.final;
            toastErr('Not saved', friendlyDbError(res.error,
                'This question may have been deleted elsewhere. Press Refresh to check.'));
            return;
        }

        if (field === 'points') { item.points = next; renderQbToolbar(); }
        else { item.final = next; }
    }

    /* ---- 16.5 Delete one, delete all, bulk points ---- */

    function qbShort(text) {
        var t = String(text || '').trim();
        return t.length > 90 ? t.slice(0, 87) + '…' : t;
    }

    /* After a row disappears, focus goes somewhere that still exists. The
       dialog restores focus on a 160ms timer; this runs after it. */
    function qbRefocus(index) {
        setTimeout(function () {
            var rows = $$('#qb-tbody .qb-row');
            var row = rows[Math.min(index, rows.length - 1)];
            var target = row ? $('[data-qb-act="edit"]', row) : $('#qb-add-btn');
            if (target) { target.focus({ preventScroll: true }); }
        }, 220);
    }

    async function qbDeleteOne(id, btn) {
        var list = qb.bank[qb.topic];
        var index = list.findIndex(function (q) { return q.id === id; });
        if (index === -1) { return; }
        var item = list[index];

        var ok = await confirmAction({
            title: 'Delete question',
            subtitle: qbTopicLabel(qb.topic),
            heading: 'Delete question ' + (index + 1) + '?',
            message: '“' + qbShort(item.q) + '” and its steps and hints will be removed. This cannot be undone.',
            confirmLabel: 'Delete question'
        });
        if (!ok) { return; }

        var release = setBusy(btn, '…');
        var res = await sb.from('question_bank').delete().eq('id', id);
        release();

        if (res.error) {
            toastErr('Question not deleted', friendlyDbError(res.error, 'Delete rejected.'));
            return;
        }

        qb.bank[qb.topic] = qb.bank[qb.topic].filter(function (q) { return q.id !== id; });
        renderQbTable();
        renderQbChrome();
        toastOk('Question deleted', qbTopicLabel(qb.topic) + ' now has ' + qb.bank[qb.topic].length + '.');
        qbRefocus(index);
    }

    async function qbDeleteAll() {
        var topic = qb.topic;
        var count = qb.bank[topic].length;
        if (!count || qb.busy.bulk) { return; }

        var ok = await confirmAction({
            title: 'Delete all questions',
            subtitle: qbTopicLabel(topic),
            heading: 'Delete every question in topic ' + QB_TOPICS[topic].num + '?',
            message: 'All ' + count + ' questions in “' + QB_TOPICS[topic].title +
                '”, with their steps and hints, will be removed. The other topics are not touched. This cannot be undone.',
            confirmLabel: 'Delete ' + count
        });
        if (!ok) { return; }

        qb.busy.bulk = true;
        var release = setBusy($('#qb-delete-all'), 'Deleting…');
        var res = await sb.from('question_bank').delete().eq('difficulty', topic);
        release();
        qb.busy.bulk = false;

        if (res.error) {
            renderQbToolbar();
            toastErr('Questions not deleted', friendlyDbError(res.error, 'Delete rejected.'));
            return;
        }

        qb.bank[topic] = [];
        renderQbAll();
        toastOk('Topic cleared', count + ' questions removed from ' + qbTopicLabel(topic) + '.');
        setTimeout(function () { $('#qb-add-btn').focus({ preventScroll: true }); }, 220);
    }

    async function qbApplyBulk(event) {
        event.preventDefault();
        if (qb.busy.bulk) { return; }

        var topic = qb.topic;
        var list = qb.bank[topic];
        if (!list.length) { return; }

        var value = qbPoints($('#qb-bulk-points').value);
        if (!setFieldError('qb-bulk-points', value === null
            ? 'Use a whole number from 1 to ' + QB_POINTS_MAX + '.' : '')) {
            $('#qb-bulk-points').focus();
            return;
        }

        var uniform = qbUniformPoints(list);
        if (uniform === value) {
            toastOk('Nothing to change', 'Every question here is already worth ' + value + '.');
            return;
        }

        /* Some questions carry their own value: say so before replacing it. */
        if (uniform === null) {
            var ok = await confirmAction({
                title: 'Replace custom points',
                subtitle: qbTopicLabel(topic),
                heading: 'Set all ' + list.length + ' questions to ' + value + ' points?',
                message: 'Some questions in this topic have their own point value. Applying this replaces every one of them with ' +
                    value + '.',
                confirmLabel: 'Replace all'
            });
            if (!ok) { return; }
        }

        var ids = list.map(function (q) { return q.id; });
        qb.busy.bulk = true;
        var release = setBusy($('#qb-bulk-apply'), 'Applying…');
        var res = await sb.from('question_bank').update({ points: value }).in('id', ids);
        release();
        qb.busy.bulk = false;

        if (res.error) {
            renderQbToolbar();
            toastErr('Points not updated', friendlyDbError(res.error, 'Update rejected.'));
            return;
        }

        list.forEach(function (q) { q.points = value; });
        renderQbTable();
        toastOk('Points updated', 'Every question in ' + qbTopicLabel(topic) + ' is now worth ' + value + '.');
    }

    /* ---- 16.6 Add / edit dialog ---- */

    function qbStepList() { return $('#qb-steps'); }

    function qbAddStep(data, focus) {
        var node = $('#tpl-qb-step').content.firstElementChild.cloneNode(true);
        var seq = ++qb.stepSeq;
        var step = qbCleanStep(data);

        $$('[data-step]', node).forEach(function (input) {
            var key = input.getAttribute('data-step');
            input.id = 'qb-step-' + seq + '-' + key;
            input.value = step[key] || '';
        });
        $$('label[data-for]', node).forEach(function (label) {
            label.htmlFor = 'qb-step-' + seq + '-' + label.getAttribute('data-for');
        });

        qbStepList().appendChild(node);
        qbRenumberSteps();
        if (focus) { $('[data-step="prompt"]', node).focus(); }
    }

    function qbRenumberSteps() {
        var steps = $$('.qb-step', qbStepList());
        steps.forEach(function (li, i) {
            $('.qb-step-num', li).textContent = String(i + 1);
            var remove = $('[data-qb-remove-step]', li);
            remove.setAttribute('aria-label', 'Remove step ' + (i + 1));
            /* At least one step stays, as in the original builder. */
            remove.disabled = steps.length <= 1;
        });
    }

    function qbReadSteps() {
        return $$('.qb-step', qbStepList()).map(function (li) {
            var s = {};
            ['prompt', 'answer', 'hint1', 'hint2', 'hint3'].forEach(function (key) {
                s[key] = $('[data-step="' + key + '"]', li).value.trim();
            });
            return s;
        }).filter(function (s) {
            /* A step left completely blank is not saved. */
            return s.prompt || s.answer || s.hint1 || s.hint2 || s.hint3;
        });
    }

    function qbOpenEditor(id, trigger) {
        var item = id == null ? null : qb.bank[qb.topic].find(function (q) { return q.id === id; });
        if (id != null && !item) { return; }

        qb.editingId = item ? item.id : null;
        clearFormErrors('qb-edit-form');

        var index = item ? qb.bank[qb.topic].indexOf(item) + 1 : 0;
        $('#qb-edit-title').textContent = item ? 'Edit question ' + index : 'Add question';
        $('#qb-edit-sub').textContent = qbTopicLabel(qb.topic);
        $('#qb-edit-save').textContent = item ? 'Save changes' : 'Add question';

        var uniform = qbUniformPoints(qb.bank[qb.topic]);
        $('#qb-question').value = item ? item.q : '';
        $('#qb-final').value = item ? item.final : '';
        $('#qb-points').value = String(item ? item.points : (uniform || 10));

        qbStepList().textContent = '';
        var steps = item && item.steps.length ? item.steps : [null];
        steps.forEach(function (s) { qbAddStep(s, false); });

        openModal('modal-qb-edit', trigger);
        /* openModal lands on the first control, the close button; the
           problem text is where this dialog starts. */
        $('#qb-question').focus({ preventScroll: true });
    }

    async function qbSaveEditor(event) {
        event.preventDefault();
        if (qb.busy.edit) { return; }
        clearFormErrors('qb-edit-form');

        var question = $('#qb-question').value.trim();
        var finalAnswer = $('#qb-final').value.trim();
        var points = qbPoints($('#qb-points').value);

        var valid = true;
        valid = setFieldError('qb-question', question ? '' : 'Write the sentence problem.') && valid;
        valid = setFieldError('qb-points', points === null
            ? 'Use a whole number from 1 to ' + QB_POINTS_MAX + '.' : '') && valid;
        if (!valid) {
            var bad = $('#qb-edit-form .is-invalid');
            if (bad) { bad.focus(); }
            return;
        }

        var steps = qbReadSteps();
        var current = qb.editingId == null ? null
            : qb.bank[qb.topic].find(function (q) { return q.id === qb.editingId; });
        var payload = {
            question: question,
            final_answer: finalAnswer,
            hint: qbSerializeHint(steps, current ? current.hint : ''),
            points: points
        };

        qb.busy.edit = true;
        var release = setBusy($('#qb-edit-save'), 'Saving…');
        var editing = qb.editingId;
        var topic = qb.topic;
        var res = editing != null
            ? await sb.from('question_bank').update(payload).eq('id', editing).select(QB_COLUMNS).maybeSingle()
            : await sb.from('question_bank').insert([Object.assign({ difficulty: topic }, payload)])
                .select(QB_COLUMNS).single();
        release();
        qb.busy.edit = false;

        if (res.error || !res.data) {
            toastErr(editing != null ? 'Changes not saved' : 'Question not added',
                friendlyDbError(res.error, 'This question may have been deleted elsewhere. Press Refresh to check.'));
            return;
        }

        var saved = qbFromRow(res.data);
        var list = qb.bank[topic];
        if (editing != null) {
            var at = list.findIndex(function (q) { return q.id === editing; });
            if (at !== -1) { list[at] = saved; } else { list.push(saved); }
        } else {
            list.push(saved);
        }

        closeModal('modal-qb-edit');
        renderQbTable();
        renderQbChrome();
        /* The row was rebuilt, so the Edit button that opened the dialog is
           gone; its replacement takes focus instead. */
        if (editing != null) {
            setTimeout(function () {
                var row = qbRowEl(editing);
                var btn = row && $('[data-qb-act="edit"]', row);
                if (btn) { btn.focus({ preventScroll: true }); }
            }, 220);
        }
        toastOk(editing != null ? 'Question updated' : 'Question added',
            qbTopicLabel(topic) + ' · ' + (steps.length ? qbStepSummary(saved) : 'no steps'));
    }

    /* ---- 16.7 Auto-generate ----
       The generator is the original, unchanged in what it produces: two
       templates for topic 1, one each for topics 2 and 3, every problem with
       its worked steps and three tiers of hints. `pts` is passed in rather
       than read from the page. */
    function generateRandomSentenceQuestion(diff, pts) {
        var pick = function (arr) { return arr[Math.floor(Math.random() * arr.length)]; };

        if (diff === 'EASY') {
            var templates = [
                function () {
                    var total = Math.floor(Math.random() * 8 + 2) * 50;
                    var pct = pick([10, 20, 25, 30, 40, 50, 60, 75]);
                    var result = (total * pct) / 100;
                    var act = pick(['sports club', 'art workshop', 'math olympiad', 'science fair']);
                    return {
                        q: 'In a school of ' + total + ' students, ' + pct + '% joined the ' + act + '. How many students joined?',
                        final: String(result),
                        points: pts,
                        steps: [
                            { prompt: 'Step 1: Convert ' + pct + '% into a decimal.', answer: String(pct / 100),
                              hint1: 'Divide percentage by 100 to convert to decimal.',
                              hint2: pct + ' / 100', hint3: pct + ' / 100 = ' + (pct / 100) },
                            { prompt: 'Step 2: Multiply decimal (' + (pct / 100) + ') by total students (' + total + ').',
                              answer: String(result),
                              hint1: 'Multiply decimal value by total number of students.',
                              hint2: (pct / 100) + ' * ' + total, hint3: (pct / 100) + ' * ' + total + ' = ' + result }
                        ]
                    };
                },
                function () {
                    var price = pick([500, 800, 1000, 1200, 1500, 2000]);
                    var pct = pick([10, 15, 20, 25, 30, 50]);
                    var discount = (price * pct) / 100;
                    var item = pick(['jacket', 'pair of shoes', 'backpack', 'watch']);
                    return {
                        q: 'A ' + item + ' originally priced at PHP ' + price.toLocaleString() + ' is on sale with a ' + pct +
                            '% discount. What is the discount amount in PHP?',
                        final: String(discount),
                        points: pts,
                        steps: [
                            { prompt: 'Step 1: Convert ' + pct + '% into decimal form.', answer: String(pct / 100),
                              hint1: 'Divide the rate by 100.', hint2: pct + ' / 100', hint3: pct + ' / 100 = ' + (pct / 100) },
                            { prompt: 'Step 2: Calculate discount amount by multiplying ' + price + ' by ' + (pct / 100) + '.',
                              answer: String(discount),
                              hint1: 'Multiply original price by percentage in decimal.',
                              hint2: price + ' * ' + (pct / 100), hint3: price + ' * ' + (pct / 100) + ' = ' + discount }
                        ]
                    };
                }
            ];
            return pick(templates)();
        }

        if (diff === 'MEDIUM') {
            var orig = Math.floor(Math.random() * 10 + 5) * 100;
            var pctUp = pick([10, 20, 25, 30, 50]);
            var inc = (orig * pctUp) / 100;
            var newPrice = orig + inc;
            var thing = pick(['smartphone', 'bicycle', 'monitor', 'guitar']);
            return {
                q: 'A ' + thing + ' originally priced at PHP ' + orig.toLocaleString() + ' increased in price to PHP ' +
                    newPrice.toLocaleString() + '. What is the percentage increase?',
                final: pctUp + '%',
                points: pts,
                steps: [
                    { prompt: 'Step 1: Calculate the amount of price increase (' + newPrice + ' - ' + orig + ').',
                      answer: String(inc), hint1: 'Subtract original price from new price.',
                      hint2: newPrice + ' - ' + orig, hint3: newPrice + ' - ' + orig + ' = ' + inc },
                    { prompt: 'Step 2: Divide increase (' + inc + ') by original price (' + orig + ').',
                      answer: String(inc / orig), hint1: 'Divide increase amount by original price.',
                      hint2: inc + ' / ' + orig, hint3: inc + ' / ' + orig + ' = ' + (inc / orig) },
                    { prompt: 'Step 3: Convert decimal (' + (inc / orig) + ') to percentage by multiplying by 100.',
                      answer: pctUp + '%', hint1: 'Multiply decimal by 100 and add % sign.',
                      hint2: (inc / orig) + ' * 100', hint3: (inc / orig) + ' * 100 = ' + pctUp + '%' }
                ]
            };
        }

        /* HARD: percentage decrease */
        var base = Math.floor(Math.random() * 10 + 10) * 100;
        var pctDown = pick([10, 20, 25, 30, 40, 50]);
        var dec = (base * pctDown) / 100;
        var sale = base - dec;
        var goods = pick(['television', 'tablet', 'pair of sneakers', 'camera']);
        return {
            q: 'An item (' + goods + ') originally priced at PHP ' + base.toLocaleString() + ' is marked down to PHP ' +
                sale.toLocaleString() + '. What is the percentage decrease?',
            final: pctDown + '%',
            points: pts,
            steps: [
                { prompt: 'Step 1: Calculate the amount of price decrease (' + base + ' - ' + sale + ').',
                  answer: String(dec), hint1: 'Subtract new sale price from original price.',
                  hint2: base + ' - ' + sale, hint3: base + ' - ' + sale + ' = ' + dec },
                { prompt: 'Step 2: Divide decrease (' + dec + ') by original price (' + base + ').',
                  answer: String(dec / base), hint1: 'Divide decrease amount by original price.',
                  hint2: dec + ' / ' + base, hint3: dec + ' / ' + base + ' = ' + (dec / base) },
                { prompt: 'Step 3: Convert decimal (' + (dec / base) + ') to percentage by multiplying by 100.',
                  answer: pctDown + '%', hint1: 'Multiply decimal by 100.',
                  hint2: (dec / base) + ' * 100', hint3: (dec / base) + ' * 100 = ' + pctDown + '%' }
            ]
        };
    }

    function qbOpenGenerator(trigger) {
        qb.drafts = [];
        $('#qb-gen-sub').textContent = qbTopicLabel(qb.topic);
        $('#qb-gen-status').textContent = '';
        renderQbDrafts();
        openModal('modal-qb-generate', trigger);
        $('#qb-gen-count').focus({ preventScroll: true });
    }

    function renderQbDrafts() {
        var list = $('#qb-previews');
        list.textContent = '';

        qb.drafts.forEach(function (draft, i) {
            var node = $('#tpl-qb-preview').content.firstElementChild.cloneNode(true);
            node.setAttribute('data-index', String(i));
            $('.qb-preview-num', node).textContent = String(i + 1);
            $('[data-qb-remove-preview]', node).setAttribute('aria-label', 'Remove draft ' + (i + 1));

            $$('[data-preview]', node).forEach(function (input) {
                var key = input.getAttribute('data-preview');
                input.id = 'qb-draft-' + i + '-' + key;
                input.value = String(draft[key] == null ? '' : draft[key]);
            });
            $$('label[data-for]', node).forEach(function (label) {
                label.htmlFor = 'qb-draft-' + i + '-' + label.getAttribute('data-for');
            });
            $('.qb-preview-meta', node).textContent = qbStepSummary(draft) + ' included — edit them after saving.';
            list.appendChild(node);
        });

        var n = qb.drafts.length;
        $('#qb-gen-empty').classList.toggle('is-hidden', n > 0);
        var save = $('#qb-gen-save');
        save.disabled = n === 0 || qb.busy.drafts;
        save.textContent = n ? 'Save ' + n + ' to bank' : 'Save to bank';
    }

    function qbGenerateDrafts(event) {
        event.preventDefault();
        var count = toInt($('#qb-gen-count').value, 5);
        var pts = qbUniformPoints(qb.bank[qb.topic]) || 10;
        qb.drafts = [];
        for (var i = 0; i < count; i++) { qb.drafts.push(generateRandomSentenceQuestion(qb.topic, pts)); }
        renderQbDrafts();
        $('#qb-gen-status').textContent = count + (count === 1 ? ' draft' : ' drafts') + ' ready to review.';
    }

    async function qbSaveDrafts() {
        if (qb.busy.drafts || !qb.drafts.length) { return; }

        for (var i = 0; i < qb.drafts.length; i++) {
            var d = qb.drafts[i];
            var pts = qbPoints(d.points);
            if (!String(d.q || '').trim() || pts === null) {
                var field = !String(d.q || '').trim() ? 'q' : 'points';
                var input = document.getElementById('qb-draft-' + i + '-' + field);
                if (input) { input.focus(); }
                toastErr('Draft ' + (i + 1) + ' needs a fix', field === 'q'
                    ? 'The problem statement is empty.'
                    : 'Points must be a whole number from 1 to ' + QB_POINTS_MAX + '.');
                return;
            }
        }

        var topic = qb.topic;
        var rows = qb.drafts.map(function (d) {
            return {
                difficulty: topic,
                question: String(d.q).trim(),
                final_answer: String(d.final || '').trim(),
                hint: qbSerializeHint(d.steps.map(qbCleanStep)),
                points: qbPoints(d.points)
            };
        });

        qb.busy.drafts = true;
        var release = setBusy($('#qb-gen-save'), 'Saving…');
        var res = await sb.from('question_bank').insert(rows).select(QB_COLUMNS);
        release();
        qb.busy.drafts = false;

        if (res.error || !res.data) {
            renderQbDrafts();
            toastErr('Drafts not saved', friendlyDbError(res.error, 'Insert rejected.'));
            return;
        }

        res.data.forEach(function (row) { qb.bank[topic].push(qbFromRow(row)); });
        qb.drafts = [];
        closeModal('modal-qb-generate');
        renderQbTable();
        renderQbChrome();
        toastOk(res.data.length + (res.data.length === 1 ? ' question saved' : ' questions saved'), qbTopicLabel(topic));
    }

    /* ---- 16.8 Adaptive rules ---- */

    function qbMarkDirty() {
        qb.dirty = true;
        $('#qb-dirty').classList.add('is-on');
    }

    async function qbSaveRules(event) {
        event.preventDefault();
        if (qb.busy.config || qb.status !== 'ready') { return; }
        clearFormErrors('qb-config-form');

        /* Every topic is checked, not only the one on screen: an invalid
           value typed into another topic takes the admin back there. */
        var fields = [['minQuestions', 'qb-min-questions', 'Solved to level up'],
                      ['maxErrors', 'qb-max-errors', 'Wrong to level down']];
        var order = [qb.topic].concat(QB_ORDER.filter(function (t) { return t !== qb.topic; }));

        for (var i = 0; i < order.length; i++) {
            for (var j = 0; j < fields.length; j++) {
                var value = qb.rules[order[i]][fields[j][0]];
                if (qbIntIn(value, 1, 10) === null) {
                    if (order[i] !== qb.topic) { qbSwitchTopic(order[i]); }
                    setFieldError(fields[j][1], 'Use a whole number from 1 to 10.');
                    $('#' + fields[j][1]).focus();
                    return;
                }
            }
        }

        var maxPoints = qbPoints(qb.maxPoints);
        if (maxPoints === null) {
            setFieldError('qb-max-points', 'Use a whole number from 1 to ' + QB_POINTS_MAX + '.');
            $('#qb-max-points').focus();
            return;
        }

        var row = { id: 1, max_points: maxPoints };
        QB_ORDER.forEach(function (topic) {
            var key = topic.toLowerCase();
            row[key + '_mastery'] = toInt(qb.rules[topic].mastery, 80);
            row[key + '_min_questions'] = toInt(qb.rules[topic].minQuestions, 3);
            row[key + '_max_errors'] = toInt(qb.rules[topic].maxErrors, 3);
        });

        qb.busy.config = true;
        var release = setBusy($('#qb-config-save'), 'Saving…');
        var res = await sb.from('app_config').upsert(row);
        release();
        qb.busy.config = false;

        if (res.error) {
            renderQbRules();
            toastErr('Rules not saved', friendlyDbError(res.error, 'Save rejected.'));
            return;
        }

        qb.dirty = false;
        qb.maxPoints = maxPoints;
        renderQbRules();
        toastOk('Rules saved', 'All three topics · max points ' + maxPoints + '.');
    }

    /* ---- 16.9 Wiring ---- */

    function initMathTask() {
        $$('[data-qb-topic]').forEach(function (btn) {
            btn.addEventListener('click', function () { qbSwitchTopic(btn.getAttribute('data-qb-topic')); });
        });

        var tbody = $('#qb-tbody');
        tbody.addEventListener('change', function (event) {
            var input = event.target.closest('[data-qb-field]');
            if (input) { qbSaveInline(input); }
        });
        /* Enter in an inline field saves it, like leaving the field does. */
        tbody.addEventListener('keydown', function (event) {
            if (event.key === 'Enter' && event.target.matches('[data-qb-field]')) {
                event.preventDefault();
                event.target.blur();
            }
        });
        tbody.addEventListener('click', function (event) {
            var btn = event.target.closest('[data-qb-act]');
            if (!btn) { return; }
            var row = btn.closest('.qb-row');
            var id = toInt(row && row.getAttribute('data-id'), null);
            if (id === null) { return; }
            if (btn.getAttribute('data-qb-act') === 'edit') { qbOpenEditor(id, btn); }
            else { qbDeleteOne(id, btn); }
        });
        tbody.addEventListener('focusout', function () {
            setTimeout(function () {
                if (qb.renderPending && !tbody.contains(document.activeElement)) { renderQbTable(); }
            }, 0);
        });

        $('#qb-add-btn').addEventListener('click', function () { qbOpenEditor(null, this); });
        $('#qb-generate-btn').addEventListener('click', function () { qbOpenGenerator(this); });
        $('#qb-delete-all').addEventListener('click', qbDeleteAll);
        $('#qb-bulk-form').addEventListener('submit', qbApplyBulk);
        $('#qb-bulk-points').addEventListener('input', function () { setFieldError('qb-bulk-points', ''); });

        /* Rules: every edit lands in the topic's own state at once, so
           switching topics never loses it. */
        $('#qb-mastery').addEventListener('input', function () {
            qb.rules[qb.topic].mastery = toInt(this.value, 80);
            qbPaintRange();
            qbMarkDirty();
        });
        [['#qb-min-questions', 'minQuestions'], ['#qb-max-errors', 'maxErrors']].forEach(function (spec) {
            $(spec[0]).addEventListener('input', function () {
                qb.rules[qb.topic][spec[1]] = this.value;
                setFieldError(this.id, '');
                qbMarkDirty();
            });
        });
        $('#qb-max-points').addEventListener('input', function () {
            qb.maxPoints = this.value;
            setFieldError(this.id, '');
            qbMarkDirty();
        });
        $('#qb-config-form').addEventListener('submit', qbSaveRules);

        $('#qb-edit-form').addEventListener('submit', qbSaveEditor);
        $('#qb-add-step').addEventListener('click', function () { qbAddStep(null, true); });
        qbStepList().addEventListener('click', function (event) {
            var btn = event.target.closest('[data-qb-remove-step]');
            if (!btn || btn.disabled) { return; }
            var li = btn.closest('.qb-step');
            var prev = li.previousElementSibling || li.nextElementSibling;
            li.remove();
            qbRenumberSteps();
            var target = prev ? $('[data-qb-remove-step]', prev) : $('#qb-add-step');
            (target && !target.disabled ? target : $('#qb-add-step')).focus();
        });
        ['qb-question', 'qb-points'].forEach(function (id) {
            $('#' + id).addEventListener('input', function () { setFieldError(id, ''); });
        });

        $('#qb-gen-form').addEventListener('submit', qbGenerateDrafts);
        $('#qb-gen-save').addEventListener('click', qbSaveDrafts);
        var previews = $('#qb-previews');
        previews.addEventListener('input', function (event) {
            var input = event.target.closest('[data-preview]');
            var li = input && input.closest('.qb-preview');
            if (!li) { return; }
            var draft = qb.drafts[toInt(li.getAttribute('data-index'), -1)];
            if (draft) { draft[input.getAttribute('data-preview')] = input.value; }
        });
        previews.addEventListener('click', function (event) {
            var btn = event.target.closest('[data-qb-remove-preview]');
            if (!btn) { return; }
            var index = toInt(btn.closest('.qb-preview').getAttribute('data-index'), -1);
            if (index < 0) { return; }
            qb.drafts.splice(index, 1);
            renderQbDrafts();
            var rest = $$('[data-qb-remove-preview]', previews);
            (rest[Math.min(index, rest.length - 1)] || $('#qb-gen-run')).focus();
            $('#qb-gen-status').textContent = 'Draft removed. ' + qb.drafts.length + ' left.';
        });

        renderQbAll();
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
    loadAudit = tracked('audit', loadAudit);
    loadSettings = tracked('settings', loadSettings);
    loadAdminDevices = tracked('admindevices', loadAdminDevices);
    loadMathTask = tracked('mathtask', loadMathTask);

    RETRY = {
        cohort: loadCohort, sections: loadSections, roster: loadRoster, stages: loadStageCounters,
        faculty: loadFaculty, admins: loadAdmins, audit: loadAudit, settings: loadSettings,
        admindevices: loadAdminDevices, mathtask: loadMathTask
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

        var hour = new Date().getHours();
        var greeting = 'Good evening';
        if (hour < 12) { greeting = 'Good morning'; }
        else if (hour < 18) { greeting = 'Good afternoon'; }

        $('#admin-name').textContent = name;
        $('#admin-email').textContent = email;
        $('#profile-name').textContent = name;
        $('#profile-email').textContent = email;
        $('#admin-initials').textContent = initialsOf(name, email);
        /* "Dr. Reyes" greeted as "Good morning, Dr." read as a typo. An
           honorific keeps the surname with it; otherwise the first name. */
        var parts = name.split(/\s+/);
        var short = /^(dr|prof|mr|mrs|ms|mx|sir|ma'?am|engr|atty)\.?$/i.test(parts[0]) && parts[1]
            ? parts[0] + ' ' + parts[parts.length - 1]
            : parts[0];
        $('#overview-greeting').textContent = greeting + ', ' + short;
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

        $('#register-student-form').addEventListener('submit', handleRegisterStudent);
        $('#edit-student-form').addEventListener('submit', handleUpdateStudent);
        $$('#edit-student-form [data-score-test]').forEach(function (input) {
            input.addEventListener('input', function () { paintScorePreview(input.getAttribute('data-score-test')); });
        });
        $('#add-professor-form').addEventListener('submit', handleRegisterProfessor);
        $('#add-admin-form').addEventListener('submit', handleAddAdmin);
        $('#admin-tbody').addEventListener('click', function (event) {
            var btn = event.target.closest('[data-admin-act]');
            if (!btn) { return; }
            var email = btn.getAttribute('data-email');
            if (btn.getAttribute('data-admin-act') === 'link') { resendAdminLink(email, btn); }
        });
        initChangePassword();
        $('#audit-open').addEventListener('click', openAuditLog);

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
        $('#revoke-all-btn').addEventListener('click', revokeAllStudentSessions);
        $('#signout-confirm').addEventListener('click', signOut);
        $('#device-limit-signout').addEventListener('click', signOut);

        $('#section-scores-btn').addEventListener('click', function () {
            var section = state.activeSection;
            closeModal('modal-section-details');
            setTimeout(function () { openScoresModal(section); }, 200);
        });

        $('#export-overview').addEventListener('click', exportCohortCsv);
        $('#export-roster').addEventListener('click', exportCohortCsv);
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
        PIAShell.initRail({ hasOpenModal: function () { return openLayers.length > 0; } });
        initRouter();
        initModals();
        initInfoTips();
        initRoster();
        initDrawerActions();
        initFaculty();
        initGates();
        initForms();
        initMathTask();
        initRetry();
        initScrollRegions();
        paintSkeletons();

        setBootText('Loading dashboard…');
        await initAdminIdentity(email);

        revealApp();

        /* --- Phase 3: DATA. A failure here shows the banner and keeps the
           verified admin on the page. --- */
        await refreshAll();
        applyDrilldownChrome();
        loadMathTask();

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
