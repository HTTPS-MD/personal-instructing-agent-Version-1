/* ============================================================================
   PIA ADMIN CONSOLE -- ATTENDANCE AND STUDENT NUMBERS, INSIDE THE STUDENTS PAGE
   ============================================================================
   Two things on the Students page, both following the Section filter:

   1. An Attendance panel above the table: start or stop attendance for the chosen
      section, see who is waiting, tick the students you can see in the lab and
      let them in.
   2. A "Student number" column in the table: one box per student.

   admin-dashboard.js calls PIACheckin.decorateRoster() every time it has drawn
   the roster, and PIACheckin.saveNumberFor() when a student is registered.

   Everything talks to the admin_* functions of migrations 0052-0054; each one
   refuses anyone who is not a signed-in admin, so this file is a convenience,
   not the boundary.

   NOBODY IS TICKED BY DEFAULT. Ticking is the admin's way of saying "I can see
   this student in the lab", and there is deliberately no "select all".
   ========================================================================== */
(function () {
    'use strict';

    var MINUTES = [15, 30, 45, 60];
    var REFRESH_MS = 4000;
    var overview = { sections: [], open: [], waiting: [] };
    var ticked = {};              /* request id -> true; survives the refresh */
    var timer = null;
    var polled = false;

    function $(sel, root) { return (root || document).querySelector(sel); }

    function esc(v) {
        return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function failure(error) {
        var raw = String((error && error.message) || '');
        if (/only an administrator|42501/i.test(raw)) { return 'Only an administrator can do this. Sign in as admin.'; }
        if (/PGRST202|42883|could not find the function/i.test(raw)) { return 'The attendance update is not applied to the database yet.'; }
        return raw.replace(/^PIA:\s*/, '') || 'Something went wrong. Try again.';
    }

    async function call(name, args) {
        var res = await sb.rpc(name, args || {});
        if (res.error) { throw res.error; }
        return res.data;
    }

    function currentSection() {
        var select = $('#section-filter');
        return select ? select.value : '';
    }

    function studentsViewVisible() {
        var panel = $('#view-students');
        return !!panel && !panel.classList.contains('is-hidden') && !document.hidden;
    }

    function minutesLeft(iso) { return Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60000)); }
    function clock(iso) { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }

    function say(message, isError) {
        var el = $('#ci-status');
        if (!el) { return; }
        el.textContent = message || '';
        el.style.color = isError ? 'var(--danger)' : '';
    }

    function prettyNumber(digits) { return digits.length === 11 ? digits.slice(0, 4) + '-' + digits.slice(4) : digits; }

    /* ---- 1. the check-in panel ------------------------------------------- */
    function renderBar() {
        var host = $('#checkin-bar');
        if (!host) { return; }
        var section = currentSection();

        if (!section) {
            host.innerHTML = '<p class="scope-line" id="ci-status" role="status" aria-live="polite"></p>' +
                '<div class="panel panel-pad"><p class="scope-line">Choose a section to start attendance and to see who is waiting.</p></div>';
            return;
        }

        var meta = overview.sections.filter(function (s) { return s.section === section; })[0];
        var open = overview.open.filter(function (c) { return c.section === section; })[0];
        var mine = overview.waiting.filter(function (w) { return w.section === section; });
        var picked = mine.filter(function (w) { return ticked[w.id]; }).length;
        var missing = meta && meta.without_number
            ? ' · <span class="badge badge-warn">' + meta.without_number + ' without a number</span>' : '';
        var keep = $('#ci-status') ? $('#ci-status').textContent : '';

        var head;
        if (!open) {
            head = '<div class="panel-bar"><div><h2 class="panel-title">Attendance</h2>' +
                '<p class="scope-line"><span class="badge">Closed</span> ' + esc(section) + missing + '</p></div>' +
                '<div class="panel-tools"><select class="input input-sm" data-ci-minutes aria-label="Stay open for">' +
                MINUTES.map(function (m) { return '<option value="' + m + '"' + (m === 15 ? ' selected' : '') + '>' + m + ' min</option>'; }).join('') +
                '</select><button type="button" class="btn btn-primary btn-sm" data-ci-start>Start attendance</button></div></div>';
        } else {
            head = '<div class="panel-bar"><div><h2 class="panel-title">Attendance</h2>' +
                '<p class="scope-line"><span class="badge badge-accent">Open</span> ' + esc(section) + ' · ' + minutesLeft(open.ends_at) +
                ' min left · ' + mine.length + ' waiting' + missing + '</p></div>' +
                '<div class="panel-tools"><button type="button" class="btn btn-danger btn-sm" data-ci-stop>Stop attendance</button></div></div>';
        }

        var body = '';
        if (open && mine.length) {
            body = '<div class="table-wrap"><table class="table"><thead><tr><th scope="col">Let in</th><th scope="col">Name</th>' +
                '<th scope="col">Section</th><th scope="col">Asked at</th></tr></thead><tbody>' +
                mine.map(function (w) {
                    return '<tr><td><input type="checkbox" data-ci-id="' + esc(w.id) + '"' + (ticked[w.id] ? ' checked' : '') +
                        ' style="width:20px;height:20px" aria-label="Let in ' + esc(w.full_name) + '"></td><td>' + esc(w.full_name || 'Unknown') +
                        (w.duplicate ? ' <span class="badge badge-warn">Asked more than once</span>' : '') + '</td><td>' + esc(w.section) +
                        '</td><td class="mono">' + esc(clock(w.created_at)) + '</td></tr>';
                }).join('') + '</tbody></table></div>' +
                '<div class="panel-bar" style="border-top:1px solid var(--line);border-bottom:0"><span class="scope-line">Tick the students you can see in the lab.</span>' +
                '<button type="button" class="btn btn-primary btn-sm" data-ci-letin' + (picked ? '' : ' disabled') + '>Let in ' + (picked ? picked + ' ' : '') + 'selected</button></div>';
        } else if (open) {
            body = '<div class="panel-pad"><p class="scope-line">Nobody is waiting. Names appear here as students type their number.</p></div>';
        }

        host.innerHTML = '<p class="scope-line" id="ci-status" role="status" aria-live="polite"></p><section class="panel">' + head + body + '</section>';
        if (keep) { say(keep); }
    }

    async function refreshOverview() {
        var data = await call('admin_checkin_overview');
        overview.sections = (data && data.sections) || [];
        overview.open = (data && data.open) || [];
        overview.waiting = (data && data.waiting) || [];
        var live = {};
        overview.waiting.forEach(function (w) { live[w.id] = true; });
        Object.keys(ticked).forEach(function (id) { if (!live[id]) { delete ticked[id]; } });
        renderBar();
    }

    async function act(button, work) {
        button.disabled = true;
        say('');
        try { await work(); await refreshOverview(); } catch (error) { say(failure(error), true); button.disabled = false; }
    }

    function wireBar() {
        var host = $('#checkin-bar');
        if (!host || host.getAttribute('data-wired')) { return; }
        host.setAttribute('data-wired', '1');

        host.addEventListener('click', function (event) {
            var section = currentSection();
            if (event.target.matches('[data-ci-start]')) {
                act(event.target, function () {
                    return call('admin_start_checkin', { p_section: section, p_minutes: Number($('[data-ci-minutes]', host).value) });
                });
            } else if (event.target.matches('[data-ci-stop]')) {
                act(event.target, function () { return call('admin_stop_checkin', { p_section: section }); });
            } else if (event.target.matches('[data-ci-letin]')) {
                var ids = overview.waiting.filter(function (w) { return w.section === section && ticked[w.id]; }).map(function (w) { return w.id; });
                if (!ids.length) { return; }
                act(event.target, async function () {
                    var n = await call('admin_let_in', { p_ids: ids });
                    ids.forEach(function (id) { delete ticked[id]; });
                    say(n + ' student' + (n === 1 ? '' : 's') + ' let in.');
                });
            }
        });

        host.addEventListener('change', function (event) {
            if (!event.target.matches('[data-ci-id]')) { return; }
            var id = event.target.getAttribute('data-ci-id');
            if (event.target.checked) { ticked[id] = true; } else { delete ticked[id]; }
            renderBar();
        });
    }

    /* ---- 2. the Student number column ------------------------------------ */
    async function saveNumber(email, rawNumber) {
        var digits = String(rawNumber || '').replace(/\D/g, '');
        if (digits.length !== 11) { return { ok: false, message: 'A student number has 11 digits.' }; }
        try {
            await call('admin_set_student_number', { p_email: email, p_number: digits });
            return { ok: true, number: prettyNumber(digits) };
        } catch (error) {
            return { ok: false, message: failure(error) };
        }
    }

    function fillCell(cell, email, number) {
        cell.innerHTML = '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">' +
            '<input class="input input-sm mono" type="text" inputmode="numeric" maxlength="14" autocomplete="off" data-ci-number ' +
            'style="width:10.5rem" value="' + esc(number ? prettyNumber(String(number).replace(/\D/g, '')) : '') + '" placeholder="11 digits" aria-label="Student number">' +
            '<button type="button" class="btn btn-secondary btn-sm" data-ci-save>Save</button></div>' +
            '<p class="field-hint" data-ci-note style="margin-top:4px"></p>';
        cell.setAttribute('data-email', email);
    }

    /* The row opens the student's profile on click and on Enter. A box inside it
       must not do that, so everything that happens in the cell stays in the cell. */
    function guardCell(cell) {
        ['click', 'keydown', 'keyup', 'dblclick'].forEach(function (type) {
            cell.addEventListener(type, function (event) { event.stopPropagation(); });
        });
        async function save() {
            var input = $('[data-ci-number]', cell);
            var note = $('[data-ci-note]', cell);
            var button = $('[data-ci-save]', cell);
            button.disabled = true;
            var result = await saveNumber(cell.getAttribute('data-email'), input.value);
            button.disabled = false;
            if (result.ok) { input.value = result.number; note.textContent = 'Saved.'; note.style.color = ''; refreshOverview().catch(function () {}); }
            else { note.textContent = result.message; note.style.color = 'var(--danger)'; }
        }
        cell.addEventListener('click', function (event) { if (event.target.matches('[data-ci-save]')) { save(); } });
        cell.addEventListener('keydown', function (event) {
            if (event.key === 'Enter' && event.target.matches('[data-ci-number]')) { event.preventDefault(); save(); }
        });
    }

    async function decorateRoster() {
        wireBar();

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
                guardCell(cell);
                tr.appendChild(cell);
            }
            return { tr: tr, cell: cell, email: tr.getAttribute('data-student') };
        });

        renderBar();
        if (!polled) {
            polled = true;
            refreshOverview().catch(function (error) { say(failure(error), true); });
            timer = setInterval(function () { if (studentsViewVisible()) { refreshOverview().catch(function () {}); } }, REFRESH_MS);
        }

        if (!cells.length || typeof sb === 'undefined' || !sb) { return; }
        try {
            var data = await call('admin_numbers_for', { p_emails: cells.map(function (c) { return c.email; }) });
            var byEmail = {};
            (data || []).forEach(function (r) { byEmail[String(r.email).toLowerCase()] = r.number; });
            cells.forEach(function (c) {
                if (c.tr.isConnected) { fillCell(c.cell, c.email, byEmail[String(c.email).toLowerCase()]); }
            });
        } catch (error) {
            cells.forEach(function (c) { if (c.tr.isConnected) { c.cell.innerHTML = '<span class="scope-line">' + esc(failure(error)) + '</span>'; } });
        }
    }

    window.PIACheckin = {
        decorateRoster: decorateRoster,
        saveNumberFor: function (email, number) { return saveNumber(email, number); }
    };
})();
