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
const classId = (section) => 'cls-' + section;
const sectionOf = (id) => String(id).replace(/^cls-/, '');

function overview() {
  const sections = [...new Set(store.students.filter((s) => s.role === 'student').map((s) => s.section))].sort();
  return {
    sections: sections.map((section) => ({ section, students: store.students.filter((s) => s.role === 'student' && s.section === section).length })),
    open: [...store.classes.entries()].filter(([, closes]) => closes > store.clock).map(([section, closes]) => ({
      id: classId(section), section, closes_at: new Date(closes - (Date.now() - store.clock) * 0).toISOString(),
      students: store.students.filter((s) => s.role === 'student' && s.section === section).map((s) => ({
        email: s.email, full_name: s.full_name, number: s.number, present: !store.absent.has(section + '|' + s.email) })),
    })),
  };
}

function rpc(name, args, who) {
  const isAdmin = who === ADMIN.email;
  if (name.startsWith('admin_') && !isAdmin) return { error: { message: 'PIA: only an administrator can do this.', code: '42501' } };
  switch (name) {
    case 'admin_class_overview': {
      const o = overview();
      // Real clock for the page's "closes in N min": translate the sim clock to now.
      o.open.forEach((c) => { c.closes_at = new Date(Date.now() + (store.classes.get(c.section) - store.clock)).toISOString(); });
      return { data: o };
    }
    case 'admin_open_class': store.openClass(args.p_section, args.p_minutes); return { data: classId(args.p_section) };
    case 'admin_close_class': store.closeClass(args.p_section); return { data: null };
    case 'admin_set_attendance': store.setPresent(sectionOf(args.p_class), args.p_email, args.p_present); return { data: null };
    case 'admin_import_student_numbers': {
      let n = 0;
      for (const r of args.p_rows || []) {
        const s = store.students.find((x) => x.email === String(r.email).toLowerCase());
        if (s) { s.number = r.number; n++; }
      }
      return { data: n };
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
      classes: Object.fromEntries([...store.classes].map(([s, c]) => [s, c > store.clock ? 'open until ' + new Date(c).toISOString().slice(11, 16) + ' UTC' : 'closed'])),
      absent: [...store.absent], sessions: Object.fromEntries([...store.sessions].map(([e, s]) => [e, s.device])),
      attempts: store.attempts.length, log: store.log.slice(-12),
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
