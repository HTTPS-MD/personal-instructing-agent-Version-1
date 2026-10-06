/* Isolated browser verification for Batch 2 (OCEAN test + tutoring tutorial).
   Every non-loopback request is intercepted. The Supabase SDK is replaced by a
   fixture; no real auth, database, email or account is touched.
   The "account" (user_metadata) lives in THIS Node process, so two browser
   contexts act as two devices signed in to the same account. */
const { chromium } = require('playwright');
const { createServer } = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const out = process.env.PIA_TEST_OUTPUT || '/tmp/pia-batch-2-evidence';
fs.mkdirSync(out, { recursive: true });
const mime = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.webp':'image/webp', '.png':'image/png', '.jpg':'image/jpeg' };
const server = createServer((req, res) => {
  const file = path.resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (error, data) => {
    if (error) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
    res.end(data);
  });
});

/* Serialised into the page. `window.__acct(op, payload)` is bound by Node. */
function fixture() {
  const f = window.fixture = Object.assign({ calls: [], profile: null, readError: false, writeError: false }, window.fixtureInitial || {});
  const user = { id: 'isolated-user', email: 'fixture@example.test' };
  const profile = () => Object.assign({ email: user.email, full_name: 'Fixture Learner', role: 'student', group_type: 'Assigned', is_ocean_done: true, selected_character: 'pia-open', current_stage: '', section: 'Earth', must_change_password: false }, f.profile || {});
  const chain = (table) => {
    const c = { select() { return c; }, eq() { return c; }, update() { f.calls.push({ method: 'profile-update' }); return c; },
      maybeSingle: async () => table === 'settings' ? { data: { value: f.stageOpen !== false }, error: null } : { data: profile(), error: null },
      then(res) { res({ data: null, error: null }); } };
    return c;
  };
  const api = {
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'isolated', user } }, error: null }),
      getUser: async () => {
        f.calls.push({ method: 'getUser' });
        if (f.readError) return { data: { user: null }, error: { message: 'unavailable' } };
        const meta = await window.__acct('read');
        return { data: { user: Object.assign({}, user, { user_metadata: meta }) }, error: null };
      },
      updateUser: async (args) => {
        f.calls.push({ method: 'updateUser', keys: Object.keys(args || {}), dataKeys: Object.keys((args && args.data) || {}) });
        if (args && args.password !== undefined) {
          await window.__acct('submit', { pwKeys: Object.keys(args) });
          if (f.updateDelay) await new Promise(r => setTimeout(r, f.updateDelay));
          if (!args.current_password) return { data: null, error: { code: 'current_password_required', message: 'Current password required when setting new password.' } };
          if (f.passwordError) return { data: null, error: f.passwordError };
          f.profile = Object.assign({}, f.profile, { must_change_password: false });   // MOCK of the migration-0019 trigger
          return { data: { user }, error: null };
        }
        if (f.writeError) return { data: null, error: { message: 'unavailable' } };
        await window.__acct('write', args.data);
        return { data: { user }, error: null };
      },
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async () => { f.calls.push({ method: 'signout' }); return { error: null }; }
    },
    from: chain,
    rpc: async (name, args) => {
      f.calls.push({ method: 'rpc', name });
      if (name === 'set_student_stage') return { data: { granted: true }, error: null };
      if (name === 'submit_ocean_results') { await window.__acct('submit', args); return { data: { ok: true }, error: null }; }
      if (name === 'resume_or_start_game_session') return { data: { session_id: 's1', resumed: false, topic: 1, answered: 0 }, error: null };
      return { data: null, error: null };
    },
    channel: (name) => {
      const ch = {
        on(_event, _filter, callback) {
          if (name.startsWith('student-stage-sync-')) f.stageUpdate = callback;
          return ch;
        },
        subscribe() { return ch; }
      };
      return ch;
    },
    removeChannel() {}
  };
  window.supabase = { createClient: () => api };
}

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PIA_CHROME, args: ['--disable-background-networking'] });
  const results = [];
  const accounts = {};            // accountKey -> user_metadata
  let leaked = [];
  let submitted = null;

  async function pageFor(url, { width = 1280, height = 900, theme = 'dark', initial = {}, account = 'acct-1', reduced = true, ctx } = {}) {
    const context = ctx || await browser.newContext({ viewport: { width, height }, reducedMotion: reduced ? 'reduce' : 'no-preference', serviceWorkers: 'block' });
    if (!ctx) {
      await context.addInitScript(i => window.fixtureInitial = i, initial);
      await context.addInitScript(t => { localStorage.setItem('pia_theme', t); localStorage.setItem('pia_user_email', 'fixture@example.test'); }, theme);
      await context.route('**/*', route => {
        const u = route.request().url();
        if (u.startsWith(origin + '/')) return route.continue();
        if (u.includes('/assets/js/vendor/supabase.js')) return route.fulfill({ contentType: 'text/javascript', body: `(${fixture.toString()})();` });
        leaked.push(u); return route.abort('blockedbyclient');
      });
      await context.exposeBinding('__acct', (_s, op, data) => {
        accounts[account] = accounts[account] || {};
        if (op === 'write') Object.assign(accounts[account], data);
        if (op === 'submit') { submitted = data; return null; }
        return accounts[account];
      });
    }
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    page.on('pageerror', e => results.push({ error: e.message }));
    await page.goto(origin + url);
    return page;
  }
  async function check(name, fn) {
    if (process.env.PIA_TEST_FILTER && !name.includes(process.env.PIA_TEST_FILTER)) return;
    try { await fn(); results.push({ name, pass: true }); } catch (e) { results.push({ name, pass: false, message: String(e.message).slice(0, 400) }); }
  }
  const calls = p => p.evaluate(() => window.fixture.calls);
  const dash = '/student/html/student-dashboard.html';
  const ocean = '/student/html/ocean-test.html';
  const visible = (p, sel) => p.locator(sel).isVisible();

  /* ---------------- OCEAN ---------------- */
  async function startOcean(opts) {
    const p = await pageFor(ocean, Object.assign({ initial: { profile: { is_ocean_done: false } } }, opts));
    await p.locator('[data-action="start"]').click();
    await p.waitForSelector('#test-container:not(.hidden)');
    return p;
  }
  await check('ocean: question map and overview grid are absent', async () => {
    const p = await startOcean();
    for (const sel of ['#qnav', '#question-grid', '.qgrid', '.qmap-bar', '#qmap-open', '#qmap-scrim', '.qnav-legend'])
      assert.equal(await p.locator(sel).count(), 0, sel);
    assert.equal(await p.getByText(/question map|all questions/i).count(), 0);
    await p.screenshot({ path: path.join(out, 'ocean-q1-dark-1280.png') });
    await p.context().close();
  });
  await check('ocean: Question 50 offers review when answers are missing', async () => {
    const p = await startOcean();
    const submit = p.locator('#btn-submit-ocean');
    assert.equal(await submit.isVisible(), false);
    assert.equal(await p.locator('#btn-prev').isDisabled(), true);
    assert.equal(await p.locator('.test-nav button:visible').count(), 2);
    for (let i = 0; i < 49; i++) { assert.equal(await submit.isVisible(), false, 'q' + (i + 1)); await p.locator('#btn-next').click(); }
    assert.match(await p.locator('#question-counter').innerText(), /50 of 50/i);
    assert.equal(await submit.isVisible(), false);
    assert.equal(await p.locator('#btn-next-label').innerText(), 'Review 50');
    await p.locator('#btn-next').click();
    assert.match(await p.locator('#question-counter').innerText(), /1 of 50/i);
    assert.equal(await p.locator('#btn-next-label').innerText(), 'Next missing');
    assert.equal(await p.locator('#btn-next').isDisabled(), true);
    assert.equal(await submit.isVisible(), false);
    await p.context().close();
  });
  await check('ocean: skipped questions return in order, then Submit appears', async () => {
    const p = await startOcean({ width: 375, theme: 'dark' });
    const submit = p.locator('#btn-submit-ocean');
    for (let i = 0; i < 50; i++) {
      if (i !== 2 && i !== 16) await p.locator('#ocean-answer-list button[data-score="4"]').click();
      if (i < 49) await p.locator('#btn-next').click();
    }
    assert.equal(await submit.isVisible(), false);
    assert.equal(await p.locator('#btn-next-label').innerText(), 'Review 2');
    assert.match(await p.locator('#submit-hint').innerText(), /2 unanswered/i);
    await p.screenshot({ path: path.join(out, 'ocean-review-missing-375.png') });
    await p.locator('#btn-next').click();
    assert.match(await p.locator('#question-counter').innerText(), /3 of 50/i);
    assert.equal(await p.locator('#btn-next').isDisabled(), true);
    await p.locator('#ocean-answer-list button[data-score="4"]').click();
    assert.equal(await p.locator('#btn-next-label').innerText(), 'Next missing');
    await p.locator('#btn-next').click();
    assert.match(await p.locator('#question-counter').innerText(), /17 of 50/i);
    await p.locator('#ocean-answer-list button[data-score="4"]').click();
    assert.equal(await submit.isVisible(), true);
    assert.equal(await submit.isEnabled(), true);
    await submit.click();
    await p.waitForURL(/assessment-complete/);
    assert.deepEqual(submitted, { p_responses: new Array(50).fill(4) });
    await p.context().close();
  });
  await check('ocean: Submit works only when all answered; answers reach the existing RPC', async () => {
    const p = await startOcean();
    for (let i = 0; i < 50; i++) {
      await p.locator('#ocean-answer-list button[data-score="4"]').click();
      if (i < 49) await p.locator('#btn-next').click();
    }
    const submit = p.locator('#btn-submit-ocean');
    assert.equal(await submit.isVisible(), true);
    assert.equal(await submit.isEnabled(), true);
    await p.screenshot({ path: path.join(out, 'ocean-q50-ready-dark-1280.png') });
    await submit.click();
    await p.waitForURL(/assessment-complete/);
    assert.deepEqual(submitted, { p_responses: new Array(50).fill(4) });
    await p.context().close();
  });
  await check('ocean: progress persists across reload and keyboard arrows still step', async () => {
    const p = await startOcean();
    await p.locator('#ocean-answer-list button[data-score="2"]').click();
    await p.keyboard.press('ArrowRight');
    assert.match(await p.locator('#question-counter').innerText(), /2 of 50/i);
    await p.reload();
    await p.waitForSelector('#test-container:not(.hidden)');
    assert.match(await p.locator('#question-counter').innerText(), /2 of 50/i);
    await p.locator('#btn-prev').click();
    assert.equal(await p.locator('#ocean-answer-list .is-selected').getAttribute('data-score'), '2');
    await p.context().close();
  });
  for (const [w, t] of [[320, 'light'], [375, 'dark'], [768, 'light'], [1440, 'dark']]) {
    await check(`ocean: no overflow at ${w}px ${t}`, async () => {
      const p = await startOcean({ width: w, theme: t });
      await p.locator('#ocean-answer-list button[data-score="3"]').click();
      assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      await p.screenshot({ path: path.join(out, `ocean-${w}-${t}.png`) });
      for (let i = 0; i < 49; i++) await p.locator('#btn-next').click();
      assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      await p.context().close();
    });
  }
  await check('ocean: homepage comic surface applied', async () => {
    const p = await startOcean();
    assert.equal(await p.evaluate(() => document.documentElement.dataset.surface), 'comic');
    await p.context().close();
  });

  /* ---------------- TUTORIAL ---------------- */
  const dlg = p => p.locator('#modal-tutorial.is-open');
  await check('tutorial: opens automatically on first visit, skip visible, no autoplay media', async () => {
    const p = await pageFor(dash);
    await dlg(p).waitFor();
    assert.equal(await p.locator('#tutorial-skip').isVisible(), true);
    assert.match(await p.locator('#tutorial-skip').innerText(), /skip tutorial/i);
    assert.equal(await p.locator('video, audio').count(), 0);
    assert.equal(await p.locator('.learn').getAttribute('inert') !== null, true);
    await p.screenshot({ path: path.join(out, 'tutorial-step1-dark-1280.png') });
    await p.context().close();
    for (const k of Object.keys(accounts)) delete accounts[k];
  });
  await check('tutorial: Skip marks the ACCOUNT as seen (updateUser user_metadata), not browser storage', async () => {
    const p = await pageFor(dash);
    await dlg(p).waitFor();
    await p.locator('#tutorial-skip').click();
    await p.waitForFunction(() => window.fixture.calls.some(c => c.method === 'updateUser'));
    assert.ok(accounts['acct-1'].pia_tutorial_seen_at);
    const c = await calls(p);
    assert.deepEqual(c.find(x => x.method === 'updateUser').keys, ['data']);   // never password/email
    assert.equal(await p.evaluate(() => Object.keys(localStorage).some(k => /tutorial/i.test(k))), false);
    assert.equal(await dlg(p).count(), 0);
    assert.equal(await p.locator('.learn').getAttribute('inert'), null);
    await p.context().close();
  });
  await check('tutorial: second device on the same account does not auto-open', async () => {
    const p = await pageFor(dash);                // new context = new device, same account
    await p.waitForSelector('#start-btn');
    await p.waitForFunction(() => window.fixture.calls.some(c => c.method === 'getUser'));
    await p.waitForTimeout(300);
    assert.equal(await dlg(p).count(), 0);
    await p.context().close();
  });
  await check('tutorial: a different account still sees it once', async () => {
    const p = await pageFor(dash, { account: 'acct-2' });
    await dlg(p).waitFor();
    await p.context().close();
  });
  await check('tutorial: manual replay via Tutorial button, steps, Back/Next/Finish; replay does not write again', async () => {
    const p = await pageFor(dash);
    await p.waitForSelector('#start-btn'); await p.waitForTimeout(200);
    const before = (await calls(p)).filter(c => c.method === 'updateUser').length;
    await p.locator('#tutorial-btn').click();
    await dlg(p).waitFor();
    assert.match(await p.locator('#tutorial-step').innerText(), /Step 1 of 4/i);
    assert.equal(await p.locator('#tutorial-back').isDisabled(), true);
    await p.locator('#tutorial-next').click();
    assert.match(await p.locator('#tutorial-step').innerText(), /Step 2 of 4/i);
    await p.locator('#tutorial-back').click();
    assert.match(await p.locator('#tutorial-step').innerText(), /Step 1 of 4/i);
    for (let i = 0; i < 3; i++) await p.locator('#tutorial-next').click();
    assert.equal(await p.locator('#tutorial-next').innerText(), 'Finish');
    await p.locator('#tutorial-next').click();
    await p.waitForFunction(() => !document.querySelector('#modal-tutorial.is-open'));
    assert.equal((await calls(p)).filter(c => c.method === 'updateUser').length, before);
    assert.equal(await p.evaluate(() => document.activeElement.id), 'tutorial-btn');
    await p.context().close();
  });
  await check('tutorial: Finish on first visit also marks seen', async () => {
    const p = await pageFor(dash, { account: 'acct-3' });
    await dlg(p).waitFor();
    for (let i = 0; i < 4; i++) await p.locator('#tutorial-next').click();
    await p.waitForFunction(() => window.fixture.calls.some(c => c.method === 'updateUser'));
    assert.ok(accounts['acct-3'].pia_tutorial_seen_at);
    await p.context().close();
  });
  await check('tutorial: Escape skips and marks seen; Tab stays inside the dialog', async () => {
    const p = await pageFor(dash, { account: 'acct-4' });
    await dlg(p).waitFor();
    for (let i = 0; i < 6; i++) { await p.keyboard.press('Tab'); assert.equal(await p.evaluate(() => !!document.activeElement.closest('#modal-tutorial')), true); }
    await p.keyboard.press('Escape');
    await p.waitForFunction(() => window.fixture.calls.some(c => c.method === 'updateUser'));
    assert.ok(accounts['acct-4'].pia_tutorial_seen_at);
    assert.equal(await dlg(p).count(), 0);
    await p.context().close();
  });
  await check('tutorial: after Skip, reduced motion shows static highlight + note, no cursor', async () => {
    const p = await pageFor(dash, { account: 'acct-5', reduced: true });
    await dlg(p).waitFor();
    await p.locator('#tutorial-skip').click();
    await p.waitForSelector('#tutorial-btn.is-spotlight');
    assert.equal(await p.locator('.tutorial-cursor').count(), 0);
    await p.waitForFunction(() => (document.querySelector('.tutorial-callout-text') || {}).textContent);
    assert.match(await p.locator('.tutorial-callout').innerText(), /replay the tutorial/i);
    const ring = await p.locator('#tutorial-btn').evaluate(el => getComputedStyle(el).outlineStyle);
    assert.equal(ring, 'solid');
    await p.screenshot({ path: path.join(out, 'tutorial-skip-reduced-motion.png') });
    await p.context().close();
  });
  await check('tutorial: after Skip, normal motion shows a mock cursor that reaches the button', async () => {
    const p = await pageFor(dash, { account: 'acct-6', reduced: false });
    await dlg(p).waitFor();
    await p.locator('#tutorial-skip').click();
    await p.waitForSelector('.tutorial-cursor');
    assert.equal(await p.locator('.tutorial-cursor').getAttribute('aria-hidden'), 'true');
    await p.waitForSelector('#tutorial-btn.is-clicked', { timeout: 3000 });
    const box = await p.locator('#tutorial-btn').boundingBox();
    const cur = await p.locator('.tutorial-cursor').boundingBox();
    assert.ok(Math.abs(cur.x - (box.x + box.width / 2)) < 30 && Math.abs(cur.y - (box.y + box.height / 2)) < 30, JSON.stringify({ box, cur }));
    await p.screenshot({ path: path.join(out, 'tutorial-skip-cursor.png') });
    await p.waitForSelector('.tutorial-cursor', { state: 'detached', timeout: 6000 });
    await p.context().close();
  });
  await check('tutorial: read failure does not auto-open; button still replays', async () => {
    const p = await pageFor(dash, { account: 'acct-7', initial: { readError: true } });
    await p.waitForSelector('#start-btn'); await p.waitForTimeout(300);
    assert.equal(await dlg(p).count(), 0);
    await p.locator('#tutorial-btn').click(); await dlg(p).waitFor();
    await p.keyboard.press('Escape');                              // write still allowed here
    await p.context().close();
  });
  await check('tutorial: write failure still closes the dialog and never claims success', async () => {
    const p = await pageFor(dash, { account: 'acct-8', initial: { writeError: true } });
    await dlg(p).waitFor();
    await p.locator('#tutorial-skip').click();
    await p.waitForFunction(() => window.fixture.calls.some(c => c.method === 'updateUser'));
    assert.equal(await dlg(p).count(), 0);
    assert.equal(accounts['acct-8'] && accounts['acct-8'].pia_tutorial_seen_at, undefined);
    assert.equal(await p.locator('.learn').getAttribute('inert'), null);
    await p.context().close();
  });
  for (const [w, t] of [[320, 'light'], [375, 'dark'], [768, 'dark'], [1440, 'light']]) {
    await check(`tutorial: dialog and header fit at ${w}px ${t}; targets >=44px`, async () => {
      const p = await pageFor(dash, { width: w, theme: t, account: `fit-${w}${t}` });
      await dlg(p).waitFor();
      assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      for (const id of ['#tutorial-skip', '#tutorial-next']) { const b = await p.locator(id).boundingBox(); assert.ok(b.height >= 44 && b.width >= 44, id + JSON.stringify(b)); }
      await p.screenshot({ path: path.join(out, `tutorial-${w}-${t}.png`) });
      await p.locator('#tutorial-skip').click();
      await p.waitForFunction(() => !document.querySelector('#modal-tutorial.is-open'));
      const tb = await p.locator('#tutorial-btn').boundingBox();
      assert.ok(tb.width >= 44 && tb.height >= 44, JSON.stringify(tb));
      assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      await p.screenshot({ path: path.join(out, `dashboard-${w}-${t}.png`) });
      await p.context().close();
    });
  }
  await check('dashboard: homepage comic surface applied and Batch 1 homepage untouched', async () => {
    const p = await pageFor(dash, { account: 'surface' });
    assert.equal(await p.evaluate(() => document.documentElement.dataset.surface), 'comic');
    await p.context().close();
  });
  /* ---------------- ICON / CARD AUDIT ---------------- */
  const iconsOf = p => p.evaluate(() => [...document.querySelectorAll('svg.icon')].filter(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden').map(e => (e.querySelector('use') || {getAttribute: () => '?'}).getAttribute('href')).sort());
  const flat = (p, sel) => p.locator(sel).evaluate(el => { const c = getComputedStyle(el); return { bg: c.backgroundColor, shadow: c.boxShadow }; });
  const isFlat = o => (o.bg === 'rgba(0, 0, 0, 0)' || o.bg === 'transparent') && o.shadow === 'none';

  for (const [w, t] of [[375, 'dark'], [1280, 'light']]) {
    await check(`audit: OCEAN consent screen has no glyph, icon, or card (${w}px ${t})`, async () => {
      const p = await pageFor(ocean, { width: w, theme: t, initial: { profile: { is_ocean_done: false } } });
      await p.waitForSelector('.gate-wrap');
      assert.equal(await p.locator('.gate-glyph, .privacy-box, .modal-hero, svg.icon-lg').count(), 0);
      assert.deepEqual(await iconsOf(p), ['#i-logout'].filter(() => false));
      assert.ok(isFlat(await flat(p, '.gate-wrap')));
      assert.match(await p.locator('.privacy-note').innerText(), /Your answers are private[\s\S]*not graded/);
      await p.screenshot({ path: path.join(out, `audit-ocean-consent-${w}-${t}.png`) });
      await p.context().close();
    });
    await check(`audit: OCEAN question screen keeps only direction chevrons (${w}px ${t})`, async () => {
      const p = await startOcean({ width: w, theme: t });
      await p.locator('#ocean-answer-list button[data-score="3"]').click();
      await p.locator('#btn-next').click();
      assert.deepEqual(await iconsOf(p), ['#i-chev-left', '#i-chev-right']);
      assert.ok(isFlat(await flat(p, '.test-progress')));
      await p.screenshot({ path: path.join(out, `audit-ocean-question-${w}-${t}.png`) });
      await p.context().close();
    });
  }
  await check('audit: OCEAN quit dialog is plain text, no glyph/hero; behaviour unchanged', async () => {
    const p = await startOcean({ width: 375 });
    await p.locator('#ocean-answer-list button[data-score="3"]').click();
    await p.locator('.brand-link').click();
    await p.waitForSelector('#quit-modal.modal-active');
    assert.equal(await p.locator('#quit-modal .modal-hero, #quit-modal svg').count(), 0);
    assert.match(await p.locator('#quit-modal .modal-text').innerText(), /come back and carry on/);
    await p.screenshot({ path: path.join(out, 'audit-ocean-quit-375.png') });
    await p.locator('#quit-modal-stay').click();
    await p.waitForFunction(() => !document.querySelector('#quit-modal.modal-active'));
    assert.equal(new URL(p.url()).pathname, ocean);        // still on the test: no navigation change
    await p.context().close();
  });
  for (const [w, t] of [[375, 'dark'], [1280, 'light']]) {
    await check(`audit: Character Selection icons/cards (${w}px ${t}); lock-in dialog plain`, async () => {
      const p = await pageFor('/student/html/character-selection.html', { width: w, theme: t, account: 'char2', initial: { profile: { group_type: 'Non-Assigned', selected_character: null, is_ocean_done: true } } });
      await p.waitForSelector('.persona-card');
      assert.deepEqual(await iconsOf(p), []);
      assert.equal(await p.locator('.persona-card').count() > 1, true);   // functional cards kept
      await p.locator('.persona-card').first().click();
      assert.equal(await p.locator('#lock-in-btn').isEnabled(), true);
      assert.equal(await p.locator('#lock-in-btn svg').count(), 0);
      await p.screenshot({ path: path.join(out, `audit-char-preview-${w}-${t}.png`) });
      await p.locator('#lock-in-btn').click();
      await p.waitForSelector('.overlay.modal-active, .overlay.is-open, .overlay[aria-hidden="false"]');
      assert.equal(await p.locator('#modal-content .modal-hero, #modal-content .modal-hero-glyph').count(), 0);
      assert.match(await p.locator('#modal-content .modal-text').innerText(), /This choice is final/);
      await p.screenshot({ path: path.join(out, `audit-char-lock-${w}-${t}.png`) });
      await p.context().close();
    });
    await check(`audit: dashboard start screen icons/cards (${w}px ${t}); facts are a description list`, async () => {
      const p = await pageFor(dash, { width: w, theme: t, account: 'dash-audit', initial: {} });
      await p.waitForSelector('#start-btn');
      await p.keyboard.press('Escape');
      assert.equal(await p.locator('.start-card svg, .agent-card svg, #start-btn svg, #signout-btn svg').count(), 0);
      assert.equal(await p.locator('.dot-live').count(), 0);
      await p.keyboard.press('Escape');   // the first-visit tutorial can open a moment after the page; close it, then wait until nothing covers the page
      await p.waitForFunction(() => { const s = document.querySelector('#tutorial-btn svg'); return s && s.getClientRects().length && getComputedStyle(s).visibility !== 'hidden' && !document.querySelector('.overlay.is-open'); }, null, { timeout: 8000 });
      assert.deepEqual(await iconsOf(p), ['#i-help']);
      assert.equal(await p.locator('dl.facts > .fact > dt').count(), 2);
      assert.equal(await p.locator('.start-card #start-btn').count(), 1, 'Start sits inside the start section');
      assert.equal(await p.evaluate(() => { const a = document.querySelector('.start-card').getBoundingClientRect(), b = document.querySelector('.agent-card').getBoundingClientRect(); return b.top >= a.top - 1 && (innerWidth < 720 || b.left >= a.right - 1 || b.top >= a.bottom - 1); }), true);
      assert.ok(isFlat(await flat(p, '.start-card')));
      assert.equal(await p.locator('.agent-card').count(), 1);          // functional tutor card kept
      await p.screenshot({ path: path.join(out, `audit-dash-start-${w}-${t}.png`) });
      await p.context().close();
    });
  }
  await check('audit: dashboard session + sign-out dialog (no trophy/bulb/hero; no status icons)', async () => {
    const p = await pageFor(dash, { width: 375, account: 'dash-audit2' });
    await p.waitForSelector('#start-btn'); await p.keyboard.press('Escape');
    await p.evaluate(() => { document.querySelector('#screen-start').classList.remove('is-active'); document.querySelector('#screen-session').classList.add('is-active'); });
    assert.equal(await p.locator('#hint-btn svg, #submit-btn svg').count(), 0);
    await p.keyboard.press('Escape');   // the first-visit tutorial can open a moment after the page; close it, then wait until nothing covers the page
      await p.waitForFunction(() => { const s = document.querySelector('#tutorial-btn svg'); return s && s.getClientRects().length && getComputedStyle(s).visibility !== 'hidden' && !document.querySelector('.overlay.is-open'); }, null, { timeout: 8000 });
      assert.deepEqual(await iconsOf(p), ['#i-help']);                 // tutorial control only: the step game has no status icons
    assert.equal(await p.locator('.left-sidebar').count() + await p.locator('.center-panel').count() + await p.locator('.right-sidebar').count(), 3);   // the original game's three areas
    await p.screenshot({ path: path.join(out, 'audit-dash-session-375.png') });
    assert.equal(await p.locator('#signout-btn').isVisible(), true);
    await p.locator('#signout-btn').click();
    await p.waitForSelector('#modal-confirm.is-open');
    assert.equal(await p.locator('#modal-confirm .modal-hero, #modal-confirm .modal-hero-glyph').count(), 0);
    assert.ok((await p.locator('#confirm-text').innerText()).length >= 0);
    assert.equal(await p.locator('#modal-confirm').getAttribute('aria-labelledby'), 'confirm-title');
    await p.screenshot({ path: path.join(out, 'audit-dash-signout-dialog-375.png') });
    await p.keyboard.press('Escape');
    await p.context().close();
  });
  await check('audit: tutorial dialog has no icon, X, or nested card', async () => {
    const p = await pageFor(dash, { width: 375, account: 'tut-audit' });
    await p.locator('#modal-tutorial.is-open').waitFor();
    assert.equal(await p.locator('#modal-tutorial svg, #modal-tutorial .modal-close, #modal-tutorial .modal-hero').count(), 0);
    await p.context().close();
  });
  /* ---------------- POLISH: callout, out-of-scope screens, zoom, contrast, long text, keyboard ---------------- */
  const overlap = (a, b) => !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
  for (const [w, t, reduced] of [[320, 'light', true], [375, 'dark', true], [375, 'light', false], [768, 'dark', false], [1440, 'light', true]]) {
    await check(`polish: post-Skip note overlaps nothing at ${w}px ${t} reduced=${reduced}`, async () => {
      const p = await pageFor(dash, { width: w, theme: t, reduced, account: `note-${w}${t}${reduced}` });
      await dlg(p).waitFor();
      await p.locator('#tutorial-skip').click();
      await p.waitForFunction(() => (document.querySelector('.tutorial-callout-text') || {}).textContent);
      const r = await p.evaluate(() => {
        const box = s => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, w: b.width }; };
        return { note: box('.tutorial-callout'), text: box('.tutorial-callout-text'), bar: box('.learn-bar'),
                 others: ['.start-hello', '#start-btn', '#tutorial-btn', '#signout-btn', '.agent-card', '.start-facts'].map(s => [s, box(s)]),
                 role: document.querySelector('.tutorial-callout').getAttribute('role'), vw: innerWidth, sw: document.documentElement.scrollWidth };
      });
      assert.equal(r.role, 'status');
      assert.ok(r.note.top >= r.bar.bottom - 1, 'sits below the top bar');
      assert.ok(r.note.left >= 0 && r.note.right <= r.vw + 1, 'inside the viewport');
      assert.ok(r.sw <= r.vw + 1, 'no horizontal overflow');
      for (const [sel, b] of r.others) if (b) assert.equal(overlap(r.note, b), false, 'note overlaps ' + sel);
      if (reduced) assert.equal(await p.locator('.tutorial-cursor').count(), 0, 'reduced motion: no cursor');
      assert.equal(await p.locator('#tutorial-btn.is-spotlight').count(), 1, 'button is highlighted');
      await p.screenshot({ path: path.join(out, `polish-note-${w}-${t}${reduced ? '-rm' : ''}.png`) });
      await p.waitForSelector('.tutorial-callout', { state: 'detached', timeout: 9000 });
      assert.equal(await p.locator('#tutorial-btn.is-spotlight').count(), 0);
      await p.context().close();
    });
  }
  /* ---------------- WAITING ROOM / ASSESSMENT COMPLETE / SET NEW PASSWORD ---------------- */
  const WAIT = ['/student/html/waiting-room.html', { stageOpen: false, profile: { is_ocean_done: false } }];
  for (const [w, t] of [[320, 'light'], [375, 'dark'], [768, 'light'], [1280, 'dark'], [1440, 'light']]) {
    await check(`waiting room: open section + facts list, no card/glyph/icon/action (${w}px ${t})`, async () => {
      const p = await pageFor(WAIT[0], { width: w, theme: t, account: 'wr', initial: WAIT[1] });
      await p.waitForSelector('#waiting-for'); await p.waitForFunction(() => document.querySelector('#waiting-for').textContent === 'The questionnaire');
      assert.equal(await p.evaluate(() => document.documentElement.dataset.surface), 'comic');
      assert.equal(await p.locator('.wait-card, .wait-orb, .gate-glyph, svg.icon-lg').count(), 0);
      assert.deepEqual(await iconsOf(p), []);
      assert.equal(await p.locator('main button, main a.btn, main form').count(), 0, 'no action: the existing flow redirects automatically');
      assert.equal(await p.locator('dl.facts-list > div').count(), 3);
      assert.deepEqual(await p.locator('dl.facts-list dt').allInnerTexts(), ['Status', 'Your stage', 'Waiting for']);
      assert.ok(isFlat(await flat(p, '.wait-section')));
      assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      await p.screenshot({ path: path.join(out, `final-waiting-${w}-${t}.png`) });
      await p.context().close();
    });
  }
  await check('waiting room: existing redirect behaviour preserved when the stage opens', async () => {
    const p = await pageFor('/student/html/waiting-room.html', { account: 'wr2', initial: { stageOpen: true, profile: { is_ocean_done: false } } });
    await p.waitForURL(/ocean-test\.html/);
    await p.context().close();
  });
  await check('waiting room: char/dash variants name the right stage', async () => {
    let p = await pageFor('/student/html/waiting-room.html', { account: 'wr3', initial: { stageOpen: false, profile: { is_ocean_done: true, group_type: 'Non-Assigned', selected_character: null } } });
    await p.waitForFunction(() => document.querySelector('#waiting-for').textContent === 'Character selection');
    await p.context().close();
    p = await pageFor('/student/html/waiting-room.html', { account: 'wr4', initial: { stageOpen: false, profile: { is_ocean_done: true, group_type: 'Assigned', selected_character: 'pia-open' } } });
    await p.waitForFunction(() => document.querySelector('#waiting-for').textContent === 'The tutoring dashboard');
    await p.context().close();
  });
  await check('control (OCEAN only): thank-you screen has no next stage; waiting room and dashboard URL send Control there', async () => {
    const ctl = { is_ocean_done: true, group_type: 'Control', selected_character: null };
    let p = await pageFor('/student/html/assessment-complete.html', { account: 'ctl-ac', initial: { stageOpen: true, profile: ctl } });
    await p.waitForSelector('h1'); await p.waitForTimeout(400);
    assert.equal(await p.locator('#btn-continue').count(), 0, 'no Continue for Control');
    assert.equal(await p.locator('main a.btn, main button').count(), 0);
    assert.match(await p.locator('.gate-lede').innerText(), /^Your answers have been saved\. That is everything for now\.$/);
    await p.context().close();
    p = await pageFor('/student/html/waiting-room.html', { account: 'ctl-wr', initial: { stageOpen: true, profile: ctl } });
    await p.waitForURL(/assessment-complete\.html/);
    await p.context().close();
    p = await pageFor('/student/html/student-dashboard.html', { account: 'ctl-dash', initial: { stageOpen: true, profile: ctl } });
    await p.waitForURL(/assessment-complete\.html/);
    await p.context().close();
    p = await pageFor('/student/html/character-selection.html', { account: 'ctl-char', initial: { stageOpen: true, profile: ctl } });
    await p.waitForURL(/assessment-complete\.html/);
    await p.context().close();
  });
  await check('assigned + pia-neutral: the student goes straight to the dashboard, sees PIA as their tutor, never Character Selection', async () => {
    const asg = { is_ocean_done: true, group_type: 'Assigned', selected_character: 'pia-neutral' };
    let p = await pageFor('/student/html/student-dashboard.html', { account: 'asg-neutral', initial: { stageOpen: true, profile: asg } });
    await p.waitForSelector('#agent-name-start'); await p.waitForTimeout(400);
    assert.match(p.url(), /student-dashboard\.html/);
    assert.equal((await p.locator('#agent-name-start').innerText()).trim(), 'PIA · your tutor');
    await p.context().close();
    p = await pageFor('/student/html/character-selection.html', { account: 'asg-char', initial: { stageOpen: true, profile: asg } });
    await p.waitForURL(/student-dashboard\.html/);
    await p.context().close();
    p = await pageFor('/student/html/waiting-room.html', { account: 'asg-wait', initial: { stageOpen: true, profile: asg } });
    await p.waitForURL(/student-dashboard\.html/);
    await p.context().close();
  });
  await check('assigned without a tutor yet is not auto-assigned or sent to Character Selection', async () => {
    const asg = { is_ocean_done: true, group_type: 'Assigned', selected_character: null };
    const p = await pageFor('/student/html/character-selection.html', { account: 'asg-none', initial: { stageOpen: true, profile: asg } });
    await p.waitForURL(/student-dashboard\.html/);
    await p.waitForSelector('#agent-name-start'); await p.waitForTimeout(300);
    /* Step game (0039): no tutor is shown or chosen, and the session cannot start until an admin assigns one. */
    assert.match(await p.locator('#global-error-message').innerText(), /not been assigned/i);
    assert.equal(await p.locator('#start-btn').isDisabled(), true);
    assert.equal(await p.evaluate(() => (document.querySelector('#agent-img-start').getAttribute('src') || '').includes('/tutors/')), false);
    await p.context().close();
  });
  await check('free choice who picked PIA Neutral reaches the dashboard; one who has not picked is sent to Character Selection', async () => {
    let p = await pageFor('/student/html/waiting-room.html', { account: 'fc-picked', initial: { stageOpen: true, profile: { is_ocean_done: true, group_type: 'Non-Assigned', selected_character: 'pia-neutral' } } });
    await p.waitForURL(/student-dashboard\.html/);
    await p.context().close();
    p = await pageFor('/student/html/waiting-room.html', { account: 'fc-unpicked', initial: { stageOpen: true, profile: { is_ocean_done: true, group_type: 'Non-Assigned', selected_character: null } } });
    await p.waitForURL(/character-selection\.html/);
    await p.context().close();
  });
  await check('student pages show only that student\u2019s own status and next step, never the research-group policy', async () => {
    const BANNED = /\bcontrol group\b|\bControl\b|Experimental|research group|Free choice|free-choice|\bAssigned\b|non-assigned|\bcondition\b|OCEAN only/i;
    const pages = [
      ['/student/html/waiting-room.html', { stageOpen: false }],
      ['/student/html/assessment-complete.html', { stageOpen: true }],
      ['/student/html/student-dashboard.html', { stageOpen: true }],
      ['/student/html/character-selection.html', { stageOpen: true }],
      ['/student/html/ocean-test.html', { stageOpen: true }]
    ];
    const groups = [['Control', null], ['Assigned', 'pia-open'], ['Non-Assigned', null]];
    let n = 0;
    for (const [group, tutor] of groups) {
      for (const [url, extra] of pages) {
        const done = !/ocean-test/.test(url);
        const prof = { group_type: group, selected_character: tutor, is_ocean_done: done };
        const p = await pageFor(url, { account: 'priv' + (n++), initial: Object.assign({ profile: prof }, extra) });
        await p.waitForTimeout(700);
        const text = await p.evaluate(() => document.body.innerText);
        const hit = text.match(BANNED);
        assert.equal(hit, null, `${group} on ${url.split('/').pop()} says "${hit && hit[0]}"`);
        await p.context().close();
      }
    }
  });
  await check('control (OCEAN only): before OCEAN they are still routed to the questionnaire', async () => {
    const p = await pageFor('/student/html/waiting-room.html', { account: 'ctl-pre', initial: { stageOpen: true, profile: { is_ocean_done: false, group_type: 'Control' } } });
    await p.waitForURL(/ocean-test\.html/);
    await p.context().close();
  });
  for (const [w, t] of [[320, 'dark'], [375, 'light'], [768, 'dark'], [1280, 'light'], [1440, 'dark']]) {
    await check(`assessment complete: heading, same wording, one action, no glyph/card (${w}px ${t})`, async () => {
      const p = await pageFor('/student/html/assessment-complete.html', { width: w, theme: t, account: 'ac', initial: { profile: { is_ocean_done: true } } });
      await p.waitForSelector('#btn-continue'); await p.waitForTimeout(250);
      assert.equal(await p.evaluate(() => document.documentElement.dataset.surface), 'comic');
      assert.equal(await p.locator('h1').innerText(), 'Thank you for completing the assessment');
      assert.match(await p.locator('.gate-lede').innerText(), /^Your answers have been saved\. Continue to your next stage\.$/);
      assert.equal(await p.locator('.gate-glyph, svg.icon-lg, .gate-wrap:not(.gate-open)').count(), 0);
      assert.deepEqual(await iconsOf(p), ['#i-arrow-right']);          // direction on the one action
      assert.equal(await p.locator('main a.btn, main button').count(), 1);
      assert.match(await p.locator('#btn-continue').getAttribute('href'), /student-dashboard\.html$/);   // existing resolveStudentRedirect
      assert.ok(isFlat(await flat(p, '.gate-wrap')));
      assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      await p.screenshot({ path: path.join(out, `final-complete-${w}-${t}.png`) });
      await p.context().close();
    });
  }
  const PW = ['/student/html/set-new-password.html', { profile: { must_change_password: true } }];
  const pwPage = (o = {}) => pageFor(PW[0], Object.assign({ account: 'pw' }, o, { initial: Object.assign({}, PW[1], o.initial || {}) }));
  await check('student header: optional change-password link is visible', async () => {
    const p = await pageFor(dash, { account: 'pw-link' });
    await p.waitForSelector('#pia-change-password');
    assert.equal(await p.locator('#pia-change-password').isVisible(), true);
    assert.equal(new URL(await p.locator('#pia-change-password').getAttribute('href'), p.url()).pathname,
      '/student/html/set-new-password.html');
    await p.context().close();
  });
  await check('password change, OPTIONAL (flag off): OCEAN page -> Change password link -> the page opens and stays, back link returns to OCEAN', async () => {
    const oceanUrl = '/student/html/ocean-test.html';
    const p = await pageFor(oceanUrl, { account: 'pw-opt', initial: { profile: { is_ocean_done: false, must_change_password: false } } });
    await p.waitForSelector('#pia-change-password');
    assert.equal(new URL(p.url()).pathname, oceanUrl);
    await p.click('#pia-change-password');
    await p.waitForURL(u => u.pathname === '/student/html/set-new-password.html');
    await p.waitForFunction(() => !document.body.classList.contains('opacity-0'));
    await p.waitForTimeout(1200);                                   // long enough for any redirect to fire
    assert.equal(new URL(p.url()).pathname, '/student/html/set-new-password.html');
    assert.match(await p.locator('h1').innerText(), /Change your password/);
    assert.match(await p.locator('label[for="pw-current"]').innerText(), /Current password/);
    assert.equal(await p.locator('#pw-back').isVisible(), true);
    assert.equal(new URL(await p.locator('#pw-back').getAttribute('href'), p.url()).pathname, oceanUrl);
    assert.equal(await p.locator('#pia-change-password').count(), 0, 'no change-password link on the change-password page itself');
    await p.context().close();
  });
  await check('password change, OPTIONAL: also reachable from the thank-you screen and the waiting room without bouncing', async () => {
    for (const u of ['/student/html/assessment-complete.html', '/student/html/waiting-room.html']) {
      const p = await pageFor(u, { account: 'pw-opt2', initial: { stageOpen: false, profile: { must_change_password: false } } });
      await p.waitForSelector('#pia-change-password');
      await p.click('#pia-change-password');
      await p.waitForURL(x => x.pathname === '/student/html/set-new-password.html');
      await p.waitForTimeout(1000);
      assert.equal(new URL(p.url()).pathname, '/student/html/set-new-password.html');
      await p.context().close();
    }
  });
  await check('password change, OPTIONAL: the link is reachable on a phone (375px) from the dashboard and OCEAN', async () => {
    for (const [u, prof] of [[dash, {}], ['/student/html/ocean-test.html', { is_ocean_done: false }]]) {
      const p = await pageFor(u, { account: 'pw-opt3', width: 375, initial: { profile: Object.assign({ must_change_password: false }, prof) } });
      await p.waitForSelector('#pia-change-password');
      await p.keyboard.press('Escape');
      assert.equal(await p.locator('#pia-change-password').isVisible(), true, u);
      await p.context().close();
    }
  });
  await check('password change, REQUIRED (flag on): any student page sends the student to the password page, which has no way around it', async () => {
    for (const u of ['/student/html/ocean-test.html', dash, '/student/html/assessment-complete.html']) {
      const p = await pageFor(u, { account: 'pw-req', initial: { profile: { must_change_password: true, is_ocean_done: u !== '/student/html/ocean-test.html' } } });
      await p.waitForURL(x => x.pathname === '/student/html/set-new-password.html');
      await p.waitForFunction(() => !document.body.classList.contains('opacity-0'));
      assert.match(await p.locator('h1').innerText(), /Choose a new password/);
      assert.match(await p.locator('label[for="pw-current"]').innerText(), /Temporary password/);
      assert.equal(await p.locator('#pw-back').isVisible(), false, 'no back link while the change is required');
      assert.equal(await p.locator('#pia-change-password').count(), 0);
      await p.waitForTimeout(600);
      assert.equal(new URL(p.url()).pathname, '/student/html/set-new-password.html');
      await p.context().close();
    }
  });
  for (const [w, t] of [[320, 'light'], [375, 'dark'], [768, 'light'], [1280, 'dark'], [1440, 'light']]) {
    await check(`set new password: one surface, left-aligned, email from session, rules visible (${w}px ${t})`, async () => {
      const p = await pwPage({ width: w, theme: t });
      await p.waitForSelector('#pw-new'); await p.waitForFunction(() => document.querySelector('#pw-email').textContent.includes('@'));
      assert.equal(await p.evaluate(() => document.documentElement.dataset.surface), 'comic');
      assert.equal(await p.locator('.gate-glyph, svg.icon-lg, .pw-identity[style], .modal-hero').count(), 0);
      assert.equal(await p.locator('#pw-email').innerText(), 'fixture@example.test');
      assert.equal(await p.locator('#pw-current').getAttribute('type'), 'password');
      assert.equal(await p.locator('#pw-rules li').count(), 4);
      assert.equal(await p.locator('#pw-new').getAttribute('placeholder'), null);   // requirements are not placeholders
      assert.ok(isFlat(await flat(p, '.pw-identity')));
      assert.equal(await p.locator('h1').evaluate(el => getComputedStyle(el).textAlign), 'start');
      assert.equal(await p.locator('main button[type=submit]').count(), 1);
      assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      await p.screenshot({ path: path.join(out, `final-password-${w}-${t}.png`) });
      await p.context().close();
    });
  }
  await check('set new password: field-level errors, focus, no request on invalid input', async () => {
    const p = await pwPage(); await p.waitForSelector('#pw-new');
    await p.fill('#pw-new', 'abc'); await p.fill('#pw-confirm', 'abc'); await p.click('#pw-submit');
    assert.match(await p.locator('#pw-new-msg').innerText(), /at least 8 characters/);
    assert.equal(await p.locator('#pw-new').getAttribute('aria-invalid'), 'true');
    assert.equal(await p.evaluate(() => document.activeElement.id), 'pw-new');
    await p.fill('#pw-new', 'abcdefg1'); await p.fill('#pw-confirm', 'abcdefg2'); await p.click('#pw-submit');
    assert.match(await p.locator('#pw-confirm-msg').innerText(), /do not match/);
    assert.equal(await p.evaluate(() => document.activeElement.id), 'pw-confirm');
    assert.equal((await calls(p)).filter(c => c.method === 'updateUser').length, 0);
    await p.context().close();
  });
  await check('set new password: show-passwords is an accessible, non-submitting toggle', async () => {
    const p = await pwPage(); await p.waitForSelector('#pw-new');
    assert.equal(await p.getByLabel('Show passwords').count(), 1);
    await p.check('#pw-show-toggle');
    assert.equal(await p.locator('#pw-new').getAttribute('type'), 'text');
    assert.equal(await p.locator('#pw-confirm').getAttribute('type'), 'text');
    await p.uncheck('#pw-show-toggle');
    assert.equal(await p.locator('#pw-new').getAttribute('type'), 'password');
    assert.equal((await calls(p)).filter(c => c.method === 'updateUser').length, 0);
    await p.context().close();
  });
  await check('set new password: temporary password is required and stays hidden', async () => {
    const p = await pwPage(); await p.waitForSelector('#pw-current');
    await p.fill('#pw-new', 'abcdefg1'); await p.fill('#pw-confirm', 'abcdefg1');
    await p.click('#pw-submit');
    assert.match(await p.locator('#pw-current-msg').innerText(), /password you used to sign in/i);
    assert.equal(await p.evaluate(() => document.activeElement.id), 'pw-current');
    assert.equal((await calls(p)).filter(c => c.method === 'updateUser').length, 0);
    await p.check('#pw-show-toggle');
    assert.equal(await p.locator('#pw-current').getAttribute('type'), 'password');
    await p.context().close();
  });
  await check('set new password: rules show a text cue (not colour alone) when met', async () => {
    const p = await pwPage(); await p.waitForSelector('#pw-new');
    await p.fill('#pw-new', 'abcdefg1'); await p.fill('#pw-confirm', 'abcdefg1');
    const cues = await p.locator('#pw-rules li.is-met').evaluateAll(els => els.map(e => getComputedStyle(e, '::after').content));
    assert.equal(cues.length, 4); assert.ok(cues.every(c => /met/.test(c)), JSON.stringify(cues));
    await p.screenshot({ path: path.join(out, 'final-password-rules-met.png') });
    await p.context().close();
  });
  await check('set new password: pending state, confirmed success, then existing redirect', async () => {
    const p = await pwPage({ initial: { updateDelay: 700 } }); await p.waitForSelector('#pw-new');
    await p.fill('#pw-current', 'TempPass42');
    await p.fill('#pw-new', 'abcdefg1'); await p.fill('#pw-confirm', 'abcdefg1');
    await p.click('#pw-submit');
    assert.equal(await p.locator('#pw-submit').isDisabled(), true);
    assert.equal(await p.locator('#pw-submit').innerText(), 'Saving…');
    await p.screenshot({ path: path.join(out, 'final-password-pending.png') });
    await p.waitForURL(u => !/set-new-password/.test(u.pathname), { timeout: 5000 });
    assert.deepEqual(submitted, { pwKeys: ['password', 'current_password'] });
    await p.context().close();
  });
  await check('set new password: confirmed failure keeps the fields and re-enables submit', async () => {
    const p = await pwPage({ initial: { passwordError: { message: 'Password should be at least 8 characters', code: 'weak_password' } } }); await p.waitForSelector('#pw-new');
    await p.fill('#pw-current', 'TempPass42');
    await p.fill('#pw-new', 'abcdefg1'); await p.fill('#pw-confirm', 'abcdefg1'); await p.click('#pw-submit');
    await p.waitForFunction(() => document.querySelector('#pw-status').textContent.length > 0);
    assert.equal(await p.locator('#pw-status').evaluate(el => el.classList.contains('is-error')), true);
    assert.equal(await p.locator('#pw-status').evaluate(el => getComputedStyle(el, '::before').content), '"Error: "');
    assert.equal(await p.inputValue('#pw-new'), 'abcdefg1');
    assert.equal(await p.locator('#pw-submit').isEnabled(), true);
    assert.equal(new URL(p.url()).pathname, '/student/html/set-new-password.html');
    await p.screenshot({ path: path.join(out, 'final-password-error-375.png') });
    await p.context().close();
  });
  await check('set new password: unflagged students may change it or return to their page', async () => {
    const p = await pageFor('/student/html/set-new-password.html', { account: 'pw2', initial: { profile: { must_change_password: false } } });
    await p.waitForFunction(() => !document.body.classList.contains('opacity-0'));
    assert.match(await p.locator('h1').innerText(), /Change your password/);
    assert.equal(await p.locator('#pw-back').isVisible(), true);
    assert.match(await p.locator('#pw-back').getAttribute('href'), /student\/html\//);
    // A profile write from the OCEAN page must not pull this optional detour
    // back to the student's stage before they can change their password.
    await p.evaluate(() => window.fixture.stageUpdate?.({ new: { role: 'student', current_stage: 'OCEAN' } }));
    await p.waitForTimeout(150);
    assert.equal(new URL(p.url()).pathname, '/student/html/set-new-password.html');
    await p.context().close();
  });
  const zoomCss = 'html { font-size: 200% !important; }';
  await check('zoom 200%: OCEAN question reachable, no overflow (375x667)', async () => {
    const p = await startOcean({ width: 375, height: 667 });
    await p.addStyleTag({ content: zoomCss });
    await p.locator('#ocean-answer-list button[data-score="3"]').scrollIntoViewIfNeeded();
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    for (const id of ['#btn-next', '#btn-prev']) { await p.locator(id).scrollIntoViewIfNeeded(); assert.equal(await p.locator(id).isVisible(), true); }
    await p.screenshot({ path: path.join(out, 'zoom200-ocean-375.png') });
    await p.context().close();
  });
  await check('zoom 200%: dashboard + tutorial dialog reachable, Skip/Next usable, no overflow (375x667)', async () => {
    const p = await pageFor(dash, { width: 375, height: 667, account: 'zoom-dash' });
    await p.addStyleTag({ content: zoomCss });
    await dlg(p).waitFor();
    for (const id of ['#tutorial-skip', '#tutorial-next']) { await p.locator(id).scrollIntoViewIfNeeded(); const b = await p.locator(id).boundingBox(); assert.ok(b && b.x >= 0 && b.x + b.width <= 376, id + JSON.stringify(b)); }
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await p.screenshot({ path: path.join(out, 'zoom200-tutorial-375.png') });
    await p.locator('#tutorial-skip').click();
    await p.waitForFunction(() => !document.querySelector('#modal-tutorial.is-open'));
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await p.screenshot({ path: path.join(out, 'zoom200-dashboard-375.png') });
    await p.context().close();
  });
  const contrast = (p, sels) => p.evaluate(sels => {
    const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d'); canvas.width = canvas.height = 1;
    const rgb = c => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data]; };
    const lum = c => { const a = c.slice(0, 3).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return .2126 * a[0] + .7152 * a[1] + .0722 * a[2]; };
    return sels.map(sel => {
      const el = [...document.querySelectorAll(sel)].find(e => e.getClientRects().length); if (!el) return { sel, missing: true };
      let n = el, bg = [0, 0, 0, 0];
      while (n) { bg = rgb(getComputedStyle(n).backgroundColor); if (bg[3] === 255) break; n = n.parentElement; }
      if (bg[3] !== 255) bg = rgb(getComputedStyle(document.documentElement).getPropertyValue('--bg-body') || '#fff');
      const a = lum(rgb(getComputedStyle(el).color)), b = lum(bg);
      return { sel, ratio: Math.round(((Math.max(a, b) + .05) / (Math.min(a, b) + .05)) * 100) / 100 };
    });
  }, sels);
  for (const t of ['dark', 'light']) {
    await check(`contrast >= 4.5 (${t}): OCEAN, dashboard, tutorial`, async () => {
      const bad = [];
      let p = await startOcean({ theme: t });
      await p.locator('#ocean-answer-list button[data-score="3"]').click();
      for (const c of await contrast(p, ['#question-counter', '#question-text', '.answer-label', '#btn-prev', '#btn-next', '#submit-hint', '#progress-lbl', '#answered-tally'])) if (c.missing || c.ratio < 4.5) bad.push('ocean ' + JSON.stringify(c));
      await p.context().close();
      p = await pageFor(dash, { theme: t, account: 'contrast-' + t });
      await dlg(p).waitFor();
      for (const c of await contrast(p, ['#tutorial-step', '#tutorial-title', '#tutorial-text', '#tutorial-skip', '#tutorial-next', '#tutorial-back'])) if (c.missing || c.ratio < 4.5) bad.push('tutorial ' + JSON.stringify(c));
      await p.locator('#tutorial-skip').click();
      await p.waitForSelector('.tutorial-callout-text');
      for (const c of await contrast(p, ['.start-hello', '.start-lede', '.fact-label', '.fact-value', '#start-btn', '#tutorial-btn', '#signout-btn', '.tutorial-callout-text', '.agent-name'])) if (c.missing || c.ratio < 4.5) bad.push('dash ' + JSON.stringify(c));
      await p.context().close();
      assert.deepEqual(bad, []);
    });
  }
  await check('long text: very long name/first name does not overflow at 320px', async () => {
    const long = 'Bartholomew-Maximilian-Alexandrovich-Fitzgerald-Montgomery-Wolfeschlegelsteinhausenbergerdorff';
    const p = await pageFor(dash, { width: 320, account: 'long', initial: { profile: { full_name: long + ' Smith' } } });
    await p.waitForSelector('#start-btn'); await p.keyboard.press('Escape'); await p.waitForTimeout(150);
    const over = await p.evaluate(() => [...document.querySelectorAll('body *')].filter(e => e.getClientRects().length && e.getBoundingClientRect().right > innerWidth + 1).slice(0, 4).map(e => e.tagName + '.' + e.className));
    const clipped = await p.evaluate(() => [...document.querySelectorAll('h1, h2, p, dd, dt, .who-name, #pia-signout-who')].filter(e => e.getClientRects().length && e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).textOverflow !== 'ellipsis').map(e => e.tagName + '.' + e.className));
    await p.screenshot({ path: path.join(out, 'polish-long-name-320.png') });
    assert.deepEqual(over, []);
    assert.deepEqual(clipped, [], 'text clipped inside its box');
    await p.context().close();
  });
  await check('keyboard: quit dialog traps focus, Escape keeps the test, focus returns to the link', async () => {
    const p = await startOcean({ width: 1280 });
    await p.locator('#ocean-answer-list button[data-score="3"]').click();
    await p.locator('.brand-link').focus(); await p.keyboard.press('Enter');
    await p.waitForSelector('#quit-modal.modal-active');
    for (let i = 0; i < 4; i++) { await p.keyboard.press('Tab'); assert.equal(await p.evaluate(() => !!document.activeElement.closest('#quit-modal')), true); }
    await p.keyboard.press('Escape');
    await p.waitForFunction(() => !document.querySelector('#quit-modal.modal-active'));
    assert.equal(new URL(p.url()).pathname, ocean);
    await p.context().close();
  });
  await check('keyboard: Character Selection lock-in dialog closes with Escape and focus is restored', async () => {
    const p = await pageFor('/student/html/character-selection.html', { account: 'kbd-char', initial: { profile: { group_type: 'Non-Assigned', selected_character: null, is_ocean_done: true } } });
    await p.waitForSelector('.persona-card');
    await p.locator('.persona-card').first().click();
    await p.locator('#lock-in-btn').focus(); await p.keyboard.press('Enter');
    await p.waitForSelector('.overlay.modal-active, .overlay.is-open');
    await p.keyboard.press('Escape');
    await p.waitForFunction(() => !document.querySelector('.overlay.modal-active, .overlay.is-open'));
    assert.equal(await p.evaluate(() => document.activeElement.id), 'lock-in-btn');
    await p.context().close();
  });
  /* ---------------- CHARACTER SELECTION (visual + surface only) ---------------- */
  for (const [w, t] of [[320, 'light'], [375, 'dark'], [1280, 'dark'], [1440, 'light']]) {
    await check(`character selection renders on the comic surface at ${w}px ${t} without overflow`, async () => {
      const p = await pageFor('/student/html/character-selection.html', { width: w, theme: t, account: 'char', initial: { profile: { group_type: 'Non-Assigned', selected_character: null, is_ocean_done: true } } });
      await p.waitForSelector('.persona-card', { timeout: 5000 });
      assert.equal(await p.evaluate(() => document.documentElement.dataset.surface), 'comic');
      const over = await p.evaluate(() => [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > window.innerWidth + 1).slice(0, 5).map(e => e.tagName + '.' + e.className + ' ' + Math.round(e.getBoundingClientRect().right)));
      await p.screenshot({ path: path.join(out, `character-${w}-${t}.png`) });
      assert.deepEqual(over, [], 'elements past viewport');
      await p.context().close();
    });
  }
  await check('redesign: OCEAN question controls stay put across all 50 prompts at 320px', async () => {
    const p = await startOcean({ width: 320, theme: 'light' });
    const positions = [];
    for (let i = 0; i < 50; i++) {
      positions.push(await p.evaluate(() => {
        const y = selector => document.querySelector(selector).getBoundingClientRect().top + scrollY;
        return [y('.answer-list'), y('.test-nav')];
      }));
      if (i < 49) await p.locator('#btn-next').click();
    }
    for (const col of [0, 1]) {
      const values = positions.map(row => row[col]);
      const max = Math.max(...values), min = Math.min(...values);
      assert.ok(max - min <= 1, `question content shifts controls by ${max - min}px at question ${values.indexOf(max) + 1}; first ${values.slice(0, 6).join(', ')}; last ${values.slice(-3).join(', ')}`);
    }
    await p.context().close();
  });
  await check('redesign: mobile tutor choices come first and preview stays steady', async () => {
    const p = await pageFor('/student/html/character-selection.html', { width: 320, theme: 'light', account: 'char-redesign', initial: { profile: { group_type: 'Non-Assigned', selected_character: null, is_ocean_done: true } } });
    await p.waitForSelector('.persona-card');
    const order = await p.evaluate(() => ['.pick-head', '.persona-grid', '.preview-card'].map(s => document.querySelector(s).getBoundingClientRect().top + scrollY));
    assert.ok(order[0] < order[1] && order[1] < order[2], 'instructions and choices precede preview');
    const heights = [];
    for (const card of await p.locator('.persona-card').all()) {
      await card.click();
      heights.push(await p.locator('.preview-card').evaluate(el => el.getBoundingClientRect().height));
    }
    assert.ok(Math.max(...heights) - Math.min(...heights) <= 1, 'tutor copy shifts the preview: ' + heights.join(', '));
    await p.screenshot({ path: path.join(out, 'redesign-character-320.png') });
    await p.locator('#lock-in-btn').click();
    assert.equal(await p.locator('#confirm-modal [data-action="close"]').count(), 1);
    assert.equal(await p.locator('#confirm-modal .modal-close').count(), 0);
    await p.context().close();
  });
  await check('redesign: dashboard work comes first and each sign-out state has one control', async () => {
    const p = await pageFor(dash, { width: 375, account: 'dash-redesign' });
    await p.locator('#tutorial-skip').click();
    await p.waitForSelector('#modal-tutorial.is-mounted', { state: 'detached' });
    await p.evaluate(() => { document.querySelector('#screen-start').classList.remove('is-active'); document.querySelector('#screen-session').classList.add('is-active'); });
    // The original game arrangement stacks on a phone: tutor, then the workspace, then the notebook.
    const geo = await p.evaluate(() => ['.left-sidebar', '.center-panel', '.right-sidebar'].map(sel => { const r = document.querySelector(sel).getBoundingClientRect(); return [r.top + scrollY, r.bottom + scrollY]; }));
    assert.ok(geo[0][1] <= geo[1][0] + 2 && geo[1][1] <= geo[2][0] + 2, 'tutor, workspace, notebook in order');
    assert.ok(geo[0][1] - geo[0][0] <= 560, 'the tutor block is a bounded height on a phone');
    await p.screenshot({ path: path.join(out, 'redesign-dashboard-work-375.png') });
    assert.equal(await p.locator('#signout-btn:visible').count(), 1);
    assert.equal(await p.locator('#summary-signout').count(), 0);
    await p.locator('#signout-btn').click();
    await p.waitForSelector('#modal-confirm.is-open');
    assert.equal(await p.locator('#modal-confirm [data-modal-close]').count(), 1);
    assert.equal(await p.locator('#modal-confirm .modal-close').count(), 0);
    await p.context().close();
  });
  await check('redesign: password validation does not move fields or submit at 320px', async () => {
    const p = await pwPage({ width: 320, theme: 'light' });
    await p.waitForFunction(() => document.querySelector('#pw-email').textContent.includes('@'));
    const positions = () => p.evaluate(() => ['#pw-confirm', '#pw-submit'].map(s => document.querySelector(s).getBoundingClientRect().top + scrollY));
    const before = await positions();
    await p.fill('#pw-new', 'abc');
    await p.fill('#pw-confirm', 'abc');
    await p.click('#pw-submit');
    const after = await positions();
    assert.ok(after.every((y, i) => Math.abs(y - before[i]) <= 1), `password controls moved: ${before} -> ${after}`);
    await p.screenshot({ path: path.join(out, 'redesign-password-errors-320.png') });
    await p.context().close();
  });
  await check('redesign: Character Selection uses the same tutor art as the game (all six)', async () => {
    let p = await pageFor('/student/html/character-selection.html', { account: 'char-art', initial: { profile: { group_type: 'Non-Assigned', selected_character: null, is_ocean_done: true } } });
    await p.waitForSelector('.persona-card');
    await p.waitForFunction(() => [...document.querySelectorAll('.persona-card img')].slice(0, 5).every(img => img.complete && img.naturalWidth > 0));
    const art = await p.locator('.persona-card').evaluateAll(cards => cards.map(card => ({
      key: card.dataset.character,
      src: card.querySelector('img')?.getAttribute('src') || '',
      loaded: (card.querySelector('img')?.naturalWidth || 0) > 0,
      fallback: card.querySelector('.persona-thumb').hasAttribute('data-mono')
    })));
    const folders = [
      ['pia-open', 'Openness'], ['pia-conscientious', 'Conscientiousness'],
      ['pia-extravert', 'Extraverted'], ['pia-agreeable', 'Agreeableness'],
      ['pia-calm', 'Neuroticism']
    ];
    art.slice(0, 5).forEach((item, index) => {
      assert.equal(item.key, folders[index][0]);
      assert.match(item.src, new RegExp(`personas/${folders[index][1]}/default\\.webp$`));
      assert.equal(item.loaded, true, item.key + ' art missing');
      assert.equal(item.fallback, false, item.key + ' fell back to monogram');
    });
    assert.match(art[5].src, /personas\/Neutral\/default\.webp$/);
    assert.equal(art[5].loaded, true); assert.equal(art[5].fallback, false, 'Neutral now has real art');
    await p.screenshot({ path: path.join(out, 'redesign-cast-1280.png') });
    await p.context().close();
    p = await pageFor(dash, { account: 'dash-neutral', initial: { profile: { selected_character: 'pia-neutral' } } });
    await p.waitForSelector('#start-btn');
    /* Step game: PIA Neutral now has real art (Personas/Neutral), so the monogram placeholder is no longer used. */
    assert.match(await p.locator('#agent-img-start').getAttribute('src'), /personas\/Neutral\/default\.webp$/);   // the game's 3D-style Neutral art
    await p.context().close();
  });
  await check('no request left the loopback server', async () => { assert.deepEqual(leaked.filter(u => /supabase\.co/.test(u)), []); });

  await browser.close(); server.close();
  fs.writeFileSync(path.join(out, 'results-b2.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  process.exit(results.some(r => r.error || r.pass === false) ? 1 : 0);
})();
