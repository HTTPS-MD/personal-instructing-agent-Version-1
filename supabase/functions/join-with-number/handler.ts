// The rules of the student-number door, with no I/O of their own: everything
// that touches a database or the Auth Admin API arrives through `Deps`.
// index.ts wires Deps to Supabase; tests/sim wires the same handler to an
// in-memory store, so the use cases can be rehearsed without a database.
//
//   { action: 'lookup',  number }                -> { ok, name, section }
//   { action: 'request', number, secret }        -> { ok, request_id }
//   { action: 'poll',    request_id, secret }    -> { status: waiting | let_in | expired | closed | gone, ... }
//
// The flow: the student types a number and confirms the name (lookup), then
// asks to be let in (request). Typing the number NEVER opens a session. The
// admin, who can see the lab, ticks the students they see and lets them in. The
// student's browser polls with the secret it made itself; only that browser can
// collect the one-time sign-in token, and only once.
//
// A number is accepted only while an admin has a check-in open for the
// student's section. While nothing is open, the answer is the same for every
// number and no name is read, so nothing about the roster leaks.

export interface Student {
  email: string;
  full_name: string | null;
  section: string;
  role: string | null;
}

export interface RequestRow {
  id: string;
  email: string;
  section: string;
  secretHash: string;
  status: 'waiting' | 'let_in';
  createdMs: number;
  letInMs: number | null;
  delivered: boolean;
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
  /** Waiting, unexpired requests: for one student, or for everyone when email is null. */
  countWaiting(email: string | null, sinceMs: number): Promise<number>;
  createRequest(r: { email: string; section: string; secretHash: string }): Promise<string>;
  getRequest(id: string): Promise<RequestRow | null>;
  markDelivered(id: string): Promise<void>;
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
export const REQUEST_TTL_MS = 20 * 60_000;      // a request not let in by then is dead
export const LET_IN_GRACE_MS = 5 * 60_000;      // time to collect the token after being let in
export const MAX_WAITING_PER_STUDENT = 3;
export const MAX_WAITING_ALL = 300;

export const MESSAGES = {
  notReady: 'Attendance has not started yet. Please wait.',
  notFound: 'We could not find you in today’s attendance. Tell your admin.',
  throttled: 'Too many tries. Please wait a few minutes, or tell your admin.',
  badNumber: 'Type your 11-digit student number.',
  tooMany: 'Too many are waiting for this number. Tell your admin.',
  server: 'Something went wrong. Please try again.',
} as const;

/** Digits only: "2023-1230142" and "20231230142" are one number. A student number has 11 digits. */
export function normalizeNumber(raw: unknown): string {
  return String(raw ?? '').replace(/\D/g, '').slice(0, 24);
}

export const NUMBER_PATTERN = /^\d{11}$/;
const SECRET_PATTERN = /^[0-9a-f]{32,64}$/;

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function handleJoin(
  body: Record<string, unknown>,
  ip: string,
  deps: Deps,
): Promise<Reply> {
  const action = String(body.action ?? '');
  if (action === 'poll') return poll(body, deps);
  if (action !== 'lookup' && action !== 'request') return { status: 400, body: { error: 'Unknown action.' } };

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

  // ---- request -------------------------------------------------------------
  const secret = String(body.secret ?? '');
  if (!SECRET_PATTERN.test(secret)) return { status: 400, body: { error: MESSAGES.server } };

  const email = student.email.trim().toLowerCase();
  const waitingSince = deps.now() - REQUEST_TTL_MS;
  if ((await deps.countWaiting(email, waitingSince)) >= MAX_WAITING_PER_STUDENT
    || (await deps.countWaiting(null, waitingSince)) >= MAX_WAITING_ALL) {
    return { status: 429, body: { error: MESSAGES.tooMany } };
  }

  try {
    const id = await deps.createRequest({ email, section: student.section, secretHash: await sha256Hex(secret) });
    return { status: 200, body: { ok: true, request_id: id } };
  } catch {
    return { status: 500, body: { error: MESSAGES.server } };
  }
}

async function poll(body: Record<string, unknown>, deps: Deps): Promise<Reply> {
  const id = String(body.request_id ?? '');
  const secret = String(body.secret ?? '');
  if (!id || id.length > 64 || !SECRET_PATTERN.test(secret)) return { status: 200, body: { status: 'gone' } };

  const row = await deps.getRequest(id);
  // Same answer for "no such request" and "not your request": a stranger learns nothing.
  if (!row || row.secretHash !== await sha256Hex(secret)) return { status: 200, body: { status: 'gone' } };

  const now = deps.now();
  if (row.delivered) return { status: 200, body: { status: 'gone' } };

  if (row.status === 'let_in') {
    if (row.letInMs === null || now - row.letInMs > LET_IN_GRACE_MS) return { status: 200, body: { status: 'expired' } };
    try {
      await deps.ensureAccount(row.email);
      const tokenHash = await deps.mintToken(row.email);
      if (!tokenHash) return { status: 500, body: { error: MESSAGES.server } };
      await deps.markDelivered(row.id);        // one time: the next poll finds nothing
      return { status: 200, body: { status: 'let_in', email: row.email, token_hash: tokenHash } };
    } catch {
      return { status: 500, body: { error: MESSAGES.server } };
    }
  }

  if (now - row.createdMs > REQUEST_TTL_MS) return { status: 200, body: { status: 'expired' } };
  if (!(await deps.checkinOpenFor(row.section))) return { status: 200, body: { status: 'closed' } };
  return { status: 200, body: { status: 'waiting' } };
}
