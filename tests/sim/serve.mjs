// SIMULATION SERVER. Serves the real site from this folder and replaces the
// Supabase SDK with tests/sim/sim-supabase.js, whose backend is the real
// join-with-number handler running on an in-memory store (memory-store.ts).
// No request ever leaves this machine and no real data is read or written.
//
//   node tests/sim/serve.mjs            then open  http://127.0.0.1:5599/__sim/
//
// Each browser TAB is one lab PC (its own session lives in sessionStorage).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleJoin } from '../../supabase/functions/join-with-number/handler.ts';
import { MemoryStore, sampleRoster } from './memory-store.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.PORT || 5599);
const ADMIN = { email: 'admin@school.test', full_name: 'Admin (simulated)', role: 'admin', section: '' };

let store;
function reset() { store = new MemoryStore(sampleRoster(), ['juan@student.test', 'maria@student.test']); }
reset();

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.woff2': 'font/woff2' };

const profileOf = (email) => {
  if (email === ADMIN.email) return ADMIN;
  const s = store.students.find((x) => x.email === email);
  return s ? { email: s.email, full_name: s.full_name, role: s.role, section: s.section, group_type: 'Assigned',
    is_ocean_done: false, current_stage: '', parental_consent: true, student_assent: true, must_change_password: false } : null;
};

const sections = () => [...new Set(store.students.filter((s) => s.role === 'student').map((s) => s.section))].sort();
// The page counts down in real time; translate the simulated clock to "now".
const realIso = (simMs) => new Date(Date.now() + (simMs - store.clock)).toISOString();

function overview() {
  return {
    sections: sections().map((section) => {
      const list = store.students.filter((s) => s.role === 'student' && s.section === section);
      return { section, students: list.length, without_number: list.filter((s) => !s.number).length,
        ocean_done: list.filter((s, i) => i % 2 === 0).length };
    }),
    open: [...store.checkins.entries()].filter(([, ends]) => ends > store.clock)
      .map(([section, ends]) => ({ section, ends_at: realIso(ends) })),
    waiting: store.waiting().filter((w) => store.isOpen(w.section))
      .map((w) => ({ id: w.id, section: w.section, full_name: w.name, created_at: realIso(w.createdMs), duplicate: w.duplicate })),
  };
}

function rpc(name, args, who) {
  const isAdmin = who === ADMIN.email;
  if (name.startsWith('admin_') && !isAdmin) return { error: { message: 'PIA: only an administrator can do this.', code: '42501' } };
  switch (name) {
    case 'admin_checkin_overview': return { data: overview() };
    case 'admin_start_checkin': store.startCheckin(args.p_section, args.p_minutes); return { data: 'checkin-' + args.p_section };
    case 'admin_stop_checkin': store.stopCheckin(args.p_section); return { data: null };
    case 'admin_let_in': return { data: store.letIn(args.p_ids || []) };
    case 'admin_import_student_numbers': {
      let n = 0;
      for (const r of args.p_rows || []) {
        const s = store.students.find((x) => x.email === String(r.email).toLowerCase());
        if (s) { s.number = r.number; n++; }
      }
      return { data: n };
    }
    case 'admin_numbers_taken': {
      const keys = new Set((args.p_numbers || []).map((n) => String(n).replace(/\D/g, '')));
      return { data: store.students.filter((x) => x.number && keys.has(String(x.number).replace(/\D/g, '')))
        .map((x) => ({ number_key: String(x.number).replace(/\D/g, ''), full_name: x.full_name, email: x.email })) };
    }
    case 'sim_add_student': {
      if (store.students.some((x) => x.email === args.email)) return { data: { status: 'duplicate' } };
      store.students.push({ number: '', full_name: args.fullName, section: args.section, email: args.email, role: 'student' });
      return { data: { status: 'created' } };
    }
    case 'admin_section_students':
      return { data: store.students.filter((x) => x.role === 'student' && x.section === args.p_section)
        .map((x, i) => ({ email: x.email, full_name: x.full_name, number: x.number || null,
          group_type: ['assigned', 'non-assigned', 'neutral', 'control'][i % 4], current_stage: i % 2 ? 'Waiting Room' : '', status: 'inactive', is_ocean_done: i % 2 === 0 })) };
    case 'admin_numbers_for': {
      const wanted = new Set((args.p_emails || []).map((e) => String(e).toLowerCase()));
      return { data: store.students.filter((x) => wanted.has(x.email) && x.number).map((x) => ({ email: x.email, number: x.number })) };
    }
    case 'admin_students_with_numbers':
      return { data: store.students.filter((s) => s.role === 'student' && s.section === args.p_section)
        .map((s) => ({ email: s.email, full_name: s.full_name, number: s.number || null })) };
    case 'admin_set_student_number': {
      const key = String(args.p_number).replace(/\D/g, '');
      if (!/^\d{11}$/.test(key)) return { error: { message: 'PIA: a student number has 11 digits.' } };
      const other = store.students.find((x) => x.email !== args.p_email && String(x.number).replace(/\D/g, '') === key);
      if (other) return { error: { message: 'PIA: that number already belongs to another student (' + other.email + ').' } };
      const s = store.students.find((x) => x.email === args.p_email);
      if (!s) return { error: { message: 'PIA: no student is registered with that email.' } };
      s.number = args.p_number;
      return { data: null };
    }
    case 'claim_student_session': return { data: null };
    case 'jwt_is_current': return { data: true };
    default: return { data: null };
  }
}

const readBody = (req) => new Promise((res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { res(JSON.parse(b || '{}')); } catch { res({}); } }); });
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);

  if (p === '/__sim/sim-supabase.js') { res.writeHead(200, { 'Content-Type': TYPES['.js'] }); return res.end(fs.readFileSync(path.join(ROOT, 'tests/sim/sim-supabase.js'))); }
  if (p === '/__sim/' || p === '/__sim') { res.writeHead(200, { 'Content-Type': TYPES['.html'] }); return res.end(fs.readFileSync(path.join(ROOT, 'tests/sim/launcher.html'))); }

  if (p.startsWith('/__sim/') && req.method === 'POST') {
    const body = await readBody(req);
    const ip = String(req.headers['x-sim-ip'] || req.socket.remoteAddress || 'local');
    if (p === '/__sim/fn/join-with-number') { const r = await handleJoin(body, ip, store.deps()); return json(res, r.status, r.body); }
    if (p === '/__sim/redeem') {
      const got = store.redeem(body.token, body.device);
      return got ? json(res, 200, { email: got.email, kicked: got.kickedDevice }) : json(res, 401, { error: 'invalid token' });
    }
    if (p === '/__sim/signout') { store.signOut(body.email); return json(res, 200, {}); }
    if (p === '/__sim/rpc') return json(res, 200, rpc(body.name, body.args || {}, body.email));
    if (p === '/__sim/advance') { store.advance(Number(body.ms) || 0); return json(res, 200, {}); }
    if (p === '/__sim/reset') { reset(); return json(res, 200, {}); }
  }
  if (p === '/__sim/profile') return json(res, 200, { data: profileOf(url.searchParams.get('email')) });
  if (p === '/__sim/session') {
    const email = url.searchParams.get('email'); const device = url.searchParams.get('device');
    return json(res, 200, { active: email === ADMIN.email || store.sessionOn(email) === device });
  }
  if (p === '/__sim/state') {
    return json(res, 200, {
      clock: new Date(store.clock).toISOString(),
      checkins: Object.fromEntries(sections().map((s) => [s, store.isOpen(s) ? 'open until ' + new Date(store.checkins.get(s)).toISOString().slice(11, 16) + ' UTC' : 'closed'])),
      waiting: store.waiting().map((w) => `${w.name} (${w.section})${w.duplicate ? ' DUPLICATE' : ''}`),
      sessions: Object.fromEntries([...store.sessions].map(([e, s]) => [e, s.device])),
      failedTries: store.attempts.filter((a) => !a.ok).length, log: store.log.slice(-12),
      students: store.students.filter((s) => s.role === 'student').map((s) => ({ number: s.number, name: s.full_name, section: s.section })),
    });
  }

  let file = path.join(ROOT, p === '/' ? 'index.html' : p);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
  const ext = path.extname(file);
  res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  if (ext === '.html') {
    // The real SDK is swapped for the simulated one; nothing else changes.
    return res.end(fs.readFileSync(file, 'utf8').replace(/<script[^>]*vendor\/supabase\.js[^>]*><\/script>/g, '<script src="/__sim/sim-supabase.js"></script>'));
  }
  res.end(fs.readFileSync(file));
}).listen(PORT, '127.0.0.1', () => console.log(`PIA simulation on http://127.0.0.1:${PORT}/__sim/  (no network, no real data)`));
