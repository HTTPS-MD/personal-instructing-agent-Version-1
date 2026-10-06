#!/usr/bin/env node
/* PIA load test: N synthetic students using the tutoring game at the same time.
 *
 *   SUPABASE_SERVICE_ROLE_KEY=... node tests/load-100-students.cjs --confirm-target [--n 100] [--ramp 30] [--duration 300]
 *
 * What it does
 *   1. setup  : creates loadtestNNN@example.com (Auth user + profiles row) for N students.
 *   2. run    : every student signs in, claims the session, and then does what the real page does:
 *               check_student_session / record_heartbeat / touch_presence on their timers, and the
 *               game loop (serve question -> think -> check_step_answer -> finish -> learning-profile).
 *   3. report : request counts, errors, status codes, p50/p95/max latency per call.
 *
 * It never deletes anything. Clean up with supabase/staging/LOADTEST_cleanup.sql.
 *
 * The service role key is read from the environment only. It is used to create the accounts and to read
 * the answer key of the served question (a real student cannot), so some answers are correct.
 * Not covered: browser rendering, realtime websockets, the admin dashboard refresh.
 */
'use strict';
const crypto = require('crypto');

const URL_ = (process.env.SUPABASE_URL || 'https://hvfqqdtemayhhfavmfbs.supabase.co').replace(/\/+$/, '');
const ANON = process.env.SUPABASE_ANON_KEY || 'sb_publishable_NXpgU16p8YZ4oedc7MY5ng_J3F-2Mgy';
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const argv = process.argv.slice(2);
const flag = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true); };
const N        = Number(flag('n', 100));
const RAMP_S   = Number(flag('ramp', 30));       // logins spread over this many seconds (0 = all at once)
const DURATION = Number(flag('duration', 300));  // seconds each student keeps playing after login
const WRONG_P  = Number(flag('wrong', 0.3));     // share of answers deliberately wrong
const THINK    = [Number(flag('think-min', 4)), Number(flag('think-max', 12))]; // seconds per answer
const SKIP_SETUP = flag('skip-setup', false) === true;

if (!SERVICE) { console.error('Set SUPABASE_SERVICE_ROLE_KEY in this terminal first.'); process.exit(1); }
if (flag('confirm-target', false) !== true) {
  console.error('This will create ' + N + ' accounts on ' + URL_ + '.\nAdd --confirm-target to proceed.');
  process.exit(1);
}

const EMAIL = (i) => 'loadtest' + String(i).padStart(3, '0') + '@example.com';
// In memory only, unless LOADTEST_PASSWORD is set (needed to re-run with --skip-setup against the same accounts).
const PASSWORD = process.env.LOADTEST_PASSWORD || ('Lt-' + crypto.randomBytes(12).toString('base64url') + '!9');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => a + Math.random() * (b - a);

/* ---- metrics ---- */
const stats = {};
function rec(name, ms, status, ok) {
  const s = stats[name] || (stats[name] = { n: 0, err: 0, ms: [], codes: {} });
  s.n++; if (!ok) s.err++; s.ms.push(ms); s.codes[status] = (s.codes[status] || 0) + 1;
}
const outcomes = {};
const firstErrors = {};
async function call(name, url, opts) {
  const t0 = performance.now();
  let status = 0, body = null, ok = false;
  try {
    const res = await fetch(url, opts);
    status = res.status;
    const text = await res.text();
    try { body = text ? JSON.parse(text) : null; } catch (_e) { body = text; }
    ok = res.ok;
  } catch (e) { status = 0; body = String(e && e.message || e); }
  rec(name, performance.now() - t0, status, ok);
  if (!ok && !firstErrors[name]) firstErrors[name] = status + ' ' + JSON.stringify(body).slice(0, 200);
  return { ok, status, body };
}
const svcHeaders = { apikey: SERVICE, Authorization: 'Bearer ' + SERVICE, 'Content-Type': 'application/json' };

/* ---- setup ---- */
async function setupOne(i) {
  const email = EMAIL(i);
  const u = await call('setup:auth-user', URL_ + '/auth/v1/admin/users', {
    method: 'POST', headers: svcHeaders,
    body: JSON.stringify({ email, password: PASSWORD, email_confirm: true })
  });
  if (!u.ok && !(u.body && /already|registered|exists/i.test(JSON.stringify(u.body)))) return false;
  if (!u.ok) { // exists from an earlier run: give it this run's password
    const list = await call('setup:find-user', URL_ + '/auth/v1/admin/users?per_page=1000', { headers: svcHeaders });
    const found = list.ok && (list.body.users || []).find((x) => x.email === email);
    if (!found) return false;
    await call('setup:reset-pw', URL_ + '/auth/v1/admin/users/' + found.id, {
      method: 'PUT', headers: svcHeaders, body: JSON.stringify({ password: PASSWORD })
    });
  }
  const p = await call('setup:profile', URL_ + '/rest/v1/profiles?on_conflict=email', {
    method: 'POST', headers: { ...svcHeaders, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([{
      email, full_name: 'LOADTEST - delete', role: 'student', section: 'LOADTEST',
      group_type: 'Assigned', is_ocean_done: true, selected_character: 'pia-open',
      parental_consent: true, student_assent: true, max_devices: 1
    }])
  });
  return p.ok;
}

/* ---- one student ---- */
async function student(i, endAt) {
  const email = EMAIL(i);
  const tag = (n) => n;
  const login = await call(tag('auth:sign-in'), URL_ + '/auth/v1/token?grant_type=password', {
    method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD })
  });
  if (!login.ok) return;
  const token = login.body.access_token;
  const H = { apikey: ANON, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  const rpc = (fn, args) => call('rpc:' + fn, URL_ + '/rest/v1/rpc/' + fn, { method: 'POST', headers: H, body: JSON.stringify(args || {}) });

  const device = crypto.randomUUID();
  await rpc('claim_student_session', { p_device_id: device });
  await rpc('set_student_stage', { p_stage: 'Tutoring Dashboard' });

  let alive = true;
  const timers = [
    setInterval(() => rpc('check_student_session'), 10000),
    setInterval(() => rpc('record_heartbeat', { p_stage: 'Tutoring Dashboard' }), 30000),
    setInterval(() => rpc('touch_presence', { p_online: true }), 45000)
  ];
  rpc('touch_presence', { p_online: true }); rpc('record_heartbeat', { p_stage: 'Tutoring Dashboard' });

  const sess = await rpc('resume_or_start_game_session');
  if (!sess.ok || !sess.body || !sess.body.session_id) { timers.forEach(clearInterval); return; }
  const sid = sess.body.session_id;

  async function answerKey(problemId, stepIndex) {
    const r = await call('svc:read-answer-key', URL_ + '/rest/v1/served_questions?select=steps&session_id=eq.' + sid +
      '&problem_id=eq.' + encodeURIComponent(problemId) + '&student_email=eq.' + encodeURIComponent(email), { headers: svcHeaders });
    const step = r.ok && r.body && r.body[0] && r.body[0].steps && r.body[0].steps[stepIndex];
    return step ? String(step.answer != null ? step.answer : step.stepAnswer) : null;
  }

  while (alive && Date.now() < endAt) {
    const q = await rpc('serve_next_step_question', { p_session_id: sid });
    if (!q.ok || !q.body) { await sleep(4000); continue; }
    const d = q.body;
    if (!d.problem_id && !d.pending_offer) {
      outcomes['serve:no-question'] = (outcomes['serve:no-question'] || 0) + 1;
      if (!firstErrors['serve:no-question']) firstErrors['serve:no-question'] = JSON.stringify(d).slice(0, 400);
    }
    if (d.done) break;
    if (d.pending_offer) { await rpc('respond_topic_offer', { p_session_id: sid, p_problem_id: d.pending_offer.problem_id, p_accept: false }); continue; }
    if (d.clock && d.clock.expired) {
      outcomes['serve:clock-expired'] = (outcomes['serve:clock-expired'] || 0) + 1;
      if (!firstErrors['serve:clock-expired']) firstErrors['serve:clock-expired'] = JSON.stringify(d.clock).slice(0, 300);
      break;
    }

    let idx = Number(d.current_step) || 0, completed = d.locked === true, guard = 0;
    while (!completed && Date.now() < endAt && guard++ < 40) {
      await sleep(rnd(THINK[0], THINK[1]) * 1000);
      const key = await answerKey(d.problem_id, idx);
      if (key == null) break;
      const wrong = Math.random() < WRONG_P;
      const submitted = wrong ? String(Number(key) + 1 || 'x') : key;
      let r = await rpc('check_step_answer', { p_session_id: sid, p_problem_id: d.problem_id, p_submitted: submitted });
      if (!r.ok || !r.body) continue;
      let out = r.body.outcome; outcomes[out] = (outcomes[out] || 0) + 1;
      if (out === 'needs_final' || out === 'format_error') {
        r = await rpc('check_step_answer', { p_session_id: sid, p_problem_id: d.problem_id, p_submitted: key });
        if (r.ok && r.body) { out = r.body.outcome; outcomes[out] = (outcomes[out] || 0) + 1; }
      }
      if (out === 'wrong' && Math.random() < 0.4) await rpc('consume_step_hint', { p_session_id: sid, p_problem_id: d.problem_id });
      if (out === 'time_expired') { alive = false; break; }
      const st = r.body && r.body.state;
      if (out === 'question_done' || out === 'locked' || (st && st.completed)) completed = true;
      else if (st && st.current_step != null) idx = Number(st.current_step);
    }
    if (completed) {
      await rpc('finish_step_question', { p_session_id: sid, p_problem_id: d.problem_id });
      call('edge:learning-profile', URL_ + '/functions/v1/learning-profile', { method: 'POST', headers: H, body: JSON.stringify({ session_id: sid }) });
    }
  }
  timers.forEach(clearInterval);
  await rpc('touch_presence', { p_online: false });
}

/* ---- report ---- */
function pct(a, p) { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; }
function report() {
  const rows = Object.keys(stats).sort().map((k) => {
    const s = stats[k];
    return { call: k, n: s.n, errors: s.err, 'err%': (100 * s.err / s.n).toFixed(1), p50_ms: Math.round(pct(s.ms, 0.5)), p95_ms: Math.round(pct(s.ms, 0.95)), max_ms: Math.round(Math.max(...s.ms)), codes: JSON.stringify(s.codes) };
  });
  console.table(rows);
  console.log('answer outcomes:', outcomes);
  if (Object.keys(firstErrors).length) { console.log('first error per call:'); for (const k in firstErrors) console.log('  ' + k + ' -> ' + firstErrors[k]); }
  const limited = Object.values(stats).reduce((a, s) => a + (s.codes[429] || 0), 0);
  console.log('HTTP 429 (rate limited) responses:', limited);
}

(async () => {
  console.log('Target ' + URL_ + ' | students ' + N + ' | ramp ' + RAMP_S + 's | play ' + DURATION + 's');
  if (!SKIP_SETUP) {
    console.log('Setting up accounts...');
    let okCount = 0;
    for (let i = 1; i <= N; i += 10) {
      const batch = []; for (let j = i; j < Math.min(i + 10, N + 1); j++) batch.push(setupOne(j));
      (await Promise.all(batch)).forEach((x) => { if (x) okCount++; });
    }
    console.log('Accounts ready: ' + okCount + '/' + N);
    if (okCount < N) { report(); console.error('Setup incomplete; stopping before the load phase.'); process.exit(2); }
  }
  const waitS = Number(flag('wait-after-setup', 0));
  if (waitS > 0) {
    console.log('Waiting ' + waitS + 's so the account-creation calls leave the rate-limit window...');
    for (let left = waitS; left > 0; left -= 30) { console.log('  ' + left + 's left'); await sleep(Math.min(30, left) * 1000); }
  }
  console.log('Starting students...');
  const endAt = Date.now() + RAMP_S * 1000 + DURATION * 1000;
  const t0 = Date.now();
  await Promise.all(Array.from({ length: N }, async (_, k) => {
    await sleep(RAMP_S ? rnd(0, RAMP_S * 1000) : 0);
    try { await student(k + 1, endAt); } catch (e) { rec('student:crash', 0, 0, false); firstErrors['student:crash'] = String(e); }
  }));
  console.log('Finished in ' + Math.round((Date.now() - t0) / 1000) + 's');
  report();
  console.log('\nClean up: run supabase/staging/LOADTEST_cleanup.sql in the SQL Editor.');
})();
