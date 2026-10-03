/**
 * ============================================================================
 * PIA SYSTEM — ADMIN SHELL
 * ============================================================================
 * Everything about the console's frame that is not data: which nav item is
 * current, the collapsible People submenu, route-derived breadcrumbs, the
 * theme toggle, the account menu, the small-screen drawer, and the header
 * search field with its anchored results.
 *
 * admin-dashboard.js owns routing and data and hands this file a `host`:
 *   host.go(view)                       switch view
 *   host.openModal(id, trigger)         open an existing dialog
 *   host.openStudent(email)             open the participant profile
 *   host.openSection(name)              show one section in the Students view
 *   host.getSections()                  [{ name }]
 *   host.searchStudents(term, signal)   Promise<[{ full_name, email, section }]>
 *   host.signOut()                      the existing sign-out
 *   host.isModalOpen()                  true while a dialog owns the keyboard
 *
 * The theme uses the site's existing persistence (localStorage "pia_theme",
 * applied before paint by theme-boot.js); this file only flips and stores it.
 * ==========================================================================*/
(function (global) {
    'use strict';

    var $ = function (sel, root) { return (root || document).querySelector(sel); };
    var $$ = function (sel, root) {
        return Array.prototype.slice.call((root || document).querySelectorAll(sel));
    };
    function esc(v) {
        return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    var host = null;

    /* ------------------------------------------------------------ routes -- */
    /* One table drives the breadcrumbs, the document title and the nav state. */
    var ROUTES = {
        overview: { trail: ['Overview'] },
        live: { trail: ['Live Sessions'] },
        students: { trail: ['People', 'Students'] },
        faculty: { trail: ['People', 'Faculty'] },
        controls: { trail: ['Stage Controls'] },
        mathtask: { trail: ['Math Task'] },
        profile: { trail: ['Profile'] },
        settings: { trail: ['Settings'] }
    };
    var PEOPLE_CHILDREN = { students: 1, faculty: 1 };

    function titleOf(view) {
        var r = ROUTES[view];
        return r ? r.trail[r.trail.length - 1] : 'Overview';
    }

    function setPeopleOpen(open) {
        var toggle = $('#nav-people-toggle');
        var list = $('#nav-people-list');
        if (!toggle || !list) { return; }
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        list.hidden = !open;
        $('#nav-people').classList.toggle('is-open', open);
    }

    function setRoute(view) {
        if (!ROUTES[view]) { view = 'overview'; }

        $$('.nav-item[data-view]').forEach(function (item) {
            var on = item.getAttribute('data-view') === view;
            item.classList.toggle('is-active', on);
            if (on) { item.setAttribute('aria-current', 'page'); } else { item.removeAttribute('aria-current'); }
        });

        /* A current child keeps its parent open (and marked) so it can be found. */
        var inPeople = !!PEOPLE_CHILDREN[view];
        $('#nav-people').classList.toggle('has-active-child', inPeople);
        if (inPeople) { setPeopleOpen(true); }

        var trail = ['Admin'].concat(ROUTES[view].trail);
        $('#crumbs-list').innerHTML = trail.map(function (label, i) {
            return i === trail.length - 1
                ? '<li aria-current="page">' + esc(label) + '</li>'
                : '<li>' + esc(label) + '</li>';
        }).join('');
        document.title = titleOf(view) + ' — PIA Admin Console';
        closeMobileNav();
    }

    /* ------------------------------------------------------------- theme -- */
    function currentTheme() {
        return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    }

    function syncThemeToggle() {
        var btn = $('#theme-toggle');
        if (!btn) { return; }
        /* Labelled by the action it performs. */
        btn.setAttribute('aria-label', currentTheme() === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
    }

    function initTheme() {
        var btn = $('#theme-toggle');
        if (!btn) { return; }
        btn.addEventListener('click', function () {
            var next = currentTheme() === 'dark' ? 'light' : 'dark';
            document.documentElement.setAttribute('data-theme', next);
            try { localStorage.setItem('pia_theme', next); } catch (e) { /* private mode */ }
            syncThemeToggle();
        });
        syncThemeToggle();
    }

    /* ------------------------------------------------------- mobile drawer -- */
    var navReturnFocus = null;

    function isNavOpen() { return $('#app').classList.contains('nav-open'); }

    function openMobileNav() {
        if (isNavOpen()) { return; }
        navReturnFocus = document.activeElement;
        $('#app').classList.add('nav-open');
        $('#nav-scrim').classList.add('is-visible');
        $('#mobile-nav-toggle').setAttribute('aria-expanded', 'true');
        var first = $('#sidebar .nav-item');
        if (first) { first.focus({ preventScroll: true }); }
    }

    function closeMobileNav() {
        if (!isNavOpen()) { return; }
        $('#app').classList.remove('nav-open');
        $('#nav-scrim').classList.remove('is-visible');
        $('#mobile-nav-toggle').setAttribute('aria-expanded', 'false');
        if (navReturnFocus && navReturnFocus.focus) { navReturnFocus.focus({ preventScroll: true }); }
        navReturnFocus = null;
    }

    function initMobileNav() {
        $('#mobile-nav-toggle').addEventListener('click', function () {
            if (isNavOpen()) { closeMobileNav(); } else { openMobileNav(); }
        });
        $('#nav-scrim').addEventListener('click', closeMobileNav);
    }

    /* --------------------------------------------------------- user menu -- */
    function userMenuItems() { return $$('#user-menu .user-menu-item'); }

    function openUserMenu(focusFirst) {
        var menu = $('#user-menu');
        menu.hidden = false;
        $('#user-menu-btn').setAttribute('aria-expanded', 'true');
        if (focusFirst) { userMenuItems()[0].focus(); }
    }

    function closeUserMenu(returnFocus) {
        var menu = $('#user-menu');
        if (menu.hidden) { return; }
        menu.hidden = true;
        $('#user-menu-btn').setAttribute('aria-expanded', 'false');
        if (returnFocus) { $('#user-menu-btn').focus(); }
    }

    function initUserMenu() {
        var btn = $('#user-menu-btn');
        var menu = $('#user-menu');

        btn.addEventListener('click', function () {
            if (menu.hidden) { openUserMenu(false); } else { closeUserMenu(false); }
        });
        btn.addEventListener('keydown', function (e) {
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); openUserMenu(true); }
            else if (e.key === 'Escape' && !menu.hidden) { e.preventDefault(); e.stopPropagation(); closeUserMenu(true); }
        });

        menu.addEventListener('keydown', function (e) {
            var items = userMenuItems();
            var i = items.indexOf(document.activeElement);
            if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
            else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
            else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeUserMenu(true); }
            else if (e.key === 'Tab') { closeUserMenu(false); }
        });

        menu.addEventListener('click', function (e) {
            var item = e.target.closest('[data-user-action]');
            if (!item) { return; }
            var action = item.getAttribute('data-user-action');
            if (action === 'signout') {
                /* Immediate: no confirmation. The host reports the outcome. */
                host.signOut();
                return;
            }
            closeUserMenu(false);
            host.go(action);
        });

        document.addEventListener('mousedown', function (e) {
            if (!menu.hidden && !e.target.closest('.sidebar-foot')) { closeUserMenu(false); }
        });
    }

    /* ---------------------------------------------------- header search -- */
    var palette = {
        open: false, items: [], active: -1,
        request: 0, controller: null, timer: null, students: null, pending: false
    };

    function matches(label, term) { return label.toLowerCase().indexOf(term) !== -1; }

    /* Builds the grouped result list for the current input. */
    function buildGroups(term) {
        var groups = [];
        if (!term) return groups;
        if (palette.students && palette.students.term === term && palette.students.rows.length) {
            groups.push({ title: 'Students', items: palette.students.rows.map(function (s) {
                return { label: s.full_name || s.email, detail: s.full_name ? s.email : (s.section || ''), run: function () { host.openStudent(s.email); } };
            }) });
        }
        var sections = host.getSections().filter(function (s) { return matches(s.name, term); });
        if (sections.length) {
            groups.push({ title: 'Sections', items: sections.slice(0, 6).map(function (s) {
                return { label: s.name, run: function () { host.openSection(s.name); } };
            }) });
        }
        return groups;
    }

    function renderPalette() {
        var term = $('#palette-input').value.trim().toLowerCase();
        var groups = buildGroups(term);
        var list = $('#palette-list');
        var flat = [];
        var html = '';

        groups.forEach(function (g, gi) {
            html += '<div class="palette-group" role="group" aria-labelledby="pg-' + gi + '">' +
                '<p class="palette-group-title" id="pg-' + gi + '">' + esc(g.title) + '</p>';
            g.items.forEach(function (item) {
                var id = 'po-' + flat.length;
                flat.push(item);
                html += '<div class="palette-option" role="option" id="' + id + '" data-index="' + (flat.length - 1) +
                    '" aria-selected="false"><span class="palette-label">' + esc(item.label) + '</span>' +
                    (item.detail ? '<span class="palette-detail">' + esc(item.detail) + '</span>' : '') + '</div>';
            });
            html += '</div>';
        });

        if (term && palette.pending) {
            html += '<p class="palette-note">Searching students…</p>';
        }
        if (term && !flat.length && !palette.pending) {
            html = '<p class="palette-note">No results for “' + esc($('#palette-input').value.trim()) + '”.</p>';
        }
        if (palette.studentError && term) {
            html += '<p class="palette-note">Students could not be searched right now.</p>';
        }

        list.innerHTML = html;
        palette.items = flat;
        palette.active = flat.length ? 0 : -1;
        paintActive();

        var status = $('#palette-status');
        status.textContent = flat.length
            ? flat.length + (flat.length === 1 ? ' result' : ' results')
            : (term && !palette.pending ? 'No results' : '');
    }

    function paintActive() {
        var input = $('#palette-input');
        $$('.palette-option').forEach(function (el, i) {
            var on = i === palette.active;
            el.classList.toggle('is-active', on);
            el.setAttribute('aria-selected', on ? 'true' : 'false');
            if (on) { el.scrollIntoView({ block: 'nearest' }); }
        });
        if (palette.active >= 0) { input.setAttribute('aria-activedescendant', 'po-' + palette.active); }
        else { input.removeAttribute('aria-activedescendant'); }
    }

    /* Students come from the server. A newer keystroke aborts the older request
       and a late response is dropped, so a slow answer for "ma" can never
       overwrite the list for "mar". */
    function searchStudents(term) {
        clearTimeout(palette.timer);
        if (palette.controller) { palette.controller.abort(); palette.controller = null; }
        palette.studentError = false;

        if (!term || term.length < 2) { palette.pending = false; palette.students = null; return; }

        palette.pending = true;
        var ticket = ++palette.request;
        palette.timer = setTimeout(function () {
            var controller = typeof AbortController === 'function' ? new AbortController() : null;
            palette.controller = controller;
            host.searchStudents(term, controller ? controller.signal : undefined).then(function (rows) {
                if (ticket !== palette.request || !palette.open) { return; }
                palette.pending = false;
                palette.students = { term: term, rows: rows || [] };
                renderPalette();
            }, function (err) {
                if (ticket !== palette.request || !palette.open) { return; }
                if (err && err.name === 'AbortError') { return; }
                palette.pending = false;
                palette.studentError = true;
                renderPalette();
            });
        }, 200);
    }

    function openPalette() {
        if (palette.open || !$('#palette-input').value.trim() || (host.isModalOpen && host.isModalOpen())) { return; }
        closeUserMenu(false);
        palette.open = true;
        $('#palette-list').hidden = false;
        $('#palette-input').setAttribute('aria-expanded', 'true');
        renderPalette();
    }

    function closePalette(restoreFocus) {
        if (!palette.open) { return; }
        palette.open = false;
        clearTimeout(palette.timer);
        palette.request++;
        if (palette.controller) { palette.controller.abort(); palette.controller = null; }
        $('#palette-list').hidden = true;
        $('#palette-input').setAttribute('aria-expanded', 'false');
        $('#palette-input').removeAttribute('aria-activedescendant');
        if (restoreFocus) $('#palette-input').focus({ preventScroll: true });
    }

    function choose(index) {
        var item = palette.items[index];
        if (!item) { return; }
        closePalette(true);
        $('#palette-input').value = '';
        item.run();
    }

    function initPalette() {
        var input = $('#palette-input');

        input.addEventListener('input', function () {
            var term = input.value.trim().toLowerCase();
            if (!term) { closePalette(false); return; }
            openPalette();
            searchStudents(term);
            renderPalette();
        });
        input.addEventListener('focus', openPalette);

        document.addEventListener('mousedown', function (e) {
            if (palette.open && !$('#palette').contains(e.target)) closePalette(false);
        });
        $('#palette-list').addEventListener('mousemove', function (e) {
            var opt = e.target.closest('.palette-option');
            if (opt) {
                var i = Number(opt.getAttribute('data-index'));
                if (i !== palette.active) { palette.active = i; paintActive(); }
            }
        });
        $('#palette-list').addEventListener('click', function (e) {
            var opt = e.target.closest('.palette-option');
            if (opt) { choose(Number(opt.getAttribute('data-index'))); }
        });

        document.addEventListener('keydown', function (e) {
            if (palette.open && e.target === input) {
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePalette(true); }
                else if (e.key === 'ArrowDown' && palette.items.length) {
                    e.preventDefault(); palette.active = (palette.active + 1) % palette.items.length; paintActive();
                } else if (e.key === 'ArrowUp' && palette.items.length) {
                    e.preventDefault(); palette.active = (palette.active - 1 + palette.items.length) % palette.items.length; paintActive();
                } else if (e.key === 'Enter') {
                    e.preventDefault(); choose(palette.active);
                } else if (e.key === 'Tab') {
                    closePalette(false);
                }
                return;
            }

            if (e.key === 'Escape') {
                if ($('#user-menu') && !$('#user-menu').hidden) { return; }
                if (isNavOpen() && !(host.isModalOpen && host.isModalOpen())) { closeMobileNav(); }
            }
        }, true);
    }

    /* -------------------------------------------------------------- init -- */
    function initNav() {
        $('#nav-people-toggle').addEventListener('click', function () {
            setPeopleOpen($('#nav-people-toggle').getAttribute('aria-expanded') !== 'true');
        });
        $$('.nav-item[data-view]').forEach(function (item) {
            item.addEventListener('click', function () { host.go(item.getAttribute('data-view')); });
        });
        $$('[data-view-link]').forEach(function (link) {
            link.addEventListener('click', function (e) { e.preventDefault(); host.go(link.getAttribute('data-view-link')); });
        });
    }

    function init(h) {
        host = h;
        initNav();
        initTheme();
        initMobileNav();
        initUserMenu();
        initPalette();
    }

    global.PIAAdminShell = {
        init: init,
        setRoute: setRoute,
        titleOf: titleOf,
        isRoute: function (v) { return !!ROUTES[v]; },
        closeMobileNav: closeMobileNav,
        isPaletteOpen: function () { return palette.open; }
    };
})(window);
