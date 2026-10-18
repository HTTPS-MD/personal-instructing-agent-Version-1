/* ============================================================================
   PIA ADMIN CONSOLE -- SECTIONS (cards, attendance, student numbers)
   ============================================================================
   The Sections page opens with one card per section. Opening a section shows
   that section's ATTENDANCE (start it, see who is waiting, tick the students you
   can see in the lab and let them in) and its students. The student number is
   plain text with Edit; the same cell is used in the All students table.

   admin-dashboard.js calls:
     PIASections.show()            when the Sections view opens
     PIACheckin.decorateRoster()   every time it has drawn the All students table
     PIACheckin.saveNumberFor()    when a student is added (kept for older callers)

   Everything talks to the admin_* functions of migrations 0052-0056; each one
   refuses anyone who is not a signed-in admin, so this file is a convenience,
   not the boundary.

   NOBODY IS TICKED BY DEFAULT. Ticking is the admin's way of saying "I can see
   this student in the lab", and there is deliberately no "select all".
   ========================================================================== */
(function () {
    'use strict';

    var MINUTES = [15, 30, 45, 60];
    var REFRESH_MS = 4000;
    var CONDITIONS = { 'assigned': 'EXP · Assigned', 'non-assigned': 'EXP · Free choice', 'neutral': 'EXP · Neutral', 'control': 'CTRL · Traditional' };

    var overview = { sections: [], open: [], waiting: [] };
    var ticked = {};              /* request id -> true; survives the refresh */
    var current = '';             /* the section that is open, '' for the cards */
    var timer = null;
    var polled = false;
    var built = false;

    function $(sel, root) { return (root || document).querySelector(sel); }

    function esc(v) {
        return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function failure(error) {
        var raw = String((error && error.message) || '');
        if (/only an administrator|42501/i.test(raw)) { return 'Only an administrator can do this. Sign in as admin.'; }
        if (/PGRST202|42883|could not find the function/i.test(raw)) { return 'The latest database update is not applied yet.'; }
        return raw.replace(/^PIA:\s*/, '') || 'Something went wrong. Try again.';
    }

    async function call(name, args) {
        var res = await sb.rpc(name, args || {});
        if (res.error) { throw res.error; }
        return res.data;
    }

    function viewVisible() {
        var panel = $('#view-sections');
        return !!panel && !panel.classList.contains('is-hidden') && !document.hidden;
    }

    function minutesLeft(iso) { return Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60000)); }
    function clock(iso) { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
    function digitsOf(s) { return String(s || '').replace(/\D/g, ''); }
    function prettyNumber(s) { var d = digitsOf(s).slice(0, 11); return d.length > 4 ? d.slice(0, 4) + '-' + d.slice(4) : d; }

    function say(message, isError) {
        var el = $('#sec-status');
        if (!el) { return; }
        el.textContent = message || '';
        el.style.color = isError ? 'var(--danger)' : '';
    }

    /* ---- the student number cell: plain text, Edit, Save, Cancel --------------- */
    async function saveNumber(email, raw) {
        var d = digitsOf(raw);
        if (d.length !== 11) { return { ok: false, message: 'Student number must be 11 digits' }; }
        try {
            await call('admin_set_student_number', { p_email: email, p_number: d });
            return { ok: true, number: prettyNumber(d) };
        } catch (error) {
            return { ok: false, message: failure(error) };
        }
    }

    function cellHtml(st) {
        if (st.editing) {
            return '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">' +
                '<input class="input input-sm mono" type="text" inputmode="numeric" maxlength="14" autocomplete="off" data-ci-number ' +
                'style="width:10rem" value="' + esc(st.draft != null ? st.draft : st.number) + '" placeholder="11 digits" aria-label="Student number"' +
                (st.msg ? ' aria-invalid="true"' : '') + '>' +
                '<button type="button" class="btn btn-primary btn-sm" data-ci-save>Save</button>' +
                '<button type="button" class="btn btn-ghost btn-sm" data-ci-cancel>Cancel</button></div>' +
                (st.msg ? '<p class="field-msg" style="margin:4px 0 0">' + esc(st.msg) + '</p>' : '');
        }
        return st.number
            ? '<span class="mono">' + esc(prettyNumber(st.number)) + '</span> <button type="button" class="btn btn-ghost btn-sm" data-ci-edit aria-label="Edit student number">Edit</button>'
            : '<button type="button" class="btn btn-ghost btn-sm" data-ci-edit>Add number</button>';
    }

    function paintCell(cell) {
        cell.innerHTML = cellHtml(cell._st);
        if (cell._st.editing) { var input = $('[data-ci-number]', cell); if (input) { input.focus(); input.select(); } }
    }

    async function saveCell(cell, onSaved) {
        var st = cell._st;
        var input = $('[data-ci-number]', cell);
        var button = $('[data-ci-save]', cell);
        if (button) { button.disabled = true; }
        var result = await saveNumber(st.email, input ? input.value : '');
        if (result.ok) {
            st.number = result.number; st.editing = false; st.msg = ''; st.draft = null;
            paintCell(cell);
            if (onSaved) { onSaved(); }
        } else {
            st.msg = result.message; st.draft = input ? input.value : '';
            paintCell(cell);
        }
    }

    /* The row opens the student's profile on click and on Enter, so what happens in the
       cell stays in the cell. */
    function bindCell(cell, email, number, onSaved) {
        cell._st = { email: email, number: number || '', editing: false, msg: '', draft: null };
        ['click', 'keydown', 'keyup', 'dblclick'].forEach(function (type) {
            cell.addEventListener(type, function (event) { event.stopPropagation(); });
        });
        cell.addEventListener('click', function (event) {
            if (event.target.closest('[data-ci-edit]')) { cell._st.editing = true; cell._st.msg = ''; cell._st.draft = null; paintCell(cell); }
            else if (event.target.closest('[data-ci-cancel]')) { cell._st.editing = false; cell._st.msg = ''; paintCell(cell); }
            else if (event.target.closest('[data-ci-save]')) { saveCell(cell, onSaved); }
        });
        cell.addEventListener('keydown', function (event) {
            if (!event.target.matches('[data-ci-number]')) { return; }
            if (event.key === 'Enter') { event.preventDefault(); saveCell(cell, onSaved); }
            else if (event.key === 'Escape') { event.preventDefault(); cell._st.editing = false; cell._st.msg = ''; paintCell(cell); }
        });
        paintCell(cell);
    }

    /* ---- the All students table: a Student number column ----------------------- */
    async function decorateRoster() {
        var headRow = $('#roster-thead tr');
        if (headRow && !headRow.querySelector('[data-ci-th]')) {
            var th = document.createElement('th');
            th.scope = 'col';
            th.setAttribute('data-ci-th', '');
            th.textContent = 'Student number';
            headRow.appendChild(th);
        }

        var rows = Array.prototype.slice.call(document.querySelectorAll('#student-tbody tr[data-student]'));
        var cells = rows.map(function (tr) {
            var cell = tr.querySelector('[data-ci-cell]');
            if (!cell) {
                cell = document.createElement('td');
                cell.setAttribute('data-ci-cell', '');
                cell.innerHTML = '<span class="scope-line">…</span>';
                tr.appendChild(cell);
            }
            return { tr: tr, cell: cell, email: tr.getAttribute('data-student') };
        });
        if (!cells.length || typeof sb === 'undefined' || !sb) { return; }

        try {
            var data = await call('admin_numbers_for', { p_emails: cells.map(function (c) { return c.email; }) });
            var byEmail = {};
            (data || []).forEach(function (r) { byEmail[String(r.email).toLowerCase()] = r.number; });
            cells.forEach(function (c) {
                if (c.tr.isConnected) { bindCell(c.cell, c.email, byEmail[String(c.email).toLowerCase()], refreshOverview); }
            });
        } catch (error) {
            cells.forEach(function (c) { if (c.tr.isConnected) { c.cell.innerHTML = '<span class="scope-line">' + esc(failure(error)) + '</span>'; } });
        }
    }

    /* ---- the Sections view ------------------------------------------------------ */
    function build() {
        var root = $('#sections-root');
        if (!root || built) { return; }
        built = true;
        root.innerHTML = '<p class="scope-line" id="sec-status" role="status" aria-live="polite"></p><div id="sec-body"></div>';
        wire();
    }

    function sectionMeta(name) { return overview.sections.filter(function (s) { return s.section === name; })[0]; }
    function isOpen(name) { return overview.open.some(function (c) { return c.section === name; }); }

    function renderCards() {
        $('#sec-body').innerHTML = overview.sections.length
            ? '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px">' +
              overview.sections.map(function (s) {
                  var open = isOpen(s.section);
                  return '<button type="button" class="panel panel-pad" data-open="' + esc(s.section) + '" style="text-align:left;cursor:pointer;display:block;width:100%;color:inherit">' +
                      '<h2 class="panel-title">' + esc(s.section) + '</h2>' +
                      '<p class="scope-line">' + s.students + (s.students === 1 ? ' student' : ' students') + ' · OCEAN ' + s.ocean_done + ' of ' + s.students + '</p>' +
                      '<p style="margin:8px 0 0;display:flex;gap:6px;flex-wrap:wrap"><span class="badge ' + (open ? 'badge-accent' : '') + '">Attendance ' + (open ? 'open' : 'closed') + '</span>' +
                      (s.without_number ? '<span class="badge badge-warn">' + s.without_number + ' without a number</span>' : '') + '</p></button>';
              }).join('') + '</div>'
            : '<p class="scope-line">No sections yet. Create one in Manage sections.</p>';
    }

    function renderAttendance() {
        var host = $('#sec-att');
        if (!host) { return; }
        var meta = sectionMeta(current);
        var open = overview.open.filter(function (c) { return c.section === current; })[0];
        var mine = overview.waiting.filter(function (w) { return w.section === current; });
        var picked = mine.filter(function (w) { return ticked[w.id]; }).length;
        var missing = meta && meta.without_number ? ' · <span class="badge badge-warn">' + meta.without_number + ' without a number</span>' : '';

        var head;
        if (!open) {
            head = '<div class="panel-bar"><div><h2 class="panel-title">Attendance</h2>' +
                '<p class="scope-line"><span class="badge">Closed</span> Students can’t check in yet.</p></div>' +
                '<div class="panel-tools"><select class="input input-sm" data-ci-minutes aria-label="Stay open for">' +
                MINUTES.map(function (m) { return '<option value="' + m + '"' + (m === 15 ? ' selected' : '') + '>' + m + ' min</option>'; }).join('') +
                '</select><button type="button" class="btn btn-primary btn-sm" data-ci-start>Start attendance</button></div></div>';
        } else {
            head = '<div class="panel-bar"><div><h2 class="panel-title">Attendance</h2>' +
                '<p class="scope-line"><span class="badge badge-accent">Open</span> ' + minutesLeft(open.ends_at) + ' min left · ' + mine.length + ' waiting' + missing + '</p></div>' +
                '<div class="panel-tools"><button type="button" class="btn btn-danger btn-sm" data-ci-stop>Stop attendance</button></div></div>';
        }

        var body = '';
        if (open && mine.length) {
            body = '<div class="table-wrap"><table class="table"><thead><tr><th scope="col">Let in</th><th scope="col">Name</th><th scope="col">Asked at</th></tr></thead><tbody>' +
                mine.map(function (w) {
                    return '<tr><td><input type="checkbox" data-ci-id="' + esc(w.id) + '"' + (ticked[w.id] ? ' checked' : '') +
                        ' style="width:20px;height:20px" aria-label="Let in ' + esc(w.full_name) + '"></td><td>' + esc(w.full_name || 'Unknown') +
                        (w.duplicate ? ' <span class="badge badge-warn">Asked more than once</span>' : '') + '</td><td class="mono">' + esc(clock(w.created_at)) + '</td></tr>';
                }).join('') + '</tbody></table></div>' +
                '<div class="panel-bar" style="border-top:1px solid var(--line);border-bottom:0"><span class="scope-line">Tick the students you can see in the lab.</span>' +
                '<button type="button" class="btn btn-primary btn-sm" data-ci-letin' + (picked ? '' : ' disabled') + '>Let in ' + (picked ? picked + ' ' : '') + 'selected</button></div>';
        } else if (open) {
            body = '<div class="panel-pad"><p class="scope-line">Nobody is waiting. Names appear here as students type their number.</p></div>';
        }
        host.innerHTML = head + body;
    }

    function renderSection() {
        $('#sec-body').innerHTML =
            '<p style="margin:0 0 12px"><button type="button" class="btn btn-ghost btn-sm" data-back>← All sections</button></p>' +
            '<h2 class="panel-title section-title" style="font-size:var(--fs-heading, 1.25rem)">' + esc(current) + '</h2>' +
            '<div class="stack-lg">' +
            '<section class="panel" id="sec-att" aria-label="Attendance"></section>' +
            '<section class="panel"><div class="panel-bar"><h2 class="panel-title">Students</h2><span class="scope-line" id="sec-count"></span></div>' +
            '<div class="table-wrap"><table class="table"><thead><tr><th scope="col">Student</th><th scope="col">Condition</th><th scope="col">Stage</th><th scope="col">Student number</th></tr></thead>' +
            '<tbody id="sec-rows"><tr><td colspan="4" class="scope-line">Loading…</td></tr></tbody></table></div></section></div>';
        renderAttendance();
        loadStudents();
    }

    async function loadStudents() {
        var body = $('#sec-rows');
        if (!body) { return; }
        try {
            var rows = await call('admin_section_students', { p_section: current });
            $('#sec-count').textContent = rows.length + (rows.length === 1 ? ' student' : ' students');
            if (!rows.length) { body.innerHTML = '<tr><td colspan="4" class="scope-line">No students in this section yet. Use Add students.</td></tr>'; return; }
            body.innerHTML = rows.map(function (r, i) {
                return '<tr><td>' + esc(r.full_name || r.email) + '</td>' +
                    '<td><span class="badge">' + esc(CONDITIONS[r.group_type] || r.group_type || '—') + '</span></td>' +
                    '<td>' + esc(r.current_stage || '—') + '</td><td data-n="' + i + '"></td></tr>';
            }).join('');
            rows.forEach(function (r, i) { bindCell($('[data-n="' + i + '"]', body), r.email, r.number, refreshOverview); });
        } catch (error) {
            body.innerHTML = '<tr><td colspan="4" class="scope-line">' + esc(failure(error)) + '</td></tr>';
        }
    }

    async function refreshOverview() {
        var data = await call('admin_checkin_overview');
        overview.sections = (data && data.sections) || [];
        overview.open = (data && data.open) || [];
        overview.waiting = (data && data.waiting) || [];
        var live = {};
        overview.waiting.forEach(function (w) { live[w.id] = true; });
        Object.keys(ticked).forEach(function (id) { if (!live[id]) { delete ticked[id]; } });
        if (!$('#sec-body')) { return; }
        if (current) { renderAttendance(); } else { renderCards(); }
    }

    async function act(button, work) {
        button.disabled = true;
        say('');
        try { await work(); await refreshOverview(); } catch (error) { say(failure(error), true); button.disabled = false; }
    }

    function openSection(name) {
        current = name;
        say('');
        if (name) { renderSection(); } else { renderCards(); }
        syncAddButton();
    }

    function syncAddButton() {
        var button = $('#sections-add');
        if (button) { button.textContent = current ? 'Add students to ' + current : 'Add students'; }
    }

    function wire() {
        var body = $('#sec-body');

        body.addEventListener('click', function (event) {
            var card = event.target.closest('[data-open]');
            if (card) { openSection(card.getAttribute('data-open')); return; }
            if (event.target.closest('[data-back]')) { refreshOverview().catch(function () {}); openSection(''); return; }
            if (event.target.matches('[data-ci-start]')) {
                act(event.target, function () {
                    return call('admin_start_checkin', { p_section: current, p_minutes: Number($('[data-ci-minutes]', body).value) });
                });
            } else if (event.target.matches('[data-ci-stop]')) {
                act(event.target, function () { return call('admin_stop_checkin', { p_section: current }); });
            } else if (event.target.matches('[data-ci-letin]')) {
                var ids = overview.waiting.filter(function (w) { return w.section === current && ticked[w.id]; }).map(function (w) { return w.id; });
                if (!ids.length) { return; }
                act(event.target, async function () {
                    var n = await call('admin_let_in', { p_ids: ids });
                    ids.forEach(function (id) { delete ticked[id]; });
                    say(n + ' student' + (n === 1 ? '' : 's') + ' let in.');
                });
            }
        });

        body.addEventListener('change', function (event) {
            if (!event.target.matches('[data-ci-id]')) { return; }
            var id = event.target.getAttribute('data-ci-id');
            if (event.target.checked) { ticked[id] = true; } else { delete ticked[id]; }
            renderAttendance();
        });

        document.addEventListener('pia:students-added', function () {
            if (!built) { return; }
            refreshOverview().then(function () { if (current) { loadStudents(); } }).catch(function () {});
        });
    }

    function show() {
        if (typeof sb === 'undefined' || !sb) { return; }
        build();
        syncAddButton();
        refreshOverview().catch(function (error) { say(failure(error), true); });
        if (!polled) {
            polled = true;
            timer = setInterval(function () { if (viewVisible()) { refreshOverview().catch(function () {}); } }, REFRESH_MS);
        }
    }

    window.PIASections = { show: show, current: function () { return viewVisible() ? current : ''; } };
    window.PIACheckin = {
        decorateRoster: decorateRoster,
        saveNumberFor: function (email, number) { return saveNumber(email, number); }
    };
})();
