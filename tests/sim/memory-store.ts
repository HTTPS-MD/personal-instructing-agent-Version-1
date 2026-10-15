// SIMULATION ONLY. An in-memory stand-in for the tables and the Auth Admin API
// that join-with-number talks to, so the real handler.ts can be exercised -- by
// the Deno use-case tests and by the local sim server -- without any database.
// It never reads a network address and holds no real data.
//
// It reimplements, in a few lines, what the SQL and Supabase Auth do:
//   * a student has ONE active session: the newest sign-in takes over and the
//     older browser is signed out (claim_student_session, migration 0027);
//   * a check-in is open for a section until its end time or until it is stopped;
//   * the admin lets in the requests they tick (admin_let_in).
import type { Deps, RequestRow, Student } from '../../supabase/functions/join-with-number/handler.ts';
import { normalizeNumber } from '../../supabase/functions/join-with-number/handler.ts';

export interface SimStudent extends Student { number: string }
interface SimRequest extends RequestRow { name: string }

export class MemoryStore {
  clock = Date.UTC(2026, 9, 14, 1, 0, 0);       // 14 Oct 2026, 09:00 in Manila
  students: SimStudent[] = [];
  checkins = new Map<string, number>();         // section -> ends at (ms)
  requests = new Map<string, SimRequest>();
  attempts: { key: string; ok: boolean; at: number }[] = [];
  accounts = new Set<string>();                 // emails that have an auth user
  tokens = new Map<string, string>();           // one-time token -> email
  sessions = new Map<string, { id: number; device: string }>();   // email -> active
  log: string[] = [];
  private nextSession = 1;
  private nextRequest = 1;
  private nextToken = 1;

  constructor(students: SimStudent[], activated: string[] = []) {
    this.students = students;
    activated.forEach((e) => this.accounts.add(e));
  }

  // ---- admin actions ------------------------------------------------------
  startCheckin(section: string, minutes = 15) {
    this.checkins.set(section, this.clock + minutes * 60_000);
    this.log.push(`admin started check-in for ${section}, ${minutes} min`);
  }
  stopCheckin(section: string) { this.checkins.delete(section); this.log.push(`admin stopped check-in for ${section}`); }
  /** The admin ticks these requests and lets them in. */
  letIn(ids: string[]): number {
    let n = 0;
    for (const id of ids) {
      const r = this.requests.get(id);
      if (r && r.status === 'waiting' && this.clock - r.createdMs <= 20 * 60_000 && this.isOpen(r.section)) {
        r.status = 'let_in'; r.letInMs = this.clock; n++;
        this.log.push(`admin let in ${r.email}`);
      }
    }
    return n;
  }
  waiting(): (SimRequest & { duplicate: boolean })[] {
    const live = [...this.requests.values()].filter((r) => r.status === 'waiting' && this.clock - r.createdMs <= 20 * 60_000);
    return live.map((r) => ({ ...r, duplicate: live.filter((x) => x.email === r.email).length > 1 }));
  }
  advance(ms: number) { this.clock += ms; }

  // ---- the browser's side of verifyOtp -------------------------------------
  /** Redeem a one-time token on a browser. Returns who got in and which browser was kicked out. */
  redeem(token: string, device: string): { email: string; kickedDevice: string | null } | null {
    const email = this.tokens.get(token);
    if (!email) return null;
    this.tokens.delete(token);                  // one time only
    const previous = this.sessions.get(email);
    this.sessions.set(email, { id: this.nextSession++, device });
    return { email, kickedDevice: previous && previous.device !== device ? previous.device : null };
  }
  sessionOn(email: string) { return this.sessions.get(email)?.device ?? null; }
  signOut(email: string) { this.sessions.delete(email); }

  // ---- what the Edge Function sees -----------------------------------------
  isOpen(section: string) { const c = this.checkins.get(section); return c !== undefined && c > this.clock; }

  deps(): Deps {
    return {
      now: () => this.clock,
      countFailures: async (key, since) =>
        this.attempts.filter((a) => a.key === key && !a.ok && a.at >= since).length,
      record: async (key, ok) => { this.attempts.push({ key, ok, at: this.clock }); },
      findStudent: async (numberKey) => {
        const s = this.students.find((x) => normalizeNumber(x.number) === numberKey);
        return s ? { email: s.email, full_name: s.full_name, section: s.section, role: s.role } : null;
      },
      anyCheckinOpen: async () => [...this.checkins.keys()].some((s) => this.isOpen(s)),
      checkinOpenFor: async (section) => this.isOpen(section),
      countWaiting: async (email, since) =>
        [...this.requests.values()].filter((r) => r.status === 'waiting' && r.createdMs >= since && (email === null || r.email === email)).length,
      createRequest: async ({ email, section, secretHash }) => {
        const id = 'req-' + this.nextRequest++;
        const s = this.students.find((x) => x.email === email);
        this.requests.set(id, { id, email, section, secretHash, status: 'waiting', createdMs: this.clock, letInMs: null, delivered: false, name: s?.full_name ?? '' });
        return id;
      },
      getRequest: async (id) => { const r = this.requests.get(id); return r ? { ...r } : null; },
      markDelivered: async (id) => { const r = this.requests.get(id); if (r) r.delivered = true; },
      ensureAccount: async (email) => {
        if (!this.accounts.has(email)) { this.accounts.add(email); this.log.push(`account created for ${email}`); }
      },
      mintToken: async (email) => {
        const t = 'tok-' + this.nextToken++ + '-' + email;
        this.tokens.set(t, email);
        return t;
      },
    };
  }
}

export function sampleRoster(): SimStudent[] {
  const rows: [string, string, string, string][] = [
    ['2023-1230101', 'Dela Cruz, Juan P.', '7-A', 'juan'],
    ['2023-1230102', 'Santos, Maria C.', '7-A', 'maria'],
    ['2023-1230103', 'Reyes, Ana', '7-A', 'ana'],
    ['2023-1230104', 'Garcia, Pedro L.', '7-A', 'pedro'],
    ['2023-1230201', 'Bautista, Luis M.', '7-B', 'luis'],
    ['2023-1230202', 'Mendoza, Rica', '7-B', 'rica'],
    ['2023-1230301', 'Navarro, Ella S.', '7-C', 'ella'],
  ];
  const roster: SimStudent[] = rows.map(([number, full_name, section, id]) => (
    { number, full_name, section, email: id + '@student.test', role: 'student' }));
  roster.push({ number: '2019-4560001', full_name: 'Lopez, Teacher', section: '7-A', email: 'teacher@school.test', role: 'teacher' });
  return roster;
}
