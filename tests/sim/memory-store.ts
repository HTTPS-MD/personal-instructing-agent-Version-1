// SIMULATION ONLY. An in-memory stand-in for the tables and the Auth Admin API
// that join-with-number talks to, so the real handler.ts can be exercised -- by
// the Deno use-case tests and by the local sim server -- without any database.
// It never reads a network address and holds no real data.
//
// It reimplements, in a few lines, what the SQL and Supabase Auth do:
//   * a student has ONE active session: the newest sign-in takes over and the
//     older browser is signed out (claim_student_session, migration 0027);
//   * a check-in is open for a section until its end time or until it is stopped;
//   * the admin marks each student present or absent, and a number gets in once.
import type { Deps, Student } from '../../supabase/functions/join-with-number/handler.ts';
import { normalizeNumber } from '../../supabase/functions/join-with-number/handler.ts';

export interface SimStudent extends Student { number: string }
interface Mark { present: boolean; entered: boolean; refused: number }

export class MemoryStore {
  clock = Date.UTC(2026, 9, 14, 1, 0, 0);       // 14 Oct 2026, 09:00 in Manila
  students: SimStudent[] = [];
  checkins = new Map<string, number>();         // section -> ends at (ms)
  marks = new Map<string, Mark>();              // `${section}|${email}` for the open attendance
  attempts: { key: string; ok: boolean; at: number }[] = [];
  accounts = new Set<string>();                 // emails that have an auth user
  tokens = new Map<string, string>();           // one-time token -> email
  sessions = new Map<string, { id: number; device: string }>();   // email -> active
  log: string[] = [];
  private nextSession = 1;
  private nextToken = 1;

  constructor(students: SimStudent[], activated: string[] = []) {
    this.students = students;
    activated.forEach((e) => this.accounts.add(e));
  }

  // ---- admin actions ------------------------------------------------------
  startCheckin(section: string, minutes = 15) {
    this.checkins.set(section, this.clock + minutes * 60_000);
    for (const k of [...this.marks.keys()]) if (k.startsWith(section + '|')) this.marks.delete(k);   // a new attendance starts clean
    this.log.push(`admin started attendance for ${section}, ${minutes} min`);
  }
  stopCheckin(section: string) { this.checkins.delete(section); this.log.push(`admin stopped check-in for ${section}`); }
  /** The admin marks a student present (true), absent (false) or clears the mark (null). */
  mark(section: string, email: string, present: boolean | null): boolean {
    if (!this.isOpen(section)) return false;
    const key = section + '|' + email;
    if (present === null) { this.marks.delete(key); return true; }
    const was = this.marks.get(key);
    this.marks.set(key, { present, entered: was?.entered ?? false, refused: was?.refused ?? 0 });
    this.log.push(`admin marked ${email} ${present ? 'present' : 'absent'}`);
    return true;
  }
  letBackIn(section: string, email: string) {
    const m = this.marks.get(section + '|' + email);
    if (m) { m.entered = false; m.refused = 0; this.log.push(`admin let ${email} back in`); }
  }
  markOf(section: string, email: string): Mark | undefined { return this.marks.get(section + '|' + email); }
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
      attendanceFor: async (section, email) => {
        const m = this.marks.get(section + '|' + email);
        return !m ? 'none' : !m.present ? 'absent' : m.entered ? 'entered' : 'present';
      },
      claimEntry: async (section, email) => {
        const m = this.marks.get(section + '|' + email);
        if (!m || !m.present || m.entered) return false;
        m.entered = true; return true;
      },
      releaseEntry: async (section, email) => { const m = this.marks.get(section + '|' + email); if (m) m.entered = false; },
      noteRefusal: async (section, email) => { const m = this.marks.get(section + '|' + email); if (m) m.refused++; },
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
