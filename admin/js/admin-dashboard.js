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
 *   10. Stage controls and targeted access
 *   11. Settings and admin devices
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
        if (error.code === '23505' || /duplicate key|already exists/i.test(msg)) {
            return 'An account already uses this email. Only one account per email is allowed.';
        }
        if (error.code === '42501' || /permission denied|row-level security/i.test(msg)) {
            return 'You do not have permission for this action. Make sure you are signed in as an admin.';
        }
        return msg || fallback;
    }

    /* Pre/post test scores are 0–100. A mistyped 1000 silently corrupts the
       research data, and the teacher dashboard thresholds on < 70. */
    function parseScore(raw) {
        if (raw === null || raw === undefined || String(raw).trim() === '') {
            return { ok: true, value: null };
        }
        var n = parseFloat(raw);
        if (!Number.isFinite(n) || n < 0 || n > 100) { return { ok: false, value: null }; }
        return { ok: true, value: n };
    }

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
       admin_grant_stage — do not rename them. */
    var GATES = [
        { key: 'ocean', stage: 'Stage 1', title: 'OCEAN personality test', open: false,
          desc: 'Allows students to answer the Big Five Inventory. Responses are scored server-side.' },
        { key: 'char', stage: 'Stage 2', title: 'Character selection', open: false,
          desc: 'Allows the free-choice group to pick their preferred agent persona.' },
        { key: 'dash', stage: 'Stage 3', title: 'Tutoring dashboard', open: false,
          desc: 'Allows students to open the problem sets and begin a tutoring session.' }
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
        settings: 'Settings',
        mathtask: 'Math Task'
    };

    function switchView(view) {
        if (!VIEW_TITLES[view]) { view = 'overview'; }

        $$('[data-view-panel]').forEach(function (panel) {
            panel.classList.toggle('is-hidden', panel.getAttribute('data-view-panel') !== view);
        });
        $$('.nav-item').forEach(function (item) {
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
        $$('.nav-item').forEach(function (item) {
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
            $('#confirm-subtitle').textContent = options.subtitle || 'Please review before continuing.';
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
            roster: [['#student-tbody', 'rows', 7]],
            faculty: [['#faculty-tbody', 'rows', 5]],
            settings: [['#gates-grid', 'block'], ['#gate-summary', 'block']],
            admins: [['#admin-tbody', 'rows', 4]],
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
        return '<div aria-hidden="true"><div class="trait-top">' +
            '<span class="trait-name">' + sk('Section name') + '</span>' +
            '<span class="trait-val tnum">' + sk('00%') + '</span></div><div class="bar"></div></div>';
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
            '<p class="gate-desc">' + sk(gate.desc) + '</p>' +
            '<div class="gate-control"><span><span class="gate-control-label">' + sk('Global access') + '</span><br>' +
            '<span class="gate-control-sub">' + sk('Applies to every section') + '</span></span>' +
            '<span class="skeleton" style="width:44px;height:24px;border-radius:var(--r-pill)"></span></div></div>' +
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
        fill('#section-health', times(3, skeletonHealth));
        fill('#sections-grid', times(3, skeletonSectionCard));
        fill('#gates-grid', GATES.map(skeletonGate).join(''));
        fill('#student-tbody', skeletonRows(7, 6));
        fill('#faculty-tbody', skeletonRows(5, 4));
        fill('#admin-tbody', skeletonRows(4, 2));
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
        var both = await Promise.all([
            sb.from('profiles')
                .select(COHORT_COLUMNS)
                .neq('role', 'admin')
                .limit(2000),
            sb.from('ocean_submissions')
                .select('email')
                .limit(5000)
        ]);
        var res = both[0];
        var results = both[1];

        state.loading.cohort = false;

        if (res.error) { throw res.error; }
        if (results.error) { throw results.error; }

        state.resultEmails = {};
        (results.data || []).forEach(function (row) {
            state.resultEmails[String(row.email || '').toLowerCase()] = true;
        });

        state.cohort = res.data || [];
        renderKpis();
        renderPipeline();
        renderLiveSessions();
        renderSectionHealth();
        renderSections();
    }

    async function loadSections() {
        var res = await sb.from('sections').select('name').order('name', { ascending: true });
        if (res.error) { throw res.error; }

        state.sections = res.data || [];
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
            tbody.innerHTML = skeletonRows(7, 6);
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
            tbody.innerHTML = '<tr><td colspan="7"><div class="state-block region-error">' +
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

    /* settings holds one row per stage flag: stage_ocean / stage_char / stage_dash. */
    async function loadSettings() {
        var res = await sb.from('settings').select('key, value');
        if (res.error) { throw res.error; }

        (res.data || []).forEach(function (row) {
            if (!row.key || row.key.indexOf('stage_') !== 0) { return; }
            var key = row.key.replace('stage_', '');
            var gate = GATES.filter(function (g) { return g.key === key; })[0];
            if (gate) { gate.open = (row.value === true || row.value === 'true'); }
        });

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
        $('#kpi-enrolled-foot').textContent = 'Across ' + state.sections.length + ' section' +
            (state.sections.length === 1 ? '' : 's');
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

    function renderLiveSessions() {
        var rows = state.cohort
            .filter(function (s) { return stageOf(s) && s.stage_started_at; })
            .sort(function (a, b) { return new Date(a.stage_started_at) - new Date(b.stage_started_at); })
            .slice(0, 6);

        var tbody = $('#live-tbody');

        if (!rows.length) {
            tbody.innerHTML = '<tr><td colspan="4">' +
                '<div class="state-block" style="min-height:180px">' +
                '<span class="state-glyph">' + icon('clock', 'icon-lg') + '</span>' +
                '<p class="state-title">No sessions running</p>' +
                '<p class="state-desc">Students appear here as soon as they enter a stage.</p>' +
                '</div></td></tr>';
            return;
        }

        tbody.innerHTML = rows.map(function (s) {
            return '' +
                '<tr data-started-at="' + esc(s.stage_started_at) + '">' +
                '<td>' + userCell(s) + '</td>' +
                '<td class="muted">' + esc(s.section || '—') + '</td>' +
                '<td>' + stageBadge(stageOf(s)) + '</td>' +
                '<td class="duration-cell" data-duration>' + esc(formatDuration(s.stage_started_at)) + '</td>' +
                '</tr>';
        }).join('');
    }

    function renderGateSummary() {
        $('#gate-summary').innerHTML = GATES.map(function (gate) {
            return '' +
                '<div class="device-row">' +
                '<span class="dot ' + (gate.open ? 'dot-live' : 'dot-off') + '"></span>' +
                '<div class="device-text">' +
                '<p class="device-name">' + esc(gate.title) + '</p>' +
                '<p class="device-meta">' + esc(gate.stage) + '</p>' +
                '</div>' +
                '<span class="badge ' + (gate.open ? 'badge-accent' : '') + '">' +
                (gate.open ? 'Open' : 'Closed') + '</span>' +
                '</div>';
        }).join('');
    }

    function renderSectionHealth() {
        var container = $('#section-health');
        if (!state.sections.length) {
            container.innerHTML = '<p class="state-desc">No sections yet.</p>';
            return;
        }

        container.innerHTML = state.sections.map(function (section) {
            var members = state.cohort.filter(function (s) { return s.section === section.name; });
            var done = members.filter(hasCurrentResult).length;
            var share = pct(done, members.length);
            return '' +
                '<div>' +
                '<div class="trait-top">' +
                '<span class="trait-name">' + esc(section.name) + '</span>' +
                '<span class="trait-val tnum">' + share + '%</span>' +
                '</div>' +
                '<div class="bar"><div class="bar-fill" style="width:' + share + '%"></div></div>' +
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
                '<p class="state-desc">Create a section before registering students — every participant must belong to one.</p>' +
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
                '<p class="state-desc">Register a participant and assign them to ' + esc(sectionName) + '.</p>' +
                '</div></td></tr>';
            return;
        }

        $('#section-students-tbody').innerHTML = students.map(function (s) {
            var condition = CONDITIONS[s.group_type] || { short: s.group_type || '—', badge: '' };
            var active = (s.status || '') === 'active';
            return '' +
                '<tr>' +
                '<td>' + userCell(s) + '</td>' +
                '<td><span class="badge ' + condition.badge + '">' + esc(condition.short) + '</span></td>' +
                '<td><span class="badge ' + (active ? 'badge-accent' : '') + '">' +
                '<span class="dot ' + (active ? 'dot-live' : 'dot-off') + '"></span>' +
                (active ? 'Active' : 'Inactive') + '</span></td>' +
                '<td class="tnum muted">' + esc(s.pre_test_score == null ? '—' : s.pre_test_score) + '</td>' +
                '<td class="tnum muted">' + esc(s.post_test_score == null ? '—' : s.post_test_score) + '</td>' +
                '</tr>';
        }).join('');
    }

    /* ============================================== 7. STUDENT ROSTER === */

    var ROSTER_HEADS = {
        default:
            '<tr><th>Student</th><th>Section</th><th>Condition</th><th>Stage</th>' +
            '<th>Pre-test</th><th>Devices</th><th class="col-right col-w-actions">Actions</th></tr>',
        'Active Game':
            '<tr><th>Student</th><th>Problem</th><th>Difficulty</th><th>Hints</th>' +
            '<th>Streak</th><th>Duration</th><th class="col-right col-w-actions">Actions</th></tr>',
        stage:
            '<tr><th>Student</th><th>Section</th><th>Activity</th><th>Duration</th>' +
            '<th class="col-right col-w-actions">Actions</th></tr>'
    };

    /* Edit only. Deleting a participant destroys collected responses, so it
       lives one deliberate step away — inside the profile drawer, where the
       admin has the student's name, section and progress in front of them.
       A trash icon sitting inches from a row you click to open that drawer is
       an accident waiting to happen, and it duplicated an action that was
       already there. */
    function rosterActions(email) {
        return '' +
            '<td class="col-right"><span class="row-actions">' +
            '<button class="btn-icon" title="Edit participant" data-row-act="edit" data-email="' + esc(email) + '">' +
            icon('pencil', 'icon-sm') + '</button>' +
            '</span></td>';
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
            var email = s.email;
            var started = s.stage_started_at || '';

            if (drill === 'Active Game') {
                return '' +
                    '<tr class="is-clickable" data-student="' + esc(email) + '" data-started-at="' + esc(started) + '">' +
                    '<td>' + userCell(s) + '</td>' +
                    '<td class="tnum muted">Question ' + toInt(s.current_problem, 1) + '</td>' +
                    '<td><span class="badge badge">' + esc(s.current_difficulty || 'Normal') + '</span></td>' +
                    '<td class="tnum muted">' + toInt(s.hints_used, 0) + '</td>' +
                    '<td class="tnum muted">' + toInt(s.consecutive_correct, 0) + '</td>' +
                    '<td class="duration-cell" data-duration>' + esc(formatDuration(started)) + '</td>' +
                    rosterActions(email) +
                    '</tr>';
            }

            if (drill) {
                var activity = 'Reading instructions';
                if (drill === 'OCEAN') { activity = 'Answering item ' + toInt(s.ocean_current_item, 1) + '/50'; }
                if (drill === 'Character Selection') { activity = 'Browsing personas'; }
                if (drill === 'Tutoring Dashboard') { activity = 'Browsing dashboard'; }

                return '' +
                    '<tr class="is-clickable" data-student="' + esc(email) + '" data-started-at="' + esc(started) + '">' +
                    '<td>' + userCell(s) + '</td>' +
                    '<td class="muted">' + esc(s.section || '—') + '</td>' +
                    '<td><span class="badge badge-accent">' + esc(activity) + '</span></td>' +
                    '<td class="duration-cell" data-duration>' + esc(formatDuration(started)) + '</td>' +
                    rosterActions(email) +
                    '</tr>';
            }

            var condition = CONDITIONS[s.group_type] || { short: s.group_type || '—', badge: '' };
            var used = (s.active_devices || []).length;
            var limit = toInt(s.max_devices, 1);
            var deviceTone = used >= limit && used > 0 ? 'badge-warn' : '';

            return '' +
                '<tr class="is-clickable" data-student="' + esc(email) + '" data-started-at="' + esc(started) + '">' +
                '<td>' + userCell(s) + '</td>' +
                '<td class="muted">' + esc(s.section || '—') + '</td>' +
                '<td><span class="badge ' + condition.badge + '">' + esc(condition.short) + '</span></td>' +
                '<td>' + stageBadge(stageOf(s)) + '</td>' +
                '<td class="tnum muted">' + esc(s.pre_test_score == null ? '—' : s.pre_test_score) + '</td>' +
                '<td><span class="badge ' + deviceTone + ' tnum">' + used + ' / ' + limit + '</span></td>' +
                rosterActions(email) +
                '</tr>';
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

        $$('[data-stage-filter]').forEach(function (tile) {
            tile.addEventListener('click', function () {
                var key = tile.getAttribute('data-stage-filter');
                var isSame = state.filters.stage === key;
                state.filters.stage = isSame ? null : key;

                $$('[data-stage-filter]').forEach(function (t) {
                    t.classList.toggle('is-active', !isSame && t === tile);
                });

                applyDrilldownChrome();
                state.page = 1;
                loadRoster();
            });
        });

        $('#clear-stage-filter').addEventListener('click', function () {
            state.filters.stage = null;
            $$('[data-stage-filter]').forEach(function (t) { t.classList.remove('is-active'); });
            applyDrilldownChrome();
            state.page = 1;
            loadRoster();
        });

        $('#reset-filters').addEventListener('click', function () {
            state.filters = { group: 'all', sub: 'all', stage: null, search: '' };
            $('#student-search').value = '';
            $$('[data-group-filter]').forEach(function (b) {
                b.classList.toggle('is-active', b.getAttribute('data-group-filter') === 'all');
            });
            $$('[data-stage-filter]').forEach(function (t) { t.classList.remove('is-active'); });
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

        /* One delegated listener covers every row and every row action. */
        $('#student-tbody').addEventListener('click', function (event) {
            var actionBtn = event.target.closest('[data-row-act]');
            if (actionBtn) {
                event.stopPropagation();
                if (actionBtn.getAttribute('data-row-act') === 'edit') {
                    openEditStudent(actionBtn.getAttribute('data-email'));
                }
                return;
            }

            var row = event.target.closest('[data-student]');
            if (row) { openStudentDrawer(row.getAttribute('data-student')); }
        });
    }

    function applyDrilldownChrome() {
        var drill = state.filters.stage;
        $('#clear-stage-filter').classList.toggle('is-hidden', !drill);
        $('#roster-filter-bar').classList.toggle('is-hidden', !!drill);
        $('#roster-title').textContent = drill ? stageLabel(drill) + ' — live view' : 'All students';
        $('#roster-sub').textContent = drill
            ? 'Participants currently at this stage.'
            : 'Showing the full cohort.';
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
        $('#drawer-pre').textContent = s.pre_test_score == null ? 'n/a' : s.pre_test_score;
        $('#drawer-post').textContent = s.post_test_score == null ? 'n/a' : s.post_test_score;

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
        return '<div class="notice">' + icon(iconName) + '<div><p class="notice-title">' + esc(title) +
            '</p><p class="notice-text">' + esc(text) + '</p></div></div>';
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
                : 'This participant has not completed the questionnaire.');
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
        var maxDevices = toInt($('#rs-device').value, 1);
        var score = parseScore($('#rs-pretest').value);

        var valid = true;
        valid = setFieldError('rs-first', first ? '' : 'First name is required.') && valid;
        valid = setFieldError('rs-last', last ? '' : 'Last name is required.') && valid;
        valid = setFieldError('rs-email', isEmail(email) ? '' : 'Enter a valid school email address.') && valid;
        valid = setFieldError('rs-section', section ? '' : 'Create a section first.') && valid;
        valid = setFieldError('rs-pretest', score.ok ? '' : 'Pre-test score must be between 0 and 100.') && valid;
        valid = setFieldError('rs-consent', $('#rs-consent').checked ? '' : 'Parental consent must be recorded first.') && valid;
        if (!valid) { return; }

        var fullName = [first, middle, last].filter(Boolean).join(' ');
        var release = setBusy($('#rs-submit'), 'Registering…');

        try {
            /* Pre-check BEFORE creating the auth user. admin_create_auth_user
               runs first; if the profiles insert then fails (duplicate email,
               for instance) an auth user is left behind with no profile, and
               every later attempt fails with "user already exists" — that
               student can never be registered again. Checking first avoids the
               whole situation. */
            var existing = await sb.from('profiles').select('email').eq('email', email).maybeSingle();

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
                pre_test_score: score.value,
                max_devices: maxDevices,
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
        $('#es-pretest').value = s.pre_test_score == null ? '' : s.pre_test_score;
        $('#es-device').value = toInt(s.max_devices, 1);

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

    async function handleUpdateStudent(event) {
        event.preventDefault();
        clearFormErrors('edit-student-form');

        var originalEmail = $('#es-original-email').value;
        var first = $('#es-first').value.trim();
        var middle = $('#es-middle').value.trim();
        var last = $('#es-last').value.trim();
        var email = normalizeEmail($('#es-email').value);
        var section = $('#es-section').value;
        var groupType = ($('input[name="es-condition"]:checked') || {}).value;
        var maxDevices = toInt($('#es-device').value, 1);
        var score = parseScore($('#es-pretest').value);

        var valid = true;
        valid = setFieldError('es-first', first ? '' : 'First name is required.') && valid;
        valid = setFieldError('es-last', last ? '' : 'Last name is required.') && valid;
        valid = setFieldError('es-email', isEmail(email) ? '' : 'Enter a valid email address.') && valid;
        valid = setFieldError('es-pretest', score.ok ? '' : 'Pre-test score must be between 0 and 100.') && valid;
        if (!valid) { return; }

        var fullName = [first, middle, last].filter(Boolean).join(' ');
        var emailChanged = (email !== normalizeEmail(originalEmail));
        var release = setBusy($('#es-submit'), 'Saving…');

        try {
            /* Check for a clash BEFORE touching auth. If the auth email is
               changed first and the profiles update then fails, auth holds the
               new address while profiles holds the old one — the student's
               session no longer matches any profile and they cannot log in. */
            if (emailChanged) {
                var clash = await sb.from('profiles').select('email').eq('email', email).maybeSingle();

                if (clash.data) {
                    setFieldError('es-email', 'Another account already uses this email.');
                    toastErr('Duplicate email', email + ' is already taken.');
                    return;
                }

                var rpcRes = await sb.rpc('admin_update_user_email', {
                    target_email: originalEmail,
                    new_email: email
                });

                if (rpcRes.error) {
                    toastErr('Auth email not updated', friendlyDbError(rpcRes.error, 'Could not update the auth email.'));
                    return;
                }
            }

            var payload = {
                full_name: fullName,
                section: section,
                pre_test_score: score.value,
                group_type: groupType,
                max_devices: maxDevices
            };
            if (emailChanged) { payload.email = email; }

            var updateRes = await sb.from('profiles').update(payload).eq('email', originalEmail);

            if (updateRes.error) {
                if (emailChanged) {
                    showNotice('Profile not updated',
                        friendlyDbError(updateRes.error, 'Could not update the profile.') +
                        '\n\nWARNING: the auth email was already changed to ' + email +
                        ' but the profile still holds ' + originalEmail +
                        '. These must be reconciled before this student signs in again.',
                        'danger');
                } else {
                    toastErr('Update failed', friendlyDbError(updateRes.error, 'Could not update the profile.'));
                }
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
                '<p class="state-title">No active devices</p>' +
                '<p class="state-desc">This account is not signed in anywhere right now.</p></div>';
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

        $('#faculty-tbody').innerHTML = rows.map(function (f) {
            var active = (f.status || '') === 'active';
            return '' +
                '<tr class="is-clickable" data-faculty="' + esc(f.email) + '">' +
                '<td>' + userCell({ full_name: f.name, email: f.email }) + '</td>' +
                '<td class="muted">' + esc(f.department || '—') + '</td>' +
                '<td><span class="badge">' + esc(f.assigned_section || 'Unassigned') + '</span></td>' +
                '<td><span class="badge ' + (active ? 'badge-accent' : '') + '">' +
                '<span class="dot ' + (active ? 'dot-live' : 'dot-off') + '"></span>' +
                (active ? 'Active' : 'Inactive') + '</span></td>' +
                '<td class="col-right"><span class="row-actions">' +
                '<button class="btn-icon" title="Send password-reset email" data-fac-act="reset" data-email="' + esc(f.email) + '">' +
                icon('key', 'icon-sm') + '</button>' +
                '<button class="btn-icon" title="Sign out everywhere" data-fac-act="signout" data-email="' + esc(f.email) + '">' +
                icon('logout', 'icon-sm') + '</button>' +
                '<button class="btn-icon" title="Remove faculty" data-fac-act="delete" data-email="' + esc(f.email) + '">' +
                icon('trash', 'icon-sm') + '</button>' +
                '</span></td>' +
                '</tr>';
        }).join('');
    }

    function initFaculty() {
        $('#faculty-search').addEventListener('input', debounce(function (event) {
            renderFaculty(event.target.value);
        }, 200));

        $('#faculty-tbody').addEventListener('click', function (event) {
            var actionBtn = event.target.closest('[data-fac-act]');
            if (actionBtn) {
                event.stopPropagation();
                var email = actionBtn.getAttribute('data-email');
                var act = actionBtn.getAttribute('data-fac-act');
                if (act === 'reset') {
                    sendPasswordReset(email, actionBtn);
                } else if (act === 'signout') {
                    signOutFacultyEverywhere(email, actionBtn);
                } else {
                    deleteFaculty(email);
                }
                return;
            }

            var row = event.target.closest('[data-faculty]');
            if (row) { openFacultyProfile(row.getAttribute('data-faculty')); }
        });

        $('#faculty-reset').addEventListener('click', function () {
            if (state.activeFaculty) { sendPasswordReset(state.activeFaculty.email, this); }
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

    function renderGates() {
        $('#gates-grid').innerHTML = GATES.map(function (gate) {
            return '' +
                '<article class="gate">' +
                '<div class="gate-body">' +
                '<div class="gate-top">' +
                '<span class="badge">' + esc(gate.stage) + '</span>' +
                '<span class="badge ' + (gate.open ? 'badge-accent' : '') + '" data-gate-status="' + gate.key + '">' +
                (gate.open ? 'Open' : 'Closed') + '</span>' +
                '</div>' +
                '<h3 class="gate-title">' + esc(gate.title) + '</h3>' +
                '<p class="gate-desc">' + esc(gate.desc) + '</p>' +
                '<div class="gate-control">' +
                '<span>' +
                '<span class="gate-control-label">Global access</span><br>' +
                '<span class="gate-control-sub">Applies to every section</span>' +
                '</span>' +
                '<label class="switch">' +
                '<input type="checkbox" data-gate="' + gate.key + '"' + (gate.open ? ' checked' : '') + '>' +
                '<span class="switch-track"></span>' +
                '</label>' +
                '</div>' +
                '</div>' +
                '<div class="gate-foot">' +
                '<button class="btn btn-secondary btn-sm" data-target="' + gate.key + '" data-target-scope="section">Section override</button>' +
                '<button class="btn btn-secondary btn-sm" data-target="' + gate.key + '" data-target-scope="student">Student override</button>' +
                '</div>' +
                '</article>';
        }).join('');

        $$('[data-gate]').forEach(function (input) {
            input.addEventListener('change', function () { updateStageControl(input); });
        });

        $$('[data-target]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                openTargeted(btn.getAttribute('data-target'), btn.getAttribute('data-target-scope'));
            });
        });
    }

    function paintGateStatus(key, open) {
        var label = $('[data-gate-status="' + key + '"]');
        if (!label) { return; }
        label.textContent = open ? 'Open' : 'Closed';
        label.className = 'badge ' + (open ? 'badge-accent' : '');
    }

    /* Closing a stage through the settings table alone does not evict the
       students already inside — their own current_stage acts as a targeted
       grant, so they keep re-entering by direct URL. admin_set_stage_open
       returns them to the Waiting Room as part of closing. */
    async function updateStageControl(input) {
        var key = input.getAttribute('data-gate');
        var gate = GATES.filter(function (g) { return g.key === key; })[0];
        var wanted = input.checked;

        input.disabled = true;
        paintGateStatus(key, wanted);

        var res = await sb.rpc('admin_set_stage_open', { p_stage: key, p_open: wanted });
        input.disabled = false;

        if (res.error) {
            /* Roll the control back to the server's actual state. */
            input.checked = !wanted;
            paintGateStatus(key, !wanted);
            toastErr('Stage control failed', res.error.message);
            return;
        }

        gate.open = wanted;
        renderGateSummary();

        var evicted = (res.data && res.data.evicted) || 0;
        if (!wanted && evicted > 0) {
            toastOk(gate.title + ' closed',
                evicted + ' student' + (evicted === 1 ? '' : 's') + ' returned to the Waiting Room.');
        } else {
            toastOk(gate.title + (wanted ? ' opened' : ' closed'), 'Global access updated for every section.');
        }

        refreshAll();
    }

    /* ---- Targeted access ---- */

    var targeted = { gate: null, mode: 'section', email: null, name: null };

    function openTargeted(gateKey, mode) {
        var gate = GATES.filter(function (g) { return g.key === gateKey; })[0];
        targeted.gate = gateKey;
        targeted.email = null;
        targeted.name = null;

        $('#targeted-sub').textContent = 'Open "' + gate.title + '" for a single section or participant.';
        $('#tg-search').value = '';
        $('#tg-list').innerHTML = '';
        setTargetMode(mode || 'section');
        openModal('modal-targeted');

        if ((mode || 'section') === 'student') { runTargetSearch(''); }
    }

    function setTargetMode(mode) {
        targeted.mode = mode;
        $$('[data-target-mode]').forEach(function (btn) {
            btn.classList.toggle('is-active', btn.getAttribute('data-target-mode') === mode);
        });
        $('#targeted-section-field').classList.toggle('is-hidden', mode !== 'section');
        $('#targeted-student-field').classList.toggle('is-hidden', mode !== 'student');

        if (mode === 'student' && !$('#tg-list').innerHTML) { runTargetSearch(''); }
        updateTargetedFooter();
    }

    /* Queries the database directly rather than the roster cache: the cache
       holds one page of 50 and reflects the active filters, so a student on
       page 2 could never be targeted. */
    async function runTargetSearch(rawTerm) {
        var list = $('#tg-list');
        list.innerHTML = '<div class="state-block" style="min-height:120px">' +
            '<div class="spinner"></div><p class="state-desc">Searching…</p></div>';

        var term = sanitizeFilterTerm(rawTerm);

        var query = sb.from('profiles')
            .select('full_name, email, section')
            .neq('role', 'admin')
            .order('full_name', { ascending: true })
            .limit(50);

        if (term) {
            query = query.or('full_name.ilike.%' + term + '%,email.ilike.%' + term + '%');
        }

        var res = await query;

        if (res.error) {
            list.innerHTML = '<div class="state-block" style="min-height:120px">' +
                '<p class="state-title">Search failed</p>' +
                '<p class="state-desc">' + esc(res.error.message) + '</p></div>';
            return;
        }

        var rows = res.data || [];

        if (!rows.length) {
            list.innerHTML = '<div class="state-block" style="min-height:120px">' +
                '<p class="state-title">No participant found</p>' +
                '<p class="state-desc">Try a different name or email fragment.</p></div>';
            return;
        }

        list.innerHTML = rows.map(function (s) {
            return '' +
                '<button type="button" class="pick-row' + (targeted.email === s.email ? ' is-picked' : '') +
                '" data-pick="' + esc(s.email) + '" data-name="' + esc(s.full_name || s.email) + '">' +
                '<span class="avatar">' + esc(initialsOf(s.full_name, s.email)) + '</span>' +
                '<span class="pick-text">' +
                '<span class="cell-name">' + esc(s.full_name || '(no name)') + '</span>' +
                '<span class="cell-mail">' + esc(s.email) + ' · ' + esc(s.section || 'no section') + '</span>' +
                '</span>' +
                '<span class="pick-check">' + icon('check', 'icon-sm') + '</span>' +
                '</button>';
        }).join('');

        $$('[data-pick]', list).forEach(function (row) {
            row.addEventListener('click', function () {
                targeted.email = row.getAttribute('data-pick');
                targeted.name = row.getAttribute('data-name');
                $$('[data-pick]', list).forEach(function (r) { r.classList.remove('is-picked'); });
                row.classList.add('is-picked');
                updateTargetedFooter();
            });
        });
    }

    function updateTargetedFooter() {
        var note = $('#targeted-selection');
        var confirmBtn = $('#targeted-confirm');

        if (targeted.mode === 'section') {
            var section = $('#tg-section').value;
            note.textContent = section ? 'Section: ' + section : 'No section available';
            confirmBtn.disabled = !section;
            return;
        }

        note.textContent = targeted.name ? 'Selected: ' + targeted.name : 'Nothing selected';
        confirmBtn.disabled = !targeted.email;
    }

    function initTargeted() {
        $$('[data-target-mode]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                setTargetMode(btn.getAttribute('data-target-mode'));
            });
        });

        $('#tg-search').addEventListener('input', debounce(function (event) {
            runTargetSearch(event.target.value);
        }, 250));

        $('#tg-section').addEventListener('change', updateTargetedFooter);

        $('#targeted-confirm').addEventListener('click', executeTargetedOpen);
    }

    /* admin_grant_stage resets the correct prerequisite flag per stage and
       reports who it could not grant (an unfinished OCEAN test, for example)
       instead of silently rewriting their data. Writing current_stage alone
       would be undone immediately: the route guard sends the student back to
       the Waiting Room, which overwrites current_stage again. */
    async function executeTargetedOpen() {
        var args = { p_stage: targeted.gate, p_emails: null, p_section: null };

        if (targeted.mode === 'section') {
            var section = $('#tg-section').value;
            if (!section) { toastErr('Select a section', 'Choose a section before granting access.'); return; }
            args.p_section = section;
        } else {
            if (!targeted.email) { toastErr('Select a participant', 'Choose a student before granting access.'); return; }
            args.p_emails = [targeted.email];
        }

        var release = setBusy($('#targeted-confirm'), 'Granting…');
        var res = await sb.rpc('admin_grant_stage', args);
        release();

        if (res.error) {
            toastErr('Grant failed', res.error.message);
            return;
        }

        var granted = (res.data && res.data.granted) || [];
        var skipped = (res.data && res.data.skipped) || [];

        closeModal('modal-targeted');
        refreshAll();

        if (!skipped.length) {
            toastOk('Access granted',
                granted.length + ' student' + (granted.length === 1 ? '' : 's') +
                ' moved to ' + targeted.gate.toUpperCase() + '.');
            return;
        }

        var lines = skipped.slice(0, 8).map(function (item) {
            return '• ' + item.email + ' — ' + item.reason;
        }).join('\n');
        var more = skipped.length > 8 ? '\n…and ' + (skipped.length - 8) + ' more.' : '';

        showNotice(
            granted.length ? 'Partially granted' : 'Nothing granted',
            'Granted: ' + granted.length + '\nSkipped: ' + skipped.length + '\n\n' + lines + more,
            granted.length ? 'accent' : 'danger'
        );
    }

    /* ================================= 11. SETTINGS AND ADMIN DEVICES === */

    async function handlePasswordUpdate(event) {
        event.preventDefault();
        clearFormErrors('password-form');

        var next = $('#new-password').value;
        var confirmValue = $('#confirm-password').value;

        var valid = true;
        valid = setFieldError('new-password', next.length >= 8 ? '' : 'Use at least 8 characters.') && valid;
        valid = setFieldError('confirm-password', next === confirmValue ? '' : 'Passwords do not match.') && valid;
        if (!valid) { return; }

        var release = setBusy($('#password-submit'), 'Updating…');
        var res = await sb.auth.updateUser({ password: next });
        release();

        if (res.error) {
            toastErr('Password not updated', res.error.message);
            return;
        }

        $('#password-form').reset();
        toastOk('Password updated', 'Use the new password the next time you sign in.');
    }

    /* ---- Device registration diagnostics ----
       A failure here used to end in one console.error and a list that said
       "No registered devices", which reads as "nothing is wrong". Now every
       way this can go wrong is logged with the details needed to tell them
       apart, kept in window.PIA_DEVICE_DIAG (paste it into a bug report), and
       shown in the Device policy card with a retry. */

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
            .select('max_devices, active_devices')
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

        $('#device-limit').value = toInt(res.data.max_devices, 1);
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

        if (devices.indexOf(deviceId) !== -1) {
            renderAdminDevices(devices);
            return;
        }

        var claim;
        try { claim = await sb.rpc('claim_device', { p_device_id: deviceId }); }
        catch (err) { claim = { error: { message: (err && err.message) || 'The request did not complete.' } }; }

        if (claim.error) {
            var fields = errorFields(claim.error);
            deviceProblem('claim_device', Object.assign({ deviceId: deviceId, listedBefore: devices }, fields));
            renderAdminDevices(devices, { title: 'This browser was not registered', message: claimFailureText(fields) });
            toastErr('This browser was not registered', 'claim_device failed' +
                (fields.code ? ' (' + fields.code + ')' : '') + '. Details are in the Device policy card.');
            return;
        }

        if (claim.data && claim.data.allowed === false) {
            renderAdminDevices(claim.data.devices || devices);
            showDeviceLimitModal(claim.data.devices || devices);
            return;
        }

        if (!claim.data || !Array.isArray(claim.data.devices)) {
            deviceProblem('claim_device-response', { deviceId: deviceId, response: claim.data });
            toastErr('This browser was not registered', 'claim_device gave no usable answer. Details are in the Device policy card.');
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
            toastErr('The registration did not stick', 'The server accepted this browser but it is not in the saved list. Details are in the Device policy card.');
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
                '<div><p class="notice-title">No registered devices</p>' +
                '<p class="notice-text">This browser registers itself the next time the console loads.</p></div></div>');
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

        var currentId = null;
        try { currentId = localStorage.getItem('pia_device_id'); } catch (err) { /* ignore */ }
        if (currentId === deviceId) { await signOut(); }
    }

    async function saveAdminDeviceLimit() {
        var value = toInt($('#device-limit').value, 0);

        if (!value || value < 1 || value > 10) {
            setFieldError('device-limit', 'Choose a limit between 1 and 10.');
            return;
        }
        setFieldError('device-limit', '');

        var release = setBusy($('#save-device-limit'), 'Saving…');
        var res = await sb.from('profiles').update({ max_devices: value }).eq('email', state.adminEmail);
        release();

        if (res.error) {
            toastErr('Policy not saved', friendlyDbError(res.error, 'Could not update the device limit.'));
            return;
        }

        toastOk('Device policy saved', 'Maximum of ' + value + ' concurrent session' + (value === 1 ? '' : 's') + '.');
    }

    /* Forced modal: the admin must free a slot before the console continues. */
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
                '<td class="tnum muted">' + (a.active_devices || []).length + ' of ' + toInt(a.max_devices, 1) + '</td>' +
                '<td class="col-right"><span class="row-actions">' +
                /* No actions on your own row: removing yourself would lock
                   you out, and another administrator can do it for you. */
                (isYou ? '' :
                    '<button class="btn-icon" title="Email a one-time link to set their password" ' +
                    'data-admin-act="link" data-email="' + esc(a.email) + '">' + icon('send', 'icon-sm') + '</button>' +
                    '<button class="btn-icon" title="Remove administrator" ' +
                    'data-admin-act="remove" data-email="' + esc(a.email) + '">' + icon('trash', 'icon-sm') + '</button>') +
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

    /* Removal deletes the account (admin_delete_user), which also ends its
       sessions: with the profile gone, pia_caller_role() no longer says
       admin, so every admin check refuses them at once. It is not a demotion
       -- the only other roles are participant (which would put them in the
       research roster) and professor (which needs a faculty record). To give
       someone access again, add them as a new administrator. */
    async function removeAdmin(email, sourceBtn) {
        if (email === state.adminEmail) { return; }

        var ok = await confirmAction({
            title: 'Remove administrator',
            heading: 'Remove ' + email + '?',
            message: 'Their account is deleted and their access to this console ends immediately. ' +
                'This cannot be undone; to give them access again, add them as a new administrator.',
            confirmLabel: 'Remove administrator'
        });
        if (!ok) { return; }

        var release = setBusy(sourceBtn, '…');
        var res = await sb.rpc('admin_delete_user', { target_email: email });
        release();

        if (res.error) {
            toastErr('Not removed', friendlyDbError(res.error, 'The administrator was not removed.'));
            return;
        }

        toastOk('Administrator removed', email + ' no longer has access.');
        await loadAdmins();
    }

    async function handleAddAdmin(event) {
        event.preventDefault();
        clearFormErrors('add-admin-form');

        var name = $('#aa-name').value.trim();
        var email = normalizeEmail($('#aa-email').value);
        var maxDevices = toInt($('#aa-devices').value, 0);

        var valid = true;
        valid = setFieldError('aa-name', name ? '' : 'Full name is required.') && valid;
        valid = setFieldError('aa-email', isEmail(email) ? '' : 'Enter a valid email address.') && valid;
        valid = setFieldError('aa-devices', (maxDevices >= 1 && maxDevices <= 10) ? '' : 'Choose between 1 and 10.') && valid;
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
                'delete accounts, including other administrators. They will get a one-time link to ' +
                'choose their own password.',
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
                status: 'inactive',
                max_devices: maxDevices
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

    async function openScoresModal(sectionName) {
        state.activeSection = sectionName;
        $('#scores-title').textContent = 'Input scores — ' + sectionName;
        $('#scores-tbody').innerHTML = skeletonRows(4, 5);
        openModal('modal-scores');

        var res = await sb.from('profiles')
            .select('role, full_name, email, group_type, pre_test_score, post_test_score')
            .eq('section', sectionName)
            .order('full_name', { ascending: true });

        if (res.error) {
            $('#scores-tbody').innerHTML = '';
            toastErr('Could not load scores', friendlyDbError(res.error, 'Unknown database error.'));
            return;
        }

        var students = (res.data || []).filter(function (row) {
            return (row.role || '').toLowerCase() !== 'admin';
        });

        if (!students.length) {
            $('#scores-tbody').innerHTML = '<tr><td colspan="4">' +
                '<div class="state-block" style="min-height:200px">' +
                '<p class="state-title">No students in this section</p>' +
                '<p class="state-desc">Assign participants to ' + esc(sectionName) + ' first.</p>' +
                '</div></td></tr>';
            $('#scores-save').disabled = true;
            return;
        }

        $('#scores-save').disabled = false;
        $('#scores-note').textContent = students.length + ' row' + (students.length === 1 ? '' : 's') +
            ' · values must be 0–100';

        $('#scores-tbody').innerHTML = students.map(function (s) {
            var condition = CONDITIONS[s.group_type] || { short: s.group_type || '—', badge: '' };
            return '' +
                '<tr>' +
                '<td>' + userCell(s) + '</td>' +
                '<td><span class="badge ' + condition.badge + '">' + esc(condition.short) + '</span></td>' +
                '<td class="col-right"><input class="input score-input" type="number" step="0.1" min="0" max="100"' +
                ' data-score="pre" data-email="' + esc(s.email) + '"' +
                ' value="' + esc(s.pre_test_score == null ? '' : s.pre_test_score) + '"></td>' +
                '<td class="col-right"><input class="input score-input" type="number" step="0.1" min="0" max="100"' +
                ' data-score="post" data-email="' + esc(s.email) + '"' +
                ' value="' + esc(s.post_test_score == null ? '' : s.post_test_score) + '"></td>' +
                '</tr>';
        }).join('');
    }

    /* UPDATE per row, never upsert. An upsert INSERTS when nothing matches: if
       another admin deletes a student while this modal is open, saving would
       resurrect them as a ghost row — email and score only, NULL name, and
       role defaulting to 'student' — which then shows up in the research
       export. An UPDATE that matches nothing simply touches zero rows. */
    async function saveBatchScores() {
        var rows = $$('#scores-tbody tr');
        var updates = [];

        for (var i = 0; i < rows.length; i++) {
            var preInput = rows[i].querySelector('[data-score="pre"]');
            var postInput = rows[i].querySelector('[data-score="post"]');
            if (!preInput || !postInput) { continue; }

            var email = preInput.getAttribute('data-email');
            var pre = parseScore(preInput.value);
            var post = parseScore(postInput.value);

            preInput.classList.toggle('is-invalid', !pre.ok);
            postInput.classList.toggle('is-invalid', !post.ok);

            if (!pre.ok || !post.ok) {
                toastErr('Score out of range', 'The score for ' + email + ' must be between 0 and 100.');
                return;
            }

            updates.push({ email: email, pre_test_score: pre.value, post_test_score: post.value });
        }

        if (!updates.length) { closeModal('modal-scores'); return; }

        var release = setBusy($('#scores-save'), 'Saving…');

        var results = await Promise.all(updates.map(function (u) {
            return sb.from('profiles')
                .update({ pre_test_score: u.pre_test_score, post_test_score: u.post_test_score })
                .eq('email', u.email);
        }));

        release();

        var failed = results.filter(function (r) { return r.error; });

        if (failed.length) {
            console.error('Batch score save failed:', failed[0].error);
            toastErr('Scores not saved',
                friendlyDbError(failed[0].error, 'Could not save the scores.') +
                (failed.length > 1 ? ' (' + failed.length + ' rows failed)' : ''));
            return;
        }

        closeModal('modal-scores');
        toastOk('Scores saved', updates.length + ' record' + (updates.length === 1 ? '' : 's') +
            ' updated for ' + state.activeSection + '.');
        refreshAll();
    }

    /* ---- Section broadcast ---- */

    async function broadcastSection(sectionName, sourceBtn) {
        var res = await sb.from('profiles')
            .select('email')
            .eq('section', sectionName)
            .eq('status', 'inactive');

        if (res.error) {
            toastErr('Broadcast failed', friendlyDbError(res.error, 'Could not read the section roster.'));
            return;
        }

        var recipients = res.data || [];

        if (!recipients.length) {
            toastOk('Nothing to send', 'Every student in ' + sectionName + ' has already activated.');
            return;
        }

        var ok = await confirmAction({
            title: 'Email section roster',
            heading: 'Send ' + recipients.length + ' activation email' + (recipients.length === 1 ? '' : 's') + '?',
            message: 'One email per inactive student in ' + sectionName +
                '. Sending is paced at roughly one per 1.5 seconds to stay inside the provider rate limit.',
            confirmLabel: 'Send emails',
            tone: 'accent'
        });
        if (!ok) { return; }

        var release = setBusy(sourceBtn, 'Sending…');
        var redirect = activationRedirect();
        var sent = 0;
        var failures = [];

        for (var i = 0; i < recipients.length; i++) {
            var mail = await sb.auth.signInWithOtp({
                email: recipients[i].email,
                options: { shouldCreateUser: false, emailRedirectTo: redirect }
            });

            if (mail.error) { failures.push(recipients[i].email + ' — ' + mail.error.message); }
            else { sent++; }

            /* Rate-limit pacing, ported from the original broadcast loop. */
            await new Promise(function (resolve) { setTimeout(resolve, 1500); });
        }

        release();

        if (!failures.length) {
            toastOk('Broadcast complete', sent + ' activation email' + (sent === 1 ? '' : 's') +
                ' sent to ' + sectionName + '.');
            return;
        }

        showNotice('Broadcast finished with errors',
            'Sent: ' + sent + '\nFailed: ' + failures.length + '\n\n' +
            failures.slice(0, 8).join('\n') +
            (failures.length > 8 ? '\n…and ' + (failures.length - 8) + ' more.' : ''),
            'danger');
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
                .subscribe(function (status) { paintConnection(status); });
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

    function paintConnection(status) {
        var dot = $('#live-dot');
        var label = $('#live-label');
        if (!dot || !label) { return; }

        if (status === 'SUBSCRIBED') {
            dot.className = 'dot dot-live';
            label.textContent = 'Live';
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            dot.className = 'dot dot-warn';
            label.textContent = 'Reconnecting…';
        } else if (status === 'CLOSED') {
            dot.className = 'dot dot-off';
            label.textContent = 'Offline';
        }
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
            'current_stage', 'is_in_game', 'pre_test_score', 'post_test_score', 'is_ocean_done'];
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
            $('#qb-empty-desc').textContent = 'Add one by hand, or let Auto-generate draft a set you can review first.';
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
    loadSettings = tracked('settings', loadSettings);
    loadAdminDevices = tracked('admindevices', loadAdminDevices);
    loadMathTask = tracked('mathtask', loadMathTask);

    RETRY = {
        cohort: loadCohort, sections: loadSections, roster: loadRoster, stages: loadStageCounters,
        faculty: loadFaculty, admins: loadAdmins, settings: loadSettings,
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
        $('#add-professor-form').addEventListener('submit', handleRegisterProfessor);
        $('#add-admin-form').addEventListener('submit', handleAddAdmin);
        $('#admin-tbody').addEventListener('click', function (event) {
            var btn = event.target.closest('[data-admin-act]');
            if (!btn) { return; }
            var email = btn.getAttribute('data-email');
            if (btn.getAttribute('data-admin-act') === 'remove') { removeAdmin(email, btn); }
            else { resendAdminLink(email, btn); }
        });
        $('#password-form').addEventListener('submit', handlePasswordUpdate);

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

        $('#save-device-limit').addEventListener('click', saveAdminDeviceLimit);
        $('#scores-save').addEventListener('click', saveBatchScores);
        $('#revoke-all-btn').addEventListener('click', revokeAllStudentSessions);
        $('#signout-confirm').addEventListener('click', signOut);
        $('#device-limit-signout').addEventListener('click', signOut);

        $('#section-scores-btn').addEventListener('click', function () {
            var section = state.activeSection;
            closeModal('modal-section-details');
            setTimeout(function () { openScoresModal(section); }, 200);
        });

        $('#section-broadcast-btn').addEventListener('click', function () {
            broadcastSection(state.activeSection, this);
        });

        $('#export-overview').addEventListener('click', exportCohortCsv);
        $('#export-roster').addEventListener('click', exportCohortCsv);

        $('#refresh-btn').addEventListener('click', async function () {
            /* The icon keeps its place and turns; the button is inert until
               everything has landed. */
            var btn = this;
            if (btn.classList.contains('is-busy')) { return; }
            btn.classList.add('is-busy');
            btn.setAttribute('aria-disabled', 'true');
            await Promise.all([refreshAll(), loadMathTask()]);
            btn.classList.remove('is-busy');
            btn.removeAttribute('aria-disabled');
            toastOk('Refreshed', 'Every panel is showing current data.');
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
        var email;
        try {
            setBootText('Verifying administrator access…');

            var sessionRes = await sb.auth.getSession();
            if (sessionRes.error || !sessionRes.data.session) {
                throw new Error('Session expired. Please log in again.');
            }

            email = sessionRes.data.session.user.email;

            var profileRes = await sb.from('profiles').select('role').eq('email', email).maybeSingle();
            if (profileRes.error || !profileRes.data || profileRes.data.role !== 'admin') {
                throw new Error('Unauthorized access. Admin privileges required.');
            }
        } catch (err) {
            console.error('Auth check failed:', err);
            setBootText(err.message || 'Failed to verify admin access.');
            showGlobalError(err.message || 'Failed to verify admin access.');
            try { localStorage.removeItem('pia_user_email'); } catch (e) { /* ignore */ }
            setTimeout(function () { window.location.replace('../../index.html'); }, 3000);
            return;
        }

        try { localStorage.setItem('pia_user_email', email); } catch (err) { /* ignore */ }

        /* --- Phase 2: UI. Wire the shell before data arrives so the skeletons
           are interactive. --- */
        PIAShell.initRail({ hasOpenModal: function () { return openLayers.length > 0; } });
        initRouter();
        initModals();
        initRoster();
        initDrawerActions();
        initFaculty();
        initTargeted();
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
        await loadAdminDevices();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
