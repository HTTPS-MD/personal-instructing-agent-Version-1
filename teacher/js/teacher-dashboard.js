/**
 * ============================================================================
 * PIA SYSTEM — TEACHER CONSOLE (live monitor)
 * ============================================================================
 * One screen for a teacher running a 75-minute PIA session in their own
 * section: who is here, who is working, who needs attention, and how far
 * each student is through this lesson. Uses the shared `sb` client from
 * function.js and the shared rail from shell.js.
 *
 * WITHIN THE CERC PROTOCOL: everything about students comes from one server
 * function, teacher_class_status (migration 0026), which returns only a
 * name, a status, a progress count and an attention flag. Personality
 * results, the research group, the tutor persona and test scores never
 * reach this page -- teachers cannot read student rows directly any more,
 * so not even the browser console can ask for them.
 * ==========================================================================*/
(function () {
    'use strict';

    var $ = function (s, r) { return (r || document).querySelector(s); };
    var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

    var esc = (typeof escapeHTML === 'function') ? escapeHTML : function (v) {
        return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    };

    var state = {
        section: null,
        name: null,
        email: null,
        rows: [],
        loadedAt: 0,
        filter: 'all',
        search: ''
    };

    function debounce(fn, wait) {
        var t = null;
        return function () {
            var a = arguments, s = this;
            clearTimeout(t);
            t = setTimeout(function () { fn.apply(s, a); }, wait || 200);
        };
    }

    function initialsOf(name, email) {
        var src = (name || '').trim().replace(/^(Dr|Prof|Mr|Mrs|Ms)\.?\s+/i, '');
        if (!src) { return (email || '?').slice(0, 2).toUpperCase(); }
        var p = src.split(/\s+/);
        return (p.length === 1 ? p[0].slice(0, 2) : p[0][0] + p[p.length - 1][0]).toUpperCase();
    }

    /* ============================================ 1. BOOT GATE ========= */

    function setBootText(m) { var n = $('#boot-text'); if (n) { n.textContent = m; } }

    function reveal() {
        document.body.removeAttribute('data-boot');
        var v = $('#boot-veil');
        if (v) { setTimeout(function () { v.hidden = true; }, 200); }
    }

    function showAccessError(message) {
        var banner = $('#global-error-banner');
        if (!banner) { return; }
        $('#global-error-message').textContent = message;
        banner.hidden = false;
    }

    /* ============================================ 2. MODALS + TOAST ==== */

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
        var o = document.getElementById(id);
        if (!o || openLayers.indexOf(o) !== -1) { return; }
        if (!openLayers.length) { lastFocused = document.activeElement; lockScroll(); }
        o.classList.add('is-mounted');
        openLayers.push(o);
        
        /* Raise this layer above every layer already open. All overlays share
           one base z-index in CSS, so without this the winner is decided by DOM
           source order — which is how an open drawer ended up covering a
           confirmation dialog it had itself triggered. z-index does not affect
           layout, so this costs nothing in CLS. */
        o.style.zIndex = String(Z_OVERLAY_BASE + openLayers.length);
        void o.offsetWidth;
        o.classList.add('is-open');
        var f = o.querySelector('button, input, select, textarea');
        if (f) { f.focus({ preventScroll: true }); }
    }

    function closeModal(target) {
        var o = (typeof target === 'string') ? document.getElementById(target) : target;
        o = o || openLayers[openLayers.length - 1];
        if (!o) { return; }
        o.classList.remove('is-open');
        o.style.zIndex = '';
        openLayers = openLayers.filter(function (l) { return l !== o; });
        setTimeout(function () {
            o.classList.remove('is-mounted');
            if (!openLayers.length) {
                unlockScroll();
                if (lastFocused && lastFocused.focus) { lastFocused.focus({ preventScroll: true }); }
            }
        }, 160);
    }

    function initModals() {
        $$('[data-modal-open]').forEach(function (t) {
            t.addEventListener('click', function () { openModal(t.getAttribute('data-modal-open')); });
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

    function toast(title, description, tone) {
        var stack = $('#toast-stack');
        if (!stack) { return; }
        var n = document.createElement('div');
        n.className = 'toast toast-' + (tone === 'danger' ? 'danger' : 'accent');
        n.innerHTML = '<svg class="icon"><use href="#i-' + (tone === 'danger' ? 'alert' : 'check') +
            '"></use></svg><div class="toast-text"><p class="toast-title">' + esc(title) + '</p>' +
            (description ? '<p class="toast-desc">' + esc(description) + '</p>' : '') + '</div>';
        stack.appendChild(n);
        void n.offsetWidth;
        n.classList.add('is-open');
        setTimeout(function () {
            n.classList.remove('is-open');
            setTimeout(function () { n.remove(); }, 200);
        }, 3800);
    }

    function setBusy(button, label) {
        if (!button) { return function () {}; }
        var html = button.innerHTML, w = button.getBoundingClientRect().width;
        button.style.width = Math.ceil(w) + 'px';
        button.disabled = true;
        button.textContent = label || 'Working…';
        return function () {
            button.innerHTML = html;
            button.disabled = false;
            button.style.width = '';
        };
    }

    /* ============================================ 3. ACCESS GUARD ====== */

    async function enforceTeacherAccess() {
        if (typeof sb === 'undefined' || !sb) {
            setBootText('Could not connect.');
            showAccessError('Database connection failed. Please refresh.');
            return false;
        }

        try {
            var session = await sb.auth.getSession();
            if (session.error || !session.data.session) { throw new Error('Session expired. Please log in again.'); }

            var email = session.data.session.user.email;
            var res = await sb.from('profiles').select('role, section, full_name').eq('email', email).maybeSingle();

            if (res.error || !res.data || res.data.role !== 'teacher') {
                throw new Error('Unauthorized access. Teacher privileges required.');
            }

            try { localStorage.setItem('pia_user_email', email); } catch (e) { /* private mode */ }

            state.email = email;
            state.section = res.data.section || null;
            state.name = res.data.full_name || null;

            /* profiles is the source of truth; the professors row is a fallback
               for accounts created before the two were written together. */
            if (!state.section || !state.name) {
                var prof = await sb.from('professors').select('name, assigned_section').eq('email', email).maybeSingle();
                if (!state.section) { state.section = (prof.data && prof.data.assigned_section) || null; }
                if (!state.name) { state.name = (prof.data && prof.data.name) || null; }
            }

            var shown = state.name || email.split('@')[0];
            $('#teacher-name').textContent = shown;
            $('#teacher-email').textContent = email;
            $('#teacher-initials').textContent = initialsOf(shown, email);
            $('#teacher-section-label').textContent = state.section
                ? 'Section ' + state.section : 'No section assigned';

            var hour = new Date().getHours();
            var greet = hour < 12 ? 'Good morning' : (hour < 18 ? 'Good afternoon' : 'Good evening');

            /* Faculty names carry an honorific, so a naive first-word split
               greets them as "Dr." — keep the title WITH the surname, which is
               how a teacher is actually addressed. */
            var honorific = /^(Dr|Prof|Mr|Mrs|Ms)\.?\s+/i.exec(shown);
            var parts = shown.trim().split(/\s+/);
            var address = honorific
                ? parts[0] + ' ' + parts[parts.length - 1]
                : parts[0];
            $('#page-greeting').textContent = greet + ', ' + address;

            return true;
        } catch (e) {
            console.error('Teacher dashboard access error:', e);
            setBootText(e.message || 'Failed to verify access.');
            showAccessError(e.message || 'Failed to verify access.');
            try { localStorage.removeItem('pia_user_email'); } catch (err) { /* ignore */ }
            setTimeout(function () { window.location.replace('../../index.html'); }, 3000);
            return false;
        }
    }

    /* ============================================ 4. DATA ============== */

    /* Ten seconds is "live" for a classroom, and 31 rows is a trivial query.
       Polling a guarded function rather than subscribing to table changes is
       deliberate: a realtime subscription streams WHOLE rows, and a student
       row carries exactly the research columns this page must never see. */
    var REFRESH_MS = 10000;

    var ACTIVITY = {
        solving:     { label: 'Solving',         tone: 'online' },
        idle:        { label: 'Idle',            tone: 'inactive' },
        not_started: { label: 'Not started yet', tone: 'inactive' },
        setting_up:  { label: 'Getting set up',  tone: 'neutral' },
        waiting:     { label: 'In waiting room', tone: 'neutral' },
        finished:    { label: 'Finished',        tone: 'done' },
        offline:     { label: 'Offline',         tone: 'offline' }
    };

    /* Who to look at first, after anyone who needs attention. */
    var ORDER = { idle: 1, not_started: 2, solving: 3, setting_up: 4, waiting: 5, finished: 6, offline: 7 };

    function attentionText(r) {
        var m = r.attention_minutes || 0;
        if (r.attention === 'stuck') { return 'Same problem for ' + m + ' min'; }
        if (r.attention === 'idle') { return 'No activity for ' + m + ' min'; }
        if (r.attention === 'dropped') { return 'Disconnected mid-lesson'; }
        return '';
    }

    function agoText(sec) {
        if (sec === null || sec === undefined) { return '—'; }
        if (sec < 60) { return 'Just now'; }
        var m = Math.floor(sec / 60);
        return m < 60 ? m + ' min ago' : Math.floor(m / 60) + ' h ago';
    }

    function skeletonRows(n) {
        var out = '';
        for (var i = 0; i < (n || 5); i++) {
            out += '<tr aria-hidden="true"><td><div class="cell-user">' +
                '<span class="skeleton skeleton-avatar"></span>' +
                '<span class="skeleton skeleton-line" style="width:140px"></span></div></td>' +
                '<td><span class="skeleton skeleton-pill"></span></td>' +
                '<td><span class="skeleton skeleton-pill"></span></td>' +
                '<td><span class="skeleton skeleton-pill"></span></td>' +
                '<td class="col-right"><span class="skeleton skeleton-pill"></span></td></tr>';
        }
        return out;
    }

    async function loadMonitoring() {
        var tbody = $('#student-monitoring-body');

        if (!state.section) {
            tbody.innerHTML = '<tr><td colspan="5" class="empty-cell">' +
                'No section is assigned to your account yet. Please contact the administrator.</td></tr>';
            $('#roster-sub').textContent = 'No section assigned.';
            paintStats([]);
            return;
        }

        if (!state.loadedAt) { tbody.innerHTML = skeletonRows(6); }

        var res;
        try {
            res = await sb.rpc('teacher_class_status');
        } catch (err) {
            res = { error: err };
        }

        if (res.error) {
            paintConnection('error');
            if (!state.loadedAt) {
                tbody.innerHTML = '<tr><td colspan="5" class="empty-cell">Could not load your class. ' +
                    esc(res.error.message || '') + '</td></tr>';
            }
            return;
        }

        state.rows = res.data || [];
        state.loadedAt = Date.now();
        $('#nav-count-students').textContent = state.rows.length;
        render();
        paintConnection('ok');
    }

    function paintStats(rows) {
        var count = function (test) { return rows.filter(test).length; };
        $('#stat-total').textContent = rows.length;
        $('#stat-online').textContent = count(function (r) { return r.online; }) + ' online';
        $('#stat-attention').textContent = count(function (r) { return !!r.attention; });
        $('#stat-solving').textContent = count(function (r) { return r.activity === 'solving'; });
        $('#stat-finished').textContent = count(function (r) { return r.activity === 'finished'; });
    }

    function matchesFilter(r) {
        if (state.filter === 'attention') { return !!r.attention; }
        if (state.filter === 'solving') { return r.activity === 'solving'; }
        if (state.filter === 'finished') { return r.activity === 'finished'; }
        return true;
    }

    function progressCell(r) {
        /* Before the lesson (waiting, setting up) there is nothing to count. */
        if (r.activity === 'waiting' || r.activity === 'setting_up' ||
            (r.activity === 'offline' && !r.problems_done)) {
            return '<span class="muted">—</span>';
        }
        var target = r.problems_target || 10;
        var pct = Math.round(Math.min(r.problems_done, target) / target * 100);
        return '<span class="lesson-progress">' +
            '<span class="bar"><span class="bar-fill" style="width:' + pct + '%"></span></span>' +
            '<span class="tnum">' + r.problems_done + ' / ' + target + '</span></span>';
    }

    function render() {
        paintStats(state.rows);

        var term = state.search.trim().toLowerCase();
        var rows = state.rows.filter(function (r) {
            if (!matchesFilter(r)) { return false; }
            return !term || String(r.full_name || '').toLowerCase().indexOf(term) !== -1;
        });

        /* Attention first -- longest wait at the top -- then by status. */
        rows.sort(function (a, b) {
            if (!!a.attention !== !!b.attention) { return a.attention ? -1 : 1; }
            if (a.attention && b.attention) { return (b.attention_minutes || 0) - (a.attention_minutes || 0); }
            var d = (ORDER[a.activity] || 9) - (ORDER[b.activity] || 9);
            return d || String(a.full_name).localeCompare(String(b.full_name));
        });

        var empty = !rows.length;
        $('#empty-state').style.display = empty ? 'block' : 'none';
        if (empty) {
            var noneYet = state.filter === 'attention' && !term;
            $('#empty-title').textContent = noneYet ? 'Nobody needs attention right now' : 'Nobody matches that';
            $('#empty-desc').textContent = noneYet
                ? 'Students stuck, idle or disconnected will appear here.'
                : 'Try another tile, or clear the search box.';
        }

        $('#student-monitoring-body').innerHTML = rows.map(function (r) {
            var a = ACTIVITY[r.activity] || ACTIVITY.offline;
            var pulse = r.activity === 'solving' ? ' engagement-dot-pulse' : '';
            var att = attentionText(r);

            return '' +
                '<tr data-key="' + esc(r.student_key) + '"' + (r.attention ? ' class="needs-attention"' : '') + '>' +
                '<td><div class="cell-user">' +
                '<span class="student-avatar-wrap">' +
                '<span class="student-avatar-initial">' + esc(initialsOf(r.full_name, '')) + '</span>' +
                '<span class="student-avatar-status status-dot-' + a.tone + '"></span></span>' +
                '<span class="cell-name">' + esc(r.full_name) + '</span>' +
                '</div></td>' +
                '<td><span class="engagement-badge status-badge-' + a.tone + '">' +
                '<span class="status-dot status-dot-' + a.tone + pulse + '"></span>' + esc(a.label) + '</span></td>' +
                '<td>' + progressCell(r) + '</td>' +
                '<td>' + (att
                    ? '<span class="learning-badge learning-struggling"><svg class="icon"><use href="#i-alert"></use></svg>' +
                      esc(att) + '</span>'
                    : '<span class="muted">—</span>') + '</td>' +
                '<td class="col-right muted tnum">' + esc(agoText(r.seconds_since_active)) + '</td>' +
                '</tr>';
        }).join('');

        $('#roster-sub').textContent = rows.length === state.rows.length
            ? 'Section ' + state.section + ' · ' + rows.length + ' student' + (rows.length === 1 ? '' : 's')
            : 'Showing ' + rows.length + ' of ' + state.rows.length;

        $$('[data-filter]').forEach(function (el) {
            el.classList.toggle('is-active', el.getAttribute('data-filter') === state.filter);
        });
    }

    /* ============================================ 5. LIVE REFRESH ====== */

    function paintConnection(status) {
        var dot = $('#live-dot'), label = $('#live-label');
        if (!dot || !label) { return; }
        if (status === 'ok') {
            dot.className = 'dot dot-live';
            var sec = Math.round((Date.now() - state.loadedAt) / 1000);
            label.textContent = sec < 5 ? 'Live' : 'Updated ' + sec + 's ago';
        } else {
            dot.className = 'dot dot-warn';
            label.textContent = 'Reconnecting…';
        }
    }

    var pollId = null;

    function schedule() {
        clearTimeout(pollId);
        pollId = setTimeout(async function () {
            /* A hidden tab does not poll; showing it again refreshes at once. */
            if (!document.hidden) { await loadMonitoring(); }
            schedule();
        }, REFRESH_MS);
    }

    /* The "updated … ago" label ticks between refreshes. */
    setInterval(function () { if (state.loadedAt) { paintConnection('ok'); } }, 5000);

    /* ============================================ 6. BOOT ============== */

    async function boot() {
        setBootText('Verifying your access…');
        var allowed = await enforceTeacherAccess();
        if (!allowed) { return; }

        initModals();
        PIAShell.initRail({ hasOpenModal: function () { return openLayers.length > 0; } });

        $('#search-student').addEventListener('input', debounce(function (e) {
            state.search = e.target.value;
            render();
        }, 200));

        $$('[data-filter]').forEach(function (el) {
            el.addEventListener('click', function () {
                var f = el.getAttribute('data-filter');
                /* Clicking the active tile again goes back to everyone. */
                state.filter = (state.filter === f) ? 'all' : f;
                render();
            });
        });

        $('#reset-filters').addEventListener('click', function () {
            state.filter = 'all';
            state.search = '';
            $('#search-student').value = '';
            render();
        });

        $('#refresh-btn').addEventListener('click', async function () {
            var release = setBusy(this, '…');
            await loadMonitoring();
            release();
            toast('Refreshed', 'Your class is up to date.');
        });

        document.addEventListener('visibilitychange', function () {
            if (!document.hidden) { loadMonitoring(); }
        });

        $('#signout-confirm').addEventListener('click', function () {
            if (typeof executeForceLogout === 'function') { executeForceLogout(); }
            else { window.location.replace('../../index.html'); }
        });

        setBootText('Loading your section…');
        await loadMonitoring();
        reveal();
        schedule();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
