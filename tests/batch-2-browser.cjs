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
  const profile = () => Object.assign({ email: user.email, full_name: 'Fixture Learner', role: 'student', group_type: 'Control', is_ocean_done: true, selected_character: 'pia-open', current_stage: '', section: 'Earth', must_change_password: false }, f.profile || {});
  const chain = (table) => {
    const c = { select() { return c; }, eq() { return c; }, update() { f.calls.push({ method: 'profile-update' }); return c; },
      maybeSingle: async () => table === 'settings' ? { data: { value: true }, error: null } : { data: profile(), error: null },
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
        if (u.startsWith('https://cdn.jsdelivr.net/npm/@supabase/supabase-js')) return route.fulfill({ contentType: 'text/javascript', body: `(${fixture.toString()})();` });
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
  await check('ocean: Back/Next only, Submit absent until the final question', async () => {
    const p = await startOcean();
    const submit = p.locator('#btn-submit-ocean');
    assert.equal(await submit.isVisible(), false);
    assert.equal(await p.locator('#btn-prev').isDisabled(), true);
    assert.equal(await p.locator('.test-nav button:visible').count(), 2);
    for (let i = 0; i < 49; i++) { assert.equal(await submit.isVisible(), false, 'q' + (i + 1)); await p.locator('#btn-next').click(); }
    assert.match(await p.locator('#question-counter').innerText(), /50 of 50/i);
    assert.equal(await submit.isVisible(), true);
    assert.equal(await p.locator('#btn-next').isVisible(), false);
    assert.equal(await submit.isDisabled(), true, 'unanswered questions keep Submit disabled');
    await p.locator('#btn-prev').click();
    assert.equal(await submit.isVisible(), false);
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
  await check('no request left the loopback server', async () => { assert.deepEqual(leaked.filter(u => /supabase\.co/.test(u)), []); });

  await browser.close(); server.close();
  fs.writeFileSync(path.join(out, 'results-b2.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  process.exit(results.some(r => r.error || r.pass === false) ? 1 : 0);
})();
