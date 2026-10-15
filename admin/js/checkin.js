/* Admin: start check-in for a section, see who is waiting, tick the students you
   can see in the lab and let them in, load student numbers. Talks to the admin_*
   functions of migration 0052 only; every one of them refuses anyone who is not
   a signed-in admin, so this page is a convenience, not the boundary.

   NOBODY IS TICKED BY DEFAULT. Ticking is the admin's act of saying "I can see
   this student in the lab", and there is deliberately no "select all". */
(function () {
    'use strict';

    var $ = function (sel) { return document.querySelector(sel); };
    var MINUTES = [15, 30, 45, 60];
    var REFRESH_MS = 4000;
    var state = { sections: [], open: [], waiting: [] };
    var ticked = {};           // request id -> true; survives the refresh

    function esc(v) {
        return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function say(message, isError) {
        var el = $('#status');
        el.textContent = message || '';
        el.className = isError ? 'err' : '';
    }

    function failure(error) {
        var raw = String((error && error.message) || '');
        if (/only an administrator|42501/i.test(raw)) { return 'Only an administrator can do this. Sign in as admin.'; }
        return raw.replace(/^PIA:\s*/, '') || 'Something went wrong. Try again.';
    }

    async function call(name, args) {
        var res = await sb.rpc(name, args || {});
        if (res.error) { throw res.error; }
        return res.data;
    }

    async function refresh() {
        var data = await call('admin_checkin_overview');
        state.sections = (data && data.sections) || [];
        state.open = (data && data.open) || [];
        state.waiting = (data && data.waiting) || [];
        var live = {};
        state.waiting.forEach(function (w) { live[w.id] = true; });
        Object.keys(ticked).forEach(function (id) { if (!live[id]) { delete ticked[id]; } });
        render();
    }

    function minutesLeft(iso) { return Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60000)); }
    function clock(iso) { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }

    function render() {
        var openBy = {};
        state.open.forEach(function (c) { openBy[c.section] = c; });

        $('#sections').innerHTML = state.sections.map(function (s) {
            var c = openBy[s.section];
            var missing = s.without_number
                ? ' <span class="pill warn">' + s.without_number + ' without a number</span>' : '';
            if (!c) {
                return '<div class="card" data-section="' + esc(s.section) + '"><div class="row">' +
                    '<div><h2>' + esc(s.section) + '</h2><span class="pill">check-in closed</span> ' +
                    '<span class="hint">' + s.students + ' students</span>' + missing + '</div>' +
                    '<div class="row"><select data-minutes aria-label="Stay open for">' +
                    MINUTES.map(function (m) { return '<option value="' + m + '"' + (m === 15 ? ' selected' : '') + '>' + m + ' min</option>'; }).join('') +
                    '</select><button type="button" data-start>Start check-in</button></div></div></div>';
            }
            var mine = state.waiting.filter(function (w) { return w.section === s.section; });
            var picked = mine.filter(function (w) { return ticked[w.id]; }).length;
            return '<div class="card" data-section="' + esc(s.section) + '"><div class="row">' +
                '<div><h2>' + esc(s.section) + '</h2><span class="pill open">check-in open</span> ' +
                '<span class="hint">' + minutesLeft(c.ends_at) + ' min left · ' + mine.length + ' waiting</span>' + missing + '</div>' +
                '<button type="button" class="danger" data-stop>Stop check-in</button></div>' +
                (mine.length
                    ? '<table><thead><tr><th>Let in</th><th>Name</th><th>Section</th><th>Asked at</th></tr></thead><tbody>' +
                      mine.map(function (w) {
                          return '<tr><td class="pick"><input type="checkbox" data-id="' + esc(w.id) + '"' + (ticked[w.id] ? ' checked' : '') +
                              ' aria-label="Let in ' + esc(w.full_name) + '"></td><td>' + esc(w.full_name || 'Unknown') +
                              (w.duplicate ? ' <span class="pill warn">asked more than once</span>' : '') + '</td><td>' + esc(w.section) +
                              '</td><td>' + esc(clock(w.created_at)) + '</td></tr>';
                      }).join('') +
                      '</tbody></table><p class="row" style="margin-top:12px"><span class="hint">Tick the students you can see in the lab.</span>' +
                      '<button type="button" data-letin' + (picked ? '' : ' disabled') + '>Let in ' + (picked ? picked + ' ' : '') + 'selected</button></p>'
                    : '<p class="empty">Nobody is waiting. Names appear here as students type their number.</p>') + '</div>';
        }).join('') || '<p class="hint">No sections yet.</p>';
    }

    async function act(button, work) {
        button.disabled = true;
        say('');
        try { await work(); await refresh(); } catch (error) { say(failure(error), true); button.disabled = false; }
    }

    function wire() {
        $('#sections').addEventListener('click', function (event) {
            var card = event.target.closest('[data-section]');
            if (!card) { return; }
            var section = card.getAttribute('data-section');
            if (event.target.matches('[data-start]')) {
                act(event.target, function () {
                    return call('admin_start_checkin', { p_section: section, p_minutes: Number(card.querySelector('[data-minutes]').value) });
                });
            } else if (event.target.matches('[data-stop]')) {
                act(event.target, function () { return call('admin_stop_checkin', { p_section: section }); });
            } else if (event.target.matches('[data-letin]')) {
                var ids = state.waiting.filter(function (w) { return w.section === section && ticked[w.id]; }).map(function (w) { return w.id; });
                if (!ids.length) { return; }
                act(event.target, async function () {
                    var n = await call('admin_let_in', { p_ids: ids });
                    ids.forEach(function (id) { delete ticked[id]; });
                    say(n + ' student' + (n === 1 ? '' : 's') + ' let in.');
                });
            }
        });

        $('#sections').addEventListener('change', function (event) {
            if (!event.target.matches('[data-id]')) { return; }
            if (event.target.checked) { ticked[event.target.getAttribute('data-id')] = true; } else { delete ticked[event.target.getAttribute('data-id')]; }
            render();
        });

        $('#num-save').addEventListener('click', function (event) {
            var rows = $('#numbers').value.split('\n').map(function (line) {
                var parts = line.split(/[,\t;]/).map(function (p) { return p.trim(); });
                return parts.length >= 2 && parts[0] && parts[1] ? { email: parts[0].toLowerCase(), number: parts[1] } : null;
            }).filter(Boolean);
            if (!rows.length) { $('#num-result').textContent = 'Nothing to save. Use: email, student number'; return; }
            act(event.target, async function () {
                var n = await call('admin_import_student_numbers', { p_rows: rows });
                $('#num-result').textContent = 'Saved ' + n + ' student number' + (n === 1 ? '' : 's') + '.';
            });
        });
    }

    async function boot() {
        if (typeof sb === 'undefined' || !sb) { say('The service is unavailable. Check your connection and reload.', true); return; }
        var session = (await sb.auth.getSession()).data.session;
        if (!session) { window.location.replace('../../index.html?signin=staff'); return; }
        wire();
        try { await refresh(); } catch (error) { say(failure(error), true); }
        setInterval(function () { if (!document.hidden) { refresh().catch(function () {}); } }, REFRESH_MS);
    }

    if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', boot); } else { boot(); }
})();
