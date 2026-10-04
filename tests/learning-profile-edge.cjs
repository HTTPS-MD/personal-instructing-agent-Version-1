/* Proves the PIA side of the ML path, with SYNTHETIC data only, all on loopback:
     Edge Function handler (supabase/functions/learning-profile/handler.ts)
       -> the REAL hardened Worker code (ml-service/src/entry.py, run by tests/serve_harness.py)
   The "database" is a stub that returns the numbers get_learning_features produced on the
   scratch PostgreSQL (supabase/scratch/learning_features_0044_test.sql). */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const PORT = 18971, TOKEN = 'synthetic-test-token-0123456789';
const SID = '10000000-0000-0000-0000-000000000001';
const FEATURES = { // from the scratch database run: good = 8 correct, bad = 7 wrong + a hint
  good: { events: 8, features: { hint_rate: 0, recent_accuracy: 1, average_attempts: 1, consecutive_wrong: 0, consecutive_correct: 8, average_response_time: 23.75, correct_response_efficiency: 0.6813 } },
  bad: { events: 7, features: { hint_rate: 1, recent_accuracy: 0, average_attempts: 7, consecutive_wrong: 7, consecutive_correct: 0, average_response_time: 120, correct_response_efficiency: 0 } },
  one: { events: 1, features: { hint_rate: 0, recent_accuracy: 1, average_attempts: 1, consecutive_wrong: 0, consecutive_correct: 1, average_response_time: 120, correct_response_efficiency: 0.2 } },
};
const results = [];
async function check(name, fn) { try { await fn(); results.push({ name, pass: true }); } catch (e) { results.push({ name, pass: false, message: String(e.message || e) }); } }

(async () => {
  const { handle } = await import(pathToFileURL(path.join(root, 'supabase/functions/learning-profile/handler.ts')).href);
  const py = spawn('python3', [path.join(root, 'ml-service/tests/serve_harness.py'), String(PORT), TOKEN], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${PORT}/__seen`); break; } catch (e) { await new Promise(r => setTimeout(r, 100)); } }
  const seen = async () => (await (await fetch(`http://127.0.0.1:${PORT}/__seen`)).json());
  const env = { mlUrl: `http://127.0.0.1:${PORT}`, mlToken: TOKEN, allowedOrigins: ['https://pia.example', 'http://127.0.0.1:5504'] };
  const asStudent = (which) => async (auth, sid) => ({ data: FEATURES[which], error: null });
  const rpcCalls = [];
  const req = (body, headers = {}, method = 'POST') => new Request('https://fn.example/functions/v1/learning-profile', {
    method, headers: { Authorization: 'Bearer ' + 'x'.repeat(40), 'Content-Type': 'application/json', ...headers }, body: method === 'POST' ? JSON.stringify(body) : undefined });
  const j = async r => r.json();
  const before = async () => (await seen()).length;

  await check('PIA really calls the ML service: strong -> outstanding, weak -> struggling, with the real Worker code', async () => {
    const a = await handle(req({ session_id: SID }), env, asStudent('good'));
    const b = await handle(req({ session_id: SID }), env, asStudent('bad'));
    const ja = await j(a), jb = await j(b);
    assert.equal(a.status, 200); assert.equal(ja.profile, 'outstanding'); assert.equal(ja.source, 'ml'); assert.equal(typeof ja.confidence, 'number');
    assert.equal(jb.profile, 'struggling'); assert.equal(jb.source, 'ml');
    const log = await seen(); assert.ok(log.length >= 2, 'the Worker was actually reached');
  });
  await check('what the ML service received: POST /predict, bearer token, EXACTLY the seven numbers, nothing else', async () => {
    const log = await seen(); const last = log[log.length - 1];
    assert.equal(last.method, 'POST'); assert.equal(last.path, '/predict'); assert.equal(last.has_auth, true);
    assert.deepEqual(Object.keys(JSON.parse(last.body)).sort(), ['average_attempts', 'average_response_time', 'consecutive_correct', 'consecutive_wrong', 'correct_response_efficiency', 'hint_rate', 'recent_accuracy']);
    assert.equal(/learn|email|name|student|session|sid|group|tutor|ocean|x\.test/i.test(last.body), false, last.body);
    assert.equal(last.body.includes(SID), false);
  });
  await check('the browser cannot supply features or "learn": any body but {session_id} is refused and the Worker is not called', async () => {
    const n = await before();
    for (const body of [{ session_id: SID, learn: true }, { session_id: SID, features: { recent_accuracy: 1 } }, { recent_accuracy: 1 }, { session_id: 'not-a-uuid' }, {}, []]) {
      const r = await handle(req(body), env, asStudent('good')); assert.equal(r.status, 400, JSON.stringify(body));
    }
    assert.equal(await before(), n);
  });
  await check('fewer than two answers: default wording, the Worker is NOT called', async () => {
    const n = await before(); const r = await handle(req({ session_id: SID }), env, asStudent('one'));
    assert.deepEqual(await j(r), { profile: 'average', confidence: null, source: 'default' }); assert.equal(await before(), n);
  });
  await check('database refuses (Control, teacher, signed out): 403 and the Worker is NOT called', async () => {
    const n = await before(); const r = await handle(req({ session_id: SID }), env, async () => ({ data: null, error: { message: 'PIA: the tutoring game is not available to this account.' } }));
    assert.equal(r.status, 403); assert.equal((await j(r)).error.includes('PIA:'), false); assert.equal(await before(), n);
  });
  await check('no or malformed Authorization header: 401 before anything else happens', async () => {
    const n = await before();
    for (const h of [{ Authorization: '' }, { Authorization: 'Basic abc' }, { Authorization: 'Bearer x' }]) {
      const r = await handle(req({ session_id: SID }, h), env, asStudent('good')); assert.equal(r.status, 401);
    }
    assert.equal(await before(), n);
  });
  await check('the function runs the database call with the CALLER\'s own header', async () => {
    let got = null; await handle(req({ session_id: SID }, { Authorization: 'Bearer ' + 'u'.repeat(30) }), env, async (auth) => { got = auth; return { data: FEATURES.good, error: null }; });
    assert.equal(got, 'Bearer ' + 'u'.repeat(30));
  });
  await check('off until configured: no ML url or token -> 503, game keeps its wording', async () => {
    for (const e of [{ ...env, mlUrl: '' }, { ...env, mlToken: '' }]) assert.equal((await handle(req({ session_id: SID }), e, asStudent('good'))).status, 503);
  });
  await check('ML service failures never reach the student as detail: wrong token, down, garbage -> 502', async () => {
    assert.equal((await handle(req({ session_id: SID }), { ...env, mlToken: 'wrong-token' }, asStudent('good'))).status, 502);
    assert.equal((await handle(req({ session_id: SID }), { ...env, mlUrl: 'http://127.0.0.1:1' }, asStudent('good'))).status, 502);
    const garbage = async () => new Response(JSON.stringify({ profile: 'genius', confidence: 1 }), { status: 200 });
    assert.equal((await handle(req({ session_id: SID }), env, asStudent('good'), garbage)).status, 502);
    const slow = async (_u, o) => new Promise((_r, rej) => o.signal.addEventListener('abort', () => rej(new Error('timeout'))));
    assert.equal((await handle(req({ session_id: SID }), { ...env, timeoutMs: 100 }, asStudent('good'), slow)).status, 502);
  });
  await check('CORS: only PIA origins; the ML token never appears in any response', async () => {
    const ok = await handle(req({ session_id: SID }, { Origin: 'https://pia.example' }), env, asStudent('good'));
    assert.equal(ok.headers.get('Access-Control-Allow-Origin'), 'https://pia.example');
    const bad = await handle(req({ session_id: SID }, { Origin: 'https://evil.example' }), env, asStudent('good'));
    assert.equal(bad.headers.get('Access-Control-Allow-Origin'), null);
    const pre = await handle(req(null, { Origin: 'https://evil.example' }, 'OPTIONS'), env, asStudent('good')); assert.equal(pre.headers.get('Access-Control-Allow-Origin'), null);
    for (const r of [ok, bad, pre]) { assert.equal((await r.clone().text()).includes(TOKEN), false); assert.equal([...r.headers.values()].join().includes(TOKEN), false); }
    assert.equal((await handle(req({}, {}, 'GET'), env, asStudent('good'))).status, 405);
  });
  await check('no secret or service address in anything the browser loads; CSP does not allow the ML host', async () => {
    const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? (['node_modules', '.git', 'tests', 'supabase', 'ml-service', 'docs'].includes(e.name) ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]);
    for (const f of walk(root).filter(f => /\.(js|html|css|json)$/.test(f))) {
      const t = fs.readFileSync(f, 'utf8');
      assert.equal(/workers\.dev|PIA_ML_TOKEN|ML_TOKEN|pia-ml-api|\/predict/.test(t), false, path.relative(root, f));
    }
    assert.equal(/workers\.dev/.test(fs.readFileSync(path.join(root, '_headers'), 'utf8')), false);
  });

  py.kill();
  const failed = results.filter(r => !r.pass);
  console.log(JSON.stringify({ pass: results.length - failed.length, fail: failed.length, total: results.length, failures: failed }, null, 1));
  process.exit(failed.length ? 1 : 0);
})();
