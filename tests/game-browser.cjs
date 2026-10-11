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
  let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  /* Cloudflare Pages serves clean URLs: /x/y serves x/y.html (and x/y.html redirects to it). */
  if (!path.extname(pathname) && fs.existsSync(path.resolve(root, '.' + pathname + '.html'))) pathname += '.html';
  const file = path.resolve(root, '.' + pathname);
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

  async function open(url, { width = 1280, height = 900, profile = { group_type: 'Assigned', selected_character: 'pia-open' }, theme = 'dark', limit = 600, block = null, poll = null, motion = 'reduce', ctx } = {}) {
    const context = ctx || await browser.newContext({ viewport: { width, height }, reducedMotion: motion, serviceWorkers: 'block' });
    if (!ctx) {
      await context.addInitScript(([p, t, l, pm]) => { if (pm) window.PIA_TUTORING_POLL_MS = pm; if (!sessionStorage.getItem('__limit_set')) { localStorage.setItem('__mock_limit', String(l)); sessionStorage.setItem('__limit_set', '1'); } localStorage.setItem('__mock_profile', JSON.stringify(p)); localStorage.setItem('pia_theme', t); localStorage.setItem('pia_user_email', 'student@example.test'); localStorage.setItem('pia_user_role', 'student'); }, [profile, theme, limit, poll]);
      await context.route('**/*', route => {
        const u = route.request().url();
        /* The SDK is served from this origin now, so the stand-in must be matched BEFORE the origin check. */
        if (u.includes('/assets/js/vendor/supabase.js')) return route.fulfill({ contentType: 'text/javascript', body: mock });
        if (u.startsWith(origin + '/')) { if (block && block.test(u)) return route.abort('failed'); return route.continue(); }
        leaked.push(u); return route.abort('blockedbyclient');
      });
    }
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    page.__reqs = [];
    page.on('request', r => page.__reqs.push(r.url()));
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
    const done = await p.locator('.step-card.correct').count();
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
    assert.equal(await p.evaluate(() => /tutors\/|personas\//.test(document.querySelector('#agent-img-start').getAttribute('src') || '')), false);
    assert.equal(await p.evaluate(() => window.__calls.some(c => c.m === 'rpc' && /serve_next|check_step/.test(c.name))), false);
    await p.context().close();
  });
  await check('direct URL with ?group=control&selected_character=...&student_id= changes nothing', async () => {
    const p = await open(DASH + '?group=control&group_type=control&selected_character=pia-open&student_id=5', { profile: { group_type: 'Assigned', selected_character: 'pia-calm' } });
    await p.waitForSelector('#start-btn');
    assert.match(await p.locator('#agent-img-start').getAttribute('src'), /personas\/Neuroticism\/default\.webp$/);
    assert.equal(await p.evaluate(() => location.pathname), DASH);
    await p.context().close();
  });
  await check('localStorage tutor/group cannot change the tutor (selected_character, pia_student_id, group_type set there are ignored)', async () => {
    const p = await open(DASH, { profile: { group_type: 'Assigned', selected_character: 'pia-agreeable' } });
    await p.evaluate(() => { localStorage.setItem('selected_character', 'pia-calm'); localStorage.setItem('pia_student_id', '9'); localStorage.setItem('group_type', 'control'); });
    await p.reload(); await p.waitForSelector('#start-btn');
    assert.match(await p.locator('#agent-img-start').getAttribute('src'), /personas\/Agreeableness\/default\.webp$/);
    await p.context().close();
  });

  /* ---------------- tutor display: the 3D-style persona art ---------------- */
  const PERSONA = {   // selected_character -> [folder, { mood: file }]
    'pia-open': ['Openness', { default: 'default', happy: 'happy', sad: 'sad', excited: 'excited' }],
    'pia-conscientious': ['Conscientiousness', { default: 'default', happy: 'happy', sad: 'sad', excited: 'excited' }],
    'pia-extravert': ['Extraverted', { default: 'default', happy: 'happy', sad: 'sad', excited: 'excited' }],
    'pia-agreeable': ['Agreeableness', { default: 'default', happy: 'happy', sad: 'sad', excited: 'excited' }],
    'pia-calm': ['Neuroticism', { default: 'default', happy: 'happy', sad: 'sad', excited: 'excited' }],
    'pia-neutral': ['Neutral', { default: 'default', happy: 'approval', sad: 'disapproval', excited: 'nod' }]
  };
  const imgFile = p => p.locator('#agent-img').getAttribute('src').then(x => x.split('/').slice(-2).join('/'));
  const waitFile = (p, expected, sel = '#agent-img') => p.waitForFunction(([e, s]) => (document.querySelector(s).getAttribute('src') || '').endsWith(e) && document.querySelector(s).complete && document.querySelector(s).naturalWidth > 0, [expected, sel], { timeout: 5000 });
  for (const [key, [folder]] of Object.entries(PERSONA)) {
    await check(`persona mapping: ${key} -> assets/images/personas/${folder} (start screen + game, loads)`, async () => {
      const p = await open(DASH, { profile: { group_type: 'Assigned', selected_character: key } });
      await p.waitForSelector('#start-btn');
      assert.match(await p.locator('#agent-img-start').getAttribute('src'), new RegExp(`personas/${folder}/default\\.webp$`));
      await start(p);
      assert.match(await p.locator('#agent-img').getAttribute('src'), new RegExp(`personas/${folder}/default\\.webp$`));
      assert.equal(await p.evaluate(() => document.querySelector('#agent-img').naturalWidth > 0 && document.querySelector('#agent-img-start').naturalWidth > 0), true);
      assert.equal(await p.locator('#agent-img').getAttribute('alt') !== '', true);
      await p.context().close();
    });
  }
  await check('persona mapping: the tutor comes only from profiles.selected_character (not the URL, localStorage or group)', async () => {
    const p = await open(DASH + '?selected_character=pia-open&tutor=pia-neutral', { profile: { group_type: 'Non-Assigned', selected_character: 'pia-extravert' } });
    await p.evaluate(() => { localStorage.setItem('selected_character', 'pia-calm'); localStorage.setItem('tutor', 'pia-neutral'); });
    await p.reload(); await p.waitForSelector('#start-btn');
    assert.match(await p.locator('#agent-img-start').getAttribute('src'), /personas\/Extraverted\/default\.webp$/);
    assert.equal(p.__reqs.filter(u => /personas\//.test(u)).every(u => /personas\/Extraverted\//.test(u)), true, 'only the saved tutor\'s pictures are requested');
    await p.context().close();
  });
  for (const key of ['pia-open', 'pia-neutral']) {
    await check(`expressions: ${key} - sad on a wrong answer, thinking on a hint, excited on a quick answer, happy after struggle, excited on a topic offer`, async () => {
      const [folder, m] = PERSONA[key];
      const file = mood => `${folder}/${m[mood]}.webp`;
      const think = key === 'pia-neutral' ? 'Neutral/shrug.webp' : `${folder}/default.webp`;
      const p = await open(DASH, { profile: { group_type: 'Assigned', selected_character: key } });
      await start(p);
      await submit(p, '9');   await waitFile(p, file('sad'));
      await submit(p, '8');   await waitFile(p, file('sad'));
      await p.locator('#hint-btn').click(); await waitFile(p, think);
      const q = await p.locator('#problem-expression').innerText(); const pct = q.match(/(\d+)%/)[1];
      const b = (await bank(p)).find(x => x.question === q);
      await submit(p, pct + '/100'); await waitFile(p, file('happy'));          // working accepted
      await submit(p, b.steps[0].answer); await waitFile(p, file('happy'));     // correct after struggle
      await submit(p, b.steps[1].answer);                                       // quick, no mistakes on this step
      await waitFile(p, file('excited'));
      // a topic offer: the up offer shows the excited picture in the dialog too
      await p.waitForSelector('#step-input', { timeout: 5000 });
      for (let i = 0; i < 6; i++) { await finishQuestion(p); if (await p.locator('#modal-offer.is-open').count()) break; }
      await p.waitForSelector('#modal-offer.is-open', { timeout: 8000 });
      await waitFile(p, file('excited'), '#offer-img');
      await p.context().close();
    });
  }
  await check('fallback: every persona picture unavailable -> the previous illustrations show, each mood, nothing breaks', async () => {
    const p = await open(DASH, { profile: { group_type: 'Assigned', selected_character: 'pia-open' }, block: /\/assets\/images\/personas\// });
    await p.waitForSelector('#start-btn');
    await waitFile(p, 'tutors/pia-open/default.webp', '#agent-img-start');
    await start(p);
    await waitFile(p, 'tutors/pia-open/default.webp');
    await submit(p, '9');  await waitFile(p, 'tutors/pia-open/sad.webp');
    await submit(p, '8');
    const q = await p.locator('#problem-expression').innerText(); const pct = q.match(/(\d+)%/)[1];
    await submit(p, pct + '/100'); await waitFile(p, 'tutors/pia-open/happy.webp');
    assert.equal(await p.evaluate(() => document.querySelector('#agent-img').naturalWidth > 0), true);
    assert.equal(await p.locator('#agent-img').isVisible(), true);
    await p.context().close();
  });
  await check('fallback: only one expression missing (excited) -> that mood uses the previous happy picture, the rest keep the 3D art', async () => {
    const p = await open(DASH, { profile: { group_type: 'Assigned', selected_character: 'pia-agreeable' }, block: /\/personas\/Agreeableness\/excited\.webp/ });
    await start(p);
    await waitFile(p, 'Agreeableness/default.webp');
    const q = await p.locator('#problem-expression').innerText(); const b = (await bank(p)).find(x => x.question === q);
    await submit(p, b.steps[0].answer);                       // quick and clean -> would be excited
    await waitFile(p, 'tutors/pia-agreeable/happy.webp');
    await submit(p, '1');                                     // wrong -> sad keeps the 3D picture
    await waitFile(p, 'Agreeableness/sad.webp');
    await p.context().close();
  });
  await check('fallback: the topic-offer dialog also falls back, and a missing start-screen picture falls back', async () => {
    const p = await open(DASH, { profile: { group_type: 'Assigned', selected_character: 'pia-calm' }, block: /\/personas\/Neuroticism\// });
    await p.waitForSelector('#start-btn');
    await waitFile(p, 'tutors/pia-calm/default.webp', '#agent-img-start');
    await start(p);
    for (let i = 0; i < 3; i++) await finishQuestion(p);
    await p.waitForSelector('#modal-offer.is-open', { timeout: 8000 });
    await waitFile(p, 'tutors/pia-calm/happy.webp', '#offer-img');
    await p.context().close();
  });
  for (const [w, h] of [[320, 640], [375, 740], [768, 1024], [1024, 768], [1440, 900]]) {
    await check(`responsive persona card at ${w}px: inside the tutor panel, no overflow, full picture shown, hint slot intact`, async () => {
      for (const key of ['pia-open', 'pia-neutral']) {
        const p = await open(DASH, { width: w, height: h, profile: { group_type: 'Assigned', selected_character: key } });
        await p.waitForSelector('#start-btn');
        const portrait = await p.evaluate(() => { const r = document.querySelector('#agent-img-start').getBoundingClientRect(); return { l: r.left, r: r.right, w: r.width, h: r.height, iw: innerWidth, sw: document.documentElement.scrollWidth }; });
        assert.ok(portrait.l >= 0 && portrait.r <= portrait.iw && portrait.sw <= portrait.iw, JSON.stringify(portrait));
        await start(p);
        await submit(p, '9'); await submit(p, '8');
        await p.waitForTimeout(300);
        const g = await p.evaluate(() => {
          const img = document.querySelector('#agent-img').getBoundingClientRect(), side = document.querySelector('.left-sidebar').getBoundingClientRect();
          const bubble = document.querySelector('.prompt-box').getBoundingClientRect(), hint = document.querySelector('#hint-btn').getBoundingClientRect();
          return { img: [img.left, img.top, img.right, img.bottom], side: [side.left, side.top, side.right, side.bottom], bubbleBottom: bubble.bottom, hintTop: hint.top, hintBottom: hint.bottom, w: img.width, h: img.height, iw: innerWidth, sw: document.documentElement.scrollWidth, nat: document.querySelector('#agent-img').naturalWidth };
        });
        assert.ok(g.sw <= g.iw, 'horizontal overflow ' + JSON.stringify(g));
        assert.ok(g.img[0] >= g.side[0] - 1 && g.img[2] <= g.side[2] + 1 && g.img[1] >= g.side[1] - 1 && g.img[3] <= g.side[3] + 1, 'card outside the tutor panel ' + JSON.stringify(g));
        assert.ok(g.img[1] >= g.bubbleBottom - 1, 'card overlaps the speech bubble ' + JSON.stringify(g));
        assert.ok(g.img[3] <= g.hintTop + 8, 'card overlaps the hint slot ' + JSON.stringify(g));
        assert.ok(g.h >= 120 && g.w >= 90 && g.nat > 0, 'picture too small ' + JSON.stringify(g));
        await p.screenshot({ path: path.join(out, `persona-${key}-${w}.png`), fullPage: w < 900 });
        await p.context().close();
      }
    });
  }
  await check('persona: changing expression moves nothing (card, bubble, hint slot, chalkboard) at 320px', async () => {
    const p = await open(DASH, { width: 320, height: 640 }); await start(p); await p.waitForTimeout(300);
    const snap = () => p.evaluate(() => ['#agent-img', '.prompt-box', '.video-hint-layer', '.problem-header-block'].map(s => { const b = document.querySelector(s).getBoundingClientRect(); return [s, Math.round(b.x), Math.round(b.y + scrollY), Math.round(b.width), Math.round(b.height)].join(); }));
    const base = await snap();
    await submit(p, '7'); await waitFile(p, 'Openness/sad.webp'); await p.waitForTimeout(200);
    assert.deepEqual(await snap(), base);
    await p.context().close();
  });
  await check('unchanged behaviour: Control gets no game page and never requests a persona picture; Free choice and Neutral still reach the game', async () => {
    const c = await open(DASH, { profile: { group_type: 'Control', selected_character: 'pia-open' } });
    await c.waitForFunction(() => location.pathname === '/student/html/assessment-complete.html');
    await c.waitForTimeout(600);
    assert.equal(c.__reqs.some(u => /personas\//.test(u)), false);
    await c.context().close();
    for (const [profile, folder] of [[{ group_type: 'Non-Assigned', selected_character: 'pia-calm' }, 'Neuroticism'], [{ group_type: 'Non-Assigned', selected_character: 'pia-neutral' }, 'Neutral'], [{ group_type: 'Assigned', selected_character: 'pia-neutral' }, 'Neutral']]) {
      const p = await open(DASH, { profile }); await p.waitForSelector('#start-btn');
      assert.equal(new URL(p.url()).pathname, DASH);
      assert.match(await p.locator('#agent-img-start').getAttribute('src'), new RegExp(`personas/${folder}/default\\.webp$`));
      await p.context().close();
    }
    const n = await open(DASH, { profile: { group_type: 'Non-Assigned', selected_character: null } });
    await n.waitForFunction(() => location.pathname === '/student/html/character-selection.html');
    await n.context().close();
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
    await p.locator('#hint-btn').click(); await p.waitForFunction(() => /Tier/.test(document.querySelector('#hint-tier-label').textContent));
    assert.match(await p.locator('#hint-tier-label').innerText(), /Tier 1\//);
    const q = await p.locator('#problem-expression').innerText();
    const b = (await bank(p)).find(x => x.question === q);
    const pct = q.match(/(\d+)%/)[1];
    await submit(p, pct + '/100');
    assert.match(await p.locator('.step-card > .feedback-msg.correct').innerText(), /Correct calculation/);
    assert.equal(await p.locator('#hint-tier-label').innerText(), '', 'tier label clears when the confirm box opens');
    await submit(p, pct + '%');
    assert.match(await p.locator('#step-feedback').innerText(), /decimal value only/);
    await submit(p, b.steps[0].answer);
    assert.equal(await p.locator('.step-card.correct').count(), 1);
    assert.equal(await p.locator('.step-card.correct input.solution-input').count(), 2, 'working and confirmed value both shown');
    await submit(p, b.steps[1].answer);
    await p.waitForFunction(q0 => document.querySelector('#problem-expression').textContent !== q0, q, { timeout: 5000 });
    assert.equal(await p.locator('#solved-list .q-btn').count(), 1);
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
    assert.match(await p.locator('#problem-kicker').innerText(), /^Topic 2:/);
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
    assert.match(await p.locator('#problem-kicker').innerText(), /^Topic 1:/);
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
    assert.match(await p.locator('.step-card > .feedback-msg.correct').innerText(), /Correct calculation/);
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
    assert.equal(await p.locator('#solved-list .q-btn').count(), 16);
    for (let i = 1; i < seen.length; i++) assert.notEqual(seen[i], seen[i - 1], 'same question twice in a row');
    assert.ok(new Set(seen).size < seen.length, 'bank cycled and repeated');
    const names = await p.evaluate(() => [...new Set(window.__calls.filter(c => c.m === 'rpc').map(c => c.name))]);
    for (const old of ['serve_next_question', 'check_question_answer', 'consume_question_hint', 'reveal_question_solution', 'record_question_result', 'end_game_session']) assert.equal(names.includes(old), false, old);
    assert.equal(await p.evaluate(() => window.__responses.filter(r => /"answer"|final_answer|stepAnswer/.test(r.body)).length), 0);
    await p.context().close();
  });

  /* ---------------- tutor wording profile (0044: worked out by the database) ---------------- */
  const wrongLine = async (p, key) => {
    const bank = await p.evaluate(() => window.PIA_TUTORS['pia-open'].profiles);
    const said = await p.locator('#agent-speech').innerText();
    const lines = k => [].concat(bank[k].wrong || [], (bank[k].reactions && bank[k].reactions.wrongFirst) || [], (bank[k].reactions && bank[k].reactions.wrongRepeated) || []);
    return ['struggling', 'average', 'outstanding'].filter(k => lines(k).some(l => said.includes(l))).filter(k => !key || k === key);
  };
  const wrongOnce = async p => {
    const q = await p.locator('#problem-expression').innerText();
    const b = (await bank(p)).find(x => x.question === q);
    await submit(p, b.steps[0].answer === '999' ? '998' : '999');
    await p.waitForTimeout(250);
  };
  await check('wording profile: asks the Edge Function with the session id only, moves ONE step at a time, never calls the ML service itself', async () => {
    const p = await open(DASH);
    await start(p);
    await p.evaluate(() => localStorage.setItem('__mock_lp', 'outstanding'));
    await wrongOnce(p); await wrongOnce(p);
    assert.deepEqual(await wrongLine(p), ['outstanding'], 'average -> outstanding after the service says so');
    await p.evaluate(() => localStorage.setItem('__mock_lp', 'struggling'));
    await wrongOnce(p); await wrongOnce(p);
    assert.ok((await wrongLine(p)).includes('average'), 'outstanding -> average, not straight to struggling');
    await wrongOnce(p);
    assert.deepEqual(await wrongLine(p), ['struggling']);
    const calls = await p.evaluate(() => window.__calls.filter(c => c.m === 'fn' && c.name === 'learning-profile'));
    assert.ok(calls.length >= 5);
    for (const c of calls) assert.deepEqual(Object.keys(c.body), ['session_id'], 'only the session id is sent');
    assert.equal(await p.evaluate(() => window.__calls.some(c => c.m === 'rpc' && /learning/.test(c.name))), false, 'no learning RPC from the page');
    assert.deepEqual(p.__reqs.filter(u => !u.startsWith(origin) && !/fonts\.(googleapis|gstatic)\.com/.test(u)), [], 'nothing but the pages\' own fonts/SDK is requested; no ML or other outside service');
    await p.context().close();
  });
  await check('wording profile: a failing profile call keeps the wording and the game works', async () => {
    const p = await open(DASH);
    await start(p);
    await p.evaluate(() => { localStorage.setItem('__mock_lp', 'outstanding'); localStorage.setItem('__mock_lp_fail', '1'); });
    await wrongOnce(p); await wrongOnce(p); await wrongOnce(p);
    assert.ok((await wrongLine(p)).includes('average'));
    assert.equal(await p.locator('#step-input').isEnabled(), true);
    await solveCurrent(p);
    assert.equal(await p.locator('.step-card.correct').count(), 1);
    await p.context().close();
  });

  /* ---------------- the tutor is centred in its panel; the speech bubble never scrolls ---------------- */
  for (const w of [320, 375, 768, 1024, 1280]) {
    await check(`tutor figure is centred in its panel and the bubble has no scroll bar (${w}px)`, async () => {
      const p = await open(DASH, { width: w, height: w < 500 ? 740 : 800 });
      await start(p);
      await p.waitForFunction(() => { const i = document.querySelector('#agent-img'); return i && i.complete && i.naturalWidth > 1; });
      const measure = () => p.evaluate(() => {
        const img = document.querySelector('#agent-img'), panel = document.querySelector('.video-mentor-sidebar');
        const r = img.getBoundingClientRect(), pr = panel.getBoundingClientRect();
        // where the opaque figure really is inside the picture, measured independently of the page script
        const cv = document.createElement('canvas'); const W = 96, H = Math.round(96 * img.naturalHeight / img.naturalWidth); cv.width = W; cv.height = H;
        const cx = cv.getContext('2d'); cx.drawImage(img, 0, 0, W, H); const d = cx.getImageData(0, 0, W, H).data; const cols = new Array(W).fill(0);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (d[(y * W + x) * 4 + 3] > 40) cols[x]++;
        let min = -1, max = -1; for (let i = 0; i < W; i++) if (cols[i] > 1) { if (min < 0) min = i; max = i; }
        const c = min < 0 ? 0.5 : (min + max + 1) / 2 / W;
        const rw = Math.min(r.width, r.height * img.naturalWidth / img.naturalHeight);
        const figureX = r.left + (r.width - rw) / 2 + c * rw;
        return { off: Math.round(Math.abs(figureX - (pr.left + pr.width / 2))), panel: Math.round(pr.width) };
      });
      let m = await measure();
      assert.ok(m.off <= 3, 'happy/default figure is ' + m.off + 'px off the panel centre');
      await submit(p, '9'); await submit(p, '8');   // a different expression (a different picture)
      await p.waitForTimeout(500);
      m = await measure();
      assert.ok(m.off <= 3, 'after a wrong answer the figure is ' + m.off + 'px off the panel centre');
      await p.evaluate(() => { document.querySelector('#agent-speech').textContent = 'Nice work! Keep going.'; });
      await p.waitForTimeout(300);
      const normal = await p.evaluate(() => { const sp = document.querySelector('#agent-speech'); sp.style.fontSize = ''; return parseFloat(getComputedStyle(sp).fontSize); });
      assert.ok(normal >= 13, 'a short line keeps a comfortable size, got ' + normal + 'px');
      // a realistic long hint fits whole; an absurdly long line may scroll but never shows a bar
      const bubble = () => p.evaluate(() => { const box = document.querySelector('#status-msg'), sp = document.querySelector('#agent-speech'); return { fits: sp.scrollHeight <= sp.clientHeight + 1, fs: getComputedStyle(sp).fontSize, boxBar: box.scrollHeight > box.clientHeight + 1 && getComputedStyle(box).overflowY !== 'hidden', hasBar: sp.offsetWidth - sp.clientWidth > 0, boxOverflow: getComputedStyle(box).overflowY }; });
      await p.evaluate(() => { document.querySelector('#agent-speech').textContent = 'Let us slow down. Read the problem again, find the total, decide which operation it asks for, and check each small step before you move on.'; });
      await p.waitForTimeout(400);
      let b = await bubble();
      assert.equal(b.fits, true, 'a realistic long hint fits the bubble ' + JSON.stringify(b));
      assert.equal(b.boxOverflow, 'hidden', 'the bubble box never scrolls: ' + JSON.stringify(b));
      assert.equal(b.hasBar, false, 'no scroll bar');
      await p.evaluate(() => { document.querySelector('#agent-speech').textContent = 'Let us slow down and look at this one carefully together. First, read the whole problem again and find the number that tells you the total. Then decide which operation the problem is asking for, write the working the way you were taught, and check each small step before you move on to the next one and then the one after that as well.'; });
      await p.waitForTimeout(400);
      b = await bubble();
      assert.equal(b.hasBar, false, 'even an absurdly long line draws no scroll bar');
      assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no horizontal overflow');
      await p.screenshot({ path: path.join(out, `game-centred-${w}.png`) });
      await p.context().close();
    });
  }

  /* ---------------- the bubble and the tutor are one group, centred up and down, close together ---------------- */
  for (const [w, h] of [[375, 740], [768, 900], [1024, 800], [1280, 800], [1920, 1000]]) {
    await check(`tutor + speech bubble: close together and centred up and down in the panel (${w}x${h})`, async () => {
      const p = await open(DASH, { width: w, height: h });
      await start(p);
      await p.waitForFunction(() => { const i = document.querySelector('#agent-img'); return i && i.complete && i.naturalWidth > 1; });
      await p.waitForTimeout(500);
      const m = await p.evaluate(() => {
        const img = document.querySelector('#agent-img'), box = document.querySelector('#status-msg'), layer = document.querySelector('.video-copy-layer');
        const cv = document.createElement('canvas'); const W = 96, H = Math.round(96 * img.naturalHeight / img.naturalWidth); cv.width = W; cv.height = H;
        const cx = cv.getContext('2d'); cx.drawImage(img, 0, 0, W, H); const d = cx.getImageData(0, 0, W, H).data;
        let top = -1, bottom = -1; for (let y = 0; y < H; y++) { let n = 0; for (let x = 0; x < W; x++) if (d[(y * W + x) * 4 + 3] > 40) n++; if (n > 1) { if (top < 0) top = y; bottom = y; } }
        const r = img.getBoundingClientRect(), s = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight);
        const rh = img.naturalHeight * s, oy = r.top + (r.height - rh);      // object-position: center bottom
        const figTop = oy + (top / H) * rh, figBottom = oy + ((bottom + 1) / H) * rh;
        const b = box.getBoundingClientRect(), l = layer.getBoundingClientRect();
        return { gap: Math.round(figTop - b.bottom), groupCentre: Math.round((b.top + figBottom) / 2), layerCentre: Math.round((l.top + l.bottom) / 2), above: Math.round(b.top - l.top), below: Math.round(l.bottom - figBottom) };
      });
      await p.screenshot({ path: path.join(out, `game-group-${w}.png`) });
      assert.ok(m.gap >= 0 && m.gap <= 48, 'the bubble and the figure are close together: gap ' + m.gap + 'px ' + JSON.stringify(m));
      assert.ok(Math.abs(m.groupCentre - m.layerCentre) <= 14 || (m.above >= 0 && m.below >= 0 && Math.abs(m.above - m.below) <= 28), 'the group is centred up and down ' + JSON.stringify(m));
      await p.context().close();
    });
  }

  /* ---------------- live: the closing time reaches the page by itself ---------------- */
  await check('live: the game locks the moment the admin closes it (no answer needed) and opens again the moment it is reopened, same question', async () => {
    const p = await open(DASH, { poll: 600 });
    await start(p);
    const q = await p.locator('#problem-expression').innerText();
    await submit(p, '9');
    await p.evaluate(() => window.__mockExpireNow());
    await p.waitForSelector('#modal-time.is-open', { timeout: 4000 });
    assert.equal(await p.locator('#step-input').isDisabled(), true, 'inputs locked');
    assert.equal(/\d/.test(await p.locator('#modal-time').innerText()), false, 'no time in the dialog');
    await p.evaluate(() => window.__mockReopen());
    await p.waitForFunction(() => !document.querySelector('#modal-time.is-open'), null, { timeout: 4000 });
    await p.waitForFunction(() => { const i = document.querySelector('#step-input'); return i && !i.disabled; }, null, { timeout: 4000 });
    assert.equal(await p.locator('#problem-expression').innerText(), q, 'the same question, not a restart');
    assert.match(await p.locator('#agent-speech').innerText(), /open again/i);
    await p.context().close();
  });
  await check('live: at the exact closing moment the game locks even when polling is slow', async () => {
    const p = await open(DASH, { poll: 60000 });
    await start(p);
    await p.evaluate(() => window.__mockCloseIn(2500));
    await p.evaluate(() => window.__mockReopen && 0);
    await p.waitForTimeout(300);
    // the page learns the time on its next status call; trigger one the way a returning tab does
    await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await p.waitForSelector('#modal-time.is-open', { timeout: 6000 });
    assert.equal(await p.locator('#step-submit').isDisabled(), true);
    await p.context().close();
  });
  await check('live: the start screen follows the admin too (closed -> Start off, reopened -> Start on, closed again -> off)', async () => {
    const p = await open(DASH, { poll: 600 });
    await p.waitForSelector('#start-btn');
    /* The lede is written once the profile has loaded and is visible only once the screen has shown: read it when it has VISIBLE
       text (innerText, as below), or a slow run compares against ''. */
    await p.waitForFunction(() => document.querySelector('#start-lede').innerText.trim().length > 0);
    const lede = await p.locator('#start-lede').innerText();
    await p.evaluate(() => window.__mockExpireNow());
    await p.waitForFunction(() => document.querySelector('#start-btn').disabled && /closed/i.test(document.querySelector('#start-lede').textContent), null, { timeout: 4000 });
    await p.evaluate(() => window.__mockReopen());
    await p.waitForFunction(() => !document.querySelector('#start-btn').disabled, null, { timeout: 4000 });
    assert.equal(await p.locator('#start-lede').innerText(), lede, 'the original text is back');
    await p.evaluate(() => window.__mockExpireNow());
    await p.waitForFunction(() => document.querySelector('#start-btn').disabled, null, { timeout: 4000 });
    await p.context().close();
  });

  /* ---------------- the worked example, drawn in the chat bubble ---------------- */
  const EXAMPLE = 'Example: 0.25 * 55. Ignore the decimal point: 25 * 55 = 1375. 0.25 has 2 decimal places, so put the point back 2 places from the right: 13.75.';
  /* Position in the PAGE, not the screen: on a phone the page scrolls on purpose to bring the example into view. */
  const boxOf = async (p, sel) => { const b = await p.locator(sel).first().boundingBox(); const y = await p.evaluate(() => window.scrollY); return b && { x: b.x, y: b.y + y, width: b.width, height: b.height }; };
  const same = (a, b, tol = 0.6) => a && b && ['x', 'y', 'width', 'height'].every(k => Math.abs(a[k] - b[k]) <= tol);
  /* Gets a topic-1 question to the Tier 2 hint of its multiply step, whose text is a worked example. */
  async function openExample(p) {
    await start(p);
    await p.evaluate(ex => { window.__bank.filter(q => q.topic === 1).forEach(q => { q.steps[1].hint2 = ex; }); }, EXAMPLE);
    const q = await p.locator('#problem-expression').innerText();
    const b = (await bank(p)).find(x => x.question === q);
    await submit(p, b.steps[0].answer);
    if (await p.locator('.conversion-confirmation').count()) await submit(p, b.steps[0].answer);
    await submit(p, '999'); await submit(p, '998');
    await p.locator('#hint-btn').click(); await p.waitForTimeout(300);          // tier 1: plain text
    await p.waitForTimeout(1700);                                              // the talking animation is over
    return { b, bubble: await boxOf(p, '#status-msg'), tutor: await boxOf(p, '#agent-img') };
  }
  for (const [w, h] of [[1440, 850], [1280, 720], [1024, 768], [412, 900], [375, 700]]) {
    await check(`worked example in the chat at ${w}x${h}: inside the bubble, bubble and tutor unchanged, nothing moves from step to step`, async () => {
      const p = await open(DASH, { width: w, height: h, motion: 'no-preference' });
      const before = await openExample(p);
      await p.locator('#hint-btn').click();                                    // tier 2: the example
      await p.waitForSelector('#status-msg .hb-inline'); await p.waitForTimeout(1700);
      assert.equal(await p.locator('.hint-board').count(), 0, 'no separate board');
      assert.ok(same(before.bubble, await boxOf(p, '#status-msg')), 'the bubble keeps its size and place');
      assert.ok(same(before.tutor, await boxOf(p, '#agent-img')), 'the tutor keeps size and place');
      const frame = () => p.evaluate(() => {
        const q = s => document.querySelector(s), rc = e => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; };
        const cap = q('.hb-caption'), rg = document.createRange(); rg.selectNodeContents(cap);
        const wrap = q('.hb-inline'), bub = q('#status-msg').getBoundingClientRect(), nx = q('.hb-next').getBoundingClientRect();
        return { board: rc(q('.hb-board')), caption: rc(cap), controls: rc(q('.hb-controls')), prev: rc(q('.hb-back')), next: rc(q('.hb-next')), count: rc(q('.hb-progress')),
          line: rg.getClientRects()[0].top, capOverflow: cap.scrollHeight - cap.clientHeight, wrapOverflow: wrap.scrollHeight - wrap.clientHeight,
          inside: wrap.getBoundingClientRect().bottom <= bub.bottom + 0.5 && nx.bottom <= bub.bottom + 0.5, total: Number(q('.hb-progress span:last-child').textContent.match(/of (\d+)/)[1]) };
      });
      const first = await frame(); let moved = 0;
      // the arrows: square, side by side, at the right-hand end, under the words
      const [pl, pt, pw, ph] = first.prev, [nl, nt, nw, nh] = first.next, [cl, , cw] = first.controls, [, , , ] = first.caption;
      assert.ok(Math.abs(pw - ph) <= 0.5 && Math.abs(nw - nh) <= 0.5 && Math.abs(pw - nw) <= 0.5, `square buttons, same size: ${pw}x${ph}, ${nw}x${nh}`);
      assert.ok(Math.abs(pt - nt) <= 0.5 && nl - (pl + pw) <= 12 && nl > pl, 'back and next side by side');
      assert.ok(Math.abs((nl + nw) - (cl + cw)) <= 1, 'the arrows end at the right edge of their row');
      assert.ok(first.count[0] + first.count[2] <= pl + 0.5, 'the step count sits to the left of the arrows');
      assert.ok(first.caption[1] + first.caption[3] <= pt + 0.5, 'the arrows are under the words');
      for (let i = 1; i < first.total; i++) {
        await p.locator('.hb-next').click(); await p.waitForTimeout(220);
        const f = await frame();
        for (const k of ['board', 'caption', 'controls', 'prev', 'next', 'count']) f[k].forEach((v, j) => { moved = Math.max(moved, Math.abs(v - first[k][j])); });
        moved = Math.max(moved, Math.abs(f.line - first.line));
        assert.equal(f.capOverflow, 0, 'the whole caption fits its box on step ' + (i + 1));
        assert.equal(f.wrapOverflow <= 1, true, 'nothing is clipped');
        assert.equal(f.inside, true, 'the arrows are inside the bubble');
      }
      assert.ok(moved <= 0.6, 'nothing moved between steps: ' + moved + 'px');
      assert.equal((await p.locator('.hb-next').textContent()).trim(), '\u21bb', 'on the last step the button is a repeat arrow');
      assert.equal(await p.locator('.hb-next').getAttribute('aria-label'), 'Replay the example');
      await p.context().close();
    });
  }
  /* Long division in the bracket (Step 1: a percentage divided by 100; also the division step of increase/decrease). */
  const DIV_EXAMPLES = {
    '8 / 100': ['Example: 8 / 100. 8 is smaller than 100, so the answer starts with "0." Then: 80 / 100 = 0 (remainder 80), then 800 / 100 = 8. So 8 / 100 = 0.08.', '0.08'],
    '15 / 60': ['Example: 15 / 60. 15 is smaller than 60, so the answer starts with "0." Then: 150 / 60 = 2 (remainder 30), then 300 / 60 = 5. So 15 / 60 = 0.25.', '0.25'],
    '13 / 52': ['Example: 13 / 52. 13 is smaller than 52, so the answer starts with "0." Then: 130 / 52 = 2 (remainder 26), then 260 / 52 = 5. So 13 / 52 = 0.25.', '0.25']
  };
  for (const [w, h] of [[1440, 850], [1280, 720], [1024, 768], [412, 900], [375, 700]]) {
    for (const key of Object.keys(DIV_EXAMPLES)) {
      if (key !== '8 / 100' && w !== 1440 && w !== 375) continue;
      await check(`long division example ${key} at ${w}x${h}: in the bubble, nothing moves, the answer is written on top`, async () => {
        const [text, result] = DIV_EXAMPLES[key];
        const p = await open(DASH, { width: w, height: h, motion: 'no-preference' });
        await start(p);
        await p.evaluate(ex => { window.__bank.filter(q => q.topic === 1).forEach(q => { q.steps[0].hint2 = ex; }); }, text);
        await submit(p, '999'); await submit(p, '998');                        // the hint button appears after wrong answers
        await p.locator('#hint-btn').click(); await p.waitForTimeout(2000);
        const bubble = await boxOf(p, '#status-msg'), tutor = await boxOf(p, '#agent-img');
        await p.locator('#hint-btn').click();
        await p.waitForSelector('#status-msg .hb-inline'); await p.waitForTimeout(1700);
        assert.ok(same(bubble, await boxOf(p, '#status-msg')), 'the bubble keeps its size and place');
        assert.ok(same(tutor, await boxOf(p, '#agent-img')), 'the tutor keeps size and place');
        const frame = () => p.evaluate(() => {
          const q = s => document.querySelector(s), rc = e => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; };
          const cap = q('.hb-caption'), rg = document.createRange(); rg.selectNodeContents(cap);
          const wrap = q('.hb-inline'), bub = q('#status-msg').getBoundingClientRect(), bd = q('.hb-board').getBoundingClientRect(), cp = cap.getBoundingClientRect();
          return { board: rc(q('.hb-board')), caption: rc(cap), controls: rc(q('.hb-controls')), next: rc(q('.hb-next')), line: rg.getClientRects()[0].top,
            capOverflow: cap.scrollHeight - cap.clientHeight, wrapOverflow: wrap.scrollHeight - wrap.clientHeight, boardClipped: q('.hb-board').scrollWidth - q('.hb-board').clientWidth + q('.hb-board').scrollHeight - q('.hb-board').clientHeight,
            inside: wrap.getBoundingClientRect().bottom <= bub.bottom + 0.5 && bd.right <= cp.left + 1, font: parseFloat(getComputedStyle(q('.hb-grid')).fontSize),
            answer: Array.from(document.querySelectorAll('.hb-qrow .hb-c.is-on')).map(c => c.textContent).join(''), rows: document.querySelectorAll('.hb-dr').length,
            total: Number(q('.hb-progress span:last-child').textContent.match(/of (\d+)/)[1]) };
        });
        const first = await frame(); let moved = 0, last = first;
        assert.ok(first.font >= 11, 'readable type: ' + first.font);
        for (let i = 1; i < first.total; i++) {
          await p.locator('.hb-next').click(); await p.waitForTimeout(330);
          const f = last = await frame();
          for (const k of ['board', 'caption', 'controls', 'next']) f[k].forEach((v, j) => { moved = Math.max(moved, Math.abs(v - first[k][j])); });
          moved = Math.max(moved, Math.abs(f.line - first.line));
          assert.equal(f.capOverflow, 0, 'the whole caption fits on step ' + (i + 1)); assert.equal(f.wrapOverflow <= 1, true, 'nothing is clipped'); assert.equal(f.boardClipped <= 1, true, 'the work fits its place');
          assert.equal(f.inside, true, 'the work is inside the bubble and apart from the words');
        }
        assert.ok(moved <= 0.6, 'nothing moved between steps: ' + moved + 'px');
        assert.equal(last.answer, result, 'the answer on top');
        assert.match(await p.locator('.hb-caption').innerText(), new RegExp(result.replace('.', '\\.')));
        assert.equal((await p.locator('.hb-next').textContent()).trim(), '\u21bb');
        await p.context().close();
      });
    }
  }
  await check('worked example in the chat: a wrong answer keeps it, a right answer removes it, the next hint removes it', async () => {
    const p = await open(DASH, { width: 1280, height: 800, motion: 'no-preference' });
    const { b } = await openExample(p);
    await p.locator('#hint-btn').click(); await p.waitForSelector('#status-msg .hb-inline');
    await submit(p, '777');
    assert.equal(await p.locator('#status-msg .hb-inline').count(), 1, 'still there after a wrong answer');
    assert.match(await p.locator('#step-feedback').innerText(), /incorrect|try again/i);
    await submit(p, '776');
    assert.equal(await p.locator('#status-msg .hb-inline').count(), 1, 'still there after another wrong answer');
    await p.locator('#hint-btn').click(); await p.waitForTimeout(300);          // tier 3: the tutor speaks again
    assert.equal(await p.locator('#status-msg .hb-inline').count(), 0, 'the next hint replaces it');
    assert.equal(await p.locator('#status-msg').evaluate(e => e.closest('.has-example') === null), true);
    await p.locator('#hint-btn').click(); await p.waitForTimeout(300);
    await submit(p, b.steps[1].answer); if (await p.locator('.conversion-confirmation').count()) await submit(p, b.steps[1].answer);
    await p.waitForTimeout(300);
    assert.equal(await p.locator('#status-msg .hb-inline').count(), 0, 'gone after the right answer');
    await p.context().close();
  });
  await check('worked example in the chat, reduced motion: all of it at once, no buttons, every explanation listed', async () => {
    const p = await open(DASH, { width: 1280, height: 800 });                  // the suite default is reduced motion
    await openExample(p);
    await p.locator('#hint-btn').click(); await p.waitForSelector('#status-msg .hb-inline');
    assert.equal(await p.locator('.hb-controls').isVisible(), false, 'no arrows needed');
    assert.ok(await p.locator('.hb-all li').count() >= 8, 'every explanation is listed');
    assert.match(await p.locator('.hb-board').getAttribute('data-shown'), /point/);
    assert.equal(await p.locator('.hb-inline').evaluate(e => e.scrollHeight <= e.clientHeight + 1), true, 'fits the bubble');
    await p.context().close();
  });

  /* ---------------- no Change password inside the game ---------------- */
  await check('Change password: offered on the start screen, gone while playing, back on the start screen after a refresh', async () => {
    const p = await open(DASH);
    await p.waitForSelector('#start-btn');
    await p.waitForSelector('#pia-change-password', { state: 'visible', timeout: 8000 });
    await start(p);
    assert.equal(await p.locator('#pia-change-password').isVisible(), false, 'not shown inside the game');
    assert.equal(await p.locator('#signout-btn').isVisible(), true, 'sign out is still there');
    await p.reload();
    await p.waitForSelector('#pia-change-password', { state: 'visible', timeout: 8000 });
    await p.context().close();
  });

  /* ---------------- a refresh keeps the trail (0046) ---------------- */
  await check('refresh: solved questions (with the student\'s working) and the error log come back from the server', async () => {
    const p = await open(DASH);
    await start(p);
    await submit(p, '9'); await submit(p, '8');
    const q1 = await p.locator('#problem-expression').innerText();
    await finishQuestion(p);
    if (await p.locator('#modal-offer.is-open').count()) { await p.locator('#offer-stay').click(); }
    await p.waitForSelector('#step-input');
    assert.equal(await p.locator('#solved-list .q-btn').count(), 1, 'one solved before the refresh');
    assert.equal(await p.locator('#error-list .history-item').count(), 2, 'two errors before the refresh');
    await p.reload();
    await p.waitForSelector('#start-btn');
    await p.waitForFunction(() => document.querySelectorAll('#solved-list .q-btn').length === 1, null, { timeout: 8000 });
    assert.equal(await p.locator('#error-list .history-item').count(), 2, 'both errors survive the refresh');
    assert.deepEqual(await p.locator('#error-list .history-item').allInnerTexts(), ['Step 1: Error on "9"', 'Step 1: Error on "8"']);
    await start(p);
    assert.equal(await p.locator('#solved-list .q-btn').innerText(), q1, 'the solved question is listed');
    await p.locator('#solved-list .q-btn').click();
    await p.waitForSelector('.workspace-preview-step');
    assert.equal(await p.locator('.workspace-preview-step').count(), 2, 'the saved working is shown, step by step');
    assert.match(await p.locator('.workspace-preview-step-title').first().innerText(), /^Step 1: Conversion/);
    await p.locator('#preview-back').click();
    assert.equal(await p.locator('#step-input').count(), 1, 'back to the live question');
    assert.equal(await p.evaluate(() => window.__calls.filter(c => c.m === 'rpc' && c.name === 'get_session_history').length), 1, 'history is asked once, by the page, with the session id only');
    assert.deepEqual(Object.keys(await p.evaluate(() => window.__calls.find(c => c.name === 'get_session_history').args)), ['p_session_id']);
    await p.context().close();
  });
  await check('refresh: a brand-new session has an empty trail and asks nothing extra', async () => {
    const p = await open(DASH);
    await p.waitForSelector('#start-btn');
    assert.equal(await p.locator('#solved-list .q-btn').count(), 0);
    assert.equal(await p.locator('#error-list .history-item').count(), 0);
    assert.equal(await p.evaluate(() => window.__calls.some(c => c.name === 'get_session_history')), false, 'not asked when nothing is being resumed');
    await p.context().close();
  });

  /* ---------------- clean URLs (Cloudflare Pages) ---------------- */
  await check('clean URL (no .html): a realtime profile update does not throw the student out of the game', async () => {
    const p = await open('/student/html/student-dashboard');
    assert.equal(new URL(p.url()).pathname, '/student/html/student-dashboard', 'opened without .html');
    await start(p);
    const before = p.url();
    await p.evaluate(() => {
      const ev = { new: { email: 'student@example.test', role: 'student', current_stage: 'Tutoring Dashboard', is_in_game: true } };
      window.__emitRealtime('student-stage-sync', ev);
    });
    await p.waitForTimeout(800);
    assert.equal(p.url(), before, 'the page was not reloaded');
    assert.equal(await p.locator('#screen-session.is-active').count(), 1, 'still in the game');
    assert.equal(await p.locator('#step-input').count(), 1);
    await p.context().close();
  });
  await check('a real stage change still navigates (the fix only stops false "not here" reloads)', async () => {
    const p = await open('/student/html/student-dashboard');
    const urls = [];
    p.on('framenavigated', f => { if (f === p.mainFrame()) urls.push(f.url()); });
    await p.evaluate(() => window.__emitRealtime('student-stage-sync', { new: { email: 'student@example.test', role: 'student', current_stage: 'Waiting Room' } }));
    await p.waitForTimeout(1200);
    assert.ok(urls.some(u => /waiting-room/.test(u)), 'navigated to the waiting room: ' + urls.join(' '));
    await p.context().close();
  });

  /* ---------------- the closing time (0045): the student sees NO time ---------------- */
  const noTime = async p => {
    const text = await p.evaluate(() => document.body.innerText);
    assert.equal(/\b\d{1,2}:\d{2}\b/.test(text), false, 'a clock-like time is on the page: ' + (text.match(/\b\d{1,2}:\d{2}\b/) || [''])[0]);
    assert.equal(/\b\d+\s*(mins?|minutes?|secs?|seconds?|hours?)\b/i.test(text), false, 'a duration is on the page');
    assert.equal(/time limit|time left|closes at|deadline|countdown/i.test(text), false, 'time wording is on the page');
    assert.equal(await p.locator('#time-left, #fact-limit, [role="timer"], .time-badge').count(), 0, 'a clock element exists');
  };
  await check('no time anywhere for the student: start screen and game show no clock, limit, minutes or closing time', async () => {
    const p = await open(DASH);
    await p.waitForSelector('#start-btn');
    await noTime(p);
    await start(p);
    await submit(p, '9'); await submit(p, '8');
    await noTime(p);
    assert.equal(await p.locator('#time-announce').innerText(), '', 'nothing is announced while open');
    await p.context().close();
  });
  await check('closed by the admin: the page learns only "closed", locks, says so without any time, and Sign out is the way on', async () => {
    const p = await open(DASH);
    await start(p);
    await p.evaluate(() => window.__mockExpireNow());
    await submit(p, '1');
    await p.waitForSelector('#modal-time.is-open', { timeout: 8000 });
    assert.equal(await p.locator('#modal-time').getAttribute('role'), 'alertdialog');
    assert.match(await p.locator('#time-title').innerText(), /Tutoring is closed/);
    assert.equal(/\d/.test(await p.locator('#modal-time').innerText()), false, 'no number in the closed dialog');
    assert.equal(await p.locator('#step-input').isDisabled(), true);
    assert.equal(await p.locator('#step-submit').isDisabled(), true);
    assert.equal(await p.locator('#hint-btn').isDisabled(), true);
    await p.keyboard.press('Escape');
    assert.equal(await p.locator('#modal-time.is-open').count(), 1, 'cannot be dismissed');
    assert.equal(await p.locator('#closed-signout').isVisible(), true);
    assert.equal(await p.locator('#time-retry').count(), 0, 'there is no Try again');
    assert.equal(await p.evaluate(() => window.__calls.some(c => c.m === 'rpc' && c.name === 'restart_after_expiry')), false, 'the page never asks to restart');
    await noTime(p);
    await p.context().close();
  });
  await check('closed before the student arrives: the start screen says so, Start is disabled, nothing is served', async () => {
    const p = await open(DASH);
    await p.waitForSelector('#start-btn');
    await p.evaluate(() => window.__mockExpireNow());
    await p.reload();
    await p.waitForSelector('#start-btn');
    await p.waitForFunction(() => /closed/i.test(document.querySelector('#start-lede').textContent));
    assert.equal(await p.locator('#start-btn').isDisabled(), true);
    assert.equal(/\d/.test(await p.locator('#start-lede').innerText()), false, 'no time in the message');
    assert.equal(await p.evaluate(() => window.__calls.some(c => c.m === 'rpc' && /serve_next/.test(c.name))), false);
    await p.context().close();
  });
  await check('reopened by the admin: the student continues the same question where they stopped', async () => {
    const p = await open(DASH);
    await start(p);
    const q = await p.locator('#problem-expression').innerText();
    await submit(p, '9');
    await p.evaluate(() => window.__mockExpireNow());
    await submit(p, '1');
    await p.waitForSelector('#modal-time.is-open');
    await p.evaluate(() => window.__mockReopen());
    await p.reload();
    await p.waitForSelector('#start-btn');
    await p.waitForFunction(() => !document.querySelector('#start-btn').disabled);
    await start(p);
    assert.equal(await p.locator('#problem-expression').innerText(), q, 'same question, not a restart');
    assert.equal(await p.locator('#step-input').isEnabled(), true);
    await noTime(p);
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
  await check('layout shift: tutor bubble, hint slot, chalkboard, input and submit do not move on wrong answers or hints (1280)', async () => {
    const p = await open(DASH); await start(p);
    await p.waitForTimeout(250);   // the one-off swap from the start screen (and the frame fit) has settled
    const snap = () => p.evaluate(() => ['.prompt-box', '.mentor-agent-stage', '.video-hint-layer', '.problem-header-block', '.problem-statement', '#step-input', '#step-submit'].map(s => { const b = document.querySelector(s).getBoundingClientRect(); return [s, Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)].join(); }));
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
    await p.focus('#hint-btn'); await p.keyboard.press('Enter'); await p.waitForFunction(() => /Tier/.test(document.querySelector('#hint-tier-label').textContent));
    assert.equal(await p.evaluate(() => document.activeElement.id), 'step-input');
    await p.context().close();
  });
  await check('original arrangement: tutor left, workspace centre, solved questions + error log right (desktop); stacked in that order on a phone', async () => {
    let p = await open(DASH, { width: 1280, height: 800 }); await start(p);
    const r = await p.evaluate(() => ['.left-sidebar', '.center-panel', '.right-sidebar'].map(s => { const b = document.querySelector(s).getBoundingClientRect(); return [b.left, b.top, b.width, b.height]; }));
    assert.ok(r[0][0] < r[1][0] && r[1][0] < r[2][0], 'left, centre, right');
    assert.ok(Math.abs(r[0][1] - r[1][1]) < 2 && Math.abs(r[1][1] - r[2][1]) < 2, 'one row');
    assert.equal(await p.evaluate(() => !!document.querySelector('.right-sidebar #solved-list') && !!document.querySelector('.right-sidebar #error-list') && !!document.querySelector('.left-sidebar #agent-img') && !!document.querySelector('.center-panel #steps')), true);
    await p.waitForTimeout(400);   // fitGameFrame() runs on the next animation frame
    const fit = await p.evaluate(() => ({ sh: document.documentElement.scrollHeight, ih: innerHeight, frame: document.querySelector('.game-frame').getBoundingClientRect().bottom }));
    assert.ok(fit.sh <= fit.ih + 1, 'the frame fits the viewport: the page itself does not scroll ' + JSON.stringify(fit));
    await p.context().close();
    p = await open(DASH, { width: 375, height: 740 }); await start(p);
    const g = await p.evaluate(() => ['.left-sidebar', '.center-panel', '.right-sidebar'].map(s => { const b = document.querySelector(s).getBoundingClientRect(); return [b.top + scrollY, b.bottom + scrollY]; }));
    assert.ok(g[0][1] <= g[1][0] + 2 && g[1][1] <= g[2][0] + 2, JSON.stringify(g));
    assert.ok(g[0][1] - g[0][0] <= 560, 'tutor block stays a bounded height');
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await p.context().close();
  });
  await check('solved question review: click a solved item, read-only work shows, Back and Escape return to the live problem', async () => {
    const p = await open(DASH); await start(p);
    await finishQuestion(p);
    const live = await p.locator('#problem-expression').innerText();
    await p.locator('#solved-list .q-btn').first().click();
    assert.match(await p.locator('#problem-kicker').innerText(), /^Solved Review/);
    assert.equal(await p.locator('#step-input').count(), 0, 'no input while reviewing');
    assert.equal(await p.locator('.workspace-preview-step').count(), 2);
    assert.equal(await p.locator('#hint-btn').isVisible(), false);
    await p.locator('#preview-back').click();
    assert.equal(await p.locator('#problem-expression').innerText(), live); await p.waitForSelector('#step-input');
    await p.locator('#solved-list .q-btn').first().click(); await p.keyboard.press('Escape');
    assert.equal(await p.locator('#step-input').count(), 1);
    await p.context().close();
  });
  await check('error log keeps the last five, in the game\'s wording', async () => {
    const p = await open(DASH); await start(p);
    for (let i = 0; i < 7; i++) await submit(p, String(900 + i));
    const items = await p.locator('#error-list .history-item').allInnerTexts();
    assert.equal(items.length, 5); assert.match(items[4], /^Step 1: Error on "906"$/);
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
