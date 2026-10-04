/* TEST HARNESS ONLY. A stand-in for the Supabase SDK and for the 0038 RPCs, so the
   page can be driven without a database. It reimplements the migration's rules in JS;
   it proves the page's wiring, not the SQL. Profile/state live in localStorage. */
(function () {
  var K_PROFILE = '__mock_profile', K_STATE = '__mock_state';
  function load(k, d) { try { return JSON.parse(localStorage.getItem(k)) || d; } catch (e) { return d; } }
  function save(k, v) { localStorage.setItem(k, JSON.stringify(v)); }
  var user = { id: 'mock-user', email: 'student@example.test' };
  function profile() {
    return Object.assign({ email: user.email, full_name: 'Mia Santos', role: 'student', group_type: 'Assigned',
      is_ocean_done: true, selected_character: 'pia-open', current_stage: '', section: '7-A' }, load(K_PROFILE, {}));
  }
  var S = load(K_STATE, { sessionId: 'sess-1', served: [], states: {}, done: [], progress: { topic: 1, answered: 0, good: 0, fail: 0 }, offers: [], win: null });
  function persist() { save(K_STATE, S); }
  window.__calls = window.__calls || []; window.__responses = [];

  var BANK = [];
  for (var i = 1; i <= 14; i++) {
    var pct = [10, 20, 25, 50, 40, 5, 30, 60, 15, 35, 45, 70, 80, 90][i - 1], base = 40 + i * 10;
    BANK.push({ id: i, topic: 1, question: 'What is ' + pct + '% of ' + base + '?',
      steps: [{ answer: String(pct / 100), hint1: 'Concept ' + i, hint2: 'Setup ' + i, hint3: 'Worked ' + i + ' ' + pct + '/100' }, { answer: String(pct * base / 100), hint1: 'Multiply it', hint2: 'Use the base', hint3: 'Worked ' + i }] });
  }
  [[40, 50, 10, 0.25, 25], [20, 30, 10, 0.5, 50], [80, 100, 20, 0.25, 25]].forEach(function (r, n) {
    BANK.push({ id: 20 + n, topic: 2, question: 'A price rises from ' + r[0] + ' to ' + r[1] + '. What is the percentage increase?',
      steps: [{ answer: String(r[2]), hint1: 'Subtract', hint2: 'New minus old', hint3: 'W' }, { answer: String(r[3]), hint1: 'Divide' }, { answer: String(r[4]), hint1: 'Convert', hint2: 'x100', hint3: 'W' }] });
  });

  function can(p, stage) {
    var g = String(p.group_type || '').trim().toLowerCase().replace('_', '-');
    if (stage === 'Tutoring Dashboard') return !!p.is_ocean_done && ['assigned', 'neutral', 'non-assigned'].indexOf(g) > -1 && !!p.selected_character;
    return false;
  }
  function guard() { if (!can(profile(), 'Tutoring Dashboard')) return { error: { message: 'PIA: the tutoring game is not available to this account.', code: '42501' } }; }
  function ev(t) {
    var e = String(t == null ? '' : t).replace(/,/g, '').replace(/PHP|₱/gi, '').replace(/×|·/g, '*').replace(/÷/g, '/').replace(/−/g, '-').replace(/%/g, '');
    e = e.replace(/(\d|\))\s*[xX]\s*(\d|\()/g, '$1*$2').trim();
    if (!e || e.length > 60 || !/^[0-9+*/(). \s-]+$/.test(e) || /--|\/\*|\*\//.test(e)) return null;
    try { var r = Function('"use strict";return (' + e + ')')(); return isFinite(r) ? r : null; } catch (x) { return null; }
  }
  function matches(u, k) { var a = ev(u), b = ev(k); return (a != null && b != null) ? Math.abs(a - b) <= 0.001 : String(u).trim().toLowerCase() === String(k).trim().toLowerCase(); }
  function working(t) { var w = String(t).trim().replace(/×|·/g, '*').replace(/÷/g, '/').replace(/−/g, '-').replace(/^[+-]\s*/, ''); return /[*/^()]/.test(w) || /\d\s*[xX]\s*(\d|\.)/.test(w) || /(\d|\))\s*[+-]\s*(\d|\()/.test(w); }
  function finalFmt(kind, t) { t = String(t).trim(); return kind === 'percentage' ? /^[+-]?(\d+(\.\d+)?|\.\d+)\s*%?$/.test(t) : /^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(t); }
  function fmt(kind, v) { return String(Number(v.toFixed(10))) + (kind === 'percentage' ? '%' : ''); }
  var req = function (t) { return t === 1 ? 2 : 3; };
  var label = function (t, i) { return t === 1 ? ['Conversion', 'Multiplication'][i] : ['Subtraction', 'Division', 'Conversion'][i]; };
  var kindOf = function (t, i) { return label(t, i) === 'Conversion' ? (t === 1 ? 'decimal' : 'percentage') : 'number'; };
  function sj(q, st) {
    return { done: false, problem_id: q.pid, problem_number: q.number, question: q.question, topic: S.progress.topic, question_topic: q.topic,
      steps_total: req(q.topic), step_labels: [0, 1, 2].slice(0, req(q.topic)).map(function (i) { return label(q.topic, i); }),
      current_step: st.step, stage: st.stage, confirm_kind: st.stage === 'confirm' ? kindOf(q.topic, st.step) : null, work_text: st.work,
      done_steps: st.doneSteps, wrong_streak: st.wrong, hint_unlocked: st.unlocked, hint_tier: st.tier, errors: st.errors, hints_used: st.hints, locked: st.completed };
  }
  function find(pid) { return S.served.filter(function (q) { return q.pid === pid; })[0]; }
  function bankq(id) { return BANK.filter(function (b) { return b.id === id; })[0]; }
  var rules = { mastery: 80, min: 3, max: 3 };
  /* The admin's closing time, reduced to what the page can learn: closed or not. A test flips it. */
  function expired() { return localStorage.getItem('__mock_closed') === '1'; }
  function clock() { return { window: 1, closed: expired(), expired: expired(), limit_seconds: 86400, remaining_seconds: 86400 }; }
  window.__mockExpireNow = function () { localStorage.setItem('__mock_closed', '1'); };
  window.__mockReopen = function () { localStorage.removeItem('__mock_closed'); };
  window.__mockWindow = function () { return { closed: expired() }; };

  var RPC = {
    set_student_stage: function () {   /* migration 0038 (Control OCEAN-only) rule: a tutor is NOT required to enter the stage */
      var p = profile(), g = String(p.group_type || '').trim().toLowerCase().replace('_', '-');
      return { data: { granted: !!p.is_ocean_done && g !== 'control' && !(g === 'non-assigned' && !p.selected_character) } };
    },
    resume_or_start_game_session: function () {
      var g = guard(); if (g) return g;
      var pend = S.served.filter(function (q) { return S.done.indexOf(q.pid) < 0; })[0];
      return { data: { session_id: S.sessionId, resumed: S.served.length > 0, problems_answered: S.progress.answered, correct_count: S.progress.clean || 0, topic: S.progress.topic, consecutive_correct: 0, pending_problem_id: pend ? pend.pid : null } };
    },
    serve_next_step_question: function () {
      var g = guard(); if (g) return g;
      var ck = clock();
      var o = S.offers.filter(function (x) { return x.status === 'pending'; })[0];
      if (o) return { data: { done: false, clock: ck, pending_offer: { problem_id: o.pid, type: o.type, from_topic: o.from, target_topic: o.to } } };
      var open = S.served.filter(function (q) { return S.done.indexOf(q.pid) < 0; })[0];
      if (open) return { data: Object.assign(sj(open, S.states[open.pid]), { clock: ck }) };
      var cnt = function (id) { return S.served.filter(function (q) { return q.id === id; }).length; };
      var last = S.served.length ? S.served[S.served.length - 1].id : null;
      var cand = BANK.slice().sort(function (a, b) { return Math.abs(a.topic - S.progress.topic) - Math.abs(b.topic - S.progress.topic) || cnt(a.id) - cnt(b.id) || ((a.id === last) - (b.id === last)) || a.id - b.id; })[0];
      if (!cand) return { data: { done: true, reason: 'bank_empty', clock: ck } };
      var rep = cnt(cand.id);
      var q = { id: cand.id, pid: 'qb-' + cand.id + (rep ? '#' + rep : ''), topic: cand.topic, question: cand.question, number: S.served.length + 1 };
      S.served.push(q);
      S.states[q.pid] = { step: 0, stage: 'work', work: null, wrong: 0, tier: 0, errors: 0, hints: 0, unlocked: false, doneSteps: [], completed: false };
      persist(); return { data: Object.assign(sj(q, S.states[q.pid]), { clock: ck }) };
    },
    restart_after_expiry: function () {
      var g = guard(); if (g) return g;
      if (expired()) return { data: { closed: true, restarted: false, clock: clock() } };
      var r0 = RPC.serve_next_step_question(); r0.data.restarted = false; return r0;
    },
    tutoring_status: function () { var g = guard(); if (g) return g; return { data: { closed: expired() } }; },
    check_step_answer: function (a) {
      var g = guard(); if (g) return g;
      var q = find(a.p_problem_id), st = S.states[a.p_problem_id], b = bankq(q.id), sub = String(a.p_submitted).trim().slice(0, 60);
      if (st.completed) return { data: { outcome: 'locked', state: sj(q, st), clock: clock() } };
      if (expired()) return { data: { outcome: 'time_expired', state: sj(q, st), clock: clock() } };
      var key = b.steps[st.step].answer, kind = kindOf(q.topic, st.step), out, text, confirmed;
      if (st.stage === 'work') {
        if (!matches(sub, key)) out = 'wrong';
        else if (!working(sub) && finalFmt(kind, sub)) { out = 'step_done'; text = fmt(kind, ev(sub)); }
        else out = 'needs_final';
      } else {
        var n = finalFmt(kind, sub) ? ev(sub) : null;
        if (n != null && Math.abs(n - ev(key)) <= 0.001) { out = 'step_done'; text = st.work; confirmed = fmt(kind, n); } else out = 'format_error';
      }
      if (out === 'wrong' || out === 'format_error') { st.errors++; st.wrong++; if (st.wrong >= 2) st.unlocked = true; }
      else if (out === 'needs_final') { st.stage = 'confirm'; st.work = sub; st.wrong = 0; st.tier = 0; }
      else { st.doneSteps.push({ text: text, confirmed: confirmed || null }); st.step++; st.stage = 'work'; st.work = null; st.wrong = 0; st.tier = 0; if (st.step >= req(q.topic)) { st.completed = true; out = 'question_done'; } }
      persist(); return { data: { outcome: out, step_text: text, confirmed: confirmed, state: sj(q, st), clock: clock() } };
    },
    consume_step_hint: function (a) {
      var g = guard(); if (g) return g;
      var q = find(a.p_problem_id), st = S.states[a.p_problem_id], b = bankq(q.id);
      if (st.completed || !st.unlocked || expired()) return { data: { hint: null, state: sj(q, st), clock: clock() } };
      var s = b.steps[st.step], list = [s.hint1, s.hint2, s.hint3].filter(Boolean); if (!list.length) list = ['Check your calculations carefully.'];
      st.tier = Math.min(st.tier + 1, list.length); st.hints++; persist();
      return { data: { hint: { text: list[st.tier - 1], tier: st.tier, tiers_total: list.length, step: st.step + 1 }, state: sj(q, st), clock: clock() } };
    },
    finish_step_question: function (a) {
      var g = guard(); if (g) return g;
      var q = find(a.p_problem_id), st = S.states[a.p_problem_id];
      if (!st.completed) return { error: { message: 'PIA: finish every step first.' } };
      var pr = S.progress, offer = null;
      if (S.done.indexOf(a.p_problem_id) < 0) {
        S.done.push(a.p_problem_id); var acc = st.errors === 0;
        pr.answered++; pr.clean = (pr.clean || 0) + (acc ? 1 : 0); pr.win = (pr.win || 0) + 1; pr.good = (pr.good || 0) + (acc ? 1 : 0); pr.fail = acc ? 0 : pr.fail + 1;
        pr.streak = acc ? (pr.streak || 0) + 1 : 0;
        if (pr.topic > 1 && pr.fail >= rules.max) offer = { type: 'down', from_topic: pr.topic, target_topic: pr.topic - 1 };
        else if (pr.topic < 3 && pr.win >= rules.min && pr.good * 100 >= rules.mastery * pr.win) offer = { type: 'up', from_topic: pr.topic, target_topic: pr.topic + 1 };
        if (offer) S.offers.push({ pid: a.p_problem_id, type: offer.type, from: offer.from_topic, to: offer.target_topic, status: 'pending' });
        persist();
      }
      return { data: { is_correct: st.errors === 0, classification: 'struggling', attempts_used: 1, hints_used: st.hints, topic: pr.topic, streak: pr.streak || 0, problems_answered: pr.answered, errors: st.errors, offer: offer } };
    },
    respond_topic_offer: function (a) {
      var g = guard(); if (g) return g;
      var o = S.offers.filter(function (x) { return x.pid === a.p_problem_id; })[0], pr = S.progress;
      if (o.status !== 'pending') return { data: { topic: pr.topic, status: o.status } };
      o.status = a.p_accept ? 'accepted' : 'refused';
      if (a.p_accept) { pr.topic = o.to; pr.win = 0; pr.good = 0; pr.fail = 0; } else if (o.type === 'up') { pr.win = 0; pr.good = 0; pr.fail = 0; } else pr.fail = 0;
      persist(); return { data: { topic: pr.topic, status: o.status } };
    }
  };

  function chain(table) {
    var c = { _t: table,
      select: function () { return c; }, eq: function () { return c; }, update: function (v) { window.__calls.push({ m: 'update', table: table, keys: Object.keys(v || {}) }); return c; },
      maybeSingle: function () {
        if (table === 'settings') return Promise.resolve({ data: { value: true }, error: null });
        if (table === 'v_tutoring_session_summary') return Promise.resolve({ data: { problems_answered: S.progress.answered, correct_count: S.progress.clean || 0, final_level: S.progress.topic }, error: null });
        return Promise.resolve({ data: profile(), error: null });
      },
      then: function (res) { res({ data: null, error: null }); } };
    return c;
  }
  var api = {
    auth: { getSession: async function () { return { data: { session: { access_token: 'mock', user: user } }, error: null }; },
      getUser: async function () { return { data: { user: Object.assign({}, user, { user_metadata: { pia_tutorial_seen_at: 'x' } }) }, error: null }; },
      updateUser: async function () { return { data: { user: user }, error: null }; },
      onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; },
      signOut: async function () { return { error: null }; } },
    from: chain,
    /* Stand-in for the Edge Function `learning-profile`. The page can only ask; the
       answer is whatever the test sets. */
    functions: { invoke: async function (name, opts) {
      window.__calls.push({ m: 'fn', name: name, body: opts && opts.body });
      if (guard()) return { data: null, error: { message: 'not available' } };
      if (localStorage.getItem('__mock_lp_fail')) return { data: null, error: { message: 'boom' } };
      return { data: { profile: localStorage.getItem('__mock_lp') || 'average', confidence: 0.7, source: 'ml' }, error: null };
    } },
    rpc: async function (name, args) {
      window.__calls.push({ m: 'rpc', name: name, args: args });
      var f = RPC[name]; var r = f ? f(args || {}) : { data: name === 'check_student_session' || name === 'jwt_is_current' ? true : null };
      window.__responses.push({ name: name, body: JSON.stringify(r) });
      if (r.error) return { data: null, error: r.error };
      return { data: r.data === undefined ? null : r.data, error: null };
    },
    /* Remembers the callbacks so a test can deliver a realtime event (window.__emitRealtime). */
    channel: function (name) {
      var ch = { on: function (type, filter, cb) { (window.__realtime = window.__realtime || []).push({ name: name, filter: filter, cb: cb }); return ch; }, subscribe: function () { return ch; } };
      return ch;
    },
    removeChannel: function () {}
  };
  window.__bank = BANK; window.__answerKeys = BANK.reduce(function (a, b) { return a.concat(b.steps.map(function (s) { return s.answer; })); }, []);
  window.__emitRealtime = function (name, payload) { (window.__realtime || []).filter(function (r) { return r.name.indexOf(name) === 0; }).forEach(function (r) { r.cb(payload); }); };
  window.__mockReset = function () { localStorage.removeItem(K_STATE); localStorage.removeItem('__mock_closed'); };
  window.supabase = { createClient: function () { return api; } };
})();
