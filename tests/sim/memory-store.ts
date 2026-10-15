// SIMULATION ONLY. An in-memory stand-in for the tables and the Auth Admin API
// that join-with-number talks to, so the real handler.ts can be exercised -- by
// the Deno use-case tests and by the local sim server -- without any database.
// It never reads a network address and holds no real data.
//
// It reimplements, in a few lines, what the SQL and Supabase Auth do:
//   * a student has ONE active session: the newest sign-in takes over and the
//     older browser is signed out (claim_student_session, migration 0027);
//   * a class is open for a section until its closing time;
//   * attendance defaults to everyone present, and the admin unmarks the absent.
import type { Deps, Student } from '../../supabase/functions/join-with-number/handler.ts';
import { normalizeNumber } from '../../supabase/functions/join-with-number/handler.ts';

export interface SimStudent extends Student { number: string }

export class MemoryStore {
  clock = Date.UTC(2026, 9, 14, 1, 0, 0);       // 14 Oct 2026, 09:00 in Manila
  students: SimStudent[] = [];
  classes = new Map<string, number>();          // section -> closes at (ms)
  absent = new Set<string>();                   // "section|email"
  attempts: { key: string; ok: boolean; at: number }[] = [];
  accounts = new Set<string>();                 // emails that have an auth user
  tokens = new Map<string, string>();           // one-time token -> email
  sessions = new Map<string, { id: number; device: string }>();   // email -> active
  log: string[] = [];
  private nextSession = 1;

  constructor(students: SimStudent[], activated: string[] = []) {
    this.students = students;
    activated.forEach((e) => this.accounts.add(e));
  }

  // ---- admin actions ------------------------------------------------------
  openClass(section: string, minutes = 120) {
    this.classes.set(section, this.clock + minutes * 60_000);
    for (const key of [...this.absent]) if (key.startsWith(section + '|')) this.absent.delete(key);
    this.log.push(`admin opened ${section} for ${minutes} min, everyone present`);
  }
  closeClass(section: string) { this.classes.delete(section); this.log.push(`admin closed ${section}`); }
  setPresent(section: string, email: string, present: boolean) {
    const k = section + '|' + email;
    if (present) this.absent.delete(k); else this.absent.add(k);
    this.log.push(`admin marked ${email} ${present ? 'present' : 'absent'}`);
  }
  advance(ms: number) { this.clock += ms; }

  // ---- the browser's side of verifyOtp -------------------------------------
  /** Redeem a one-time token on a browser. Returns who got in and who was kicked out. */
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
  private openNow(section: string) { const c = this.classes.get(section); return c !== undefined && c > this.clock; }

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
      anyClassOpen: async () => [...this.classes.keys()].some((s) => this.openNow(s)),
      classOpenFor: async (section) => this.openNow(section),
      isPresent: async (section, email) => !this.absent.has(section + '|' + email),
      ensureAccount: async (email) => {
        if (!this.accounts.has(email)) { this.accounts.add(email); this.log.push(`account created for ${email}`); }
      },
      mintToken: async (email) => {
        const t = 'tok-' + this.tokens.size + '-' + email;
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
