/* ============================================================================
   PIA ADMIN CONSOLE -- THE STUDENTS PAGE: SECTION CHIPS, ATTENDANCE, NUMBERS
   ============================================================================
   One page, one table. Three things are added to it:

   1. A row of SECTION CHIPS above the table (All, Earth, Jupiter, ...). A chip sets the
      page's own Section filter, so the table, the counts and Input scores follow it. The
      dropdown that used to do this is hidden: one way to choose a section, not two.
   2. ATTENDANCE for the chosen section, above the table: start it, see who is waiting,
      tick the students you can see in the lab and let them in. It appears only once a
      section is chosen.
   3. A STUDENT NUMBER column: plain text with Edit (Add number when there is none).

   admin-dashboard.js calls PIACheckin.decorateRoster() every time it has drawn the table,
   and PIACheckin.saveNumberFor() is kept for older callers. Everything talks to the
   admin_* functions of migrations 0052-0056; each one refuses anyone who is not a signed-in
   admin, so this file is a convenience, not the boundary.

   NOBODY IS TICKED BY DEFAULT. Ticking is the admin's way of saying "I can see this
   student in the lab", and there is deliberately no "select all".
   ========================================================================== */
(function () {
    'use strict';

    var MINUTES = [15, 30, 45, 60];
    var REFRESH_MS = 4000;

    var overview = { sections: [], open: [], waiting: [] };
    var ticked = {};              /* request id -> true; survives the refresh */
    var built = false;
    var polling = false;

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

    function pageVisible() {
        var panel = $('#view-students');
        return !!panel && !panel.classList.contains('is-hidden') && !document.hidden;
    }

    function chosen() {
        var select = $('#section-filter');
        return select ? select.value : '';
    }

    function minutesLeft(iso) { return Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60000)); }
    function clock(iso) { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
    function digitsOf(s) { return String(s || '').replace(/\D/g, ''); }
    function prettyNumber(s) { var d = digitsOf(s).slice(0, 11); return d.length > 4 ? d.slice(0, 4) + '-' + d.slice(4) : d; }

    function say(message, isError) {
        var el = $('#att-status');
        if (!el) { return; }
        el.textContent = message || '';
        el.style.color = isError ? 'var(--danger)' : '';
    }

    /* ---- the student number cell: plain text, Edit, Save, Cancel ----------------- */
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

    async function saveCell(cell) {
        var st = cell._st;
        var input = $('[data-ci-number]', cell);
        var button = $('[data-ci-save]', cell);
        if (button) { button.disabled = true; }
        var result = await saveNumber(st.email, input ? input.value : '');
        if (result.ok) {
            st.number = result.number; st.editing = false; st.msg = ''; st.draft = null;
            paintCell(cell);
            refreshOverview().catch(function () {});
        } else {
            st.msg = result.message; st.draft = input ? input.value : '';
            paintCell(cell);
        }
    }

    /* The row opens the student's profile on click and on Enter, so what happens in the
       cell stays in the cell. */
    function bindCell(cell, email, number) {
        cell._st = { email: email, number: number || '', editing: false, msg: '', draft: null };
        if (!cell._bound) {
            cell._bound = true;
            ['click', 'keydown', 'keyup', 'dblclick'].forEach(function (type) {
                cell.addEventListener(type, function (event) { event.stopPropagation(); });
            });
            cell.addEventListener('click', function (event) {
                if (event.target.closest('[data-ci-edit]')) { cell._st.editing = true; cell._st.msg = ''; cell._st.draft = null; paintCell(cell); }
                else if (event.target.closest('[data-ci-cancel]')) { cell._st.editing = false; cell._st.msg = ''; paintCell(cell); }
                else if (event.target.closest('[data-ci-save]')) { saveCell(cell); }
            });
            cell.addEventListener('keydown', function (event) {
                if (!event.target.matches('[data-ci-number]')) { return; }
                if (event.key === 'Enter') { event.preventDefault(); saveCell(cell); }
                else if (event.key === 'Escape') { event.preventDefault(); cell._st.editing = false; cell._st.msg = ''; paintCell(cell); }
            });
        }
        paintCell(cell);
    }

    /* ---- the section chips ---------------------------------------------------- */
    function isOpen(name) { return overview.open.some(function (c) { return c.section === name; }); }

    function renderChips() {
        var host = $('#section-chips');
        if (!host) { return; }
        var now = chosen();
        var total = overview.sections.reduce(function (n, s) { return n + s.students; }, 0);
        var chip = function (value, label, count, dot) {
            return '<button type="button" class="btn btn-sm ' + (now === value ? 'btn-primary' : 'btn-secondary') + '" data-chip="' + esc(value) + '" aria-pressed="' + (now === value ? 'true' : 'false') + '">' +
                esc(label) + ' <span class="mono">' + count + '</span>' + (dot ? ' <span class="badge badge-accent" title="Attendance is open">Open</span>' : '') + '</button>';
        };
        host.innerHTML = overview.sections.length
            ? '<div role="group" aria-label="Section" style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">' +
              chip('', 'All', total, false) +
              overview.sections.map(function (s) { return chip(s.section, s.section, s.students, isOpen(s.section)); }).join('') + '</div>'
            : '';
    }

    function pickSection(name) {
        var select = $('#section-filter');
        if (!select || select.value === name) { return; }
        select.value = name;
        select.dispatchEvent(new Event('change', { bubbles: true }));   /* the page's own handler does the rest */
        renderChips();
        renderAttendance();
    }

    /* ---- attendance for the chosen section ------------------------------------ */
    function renderAttendance() {
        var panel = $('#att-panel');
        if (!panel) { return; }
        var section = chosen();
        if (!section) { panel.hidden = true; panel.innerHTML = ''; return; }
        panel.hidden = false;

        var meta = overview.sections.filter(function (s) { return s.section === section; })[0];
        var open = overview.open.filter(function (c) { return c.section === section; })[0];
        var mine = overview.waiting.filter(function (w) { return w.section === section; });
        var picked = mine.filter(function (w) { return ticked[w.id]; }).length;
        var missing = meta && meta.without_number ? ' · <span class="badge badge-warn">' + meta.without_number + ' without a number</span>' : '';

        var head;
        if (!open) {
            head = '<div class="panel-bar"><div><h2 class="panel-title">Attendance · ' + esc(section) + '</h2>' +
                '<p class="scope-line"><span class="badge">Closed</span> Students can’t check in yet.' + missing + '</p></div>' +
                '<div class="panel-tools"><select class="input input-sm" data-ci-minutes aria-label="Stay open for">' +
                MINUTES.map(function (m) { return '<option value="' + m + '"' + (m === 15 ? ' selected' : '') + '>' + m + ' min</option>'; }).join('') +
                '</select><button type="button" class="btn btn-primary btn-sm" data-ci-start>Start attendance</button></div></div>';
        } else {
            head = '<div class="panel-bar"><div><h2 class="panel-title">Attendance · ' + esc(section) + '</h2>' +
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
        panel.innerHTML = head + body;
    }

    async function refreshOverview() {
        var data = await call('admin_checkin_overview');
        overview.sections = (data && data.sections) || [];
        overview.open = (data && data.open) || [];
        overview.waiting = (data && data.waiting) || [];
        var live = {};
        overview.waiting.forEach(function (w) { live[w.id] = true; });
        Object.keys(ticked).forEach(function (id) { if (!live[id]) { delete ticked[id]; } });
        renderChips();
        renderAttendance();
    }

    async function act(button, work) {
        button.disabled = true;
        say('');
        try { await work(); await refreshOverview(); } catch (error) { say(failure(error), true); button.disabled = false; }
    }

    // Hide details: masks what identifies a child (name, email, student number) in the table, for a screen others can see.
    function setHidden(on) {
        document.documentElement.classList.toggle('pia-hide-details', on);
        var b = $('#hide-details');
        if (b) { b.checked = !on; }
        try { sessionStorage.setItem('pia_hide_details', on ? '1' : '0'); } catch (e) {}
    }

    function buildHideToggle() {
        if ($('#hide-details')) { return; }
        var st = document.createElement('style');
        var H = '.pia-hide-details ';
        var masked = H + '#student-tbody td:first-child, ' + H + '#student-tbody td[data-ci-cell], ' + H + '#drawer-student :is(#drawer-student-name,#drawer-email)';
        st.textContent = masked + '{font-size:0!important;line-height:1.4}'
            + masked.split(', ').map(function (x) { return x + ' *'; }).join(', ') + '{display:none!important}'
            + masked.split(', ').map(function (x) { return x + '::after'; }).join(', ') + '{content:"********";font-size:14px;letter-spacing:2px}'
            + H + '#drawer-initials{font-size:0!important}' + H + '#drawer-initials::after{content:"**";font-size:14px}';
        st.textContent += '.pia-section-picked #roster-thead th:nth-child(2),.pia-section-picked #student-tbody td:nth-child(2){display:none}';
        document.head.appendChild(st);
        var bar = $('#stage-tabs') && $('#stage-tabs').parentNode;
        if (!bar) { return; }
        var label = document.createElement('label');
        label.style.cssText = 'display:inline-flex;align-items:center;gap:8px;cursor:pointer;font-size:14px;margin-left:auto;white-space:nowrap';
        label.innerHTML = '<input type="checkbox" id="hide-details" checked> Show details';
        bar.appendChild(label);
        label.firstChild.addEventListener('change', function (e) { setHidden(!e.target.checked); });
        var was = false;
        try { was = sessionStorage.getItem('pia_hide_details') === '1'; } catch (e) {}
        setHidden(was);
    }

    function build() {
        if (built) { return; }
        buildHideToggle();
        var chips = $('#section-chips');
        var att = $('#attendance-bar');
        if (!chips || !att) { return; }
        built = true;
        att.innerHTML = '<p class="scope-line" id="att-status" role="status" aria-live="polite"></p><section class="panel" id="att-panel" hidden></section>';

        chips.addEventListener('click', function (event) {
            var chip = event.target.closest('[data-chip]');
            if (chip) { pickSection(chip.getAttribute('data-chip')); }
        });

        att.addEventListener('click', function (event) {
            var section = chosen();
            if (event.target.matches('[data-ci-start]')) {
                act(event.target, function () {
                    return call('admin_start_checkin', { p_section: section, p_minutes: Number($('[data-ci-minutes]', att).value) });
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

        att.addEventListener('change', function (event) {
            if (!event.target.matches('[data-ci-id]')) { return; }
            var id = event.target.getAttribute('data-ci-id');
            if (event.target.checked) { ticked[id] = true; } else { delete ticked[id]; }
            renderAttendance();
        });

        document.addEventListener('pia:students-added', function () { refreshOverview().catch(function () {}); });
    }

    /* ---- called by the console after it has drawn the table -------------------- */
    async function decorateRoster() {
        build();
        var picked = !!($('#section-filter') && $('#section-filter').value);
        document.documentElement.classList.toggle('pia-section-picked', picked);
        renderChips();
        renderAttendance();
        if (!polling && typeof sb !== 'undefined' && sb) {
            polling = true;
            refreshOverview().catch(function (error) { say(failure(error), true); });
            setInterval(function () { if (pageVisible()) { refreshOverview().catch(function () {}); } }, REFRESH_MS);
        }

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
                if (c.tr.isConnected) { bindCell(c.cell, c.email, byEmail[String(c.email).toLowerCase()]); }
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
