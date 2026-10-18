// The rules of the student-number door, with no I/O of their own: everything
// that touches a database or the Auth Admin API arrives through `Deps`.
// index.ts wires Deps to Supabase; tests/sim wires the same handler to an
// in-memory store, so the use cases can be rehearsed without a database.
//
//   { action: 'lookup', number }   -> { ok, name, section }
//   { action: 'enter',  number }   -> { ok, status: 'let_in', email, token_hash }
//
// The flow: while an attendance is open the admin calls the names and marks each
// student present or absent. A student types the number and confirms the name
// (lookup), then enters. Only a student marked present gets a one-time sign-in
// token, and a number gets in ONCE per attendance: a second computer is refused
// and the admin sees it on that student's row.
//
// A number is accepted only while an admin has an attendance open for the
// student's section. While nothing is open, the answer is the same for every
// number and no name is read, so nothing about the roster leaks.

export interface Student {
  email: string;
  full_name: string | null;
  section: string;
  role: string | null;
}

export interface Deps {
  now(): number;
  /** Failed tries recorded under `key` since `sinceMs`. */
  countFailures(key: string, sinceMs: number): Promise<number>;
  record(key: string, ok: boolean): Promise<void>;
  findStudent(numberKey: string): Promise<Student | null>;
  /** True when ANY section has a check-in open right now. */
  anyCheckinOpen(): Promise<boolean>;
  /** The section has a check-in open right now. */
  checkinOpenFor(section: string): Promise<boolean>;
  /** The admin's mark for this student in the open attendance of the section. */
  attendanceFor(section: string, email: string): Promise<'none' | 'absent' | 'present' | 'entered'>;
  /** Present and not yet in: take the one place. False when someone else already took it. */
  claimEntry(section: string, email: string): Promise<boolean>;
  /** Give the place back (the token could not be made). */
  releaseEntry(section: string, email: string): Promise<void>;
  /** A second try on a number that is already in: the admin sees it. */
  noteRefusal(section: string, email: string): Promise<void>;
  /** Make sure an auth user exists for the email. */
  ensureAccount(email: string): Promise<void>;
  /** One-time sign-in token for that account's browser to redeem. */
  mintToken(email: string): Promise<string | null>;
}

export interface Reply { status: number; body: Record<string, unknown> }

export const MAX_FAILURES_PER_NUMBER = 5;
export const MAX_FAILURES_PER_IP = 60;      // a whole lab shares one address
// The address can be faked, so it cannot be the only brake: this caps ALL failed tries
// together. A lab of 40 children making typos stays far below it; a script guessing
// numbers does not.
export const MAX_FAILURES_ALL = 200;
export const WINDOW_MS = 10 * 60_000;

export const MESSAGES = {
  notReady: 'Attendance has not started yet. Please wait.',
  notFound: 'We could not find you in today’s attendance. Tell your admin.',
  throttled: 'Too many tries. Please wait a few minutes, or tell your admin.',
  badNumber: 'Type your 11-digit student number.',
  notMarked: 'Your admin has not marked you present. Tell your admin.',
  alreadyIn: 'This number is already in on another computer. Tell your admin.',
  server: 'Something went wrong. Please try again.',
} as const;

/** Digits only: "2023-1230142" and "20231230142" are one number. A student number has 11 digits. */
export function normalizeNumber(raw: unknown): string {
  return String(raw ?? '').replace(/\D/g, '').slice(0, 24);
}

export const NUMBER_PATTERN = /^\d{11}$/;

export async function handleJoin(
  body: Record<string, unknown>,
  ip: string,
  deps: Deps,
): Promise<Reply> {
  const action = String(body.action ?? '');
  if (action !== 'lookup' && action !== 'enter') return { status: 400, body: { error: 'Unknown action.' } };

  const key = normalizeNumber(body.number);
  if (!NUMBER_PATTERN.test(key)) return { status: 422, body: { error: MESSAGES.badNumber } };

  const since = deps.now() - WINDOW_MS;
  const [byNumber, byIp, byAll] = await Promise.all([
    deps.countFailures('n:' + key, since),
    deps.countFailures('ip:' + ip, since),
    deps.countFailures('all', since),
  ]);
  if (byNumber >= MAX_FAILURES_PER_NUMBER || byIp >= MAX_FAILURES_PER_IP || byAll >= MAX_FAILURES_ALL) {
    return { status: 429, body: { error: MESSAGES.throttled } };
  }

  const fail = async (reply: Reply): Promise<Reply> => {
    await Promise.all([deps.record('n:' + key, false), deps.record('ip:' + ip, false), deps.record('all', false)]);
    return reply;
  };

  // Nothing open anywhere: say so, whatever the number. No name is read, nothing leaks.
  if (!(await deps.anyCheckinOpen())) return { status: 403, body: { error: MESSAGES.notReady, closed: true } };

  const student = await deps.findStudent(key);
  const role = String(student?.role ?? 'student').trim().toLowerCase();
  const allowed = !!student && role !== 'admin' && role !== 'teacher' && (await deps.checkinOpenFor(student.section));
  if (!student || !allowed) return fail({ status: 404, body: { error: MESSAGES.notFound } });

  if (action === 'lookup') {
    return { status: 200, body: { ok: true, name: student.full_name ?? '', section: student.section } };
  }

  // ---- enter ----------------------------------------------------------------
  const email = student.email.trim().toLowerCase();
  const mark = await deps.attendanceFor(student.section, email);
  if (mark === 'none' || mark === 'absent') return { status: 403, body: { error: MESSAGES.notMarked } };
  if (mark === 'entered') {
    await deps.noteRefusal(student.section, email);
    return { status: 409, body: { error: MESSAGES.alreadyIn } };
  }

  // present: the place is taken first, so two computers typing at once cannot both get in.
  if (!(await deps.claimEntry(student.section, email))) {
    await deps.noteRefusal(student.section, email);
    return { status: 409, body: { error: MESSAGES.alreadyIn } };
  }
  try {
    await deps.ensureAccount(email);
    const tokenHash = await deps.mintToken(email);
    if (!tokenHash) { await deps.releaseEntry(student.section, email); return { status: 500, body: { error: MESSAGES.server } }; }
    return { status: 200, body: { ok: true, status: 'let_in', email, token_hash: tokenHash } };
  } catch {
    await deps.releaseEntry(student.section, email);
    return { status: 500, body: { error: MESSAGES.server } };
  }
}
