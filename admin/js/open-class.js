/* Admin: open a section's class, mark who is absent, load student numbers.
   Talks to the admin_* functions of migration 0052 only; every one of them
   refuses anyone who is not a signed-in admin, so this page is a convenience,
   not the boundary. */
(function () {
    'use strict';

    var $ = function (sel) { return document.querySelector(sel); };
    var MINUTES = [60, 90, 120, 180, 240];
    var state = { sections: [], open: [] };
    var timer = null;

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
        var data = await call('admin_class_overview');
        state.sections = (data && data.sections) || [];
        state.open = (data && data.open) || [];
        render();
    }

    function minutesLeft(iso) { return Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60000)); }

    function render() {
        var openBy = {};
        state.open.forEach(function (c) { openBy[c.section] = c; });

        $('#sections').innerHTML = state.sections.map(function (s) {
            var c = openBy[s.section];
            if (!c) {
                return '<div class="card" data-section="' + esc(s.section) + '"><div class="row">' +
                    '<div><h2>' + esc(s.section) + '</h2><span class="pill">closed</span> <span class="hint">' + s.students + ' students</span></div>' +
                    '<div class="row"><select data-minutes aria-label="Stay open for">' +
                    MINUTES.map(function (m) { return '<option value="' + m + '"' + (m === 120 ? ' selected' : '') + '>' + m / 60 + ' h</option>'; }).join('') +
                    '</select><button type="button" data-open>Open class</button></div></div></div>';
            }
            var students = c.students || [];
            var present = students.filter(function (x) { return x.present; }).length;
            var noNumber = students.filter(function (x) { return !x.number; }).length;
            return '<div class="card" data-section="' + esc(s.section) + '" data-class="' + esc(c.id) + '"><div class="row">' +
                '<div><h2>' + esc(s.section) + '</h2><span class="pill open">open</span> ' +
                '<span class="hint">closes in ' + minutesLeft(c.closes_at) + ' min · ' + present + ' of ' + students.length + ' present</span>' +
                (noNumber ? ' <span class="pill warn">' + noNumber + ' without a number</span>' : '') + '</div>' +
                '<button type="button" class="danger" data-close>Close class</button></div>' +
                '<table><thead><tr><th>Present</th><th>Student number</th><th>Name</th></tr></thead><tbody>' +
                students.map(function (x) {
                    return '<tr class="' + (x.present ? '' : 'absent') + '"><td class="keep"><input type="checkbox" data-email="' + esc(x.email) + '"' +
                        (x.present ? ' checked' : '') + ' aria-label="Present: ' + esc(x.full_name) + '"></td>' +
                        '<td>' + (x.number ? esc(x.number) : '<span class="pill warn keep">none</span>') + '</td><td>' + esc(x.full_name) + '</td></tr>';
                }).join('') + '</tbody></table></div>';
        }).join('') || '<p class="hint">No sections yet.</p>';
    }

    async function act(button, work) {
        button.disabled = true;
        say('');
        try { await work(); await refresh(); } catch (error) { say(failure(error), true); } finally { button.disabled = false; }
    }

    function wire() {
        $('#sections').addEventListener('click', function (event) {
            var card = event.target.closest('[data-section]');
            if (!card) { return; }
            var section = card.getAttribute('data-section');
            if (event.target.matches('[data-open]')) {
                act(event.target, function () {
                    return call('admin_open_class', { p_section: section, p_minutes: Number(card.querySelector('[data-minutes]').value) });
                });
            } else if (event.target.matches('[data-close]')) {
                act(event.target, function () { return call('admin_close_class', { p_section: section }); });
            }
        });

        $('#sections').addEventListener('change', function (event) {
            if (!event.target.matches('[data-email]')) { return; }
            var card = event.target.closest('[data-class]');
            var box = event.target;
            box.disabled = true;
            call('admin_set_attendance', { p_class: card.getAttribute('data-class'), p_email: box.getAttribute('data-email'), p_present: box.checked })
                .then(refresh).catch(function (error) { box.checked = !box.checked; say(failure(error), true); })
                .finally(function () { box.disabled = false; });
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
        timer = setInterval(function () { if (!document.hidden) { refresh().catch(function () {}); } }, 30000);
    }

    if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', boot); } else { boot(); }
})();
