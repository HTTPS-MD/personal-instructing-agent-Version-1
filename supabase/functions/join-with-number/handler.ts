// The rules of the student-number door, with no I/O of their own: everything
// that touches a database or the Auth Admin API arrives through `Deps`.
// index.ts wires Deps to Supabase; tests/sim wires the same handler to an
// in-memory store, so the use cases can be rehearsed without a database.
//
//   { action: 'lookup', number }  -> { ok, name }
//   { action: 'join',   number }  -> { ok, email, token_hash }
//
// A student is let in only if ALL of these hold:
//   1. the number is on the roster,
//   2. the admin has opened a class for the student's section and it has not
//      closed,
//   3. the admin has not marked the student absent for that class.
// Unknown number, closed section and absent student get ONE message, so the
// form cannot be used to learn which numbers exist or who is away.

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
  /** True when ANY section has an open class right now. */
  anyClassOpen(): Promise<boolean>;
  /** The student's section has an open class right now. */
  classOpenFor(section: string): Promise<boolean>;
  /** Marked present in that section's open class. */
  isPresent(section: string, email: string): Promise<boolean>;
  /** Make sure an auth user exists for the email; return nothing. */
  ensureAccount(email: string): Promise<void>;
  /** One-time sign-in token for that account's browser to redeem. */
  mintToken(email: string): Promise<string | null>;
}

export interface Reply { status: number; body: Record<string, unknown> }

export const MAX_FAILURES_PER_NUMBER = 5;
export const MAX_FAILURES_PER_IP = 60;      // a whole lab shares one address
export const WINDOW_MS = 10 * 60_000;

export const MESSAGES = {
  notReady: 'Class has not started yet. Please wait.',
  notFound: 'We could not find you in today’s class. Tell your admin.',
  throttled: 'Too many tries. Please wait a few minutes, or tell your admin.',
  badNumber: 'Type your student number.',
  server: 'Something went wrong. Please try again.',
} as const;

/** Letters and digits only, upper case: "2023-0142" and "20230142" are one number. */
export function normalizeNumber(raw: unknown): string {
  return String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 24);
}

export async function handleJoin(
  body: Record<string, unknown>,
  ip: string,
  deps: Deps,
): Promise<Reply> {
  const action = String(body.action ?? '');
  if (action !== 'lookup' && action !== 'join') return { status: 400, body: { error: 'Unknown action.' } };

  const key = normalizeNumber(body.number);
  if (key.length < 4) return { status: 422, body: { error: MESSAGES.badNumber } };

  const since = deps.now() - WINDOW_MS;
  const [byNumber, byIp] = await Promise.all([
    deps.countFailures('n:' + key, since),
    deps.countFailures('ip:' + ip, since),
  ]);
  if (byNumber >= MAX_FAILURES_PER_NUMBER || byIp >= MAX_FAILURES_PER_IP) {
    return { status: 429, body: { error: MESSAGES.throttled } };
  }

  const fail = async (reply: Reply): Promise<Reply> => {
    await Promise.all([deps.record('n:' + key, false), deps.record('ip:' + ip, false)]);
    return reply;
  };

  // Nothing open anywhere: say so, whatever the number. Leaks nothing.
  if (!(await deps.anyClassOpen())) return { status: 403, body: { error: MESSAGES.notReady, closed: true } };

  const student = await deps.findStudent(key);
  const role = String(student?.role ?? 'student').trim().toLowerCase();
  const allowed = !!student && role !== 'admin' && role !== 'teacher'
    && (await deps.classOpenFor(student.section))
    && (await deps.isPresent(student.section, student.email));
  if (!student || !allowed) return fail({ status: 404, body: { error: MESSAGES.notFound } });

  if (action === 'lookup') return { status: 200, body: { ok: true, name: student.full_name ?? '' } };

  const email = student.email.trim().toLowerCase();
  try {
    await deps.ensureAccount(email);
    const tokenHash = await deps.mintToken(email);
    if (!tokenHash) return { status: 500, body: { error: MESSAGES.server } };
    await deps.record('n:' + key, true);
    return { status: 200, body: { ok: true, email, token_hash: tokenHash } };
  } catch {
    return { status: 500, body: { error: MESSAGES.server } };
  }
}
