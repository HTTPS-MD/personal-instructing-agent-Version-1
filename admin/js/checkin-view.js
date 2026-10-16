/* ============================================================================
   PIA ADMIN CONSOLE -- CHECK-IN VIEW
   ============================================================================
   Start check-in for a section, see who is waiting, tick the students you can
   see in the lab and let them in, type student numbers. The console's router
   (admin-dashboard.js) calls PIACheckin.show() when this view opens.

   It talks to the admin_* functions of migrations 0052 and 0053 only; every one
   of them refuses anyone who is not a signed-in admin, so this view is a
   convenience, not the boundary.

   NOBODY IS TICKED BY DEFAULT. Ticking is the admin's way of saying "I can see
   this student in the lab", and there is deliberately no "select all".
   ========================================================================== */
(function () {
    'use strict';

    var MINUTES = [15, 30, 45, 60];
    var REFRESH_MS = 4000;
    var state = { sections: [], open: [], waiting: [] };
    var ticked = {};              /* request id -> true; survives the refresh */
    var handSection = '';
    var built = false;
    var timer = null;

    function $(sel, root) { return (root || document).querySelector(sel); }

    function esc(v) {
        return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function say(message, isError) {
        var el = $('#ci-status');
        if (!el) { return; }
        el.textContent = message || '';
        el.style.color = isError ? 'var(--danger)' : '';
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

    function isVisible() {
        var panel = $('#view-checkin');
        return !!panel && !panel.classList.contains('is-hidden') && !document.hidden;
    }

    function minutesLeft(iso) { return Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60000)); }
    function clock(iso) { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }

    /* ---- skeleton of the view: built once -------------------------------- */
    function build() {
        var root = $('#checkin-root');
        if (!root || built) { return; }
        built = true;
        root.innerHTML =
            '<p class="scope-line" id="ci-status" role="status" aria-live="polite"></p>' +
            '<div class="stack-lg" id="ci-sections"></div>' +
            '<section class="panel" aria-labelledby="ci-hand-title">' +
                '<div class="panel-bar"><h2 class="panel-title" id="ci-hand-title">Student numbers</h2>' +
                '<div class="panel-tools"><select class="input input-sm" id="ci-hand-section" aria-label="Section"></select></div></div>' +
                '<div class="panel-pad"><p class="field-hint">Type each student’s 11-digit number and press Save. Add a student in People first.</p>' +
                '<p class="field-hint" id="ci-hand-status" role="status"></p>' +
                '<div class="table-wrap" id="ci-hand-list"></div></div>' +
            '</section>' +
            '<section class="panel" aria-labelledby="ci-bulk-title">' +
                '<div class="panel-bar"><h2 class="panel-title" id="ci-bulk-title">Paste many at once</h2></div>' +
                '<div class="panel-pad"><p class="field-hint">One student per line as <span class="mono">email, student number</span>. Existing numbers are replaced.</p>' +
                '<textarea class="input" id="ci-bulk" rows="4" spellcheck="false" style="width:100%;margin-top:8px;font-family:var(--font-mono, monospace)" ' +
                    'placeholder="maria.santos@student.ue.edu.ph, 2023-1230102"></textarea>' +
                '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:8px">' +
                '<span class="field-hint" id="ci-bulk-result" role="status"></span>' +
                '<button type="button" class="btn btn-secondary btn-sm" id="ci-bulk-save">Save numbers</button></div></div>' +
            '</section>' +
            '<p class="field-hint">The tutoring closing time is a separate setting in this console. It is not changed here.</p>';
        wire();
    }

    /* ---- the section panels: rebuilt on every refresh --------------------- */
    function renderSections() {
        var openBy = {};
        state.open.forEach(function (c) { openBy[c.section] = c; });

        $('#ci-sections').innerHTML = state.sections.map(function (s) {
            var c = openBy[s.section];
            var counts = s.students + ' students' + (s.without_number
                ? ' · <span class="badge badge-warn">' + s.without_number + ' without a number</span>' : '');
            if (!c) {
                return '<section class="panel" data-ci-section="' + esc(s.section) + '">' +
                    '<div class="panel-bar"><div><h2 class="panel-title">' + esc(s.section) + '</h2>' +
                    '<p class="scope-line"><span class="badge">Check-in closed</span> ' + counts + '</p></div>' +
                    '<div class="panel-tools"><select class="input input-sm" data-ci-minutes aria-label="Stay open for">' +
                    MINUTES.map(function (m) { return '<option value="' + m + '"' + (m === 15 ? ' selected' : '') + '>' + m + ' min</option>'; }).join('') +
                    '</select><button type="button" class="btn btn-primary btn-sm" data-ci-start>Start check-in</button></div></div></section>';
            }
            var mine = state.waiting.filter(function (w) { return w.section === s.section; });
            var picked = mine.filter(function (w) { return ticked[w.id]; }).length;
            return '<section class="panel" data-ci-section="' + esc(s.section) + '">' +
                '<div class="panel-bar"><div><h2 class="panel-title">' + esc(s.section) + '</h2>' +
                '<p class="scope-line"><span class="badge badge-accent">Check-in open</span> ' + minutesLeft(c.ends_at) + ' min left · ' +
                mine.length + ' waiting · ' + counts + '</p></div>' +
                '<div class="panel-tools"><button type="button" class="btn btn-danger btn-sm" data-ci-stop>Stop check-in</button></div></div>' +
                (mine.length
                    ? '<div class="table-wrap"><table class="table"><thead><tr><th scope="col">Let in</th><th scope="col">Name</th>' +
                      '<th scope="col">Section</th><th scope="col">Asked at</th></tr></thead><tbody>' +
                      mine.map(function (w) {
                          return '<tr><td><input type="checkbox" data-ci-id="' + esc(w.id) + '"' + (ticked[w.id] ? ' checked' : '') +
                              ' style="width:20px;height:20px" aria-label="Let in ' + esc(w.full_name) + '"></td><td>' + esc(w.full_name || 'Unknown') +
                              (w.duplicate ? ' <span class="badge badge-warn">Asked more than once</span>' : '') + '</td><td>' + esc(w.section) +
                              '</td><td class="mono">' + esc(clock(w.created_at)) + '</td></tr>';
                      }).join('') + '</tbody></table></div>' +
                      '<div class="panel-bar" style="border-top:1px solid var(--line);border-bottom:0"><span class="scope-line">Tick the students you can see in the lab.</span>' +
                      '<button type="button" class="btn btn-primary btn-sm" data-ci-letin' + (picked ? '' : ' disabled') + '>Let in ' + (picked ? picked + ' ' : '') + 'selected</button></div>'
                    : '<div class="panel-pad"><p class="scope-line">Nobody is waiting. Names appear here as students type their number.</p></div>') +
                '</section>';
        }).join('') || '<p class="scope-line">No sections yet.</p>';
    }

    function fillSectionPicker() {
        var picker = $('#ci-hand-section');
        if (!picker) { return; }
        var names = state.sections.map(function (s) { return s.section; });
        if (picker.getAttribute('data-filled') === names.join('|')) { return; }
        picker.setAttribute('data-filled', names.join('|'));
        picker.innerHTML = '<option value="">Choose a section</option>' +
            names.map(function (n) { return '<option value="' + esc(n) + '"' + (n === handSection ? ' selected' : '') + '>' + esc(n) + '</option>'; }).join('');
    }

    async function refresh() {
        var data = await call('admin_checkin_overview');
        state.sections = (data && data.sections) || [];
        state.open = (data && data.open) || [];
        state.waiting = (data && data.waiting) || [];
        var live = {};
        state.waiting.forEach(function (w) { live[w.id] = true; });
        Object.keys(ticked).forEach(function (id) { if (!live[id]) { delete ticked[id]; } });
        fillSectionPicker();
        renderSections();
    }

    async function act(button, work) {
        button.disabled = true;
        say('');
        try { await work(); await refresh(); } catch (error) { say(failure(error), true); button.disabled = false; }
    }

    /* ---- student numbers, one by one -------------------------------------- */
    async function loadHandList() {
        var box = $('#ci-hand-list');
        if (!handSection) { box.innerHTML = ''; return; }
        box.innerHTML = '<p class="scope-line" style="padding:12px">Loading…</p>';
        try {
            var rows = await call('admin_students_with_numbers', { p_section: handSection });
            box.innerHTML = rows.length
                ? '<table class="table"><thead><tr><th scope="col">Name</th><th scope="col">Student number</th><th scope="col"></th></tr></thead><tbody>' +
                  rows.map(function (r) {
                      return '<tr data-email="' + esc(r.email) + '"><td>' + esc(r.full_name || r.email) + '</td>' +
                          '<td><input class="input input-sm mono" type="text" inputmode="numeric" maxlength="14" autocomplete="off" data-ci-number ' +
                          'style="width:11rem" value="' + esc(r.number || '') + '" placeholder="11 digits" aria-label="Student number of ' + esc(r.full_name || r.email) + '"></td>' +
                          '<td><button type="button" class="btn btn-secondary btn-sm" data-ci-save>Save</button></td></tr>';
                  }).join('') + '</tbody></table>'
                : '<p class="scope-line" style="padding:12px">No students in this section yet.</p>';
        } catch (error) {
            box.innerHTML = '';
            $('#ci-hand-status').textContent = failure(error);
        }
    }

    function wire() {
        var sections = $('#ci-sections');

        sections.addEventListener('click', function (event) {
            var panel = event.target.closest('[data-ci-section]');
            if (!panel) { return; }
            var section = panel.getAttribute('data-ci-section');
            if (event.target.matches('[data-ci-start]')) {
                act(event.target, function () {
                    return call('admin_start_checkin', { p_section: section, p_minutes: Number($('[data-ci-minutes]', panel).value) });
                });
            } else if (event.target.matches('[data-ci-stop]')) {
                act(event.target, function () { return call('admin_stop_checkin', { p_section: section }); });
            } else if (event.target.matches('[data-ci-letin]')) {
                var ids = state.waiting.filter(function (w) { return w.section === section && ticked[w.id]; }).map(function (w) { return w.id; });
                if (!ids.length) { return; }
                act(event.target, async function () {
                    var n = await call('admin_let_in', { p_ids: ids });
                    ids.forEach(function (id) { delete ticked[id]; });
                    say(n + ' student' + (n === 1 ? '' : 's') + ' let in.');
                });
            }
        });

        sections.addEventListener('change', function (event) {
            if (!event.target.matches('[data-ci-id]')) { return; }
            var id = event.target.getAttribute('data-ci-id');
            if (event.target.checked) { ticked[id] = true; } else { delete ticked[id]; }
            renderSections();
        });

        $('#ci-hand-section').addEventListener('change', function (event) {
            handSection = event.target.value;
            $('#ci-hand-status').textContent = '';
            loadHandList();
        });

        $('#ci-hand-list').addEventListener('click', async function (event) {
            if (!event.target.matches('[data-ci-save]')) { return; }
            var row = event.target.closest('tr');
            var input = $('[data-ci-number]', row);
            var digits = input.value.replace(/\D/g, '');
            var out = $('#ci-hand-status');
            if (digits.length !== 11) { out.textContent = 'A student number has 11 digits.'; input.focus(); return; }
            event.target.disabled = true;
            try {
                await call('admin_set_student_number', { p_email: row.getAttribute('data-email'), p_number: digits });
                out.textContent = 'Saved.';
                input.value = digits.slice(0, 4) + '-' + digits.slice(4);
                refresh().catch(function () {});
            } catch (error) {
                out.textContent = failure(error);
            } finally {
                event.target.disabled = false;
            }
        });

        $('#ci-bulk-save').addEventListener('click', function (event) {
            var rows = $('#ci-bulk').value.split('\n').map(function (line) {
                var parts = line.split(/[,\t;]/).map(function (p) { return p.trim(); });
                return parts.length >= 2 && parts[0] && parts[1] ? { email: parts[0].toLowerCase(), number: parts[1] } : null;
            }).filter(Boolean);
            if (!rows.length) { $('#ci-bulk-result').textContent = 'Nothing to save. Use: email, student number'; return; }
            act(event.target, async function () {
                var n = await call('admin_import_student_numbers', { p_rows: rows });
                $('#ci-bulk-result').textContent = 'Saved ' + n + ' student number' + (n === 1 ? '' : 's') + '.';
            });
        });
    }

    /* ---- entry point, called by the console's router ---------------------- */
    function show() {
        if (typeof sb === 'undefined' || !sb) { return; }
        build();
        refresh().catch(function (error) { say(failure(error), true); });
        if (!timer) {
            timer = setInterval(function () { if (isVisible()) { refresh().catch(function () {}); } }, REFRESH_MS);
        }
    }

    window.PIACheckin = { show: show };
})();
