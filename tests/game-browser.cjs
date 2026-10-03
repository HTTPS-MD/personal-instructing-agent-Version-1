/* Isolated browser verification for the step-by-step game (student-dashboard).
   Loopback only; the Supabase SDK is replaced by tests/fixtures/game-supabase-mock.js,
   a JS re-statement of the migration-0039 rules. It proves the PAGE (routing, wiring,
   layout, keyboard, no key in any response). The SQL itself is exercised separately by
   supabase/scratch/game_0039_test.sql on a scratch PostgreSQL. */
const { chromium } = require('playwright');
const { createServer } = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const out = process.env.PIA_TEST_OUTPUT || '/tmp/pia-game-evidence';
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
const mock = fs.readFileSync(path.join(__dirname, 'fixtures', 'game-supabase-mock.js'), 'utf8');
const DASH = '/student/html/student-dashboard.html';

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PIA_CHROME, args: ['--disable-background-networking'] });
  const results = [];
  const leaked = [];

  async function open(url, { width = 1280, height = 900, profile = { group_type: 'Assigned', selected_character: 'pia-open' }, theme = 'dark', limit = 600, ctx } = {}) {
    const context = ctx || await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    if (!ctx) {
      await context.addInitScript(([p, t, l]) => { if (!sessionStorage.getItem('__limit_set')) { localStorage.setItem('__mock_limit', String(l)); sessionStorage.setItem('__limit_set', '1'); } localStorage.setItem('__mock_profile', JSON.stringify(p)); localStorage.setItem('pia_theme', t); localStorage.setItem('pia_user_email', 'student@example.test'); localStorage.setItem('pia_user_role', 'student'); }, [profile, theme, limit]);
      await context.route('**/*', route => {
        const u = route.request().url();
        if (u.startsWith(origin + '/')) return route.continue();
        if (u.startsWith('https://cdn.jsdelivr.net/npm/@supabase/supabase-js')) return route.fulfill({ contentType: 'text/javascript', body: mock });
        leaked.push(u); return route.abort('blockedbyclient');
      });
    }
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    page.on('pageerror', e => results.push({ name: 'pageerror ' + url, pass: false, message: e.message }));
    await page.goto(origin + url);
    return page;
  }
  async function check(name, fn) {
    if (process.env.PIA_TEST_FILTER && !name.includes(process.env.PIA_TEST_FILTER)) return;
    try { await fn(); results.push({ name, pass: true }); } catch (e) { results.push({ name, pass: false, message: String(e.message).slice(0, 400) }); }
  }
  const start = async p => { await p.waitForSelector('#start-btn'); await p.keyboard.press('Escape'); await p.locator('#start-btn').click(); await p.waitForSelector('#step-input'); };
  const submit = async (p, v) => { await p.fill('#step-input', v); await p.keyboard.press('Enter'); await p.waitForTimeout(200); };
  const bank = p => p.evaluate(() => window.__bank);
  async function solveCurrent(p) {
    const q = await p.locator('#problem-expression').innerText();
    const b = (await bank(p)).find(x => x.question === q);
    const done = await p.locator('.step.is-done').count();
    await submit(p, b.steps[done].answer);
    return b;
  }
  async function finishQuestion(p) {
    const q = await p.locator('#problem-expression').innerText();
    const b = (await bank(p)).find(x => x.question === q);
    for (let i = 0; i < b.steps.length; i++) { await submit(p, b.steps[i].answer); }
    await p.waitForFunction(q0 => document.querySelector('#problem-expression').textContent !== q0 || document.querySelector('#modal-offer.is-open'), q, { timeout: 5000 });
  }
  const settle = (p, sel, path_) => p.waitForFunction(x => location.pathname === x, path_);

  /* ---------------- routes ---------------- */
  const away = '/student/html/assessment-complete.html';
  for (const [name, profile, expectPath] of [
    ['Control with a tutor, direct URL -> thank-you screen', { group_type: 'Control', selected_character: 'pia-open' }, away],
    ['Control without a tutor, direct URL -> thank-you screen', { group_type: 'control', selected_character: null }, away],
    ['Free choice without a tutor -> Character Selection', { group_type: 'Non-Assigned', selected_character: null }, '/student/html/character-selection.html'],
    ['OCEAN not done -> questionnaire', { group_type: 'Assigned', selected_character: 'pia-open', is_ocean_done: false }, '/student/html/ocean-test.html'],
    ['Assigned with a tutor -> game page', { group_type: 'Assigned', selected_character: 'pia-open' }, DASH],
    ['Free choice with PIA Neutral -> game page', { group_type: 'Non-Assigned', selected_character: 'pia-neutral' }, DASH],
    ['Legacy neutral group with a tutor -> game page', { group_type: 'neutral', selected_character: 'pia-neutral' }, DASH]
  ]) {
    await check('route: ' + name, async () => {
      const p = await open(DASH, { profile });
      await p.waitForFunction(x => location.pathname === x, expectPath, { timeout: 5000 });
      await p.context().close();
    });
  }
  await check('route: Control cannot reach Character Selection or the waiting room either', async () => {
    for (const u of ['/student/html/character-selection.html', '/student/html/waiting-room.html']) {
      const p = await open(u, { profile: { group_type: 'Control', selected_character: null } });
      await p.waitForFunction(x => location.pathname === x, away, { timeout: 5000 });
      assert.equal(await p.locator('#btn-continue:visible').count(), 0);
      await p.context().close();
    }
  });
  await check('route: Assigned with NO tutor loads the page, shows the notice, cannot start, no tutor is chosen', async () => {
    const p = await open(DASH, { profile: { group_type: 'Assigned', selected_character: null } });
    await p.waitForSelector('#global-error-banner:not([hidden])');
    assert.match(await p.locator('#global-error-message').innerText(), /not been assigned/i);
    assert.equal(await p.locator('#start-btn').isDisabled(), true);
    assert.equal(await p.evaluate(() => (document.querySelector('#agent-img-start').getAttribute('src') || '').includes('/tutors/')), false);
    assert.equal(await p.evaluate(() => window.__calls.some(c => c.m === 'rpc' && /serve_next|check_step/.test(c.name))), false);
    await p.context().close();
  });
  await check('direct URL with ?group=control&selected_character=...&student_id= changes nothing', async () => {
    const p = await open(DASH + '?group=control&group_type=control&selected_character=pia-open&student_id=5', { profile: { group_type: 'Assigned', selected_character: 'pia-calm' } });
    await p.waitForSelector('#start-btn');
    assert.match(await p.locator('#agent-img-start').getAttribute('src'), /pia-calm\//);
    assert.equal(await p.evaluate(() => location.pathname), DASH);
    await p.context().close();
  });
  await check('localStorage tutor/group cannot change the tutor (selected_character, pia_student_id, group_type set there are ignored)', async () => {
    const p = await open(DASH, { profile: { group_type: 'Assigned', selected_character: 'pia-agreeable' } });
    await p.evaluate(() => { localStorage.setItem('selected_character', 'pia-calm'); localStorage.setItem('pia_student_id', '9'); localStorage.setItem('group_type', 'control'); });
    await p.reload(); await p.waitForSelector('#start-btn');
    assert.match(await p.locator('#agent-img-start').getAttribute('src'), /pia-agreeable\//);
    await p.context().close();
  });

  /* ---------------- tutor display ---------------- */
  for (const key of ['pia-open', 'pia-conscientious', 'pia-extravert', 'pia-agreeable', 'pia-calm', 'pia-neutral']) {
    await check('tutor display: ' + key + ' (start screen + game, art loads)', async () => {
      const p = await open(DASH, { profile: { group_type: 'Assigned', selected_character: key } });
      await start(p);
      const src = await p.locator('#agent-img').getAttribute('src');
      assert.ok(src.includes('/tutors/' + key + '/'), src);
      assert.equal(await p.evaluate(() => document.querySelector('#agent-img').naturalWidth > 0), true);
      assert.equal(await p.evaluate(() => document.querySelector('#agent-img-start').naturalWidth > 0), true);
      await p.context().close();
    });
  }

  await check('art consistency: the Character Selection card art for each key is the very file the game shows (pia-calm excluded, pending)', async () => {
    const sel = await open('/student/html/character-selection.html', { profile: { group_type: 'Non-Assigned', selected_character: null } });
    await sel.waitForSelector('.persona-card');
    const cards = await sel.locator('.persona-card').evaluateAll(c => c.map(x => [x.dataset.character, x.querySelector('img').getAttribute('src')]));
    await sel.screenshot({ path: path.join(out, 'character-selection.png') });
    await sel.context().close();
    for (const [key, src] of cards) {
      if (key === 'pia-calm') continue;
      const p = await open(DASH, { profile: { group_type: 'Assigned', selected_character: key } });
      await start(p);
      const game = await p.locator('#agent-img').getAttribute('src');
      assert.equal(game.replace(/^\.\.\/\.\.\//, ''), src.replace(/^\.\.\/\.\.\//, '').replace('approval', key === 'pia-neutral' ? 'approval' : 'default'), key);
      await p.context().close();
    }
  });

  /* ---------------- removed elements ---------------- */
  await check('removed: top strip (timer-badge element), ML test badge, Start Over, Guest Student, color picker, big header, character choice', async () => {
    const p = await open(DASH);
    await start(p);
    const html = await p.evaluate(() => document.documentElement.outerHTML);
    for (const bad of ['timer-badge', 'ML TEST', 'Start Over', 'Guest Student', 'changeTheme', 'PIA Tutorial Assistant', 'selection-overlay', 'Choose Your Learning Mentor', 'action-bar', 'logo-mark']) assert.equal(html.includes(bad), false, bad);
    assert.equal(await p.locator('.dot, .action-bar, header .timer-badge').count(), 0);
    await p.context().close();
  });

  /* ---------------- the step game ---------------- */
  await check('steps: wrong answers, hint gating, tiers, working -> confirm -> value, completed steps stay visible', async () => {
    const p = await open(DASH);
    await start(p);
    assert.equal(await p.locator('#hint-btn').isVisible(), false, 'hint hidden before two wrong answers');
    await submit(p, '777');
    assert.equal(await p.locator('#hint-btn').isVisible(), false);
    await submit(p, '778');
    assert.equal(await p.locator('#hint-btn').isVisible(), true, 'hint shown after two wrong answers');
    assert.match(await p.locator('#error-list').innerText(), /Error on "777"/);
    await p.locator('#hint-btn').click(); await p.waitForSelector('#step-hint:not([hidden])');
    assert.match(await p.locator('#hint-tier-label').innerText(), /Tier 1\//);
    const q = await p.locator('#problem-expression').innerText();
    const b = (await bank(p)).find(x => x.question === q);
    const pct = q.match(/(\d+)%/)[1];
    await submit(p, pct + '/100');
    assert.match(await p.locator('.step-note').innerText(), /Correct calculation/);
    assert.equal(await p.locator('#step-hint').isHidden(), true, 'hint clears when the confirm box opens');
    await submit(p, pct + '%');
    assert.match(await p.locator('#step-feedback').innerText(), /decimal value only/);
    await submit(p, b.steps[0].answer);
    assert.equal(await p.locator('.step.is-done').count(), 1);
    assert.equal(await p.locator('.step.is-done output').count(), 2, 'working and confirmed value both shown');
    await submit(p, b.steps[1].answer);
    await p.waitForFunction(q0 => document.querySelector('#problem-expression').textContent !== q0, q, { timeout: 5000 });
    assert.equal(await p.locator('#stat-solved').innerText(), '1');
    assert.equal(await p.locator('#solved-list > li').count(), 1);
    await p.context().close();
  });
  await check('offer: appears after 3 clean questions, Escape/backdrop do not dismiss, reload brings it back, Accept moves topic', async () => {
    const p = await open(DASH);
    await start(p);
    for (let i = 0; i < 3; i++) await finishQuestion(p);
    await p.waitForSelector('#modal-offer.is-open');
    await p.keyboard.press('Escape');
    await p.mouse.click(5, 5);
    assert.equal(await p.locator('#modal-offer.is-open').count(), 1);
    await p.reload(); await p.waitForSelector('#start-btn'); await p.keyboard.press('Escape'); await p.locator('#start-btn').click();
    await p.waitForSelector('#modal-offer.is-open');
    await p.locator('#offer-accept').click();
    await p.waitForSelector('#step-input');
    assert.equal(await p.locator('#stat-level').innerText(), '2');
    assert.equal(await p.locator('.step-title').count(), 1);
    await p.context().close();
  });
  await check('offer: Stay keeps the topic; Tab stays inside the dialog', async () => {
    const p = await open(DASH);
    await start(p);
    for (let i = 0; i < 3; i++) await finishQuestion(p);
    await p.waitForSelector('#modal-offer.is-open');
    for (let i = 0; i < 4; i++) { await p.keyboard.press('Tab'); assert.equal(await p.evaluate(() => !!document.activeElement.closest('#modal-offer')), true); }
    await p.locator('#offer-stay').click();
    await p.waitForSelector('#step-input');
    assert.equal(await p.locator('#stat-level').innerText(), '1');
    await p.context().close();
  });
  await check('resume: reload mid-question restores finished steps, the confirm box and the hint button', async () => {
    const p = await open(DASH);
    await start(p);
    await submit(p, '1'); await submit(p, '2');
    const q = await p.locator('#problem-expression').innerText();
    const pct = q.match(/(\d+)%/)[1];
    await submit(p, pct + '/100');
    await p.reload(); await p.waitForSelector('#start-btn');
    await p.waitForFunction(() => /Continue/.test(document.querySelector('#start-btn-label').textContent));
    await p.keyboard.press('Escape'); await p.locator('#start-btn').click(); await p.waitForSelector('#step-input');
    assert.equal(await p.locator('#problem-expression').innerText(), q);
    assert.match(await p.locator('.step-note').innerText(), /Correct calculation/);
    assert.equal(await p.locator('#hint-btn').isVisible(), true);
    await p.context().close();
  });
  await check('no 10-question ending: 16 questions in a row, still in the game, repeats allowed, never the same one twice running', async () => {
    const p = await open(DASH);
    await start(p);
    const seen = [];
    for (let i = 0; i < 16; i++) {
      if (await p.locator('#modal-offer.is-open').count()) { await p.locator('#offer-stay').click(); await p.waitForSelector('#step-input'); }
      seen.push(await p.locator('#problem-expression').innerText());
      await finishQuestion(p);
      if (await p.locator('#modal-offer.is-open').count()) { await p.locator('#offer-stay').click(); }
      await p.waitForSelector('#step-input');
    }
    assert.equal(await p.locator('#screen-session.is-active').count(), 1);
    assert.equal(await p.locator('#stat-solved').innerText(), '16');
    for (let i = 1; i < seen.length; i++) assert.notEqual(seen[i], seen[i - 1], 'same question twice in a row');
    assert.ok(new Set(seen).size < seen.length, 'bank cycled and repeated');
    const names = await p.evaluate(() => [...new Set(window.__calls.filter(c => c.m === 'rpc').map(c => c.name))]);
    for (const old of ['serve_next_question', 'check_question_answer', 'consume_question_hint', 'reveal_question_solution', 'record_question_result', 'end_game_session']) assert.equal(names.includes(old), false, old);
    assert.equal(await p.evaluate(() => window.__responses.filter(r => /"answer"|final_answer|stepAnswer/.test(r.body)).length), 0);
    await p.context().close();
  });

  /* ---------------- the time limit ---------------- */
  await check('clock: shown in the progress card as mm:ss (role=timer), counts down, start screen states the limit', async () => {
    const p = await open(DASH, { limit: 600 });
    await p.waitForFunction(() => /10 mins/.test(document.querySelector('#fact-limit').textContent));
    await start(p);
    assert.match(await p.locator('#time-left').innerText(), /^(10:00|09:5\d)$/);
    assert.equal(await p.locator('#time-left').getAttribute('role'), 'timer');
    assert.equal(await p.locator('.progress-card #time-left').count(), 1, 'inside the redesigned game, not a top strip');
    const a = await p.locator('#time-left').innerText(); await p.waitForTimeout(1300);
    assert.notEqual(await p.locator('#time-left').innerText(), a, 'counts down');
    await p.context().close();
  });
  await check('clock: one continuous deadline - questions, topics and a page reload do not reset it', async () => {
    const p = await open(DASH, { limit: 600 });
    await start(p);
    const w1 = await p.evaluate(() => window.__mockWindow().deadline);
    await finishQuestion(p); await finishQuestion(p);
    assert.equal(await p.evaluate(() => window.__mockWindow().deadline), w1);
    await p.reload(); await p.waitForSelector('#start-btn'); await p.keyboard.press('Escape'); await p.locator('#start-btn').click(); await p.waitForSelector('#step-input');
    assert.equal(await p.evaluate(() => window.__mockWindow().deadline), w1, 'reload did not give more time');
    await p.context().close();
  });
  await check('clock: low-time warning style and polite screen-reader announcements; expiry announced', async () => {
    const p = await open(DASH, { limit: 32 });
    await start(p);
    await p.waitForFunction(() => /30 seconds left/.test(document.querySelector('#time-announce').textContent), null, { timeout: 8000 });
    assert.equal(await p.locator('#time-left.is-low').count(), 1);
    assert.equal(await p.locator('#time-announce').getAttribute('aria-live'), 'polite');
    await p.waitForSelector('#modal-time.is-open', { timeout: 40000 });
    assert.match(await p.locator('#time-announce').innerText(), /Time limit reached/);
    await p.context().close();
  });
  await check('expiry: dialog with limit/started/finished/spent, inputs locked, not dismissible, focus trapped, Try again restarts the problem', async () => {
    const p = await open(DASH, { limit: 4 });
    await start(p);
    const q = await p.locator('#problem-expression').innerText();
    await submit(p, '9'); await submit(p, '8');          // two errors, hint unlocked
    await p.waitForSelector('#modal-time.is-open', { timeout: 8000 });
    assert.equal(await p.locator('#modal-time').getAttribute('role'), 'alertdialog');
    assert.match(await p.locator('#time-limit').innerText(), /4 secs/);
    assert.match(await p.locator('#time-started').innerText(), /\d/); assert.match(await p.locator('#time-finished').innerText(), /\d/);
    assert.match(await p.locator('#time-spent').innerText(), /sec/);
    assert.equal(await p.locator('#step-input').isDisabled(), true); assert.equal(await p.locator('#step-submit').isDisabled(), true); assert.equal(await p.locator('#hint-btn').isDisabled(), true);
    assert.match(await p.locator('#agent-speech').innerText(), /Time is up/);
    await p.keyboard.press('Escape'); await p.mouse.click(4, 4);
    assert.equal(await p.locator('#modal-time.is-open').count(), 1, 'cannot be dismissed');
    for (let i = 0; i < 3; i++) { await p.keyboard.press('Tab'); assert.equal(await p.evaluate(() => !!document.activeElement.closest('#modal-time')), true); }
    await p.screenshot({ path: path.join(out, 'game-time-expired.png') });
    await p.evaluate(() => localStorage.setItem('__mock_limit', '600'));
    await p.locator('#time-retry').click();
    await p.waitForFunction(() => !document.querySelector('#modal-time.is-open'));
    assert.equal(await p.locator('#problem-expression').innerText(), q, 'same problem reloaded');
    assert.equal(await p.locator('.step').count(), 1, 'from step 1'); assert.equal(await p.locator('#step-input').isDisabled(), false);
    assert.equal(await p.locator('#hint-btn').isVisible(), false, 'errors and hints back at zero');
    assert.match(await p.locator('#time-left').innerText(), /^(10:00|09:5\d)$/, 'fresh limit');
    assert.equal(await p.evaluate(() => window.__mockWindow().no), 2);
    await submit(p, '7'); assert.match(await p.locator('#step-feedback').innerText(), /Incorrect/);
    await p.context().close();
  });
  await check('expiry: an answer sent after the server says time is up is refused and shows the dialog; reload while expired shows it again', async () => {
    const p = await open(DASH, { limit: 600 });
    await start(p);
    await p.evaluate(() => window.__mockExpireNow());
    await submit(p, '9');
    await p.waitForSelector('#modal-time.is-open');
    assert.equal(await p.locator('#error-list li').count(), 0, 'the refused answer is not counted');
    await p.reload(); await p.waitForSelector('#start-btn'); await p.keyboard.press('Escape'); await p.locator('#start-btn').click();
    await p.waitForSelector('#modal-time.is-open');
    assert.equal(await p.locator('#time-retry').isVisible(), true);
    await p.context().close();
  });
  await check('expiry: topic progress and topic are kept across Try again', async () => {
    const p = await open(DASH, { limit: 600 });
    await start(p);
    for (let i = 0; i < 3; i++) await finishQuestion(p);
    await p.waitForSelector('#modal-offer.is-open'); await p.locator('#offer-accept').click(); await p.waitForSelector('#step-input');
    assert.equal(await p.locator('#stat-level').innerText(), '2');
    await p.evaluate(() => window.__mockExpireNow()); await submit(p, '1');
    await p.waitForSelector('#modal-time.is-open'); await p.locator('#time-retry').click();
    await p.waitForFunction(() => !document.querySelector('#modal-time.is-open'));
    assert.equal(await p.locator('#stat-level').innerText(), '2'); assert.equal(await p.locator('#stat-solved').innerText(), '3');
    await p.context().close();
  });
  await check('privacy: no ocean_* column is ever selected by the game page', async () => {
    const p = await open(DASH); await start(p);
    assert.equal(await p.evaluate(() => JSON.stringify(window.__calls).includes('ocean_')), false);
    await p.context().close();
  });

  /* ---------------- layout, keyboard, mobile ---------------- */
  for (const w of [320, 375, 768, 1024, 1280]) {
    await check(`layout ${w}px: no horizontal scroll, input and submit visible, tutor figure shown`, async () => {
      const p = await open(DASH, { width: w, height: w < 500 ? 740 : 800 });
      await start(p);
      await submit(p, '9'); await submit(p, '8');
      assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'horizontal overflow');
      const r = await p.evaluate(() => { const i = document.querySelector('#step-input').getBoundingClientRect(), s = document.querySelector('#step-submit').getBoundingClientRect(), f = document.querySelector('#agent-img').getBoundingClientRect(); return { iw: i.width, sw: s.width, fh: f.height, fw: f.width, ib: i.bottom, ih: innerHeight }; });
      assert.ok(r.iw >= 150 && r.sw >= 100 && r.fh >= 100 && r.fw >= 40, JSON.stringify(r));
      await p.screenshot({ path: path.join(out, `game-${w}.png`) });
      await p.context().close();
    });
  }
  await check('layout shift: tutor column, progress, input and submit do not move on wrong answers or hints (1280)', async () => {
    const p = await open(DASH); await start(p);
    const snap = () => p.evaluate(() => ['.tutor-bubble', '.tutor-figure', '.tutor-name', '#hint-btn', '.progress-card', '#step-input', '#step-submit'].map(s => { const b = document.querySelector(s).getBoundingClientRect(); return [s, Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)].join(); }));
    const base = await snap();
    await submit(p, '7'); assert.deepEqual(await snap(), base);
    await submit(p, '8'); assert.deepEqual(await snap(), base);
    await p.locator('#hint-btn').click(); await p.waitForTimeout(300); assert.deepEqual(await snap(), base);
    await p.context().close();
  });
  await check('keyboard: Enter submits, focus returns to the input after a wrong answer, hint reachable by Tab/Enter', async () => {
    const p = await open(DASH); await start(p);
    assert.equal(await p.evaluate(() => document.activeElement.id), 'step-input');
    await submit(p, '5'); await submit(p, '6');
    assert.equal(await p.evaluate(() => document.activeElement.id), 'step-input');
    await p.focus('#hint-btn'); await p.keyboard.press('Enter'); await p.waitForSelector('#step-hint:not([hidden])');
    assert.equal(await p.evaluate(() => document.activeElement.id), 'step-input');
    await p.context().close();
  });
  await check('mobile 375: hint and tutor stay a compact row above the work; trail comes after the work', async () => {
    const p = await open(DASH, { width: 375, height: 740 }); await start(p);
    const g = await p.evaluate(() => ({ tutor: document.querySelector('.tutor').getBoundingClientRect().height, input: document.querySelector('#step-input').getBoundingClientRect().bottom, trail: document.querySelector('.trail').getBoundingClientRect().top + scrollY, work: document.querySelector('.work').getBoundingClientRect().bottom + scrollY }));
    assert.ok(g.tutor <= 260, JSON.stringify(g)); assert.ok(g.input <= 740, JSON.stringify(g)); assert.ok(g.trail >= g.work - 1, JSON.stringify(g));
    await p.context().close();
  });
  await check('light theme renders the game (smoke)', async () => {
    const p = await open(DASH, { theme: 'light' }); await start(p);
    await p.screenshot({ path: path.join(out, 'game-light.png') });
    await p.context().close();
  });
  await check('network: only loopback requests were made (everything else blocked)', async () => { assert.deepEqual(leaked.filter(u => !/fonts\.(googleapis|gstatic)\.com/.test(u)), []); });

  await browser.close(); server.close();
  const pass = results.filter(r => r.pass).length, fail = results.filter(r => r.pass === false);
  console.log(JSON.stringify({ pass, fail: fail.length, total: results.length, failures: fail }, null, 1));
  process.exit(fail.length ? 1 : 0);
})();
