/**
 * ============================================================================
 * PIA SYSTEM — TEACHER CONSOLE
 * ============================================================================
 * Live monitoring for one section. Uses the shared `sb` client from
 * function.js and the shared rail from shell.js.
 *
 * RESEARCH INTEGRITY: ocean_* is never selected here. A teacher who knows a
 * student's trait scores may teach them differently, which would contaminate
 * the variable the study measures. Only progress and activity are exposed.
 * ==========================================================================*/
(function () {
    'use strict';

    var $ = function (s, r) { return (r || document).querySelector(s); };
    var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

    var esc = (typeof escapeHTML === 'function') ? escapeHTML : function (v) {
        return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    };

    /* A student is "gone quiet" after this long without the app writing a
       timestamp for them. */
    var IDLE_MINUTES = 10;
    var STRUGGLING_BELOW = 70;

    var state = {
        section: null,
        name: null,
        email: null,
        students: [],
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

    /* Exactly the columns the table renders. Selecting '*' would ship every
       student's device IDs and OCEAN scores to the teacher's browser. */
    var COLUMNS = 'full_name, email, group_type, status, is_in_game, stage_started_at,' +
        ' selected_character, pre_test_score, post_test_score';

    function skeletonRows(n) {
        var out = '';
        for (var i = 0; i < (n || 5); i++) {
            out += '<tr aria-hidden="true"><td><div class="cell-user">' +
                '<span class="skeleton skeleton-avatar"></span><span style="width:150px">' +
                '<span class="skeleton skeleton-line" style="width:70%"></span>' +
                '<span class="skeleton skeleton-line" style="width:90%"></span></span></div></td>' +
                '<td><span class="skeleton skeleton-pill"></span></td>' +
                '<td><span class="skeleton skeleton-pill"></span></td>' +
                '<td><span class="skeleton skeleton-pill"></span></td>' +
                '<td><span class="skeleton skeleton-pill"></span></td>' +
                '<td class="col-right"><span class="skeleton skeleton-pill"></span></td></tr>';
        }
        return out;
    }

    /* Derives the three engagement states. is_in_game means working right now;
       otherwise stage_started_at is the newest timestamp the app actually
       writes (profiles has no last_seen column). */
    function engagementOf(s) {
        if ((s.status || '') !== 'active') { return 'offline'; }
        if (s.is_in_game) { return 'online'; }
        if (!s.stage_started_at) { return 'inactive'; }
        var mins = (Date.now() - new Date(s.stage_started_at).getTime()) / 60000;
        return mins > IDLE_MINUTES ? 'inactive' : 'online';
    }

    function learningOf(s) {
        return (s.pre_test_score !== null && s.pre_test_score !== undefined &&
            s.pre_test_score < STRUGGLING_BELOW) ? 'struggling' : 'smooth';
    }

    async function loadMonitoring() {
        var tbody = $('#student-monitoring-body');

        if (!state.section) {
            tbody.innerHTML = '<tr><td colspan="6" class="empty-cell">' +
                'No section is assigned to your account yet. Please contact the administrator.</td></tr>';
            paintStats([]);
            return;
        }

        if (!state.students.length) { tbody.innerHTML = skeletonRows(6); }

        var res = await sb.from('profiles').select(COLUMNS).eq('section', state.section)
            .order('full_name', { ascending: true });

        if (res.error) {
            tbody.innerHTML = '<tr><td colspan="6" class="empty-cell">Could not load your roster. ' +
                esc(res.error.message) + '</td></tr>';
            return;
        }

        state.students = res.data || [];
        $('#nav-count-students').textContent = state.students.length;
        render();
    }

    function paintStats(list) {
        var online = list.filter(function (s) { return engagementOf(s) === 'online'; }).length;
        var idle = list.filter(function (s) { return engagementOf(s) === 'inactive'; }).length;
        var strug = list.filter(function (s) { return learningOf(s) === 'struggling'; }).length;

        $('#stat-total').textContent = list.length;
        $('#stat-online').textContent = online;
        $('#stat-inactive').textContent = idle;
        $('#stat-struggling').textContent = strug;
    }

    function render() {
        paintStats(state.students);

        var term = state.search.trim().toLowerCase();
        var rows = state.students.filter(function (s) {
            var eng = engagementOf(s), learn = learningOf(s);

            if (state.filter === 'online' && eng !== 'online') { return false; }
            if (state.filter === 'inactive' && eng !== 'inactive') { return false; }
            if (state.filter === 'offline' && eng !== 'offline') { return false; }
            if (state.filter === 'struggling' && learn !== 'struggling') { return false; }
            if (state.filter === 'smooth' && learn !== 'smooth') { return false; }

            if (term) {
                return ((s.full_name || '') + ' ' + (s.email || '')).toLowerCase().indexOf(term) !== -1;
            }
            return true;
        });

        var tbody = $('#student-monitoring-body');
        $('#empty-state').style.display = rows.length ? 'none' : 'block';

        tbody.innerHTML = rows.map(function (s) {
            var eng = engagementOf(s);
            var learn = learningOf(s);

            var engLabel = { online: 'Working now', inactive: 'Gone quiet', offline: 'Not signed in' }[eng];
            var engClass = { online: 'status-badge-online', inactive: 'status-badge-inactive', offline: 'status-badge-offline' }[eng];
            var dotClass = { online: 'status-dot-online', inactive: 'status-dot-inactive', offline: 'status-dot-offline' }[eng];
            var pulse = eng === 'online' ? ' engagement-dot-pulse' : '';

            return '' +
                '<tr class="is-clickable" data-student="' + esc(s.email) + '">' +
                '<td><div class="cell-user">' +
                '<span class="student-avatar-wrap">' +
                '<span class="student-avatar-initial">' + esc(initialsOf(s.full_name, s.email)) + '</span>' +
                '<span class="student-avatar-status ' + dotClass + '"></span></span>' +
                '<span><span class="cell-name">' + esc(s.full_name || 'Unnamed student') + '</span>' +
                '<span class="cell-mail">' + esc(s.email || '') + '</span></span>' +
                '</div></td>' +
                '<td><span class="badge">' + esc(s.group_type || '—') + '</span></td>' +
                '<td class="muted">Algebraic expressions</td>' +
                '<td><span class="learning-badge ' + (learn === 'struggling' ? 'learning-struggling' : 'learning-smooth') + '">' +
                '<svg class="icon"><use href="#i-' + (learn === 'struggling' ? 'alert' : 'trend') + '"></use></svg>' +
                (learn === 'struggling' ? 'May need help' : 'Doing fine') + '</span></td>' +
                '<td><span class="engagement-badge ' + engClass + '">' +
                '<span class="status-dot ' + dotClass + pulse + '"></span>' + engLabel + '</span></td>' +
                '<td class="col-right"><button class="btn btn-secondary btn-sm" data-open="' + esc(s.email) + '">View</button></td>' +
                '</tr>';
        }).join('');

        $('#roster-sub').textContent = rows.length === state.students.length
            ? 'Showing all ' + rows.length + ' student' + (rows.length === 1 ? '' : 's') + '.'
            : 'Showing ' + rows.length + ' of ' + state.students.length + '.';

        $$('[data-filter]').forEach(function (el) {
            if (el.classList.contains('filter-tab')) {
                el.classList.toggle('active', el.getAttribute('data-filter') === state.filter);
            } else {
                el.classList.toggle('is-active', el.getAttribute('data-filter') === state.filter);
            }
        });
    }

    /* ============================================ 5. DRAWER ============ */

    function openStudent(email) {
        var s = state.students.filter(function (x) { return x.email === email; })[0];
        if (!s) { return; }

        var persona = (s.selected_character || '').replace('pia-', '') || 'not chosen';

        $('#profile-name').textContent = s.full_name || 'Unnamed student';
        $('#profile-email').textContent = s.email || '';
        $('#profile-section').textContent = state.section || '—';
        $('#profile-type').textContent = s.group_type || '—';
        $('#profile-pretest').textContent = s.pre_test_score == null ? 'Not recorded' : s.pre_test_score;
        $('#profile-posttest').textContent = s.post_test_score == null ? 'Not taken yet' : s.post_test_score;
        $('#profile-persona-badge').textContent = persona === 'not chosen'
            ? 'No tutor chosen' : persona.charAt(0).toUpperCase() + persona.slice(1) + ' tutor';

        /* Most persona art is not in the repo yet; fall back to a monogram
           rather than showing a broken image. */
        var box = $('#profile-avatar');
        var img = $('#profile-avatar-img');
        box.removeAttribute('data-mono');
        img.onerror = function () {
            box.setAttribute('data-mono', initialsOf(s.full_name, s.email));
        };
        img.src = s.selected_character
            ? '../../assets/images/' + s.selected_character.replace('pia-', 'char-') + '.png'
            : '../../assets/images/char-1.png';

        openModal('student-profile-screen');
    }

    /* ============================================ 6. REALTIME ========== */

    function paintConnection(status) {
        var dot = $('#live-dot'), label = $('#live-label');
        if (!dot || !label) { return; }
        if (status === 'SUBSCRIBED') { dot.className = 'dot dot-live'; label.textContent = 'Live'; }
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') { dot.className = 'dot dot-warn'; label.textContent = 'Reconnecting…'; }
        else if (status === 'CLOSED') { dot.className = 'dot dot-off'; label.textContent = 'Offline'; }
    }

    function setupRealtime() {
        if (typeof registerChannel !== 'function' || !state.section) { return; }

        /* Scoped to this teacher's own section: without the filter every change
           in the whole system reaches this browser. Debounced so a class all
           signing in at once does not fire dozens of reloads. */
        var suffix = String(state.section).replace(/[^A-Za-z0-9_-]/g, '_');
        var timer = null;

        registerChannel('teacher-monitoring-' + suffix, function (ch) {
            return ch.on('postgres_changes', {
                event: '*', schema: 'public', table: 'profiles',
                filter: 'section=eq.' + state.section
            }, function () {
                clearTimeout(timer);
                timer = setTimeout(loadMonitoring, 400);
            }).subscribe(paintConnection);
        });
    }

    /* Engagement is time-based, so a row can go stale without any database
       change. Re-deriving once a minute keeps "gone quiet" honest. */
    setInterval(function () { if (state.students.length) { render(); } }, 60000);

    /* ============================================ 7. BOOT ============== */

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
                state.filter = el.getAttribute('data-filter');
                render();
            });
        });

        $('#reset-filters').addEventListener('click', function () {
            state.filter = 'all';
            state.search = '';
            $('#search-student').value = '';
            render();
        });

        $('#student-monitoring-body').addEventListener('click', function (e) {
            var row = e.target.closest('[data-student]');
            if (row) { openStudent(row.getAttribute('data-student')); }
        });

        $('#refresh-btn').addEventListener('click', async function () {
            var release = setBusy(this, '…');
            await loadMonitoring();
            release();
            toast('Refreshed', 'Your roster is up to date.');
        });

        $('#signout-confirm').addEventListener('click', function () {
            if (typeof executeForceLogout === 'function') { executeForceLogout(); }
            else { window.location.replace('../../index.html'); }
        });

        setBootText('Loading your section…');
        await loadMonitoring();
        reveal();
        setupRealtime();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
