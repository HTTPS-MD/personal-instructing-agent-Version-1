/**
 * ============================================================================
 * PIA SYSTEM — TEACHER PAGE (one read-only roster)
 * ============================================================================
 * What a teacher sees: the students of their own section, whether each is online, which stage
 * they are at (OCEAN and Character Selection share one label so the research group is not
 * revealed), and while a roll call is open, who the admin marked present.
 *
 * What a teacher never gets: student numbers, emails, OCEAN results, research groups, tutor
 * personas, scores, answers or lesson progress. Those are not in the database function this page
 * calls (teacher_section_roster, migration 0064), so they cannot reach the browser at all.
 *
 * This page only READS. There is no button here that changes anything about a student.
 * ==========================================================================*/
(function () {
    'use strict';

    var $ = function (s, r) { return (r || document).querySelector(s); };
    var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

    var POLL_MS = 10000;
    var STAGE_LABEL = { setting_up: 'Setting up', waiting: 'Waiting', tutoring: 'Tutoring' };

    var state = { email: '', name: '', section: '', rows: [], filter: 'all', term: '', loadedAt: 0, loading: false };
    var pollId = null;
    var signingOut = false;
    var started = false;

    function setText(el, text) { if (el) { el.textContent = text; } }
    function bootText(message) { setText($('#boot-text'), message); }

    function isNetworkError(err) {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) { return true; }
        if (!err) { return false; }
        var code = String(err.code || '');
        var status = Number(err.status || 0);
        var msg = String(err.message || err);
        return !code && !status && /fetch|network|load failed|timed? ?out|offline/i.test(msg);
    }

    function clock(ms) {
        return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    /* ============================================ ACCESS ============== */

    function leave(message, ended) {
        bootText(message);
        $('#boot').hidden = false;
        $('#app').hidden = true;
        if (ended && typeof endStaffSession === 'function') {
            setTimeout(function () { endStaffSession('ended'); }, 1500);
            return;
        }
        try { localStorage.removeItem('pia_user_email'); } catch (err) { /* ignore */ }
        setTimeout(function () { window.location.replace('../../index.html'); }, 3000);
    }

    /* 'ok', 'denied' (already on its way somewhere), 'offline' (retry, never redirect), or 'no-client'. */
    async function checkAccess() {
        if (typeof sb === 'undefined' || !sb) { return 'no-client'; }

        try {
            var session = await sb.auth.getSession();
            if (session.error) {
                if (isNetworkError(session.error)) { return 'offline'; }
                leave('Your session ended. Taking you to sign in…', true);
                return 'denied';
            }
            if (!session.data.session) {
                leave('Your session ended. Taking you to sign in…', true);
                return 'denied';
            }

            var email = session.data.session.user.email;
            var res = await sb.from('profiles').select('role, section, full_name, is_ocean_done').eq('email', email).maybeSingle();

            if (res.error) {
                if (isNetworkError(res.error)) { return 'offline'; }
                leave('Couldn’t confirm your access. Taking you back to sign in…', true);
                return 'denied';
            }
            if (!res.data) {
                leave('Your session ended. Taking you to sign in…', true);
                return 'denied';
            }

            var role = String(res.data.role || 'student').trim().toLowerCase();
            if (role === 'admin') { window.location.replace('../../admin/html/admin-dashboard.html'); return 'denied'; }
            if (role === 'student') { window.location.replace('../../student/html/waiting-room.html'); return 'denied'; }
            if (role !== 'teacher') {
                leave('This page is for teachers. Taking you back to sign in…');
                return 'denied';
            }

            /* The questionnaire comes first; it brings the teacher back here when it is saved. */
            if (res.data.is_ocean_done !== true) {
                window.location.replace('teacher-ocean.html');
                return 'denied';
            }

            try { localStorage.setItem('pia_user_email', email); } catch (err) { /* private mode */ }
            state.email = email;
            state.section = res.data.section || '';
            state.name = res.data.full_name || '';

            /* profiles is the source of truth; the professors row is a fallback for older accounts. */
            if (!state.section || !state.name) {
                var prof = await sb.from('professors').select('name, assigned_section').eq('email', email).maybeSingle();
                if (prof.error && isNetworkError(prof.error)) { return 'offline'; }
                if (!state.section) { state.section = (prof.data && prof.data.assigned_section) || ''; }
                if (!state.name) { state.name = (prof.data && prof.data.name) || ''; }
            }
            return 'ok';
        } catch (err) {
            if (isNetworkError(err)) { return 'offline'; }
            console.error('Teacher page: access check failed.', err);
            leave('Couldn’t confirm your access. Taking you back to sign in…', true);
            return 'denied';
        }
    }

    /* A professor with several sections picks one; the choice is kept on the server. */
    async function offerSectionSwitch() {
        try {
            var res = await sb.rpc('teacher_my_sections');
            if (res.error || !res.data || res.data.length < 2) { return; }
            var select = $('#section-switch');
            select.innerHTML = '';
            res.data.forEach(function (row) {
                var option = document.createElement('option');
                option.value = row.section;
                option.textContent = row.section;
                option.selected = !!row.in_use;
                select.appendChild(option);
            });
            select.hidden = false;
            select.parentNode.classList.add('t-multi');
            select.addEventListener('change', async function () {
                select.disabled = true;
                var done = await sb.rpc('teacher_set_section', { p_section: select.value });
                if (done.error) { select.disabled = false; return; }
                window.location.reload();
            });
        } catch (e) { /* a convenience: the class still loads */ }
    }

    function paintIdentity() {
        var shown = state.name || state.email.split('@')[0];
        setText($('#who'), shown);
        setText($('#section-title'), state.section || 'Your section');
        document.title = (state.section ? state.section + ' · ' : '') + 'PIA System';
        $('#no-section').hidden = !!state.section;
        $('#roster-panel').hidden = !state.section;
    }

    /* ============================================ DATA ================ */

    async function load() {
        if (state.loading || !state.section) { return; }
        state.loading = true;
        try {
            var res = await sb.rpc('teacher_section_roster');
            if (res.error) {
                if (isNetworkError(res.error)) { paintFoot('You are offline. Showing the roster as of ' + (state.loadedAt ? clock(state.loadedAt) : 'the last load') + '.'); }
                else { paintFoot('Couldn’t load the roster. Trying again…'); }
                return;
            }
            /* Keep only the five fields this page is meant to show, whatever the server sends. */
            state.rows = (res.data || []).map(function (r) {
                return {
                    key: String(r.student_key || ''),
                    name: String(r.full_name || 'Unnamed student'),
                    online: r.online === true,
                    stage: STAGE_LABEL[r.stage] ? r.stage : 'waiting',
                    attendance: r.attendance || null
                };
            });
            state.loadedAt = Date.now();
            render();
            paintFoot('Read-only. Updated ' + clock(state.loadedAt) + '.');
        } catch (err) {
            paintFoot('Couldn’t reach the server. Showing the last roster.');
        } finally {
            state.loading = false;
        }
    }

    function schedule() {
        clearTimeout(pollId);
        pollId = setTimeout(function () {
            if (document.hidden || signingOut) { schedule(); return; }
            load().then(schedule);
        }, POLL_MS);
    }

    /* ============================================ DRAWING ============= */

    function paintFoot(text) { setText($('#foot'), text); }

    function matches(row) {
        if (state.filter === 'online' && !row.online) { return false; }
        if ((state.filter === 'setting_up' || state.filter === 'waiting' || state.filter === 'tutoring') && row.stage !== state.filter) { return false; }
        var term = state.term.trim().toLowerCase();
        return !term || row.name.toLowerCase().indexOf(term) !== -1;
    }

    function attendanceCell(td, value) {
        if (value === 'present') { td.className = 't-att-present'; td.textContent = '✓ Present'; }
        else if (value === 'absent') { td.className = 't-att-absent'; td.textContent = '✗ Absent'; }
        else if (value === 'not_marked') { td.className = 'muted'; td.textContent = 'Not marked'; }
        else { td.className = 'muted'; td.textContent = '—'; }
    }

    function render() {
        var counts = { all: state.rows.length, online: 0, setting_up: 0, waiting: 0, tutoring: 0 };
        state.rows.forEach(function (r) {
            if (r.online) { counts.online++; }
            counts[r.stage]++;
        });
        $$('[data-count]').forEach(function (n) { setText(n, counts[n.getAttribute('data-count')]); });

        setText($('#scope-line'), state.rows.length
            ? state.rows.length + (state.rows.length === 1 ? ' student' : ' students') + ' · ' + counts.online + ' online'
            : 'No students in this section yet');

        var visible = state.rows.filter(matches);
        var body = $('#roster');
        body.innerHTML = '';
        visible.forEach(function (r) {
            var tr = document.createElement('tr');

            var who = document.createElement('td');
            var name = document.createElement('span');
            name.className = 't-name';
            name.textContent = r.name;
            who.appendChild(name);

            var status = document.createElement('td');
            var dot = document.createElement('span');
            dot.className = 't-dot' + (r.online ? ' is-on' : '');
            dot.setAttribute('aria-hidden', 'true');
            status.appendChild(dot);
            status.appendChild(document.createTextNode(r.online ? 'Online' : 'Offline'));

            var stage = document.createElement('td');
            var badge = document.createElement('span');
            badge.className = 'badge';
            badge.textContent = STAGE_LABEL[r.stage];
            stage.appendChild(badge);

            var att = document.createElement('td');
            attendanceCell(att, r.attendance);

            tr.appendChild(who);
            tr.appendChild(status);
            tr.appendChild(stage);
            tr.appendChild(att);
            body.appendChild(tr);
        });

        var empty = $('#roster-empty');
        empty.classList.toggle('is-hidden', visible.length > 0);
        setText($('#roster-empty-text'), state.rows.length ? 'No matching students' : 'No students in this section yet');
    }

    /* ============================================ CONTROLS ============ */

    function bindControls() {
        $('#filters').addEventListener('click', function (event) {
            var tab = event.target.closest('[data-filter]');
            if (!tab) { return; }
            state.filter = tab.getAttribute('data-filter');
            $$('[data-filter]').forEach(function (t) {
                var on = t === tab;
                t.classList.toggle('is-active', on);
                t.setAttribute('aria-pressed', on ? 'true' : 'false');
            });
            render();
        });

        $('#find').addEventListener('input', function (event) {
            state.term = event.target.value;
            render();
        });

        var names = $('#show-names');
        var apply = function () {
            document.documentElement.classList.toggle('t-hide-names', !names.checked);
            try { sessionStorage.setItem('pia_teacher_names', names.checked ? '1' : '0'); } catch (e) { /* ignore */ }
        };
        try { names.checked = sessionStorage.getItem('pia_teacher_names') !== '0'; } catch (e) { /* ignore */ }
        names.addEventListener('change', apply);
        apply();

        var toggle = $('#theme-toggle');
        var sync = function () {
            toggle.setAttribute('aria-label', document.documentElement.getAttribute('data-theme') === 'light' ? 'Switch to dark theme' : 'Switch to light theme');
        };
        toggle.addEventListener('click', function () {
            var next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
            document.documentElement.setAttribute('data-theme', next);
            try { localStorage.setItem('pia_theme', next); } catch (e) { /* ignore */ }
            sync();
        });
        sync();

        $('#signout').addEventListener('click', function () {
            if (signingOut) { return; }
            signingOut = true;
            clearTimeout(pollId);
            this.disabled = true;
            this.textContent = 'Signing out…';
            /* executeForceLogout awaits the server; after 8 seconds finish locally on a hung connection. */
            setTimeout(function () {
                try { localStorage.clear(); sessionStorage.clear(); } catch (e) { /* ignore */ }
                window.location.replace('../../index.html');
            }, 8000);
            if (typeof executeForceLogout === 'function') { executeForceLogout(); }
            else { window.location.replace('../../index.html'); }
        });

        document.addEventListener('visibilitychange', function () {
            if (!document.hidden) { load().then(schedule); }
        });
    }

    /* ============================================ START =============== */

    async function start() {
        $('#boot-retry').hidden = true;
        bootText('Checking your access…');

        var access = await checkAccess();
        if (access === 'offline' || access === 'no-client') {
            bootText(access === 'offline'
                ? 'Can’t reach the server. Check the connection, then try again.'
                : 'Something did not load. Reload the page.');
            $('#boot-retry').hidden = false;
            return;
        }
        if (access !== 'ok') { return; }

        if (!started) {
            started = true;
            /* An ended login (an admin's "Sign out everywhere", a revoked device) closes this page at once. */
            if (typeof startStaffSessionWatch === 'function') { startStaffSessionWatch(); }
            /* 15 quiet minutes: "Are you still there?", then a 60 second countdown and sign-out. */
            if (typeof startIdleWatchdog === 'function') { startIdleWatchdog({ limitMs: 15 * 60 * 1000 }); }
            bindControls();
        }

        paintIdentity();
        $('#boot').hidden = true;
        $('#app').hidden = false;
        document.body.removeAttribute('data-boot');

        offerSectionSwitch();
        if (state.section) { await load(); schedule(); }
    }

    $('#boot-retry').addEventListener('click', start);

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
