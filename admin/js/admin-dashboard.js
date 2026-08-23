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

    var OCEAN_MAX = (typeof OCEAN_SCORE_MAX !== 'undefined') ? OCEAN_SCORE_MAX : 40;
    var toOceanPct = (typeof normalizeOceanScore === 'function') ? normalizeOceanScore : function (raw) {
        var n = parseFloat(raw);
        return Number.isFinite(n) ? Math.round((n / OCEAN_MAX) * 100) : null;
    };

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

    function activationRedirect() {
        return new URL('../../assets/html/sign-up.html', window.location.href).href;
    }

    /* ============================================ 2. APPLICATION STATE == */

    var STAGE_META = {
        'OCEAN': { label: 'OCEAN test', badge: 'badge-amber', fill: 'f-amber' },
        'Character Selection': { label: 'Character select', badge: 'badge-teal', fill: 'f-teal' },
        'Tutoring Dashboard': { label: 'Tutoring dashboard', badge: '', fill: 'f-muted' },
        'Active Game': { label: 'Active session', badge: 'badge-accent', fill: '' }
    };

    var CONDITIONS = {
        'assigned': { short: 'EXP · Assigned', badge: 'badge-accent', family: 'experimental' },
        'non-assigned': { short: 'EXP · Free choice', badge: 'badge-teal', family: 'experimental' },
        'neutral': { short: 'EXP · Neutral', badge: 'badge-amber', family: 'experimental' },
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
        rosterPage: [],      // the current page of the roster table
        faculty: [],
        totalStudents: 0,
        page: 1,
        filters: { group: 'all', sub: 'all', stage: null, search: '' },
        activeStudent: null,
        managingEmail: null,
        activeSection: null,
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
        settings: 'Settings'
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

        button.style.minWidth = Math.ceil(originalWidth) + 'px';
        button.classList.add('is-busy');
        button.disabled = true;
        button.innerHTML = esc(busyLabel || 'Working…');

        return function release() {
            button.innerHTML = originalHTML;
            button.classList.remove('is-busy');
            button.disabled = false;
            button.style.minWidth = '';
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

    /* ================================================ 4. DATA LAYER ===== */

    /* Columns the overview aggregates need. Selecting the exact set rather
       than '*' keeps active_devices the only array we pull, and keeps OCEAN
       item-level answers out of the response entirely. */
    var COHORT_COLUMNS = 'full_name, email, section, group_type, status, current_stage, is_in_game,' +
        ' stage_started_at, active_devices, ocean_o, pre_test_score, post_test_score';

    /* One pass over the cohort powers the KPI tiles, the pipeline, live
       sessions, section health and the section card counts. The study is a
       single Grade 7 cohort, so this is a small bounded read; the cap is a
       guard rail, not a paging strategy. The roster table below still pages
       server-side. */
    async function loadCohort() {
        state.loading.cohort = true;

        var res = await sb.from('profiles')
            .select(COHORT_COLUMNS)
            .neq('role', 'admin')
            .limit(2000);

        state.loading.cohort = false;

        if (res.error) { throw res.error; }

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
            tbody.innerHTML = '';
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

    function renderKpis() {
        var cohort = state.cohort;
        var total = cohort.length;
        var oceanDone = cohort.filter(function (s) { return s.ocean_o !== null && s.ocean_o !== undefined; }).length;
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
            '<span class="cell-name">' + esc(profile.full_name || '(no name)') + '</span>' +
            '<span class="cell-mail">' + esc(profile.email) + '</span>' +
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
            var done = members.filter(function (s) { return s.ocean_o !== null && s.ocean_o !== undefined; }).length;
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
            var done = members.filter(function (s) { return s.ocean_o !== null && s.ocean_o !== undefined; }).length;

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
                    '<td><span class="badge badge-teal">' + esc(s.current_difficulty || 'Normal') + '</span></td>' +
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
            var deviceTone = used >= limit && used > 0 ? 'badge-amber' : '';

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
            ' · ' + ((s.status || '') === 'active' ? 'Activated' : 'Not activated');
        $('#drawer-pre').textContent = s.pre_test_score == null ? 'n/a' : s.pre_test_score;
        $('#drawer-post').textContent = s.post_test_score == null ? 'n/a' : s.post_test_score;

        renderTraits(s);
        openModal('drawer-student');
    }

    /* Raw OCEAN sums are out of OCEAN_SCORE_MAX (40); normalizeOceanScore in
       function.js converts them to the percentages shown here. */
    function renderTraits(s) {
        var traits = [
            ['Openness', s.ocean_o],
            ['Conscientiousness', s.ocean_c],
            ['Extraversion', s.ocean_e],
            ['Agreeableness', s.ocean_a],
            ['Neuroticism', s.ocean_n]
        ];

        var hasAny = traits.some(function (pair) { return toOceanPct(pair[1]) !== null; });

        if (!hasAny) {
            $('#drawer-traits').innerHTML = '<div class="notice">' + icon('info') +
                '<div><p class="notice-title">No OCEAN result yet</p>' +
                '<p class="notice-text">This participant has not completed the Big Five Inventory.</p></div></div>';
            return;
        }

        $('#drawer-traits').innerHTML = traits.map(function (pair) {
            var value = toOceanPct(pair[1]);
            var shown = value === null ? 'n/a' : value + '%';
            return '' +
                '<div class="trait">' +
                '<div class="trait-top">' +
                '<span class="trait-name">' + pair[0] + '</span>' +
                '<span class="trait-val tnum">' + shown + '</span>' +
                '</div>' +
                '<div class="bar"><div class="bar-fill" style="width:' + (value || 0) + '%"></div></div>' +
                '</div>';
        }).join('');
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
                else if (action === 'reset-password') { sendPasswordReset(s.email, btn); }
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

    /* Security: the admin never sets a known password. The owner sets their
       own through the emailed link. */
    async function sendPasswordReset(email, sourceBtn) {
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
        var res = await sb.auth.resetPasswordForEmail(email, { redirectTo: activationRedirect() });
        release();

        if (res.error) {
            toastErr('Reset email failed', res.error.message);
            return;
        }
        toastOk('Reset email sent', email + ' can now set a new password.');
    }

    /* ---- Retakes ---- */

    async function allowRetakeOcean(email) {
        var ok = await confirmAction({
            title: 'Allow OCEAN retake',
            heading: 'Clear the OCEAN result for ' + email + '?',
            message: 'The five trait scores are erased and the student is sent back to the ' +
                'OCEAN stage. The previous result cannot be recovered.',
            confirmLabel: 'Clear and allow retake'
        });
        if (!ok) { return; }

        var res = await sb.from('profiles').update({
            is_ocean_done: false,
            current_stage: 'OCEAN',
            stage_started_at: new Date().toISOString(),
            ocean_o: null, ocean_c: null, ocean_e: null, ocean_a: null, ocean_n: null
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
                if (actionBtn.getAttribute('data-fac-act') === 'reset') {
                    sendPasswordReset(email, actionBtn);
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

        openModal('modal-faculty');
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

    /* Reads the limit, then registers this browser through claim_device.
       claim_device uses SELECT … FOR UPDATE and enforces the limit server-side,
       so the rule lives in one place instead of two copies that can disagree. */
    async function loadAdminDevices() {
        var res = await sb.from('profiles')
            .select('max_devices, active_devices')
            .eq('email', state.adminEmail)
            .maybeSingle();

        if (res.error || !res.data) {
            console.error('Admin device settings failed:', res.error);
            return;
        }

        $('#device-limit').value = toInt(res.data.max_devices, 1);

        var devices = res.data.active_devices || [];
        var deviceId = (typeof getOrCreateDeviceId === 'function') ? getOrCreateDeviceId() : null;

        if (deviceId && devices.indexOf(deviceId) === -1) {
            var claim = await sb.rpc('claim_device', { p_device_id: deviceId });

            if (claim.error) {
                console.error('claim_device failed:', claim.error);
            } else if (claim.data && claim.data.allowed === false) {
                showDeviceLimitModal(claim.data.devices || devices);
                return;
            } else if (claim.data && claim.data.devices) {
                devices = claim.data.devices;
            }
        }

        renderAdminDevices(devices);
    }

    function renderAdminDevices(devices) {
        var container = $('#admin-device-list');
        var currentId = null;
        try { currentId = localStorage.getItem('pia_device_id'); } catch (err) { /* ignore */ }

        if (!devices || !devices.length) {
            container.innerHTML = '<div class="notice">' + icon('info') +
                '<div><p class="notice-title">No registered devices</p>' +
                '<p class="notice-text">This browser registers itself the next time the console loads.</p></div></div>';
            return;
        }

        container.innerHTML = devices.map(function (deviceId) {
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

    async function revokeAdminDevice(deviceId, sourceBtn) {
        var ok = await confirmAction({
            title: 'Revoke device',
            heading: 'Sign this device out?',
            message: 'That session ends immediately. If it is the browser you are using right ' +
                'now, you will be signed out too.',
            confirmLabel: 'Revoke session'
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
        toastOk('Device revoked', 'That session has been signed out.');

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
        toastOk('Device revoked', 'This browser is now registered.');

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
            refreshAll();
        }, backoffMs);
    }

    function flushDeferredRefresh() {
        if (!deferredRefresh || isUserBusy()) { return; }
        clearTimeout(refreshTimer);
        deferredRefresh = false;
        backoffMs = 1000;
        refreshAll();
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
                        renderStudentDevices(payload.new.active_devices || []);
                    }

                    /* And the admin's own device list. */
                    if (state.adminEmail && payload.new && payload.new.email === state.adminEmail) {
                        renderAdminDevices(payload.new.active_devices || []);
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
                    loadSettings().catch(function (err) { console.error('Settings reload failed:', err); });
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

    /* Exports the cohort summary already in memory — no extra round trip, and
       what you download is exactly what the dashboard is showing. */
    function exportCohortCsv() {
        if (!state.cohort.length) {
            toastErr('Nothing to export', 'The cohort has not loaded yet.');
            return;
        }

        var headers = ['full_name', 'email', 'section', 'group_type', 'status',
            'current_stage', 'is_in_game', 'pre_test_score', 'post_test_score', 'ocean_o'];

        var lines = [headers.join(',')];
        state.cohort.forEach(function (row) {
            lines.push(headers.map(function (key) { return toCsvValue(row[key]); }).join(','));
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

        toastOk('Export ready', state.cohort.length + ' rows written to pia-cohort-' + stamp + '.csv.');
    }

    /* ============================================ 15. BOOT SEQUENCE ===== */

    /* Every read the dashboard needs, in parallel. A failure here shows the
       error banner but never signs the admin out — their identity is already
       verified at this point. */
    async function refreshAll() {
        try {
            await Promise.all([
                loadCohort(),
                loadSections(),
                loadRoster(),
                loadStageCounters(),
                loadFaculty(),
                loadSettings()
            ]);
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
        $('#overview-greeting').textContent = greeting + ', ' + name.split(' ')[0];
    }

    function initForms() {
        $('#register-student-form').addEventListener('submit', handleRegisterStudent);
        $('#edit-student-form').addEventListener('submit', handleUpdateStudent);
        $('#add-professor-form').addEventListener('submit', handleRegisterProfessor);
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
            var release = setBusy(this, '…');
            await refreshAll();
            release();
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

        setBootText('Loading dashboard…');
        await initAdminIdentity(email);

        revealApp();

        /* --- Phase 3: DATA. A failure here shows the banner and keeps the
           verified admin on the page. --- */
        await refreshAll();
        applyDrilldownChrome();

        setupRealtime();
        await loadAdminDevices();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
