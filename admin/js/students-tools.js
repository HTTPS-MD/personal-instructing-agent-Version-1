/* ============================================================================
   PIA ADMIN CONSOLE -- THE STUDENTS PAGE: SECTION CHIPS, ATTENDANCE, NUMBERS
   ============================================================================
   One page, one table. Three things are added to it:

   1. The page title is a SECTION DROPDOWN (Earth, Jupiter, ...; a section is always chosen). It sets the
      page's own Section filter, so the table, the counts and Input scores follow it. The
      filter that used to do this is hidden: one way to choose a section, not two.
   2. ATTENDANCE for the chosen section: a Start / Stop button beside Show details and, while
      it is open, a check / cross on every row, in the last column. No timer is shown; the
      attendance closes by itself after 2 hours if it is left open. The admin calls the names and marks who is in the
      lab; a student marked present who types their number walks straight in. It appears only
      once a section is chosen.
   3. A STUDENT NUMBER column: plain text with Edit (Add number when there is none).

   admin-dashboard.js calls PIACheckin.decorateRoster() every time it has drawn the table,
   and PIACheckin.saveNumberFor() is kept for older callers. Everything talks to the
   admin_* functions of migrations 0052-0058; each one refuses anyone who is not a signed-in
   admin, so this file is a convenience, not the boundary.

   NOBODY IS MARKED BY DEFAULT, and there is deliberately no "mark everyone": a check is
   the admin saying "I can see this student in the lab".
   ========================================================================== */
(function () {
    'use strict';

    var REFRESH_MS = 4000;

    var overview = { sections: [], open: [] };
    var profs = [];               /* professors: { name, email, assigned_section } */
    var holder = {};              /* section -> email of its professor (one per section) */
    var confirmDelete = false;    /* the delete row of the section menu is asking "are you sure" */
    var marks = {};               /* email -> { present, entered, refused } for the chosen section */
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
    /* Other pages read the chosen section from here (Live Sessions, Stage Controls). */
    Object.defineProperty(window, 'PIASectionNow', { get: function () { return chosen(); }, configurable: true });

    function minutesLeft(iso) { return Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60000)); }
    function clock(iso) { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
    function digitsOf(s) { return String(s || '').replace(/\D/g, ''); }
    function prettyNumber(s) { var d = digitsOf(s).slice(0, 11); return d.length > 4 ? d.slice(0, 4) + '-' + d.slice(4) : d; }

    function say(message, isError) {
        if (!message) { return; }
        var admin = window.PIAAdmin;
        if (admin) { (isError ? admin.toastErr : admin.toastOk)(isError ? 'Attendance' : 'Done', message); }
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

    /* The section picker lives in the top bar, so it follows the admin to every page that is about
       one class (Students, Live Sessions, Stage Controls). */
    function titleHost() {
        var host = $('#section-host');
        if (host) { return host; }
        var left = $('.topbar-left');
        if (!left) { return null; }
        host = document.createElement('div');
        host.id = 'section-host';
        host.hidden = true;
        left.appendChild(host);
        return host;
    }

    function updateHostVisibility() {
        var host = $('#section-host');
        if (!host) { return; }
        var view = (window.location.hash || '').replace('#', '');
        host.hidden = !(view === 'students' || view === 'live' || view === 'controls');
    }

    function profsOf(section) {
        var email = holder[section];
        return profs.filter(function (f) { return String(f.email).toLowerCase() === email; });
    }
    function sectionsOf(email) {
        return Object.keys(holder).filter(function (name) { return holder[name] === String(email).toLowerCase(); }).sort();
    }

    function renderChips() {
        var h1 = titleHost();
        if (!h1) { return; }
        var chips = $('#section-chips'); if (chips) { chips.style.display = 'none'; }
        var now = chosen();
        var label = now ? now : 'Choose a section';
        var item = 'display:block;width:100%;padding:8px 12px;border:0;background:transparent;color:var(--text);font:inherit;text-align:left;cursor:pointer';
        var row = function (value, name, count, open) {
            return '<button type="button" role="menuitemradio" aria-checked="' + (now === value) + '" data-chip="' + esc(value) + '" style="display:flex;width:100%;justify-content:space-between;gap:16px;align-items:center;padding:8px 12px;border:0;background:' + (now === value ? 'var(--line-soft)' : 'transparent') + ';color:var(--text);font:inherit;font-weight:' + (now === value ? '600' : '400') + ';text-align:left;cursor:pointer">' +
                '<span>' + esc(name) + (open ? ' <span class="badge badge-accent">Open</span>' : '') + '</span><span class="mono" style="opacity:.7">' + count + '</span></button>';
        };

        /* Delete only works on an empty section: no student and no professor. */
        var meta = overview.sections.filter(function (x) { return x.section === now; })[0];
        var why = !now ? '' : (meta && meta.students ? 'Has students' : (profsOf(now).length ? 'Has a professor' : ''));
        var remove = '';
        if (now && confirmDelete && !why) {
            remove = '<div style="padding:8px 12px;border-top:1px solid var(--line)"><div style="margin-bottom:8px">Delete ' + esc(now) + '? This cannot be undone.</div>' +
                '<button type="button" class="btn btn-danger btn-sm" data-section-confirm>Yes, delete</button> <button type="button" class="btn btn-secondary btn-sm" data-section-keep>Keep</button></div>';
        } else if (now) {
            remove = '<button type="button" data-section-delete ' + (why ? 'disabled title="' + why + ': only an empty section can be deleted." ' : '') +
                'style="' + item + ';border-top:1px solid var(--line);' + (why ? 'opacity:.5;cursor:not-allowed' : 'color:var(--danger)') + '">Delete ' + esc(now) + '</button>';
        }

        var menu = '<div data-section-menu role="menu" hidden style="position:absolute;z-index:30;top:100%;left:0;margin-top:6px;min-width:240px;max-height:60vh;overflow:auto;background:var(--bg-surface);color:var(--text);border:1px solid var(--line);border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,.18);font-size:14px;font-weight:400">' +
            overview.sections.map(function (x) { return row(x.section, x.section, x.students, isOpen(x.section)); }).join('') +
            '<button type="button" data-section-new style="' + item + ';border-top:1px solid var(--line)">+ New section</button>' + remove + '</div>';
        var wasOpen = h1.querySelector('[data-section-menu]') && !h1.querySelector('[data-section-menu]').hidden;
        h1.innerHTML = '<button type="button" data-section-toggle aria-haspopup="menu" aria-expanded="' + !!wasOpen + '">' +
            esc(label) + ' <span aria-hidden="true" style="font-size:.7em;opacity:.8">▾</span></button>' + menu;
        updateHostVisibility();
        if (wasOpen) { h1.querySelector('[data-section-menu]').hidden = false; }
        renderProfLine();
    }

    /* The professor of the chosen section, under the title: their name opens the account (reset
       the password, sign out, remove); Change gives the section to another professor; a section
       with none offers Assign. One professor per section; a professor can hold several sections. */
    function closeProfMenu() { var m = $('#prof-menu'); if (m) { m.remove(); } }

    function openProfMenu(anchor) {
        closeProfMenu();
        var section = chosen();
        var current = holder[section] || '';
        var item = 'display:block;width:100%;padding:8px 12px;border:0;background:transparent;color:var(--text);font:inherit;text-align:left;cursor:pointer';
        var rows = profs.slice().sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); }).map(function (f) {
            var email = String(f.email).toLowerCase();
            var theirs = sectionsOf(email);
            return '<button type="button" data-assign="' + esc(email) + '" style="' + item + (email === current ? ';font-weight:600;background:var(--line-soft)' : '') + '">' +
                esc(f.name || f.email) + (theirs.length ? ' <span style="opacity:.65;font-weight:400">· ' + esc(theirs.join(', ')) + '</span>' : ' <span style="opacity:.65;font-weight:400">· no section</span>') +
                (email === current ? ' ✓' : '') + '</button>';
        }).join('');
        var menu = document.createElement('div');
        menu.id = 'prof-menu';
        menu.setAttribute('role', 'menu');
        menu.style.cssText = 'position:absolute;z-index:30;margin-top:6px;min-width:280px;max-height:50vh;overflow:auto;background:var(--bg-surface);color:var(--text);border:1px solid var(--line);border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,.18);font-size:14px';
        menu.innerHTML = rows +
            (current ? '<button type="button" data-assign="" style="' + item + ';border-top:1px solid var(--line);color:var(--danger)">Remove professor from ' + esc(section) + '</button>' : '') +
            '<button type="button" data-prof-add style="' + item + ';border-top:1px solid var(--line)">+ Add new professor</button>';
        anchor.parentNode.style.position = 'relative';
        anchor.parentNode.appendChild(menu);
    }

    function renderProfLine() {
        var scope = $('#view-students .scope-row');
        if (!scope) { return; }
        var el = $('#prof-line');
        if (!el) {
            el = document.createElement('p');
            el.id = 'prof-line';
            el.className = 'scope-line';
            scope.parentNode.insertBefore(el, scope.nextSibling);
            el.addEventListener('click', function (event) {
                var open = event.target.closest('[data-prof]');
                var change = event.target.closest('[data-prof-change]');
                var add = event.target.closest('[data-prof-add]');
                var assign = event.target.closest('[data-assign]');
                if (open) {
                    var email = open.getAttribute('data-prof');
                    var rowEl = Array.prototype.slice.call(document.querySelectorAll('#faculty-tbody [data-faculty]')).filter(function (r) { return r.getAttribute('data-faculty') === email; })[0];
                    if (rowEl) { rowEl.click(); } else { say('Could not open that professor. Reload the page.', true); }
                } else if (change) {
                    if ($('#prof-menu')) { closeProfMenu(); } else { openProfMenu(change); }
                } else if (add) {
                    closeProfMenu();
                    var opener = document.querySelector('[data-modal-open="modal-add-professor"]');
                    var section = chosen();
                    if (opener) {
                        opener.click();
                        setTimeout(function () {
                            var sel = $('#ap-section');
                            if (!sel) { return; }
                            Array.prototype.slice.call(sel.options).forEach(function (o) { if (o.value) { o.disabled = !!holder[o.value]; } });
                            if (section && !holder[section]) { sel.value = section; }
                        }, 60);
                    }
                } else if (assign) {
                    var wanted = assign.getAttribute('data-assign');
                    var target = chosen();
                    closeProfMenu();
                    call('admin_set_section_professor', { p_section: target, p_email: wanted || null })
                        .then(function () { say(wanted ? 'Professor assigned.' : 'Professor removed.'); return refreshOverview(); })
                        .catch(function (error) { say(failure(error), true); });
                }
            });
            document.addEventListener('click', function (event) { if (!el.contains(event.target)) { closeProfMenu(); } });
        }
        var section = chosen();
        if (!section) { el.innerHTML = ''; el._sig = ''; return; }
        var list = profsOf(section);
        /* The page refreshes every few seconds: leave the line (and an open menu) alone unless it changed. */
        var sig = section + '|' + (list.length ? list[0].email + '|' + list[0].name : '');
        if (el._sig === sig) { return; }
        el._sig = sig;
        closeProfMenu();
        el.innerHTML = list.length
            ? 'Professor: <button type="button" class="cell-link" data-prof="' + esc(list[0].email) + '">' + esc(list[0].name || list[0].email) + '</button> · <button type="button" class="cell-link" data-prof-change>Change</button>'
            : 'No professor yet · <button type="button" class="cell-link" data-prof-change>Assign professor</button>';
    }

    var LAST_KEY = 'pia_students_section';

    /* A section is always chosen: the one with attendance open, else the last one used, else the first. */
    function ensureSection() {
        if (chosen() || !overview.sections.length) { return; }
        var names = overview.sections.map(function (x) { return x.section; });
        var last = '';
        try { last = localStorage.getItem(LAST_KEY) || ''; } catch (e) { last = ''; }
        var open = overview.open.length ? overview.open[0].section : '';
        var pick = names.indexOf(open) >= 0 ? open : (names.indexOf(last) >= 0 ? last : names[0]);
        pickSection(pick);
    }

    function pickSection(name) {
        confirmDelete = false;
        var select = $('#section-filter');
        if (!name) { return; }
        try { localStorage.setItem(LAST_KEY, name); } catch (e) { /* private mode */ }
        if (!select || select.value === name) { return; }
        select.value = name;
        select.dispatchEvent(new Event('change', { bubbles: true }));   /* the page's own handler does the rest */
        renderChips();
        renderAttendance();
        refreshOverview().catch(function () {});
    }

    /* ---- attendance for the chosen section ------------------------------------ */
    function openFor(section) { return overview.open.filter(function (c) { return c.section === section; })[0]; }

    function renderAttendance() {
        var section = chosen();
        var btn = $('#att-toggle');
        if (btn) {
            btn.hidden = !section;
            var open = !!section && !!openFor(section);
            btn.textContent = open ? 'Stop attendance' : 'Start attendance';
            btn.setAttribute('data-ci', open ? 'stop' : 'start');
            btn.className = 'btn btn-sm ' + (open ? 'btn-secondary' : 'btn-primary');
        }
        paintMarks();
    }

    /* The check / cross column, while attendance is open for the chosen section. It sits right
       after the student number, so a name, its number and its mark read as one line. */
    function markCell(email) {
        var m = marks[email] || null;
        var state = m ? (m.present ? 'present' : 'absent') : 'none';
        var html = '<span class="mk-pair" role="group" aria-label="Attendance">' +
            '<button type="button" class="btn btn-sm ' + (state === 'present' ? 'btn-primary' : 'btn-secondary') + '" data-mk="present" aria-pressed="' + (state === 'present') + '" aria-label="Present" title="Present">✓</button> ' +
            '<button type="button" class="btn btn-sm ' + (state === 'absent' ? 'btn-danger' : 'btn-secondary') + '" data-mk="absent" aria-pressed="' + (state === 'absent') + '" aria-label="Absent" title="Absent">✗</button></span>';
        if (m && m.entered) { html += ' <span class="badge badge-accent">In</span>'; }
        if (m && m.refused > 0) {
            html += ' <span class="badge badge-warn" title="Another computer tried this number">Tried again ×' + m.refused + '</span>' +
                ' <button type="button" class="btn btn-secondary btn-sm" data-mk="back">Let back in</button>';
        }
        return html;
    }

    function paintMarks() {
        var section = chosen();
        var on = !!section;                                    /* the column is reserved once a section is chosen, so starting or stopping moves nothing */
        var live = on && !!openFor(section);
        document.documentElement.classList.toggle('pia-att-on', live);
        var headRow = $('#roster-thead tr');
        var th = headRow && headRow.querySelector('[data-mk-th]');
        if (on && headRow && !th) {
            th = document.createElement('th');
            th.scope = 'col';
            th.setAttribute('data-mk-th', '');
            th.textContent = 'Attendance';
            headRow.appendChild(th);
        } else if (!on && th) { th.remove(); }
        Array.prototype.slice.call(document.querySelectorAll('#student-tbody tr[data-student]')).forEach(function (tr) {
            var cell = tr.querySelector('[data-mk-cell]');
            if (!on) { if (cell) { cell.remove(); } return; }
            if (!cell) {
                cell = document.createElement('td');
                cell.setAttribute('data-mk-cell', '');
                ['click', 'keydown', 'keyup', 'dblclick'].forEach(function (type) {
                    cell.addEventListener(type, function (event) { event.stopPropagation(); });
                });
                cell.addEventListener('click', function (event) { onMark(event, tr.getAttribute('data-student')); });
                tr.appendChild(cell);
            }
            var html = live ? markCell(String(tr.getAttribute('data-student')).toLowerCase()) : '<span class="scope-line">Not started</span>';
            if (cell._html !== html) { cell._html = html; cell.innerHTML = html; }
        });
    }

    async function onMark(event, rawEmail) {
        var btn = event.target.closest('[data-mk]');
        if (!btn) { return; }
        var section = chosen();
        var email = String(rawEmail).toLowerCase();
        var kind = btn.getAttribute('data-mk');
        try {
            if (kind === 'back') {
                await call('admin_let_back_in', { p_section: section, p_email: email });
                if (marks[email]) { marks[email].entered = false; marks[email].refused = 0; }
            } else {
                var want = kind === 'present';
                var now = marks[email];
                var next = now && now.present === want ? null : want;          /* tap again to clear */
                await call('admin_set_attendance', { p_section: section, p_email: email, p_present: next });
                if (next === null) { delete marks[email]; }
                else { marks[email] = { present: next, entered: now ? now.entered : false, refused: now ? now.refused : 0 }; }
            }
            say('');
        } catch (error) { say(failure(error), true); }
        renderAttendance();
    }

    async function refreshOverview() {
        var data = await call('admin_checkin_overview');
        overview.sections = (data && data.sections) || [];
        overview.open = (data && data.open) || [];
        try {
            var pr = await sb.from('professors').select('name, email, assigned_section');
            profs = pr.error ? profs : (pr.data || []);
            var map = {};
            var pairs = await sb.rpc('admin_professor_sections');
            if (!pairs.error && pairs.data) {
                pairs.data.forEach(function (r) { map[r.section] = String(r.email).toLowerCase(); });
            } else {
                /* Before migration 0059: the professor's single section. */
                profs.forEach(function (f) { if (f.assigned_section) { map[f.assigned_section] = String(f.email).toLowerCase(); } });
            }
            holder = map;
        } catch (e) { /* keep the last list */ }
        var section = chosen();
        marks = {};
        if (section && openFor(section)) {
            var rows = await call('admin_attendance', { p_section: section });
            (rows || []).forEach(function (r) {
                marks[String(r.email).toLowerCase()] = { present: !!r.present, entered: !!r.entered, refused: Number(r.refused) || 0 };
            });
        }
        ensureSection();
        renderChips();
        renderAttendance();
    }

    async function act(button, work) {
        button.disabled = true;
        try { await work(); await refreshOverview(); } catch (error) { say(failure(error), true); }
        button.disabled = false;
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
        /* Masking keeps every box where it was: the real text goes transparent and its
           children invisible (they still take their room), and the asterisks are painted
           over the same cell, so nothing moves when the box is ticked. */
        var sel = function (suffix) { return masked.split(', ').map(function (x) { return x + suffix; }).join(', '); };
        st.textContent = '#roster-thead th{background:var(--line-soft)}'
            + '#section-host{position:relative;display:flex;align-items:center;min-width:0}#section-host[hidden]{display:none}'
            + '#section-host [data-section-toggle]{display:inline-flex;align-items:center;gap:8px;padding:6px 14px;border:1px solid var(--accent-line);background:var(--accent-soft);color:var(--accent-text);border-radius:6px;font:inherit;font-weight:600;cursor:pointer;white-space:nowrap}'
            + '#view-students .filter-row .input{height:40px;min-height:40px;box-sizing:border-box}'
            + '#view-students .page-actions .btn{min-height:40px;box-sizing:border-box}'
            + '[data-section-menu] button:hover{background:var(--line-soft)!important}'
            + '#att-toggle{min-width:10rem;text-align:center}'
            + '#roster-thead th[data-mk-th],#student-tbody td[data-mk-cell]{min-width:14rem}'
            + masked + '{position:relative;color:transparent!important}'
            + sel(' *') + '{visibility:hidden!important}'
            + sel('::after') + '{content:"********";position:absolute;inset:0;display:flex;align-items:center;padding:inherit;box-sizing:border-box;color:var(--text);letter-spacing:2px;font-size:14px}'
            + H + '#drawer-initials{position:relative;color:transparent!important}'
            + H + '#drawer-initials::after{content:"**";position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--text)}'
            + '.pia-section-picked #roster-thead th:nth-child(3),.pia-section-picked #student-tbody td:nth-child(3){display:none}';
        document.head.appendChild(st);
        var bar = $('#stage-tabs') && $('#stage-tabs').parentNode;
        if (!bar) { return; }
        var label = document.createElement('label');
        label.style.cssText = 'display:inline-flex;align-items:center;gap:8px;cursor:pointer;font-size:14px;margin-left:auto;white-space:nowrap';
        label.innerHTML = '<input type="checkbox" id="hide-details" checked> Show details';
        var filterRow = bar.parentNode.querySelector('.filter-row');
        if (filterRow) {
            label.style.alignSelf = 'flex-end';
            label.style.height = '40px';
            filterRow.appendChild(label);
        } else { bar.appendChild(label); }
        label.firstChild.addEventListener('change', function (e) { setHidden(!e.target.checked); });
        var toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.id = 'att-toggle';
        toggle.hidden = true;
        toggle.className = 'btn btn-sm btn-primary';
        toggle.textContent = 'Start attendance';
        toggle.style.marginLeft = 'auto';
        bar.appendChild(toggle);
        toggle.addEventListener('click', function () {
            var section = chosen();
            if (!section) { return; }
            var starting = toggle.getAttribute('data-ci') !== 'stop';
            act(toggle, function () {
                return starting ? call('admin_start_checkin', { p_section: section, p_minutes: 120 })
                                : call('admin_stop_checkin', { p_section: section });
            });
        });
        var was = false;
        try { was = sessionStorage.getItem('pia_hide_details') === '1'; } catch (e) {}
        setHidden(was);
    }

    function build() {
        if (built) { return; }
        buildHideToggle();
        var h1 = titleHost();
        var scores = $('#section-scores-open');
        var actions = $('#view-students .page-actions');
        if (scores && actions && scores.parentNode !== actions) { actions.insertBefore(scores, actions.firstChild); }
        var filter = $('#section-filter');
        if (filter) {
            filter.addEventListener('change', function () {
                document.dispatchEvent(new CustomEvent('pia:section-changed', { detail: { section: chosen() } }));
            });
        }
        window.addEventListener('hashchange', updateHostVisibility);
        var att = $('#attendance-bar');
        if (att) { att.style.display = 'none'; }
        if (!h1) { return; }
        built = true;

        var closeMenu = function () {
            var m = h1.querySelector('[data-section-menu]');
            if (m) { m.hidden = true; }
            var t = h1.querySelector('[data-section-toggle]');
            if (t) { t.setAttribute('aria-expanded', 'false'); }
        };
        h1.addEventListener('click', function (event) {
            if (event.target.closest('[data-section-toggle]')) {
                var m = h1.querySelector('[data-section-menu]');
                if (m) {
                    m.hidden = !m.hidden;
                    h1.querySelector('[data-section-toggle]').setAttribute('aria-expanded', String(!m.hidden));
                }
                return;
            }
            if (event.target.closest('[data-section-new]')) {
                closeMenu();
                var opener = document.querySelector('[data-modal-open="modal-new-section"]');
                if (opener) { opener.click(); }
                return;
            }
            if (event.target.closest('[data-section-delete]')) {
                if (event.target.closest('[data-section-delete]').disabled) { return; }
                confirmDelete = true;
                renderChips();
                return;
            }
            if (event.target.closest('[data-section-keep]')) { confirmDelete = false; renderChips(); return; }
            if (event.target.closest('[data-section-confirm]')) {
                var doomed = chosen();
                confirmDelete = false;
                (async function () {
                    try {
                        await call('admin_delete_section', { p_name: doomed });
                        var filter = $('#section-filter');
                        if (filter) { filter.value = ''; }
                        say(doomed + ' was deleted.');
                        closeMenu();
                        if (window.PIAAdmin && window.PIAAdmin.refreshAll) { window.PIAAdmin.refreshAll(); }
                        await refreshOverview();
                    } catch (error) { say(failure(error), true); renderChips(); }
                }());
                return;
            }
            var chip = event.target.closest('[data-chip]');
            if (chip) { closeMenu(); pickSection(chip.getAttribute('data-chip')); }
        });
        document.addEventListener('click', function (event) { if (!h1.contains(event.target)) { closeMenu(); } });
        document.addEventListener('keydown', function (event) { if (event.key === 'Escape') { closeMenu(); } });

        document.addEventListener('pia:students-added', function () { refreshOverview().catch(function () {}); });
    }

    /* ---- called by the console after it has drawn the table -------------------- */
    async function decorateRoster() {
        build();
        var picked = !!($('#section-filter') && $('#section-filter').value);
        document.documentElement.classList.toggle('pia-section-picked', picked);
        renderChips();
        renderAttendance();
        paintMarks();
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
            headRow.insertBefore(th, headRow.children[1] || null);     /* right beside Student */
        }

        var rows = Array.prototype.slice.call(document.querySelectorAll('#student-tbody tr[data-student]'));
        var cells = rows.map(function (tr) {
            var cell = tr.querySelector('[data-ci-cell]');
            if (!cell) {
                cell = document.createElement('td');
                cell.setAttribute('data-ci-cell', '');
                cell.innerHTML = '<span class="scope-line">…</span>';
                tr.insertBefore(cell, tr.children[1] || null);
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
