/* SIMULATION ONLY. Replaces the Supabase SDK in the browser with a client whose
   backend is tests/sim/serve.mjs. Each tab is one lab PC: its name comes from
   ?pc=PC-01 (kept in sessionStorage) and its session lives in sessionStorage,
   so several tabs behave like several computers. Nothing here talks to a real
   server. */
(function () {
  'use strict';
  var params = new URLSearchParams(location.search);
  if (params.get('pc')) { try { sessionStorage.setItem('sim_pc', params.get('pc')); } catch (e) { /* ignore */ } }
  var PC = sessionStorage.getItem('sim_pc') || 'PC-00';
  if (params.get('as') === 'admin') {
    sessionStorage.setItem('sim_session', JSON.stringify({ email: 'admin@school.test' }));
    try { localStorage.setItem('pia_user_email', 'admin@school.test'); localStorage.setItem('pia_user_role', 'admin'); } catch (e) { /* ignore */ }
  }
  window.__simPC = PC;

  function post(path, body) {
    return fetch('/__sim/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-sim-ip': '10.0.0.1' }, body: JSON.stringify(body || {}) });
  }
  function get(path) { return fetch('/__sim/' + path).then(function (r) { return r.json(); }); }
  function me() { try { return JSON.parse(sessionStorage.getItem('sim_session')); } catch (e) { return null; } }
  function sessionObj(s) { return s ? { access_token: 'sim', user: { id: s.email, email: s.email } } : null; }

  function builder(table) {
    var f = {}, q = {
      select: function () { return q; }, order: function () { return q; }, limit: function () { return q; }, in: function () { return q; },
      eq: function (k, v) { f[k] = v; return q; }, ilike: function (k, v) { f[k] = v; return q; },
      maybeSingle: function () { return run(true); }, single: function () { return run(true); },
      then: function (a, b) { return run(false).then(a, b); }
    };
    function run(one) {
      if (table === 'profiles' && f.email) {
        return get('profile?email=' + encodeURIComponent(f.email)).then(function (r) { return { data: one ? r.data : (r.data ? [r.data] : []), error: null }; });
      }
      if (table === 'professors') { return Promise.resolve({ data: [{ name: 'Roy Callope', email: 'roy@school.test', assigned_section: '7-A' }, { name: 'Ana Prof', email: 'ana@school.test', assigned_section: null }], error: null }); }
      return Promise.resolve({ data: one ? null : [], error: null });
    }
    return q;
  }

  var listeners = [];
  var client = {
    auth: {
      getSession: function () { return Promise.resolve({ data: { session: sessionObj(me()) }, error: null }); },
      getUser: function () { var s = me(); return Promise.resolve({ data: { user: s ? { email: s.email } : null }, error: null }); },
      onAuthStateChange: function (cb) { listeners.push(cb); return { data: { subscription: { unsubscribe: function () {} } } }; },
      signOut: function () { var s = me(); sessionStorage.removeItem('sim_session'); return (s ? post('signout', { email: s.email }) : Promise.resolve()).then(function () { return { error: null }; }); },
      verifyOtp: function (o) {
        return post('redeem', { token: o.token_hash, device: PC }).then(function (r) { return r.json().then(function (d) {
          if (!r.ok) { return { data: { user: null, session: null }, error: { message: 'invalid token' } }; }
          sessionStorage.setItem('sim_session', JSON.stringify({ email: d.email }));
          return { data: { user: { email: d.email }, session: sessionObj({ email: d.email }) }, error: null };
        }); });
      },
      signInWithPassword: function () { return Promise.resolve({ data: { user: null }, error: { message: 'Invalid login credentials' } }); },
      signInWithOtp: function () { return Promise.resolve({ data: {}, error: { message: 'disabled in simulation' } }); },
      resetPasswordForEmail: function () { return Promise.resolve({ data: {}, error: { message: 'disabled in simulation' } }); }
    },
    from: builder,
    rpc: function (name, args) {
      var s = me();
      return post('rpc', { name: name, args: args, email: s && s.email }).then(function (r) { return r.json(); })
        .then(function (r) { return { data: r.data === undefined ? null : r.data, error: r.error || null }; });
    },
    functions: { invoke: function (name, o) {
      return post('fn/' + name, o && o.body).then(function (r) { return r.json().then(function (d) {
        return r.ok ? { data: d, error: null } : { data: null, error: { context: { status: r.status, json: function () { return Promise.resolve(d); } } } };
      }); });
    } },
    channel: function () { var c = { on: function () { return c; }, subscribe: function () { return c; } }; return c; },
    removeChannel: function () {}
  };
  window.supabase = { createClient: function () { return client; } };

  /* A lab PC whose student was taken over by a newer sign-in notices within seconds. */
  setInterval(function () {
    var s = me();
    if (!s || s.email === 'admin@school.test') { return; }
    get('session?email=' + encodeURIComponent(s.email) + '&device=' + encodeURIComponent(PC)).then(function (r) {
      if (r.active) { return; }
      sessionStorage.removeItem('sim_session');
      try { localStorage.removeItem('pia_user_email'); } catch (e) { /* ignore */ }
      sessionStorage.setItem('sim_notice', 'Signed out: someone else entered with your student number.');
      location.href = '/index.html';
    });
  }, 2500);

  document.addEventListener('DOMContentLoaded', function () {
    var bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;left:0;bottom:0;z-index:99999;background:#111;color:#ffd24d;font:12px/1.4 monospace;padding:4px 10px;border-top-right-radius:8px;opacity:.92';
    bar.textContent = 'SIMULATION · ' + PC + ' · no real database';
    var note = sessionStorage.getItem('sim_notice');
    if (note) { bar.textContent += ' · ' + note; sessionStorage.removeItem('sim_notice'); bar.style.background = '#7a1c1c'; bar.style.color = '#fff'; }
    document.body.appendChild(bar);
  });
})();
