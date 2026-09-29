/**
 * ============================================================================
 * PIA SYSTEM — TEACHER CONSOLE (live monitor)
 * ============================================================================
 * One screen for a teacher running a 75-minute PIA session in their own
 * section: who needs attention, how many are working, and where each student
 * is in this lesson. Uses the shared `sb` client from function.js and the
 * shared rail from shell.js.
 *
 * WITHIN THE CERC PROTOCOL: everything about students comes from one server
 * function, teacher_class_status (migration 0026), which returns only a
 * name, a status, a progress count and an attention flag. Personality
 * results, the research group, the tutor persona and test scores never
 * reach this page -- teachers cannot read student rows directly any more,
 * so not even the browser console can ask for them.
 *
 * HOW IT DRAWS: rows, queue items and toasts are cloned from <template>s and
 * filled with textContent, so no student data is ever parsed as HTML. Each
 * row is kept by its student_key and updated in place on every refresh:
 * nothing is rebuilt, so a teacher's text selection, a screen reader's
 * place and the order of unchanged rows all survive the 10-second poll.
 *
 * HOW IT FETCHES: one request at a time. A poll, the refresh button and a
 * tab coming back into view all share the request already in flight, so an
 * older answer can never land on top of a newer one, and the poll always
 * re-arms itself -- an error cannot stop it.
 * ==========================================================================*/
(function () {
    'use strict';

    var $ = function (s, r) { return (r || document).querySelector(s); };
    var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

    /* ============================================ 0. SETTINGS ========== */

    /* Ten seconds is "live" for a classroom, and 31 rows is a trivial query.
       Polling a guarded function rather than subscribing to table changes is
       deliberate: a realtime subscription streams WHOLE rows, and a student
       row carries exactly the research columns this page must never see. */
    var REFRESH_MS = 10000;

    /* The queue lists this many; the rest are one tap away in the roster. */
    var QUEUE_MAX = 5;

    /* The last class size and queue length, so the loading skeletons are the
       right height and nothing jumps when the data lands. Counts only,
       nothing about any student. */
    var SIZE_KEY = 'pia_teacher_class_size';
    var QUEUE_KEY = 'pia_teacher_queue_size';

    /* Status by shape (see teacher.css, section 8). `lesson` says whether
       "n / 10" means anything yet: not before the lesson, and for someone
       offline only once they have done some. */
    var ACTIVITY = {
        solving:     { label: 'Solving',        mark: 'full',  lesson: 'yes' },
        idle:        { label: 'Idle',           mark: 'empty', lesson: 'yes' },
        not_started: { label: 'Not started',    mark: 'empty', lesson: 'yes' },
        setting_up:  { label: 'Getting set up', mark: 'half',  lesson: 'no' },
        waiting:     { label: 'Waiting room',   mark: 'half',  lesson: 'no' },
        finished:    { label: 'Finished',       mark: 'done',  lesson: 'yes' },
        offline:     { label: 'Offline',        mark: 'off',   lesson: 'if-any' }
    };

    /* Who to look at first, after anyone who needs attention. */
    var ORDER = { idle: 1, not_started: 2, solving: 3, setting_up: 4, waiting: 5, finished: 6, offline: 7 };

    var REASON = { stuck: 'Same problem', idle: 'No activity', dropped: 'Dropped offline' };

    var FILTERS = {
        all: function () { return true; },
        attention: function (r) { return !!r.attention; },
        solving: function (r) { return r.activity === 'solving'; },
        finished: function (r) { return r.activity === 'finished'; },
        offline: function (r) { return r.activity === 'offline'; }
    };

    var FILTER_WORDS = {
        attention: 'needs attention',
        solving: 'is solving',
        finished: 'has finished',
        offline: 'is offline'
    };

    var state = {
        section: null,
        name: null,
        email: null,
        rows: [],
        loadedAt: 0,
        filter: 'all',
        search: '',
        connection: 'connecting',   /* connecting | ok | lost */
        flagged: null               /* student_key -> true, from the last render */
    };

    var rowEls = new Map();     /* student_key -> <tr>, reused across refreshes */
    var queueEls = new Map();   /* student_key -> <li> */

    /* ============================================ 1. SMALL HELPERS ===== */

    function debounce(fn, wait) {
        var t = null;
        return function () {
            var a = arguments, s = this;
            clearTimeout(t);
            t = setTimeout(function () { fn.apply(s, a); }, wait || 200);
        };
    }

    /* The server sends integers; this page trusts nothing it did not make. */
    function toCount(v) {
        var n = parseInt(v, 10);
        return isFinite(n) && n > 0 ? n : 0;
    }

    function nameOf(r) {
        var n = String(r.full_name == null ? '' : r.full_name).trim();
        return n || 'Unnamed student';
    }

    /* Writes only when the text changed, so an unchanged cell is not touched
       and a selection inside it survives the refresh. */
    function setText(el, text) {
        text = String(text);
        if (el && el.textContent !== text) { el.textContent = text; }
    }

    function clone(id) {
        return document.getElementById(id).content.firstElementChild.cloneNode(true);
    }

    /* Puts el at position i in parent, moving it only if it is not there. */
    function place(parent, el, i) {
        if (parent.children[i] !== el) { parent.insertBefore(el, parent.children[i] || null); }
    }

    /* After place() has filled positions 0..n-1, anything after is stale. */
    function trim(parent, n) {
        while (parent.children.length > n) { parent.lastElementChild.remove(); }
    }

    function initialsOf(name, email) {
        var src = (name || '').trim().replace(/^(Dr|Prof|Mr|Mrs|Ms)\.?\s+/i, '');
        if (!src) { return (email || '?').slice(0, 2).toUpperCase(); }
        var p = src.split(/\s+/);
        return (p.length === 1 ? p[0].slice(0, 2) : p[0][0] + p[p.length - 1][0]).toUpperCase();
    }

    function agoText(sec) {
        if (sec === null || sec === undefined) { return '—'; }
        sec = toCount(sec);
        if (sec < 60) { return 'Just now'; }
        var m = Math.floor(sec / 60);
        return m < 60 ? m + ' min ago' : Math.floor(m / 60) + ' h ago';
    }

    function clock(ts) {
        return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function reducedMotion() {
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    /* Marks a button as working: one click at a time, and keyboard focus
       stays on it (a disabled button would drop focus to the page). */
    function busy(button, on) {
        if (!button) { return; }
        if (on) {
            button.setAttribute('aria-busy', 'true');
            button.setAttribute('aria-disabled', 'true');
        } else {
            button.removeAttribute('aria-busy');
            button.removeAttribute('aria-disabled');
        }
    }

    function isBusy(button) { return button.getAttribute('aria-busy') === 'true'; }

    /* A polite screen-reader line, for changes a sighted teacher sees at once. */
    function announce(text) {
        var el = $('#announce');
        if (!el) { return; }
        el.textContent = '';
        setTimeout(function () { el.textContent = text; }, 60);
    }

    /* ============================================ 2. BOOT GATE ========= */

    function setBootText(m) { setText($('#boot-text'), m); }

    function reveal() {
        document.body.removeAttribute('data-boot');
        var v = $('#boot-veil');
        if (v) { setTimeout(function () { v.hidden = true; }, 200); }
    }

    function showBanner(message) {
        var banner = $('#global-error-banner');
        if (!banner) { return; }
        setText($('#global-error-message'), message);
        banner.hidden = false;
    }

    /* ============================================ 3. MODALS + TOASTS === */

    var openLayers = [];
    var lastFocused = null;

    /* The layer ladder lives in ONE place, global.css (--z-overlay,
       --z-toast, --z-banner, --z-boot). Read it rather than repeat it, so a
       change there can never leave a dialog under the rail or over a toast. */
    function cssInt(name, fallback) {
        var v = parseInt(getComputedStyle(document.documentElement).getPropertyValue(name), 10);
        return isFinite(v) ? v : fallback;
    }
    var signingOut = false;
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

    /* While a dialog is open, everything behind it is inert: not clickable,
       not focusable, and invisible to a screen reader's virtual cursor. */
    function setBackgroundInert(on) {
        ['app', 'skip-link'].forEach(function (id) {
            var el = document.getElementById(id);
            if (el) { el.toggleAttribute('inert', on); }
        });
    }

    /* `trigger` is the control that opened the dialog. Focus returns to IT on
       close -- not to document.activeElement, which Safari leaves on <body>
       when a button is clicked (it never focuses buttons on click). */
    function openModal(id, trigger) {
        var o = document.getElementById(id);
        if (!o || openLayers.indexOf(o) !== -1) { return; }
        if (!openLayers.length) {
            lastFocused = trigger || document.activeElement;
            lockScroll();
            setBackgroundInert(true);
        }
        o.classList.add('is-mounted');
        openLayers.push(o);
        /* Each layer above the last; z-index does not affect layout. */
        o.style.zIndex = String(cssInt('--z-overlay', 100) + openLayers.length);
        void o.offsetWidth;
        o.classList.add('is-open');
        /* Focus the safe choice, not the first button in the markup. */
        var f = o.querySelector('[data-autofocus]') || o.querySelector('button, input');
        if (f) { f.focus({ preventScroll: true }); }
    }

    function closeModal(target) {
        if (signingOut) { return; }
        var o = (typeof target === 'string') ? document.getElementById(target) : target;
        o = o || openLayers[openLayers.length - 1];
        if (!o) { return; }
        o.classList.remove('is-open');
        o.style.zIndex = '';
        openLayers = openLayers.filter(function (l) { return l !== o; });
        setTimeout(function () {
            o.classList.remove('is-mounted');
            if (!openLayers.length) {
                setBackgroundInert(false);
                unlockScroll();
                if (lastFocused && lastFocused.focus) { lastFocused.focus({ preventScroll: true }); }
            }
        }, 160);
    }

    function initModals() {
        $$('[data-modal-open]').forEach(function (t) {
            t.addEventListener('click', function () { openModal(t.getAttribute('data-modal-open'), t); });
        });
        $$('.overlay').forEach(function (o) {
            o.addEventListener('mousedown', function (e) { if (e.target === o) { closeModal(o); } });
            $$('[data-modal-close]', o).forEach(function (b) {
                b.addEventListener('click', function () { closeModal(o); });
            });
        });
        document.addEventListener('keydown', function (e) {
            if (!openLayers.length) { return; }
            var top = openLayers[openLayers.length - 1];
            if (e.key === 'Escape') { e.preventDefault(); closeModal(top); return; }
            if (e.key !== 'Tab') { return; }
            var n = $$(FOCUSABLE, top).filter(function (x) { return x.offsetParent !== null; });
            if (!n.length) { return; }
            var first = n[0], last = n[n.length - 1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        });
    }

    /* Toasts stack newest-last and never more than three deep: a flaky
       connection cannot bury the screen. Each one dismisses itself, but not
       while the pointer is on it or focus is inside it (WCAG 2.2.1: a
       teacher reading it is never cut off mid-sentence), and each has its
       own close button. Where the stack sits is teacher.css, section 9b. */
    var TOAST_MAX = 3;

    function toast(title, description, tone) {
        var stack = $('#toast-stack');
        if (!stack) { return; }
        while (stack.children.length >= TOAST_MAX) { stack.firstElementChild.remove(); }

        var n = clone('tpl-toast');
        var danger = tone === 'danger';
        n.classList.add(danger ? 'toast-danger' : 'toast-accent');
        $('use', n).setAttribute('href', danger ? '#i-alert' : '#i-check');
        setText($('.toast-title', n), title);
        setText($('.toast-desc', n), description || '');

        var remaining = danger ? 6000 : 3800;
        var startedAt = 0;
        var timer = null;
        var gone = false;

        function dismiss() {
            if (gone) { return; }
            gone = true;
            clearTimeout(timer);
            /* A keyboard user who closed it keeps their place on the page. */
            if (n.contains(document.activeElement)) { $('#main').focus({ preventScroll: true }); }
            n.classList.remove('is-open');
            setTimeout(function () { n.remove(); }, 200);
        }
        function arm() {
            clearTimeout(timer);
            startedAt = Date.now();
            timer = setTimeout(dismiss, remaining);
        }
        function pause() {
            clearTimeout(timer);
            remaining = Math.max(1500, remaining - (Date.now() - startedAt));
        }

        n.addEventListener('mouseenter', pause);
        n.addEventListener('mouseleave', arm);
        n.addEventListener('focusin', pause);
        n.addEventListener('focusout', function (e) { if (!n.contains(e.relatedTarget)) { arm(); } });
        $('.toast-close', n).addEventListener('click', dismiss);

        stack.appendChild(n);
        void n.offsetWidth;
        n.classList.add('is-open');
        arm();
    }

    /* ============================================ 4. ACCESS GUARD ====== */

    function leave(message) {
        setBootText(message);
        showBanner(message);
        try { localStorage.removeItem('pia_user_email'); } catch (err) { /* ignore */ }
        setTimeout(function () { window.location.replace('../../index.html'); }, 3000);
    }

    /* A request that never reached the server (Wi-Fi dropped, DNS, a
       captive portal) is NOT a verdict on who the teacher is. PostgREST and
       auth errors carry a code or a status; network failures carry neither,
       only a fetch/network message -- or the browser simply says offline. */
    function isNetworkError(err) {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) { return true; }
        if (!err) { return false; }
        var code = String(err.code || '');
        var status = Number(err.status || 0);
        var msg = String(err.message || err);
        return !code && !status && /fetch|network|load failed|timed? ?out|offline/i.test(msg);
    }

    /* Returns 'ok', 'denied' (already on its way to sign-in), 'offline'
       (could not reach the server: retry, never redirect) or 'no-client'
       (the Supabase library itself did not load: reload). */
    async function enforceTeacherAccess() {
        if (typeof sb === 'undefined' || !sb) { return 'no-client'; }

        try {
            var session = await sb.auth.getSession();
            if (session.error) {
                if (isNetworkError(session.error)) { return 'offline'; }
                leave('Your session ended. Taking you to sign in…');
                return 'denied';
            }
            if (!session.data.session) {
                leave('Your session ended. Taking you to sign in…');
                return 'denied';
            }

            var email = session.data.session.user.email;
            var res = await sb.from('profiles').select('role, section, full_name').eq('email', email).maybeSingle();

            if (res.error) {
                if (isNetworkError(res.error)) { return 'offline'; }
                console.error('Teacher console: access check refused.', res.error);
                leave("Couldn't confirm your access. Taking you back to sign in…");
                return 'denied';
            }
            /* A valid session can always read its own profile row, so no row at
               all means this login is no longer accepted -- signed out on the
               server (an admin ended it, or "Sign out everywhere") -- not that
               the person is the wrong kind of user. */
            if (!res.data) {
                leave('Your session ended. Taking you to sign in…');
                return 'denied';
            }
            if (res.data.role !== 'teacher') {
                leave('This page is for teachers. Taking you back to sign in…');
                return 'denied';
            }

            try { localStorage.setItem('pia_user_email', email); } catch (e) { /* private mode */ }

            state.email = email;
            state.section = res.data.section || null;
            state.name = res.data.full_name || null;

            /* profiles is the source of truth; the professors row is a fallback
               for accounts created before the two were written together. A
               failed fallback only costs a label, so it never blocks entry. */
            if (!state.section || !state.name) {
                var prof = await sb.from('professors').select('name, assigned_section').eq('email', email).maybeSingle();
                if (prof.error && isNetworkError(prof.error)) { return 'offline'; }
                if (!state.section) { state.section = (prof.data && prof.data.assigned_section) || null; }
                if (!state.name) { state.name = (prof.data && prof.data.name) || null; }
            }
            return 'ok';
        } catch (e) {
            if (isNetworkError(e)) { return 'offline'; }
            console.error('Teacher console: access check failed.', e);
            leave("Couldn't confirm your access. Taking you back to sign in…");
            return 'denied';
        }
    }

    function paintIdentity() {
        var shown = state.name || state.email.split('@')[0];
        setText($('#teacher-name'), shown);
        setText($('#teacher-email'), state.email);
        setText($('#teacher-initials'), initialsOf(shown, state.email));
        setText($('#teacher-section-label'), state.section ? 'Section ' + state.section : 'No section yet');

        /* The section is the headline; with none, say so plainly. */
        $('#mast-kicker').hidden = !state.section;
        setText($('#mast-section'), state.section || 'No section yet');
        if (state.section) { document.title = 'Section ' + state.section + ' · Teacher Console — PIA System'; }

        /* Faculty names carry an honorific, so a naive first-word split
           greets them as "Dr." -- keep the title WITH the surname, which is
           how a teacher is actually addressed. */
        var hour = new Date().getHours();
        var greet = hour < 12 ? 'Good morning' : (hour < 18 ? 'Good afternoon' : 'Good evening');
        var parts = shown.trim().split(/\s+/);
        var address = /^(Dr|Prof|Mr|Mrs|Ms)\.?$/i.test(parts[0]) && parts.length > 1
            ? parts[0] + ' ' + parts[parts.length - 1]
            : parts[0];
        var today = new Date().toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
        setText($('#mast-hello'), greet + ', ' + address + ' · ' + today);
    }

    /* ============================================ 5. DATA ============== */

    var inflight = null;

    /* CERC, defence in depth. teacher_class_status already returns only
       these fields; the page ALSO keeps only these, so if the function ever
       grew a column (by mistake, in a later migration) that column would
       never reach page memory, the DOM or the browser console. There is no
       OCEAN score, research group, persona or test score in this list, and
       nothing below reads a field that is not in it. */
    var ROW_FIELDS = [
        'student_key', 'full_name', 'activity', 'online',
        'attention', 'attention_minutes',
        'problems_done', 'problems_target', 'seconds_since_active'
    ];

    function pickRow(r) {
        var o = {};
        ROW_FIELDS.forEach(function (k) { o[k] = r ? r[k] : undefined; });
        return o;
    }

    /* Single flight: every caller shares the request already running. */
    function refresh() {
        if (!inflight) {
            inflight = load().then(function () { inflight = null; }, function () { inflight = null; });
        }
        return inflight;
    }

    async function load() {
        var res;
        try {
            res = await sb.rpc('teacher_class_status');
        } catch (err) {
            res = { error: err };
        }

        if (res.error) { onLoadError(res.error); return; }

        try {
            state.rows = Array.isArray(res.data) ? res.data.map(pickRow) : [];
            state.loadedAt = Date.now();
            render();
            try {
                sessionStorage.setItem(SIZE_KEY, String(state.rows.length));
                sessionStorage.setItem(QUEUE_KEY, String($('#queue-list').children.length));
            } catch (e) { /* ignore */ }
            onLoadOk();
        } catch (err) {
            /* A bug in drawing, not a network problem. Say so, keep polling. */
            console.error('Teacher console: could not draw the class.', err);
            onLoadError({ code: 'render' });
        }
    }

    function explain(err) {
        var code = String((err && err.code) || '');
        var msg = String((err && err.message) || '');
        if (code === '42501') {
            return 'Your sign-in expired or lost teacher access. Sign out and back in; if it keeps happening, ask the admin.';
        }
        if (code === 'PGRST202' || code === '42883') {
            return "The live monitor isn't installed on the server yet. Ask the admin to run migration 0026.";
        }
        if (code === 'render') {
            return 'Something broke while drawing the class. Reload the page.';
        }
        if (!code || /fetch|network|load failed/i.test(msg)) {
            return "Can't reach the server. Check the Wi-Fi; PIA retries every 10 seconds.";
        }
        return 'The server turned the request down (' + code + '). PIA retries every 10 seconds.';
    }

    function setPhase(phase) {
        $('#console').setAttribute('data-load', phase);
        var loading = phase === 'loading';
        $('#queue').setAttribute('aria-busy', String(loading));
        $('#roster').setAttribute('aria-busy', String(loading));
        $$('.tally').forEach(function (el) { el.disabled = phase !== 'ready'; });
    }

    function onLoadError(err) {
        var message = explain(err);
        if (!state.loadedAt) {
            /* Nothing on screen yet: the roster becomes the error, with a retry. */
            setPhase('error');
            trim($('#queue-list'), 0);
            trim($('#roster-body'), 0);
            setText($('#error-text'), message);
        } else if (state.connection !== 'lost') {
            /* Keep what is on screen, and say once how old it is. */
            toast('Connection lost', 'Still showing the class as of ' + clock(state.loadedAt) + '. ' + message, 'danger');
        }
        state.connection = 'lost';
        paintLive();
    }

    function onLoadOk() {
        if (state.connection === 'lost' && $('#console').getAttribute('data-load') === 'ready') {
            toast('Back online', 'The class is up to date again.');
        }
        state.connection = 'ok';
        setPhase('ready');
        paintLive();
    }

    /* ============================================ 6. DRAWING =========== */

    function render() {
        paintCounts();
        paintQueue();
        paintRoster();
        announceNewFlags();
    }

    function paintCounts() {
        var c = { all: state.rows.length, attention: 0, solving: 0, finished: 0, offline: 0 };
        var online = 0;
        state.rows.forEach(function (r) {
            if (r.attention) { c.attention++; }
            if (r.activity === 'solving') { c.solving++; }
            if (r.activity === 'finished') { c.finished++; }
            if (r.activity === 'offline') { c.offline++; }
            if (r.online) { online++; }
        });
        $$('[data-count]').forEach(function (el) {
            var n = c[el.getAttribute('data-count')] || 0;
            setText(el, n);
            el.setAttribute('data-n', String(n));
        });
        setText($('#tally-online'), online + ' online');
        setText($('#queue-n'), c.attention);
        setText($('#nav-count-students'), state.rows.length);
    }

    function paintFilters() {
        $$('.tally').forEach(function (el) {
            el.setAttribute('aria-pressed', String(el.getAttribute('data-filter') === state.filter));
        });
    }

    /* ---- The queue: flagged students, longest wait first ---- */
    function paintQueue() {
        var flagged = state.rows.filter(function (r) { return !!r.attention; });
        flagged.sort(function (a, b) {
            return (toCount(b.attention_minutes) - toCount(a.attention_minutes)) ||
                nameOf(a).localeCompare(nameOf(b));
        });

        var shown = flagged.slice(0, QUEUE_MAX);
        var list = $('#queue-list');
        var live = new Set();

        shown.forEach(function (r, i) {
            var key = String(r.student_key);
            var li = queueEls.get(key);
            if (!li) {
                li = clone('tpl-queue');
                li.setAttribute('data-key', key);
                queueEls.set(key, li);
            }
            live.add(key);
            setText($('.q-min-n', li), toCount(r.attention_minutes));
            setText($('.q-name', li), nameOf(r));
            setText($('.q-why', li), REASON[r.attention] || 'Needs a look');
            place(list, li, i);
        });
        trim(list, shown.length);
        queueEls.forEach(function (el, key) { if (!live.has(key)) { queueEls.delete(key); } });

        var more = $('#queue-more');
        more.hidden = flagged.length <= shown.length;
        setText($('#queue-more-text'), 'Show all ' + flagged.length + ' in the roster');
        setText($('#queue-clear'), state.section ? "All clear. Nobody's stuck." : 'Nothing to watch yet.');
    }

    /* ---- The roster: everyone, filtered and searched ---- */
    function rosterOrder(a, b) {
        if (!!a.attention !== !!b.attention) { return a.attention ? -1 : 1; }
        if (a.attention && b.attention) {
            var m = toCount(b.attention_minutes) - toCount(a.attention_minutes);
            if (m) { return m; }
        }
        var d = (ORDER[a.activity] || 9) - (ORDER[b.activity] || 9);
        return d || nameOf(a).localeCompare(nameOf(b));
    }

    function fillRow(tr, r) {
        var a = ACTIVITY[r.activity] || ACTIVITY.offline;
        var target = Math.min(toCount(r.problems_target) || 10, 20);
        var done = Math.min(toCount(r.problems_done), target);

        setText($('.r-name', tr), nameOf(r));

        var mk = $('.mk', tr);
        if (mk.getAttribute('data-mark') !== a.mark) { mk.setAttribute('data-mark', a.mark); }
        setText($('.r-status-text', tr), a.label);

        /* This lesson: one cell per problem, "n/10" beside it. */
        var counts = a.lesson === 'yes' || (a.lesson === 'if-any' && done > 0);
        var lesson = $('.r-lesson', tr);
        if (lesson.hasAttribute('data-na') === counts) { lesson.toggleAttribute('data-na', !counts); }
        var strip = $('.strip', tr);
        if (strip.childElementCount !== target) {
            strip.textContent = '';
            for (var i = 0; i < target; i++) { strip.appendChild(document.createElement('span')); }
        }
        Array.prototype.forEach.call(strip.children, function (cell, j) {
            var on = counts && j < done;
            if (cell.classList.contains('on') !== on) { cell.classList.toggle('on', on); }
        });
        setText($('.r-count', tr), counts ? done + '/' + target : '—');
        $('.r-count-sr', tr).hidden = !counts;

        /* The flag: words and minutes, amber. */
        var flag = $('.flag', tr);
        if (flag.hidden === !!r.attention) { flag.hidden = !r.attention; }
        setText($('.flag-text', tr), r.attention
            ? (REASON[r.attention] || 'Needs a look') + ' · ' + toCount(r.attention_minutes) + ' min'
            : '');

        setText($('.r-last', tr), agoText(r.seconds_since_active));
    }

    function paintRoster() {
        var term = state.search.trim().toLowerCase();
        var match = FILTERS[state.filter] || FILTERS.all;
        var list = state.rows.filter(function (r) {
            return match(r) && (!term || nameOf(r).toLowerCase().indexOf(term) !== -1);
        });
        list.sort(rosterOrder);

        var body = $('#roster-body');
        list.forEach(function (r, i) {
            var key = String(r.student_key);
            var tr = rowEls.get(key);
            if (!tr) {
                tr = clone('tpl-row');
                tr.setAttribute('data-key', key);
                rowEls.set(key, tr);
            }
            fillRow(tr, r);
            place(body, tr, i);
        });
        trim(body, list.length);

        /* Forget students who left the section; keep the filtered-out ones. */
        var present = new Set(state.rows.map(function (r) { return String(r.student_key); }));
        rowEls.forEach(function (el, key) { if (!present.has(key)) { rowEls.delete(key); } });

        paintRosterMeta(list.length, term);
        paintFilters();
    }

    function paintRosterMeta(shown, term) {
        var total = state.rows.length;
        var narrowed = state.filter !== 'all' || !!term;

        setText($('#roster-sub'), narrowed
            ? 'Showing ' + shown + ' of ' + total
            : total + ' student' + (total === 1 ? '' : 's'));
        $('#reset-filters').hidden = !narrowed;

        if (shown) { return; }

        /* The words for an empty roster. CSS decides when they show. */
        var title, text;
        if (!total) {
            title = state.section ? 'No students in Section ' + state.section + ' yet.' : 'No section on your account yet.';
            text = state.section
                ? 'They appear here once the admin adds them. This page fills in by itself.'
                : 'Ask the admin to assign you one. This page fills in by itself.';
        } else if (term) {
            title = 'Nobody called “' + state.search.trim() + '”' + (state.filter !== 'all' ? ' ' + FILTER_WORDS[state.filter] : '') + '.';
            text = 'Check the spelling, or show everyone.';
        } else if (state.filter === 'attention') {
            title = 'Nobody needs attention.';
            text = 'Flagged students show up here and in the queue.';
        } else {
            title = 'Nobody ' + FILTER_WORDS[state.filter] + ' right now.';
            text = 'Pick another count, or show everyone.';
        }
        setText($('#empty-title'), title);
        setText($('#empty-text'), text);
    }

    /* A screen-reader teacher hears when someone new is flagged. */
    function announceNewFlags() {
        var now = {};
        var fresh = [];
        state.rows.forEach(function (r) {
            if (!r.attention) { return; }
            var key = String(r.student_key);
            now[key] = true;
            if (state.flagged && !state.flagged[key]) { fresh.push(r); }
        });
        state.flagged = now;

        if (fresh.length === 1) {
            var r = fresh[0];
            announce(nameOf(r) + ' needs attention: ' + (REASON[r.attention] || 'needs a look').toLowerCase() +
                ', ' + toCount(r.attention_minutes) + ' minutes.');
        } else if (fresh.length > 1) {
            announce(fresh.length + ' more students need attention.');
        }
    }

    /* ---- Loading skeletons, sized to the last class seen ---- */
    function paintSkeletons() {
        var n = 8, q = 2;
        try {
            n = toCount(sessionStorage.getItem(SIZE_KEY)) || 8;
            q = toCount(sessionStorage.getItem(QUEUE_KEY));
        } catch (e) { /* ignore */ }
        n = Math.min(Math.max(n, 3), 40);
        /* Two is what the queue reserves anyway (teacher.css, --q-row). */
        q = Math.min(Math.max(q, 2), QUEUE_MAX);

        var body = $('#roster-body');
        for (var i = 0; i < n; i++) { body.appendChild(clone('tpl-skel-row')); }
        var list = $('#queue-list');
        for (var j = 0; j < q; j++) { list.appendChild(clone('tpl-skel-queue')); }
    }

    /* ============================================ 7. LIVE STATUS ======= */

    function paintLive() {
        var el = $('#live');
        var text, mode;
        if (state.connection === 'lost') {
            mode = 'lost';
            text = state.loadedAt ? 'Reconnecting · last ' + clock(state.loadedAt) : 'Reconnecting…';
        } else if (!state.loadedAt) {
            mode = 'connecting';
            text = 'Connecting…';
        } else {
            var sec = Math.round((Date.now() - state.loadedAt) / 1000);
            mode = 'live';
            text = sec < 15 ? 'Live · every 10 s' : (sec < 60 ? 'Updated ' + sec + 's ago' : 'Updated ' + Math.floor(sec / 60) + 'm ago');
        }
        if (el.getAttribute('data-state') !== mode) { el.setAttribute('data-state', mode); }
        setText($('#live-text'), text);
    }

    var pollId = null;

    function schedule() {
        clearTimeout(pollId);
        pollId = setTimeout(function () {
            /* A hidden tab does not poll; showing it again refreshes at once. */
            var work = document.hidden ? Promise.resolve() : refresh();
            work.then(schedule, schedule);
        }, REFRESH_MS);
    }

    /* ============================================ 8. CONTROLS ========== */

    function scrollToRoster(focus) {
        var roster = $('#roster');
        var top = roster.getBoundingClientRect().top;
        /* Only when the roster is off screen, which on a phone it usually is. */
        if (top > window.innerHeight * 0.6 || top < 0) {
            roster.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
        }
        if (focus) { $('#roster-title').focus({ preventScroll: true }); }
    }

    function setFilter(f) {
        state.filter = FILTERS[f] ? f : 'all';
        paintRoster();
    }

    function bindControls() {
        $('#search-student').addEventListener('input', debounce(function (e) {
            state.search = e.target.value;
            paintRoster();
        }, 120));

        $$('.tally').forEach(function (el) {
            el.addEventListener('click', function () {
                var f = el.getAttribute('data-filter');
                /* Pressing the pressed filter again goes back to everyone. */
                setFilter(state.filter === f ? 'all' : f);
                scrollToRoster(false);
            });
        });

        $('#queue-more').addEventListener('click', function () {
            setFilter('attention');
            scrollToRoster(true);
        });

        $('#reset-filters').addEventListener('click', function () {
            state.search = '';
            $('#search-student').value = '';
            setFilter('all');
            $('#search-student').focus({ preventScroll: true });
        });

        $('#refresh-btn').addEventListener('click', function () {
            var btn = this;
            if (isBusy(btn)) { return; }
            busy(btn, true);
            refresh().then(function () {
                busy(btn, false);
                schedule();
            });
        });

        $('#retry-btn').addEventListener('click', function () {
            var btn = this;
            if (isBusy(btn)) { return; }
            busy(btn, true);
            setText(btn, 'Trying…');
            refresh().then(function () {
                busy(btn, false);
                setText(btn, 'Try again');
                schedule();
            });
        });

        document.addEventListener('visibilitychange', function () {
            if (document.hidden) { return; }
            refresh().then(schedule);
        });

        $('#signout-confirm').addEventListener('click', function () {
            var btn = this;
            if (signingOut) { return; }
            signingOut = true;
            clearTimeout(pollId);
            busy(btn, true);
            setText(btn, 'Signing out…');
            $$('[data-modal-close]', $('#modal-signout')).forEach(function (b) { b.setAttribute('aria-disabled', 'true'); });

            /* executeForceLogout awaits the server; on a hung connection the
               button would say "Signing out…" forever. After 8 seconds, finish
               locally: this device forgets the session either way. */
            setTimeout(function () {
                try { localStorage.clear(); sessionStorage.clear(); } catch (e) { /* ignore */ }
                window.location.replace('../../index.html');
            }, 8000);

            if (typeof executeForceLogout === 'function') { executeForceLogout(); }
            else { window.location.replace('../../index.html'); }
        });
    }

    /* ---- The network, heard directly rather than at the next poll ---- */
    function bindNetwork() {
        window.addEventListener('offline', function () {
            if (state.connection === 'lost') { return; }
            if (state.loadedAt) {
                toast("You're offline", 'Still showing the class as of ' + clock(state.loadedAt) +
                    '. PIA reconnects on its own.', 'danger');
            }
            state.connection = 'lost';
            paintLive();
        });

        /* Back online: fetch now (onLoadOk says "Back online" once it lands). */
        window.addEventListener('online', function () {
            refresh().then(schedule);
        });
    }

    /* ---- Skip link: focus the main region itself, not just the URL hash ---- */
    function bindSkipLink() {
        var link = $('#skip-link');
        if (!link) { return; }
        link.addEventListener('click', function (e) {
            e.preventDefault();
            var main = $('#main');
            main.focus({ preventScroll: true });
            main.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
        });
    }

    /* ---- The phone/tablet drawer (≤1024px), made keyboard- and
       screen-reader-honest. shell.js slides it in and out; this keeps the
       semantics in step with what is on screen:
         closed -> the drawer is inert (no tabbing into an invisible panel)
         open   -> the page behind it is inert, focus moves into it, Escape
                   or choosing a link closes it, focus returns to the toggle
       and the toggle's aria-expanded always tells the truth. ---- */
    function initDrawerA11y() {
        var app = $('#app');
        var sidebar = $('#sidebar');
        var toggle = $('#mobile-nav-toggle');
        var workspace = $('.workspace');
        var skip = $('#skip-link');
        if (!app || !sidebar || !toggle || !workspace) { return; }

        var mq = window.matchMedia('(max-width: 1024px)');
        var wasOpen = false;

        function isOpen() { return app.getAttribute('data-mobile-nav') === 'open'; }

        function sync() {
            var mobile = mq.matches;
            var open = isOpen();

            /* Crossing to desktop with the drawer open would strand its scrim
               over the page; close it properly instead. */
            if (!mobile && open) { PIAShell.closeMobileNav(); return; }

            sidebar.toggleAttribute('inert', mobile && !open);
            workspace.toggleAttribute('inert', mobile && open);
            if (skip) { skip.toggleAttribute('inert', mobile && open); }
            toggle.setAttribute('aria-expanded', String(mobile && open));

            if (open && !wasOpen) {
                var first = $('.nav-item', sidebar);
                if (first) { first.focus({ preventScroll: true }); }
            } else if (!open && wasOpen && mobile && !openLayers.length) {
                toggle.focus({ preventScroll: true });
            }
            wasOpen = open;
        }

        new MutationObserver(sync).observe(app, { attributes: true, attributeFilter: ['data-mobile-nav'] });
        if (mq.addEventListener) { mq.addEventListener('change', sync); } else { mq.addListener(sync); }

        document.addEventListener('keydown', function (e) {
            if (e.key !== 'Escape' || openLayers.length || !isOpen()) { return; }
            e.preventDefault();
            PIAShell.closeMobileNav();
        });

        /* Choosing where to go closes the drawer, as on any phone app. */
        $$('.nav-item, .brand-link', sidebar).forEach(function (a) {
            a.addEventListener('click', function () {
                if (mq.matches && isOpen()) { PIAShell.closeMobileNav(); }
            });
        });

        sync();
    }

    /* ============================================ 9. BOOT ============== */

    function hello() {
        console.info('%cPIA // teacher console', 'font-family: ui-monospace, monospace; font-weight: 700;');
        console.info('Looking for OCEAN scores or research groups? Wrong room. They never leave the database: ' +
            'this page gets a name, a status and a count. (CERC 2025-1-PTCS-231, migration 0026)');
    }

    var started = false;
    var bootFailure = null;     /* 'offline' | 'no-client' while the veil offers a retry */

    /* The access check could not reach the server. The veil stays up (the
       page behind it is not ready to be used) and says what happened in
       plain words, with one action. Nothing about the teacher is cleared. */
    function showBootRetry(kind) {
        bootFailure = kind;
        $('#boot-spinner').hidden = true;
        setBootText(kind === 'no-client'
            ? "PIA didn't finish loading. Check the connection, then try again."
            : "Can't reach PIA's server. Check the Wi-Fi, then try again. Nothing is lost.");
        var btn = $('#boot-retry');
        btn.hidden = false;
        busy(btn, false);
        setText(btn, 'Try again');
        btn.focus({ preventScroll: true });
    }

    function bindBootRetry() {
        var btn = $('#boot-retry');
        btn.addEventListener('click', function () {
            if (isBusy(btn) || !bootFailure) { return; }
            /* The client library itself is missing: only a reload fetches it. */
            if (bootFailure === 'no-client') { window.location.reload(); return; }
            busy(btn, true);
            setText(btn, 'Trying…');
            start().catch(function (err) {
                console.error('Teacher console failed to start.', err);
                if (!started) { showBootRetry('offline'); return; }
                showBanner('The console hit a snag starting up. Reload the page.');
                reveal();
            });
        });
        /* The connection came back while the veil was waiting: retry at once. */
        window.addEventListener('online', function () {
            if (!started && bootFailure === 'offline' && !isBusy(btn)) { btn.click(); }
        });
    }

    async function start() {
        $('#boot-spinner').hidden = false;
        setBootText('Checking your access…');

        var access = await enforceTeacherAccess();
        if (access === 'offline' || access === 'no-client') { showBootRetry(access); return; }
        if (access !== 'ok') { return; }

        started = true;
        bootFailure = null;
        $('#boot-retry').hidden = true;

        initModals();
        PIAShell.initRail({ hasOpenModal: function () { return openLayers.length > 0; } });
        initDrawerA11y();
        bindControls();
        bindNetwork();
        paintIdentity();

        /* Show the page now and let the skeletons carry the wait: the
           frame is already the right shape, so nothing jumps when the
           class arrives. */
        setPhase('loading');
        paintSkeletons();
        reveal();
        paintLive();

        await refresh();
        schedule();
        setInterval(paintLive, 5000);
    }

    async function boot() {
        hello();
        bindSkipLink();
        bindBootRetry();
        try {
            await start();
        } catch (err) {
            console.error('Teacher console failed to start.', err);
            showBanner('The console hit a snag starting up. Reload the page.');
            reveal();
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
