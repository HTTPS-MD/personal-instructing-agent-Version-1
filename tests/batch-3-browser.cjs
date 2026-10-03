/* Isolated browser verification for Batch 3 (Admin dashboard).
   Every non-loopback request is intercepted and the Supabase SDK is replaced by
   an in-memory fixture that really filters, counts, orders and pages, so the
   console's own queries are exercised. Nothing here contacts Supabase, sends
   email or touches an account. Mocked success is front-end evidence only. */
const { chromium } = require('playwright');
const { createServer } = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const out = process.env.PIA_TEST_OUTPUT || '/tmp/pia-batch-3-evidence';
fs.mkdirSync(out, { recursive: true });
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg' };
const server = createServer((req, res) => {
  const file = path.resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (error, data) => {
    if (error) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
    res.end(data);
  });
});

/* ------------------------------------------------------------------ data -- */
function makeData(overrides = {}) {
  const students = [];
  const sections = ['Earth', 'Jupiter', 'Mars', 'Venus'];   /* Venus has no students */
  const groups = ['assigned', 'non-assigned', 'neutral', 'control'];
  for (let i = 1; i <= 23; i++) {
    const n = String(i).padStart(2, '0');
    let stage = 'Waiting Room', game = false;
    if (i <= 5) stage = 'OCEAN';
    else if (i <= 9) stage = 'Character Selection';
    else if (i <= 15) { stage = 'Tutoring Dashboard'; if (i <= 12) game = true; }
    students.push({
      full_name: `Student ${n}`, email: `student${n}@example.test`, role: 'student',
      section: i <= 8 ? 'Earth' : i <= 16 ? 'Jupiter' : (i <= 22 ? 'Mars' : null),
      group_type: groups[i % 4], status: i % 8 === 0 ? 'inactive' : 'active',
      current_stage: stage, is_in_game: game, stage_started_at: null, selected_character: null,
      active_devices: [3, 6, 9, 10, 18].includes(i) ? ['abc [Windows PC]'] : [], max_devices: 1,   /* signed in: 3,6 (connected), 9,10 (stale beat), 18 (never beat: waiting room) */
      is_ocean_done: i > 5, pre_test_score: null, post_test_score: null,
      parental_consent: true, student_assent: true, must_change_password: false
    });
  }
  students[22].full_name = 'Bartholomew-Maximilian-Alexandrovich-Fitzgerald-Montgomery Wolfeschlegelsteinhausen';
  students[22].email = 'a.very.long.email.address.for.wrapping.checks.bartholomew.maximilian@subdomain.example.test';
  const admins = [
    { full_name: 'Ada Admin', email: 'admin@example.test', role: 'admin', status: 'active', active_devices: ['dev-self [macOS Computer]'], max_devices: 99 },
    { full_name: 'Ben Other', email: 'ben@example.test', role: 'admin', status: 'inactive', active_devices: [], max_devices: 99 },
    { full_name: 'Cy Signed', email: 'cy@example.test', role: 'admin', status: 'active', active_devices: ['x [Windows PC]'], max_devices: 99 }
  ];
  const professors = [
    { name: 'Prof One', email: 'prof1@example.test', department: 'Mathematics', assigned_section: 'Earth', status: 'active' },
    { name: 'Prof Two', email: 'prof2@example.test', department: 'Science', assigned_section: null, status: 'inactive' }
  ];
  /* beatAgo = seconds since the stage page last checked in. */
  const stageTimes = {};
  for (let i = 1; i <= 8; i++) {
    const e = `student${String(i).padStart(2, '0')}@example.test`;
    stageTimes[e] = { student_email: e, ocean_time: 65 * i, character_select_time: 0, tutoring_time: 0, heartbeat_stage: 'OCEAN', beatAgo: 5 };
  }
  for (let i = 9; i <= 12; i++) {
    const e = `student${String(i).padStart(2, '0')}@example.test`;
    stageTimes[e] = { student_email: e, ocean_time: 0, character_select_time: 0, tutoring_time: 3725 + i, heartbeat_stage: 'Tutoring Dashboard', beatAgo: 600 };
  }
  return Object.assign({
    profiles: students.concat(admins), sections: sections.map(name => ({ name })), professors,
    settings: [{ key: 'stage_ocean', value: false }, { key: 'stage_char', value: false }, { key: 'stage_dash', value: false }],
    stage_overrides: [], ocean_submissions: [], question_bank: [], app_config: [],
    student_stage_time: stageTimes
  }, overrides);
}

/* ---------------------------------------------------- in-page Supabase -- */
function fixture() {
  const f = window.fixture = Object.assign({ calls: [], data: null, fail: {}, delay: {}, signoutError: false, resetError: null, resetDelay: 0, passwordCheck: 'ok', searchDelay: [] }, window.fixtureInitial || {});
  const me = 'admin@example.test';
  const tbl = n => f.data[n] || [];
  const rowsFor = name => {
    if (name === 'student_stage_time') {
      return Object.values(f.data.student_stage_time || {}).map(r => Object.assign({}, r, {
        last_heartbeat_timestamp: new Date(Date.now() - r.beatAgo * 1000).toISOString() }));
    }
    return tbl(name).map(r => Object.assign({}, r));
  };
  const parseOr = expr => expr.split(',').map(part => { const m = part.match(/^([a-z_]+)\.ilike\.%(.*)%$/); return m ? { col: m[1], term: m[2].toLowerCase() } : null; }).filter(Boolean);

  function builder(name) {
    const b = { filters: [], order: null, range: null, limit: null, count: null, head: false, single: false, signal: null, write: null };
    const api = {
      select(cols, opts) { b.cols = cols; if (opts && opts.count) b.count = opts.count; if (opts && opts.head) b.head = true; return api; },
      eq(c, v) { b.filters.push(r => r[c] === v); return api; },
      neq(c, v) { b.filters.push(r => r[c] !== v); return api; },
      in(c, vs) { b.filters.push(r => vs.indexOf(r[c]) !== -1); return api; },
      or(expr) { const conds = parseOr(expr); b.filters.push(r => conds.some(x => String(r[x.col] || '').toLowerCase().indexOf(x.term) !== -1)); return api; },
      order(c, o) { b.order = { c, asc: !o || o.ascending !== false }; return api; },
      range(a, z) { b.range = [a, z]; return api; },
      limit(n) { b.limit = n; return api; },
      abortSignal(s) { b.signal = s; return api; },
      maybeSingle() { b.single = true; return api; },
      single() { b.single = true; return api; },
      insert(v) { b.write = { op: 'insert', v }; return api; },
      update(v) { b.write = { op: 'update', v }; return api; },
      delete() { b.write = { op: 'delete' }; return api; },
      upsert(v) { b.write = { op: 'upsert', v }; return api; },
      then(resolve, reject) { return run().then(resolve, reject); }
    };
    async function run() {
      f.calls.push({ method: 'from', table: name, write: b.write && b.write.op, cols: b.cols, values: b.write && b.write.v, filters: b.filters.length });
      const wait = f.delay[name] || 0;
      if (wait) await new Promise(r => setTimeout(r, wait));
      if (b.signal && b.signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
      if (b.write && f.failWrite && f.failWrite[name]) return { data: null, error: Object.assign({ message: 'fixture write failure' }, f.failWrite[name]), count: null };
      if (f.fail[name]) return { data: null, error: Object.assign({ message: 'fixture failure' }, f.fail[name]), count: null };
      if (b.write) return { data: null, error: null };
      let rows = rowsFor(name).filter(r => b.filters.every(fn => fn(r)));
      if (b.order) rows.sort((x, y) => String(x[b.order.c] == null ? '' : x[b.order.c]).localeCompare(String(y[b.order.c] == null ? '' : y[b.order.c])) * (b.order.asc ? 1 : -1));
      const total = rows.length;
      if (b.range) rows = rows.slice(b.range[0], b.range[1] + 1);
      if (b.limit != null) rows = rows.slice(0, b.limit);
      if (b.single) return { data: rows[0] || null, error: null };
      return { data: b.head ? null : rows, error: null, count: b.count ? total : null };
    }
    return api;
  }

  const user = { id: 'isolated-admin', email: me };
  const auth = {
    getSession: async () => ({ data: { session: { access_token: 'isolated', user } }, error: null }),
    getUser: async () => ({ data: { user }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    signOut: async (args) => {
      f.calls.push({ method: 'signOut', args });
      if (f.signoutError && (!args || args.scope === 'global')) return { error: { message: 'Network request failed' } };
      return { error: null };
    },
    resetPasswordForEmail: async (email, opts) => {
      f.calls.push({ method: 'reset', email, redirectTo: opts && opts.redirectTo });
      if (f.resetDelay) await new Promise(r => setTimeout(r, f.resetDelay));
      return { data: {}, error: f.resetError };
    },
    signInWithPassword: async (args) => {
      f.calls.push({ method: 'probeSignIn' });
      if (args.password === 'wrong-password') return { data: null, error: { status: 400, message: 'Invalid login credentials' } };
      return { data: { user }, error: null };
    },
    updateUser: async (args) => { f.calls.push({ method: 'updateUser', keys: Object.keys(args || {}) }); return { data: { user }, error: null }; },
    signInWithOtp: async () => ({ data: {}, error: null })
  };
  const api = {
    auth,
    from: name => builder(name),
    rpc: async (name, args) => {
      f.calls.push({ method: 'rpc', name, args });
      if (name === 'jwt_is_current') return { data: true, error: null };
      if (name === 'claim_device') {
        const mine = args.p_device_id;
        const row = f.data.profiles.find(p => p.email === me);
        if (row.active_devices.indexOf(mine) === -1) row.active_devices = [mine, 'other-dev [Windows PC]'];
        return { data: { allowed: true, devices: row.active_devices }, error: null };
      }
      return { data: { ok: true }, error: null };
    },
    channel: () => { const ch = { on() { return ch; }, subscribe() { return ch; } }; return ch; },
    removeChannel() {}
  };
  window.supabase = { createClient: () => api };
}

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PIA_CHROME, args: ['--disable-background-networking'] });
  const results = [];
  const leaked = [];
  const ADMIN = '/admin/html/admin-dashboard.html';

  async function open(route = 'overview', { width = 1280, height = 900, theme = 'dark', initial = {}, data, reduced = false, clock = false } = {}) {
    const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block', reducedMotion: reduced ? 'reduce' : 'no-preference' });
    await context.addInitScript(i => window.fixtureInitial = i, Object.assign({ data: data || makeData() }, initial));
    await context.addInitScript(t => { try { if (!localStorage.getItem('pia_theme')) localStorage.setItem('pia_theme', t); localStorage.setItem('pia_user_email', 'admin@example.test'); } catch (e) {} }, theme);
    await context.route('**/*', r => {
      const u = r.request().url();
      if (u.startsWith(origin + '/')) return r.continue();
      if (u.startsWith('https://cdn.jsdelivr.net/npm/@supabase/supabase-js')) return r.fulfill({ contentType: 'text/javascript', body: `(${fixture.toString()})();` });
      leaked.push(u); return r.abort('blockedbyclient');
    });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    page.on('pageerror', e => results.push({ error: e.message }));
    if (clock) await page.clock.install({ time: new Date() });
    await page.goto(origin + ADMIN + '#' + route);
    await page.waitForFunction(() => !document.body.hasAttribute('data-boot'));
    return page;
  }
  async function check(name, fn) {
    if (process.env.PIA_TEST_FILTER && !name.includes(process.env.PIA_TEST_FILTER)) return;
    try { await fn(); results.push({ name, pass: true }); } catch (e) { results.push({ name, pass: false, message: String(e.message).slice(0, 500) }); }
  }
  const calls = p => p.evaluate(() => window.fixture.calls);
  /* Focus is handed back a moment after a dialog's close animation, so poll for it. */
  const focusIs = (p, test, arg) => p.waitForFunction(([src, a]) => (new Function('a', 'return (' + src + ')(document.activeElement, a)'))(a), [test.toString(), arg], { timeout: 3000 });
  /* Let the boot veil and any dialog fade finish so the picture is the settled state. */
  const shot = async (p, name) => { await p.waitForFunction(() => document.querySelector('#boot-veil').hidden); await p.waitForTimeout(450); await p.screenshot({ path: path.join(out, name + '.png') }); };
  const overflow = p => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  const visibleText = (p, sel) => p.locator(sel).evaluateAll(els => els.filter(e => e.getClientRects().length).map(e => e.innerText));
  const waitStudents = p => p.waitForFunction(() => document.querySelectorAll('#student-tbody tr[data-student]').length > 0);
  const nav = p => p.evaluate(() => [...document.querySelectorAll('#sidebar .nav-item')].filter(e => e.getClientRects().length).map(e => e.innerText.replace(/\s+/g, ' ').trim().replace(/\s+(\d+|—)$/, '')));

  /* ================= SHELL, NAVIGATION, HEADER ================= */
  await check('shell: exact navigation order, no category headings, People collapsible', async () => {
    const p = await open('overview');
    assert.deepEqual(await nav(p), ['Overview', 'Live Sessions', 'People', 'Stage Controls', 'Math Task']);
    const toggle = p.locator('#nav-people-toggle');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await p.locator('#nav-people-list').isVisible(), false);
    await toggle.focus(); await p.keyboard.press('Enter');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    assert.deepEqual(await nav(p), ['Overview', 'Live Sessions', 'People', 'Class Sections', 'All Students', 'Faculty', 'Stage Controls', 'Math Task']);
    const text = await p.locator('#sidebar').innerText();
    for (const banned of ['Workspace', 'Research Ops', 'Sections management', 'Student Roster', 'Manage gates']) assert.equal(text.includes(banned), false, banned);
    await p.keyboard.press('Space');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    await p.context().close();
  });
  await check('shell: active child keeps People open and is marked current; routes via hash', async () => {
    const p = await open('students');
    assert.equal(await p.locator('#nav-people-toggle').getAttribute('aria-expanded'), 'true');
    assert.equal(await p.locator('.nav-item[data-view="students"]').getAttribute('aria-current'), 'page');
    await p.locator('.nav-item[data-view="faculty"]').click();
    assert.equal(await p.evaluate(() => location.hash), '#faculty');
    assert.equal(await p.locator('.nav-item[data-view="faculty"]').getAttribute('aria-current'), 'page');
    assert.equal(await p.locator('.nav-item[data-view="students"]').getAttribute('aria-current'), null);
    await p.evaluate(() => { location.hash = '#controls'; });
    await p.waitForFunction(() => document.querySelector('#view-controls:not(.is-hidden)'));
    await p.context().close();
  });
  await check('header: route-derived breadcrumbs, search trigger, theme toggle at far right, borders only', async () => {
    const p = await open('overview');
    const expected = { overview: 'Admin Overview', live: 'Admin Live Sessions', sections: 'Admin People Class Sections', students: 'Admin People All Students', faculty: 'Admin People Faculty', controls: 'Admin Stage Controls', mathtask: 'Admin Math Task', profile: 'Admin Profile', settings: 'Admin Settings' };
    for (const [route, crumbs] of Object.entries(expected)) {
      await p.evaluate(r => { location.hash = '#' + r; }, route);
      await p.waitForFunction(r => document.querySelector(`#view-${r}:not(.is-hidden)`), route);
      assert.equal((await p.locator('#crumbs-list li').allInnerTexts()).join(' '), crumbs, route);
      assert.equal(await p.locator('#crumbs-list li[aria-current="page"]').count(), 1);
    }
    const hdr = await p.locator('.topbar').evaluate(el => { const c = getComputedStyle(el); const b = el.getBoundingClientRect(); return { h: b.height, bw: c.borderBottomWidth, shadow: c.boxShadow }; });
    assert.ok(hdr.h >= 56 && hdr.h <= 64, 'header height ' + hdr.h);
    assert.equal(hdr.bw, '1px'); assert.equal(hdr.shadow, 'none');
    assert.equal(await p.locator('#palette-open').getAttribute('aria-label'), 'Search students, sections, or commands');
    const sb = await p.locator('#palette-open').boundingBox(), tb = await p.locator('#theme-toggle').boundingBox(), vp = p.viewportSize();
    assert.ok(Math.abs((sb.x + sb.width / 2) - vp.width / 2) < 160, 'search is roughly centred');
    assert.ok(tb.x + tb.width >= vp.width - 24 && tb.x > sb.x, 'theme toggle is the far-right control');
    await p.context().close();
  });
  await check('theme: toggle is named by its action, flips, persists in pia_theme, themes the shell', async () => {
    const p = await open('overview', { theme: 'dark' });
    assert.equal(await p.locator('#theme-toggle').getAttribute('aria-label'), 'Switch to light theme');
    const darkBg = await p.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await p.locator('#theme-toggle').click();
    assert.equal(await p.evaluate(() => document.documentElement.dataset.theme), 'light');
    assert.equal(await p.evaluate(() => localStorage.getItem('pia_theme')), 'light');
    assert.equal(await p.locator('#theme-toggle').getAttribute('aria-label'), 'Switch to dark theme');
    assert.notEqual(await p.evaluate(() => getComputedStyle(document.body).backgroundColor), darkBg);
    await p.reload(); await p.waitForFunction(() => !document.body.hasAttribute('data-boot'));
    assert.equal(await p.evaluate(() => document.documentElement.dataset.theme), 'light');
    await p.context().close();
  });
  await check('typography and shape: Inter for UI, JetBrains Mono for numbers, 4-6px radii, flush bordered frame', async () => {
    const p = await open('students'); await waitStudents(p);
    const info = await p.evaluate(() => {
      const fam = s => getComputedStyle(document.querySelector(s)).fontFamily;
      const rad = s => parseFloat(getComputedStyle(document.querySelector(s)).borderTopLeftRadius);
      return { body: fam('body'), nav: fam('.nav-item'), cell: fam('.cell-name'), count: fam('[data-stage-count="all"]'), navCount: fam('#nav-count-students'),
        btn: rad('.btn'), input: rad('.input'), panel: rad('.panel'), badge: rad('.badge'), avatar: getComputedStyle(document.querySelector('.avatar')).borderRadius,
        sideBorder: getComputedStyle(document.querySelector('.sidebar')).borderRightWidth, pagerFont: fam('#pager-info') };
    });
    assert.match(info.body, /Inter/); assert.match(info.nav, /Inter/); assert.match(info.cell, /Inter/);
    assert.match(info.count, /JetBrains Mono/); assert.match(info.navCount, /JetBrains Mono/);
    for (const k of ['btn', 'input', 'panel', 'badge']) assert.ok(info[k] >= 4 && info[k] <= 6, k + ' radius ' + info[k]);
    assert.match(info.avatar, /50%/); assert.equal(info.sideBorder, '1px');
    const fonts = await p.evaluate(() => [...document.querySelectorAll('link[id^="admin-font-css"]')].map(l => l.href));
    assert.deepEqual(fonts, ['https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap', 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap']);
    await p.context().close();
  });
  await check('removals: no export controls, no greeting, no shortcut hints, no decorative stat cards', async () => {
    const p = await open('overview');
    for (const route of ['overview', 'live', 'sections', 'students', 'faculty', 'controls', 'mathtask', 'profile', 'settings']) {
      await p.evaluate(r => { location.hash = '#' + r; }, route);
      await p.waitForFunction(r => document.querySelector(`#view-${r}:not(.is-hidden)`), route);
    }
    const html = await p.evaluate(() => document.body.innerText);
    for (const banned of ['Export CSV', 'Export dataset', 'How N is scored', 'Good morning', 'Good afternoon', 'Good evening', 'Security log', 'Student roster', 'Manage gates']) assert.equal(html.includes(banned), false, banned);
    assert.equal(await p.locator('.stat, .stat-grid, .health-grid, .funnel').count(), 0);
    await p.context().close();
  });

  /* ================= OVERVIEW / MATH TASK ================= */
  await check('overview is a blank bordered state (no charts, metrics or widgets)', async () => {
    const p = await open('overview');
    const body = await p.locator('#view-overview').evaluate(el => ({ text: el.innerText.trim(), canvas: el.querySelectorAll('canvas, svg, table, .bar').length }));
    assert.equal(body.canvas, 0);
    assert.ok(body.text.length < 60, body.text);
    assert.equal(await p.locator('#view-overview .empty-panel').evaluate(el => getComputedStyle(el).borderTopWidth), '1px');
    await shot(p, 'overview-dark-1280');
    await p.context().close();
  });
  await check('math task: blank page per spec, no question-bank UI or modals', async () => {
    const p = await open('mathtask');
    await p.waitForSelector('#view-mathtask .empty-panel');
    assert.equal((await p.locator('#view-mathtask .page-title').innerText()).trim(), 'Math Task');
    assert.equal(await p.locator('#view-mathtask table, #view-mathtask button, #view-mathtask input, #view-mathtask .card').count(), 0);
    assert.equal(await p.locator('#modal-qb-edit, #modal-qb-generate, #tpl-qb-step, #nav-count-mathtask').count(), 0);
    assert.equal(await overflow(p), true);
    await shot(p, 'mathtask-dark-1280');
    await p.context().close();
  });

  /* ================= LIVE SESSIONS ================= */
  await check('live: Connected/Offline/Unknown only, hh:mm:ss in mono, connected first, sections and stages truthful', async () => {
    const p = await open('live');
    await p.waitForSelector('#live-tbody tr[data-live-row]');
    const rows = await p.locator('#live-tbody tr[data-live-row]').evaluateAll(trs => trs.map(tr => ({ text: tr.innerText, clock: tr.querySelector('.duration-cell').innerText, conn: tr.querySelector('.duration-cell').dataset.liveConn })));
    assert.equal(rows.length, 10);
    assert.ok(rows.every(r => /^\d\d:\d\d:\d\d$/.test(r.clock)), JSON.stringify(rows.map(r => r.clock)));
    const conns = rows.map(r => r.conn);
    assert.deepEqual(conns, ['connected', 'connected', 'connected', 'connected', 'connected', 'connected', 'connected', 'connected', 'unknown', 'unknown']);
    const all = (await p.locator('#view-live').innerText());
    assert.equal(/\bActive\b(?! time)|\bIdle\b|Away/.test(all.replace(/Active (time|session)/ig, '')), false, 'no Active / Idle / Away labels');
    assert.match(all, /Connected/); assert.match(all, /Unknown/);
    assert.match(await p.locator('[data-live-clock]').first().evaluate(e => getComputedStyle(e).fontFamily), /JetBrains Mono/);
    assert.equal(await p.locator('#live-tbody tr[data-live-row] .avatar').first().evaluate(e => { const b = e.getBoundingClientRect(); return Math.round(b.width) + 'x' + Math.round(b.height); }), '24x24');
    assert.equal(await p.locator('[data-live-count="all"]').innerText(), '13');
    assert.equal(await p.locator('[data-live-count="connected"]').innerText(), '8');
    assert.equal(await p.locator('[data-live-count="offline"]').innerText(), '2');
    assert.equal(await p.locator('[data-live-count="unknown"]').innerText(), '3');
    await shot(p, 'live-dark-1280');
    await p.context().close();
  });
  await check('live: connected clocks advance, offline clocks are frozen, one interval (no drift stacking)', async () => {
    const p = await open('live');
    await p.waitForSelector('#live-tbody tr[data-live-row]');
    await p.locator('[data-live-filter="offline"]').click();
    const off1 = await p.locator('[data-live-conn="offline"]').allInnerTexts();
    await p.locator('[data-live-filter="connected"]').click();
    const on1 = await p.locator('[data-live-conn="connected"]').first().innerText();
    await p.waitForTimeout(2300);
    const on2 = await p.locator('[data-live-conn="connected"]').first().innerText();
    const toSec = t => t.split(':').reduce((a, v) => a * 60 + Number(v), 0);
    const advanced = toSec(on2) - toSec(on1);
    assert.ok(advanced >= 2 && advanced <= 3, 'advanced ' + advanced);
    await p.locator('[data-live-filter="offline"]').click();
    assert.deepEqual(await p.locator('[data-live-conn="offline"]').allInnerTexts(), off1);
    assert.deepEqual(off1, ['01:02:16', '01:02:17']);   /* server-counted seconds, 1h 2m 14s... */
    await p.context().close();
  });
  await check('live: a student whose check-ins stop becomes Offline and their clock freezes', async () => {
    const p = await open('live', { clock: true });
    await p.waitForSelector('#live-tbody tr[data-live-row]');
    await p.evaluate(() => { window.fixture.data.student_stage_time['student01@example.test'].beatAgo = 400; });
    await p.clock.runFor(21000);
    await p.waitForFunction(() => document.querySelector('[data-live-count="connected"]').textContent === '7');
    await p.locator('[data-live-filter="offline"]').click();
    const row = p.locator('tr[data-live-row="student01@example.test"] [data-live-clock]');
    const frozen = await row.innerText();
    await p.clock.runFor(5000);
    assert.equal(await row.innerText(), frozen);
    await p.context().close();
  });
  await check('live: filter + pagination boundaries (10 rows per page) and clamping', async () => {
    const p = await open('live');
    await p.waitForSelector('#live-tbody tr[data-live-row]');
    assert.equal(await p.locator('#live-prev').isDisabled(), true);
    assert.equal(await p.locator('#live-next').isDisabled(), false);
    await p.locator('#live-next').click();
    assert.equal(await p.locator('#live-tbody tr[data-live-row]').count(), 3);
    assert.equal(await p.locator('#live-next').isDisabled(), true);
    assert.equal(await p.locator('#live-prev').isDisabled(), false);
    await p.locator('[data-live-filter="offline"]').click();            // page resets / clamps
    assert.equal(await p.locator('#live-tbody tr[data-live-row]').count(), 2);
    assert.equal(await p.locator('#live-prev').isDisabled(), true);
    assert.equal(await p.locator('#live-next').isDisabled(), true);
    assert.match(await p.locator('#live-pager-info').innerText(), /Showing 1–2 of 2/);
    await p.context().close();
  });
  await check('live: unavailable table, load error and empty states are explicit (never zero)', async () => {
    let p = await open('live', { initial: { fail: { student_stage_time: { code: '42P01', message: 'relation does not exist' } } } });
    await p.waitForSelector('#live-tbody .state-block');
    assert.match(await p.locator('#live-tbody').innerText(), /not available/i);
    assert.equal(await p.locator('[data-live-count="all"]').innerText(), '—');
    await p.context().close();
    const none = makeData(); none.student_stage_time = {}; none.profiles.forEach(r => { r.active_devices = []; });
    p = await open('live', { data: none });
    await p.waitForSelector('#live-tbody .state-block');
    assert.match(await p.locator('#live-tbody').innerText(), /No student activity recorded yet/);
    await p.context().close();
  });

  /* ================= CLASS SECTIONS ================= */
  await check('class sections: only Online/Offline labels; insufficient evidence shows a dash with an accessible explanation', async () => {
    const p = await open('sections');
    await p.waitForSelector('#sections-tbody tr');
    const rows = await p.locator('#sections-tbody tr').evaluateAll(trs => trs.map(tr => [...tr.children].map(td => td.innerText.trim())));
    const by = Object.fromEntries(rows.map(r => [r[0], r]));
    assert.match(by.Earth[4], /^Online$/);                      // students 1-8 checked in 5s ago
    for (const name of ['Jupiter', 'Mars', 'Venus']) {          // signed-in members without a heartbeat, never-seen members, no members
      assert.match(by[name][4], /^—/, name);
      assert.equal(/Offline|Unknown/i.test(by[name][4]), false, name + ' is not labelled Offline or Unknown');
    }
    const cell = p.locator('#sections-tbody tr', { hasText: 'Jupiter' }).locator('td').nth(4);
    assert.equal(await cell.locator('.sr-only').innerText(), 'Status unavailable');
    assert.equal(await cell.locator('[title]').getAttribute('title'), 'Status unavailable');
    assert.equal(by.Earth[1], 'Prof One'); assert.equal(by.Earth[2], '8');
    assert.equal(/Idle|Unknown/i.test(await p.locator('#view-sections').innerText()), false);
    assert.equal(await p.locator('#sections-tbody .dot').first().getAttribute('aria-hidden'), 'true');   // dot paired with text
    const aligns = await p.locator('#view-sections thead th').evaluateAll(els => els.map(e => getComputedStyle(e).textAlign));
    assert.deepEqual([aligns[2], aligns[3]], ['right', 'right'], 'numeric headers align with their cells');
    assert.equal(await p.locator('#sections-grid, .section-card').count(), 0);
    await shot(p, 'sections-dark-1280');
    await p.context().close();
  });
  await check('class sections: Offline only when every member is verified signed out', async () => {
    const d = makeData();
    d.profiles.filter(r => r.section === 'Jupiter').forEach(r => {
      r.active_devices = [];
      const e = r.email;
      d.student_stage_time[e] = { student_email: e, ocean_time: 0, character_select_time: 0, tutoring_time: 100, heartbeat_stage: 'Tutoring Dashboard', beatAgo: 900 };
    });
    const p = await open('sections', { data: d });
    await p.waitForSelector('#sections-tbody tr');
    const jup = await p.locator('#sections-tbody tr', { hasText: 'Jupiter' }).locator('td').nth(4).innerText();
    assert.match(jup.trim(), /^Offline$/);
    await p.context().close();
  });
  await check('class sections: unknown connection data shows "—", never Offline', async () => {
    const p = await open('sections', { initial: { fail: { student_stage_time: { code: '42P01', message: 'x' } } } });
    await p.waitForSelector('#sections-tbody tr td');
    const cells = await p.locator('#sections-tbody tr').evaluateAll(trs => trs.map(tr => tr.children[4].innerText.trim()));
    assert.deepEqual(cells.map(c => c.replace(/\s*Status unavailable$/, '')), ['—', '—', '—', '—']);
    await p.context().close();
  });
  await check('class sections: View opens the roster dialog with one X, Escape closes, focus returns', async () => {
    const p = await open('sections');
    await p.waitForSelector('#sections-tbody tr');
    const btn = p.locator('[data-section-open="Earth"]');
    await btn.focus(); await p.keyboard.press('Enter');
    await p.waitForSelector('#modal-section-details.is-open');
    assert.equal(await p.locator('#modal-section-details .modal-close:visible, #modal-section-details [data-modal-close]:visible').count(), 1);
    await p.keyboard.press('Escape');
    await p.waitForFunction(() => !document.querySelector('#modal-section-details.is-open'));
    await focusIs(p, el => el.getAttribute('data-section-open') === 'Earth');
    await p.context().close();
  });

  /* ================= ALL STUDENTS ================= */
  await check('all students: real filter counts from the full dataset, tabs not cards', async () => {
    const p = await open('students'); await waitStudents(p);
    await p.waitForFunction(() => document.querySelector('[data-stage-count="all"]').textContent === '23');
    const counts = await p.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-stage-count]')].map(e => [e.dataset.stageCount, e.textContent])));
    assert.deepEqual(counts, { all: '23', OCEAN: '5', 'Character Selection': '4', 'Tutoring Dashboard': '3', 'Active Game': '3' });
    assert.equal(await p.locator('#stage-tabs .tab.is-active').getAttribute('data-stage-filter'), '');
    const style = await p.locator('#stage-tabs .tab.is-active').evaluate(el => getComputedStyle(el).boxShadow);
    assert.notEqual(style, 'none');                       // 1px underline
    assert.equal(await p.locator('#nav-count-students').innerText(), '23');
    const lay = await p.evaluate(() => { const g = document.querySelector('#group-filter').getBoundingClientRect(), s = document.querySelector('#student-search').getBoundingClientRect(), t = document.querySelector('#stage-tabs').getBoundingClientRect();
      return { sameRow: Math.abs(g.top - s.top) < 4 && Math.abs(t.top - g.top) < 40, groupW: g.width, pad: parseFloat(getComputedStyle(document.querySelector('#student-search')).paddingLeft) }; });
    assert.ok(lay.sameRow, 'tabs, group filter and search share one row: ' + JSON.stringify(lay));
    assert.ok(lay.groupW <= 200, 'group filter is not stretched: ' + lay.groupW);
    assert.ok(lay.pad >= 28, 'search text clears the icon: ' + lay.pad);
    await shot(p, 'students-dark-1280');
    await p.context().close();
  });
  await check('all students: maximum 10 rows per page; Previous/Next disabled at boundaries; counts stay full-dataset', async () => {
    const p = await open('students'); await waitStudents(p);
    assert.equal(await p.locator('#student-tbody tr[data-student]').count(), 10);
    assert.equal(await p.locator('#page-prev').isDisabled(), true);
    assert.match(await p.locator('#pager-info').innerText(), /Showing 1–10 of 23 · page 1 of 3/);
    await p.locator('#page-next').click();
    await p.waitForFunction(() => /Showing 11–20/.test(document.querySelector('#pager-info').textContent));
    assert.equal(await p.locator('#student-tbody tr[data-student]').count(), 10);
    await p.locator('#page-next').click();
    await p.waitForFunction(() => /Showing 21–23/.test(document.querySelector('#pager-info').textContent));
    assert.equal(await p.locator('#student-tbody tr[data-student]').count(), 3);
    assert.equal(await p.locator('#page-next').isDisabled(), true);
    assert.equal(await p.locator('[data-stage-count="all"]').innerText(), '23');       // not the page's 3
    const box = await p.locator('#page-next').boundingBox(), panel = await p.locator('#view-students .panel').boundingBox();
    assert.ok(panel.x + panel.width - (box.x + box.width) < 24, 'Next sits bottom-right');
    await p.context().close();
  });
  await check('all students: tab filters reset to page 1 and load matching rows; search + group combine', async () => {
    const p = await open('students'); await waitStudents(p);
    await p.locator('#page-next').click();
    await p.waitForFunction(() => /Showing 11–20/.test(document.querySelector('#pager-info').textContent));
    await p.locator('[data-stage-filter="OCEAN"]').click();
    await p.waitForFunction(() => /of 5/.test(document.querySelector('#pager-info').textContent));
    assert.equal(await p.locator('#student-tbody tr[data-student]').count(), 5);
    assert.equal(await p.locator('#page-next').isDisabled(), true);
    assert.equal(await p.locator('[data-stage-filter="OCEAN"]').getAttribute('aria-pressed'), 'true');
    await p.locator('[data-stage-filter="Active Game"]').click();
    await p.waitForFunction(() => /of 3/.test(document.querySelector('#pager-info').textContent));
    await p.locator('[data-stage-filter=""]').click();
    await p.fill('#student-search', 'Student 07');
    await p.waitForFunction(() => /of 1\b/.test(document.querySelector('#pager-info').textContent));
    assert.equal(await p.locator('#student-tbody tr[data-student]').count(), 1);
    await p.fill('#student-search', '');
    await p.selectOption('#group-filter', 'control');
    await p.waitForFunction(() => document.querySelector('[data-stage-count="all"]').textContent === '6' && /of 6\b/.test(document.querySelector('#pager-info').textContent));
    await p.context().close();
  });
  await check('all students: no-match and reset; error with retry; loading skeleton then data', async () => {
    let p = await open('students'); await waitStudents(p);
    await p.fill('#student-search', 'zzzz-nothing');
    await p.waitForSelector('#student-empty:not(.is-hidden)');
    assert.match(await p.locator('#student-empty').innerText(), /No matching students/);
    await p.locator('#reset-filters').click();
    await waitStudents(p);
    await p.context().close();
    p = await open('students'); await waitStudents(p);
    await p.evaluate(() => { window.fixture.fail = { profiles: { code: 'XX000', message: 'boom' } }; });
    await p.fill('#student-search', 'Student 1');
    await p.waitForSelector('#student-tbody [data-retry="roster"]');
    assert.match(await p.locator('#student-tbody').innerText(), /Couldn’t load the students/);
    assert.equal(await p.locator('#student-empty').isVisible(), false, 'an error is never shown as an empty roster');
    await p.evaluate(() => { window.fixture.fail = {}; });
    await p.locator('#student-tbody [data-retry="roster"]').click();
    await waitStudents(p);
    await p.context().close();
    p = await open('students', { initial: { delay: { profiles: 700 } } });
    await p.waitForSelector('#student-tbody .skeleton');
    await waitStudents(p);
    await p.context().close();
  });
  await check('all students: a failed counter is "—", never zero', async () => {
    const p = await open('students', { initial: { delay: {}, fail: {} } });
    await waitStudents(p);
    await p.evaluate(() => { window.fixture.fail = { profiles: { code: 'XX000', message: 'boom' } }; });
    await p.selectOption('#group-filter', 'assigned');
    await p.waitForFunction(() => document.querySelector('[data-stage-count="OCEAN"]').textContent === '—');
    assert.equal(await p.locator('[data-stage-count="all"]').innerText(), '—');
    await p.context().close();
  });
  await check('all students: long names and emails wrap inside the table (no page overflow)', async () => {
    const p = await open('students', { width: 375 }); await waitStudents(p);
    await p.locator('#page-next').click(); await p.locator('#page-next').click();
    await p.waitForFunction(() => /Showing 21–23/.test(document.querySelector('#pager-info').textContent));
    assert.equal(await overflow(p), true);
    const cell = await p.locator('#student-tbody tr').last().locator('.cell-name').evaluate(e => ({ sw: e.scrollWidth, cw: e.clientWidth }));
    assert.ok(cell.sw <= cell.cw + 1, JSON.stringify(cell));
    assert.ok(cell.cw >= 120, 'the name column stays readable (not one letter per line): ' + cell.cw);
    const tabs = await p.locator('#stage-tabs').evaluate(e => ({ h: e.getBoundingClientRect().height, scroll: e.scrollWidth > e.clientWidth }));
    assert.ok(tabs.h <= 48 && tabs.scroll, 'tabs scroll in one row on a phone: ' + JSON.stringify(tabs));
    await shot(p, 'students-long-375');
    await p.context().close();
  });

  /* ================= PARTICIPANT PROFILE ================= */
  await check('participant profile: back-arrow only, removals, Escape + focus restore', async () => {
    const p = await open('students'); await waitStudents(p);
    const row = p.locator('#student-tbody tr[data-student]').first();
    const rowEmail = await row.getAttribute('data-student');
    await row.focus(); await p.keyboard.press('Enter');
    await p.waitForSelector('#drawer-student.is-open');
    assert.equal(await p.locator('#drawer-student .modal-close').count(), 0);
    const dismiss = await p.locator('#drawer-student [data-modal-close]').evaluateAll(els => els.filter(e => e.getClientRects().length).map(e => ({ label: e.getAttribute('aria-label'), x: e.getBoundingClientRect().x })));
    assert.equal(dismiss.length, 1); assert.equal(dismiss[0].label, 'Back to students');
    const titleX = await p.locator('.drawer-title').evaluate(e => e.getBoundingClientRect().x);
    assert.ok(dismiss[0].x < titleX, 'back arrow is left of the title');
    const text = await p.locator('#drawer-student').innerText();
    for (const banned of ['Devices', 'Parental consent', 'Manage active', 'Send activation email', 'Close profile']) assert.equal(text.includes(banned), false, banned);
    assert.match(text, /Edit details/); assert.match(text, /Reset password/); assert.match(text, /Delete participant/);
    await shot(p, 'profile-drawer-dark-1280');
    await p.keyboard.press('Escape');
    await p.waitForFunction(() => !document.querySelector('#drawer-student.is-open'));
    await focusIs(p, (el, want) => el.getAttribute('data-student') === want, rowEmail);
    await row.click();
    await p.waitForSelector('#drawer-student.is-open');
    await p.locator('#drawer-student [data-modal-close]').click();
    await p.waitForFunction(() => !document.querySelector('#drawer-student.is-open'));
    await p.context().close();
  });
  await check('participant profile: reset-password dialog offers an emailed link (no code) and Cancel only', async () => {
    const p = await open('students'); await waitStudents(p);
    await p.locator('#student-tbody tr[data-student]').first().click();
    await p.waitForSelector('#drawer-student.is-open');
    await p.locator('[data-student-action="reset-password"]').click();
    await p.waitForSelector('#modal-reset-password.is-open');
    const text = await p.locator('#modal-reset-password').innerText();
    assert.match(text, /Email a reset link/); assert.equal(/\bcode\b/i.test(text.replace(/temporary password/ig, '')), false, text);
    assert.equal(await p.locator('#modal-reset-password .modal-close').count(), 0);
    await p.context().close();
  });

  /* ================= FACULTY ================= */
  await check('faculty: Reset password sends the email link, with pending then actual result', async () => {
    const p = await open('faculty', { initial: { resetDelay: 600 } });
    await p.waitForSelector('#faculty-tbody tr[data-faculty]');
    await p.locator('#faculty-tbody tr[data-faculty]').first().click();
    await p.waitForSelector('#modal-faculty.is-open');
    const modalText = await p.locator('#modal-faculty').innerText();
    assert.equal(/\bOTP\b|\bcode\b/i.test(modalText), false);
    await p.locator('#faculty-reset').click();
    await p.waitForSelector('#modal-confirm.is-open');
    await p.locator('#modal-confirm .btn-danger, #modal-confirm #confirm-accept').first().click();
    await p.waitForFunction(() => /Sending/.test(document.querySelector('#faculty-status-msg').textContent));
    assert.equal(await p.locator('#faculty-reset').isDisabled(), true);
    await p.waitForFunction(() => /accepted the request/.test(document.querySelector('#faculty-status-msg').textContent));
    const call = (await calls(p)).find(c => c.method === 'reset');
    assert.equal(call.email, 'prof1@example.test'); assert.match(call.redirectTo, /sign-up\.html$/);
    await shot(p, 'faculty-reset-dark-1280');
    await p.context().close();
  });
  await check('faculty: a failed or rate-limited reset says so and never claims success', async () => {
    const p = await open('faculty', { initial: { resetError: { status: 429, message: 'email rate limit exceeded' } } });
    await p.waitForSelector('#faculty-tbody tr[data-faculty]');
    await p.locator('#faculty-tbody tr[data-faculty]').first().click();
    await p.locator('#faculty-reset').click();
    await p.waitForSelector('#modal-confirm.is-open');
    await p.locator('#confirm-accept').click();
    await p.waitForFunction(() => /not sent/.test(document.querySelector('#faculty-status-msg').textContent));
    const msg = await p.locator('#faculty-status-msg').innerText();
    assert.match(msg, /Too many attempts/); assert.equal(/accepted the request/.test(msg), false);
    assert.equal(await p.locator('#faculty-status-msg').evaluate(e => e.classList.contains('is-error')), true);
    assert.equal(await p.locator('#faculty-reset').isDisabled(), false);
    await p.context().close();
  });
  await check('faculty: profile dialog has a single dismissal (X) and sign-out/remove stay', async () => {
    const p = await open('faculty');
    await p.waitForSelector('#faculty-tbody tr[data-faculty]');
    await p.locator('#faculty-tbody tr[data-faculty]').first().click();
    await p.waitForSelector('#modal-faculty.is-open');
    assert.equal(await p.locator('#modal-faculty .modal-close:visible, #modal-faculty [data-modal-close]:visible').count(), 1);
    assert.match(await p.locator('#modal-faculty').innerText(), /Sign out everywhere[\s\S]*Remove faculty account/);
    await p.context().close();
  });

  /* ================= NEUTRAL / CONTROL POLICY (migration 0038) ================= */
  await check('conditions: Register offers Assigned, Free choice and Control only (Neutral is a persona, not a condition)', async () => {
    const p = await open('students'); await waitStudents(p);
    const vals = await p.locator('#modal-register-student input[name="rs-condition"]').evaluateAll(els => els.map(e => e.value));
    assert.deepEqual(vals, ['assigned', 'non-assigned', 'control']);
    assert.equal(/Neutral/i.test((await p.locator('#modal-register-student label.choice').allInnerTexts()).join(' ')), false, 'no Neutral condition');
    assert.equal(await p.locator('#rs-tutor option[value="pia-neutral"]').count(), 1, 'PIA Neutral is a tutor choice');
    await p.context().close();
  });
  await check('conditions: a legacy Neutral student keeps the value on an unrelated edit; nobody else is offered it', async () => {
    const p = await open('students'); await waitStudents(p);
    /* student02 is group_type "neutral" in the fixture (i % 4 === 2). */
    await p.locator('#student-tbody tr[data-student="student02@example.test"]').focus(); await p.keyboard.press('Enter');
    await p.waitForSelector('#drawer-student.is-open');
    assert.match(await p.locator('#student-tbody tr[data-student="student02@example.test"]').innerText(), /Neutral \(legacy\)/);
    await p.locator('[data-student-action="edit"]').click();
    await p.waitForSelector('#modal-edit-student.is-open');
    assert.equal(await p.locator('#es-neutral-choice').isVisible(), true);
    assert.equal(await p.locator('input[name="es-condition"][value="neutral"]').isChecked(), true);
    assert.match(await p.locator('#es-neutral-choice').innerText(), /legacy, unchanged/i);
    await p.locator('#es-first').fill('Renamed');
    await p.evaluate(() => { window.fixture.calls.length = 0; });
    await p.locator('#es-submit').click();
    await p.waitForFunction(() => window.fixture.calls.some(c => c.table === 'profiles' && c.write === 'update'));
    const upd = (await calls(p)).find(c => c.table === 'profiles' && c.write === 'update');
    assert.equal(Object.prototype.hasOwnProperty.call(upd.values, 'group_type'), false, 'group_type is not re-sent: ' + JSON.stringify(upd.values));
    assert.equal(upd.values.full_name.startsWith('Renamed'), true);
    await p.context().close();
    const q = await open('students'); await waitStudents(q);
    await q.locator('#student-tbody tr[data-student="student01@example.test"]').focus(); await q.keyboard.press('Enter');
    await q.waitForSelector('#drawer-student.is-open');
    await q.locator('[data-student-action="edit"]').click();
    await q.waitForSelector('#modal-edit-student.is-open');
    assert.equal(await q.locator('#es-neutral-choice').isVisible(), false, 'Neutral is not offered for a non-neutral student');
    const vis = await q.locator('#modal-edit-student input[name="es-condition"]').evaluateAll(els => els.filter(e => e.getClientRects().length).map(e => e.value));
    assert.deepEqual(vis, ['assigned', 'non-assigned', 'control']);
    await q.context().close();
  });
  await check('conditions: Control policy row says OCEAN only and Neutral is explained as a persona', async () => {
    const p = await open('controls');
    await p.waitForSelector('#policy-tbody tr');
    const ctl = await p.locator('#policy-tbody tr').first().locator('td').allInnerTexts();
    assert.deepEqual(ctl.map(t => t.trim()), ['Available', 'Locked', 'Locked']);
    await p.context().close();
  });

  /* ================= TUTOR ASSIGNMENT FOR ASSIGNED STUDENTS ================= */
  const TUTOR_KEYS = ['', 'pia-open', 'pia-conscientious', 'pia-extravert', 'pia-agreeable', 'pia-calm', 'pia-neutral'];
  async function openEdit(p, email) {
    await p.locator(`#student-tbody tr[data-student="${email}"]`).focus(); await p.keyboard.press('Enter');
    await p.waitForSelector('#drawer-student.is-open');
    await p.locator('[data-student-action="edit"]').click();
    await p.waitForSelector('#modal-edit-student.is-open');
  }
  const lastUpdate = async p => (await calls(p)).filter(c => c.table === 'profiles' && c.write === 'update').pop();
  await check('tutor: Register offers the tutor choice only for Assigned, including PIA Neutral; nothing is auto-assigned', async () => {
    const p = await open('students'); await waitStudents(p);
    await p.locator('#view-students [data-modal-open="modal-register-student"]').click();
    await p.waitForSelector('#modal-register-student.is-open');
    assert.equal(await p.locator('#rs-tutor-field').isVisible(), true, 'Assigned is the default condition');
    const opts = await p.locator('#rs-tutor option').evaluateAll(o => o.map(x => [x.value, x.textContent]));
    assert.deepEqual(opts.map(o => o[0]), TUTOR_KEYS);
    assert.deepEqual(opts.find(o => o[0] === 'pia-neutral'), ['pia-neutral', 'PIA Neutral']);
    assert.equal(await p.locator('#rs-tutor').inputValue(), '', 'defaults to Not assigned yet');
    await p.locator('input[name="rs-condition"][value="non-assigned"]').evaluate(e => e.click());
    assert.equal(await p.locator('#rs-tutor-field').isVisible(), false);
    await p.locator('input[name="rs-condition"][value="control"]').evaluate(e => e.click());
    assert.equal(await p.locator('#rs-tutor-field').isVisible(), false);
    await p.locator('input[name="rs-condition"][value="assigned"]').evaluate(e => e.click());
    assert.equal(await p.locator('#rs-tutor-field').isVisible(), true);
    await p.context().close();
  });
  await check('tutor: registering an Assigned student stores group_type and selected_character as separate fields', async () => {
    for (const [tutor, expectKey] of [['pia-neutral', true], ['', false]]) {
      const p = await open('students'); await waitStudents(p);
      await p.locator('#view-students [data-modal-open="modal-register-student"]').click();
      await p.waitForSelector('#modal-register-student.is-open');
      await p.locator('#rs-first').fill('Tess'); await p.locator('#rs-last').fill('Tutor');
      await p.locator('#rs-email').fill(`tess${expectKey ? 1 : 2}@example.test`);
      await p.locator('#rs-consent').evaluate(e => e.click()); await p.locator('#rs-assent').evaluate(e => e.click());
      if (tutor) await p.locator('#rs-tutor').selectOption(tutor);
      await p.evaluate(() => { window.fixture.calls.length = 0; });
      await p.locator('#rs-submit').click();
      await p.waitForFunction(() => window.fixture.calls.some(c => c.table === 'profiles' && c.write === 'insert'));
      const ins = (await calls(p)).find(c => c.table === 'profiles' && c.write === 'insert').values[0];
      assert.equal(ins.group_type, 'assigned');
      assert.equal(Object.prototype.hasOwnProperty.call(ins, 'selected_character'), expectKey, JSON.stringify(ins));
      if (expectKey) assert.equal(ins.selected_character, 'pia-neutral');
      await p.context().close();
    }
  });
  await check('tutor: Edit assigns PIA Neutral to an Assigned student; research group and tutor are separate fields', async () => {
    const p = await open('students'); await waitStudents(p);
    await openEdit(p, 'student04@example.test');            // fixture group "assigned", no tutor yet
    assert.equal(await p.locator('#es-tutor-field').isVisible(), true);
    assert.equal(await p.locator('#es-tutor').inputValue(), '');
    assert.equal(await p.locator('input[name="es-condition"][value="assigned"]').isChecked(), true);
    await p.locator('#es-tutor').selectOption('pia-neutral');
    await p.locator('#es-tutor').scrollIntoViewIfNeeded();
    await shot(p, 'edit-tutor-dark-1280');
    await p.evaluate(() => { window.fixture.calls.length = 0; });
    await p.locator('#es-submit').click();
    await p.waitForFunction(() => window.fixture.calls.some(c => c.table === 'profiles' && c.write === 'update'));
    const u = await lastUpdate(p);
    assert.equal(u.values.selected_character, 'pia-neutral');
    assert.equal(u.values.group_type, 'assigned');
    await p.context().close();
  });
  await check('tutor: an unrelated edit never sends or changes the tutor; "Not assigned yet" clears only when chosen', async () => {
    const d = makeData(); d.profiles.find(r => r.email === 'student04@example.test').selected_character = 'pia-calm';
    const p = await open('students', { data: d }); await waitStudents(p);
    await openEdit(p, 'student04@example.test');
    assert.equal(await p.locator('#es-tutor').inputValue(), 'pia-calm');
    await p.locator('#es-first').fill('Renamed');
    await p.evaluate(() => { window.fixture.calls.length = 0; });
    await p.locator('#es-submit').click();
    await p.waitForFunction(() => window.fixture.calls.some(c => c.table === 'profiles' && c.write === 'update'));
    assert.equal(Object.prototype.hasOwnProperty.call((await lastUpdate(p)).values, 'selected_character'), false);
    await p.context().close();
    const q = await open('students', { data: d }); await waitStudents(q);
    await openEdit(q, 'student04@example.test');
    await q.locator('#es-tutor').selectOption('');
    await q.evaluate(() => { window.fixture.calls.length = 0; });
    await q.locator('#es-submit').click();
    await q.waitForFunction(() => window.fixture.calls.some(c => c.table === 'profiles' && c.write === 'update'));
    assert.equal((await lastUpdate(q)).values.selected_character, null);
    await q.context().close();
  });
  await check('tutor: changing the group never clears or rewrites the tutor; non-Assigned students are shown it read-only', async () => {
    const d = makeData(); d.profiles.find(r => r.email === 'student04@example.test').selected_character = 'pia-neutral';
    const p = await open('students', { data: d }); await waitStudents(p);
    await openEdit(p, 'student04@example.test');
    await p.locator('input[name="es-condition"][value="non-assigned"]').evaluate(e => e.click());
    assert.equal(await p.locator('#es-tutor-field').isVisible(), true, 'a held tutor stays visible');
    assert.equal(await p.locator('#es-tutor').isDisabled(), true);
    assert.match(await p.locator('#es-tutor-hint').innerText(), /changing the group does not clear/i);
    await p.evaluate(() => { window.fixture.calls.length = 0; });
    await p.locator('#es-submit').click();
    await p.waitForFunction(() => window.fixture.calls.some(c => c.table === 'profiles' && c.write === 'update'));
    const u = await lastUpdate(p);
    assert.equal(u.values.group_type, 'non-assigned');
    assert.equal(Object.prototype.hasOwnProperty.call(u.values, 'selected_character'), false);
    await p.context().close();
    const q = await open('students'); await waitStudents(q);
    await openEdit(q, 'student05@example.test');           // free choice, no tutor held
    assert.equal(await q.locator('#es-tutor-field').isVisible(), false);
    await q.context().close();
  });
  await check('tutor: a failed save says so on the field and in a toast, keeps the dialog open, and writes nothing else', async () => {
    const p = await open('students'); await waitStudents(p);
    await openEdit(p, 'student04@example.test');
    await p.locator('#es-tutor').selectOption('pia-neutral');
    await p.evaluate(() => { window.fixture.failWrite = { profiles: { code: '42501', message: 'permission denied for table profiles' } }; });
    await p.locator('#es-submit').click();
    await p.waitForFunction(() => /not saved/i.test(document.querySelector('[data-msg-for="es-tutor"]').textContent));
    assert.equal(await p.locator('#modal-edit-student.is-open').count(), 1, 'dialog stays open');
    assert.match(await p.locator('[data-msg-for="es-tutor"]').innerText(), /The tutor was not saved/);
    assert.equal(await p.locator('#es-submit').isEnabled(), true, 'can retry');
    await p.evaluate(() => { window.fixture.failWrite = {}; window.fixture.calls.length = 0; });
    await p.locator('#es-submit').click();
    await p.waitForFunction(() => !document.querySelector('#modal-edit-student.is-open'));
    assert.equal((await lastUpdate(p)).values.selected_character, 'pia-neutral');
    await p.context().close();
  });
  await check('tutor: a tampered tutor value is refused before any write', async () => {
    const p = await open('students'); await waitStudents(p);
    await openEdit(p, 'student04@example.test');
    await p.evaluate(() => { const o = document.createElement('option'); o.value = 'pia-evil'; o.textContent = 'x'; document.querySelector('#es-tutor').appendChild(o); document.querySelector('#es-tutor').value = 'pia-evil'; window.fixture.calls.length = 0; });
    await p.locator('#es-submit').click();
    await p.waitForFunction(() => /listed tutors/i.test(document.querySelector('[data-msg-for="es-tutor"]').textContent));
    assert.equal((await calls(p)).filter(c => c.write === 'update').length, 0);
    await p.context().close();
  });
  await check('tutor: the profile shows the tutor and hides re-selection except for Free choice students', async () => {
    const d = makeData(); d.profiles.find(r => r.email === 'student04@example.test').selected_character = 'pia-neutral';
    const p = await open('students', { data: d }); await waitStudents(p);
    const show = async email => { await p.locator(`#student-tbody tr[data-student="${email}"]`).focus(); await p.keyboard.press('Enter'); await p.waitForSelector('#drawer-student.is-open'); };
    await show('student04@example.test');
    assert.equal((await p.locator('#drawer-tutor').innerText()).trim(), 'PIA Neutral');
    assert.equal(await p.locator('[data-student-action="retake-character"]').isVisible(), false);
    await p.keyboard.press('Escape'); await p.waitForFunction(() => !document.querySelector('#drawer-student.is-open'));
    await show('student01@example.test');                       // fixture group "non-assigned"
    assert.equal((await p.locator('#drawer-tutor').innerText()).trim(), 'Not chosen yet');
    assert.equal(await p.locator('[data-student-action="retake-character"]').isVisible(), true);
    await p.keyboard.press('Escape'); await p.waitForFunction(() => !document.querySelector('#drawer-student.is-open'));
    await show('student08@example.test');                       // fixture group "assigned", no tutor
    assert.equal((await p.locator('#drawer-tutor').innerText()).trim(), 'Not assigned yet');
    await p.context().close();
  });

  /* ================= STAGE CONTROLS ================= */
  await check('stage controls: three stages with real ids, group availability table from the server rule, no bypass', async () => {
    const p = await open('controls');
    await p.waitForSelector('#gates-grid .gate');
    assert.equal(await p.locator('#gates-grid .gate').count(), 3);
    assert.deepEqual(await p.locator('#gates-grid .gate-title').allInnerTexts(), ['OCEAN personality test', 'Character selection', 'Tutoring dashboard']);
    const rows = await p.locator('#policy-tbody tr').evaluateAll(trs => trs.map(tr => [...tr.children].map(c => c.innerText.trim())));
    assert.deepEqual(rows, [
      ['Control', 'Available', 'Locked', 'Locked'],
      ['Experimental · Assigned', 'Available', 'Locked', 'Available'],
      ['Experimental · Free choice', 'Available', 'Available', 'Available after choosing a tutor'],
      ['Neutral (legacy records)', 'Available', 'Locked', 'Available']]);
    assert.match(await p.locator('#policy-foot').innerText(), /cannot change which stages a group can enter/);
    assert.match(await p.locator('#policy-foot').innerText(), /Neutral is a tutor persona, not a group/);
    assert.equal(await p.locator('#policy-tbody th').first().evaluate(e => getComputedStyle(e).textAlign), 'left');
    assert.equal(await p.locator('#view-controls').evaluate(el => /Manage gates|Open or close/.test(el.innerText)), true);   // renamed section copy only
    await shot(p, 'controls-dark-1280');
    await p.context().close();
  });
  await check('stage controls: granting a stage calls the existing per-section RPC and nothing else', async () => {
    const p = await open('controls');
    await p.waitForSelector('#gates-grid .gate-section');
    await p.locator('label.gate-section:has(input[data-gate-section="ocean"][value="Earth"])').click();
    await p.locator('[data-gate-grant="ocean"]').click();            // the existing flow has no confirm step
    await p.waitForFunction(() => window.fixture.calls.some(c => c.name === 'admin_grant_stage'));
    const grant = (await calls(p)).filter(c => c.name === 'admin_grant_stage');
    assert.deepEqual(grant.map(c => c.args), [{ p_stage: 'ocean', p_emails: null, p_section: 'Earth' }]);
    await p.context().close();
  });

  /* ================= USER AREA, PROFILE, SETTINGS, SIGN OUT ================= */
  await check('user area: anchored bottom, 32px avatar, name/email, menu opens above in order Profile/Settings/Sign Out', async () => {
    const p = await open('overview');
    const trig = await p.locator('#user-menu-btn').boundingBox(), side = await p.locator('#sidebar').boundingBox();
    assert.ok(Math.abs((trig.y + trig.height) - (side.y + side.height)) <= 2, 'trigger sits at the bottom of the sidebar');
    assert.ok(Math.abs(trig.width - side.width) <= 2, 'full sidebar width');
    const av = await p.locator('#admin-initials').boundingBox();
    assert.equal(Math.round(av.width), 32); assert.equal(Math.round(av.height), 32);
    assert.equal(await p.locator('#admin-name').innerText(), 'Ada Admin');
    assert.equal(await p.locator('#admin-email').innerText(), 'admin@example.test');
    assert.equal(await p.locator('#user-menu-btn').evaluate(e => getComputedStyle(e.parentElement).borderTopWidth), '1px');
    await p.locator('#user-menu-btn').click();
    assert.equal(await p.locator('#user-menu-btn').getAttribute('aria-expanded'), 'true');
    const menu = await p.locator('#user-menu').boundingBox();
    assert.ok(menu.y + menu.height <= trig.y + 1, 'menu opens above the trigger');
    assert.ok(menu.x >= 0 && menu.y >= 0 && menu.x + menu.width <= p.viewportSize().width, 'contained in the viewport');
    assert.deepEqual(await p.locator('#user-menu .user-menu-item').allInnerTexts(), ['Profile', 'Settings', 'Sign Out']);
    const r = await p.locator('#user-menu').evaluate(e => { const c = getComputedStyle(e); return [parseFloat(c.borderTopLeftRadius), c.borderTopWidth]; });
    assert.ok(r[0] >= 4 && r[0] <= 6); assert.equal(r[1], '1px');
    await shot(p, 'usermenu-dark-1280');
    await p.context().close();
  });
  await check('user menu: keyboard (arrows, Escape returns focus), outside click closes, Profile and Settings navigate', async () => {
    const p = await open('overview');
    await p.locator('#user-menu-btn').focus();
    await p.keyboard.press('ArrowUp');
    assert.equal(await p.evaluate(() => document.activeElement.dataset.userAction), 'profile');
    await p.keyboard.press('ArrowDown');
    assert.equal(await p.evaluate(() => document.activeElement.dataset.userAction), 'settings');
    await p.keyboard.press('Escape');
    assert.equal(await p.locator('#user-menu').isVisible(), false);
    assert.equal(await p.evaluate(() => document.activeElement.id), 'user-menu-btn');
    await p.locator('#user-menu-btn').click(); await p.mouse.click(700, 400);
    assert.equal(await p.locator('#user-menu').isVisible(), false);
    await p.locator('#user-menu-btn').click(); await p.locator('[data-user-action="profile"]').click();
    await p.waitForSelector('#view-profile:not(.is-hidden)');
    await p.locator('#user-menu-btn').click(); await p.locator('[data-user-action="settings"]').click();
    await p.waitForSelector('#view-settings:not(.is-hidden)');
    await p.context().close();
  });
  await check('profile: single centred column ≤800px, actual name/email, Change password modal flow, honest results', async () => {
    const p = await open('profile');
    await p.waitForSelector('#admin-device-list .device-row');
    const panels = await p.locator('#view-profile .panel').evaluateAll(els => els.map(e => { const b = e.getBoundingClientRect(); return { x: Math.round(b.x), w: Math.round(b.width) }; }));
    assert.equal(panels.length, 3);
    assert.ok(panels.every(x => x.x === panels[0].x && x.w === panels[0].w), 'stacked, same column ' + JSON.stringify(panels));
    assert.ok(panels[0].w <= 800);
    assert.equal(await p.locator('#profile-name').innerText(), 'Ada Admin');
    assert.equal(await p.locator('#profile-email').innerText(), 'admin@example.test');
    await p.locator('[data-modal-open="modal-change-password"]').click();
    await p.waitForSelector('#modal-change-password.is-open');
    assert.deepEqual(await p.locator('#modal-change-password label.label').allInnerTexts(), ['Current password', 'New password', 'Confirm password']);
    assert.deepEqual(await p.locator('#modal-change-password .modal-foot button').allInnerTexts(), ['Cancel', 'Update']);
    assert.equal(await p.locator('#modal-change-password .modal-close').count(), 0);
    await p.fill('#cp-current', 'right-password1'); await p.fill('#cp-new', 'newpass123'); await p.fill('#cp-confirm', 'different123');
    await p.click('#cp-submit');
    assert.match(await p.locator('[data-msg-for="cp-confirm"]').innerText(), /do not match/);
    assert.equal((await calls(p)).some(c => c.method === 'probeSignIn'), false);
    await p.fill('#cp-current', 'wrong-password'); await p.fill('#cp-confirm', 'newpass123'); await p.click('#cp-submit');
    await p.waitForFunction(() => /not your current password/.test(document.querySelector('[data-msg-for="cp-current"]').textContent));
    assert.equal((await calls(p)).some(c => c.method === 'updateUser'), false);
    await shot(p, 'change-password-dark-1280');
    await p.fill('#cp-current', 'right-password1'); await p.click('#cp-submit');
    await p.waitForFunction(() => !document.querySelector('#modal-change-password.is-open'));
    const c = await calls(p);
    assert.ok(c.some(x => x.method === 'updateUser' && x.keys[0] === 'password'));
    assert.ok(c.some(x => x.method === 'signOut' && x.args && x.args.scope === 'others'));
    assert.equal(await p.inputValue('#cp-new'), '');
    await p.context().close();
  });
  await check('profile: Cancel is the only dismissal; Escape closes; fields wiped; focus returns to the button', async () => {
    const p = await open('profile');
    const btn = p.locator('[data-modal-open="modal-change-password"]');
    await btn.focus(); await p.keyboard.press('Enter');
    await p.waitForSelector('#modal-change-password.is-open');
    assert.equal(await p.evaluate(() => document.activeElement.id), 'cp-current');
    await p.fill('#cp-new', 'secret-value-1');
    await p.keyboard.press('Escape');
    await p.waitForFunction(() => !document.querySelector('#modal-change-password.is-open'));
    assert.equal(await p.inputValue('#cp-new'), '');
    await focusIs(p, el => el.getAttribute('data-modal-open') === 'modal-change-password');
    await p.context().close();
  });
  await check('profile: active sessions show readable device names, one "This device", no secondary identifiers', async () => {
    const p = await open('profile');
    await p.waitForSelector('#admin-device-list .device-row');
    const rows = await p.locator('#admin-device-list .device-row').evaluateAll(els => els.map(e => ({ text: e.innerText.replace(/\s+/g, ' ').trim(), id: e.dataset.device, hasButton: !!e.querySelector('button'), badge: !!e.querySelector('.badge') })));
    assert.ok(rows.length >= 2);
    for (const r of rows) { assert.equal(/\[|dev-self|other-dev|abc/.test(r.text), false, r.text); assert.ok(r.id, 'internal id retained'); }
    assert.equal(rows.filter(r => r.badge).length, 1);
    assert.match(rows.find(r => r.badge).text, /macOS computer.*This device|This device/);
    assert.equal(rows.filter(r => r.hasButton).length, rows.length - 1);
    const align = await p.locator('#admin-device-list .device-row').first().evaluate(row => { const k = [...row.children].map(c => c.getBoundingClientRect()); return Math.max(...k.map(b => b.top + b.height / 2)) - Math.min(...k.map(b => b.top + b.height / 2)); });
    assert.ok(align < 12, 'icon, name and badge share a row ' + align);
    await shot(p, 'profile-dark-1280');
    await p.context().close();
  });
  await check('settings: exactly two columns, outline "+ Add administrator" top-right, removals absent', async () => {
    const p = await open('settings');
    await p.waitForSelector('#admin-tbody tr');
    const heads = (await p.locator('#view-settings thead th').allInnerTexts()).map(t => t.toLowerCase());
    assert.deepEqual(heads, ['admin name', 'status']);
    const statuses = await p.locator('#admin-tbody tr').evaluateAll(trs => trs.map(tr => tr.children[1].innerText.trim()));
    assert.deepEqual(statuses.sort(), ['Awaiting activation', 'Signed in', 'Signed in']);
    const text = await p.locator('#view-settings').innerText();
    for (const banned of ['Devices', 'Actions', 'Security log', 'one-time', 'Active', 'Idle']) assert.equal(text.includes(banned), false, banned);
    const add = p.locator('#view-settings .page-actions .btn');
    assert.equal(await add.innerText(), '+ Add administrator');
    assert.ok((await add.getAttribute('class')).includes('btn-outline'));
    const ab = await add.boundingBox(), vp = p.viewportSize(); assert.ok(ab.x + ab.width > vp.width - 60 && ab.y < 140);
    await shot(p, 'settings-dark-1280');
    await p.context().close();
  });
  await check('settings: Add administrator opens the existing creation dialog (Cancel only); no account is simulated', async () => {
    const p = await open('settings');
    await p.locator('#view-settings .page-actions .btn').click();
    await p.waitForSelector('#modal-add-admin.is-open');
    assert.equal(await p.locator('#modal-add-admin .modal-close').count(), 0);
    assert.equal(await p.locator('#modal-add-admin [data-modal-close]').innerText(), 'Cancel');
    await p.fill('#aa-name', 'New Admin'); await p.fill('#aa-email', 'new.admin@example.test');
    await p.click('#aa-submit');
    await p.waitForSelector('#modal-confirm.is-open');
    await p.locator('#confirm-accept').click();
    await p.waitForFunction(() => window.fixture.calls.some(c => c.name === 'admin_create_auth_user'));
    const c = (await calls(p)).find(x => x.name === 'admin_create_auth_user');
    assert.equal(c.args.target_email, 'new.admin@example.test');
    await p.context().close();
  });
  await check('sign out: immediate (no confirmation), global server sign-out, then redirect', async () => {
    const p = await open('overview');
    await p.locator('#user-menu-btn').click();
    await p.locator('#user-signout').click();
    assert.equal(await p.locator('#modal-confirm.is-open').count(), 0, 'no confirmation dialog');
    await p.waitForURL(u => /\/index\.html$/.test(u.pathname));
    await p.context().close();
  });
  await check('sign out: a refused server sign-out is reported, the session stays, and Sign Out can be retried', async () => {
    const p = await open('overview', { initial: { signoutError: true } });
    await p.locator('#user-menu-btn').click();
    await p.locator('#user-signout').click();
    await p.waitForFunction(() => /Sign-out failed/.test(document.querySelector('#signout-status').textContent));
    assert.equal(new URL(p.url()).pathname, ADMIN);
    assert.match(await p.locator('#global-error-message').innerText(), /still signed in/);
    assert.equal(await p.locator('#user-signout').isDisabled(), false);
    const c = await calls(p);
    assert.ok(c.some(x => x.method === 'signOut' && x.args.scope === 'global'));
    await p.evaluate(() => { window.fixture.signoutError = false; });
    await p.locator('#user-signout').click();
    await p.waitForURL(u => /\/index\.html$/.test(u.pathname));
    await p.context().close();
  });

  /* ================= COMMAND PALETTE ================= */
  await check('palette: Ctrl+K opens, placeholder exact, autofocus, suggestions, footer keycaps, Escape restores focus', async () => {
    const p = await open('overview');
    await p.locator('#palette-open').focus();
    await p.keyboard.press('Control+k');
    await p.waitForSelector('#palette.is-open');
    assert.equal(await p.getAttribute('#palette-input', 'placeholder'), 'Search students, sections, or commands...');
    assert.equal(await p.evaluate(() => document.activeElement.id), 'palette-input');
    assert.equal(await p.locator('#palette-input').evaluate(e => getComputedStyle(e).outlineStyle), 'none');
    assert.deepEqual(await p.locator('#palette-list .palette-option').allInnerTexts(), ['Register student', 'New section', 'Go to Settings']);
    assert.deepEqual((await p.locator('.palette-foot span').allInnerTexts()).map(t => t.replace(/\s+/g, ' ').trim()), ['↑↓ navigate', 'Enter select', 'Esc close']);
    const bg = await p.locator('.palette').evaluate(e => { const c = getComputedStyle(e); return { bg: c.backgroundColor, r: parseFloat(c.borderTopLeftRadius), bw: c.borderTopWidth, align: getComputedStyle(e).textAlign }; });
    assert.notEqual(bg.bg, 'rgba(0, 0, 0, 0)'); assert.ok(bg.r >= 4 && bg.r <= 6); assert.equal(bg.bw, '1px'); assert.equal(bg.align, 'left');
    const ov = await p.locator('#palette').evaluate(e => getComputedStyle(e).backdropFilter);
    assert.match(ov, /blur/);
    await shot(p, 'palette-empty-dark-1280');
    await p.keyboard.press('Escape');
    await p.waitForFunction(() => !document.querySelector('#palette.is-open'));
    assert.equal(await p.evaluate(() => document.activeElement.id), 'palette-open');
    await p.keyboard.press('Meta+k');
    await p.waitForSelector('#palette.is-open');
    await p.context().close();
  });
  await check('palette: keyboard navigation, active option exposed, Enter runs the verified destination/action', async () => {
    const p = await open('overview');
    await p.locator('#palette-open').click();
    const input = p.locator('#palette-input');
    assert.equal(await input.getAttribute('aria-activedescendant'), 'po-0');
    await p.keyboard.press('ArrowDown'); await p.keyboard.press('ArrowDown');
    assert.equal(await input.getAttribute('aria-activedescendant'), 'po-2');
    assert.equal(await p.locator('#po-2').getAttribute('aria-selected'), 'true');
    await p.keyboard.press('ArrowDown');
    assert.equal(await input.getAttribute('aria-activedescendant'), 'po-0');
    await p.keyboard.press('ArrowUp');
    assert.equal(await input.getAttribute('aria-activedescendant'), 'po-2');
    await p.keyboard.press('Enter');
    await p.waitForSelector('#view-settings:not(.is-hidden)');
    assert.equal(await p.locator('#palette.is-open').count(), 0);
    await p.locator('#palette-open').click();
    await p.keyboard.press('Enter');                       // Register student
    await p.waitForSelector('#modal-register-student.is-open');
    await p.keyboard.press('Escape');
    await p.waitForFunction(() => !document.querySelector('#modal-register-student.is-open'));
    await focusIs(p, el => el.id === 'palette-open');
    await p.context().close();
  });
  await check('palette: groups (Students, Class Sections, Modules, Commands), no removed features, no-results message', async () => {
    const p = await open('overview');
    await p.locator('#palette-open').click();
    await p.fill('#palette-input', 'stu');
    await p.waitForFunction(() => document.querySelectorAll('#palette-list .palette-group').length >= 3);
    const groups = await p.locator('.palette-group-title').evaluateAll(els => els.map(e => e.textContent));
    assert.ok(groups.includes('Students') && groups.includes('Modules') && groups.includes('Commands'), groups.join());
    assert.equal(await p.locator('#palette-list .palette-option').count() > 3, true);
    await p.fill('#palette-input', 'ear');
    await p.waitForFunction(() => /Class Sections/i.test(document.querySelector('#palette-list').textContent));
    assert.match(await p.locator('#palette-list .palette-group:has(.palette-group-title:text("Class Sections"))').innerText(), /Earth/);
    for (const term of ['export', 'security', 'device', 'csv']) {
      await p.fill('#palette-input', term);
      await p.waitForTimeout(450);
      assert.match(await p.locator('#palette-list').innerText(), /No results/, term);
    }
    await p.fill('#palette-input', 'zzzzqqq');
    await p.waitForFunction(() => /No results for “zzzzqqq”/.test(document.querySelector('#palette-list').innerText));
    assert.match(await p.locator('#palette-status').innerText(), /No results/);
    await shot(p, 'palette-noresults-dark-1280');
    await p.context().close();
  });
  await check('palette: student search is remote, stale responses are dropped, selection opens the profile', async () => {
    const p = await open('overview');
    await p.locator('#palette-open').click();
    /* Slow answer for the first term, fast for the second: the late one must not win. */
    await p.evaluate(() => { window.fixture.delay.profiles = 900; });
    await p.fill('#palette-input', 'student 0');
    await p.waitForTimeout(260);
    await p.evaluate(() => { window.fixture.delay.profiles = 0; });
    await p.fill('#palette-input', 'student 07');
    await p.waitForFunction(() => /student07@example\.test/.test(document.querySelector('#palette-list').innerText));
    await p.waitForTimeout(1000);
    const names = await p.locator('#palette-list .palette-group:has(.palette-group-title:text("Students")) .palette-label').allInnerTexts();
    assert.deepEqual(names, ['Student 07']);
    assert.equal((await calls(p)).filter(c => c.method === 'from' && c.table === 'profiles' && /full_name, email, section/.test(c.cols || '')).length >= 2, true);
    await p.keyboard.press('Enter');
    await p.waitForSelector('#drawer-student.is-open');
    assert.equal(await p.locator('#drawer-student-name').innerText(), 'Student 07');
    await p.context().close();
  });
  await check('palette: a failing student search says so (not "no results") and sections still work', async () => {
    const p = await open('overview');
    await p.locator('#palette-open').click();
    await p.evaluate(() => { window.fixture.fail = { profiles: { code: 'XX000', message: 'down' } }; });
    await p.fill('#palette-input', 'earth');
    await p.waitForFunction(() => /could not be searched/.test(document.querySelector('#palette-list').innerText));
    assert.match(await p.locator('#palette-list').innerText(), /Earth/);
    await p.context().close();
  });

  /* ================= MODALS ================= */
  await check('modals: exactly one visible dismissal, Cancel before primary, Escape closes, focus returns, Tab stays inside', async () => {
    const p = await open('students'); await waitStudents(p);
    const cases = [
      ['modal-register-student', '#view-students [data-modal-open="modal-register-student"]'],
      ['modal-new-section', null, 'sections'], ['modal-add-professor', null, 'faculty'], ['modal-add-admin', null, 'settings']];
    for (const [id, sel, route] of cases) {
      if (route) { await p.evaluate(r => { location.hash = '#' + r; }, route); await p.waitForFunction(r => document.querySelector(`#view-${r}:not(.is-hidden)`), route); }
      const trigger = sel ? p.locator(sel) : p.locator(`#view-${route} [data-modal-open="${id}"]`);
      await trigger.focus(); await p.keyboard.press('Enter');
      await p.waitForSelector(`#${id}.is-open`);
      const dis = await p.locator(`#${id} .modal-close:visible, #${id} [data-modal-close]:visible`).count();
      assert.equal(dis, 1, id + ' dismissal count');
      const foot = await p.locator(`#${id} .modal-foot button`).allInnerTexts();
      assert.equal(foot[0], 'Cancel', id + ' footer order: ' + foot.join('|'));
      const align = await p.locator(`#${id} .modal-foot`).evaluate(e => getComputedStyle(e).justifyContent);
      assert.match(align, /flex-end|end/);
      for (let i = 0; i < 14; i++) { await p.keyboard.press('Tab'); assert.equal(await p.evaluate(m => !!document.activeElement.closest('#' + m), id), true, id + ' focus escaped'); }
      const title = await p.locator(`#${id} .modal-title`).evaluate(e => getComputedStyle(e).textAlign);
      assert.match(title, /start|left/);
      await p.keyboard.press('Escape');
      await p.waitForFunction(m => !document.querySelector('#' + m + '.is-open'), id);
      await focusIs(p, (el, want) => el.getAttribute('data-modal-open') === want, id);
    }
    await p.context().close();
  });
  await check('modals: long content scrolls inside the dialog and stays within the viewport at 320x480', async () => {
    const p = await open('students', { width: 320, height: 480 }); await waitStudents(p);
    await p.locator('#view-students [data-modal-open="modal-register-student"]').click();
    await p.waitForSelector('#modal-register-student.is-open');
    const box = await p.locator('#modal-register-student .modal').boundingBox();
    assert.ok(box.height <= 480 && box.width <= 320, JSON.stringify(box));
    assert.equal(await p.locator('#modal-register-student .modal-foot').isVisible(), true);
    assert.equal(await overflow(p), true);
    await shot(p, 'modal-register-320x480');
    await p.context().close();
  });

  /* ================= RESPONSIVE ================= */
  for (const [w, t] of [[320, 'dark'], [375, 'light'], [768, 'dark'], [1280, 'light'], [1440, 'dark']]) {
    await check(`responsive ${w}px ${t}: no page overflow on any view; theme and search stay reachable`, async () => {
      const p = await open('overview', { width: w, theme: t });
      for (const route of ['overview', 'live', 'sections', 'students', 'faculty', 'controls', 'mathtask', 'profile', 'settings']) {
        await p.evaluate(r => { location.hash = '#' + r; }, route);
        await p.waitForFunction(r => document.querySelector(`#view-${r}:not(.is-hidden)`), route);
        await p.waitForTimeout(120);
        assert.equal(await overflow(p), true, route + ' overflows at ' + w);
      }
      for (const id of ['#palette-open', '#theme-toggle']) { const b = await p.locator(id).boundingBox(); assert.ok(b && b.x >= 0 && b.x + b.width <= w, id + JSON.stringify(b)); if (w <= 900) assert.ok(b.width >= 44 && b.height >= 44, id + ' touch size'); }
      await p.evaluate(() => { location.hash = '#students'; }); await waitStudents(p);
      await shot(p, `students-${w}-${t}`);
      await p.context().close();
    });
  }
  await check('responsive 375: sidebar is a drawer (hidden from keyboard), opens with the toggle, keeps every item and the user menu', async () => {
    const p = await open('students', { width: 375 }); await waitStudents(p);
    assert.equal(await p.locator('#sidebar').evaluate(e => getComputedStyle(e).visibility), 'hidden');
    assert.equal(await p.locator('#mobile-nav-toggle').isVisible(), true);
    await p.locator('#mobile-nav-toggle').click();
    assert.equal(await p.locator('#mobile-nav-toggle').getAttribute('aria-expanded'), 'true');
    assert.equal(await p.locator('#sidebar').evaluate(e => getComputedStyle(e).visibility), 'visible');
    await p.waitForTimeout(250);
    assert.deepEqual((await nav(p)).slice(0, 3), ['Overview', 'Live Sessions', 'People']);
    assert.equal(await p.locator('#user-menu-btn').isVisible(), true);
    const ub = await p.locator('#user-menu-btn').boundingBox(); assert.ok(ub.y + ub.height <= 900 && ub.x >= 0);
    await p.locator('#user-menu-btn').click();
    assert.equal(await p.locator('#user-menu').isVisible(), true);
    await shot(p, 'mobile-nav-375');
    await p.keyboard.press('Escape');                                  // closes the menu first
    await p.keyboard.press('Escape');                                  // then the drawer
    await p.waitForFunction(() => !document.querySelector('#app.nav-open'));
    assert.equal(await p.evaluate(() => document.activeElement.id), 'mobile-nav-toggle');
    await p.locator('#mobile-nav-toggle').click();
    await p.locator('.nav-item[data-view="live"]').click();
    await p.waitForFunction(() => !document.querySelector('#app.nav-open') && document.querySelector('#view-live:not(.is-hidden)'));
    await p.context().close();
  });
  await check('responsive 375: wide tables scroll inside their own container, pager stays reachable', async () => {
    const p = await open('students', { width: 375 }); await waitStudents(p);
    const wrap = await p.locator('#view-students .table-wrap').evaluate(e => ({ sw: e.scrollWidth, cw: e.clientWidth, ox: getComputedStyle(e).overflowX, tab: e.tabIndex }));
    assert.ok(wrap.sw > wrap.cw, 'table wider than its container: ' + JSON.stringify(wrap));
    assert.equal(wrap.ox, 'auto'); assert.equal(wrap.tab, 0);
    assert.equal(await overflow(p), true);
    await p.locator('#page-next').scrollIntoViewIfNeeded();
    const nb = await p.locator('#page-next').boundingBox(); assert.ok(nb.x + nb.width <= 375 && nb.x >= 0);
    await p.context().close();
  });
  await check('layout stability: loading data does not resize the tab bar or move the table header', async () => {
    const p = await open('students', { initial: { delay: { profiles: 600 } } });
    await p.waitForSelector('#student-tbody .skeleton');
    const before = await p.evaluate(() => ({ bar: document.querySelector('#view-students .panel-bar').getBoundingClientRect().height, head: document.querySelector('#roster-thead').getBoundingClientRect().top }));
    await waitStudents(p);
    await p.waitForFunction(() => document.querySelector('[data-stage-count="all"]').textContent === '23');
    const after = await p.evaluate(() => ({ bar: document.querySelector('#view-students .panel-bar').getBoundingClientRect().height, head: document.querySelector('#roster-thead').getBoundingClientRect().top }));
    assert.ok(Math.abs(before.bar - after.bar) <= 1 && Math.abs(before.head - after.head) <= 1, JSON.stringify({ before, after }));
    await p.context().close();
  });

  /* ================= THEMES / CONTRAST ================= */
  const contrastOf = (p, sels) => p.evaluate(sels => {
    const cv = document.createElement('canvas'), ctx = cv.getContext('2d'); cv.width = cv.height = 1;
    const rgb = c => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data]; };
    const lum = c => { const a = c.slice(0, 3).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return .2126 * a[0] + .7152 * a[1] + .0722 * a[2]; };
    return sels.map(sel => {
      const el = [...document.querySelectorAll(sel)].find(e => e.getClientRects().length); if (!el) return { sel, missing: true };
      let n = el, bg = [0, 0, 0, 0]; while (n) { bg = rgb(getComputedStyle(n).backgroundColor); if (bg[3] === 255) break; n = n.parentElement; }
      if (bg[3] !== 255) bg = rgb(getComputedStyle(document.body).backgroundColor);
      const a = lum(rgb(getComputedStyle(el).color)), b = lum(bg);
      return { sel, ratio: Math.round(((Math.max(a, b) + .05) / (Math.min(a, b) + .05)) * 100) / 100 };
    });
  }, sels);
  for (const t of ['dark', 'light']) {
    await check(`contrast >= 4.5 (${t}): navigation, tabs, table text, muted text, badges, buttons`, async () => {
      const p = await open('students', { theme: t }); await waitStudents(p);
      await p.locator('#nav-people-toggle');
      const list = ['.nav-item', '.nav-item.is-active', '.crumbs li', '.tab', '.tab.is-active', '.table thead th', '.cell-name', '.cell-mail', '.badge', '.badge-accent', '.btn-primary', '.btn-secondary', '.pager', '.sidebar-user-mail', '.page-title', '.input'];
      const bad = (await contrastOf(p, list)).filter(c => c.missing || c.ratio < 4.5);
      assert.deepEqual(bad, []);
      await p.locator('#user-menu-btn').click();
      const menuBad = (await contrastOf(p, ['.user-menu-item', '.user-menu-item.is-signout'])).filter(c => c.missing || c.ratio < 4.5);
      assert.deepEqual(menuBad, []);
      await p.context().close();
    });
  }

  /* ---- Full-surface scan: every visible text node and form-control boundary, every view, both themes. ---- */
  const scanContrast = p => p.evaluate(() => {
    const cv = document.createElement('canvas'), ctx = cv.getContext('2d'); cv.width = cv.height = 1;
    const rgba = c => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = '#000'; ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); const d = ctx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
    const over = (t, b) => { const a = t[3]; return [0, 1, 2].map(i => t[i] * a + b[i] * (1 - a)).concat([1]); };
    const lum = c => { const a = c.slice(0, 3).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return .2126 * a[0] + .7152 * a[1] + .0722 * a[2]; };
    const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
    const backdrop = el => { const layers = []; let n = el; while (n && n.nodeType === 1) { const c = rgba(getComputedStyle(n).backgroundColor); if (c[3] > 0) layers.push(c); if (c[3] === 1) break; n = n.parentElement; }
      let base = layers.length && layers[layers.length - 1][3] === 1 ? layers.pop() : rgba(getComputedStyle(document.body).backgroundColor); if (base[3] !== 1) base = [255, 255, 255, 1];
      while (layers.length) base = over(layers.pop(), base); return base; };
    const visible = el => { if (!el.getClientRects().length) return false; for (let n = el; n && n.nodeType === 1; n = n.parentElement) { const cs = getComputedStyle(n); if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return false; } const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const bad = [], inputs = []; let texts = 0, worst = 99;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let t; (t = walker.nextNode());) {
      if (!t.nodeValue.trim()) continue; const el = t.parentElement;
      if (!el || /^(SCRIPT|STYLE|OPTION|NOSCRIPT)$/.test(el.tagName) || el.closest('[disabled],[aria-disabled="true"],[hidden],.is-hidden,template,svg,.sr-only,.skip-link')) continue;
      if (!visible(el)) continue;
      const cs = getComputedStyle(el), bg = backdrop(el), fg = over(rgba(cs.color), bg), r = ratio(fg, bg);
      const px = parseFloat(cs.fontSize), large = px >= 24 || (px >= 18.66 && Number(cs.fontWeight) >= 700), need = large ? 3 : 4.5;
      texts++; worst = Math.min(worst, r);
      if (r < need) bad.push({ text: t.nodeValue.trim().slice(0, 30), cls: el.className && el.className.toString().slice(0, 30), ratio: Math.round(r * 100) / 100 });
    }
    for (const el of document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, textarea')) {
      if (!visible(el) || el.disabled) continue;
      const cs = getComputedStyle(el), bg = backdrop(el.parentElement || el), fill = over(rgba(cs.backgroundColor), bg);
      const bw = parseFloat(cs.borderTopWidth) || 0, sh = (cs.boxShadow.match(/rgba?\([^)]+\)/) || [])[0], edge = bw ? over(rgba(cs.borderTopColor), bg) : (sh ? over(rgba(sh), bg) : fill);
      const boundary = Math.round(Math.max(ratio(edge, bg), ratio(fill, bg)) * 100) / 100;
      let ph = null; if (el.placeholder) { const pc = getComputedStyle(el, '::placeholder'); ph = Math.round(ratio(over(rgba(pc.color), fill), fill) * 100) / 100; }
      inputs.push({ id: el.id || el.name || el.tagName, boundary, placeholder: ph });
    }
    return { texts, worst: Math.round(worst * 100) / 100, bad, inputs };
  });
  const contrastReport = {};
  for (const t of ['dark', 'light']) {
    await check(`contrast scan (${t}): all views, text >= 4.5:1 (3:1 large), input boundary and placeholder >= 3:1 / 4.5:1`, async () => {
      for (const route of ['overview', 'live', 'sections', 'students', 'faculty', 'controls', 'mathtask', 'profile', 'settings']) {
        const p = await open(route, { theme: t });
        if (route === 'students') await waitStudents(p); else await p.waitForTimeout(500);
        const r = await scanContrast(p);
        contrastReport[`${t}/${route}`] = { texts: r.texts, worstTextRatio: r.worst, inputs: r.inputs };
        assert.deepEqual(r.bad, [], `${t}/${route} text`);
        assert.deepEqual(r.inputs.filter(i => i.boundary < 3 || (i.placeholder !== null && i.placeholder < 4.5)), [], `${t}/${route} inputs`);
        await p.context().close();
      }
      /* Overlays: command palette, user menu, a modal, the student drawer. */
      const p = await open('students', { theme: t }); await waitStudents(p);
      await p.keyboard.press('Control+k'); await p.waitForSelector('#palette.is-open'); await p.waitForTimeout(300);
      let r = await scanContrast(p); contrastReport[`${t}/palette`] = { texts: r.texts, worstTextRatio: r.worst, inputs: r.inputs };
      assert.deepEqual(r.bad, [], t + '/palette'); assert.deepEqual(r.inputs.filter(i => i.placeholder !== null && i.placeholder < 4.5), [], t + '/palette placeholder');
      await p.keyboard.press('Escape'); await p.waitForTimeout(300);
      await p.locator('#user-menu-btn').click(); await p.waitForTimeout(200);
      r = await scanContrast(p); contrastReport[`${t}/user-menu`] = { texts: r.texts, worstTextRatio: r.worst };
      assert.deepEqual(r.bad, [], t + '/user-menu');
      await p.keyboard.press('Escape');
      await p.locator('#student-tbody tr').first().locator('button, a').first().click().catch(() => {});
      await p.waitForTimeout(500);
      r = await scanContrast(p); contrastReport[`${t}/drawer-or-roster`] = { texts: r.texts, worstTextRatio: r.worst };
      assert.deepEqual(r.bad, [], t + '/drawer');
      await p.context().close();
      const q = await open('profile', { theme: t }); await q.waitForTimeout(400);
      await q.locator('[data-modal-open="modal-change-password"]').first().click().catch(() => {});
      await q.waitForTimeout(400);
      r = await scanContrast(q); contrastReport[`${t}/change-password-modal`] = { texts: r.texts, worstTextRatio: r.worst, inputs: r.inputs };
      assert.deepEqual(r.bad, [], t + '/modal');
      assert.deepEqual(r.inputs.filter(i => i.boundary < 3 || (i.placeholder !== null && i.placeholder < 4.5)), [], t + '/modal inputs');
      await q.context().close();
    });
  }
  await check('contrast scan: report written', async () => { fs.writeFileSync(path.join(out, 'contrast-b3.json'), JSON.stringify(contrastReport, null, 2)); assert.ok(Object.keys(contrastReport).length >= 22, String(Object.keys(contrastReport).length)); });

  /* ---- 200% zoom ---- browser zoom 200% of a 1280x900 window is a 640x450 CSS-pixel viewport; text-only zoom is a 200% root size. */
  const zoomReport = {};
  for (const mode of ['browser-zoom-200', 'text-only-200']) {
    await check(`${mode}: no page overflow, header controls and navigation reachable on every view`, async () => {
      const vp = mode === 'browser-zoom-200' ? { width: 640, height: 450 } : { width: 1280, height: 900 };
      for (const route of ['overview', 'live', 'sections', 'students', 'faculty', 'controls', 'mathtask', 'profile', 'settings']) {
        const p = await open(route, vp);
        if (mode === 'text-only-200') await p.addStyleTag({ content: 'html{font-size:200% !important}' });
        if (route === 'students') await waitStudents(p); else await p.waitForTimeout(500);
        await p.waitForTimeout(250);
        const m = await p.evaluate(() => {
          const inView = el => { if (!el || !el.getClientRects().length) return false; const r = el.getBoundingClientRect(); return r.left >= -1 && r.right <= window.innerWidth + 1 && r.top >= -1 && r.bottom <= window.innerHeight + 1; };
          const mq = window.innerWidth <= 900;
          return { scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth,
            palette: inView(document.querySelector('#palette-open')), theme: inView(document.querySelector('#theme-toggle')),
            toggle: inView(document.querySelector('#mobile-nav-toggle')), drawerMode: getComputedStyle(document.querySelector('#sidebar')).visibility === 'hidden',
            title: !!document.querySelector('.page:not(.is-hidden) .page-title') && document.querySelector('.page:not(.is-hidden) .page-title').getBoundingClientRect().right <= window.innerWidth + 1, mq };
        });
        zoomReport[`${mode}/${route}`] = m;
        assert.ok(m.scrollW <= m.innerW + 1, `${mode}/${route} overflow ${m.scrollW}>${m.innerW}`);
        assert.ok(m.title, `${mode}/${route} title clipped`);
        assert.ok(m.palette && m.theme, `${mode}/${route} header controls out of view ${JSON.stringify(m)}`);
        /* Navigation: visible in place or reachable through the drawer toggle; every item then scrollable into view. */
        if (route === 'students' || route === 'live' || route === 'controls') await shot(p, `zoom200-${mode}-${route}`);
        if (m.drawerMode) { assert.ok(m.toggle, `${mode}/${route} nav toggle out of view`); await p.locator('#mobile-nav-toggle').click(); await p.waitForTimeout(300); }
        const items = await p.locator('.nav-item').evaluateAll(els => els.filter(e => e.getClientRects().length).map(e => { e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return r.right <= window.innerWidth + 1 && r.left >= -1; }));
        assert.ok(items.length >= 5 && items.every(Boolean), `${mode}/${route} nav items unreachable`);
        const userOk = await p.locator('#user-menu-btn').evaluate(e => { e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1 && r.top >= -1; });
        assert.ok(userOk, `${mode}/${route} user menu trigger unreachable`);
        if (m.drawerMode && route === 'students') await shot(p, `zoom200-${mode}-${route}-drawer`);
        await p.context().close();
      }
    });
    await check(`${mode}: palette, user menu, modal and drawer stay inside the viewport and usable`, async () => {
      const vp = mode === 'browser-zoom-200' ? { width: 640, height: 450 } : { width: 1280, height: 900 };
      const p = await open('students', vp);
      if (mode === 'text-only-200') await p.addStyleTag({ content: 'html{font-size:200% !important}' });
      await waitStudents(p);
      const fits = sel => p.locator(sel).evaluate(e => { const r = e.getBoundingClientRect(); return r.left >= -1 && r.right <= window.innerWidth + 1 && r.top >= -1 && r.bottom <= window.innerHeight + 1; });
      await p.keyboard.press('Control+k'); await p.waitForSelector('#palette.is-open'); await p.waitForTimeout(300);
      assert.ok(await fits('#palette .palette'), 'palette inside viewport');
      assert.equal(await p.evaluate(() => document.activeElement.id), 'palette-input');
      await shot(p, `zoom200-${mode}-palette`);
      await p.keyboard.press('Escape'); await p.waitForTimeout(300);
      if (mode === 'browser-zoom-200') { await p.locator('#mobile-nav-toggle').click(); await p.waitForTimeout(300); }
      await p.locator('#user-menu-btn').click(); await p.waitForTimeout(250);
      assert.ok(await fits('#user-menu'), 'user menu inside viewport');
      await shot(p, `zoom200-${mode}-user-menu`);
      await p.keyboard.press('Escape'); if (mode === 'browser-zoom-200') await p.keyboard.press('Escape');
      await p.context().close();
      const q = await open('profile', vp);
      if (mode === 'text-only-200') await q.addStyleTag({ content: 'html{font-size:200% !important}' });
      await q.waitForTimeout(400);
      await q.locator('[data-modal-open="modal-change-password"]').click();
      await q.waitForTimeout(400);
      const box = await q.locator('#modal-change-password .modal').evaluate(e => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, vw: innerWidth, vh: innerHeight }; });
      assert.ok(box.l >= -1 && box.r <= box.vw + 1 && box.t >= -1 && box.b <= box.vh + 1, JSON.stringify(box));
      const reach = await q.locator('#modal-change-password button').evaluateAll(bs => bs.filter(b => b.getClientRects().length).map(b => { b.scrollIntoView({ block: 'nearest' }); const r = b.getBoundingClientRect(); return r.bottom <= innerHeight + 1 && r.top >= -1; }));
      assert.ok(reach.length >= 2 && reach.every(Boolean), 'modal buttons reachable ' + JSON.stringify(reach));
      await shot(q, `zoom200-${mode}-modal`);
      await q.context().close();
    });
  }
  await check('zoom 200%: report written', async () => { fs.writeFileSync(path.join(out, 'zoom-b3.json'), JSON.stringify(zoomReport, null, 2)); assert.ok(Object.keys(zoomReport).length >= 18); });

  await check('visual: shell and key views captured in both themes (light variants)', async () => {
    for (const [route, name] of [['live', 'live'], ['sections', 'sections'], ['students', 'students'], ['controls', 'controls'], ['settings', 'settings'], ['profile', 'profile']]) {
      const p = await open(route, { theme: 'light' });
      await p.waitForTimeout(300);
      await shot(p, `${name}-light-1280`);
      await p.context().close();
    }
  });
  await check('no request left the loopback server', async () => { assert.deepEqual(leaked.filter(u => /supabase\.co/.test(u)), []); });

  await browser.close(); server.close();
  fs.writeFileSync(path.join(out, 'results-b3.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  process.exit(results.some(r => r.error || r.pass === false) ? 1 : 0);
})();
