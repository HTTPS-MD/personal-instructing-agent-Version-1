// Use-case rehearsal for the student-number door with admin approval. Runs the
// REAL handler.ts against the in-memory store: no database, no network.
//   deno test tests/sim/join-usecases.test.ts
import {
  handleJoin, MESSAGES, MAX_FAILURES_PER_NUMBER, MAX_FAILURES_ALL, MAX_WAITING_PER_STUDENT,
  REQUEST_TTL_MS, LET_IN_GRACE_MS, WINDOW_MS,
} from '../../supabase/functions/join-with-number/handler.ts';
import { MemoryStore, sampleRoster } from './memory-store.ts';

function eq(actual: unknown, expected: unknown, msg: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const hex = (n: number) => Array.from({ length: 32 }, (_, i) => ((n + i) % 16).toString(16)).join('');
const call = (s: MemoryStore, body: Record<string, unknown>, ip = '10.0.0.1') => handleJoin(body, ip, s.deps());
const lookup = (s: MemoryStore, number: string, ip?: string) => call(s, { action: 'lookup', number }, ip);
const ask = (s: MemoryStore, number: string, secret = hex(1), ip?: string) => call(s, { action: 'request', number, secret }, ip);
const poll = (s: MemoryStore, id: unknown, secret = hex(1)) => call(s, { action: 'poll', request_id: id, secret });
const fresh = () => new MemoryStore(sampleRoster(), ['juan@student.test', 'maria@student.test']);

Deno.test('1. check-in not started: nobody gets in, no name is read, and it says so', async () => {
  const s = fresh();
  const r = await lookup(s, '2023-1230101');
  eq([r.status, r.body.error, r.body.closed, r.body.name], [403, MESSAGES.notReady, true, undefined], 'closed');
  eq(s.attempts.length, 0, 'a closed check-in is not a failed try');
});

Deno.test('2. the normal case: confirm, ask, wait, admin lets in, the browser gets in once', async () => {
  const s = fresh(); s.startCheckin('7-A');
  const look = await lookup(s, '20231230101');
  eq([look.status, look.body.name, look.body.section], [200, 'Dela Cruz, Juan P.', '7-A'], 'name and section shown to confirm');

  const req = await ask(s, '2023-1230101');
  eq(req.status, 200, 'request');
  const id = req.body.request_id;
  eq((await poll(s, id)).body.status, 'waiting', 'typing the number opens no session');
  eq(s.sessionOn('juan@student.test'), null, 'no session yet');

  eq(s.letIn([String(id)]), 1, 'admin lets in');
  const got = await poll(s, id);
  eq(got.body.status, 'let_in', 'now the browser can collect');
  eq(s.redeem(String(got.body.token_hash), 'PC-01')?.email, 'juan@student.test', 'session opened');
  eq((await poll(s, id)).body.status, 'gone', 'the token is handed over only once');
});

Deno.test('3. not ticked: the request dies after 20 minutes', async () => {
  const s = fresh(); s.startCheckin('7-A', 60);
  const id = (await ask(s, '2023-1230101')).body.request_id;
  s.advance(REQUEST_TTL_MS + 1000);
  eq((await poll(s, id)).body.status, 'expired', 'expired');
  eq(s.letIn([String(id)]), 0, 'and can no longer be let in');
});

Deno.test('4. unknown number and a section that is not open get the SAME words', async () => {
  const s = fresh(); s.startCheckin('7-A');
  const unknown = await lookup(s, '9999-9999999');
  const otherSection = await lookup(s, '2023-1230201');
  eq([unknown.status, unknown.body], [404, { error: MESSAGES.notFound }], 'unknown');
  eq(otherSection.body, unknown.body, 'identical reply for 7-B while only 7-A is open');
});

Deno.test('5. the admin stops check-in while someone is waiting: they are told it is closed', async () => {
  const s = fresh(); s.startCheckin('7-A');
  const id = (await ask(s, '2023-1230101')).body.request_id;
  s.stopCheckin('7-A');
  eq((await poll(s, id)).body.status, 'closed', 'closed');
  eq((await lookup(s, '2023-1230102')).body.closed, true, 'and nobody new is read');
});

Deno.test('6. let in just before stopping: the browser can still collect for a few minutes', async () => {
  const s = fresh(); s.startCheckin('7-A');
  const id = (await ask(s, '2023-1230101')).body.request_id;
  s.letIn([String(id)]); s.stopCheckin('7-A');
  eq((await poll(s, id)).body.status, 'let_in', 'collected');
});

Deno.test('7. let in but never collected: the offer lapses', async () => {
  const s = fresh(); s.startCheckin('7-A', 60);
  const id = (await ask(s, '2023-1230101')).body.request_id;
  s.letIn([String(id)]); s.advance(LET_IN_GRACE_MS + 1000);
  eq((await poll(s, id)).body.status, 'expired', 'lapsed');
});

Deno.test('8. another browser cannot collect the session: it does not have the secret', async () => {
  const s = fresh(); s.startCheckin('7-A');
  const id = (await ask(s, '2023-1230101', hex(1))).body.request_id;
  s.letIn([String(id)]);
  const thief = await poll(s, id, hex(7));
  eq([thief.body.status, thief.body.token_hash], ['gone', undefined], 'no token for a wrong secret');
  eq((await poll(s, id, hex(1))).body.status, 'let_in', 'the owner still can');
});

Deno.test('9. someone copies a classmate\'s number: both ask, the admin lets in one, the other is signed out when the real one enters', async () => {
  const s = fresh(); s.startCheckin('7-A');
  const fake = (await ask(s, '2023-1230101', hex(3))).body.request_id;
  const real = (await ask(s, '2023-1230101', hex(5))).body.request_id;
  eq(s.waiting().filter((w) => w.email === 'juan@student.test').every((w) => w.duplicate), true, 'the admin sees both, flagged');
  s.letIn([String(fake)]);
  const a = await poll(s, fake, hex(3));
  s.redeem(String(a.body.token_hash), 'PC-09');
  s.letIn([String(real)]);
  const b = await poll(s, real, hex(5));
  const got = s.redeem(String(b.body.token_hash), 'PC-01');
  eq([got?.kickedDevice, s.sessionOn('juan@student.test')], ['PC-09', 'PC-01'], 'the copy is kicked out when the real student comes in');
});

Deno.test('10. a one-time token cannot be used twice', async () => {
  const s = fresh(); s.startCheckin('7-A');
  const id = (await ask(s, '2023-1230101')).body.request_id;
  s.letIn([String(id)]);
  const t = String((await poll(s, id)).body.token_hash);
  eq(s.redeem(t, 'PC-01') !== null, true, 'first use');
  eq(s.redeem(t, 'PC-02'), null, 'second use refused');
});

Deno.test('11. a student cannot pile up requests', async () => {
  const s = fresh(); s.startCheckin('7-A');
  for (let i = 0; i < MAX_WAITING_PER_STUDENT; i++) eq((await ask(s, '2023-1230101', hex(i + 1))).status, 200, 'request ' + i);
  eq((await ask(s, '2023-1230101', hex(9))).status, 429, 'the next one is refused');
  eq((await ask(s, '2023-1230102', hex(9))).status, 200, 'another student is unaffected');
});

Deno.test('12. guessing one number is throttled, a different student still gets through', async () => {
  const s = fresh(); s.startCheckin('7-A');
  for (let i = 0; i < MAX_FAILURES_PER_NUMBER; i++) await lookup(s, '2023-1239999', '10.0.0.' + i);
  eq((await lookup(s, '2023-1239999', '10.0.0.77')).status, 429, 'that number is throttled');
  eq((await lookup(s, '2023-1230101', '10.0.0.77')).status, 200, 'a different student is fine');
  s.advance(WINDOW_MS + 1000);
  eq((await lookup(s, '2023-1239999', '10.0.0.77')).status, 404, 'the throttle lifts after the window');
});

Deno.test('13. a whole lab on one IP: ordinary typos do not lock the room', async () => {
  const s = fresh(); s.startCheckin('7-A');
  for (let i = 0; i < 20; i++) await lookup(s, '2023-1239' + String(i).padStart(3, '0'), '192.168.1.5');
  eq((await lookup(s, '2023-1230101', '192.168.1.5')).status, 200, 'still fine after 20 typos');
});

Deno.test('14. faking the IP address cannot beat the brake: all failures together are capped', async () => {
  const s = fresh(); s.startCheckin('7-A');
  for (let i = 0; i < MAX_FAILURES_ALL; i++) await lookup(s, '20239' + String(i).padStart(6, '0'), '203.0.113.' + i);
  eq((await lookup(s, '2023-1230101', '198.51.100.1')).status, 429, 'even a real student waits');
  s.advance(WINDOW_MS + 1000);
  eq((await lookup(s, '2023-1230101', '198.51.100.1')).status, 200, 'and is fine once the window passes');
});

Deno.test('15. a teacher or admin number never opens a student session', async () => {
  const s = fresh(); s.startCheckin('7-A');
  const r = await lookup(s, '2019-4560001');
  eq([r.status, r.body.error], [404, MESSAGES.notFound], 'refused like any unknown number');
});

Deno.test('16. a student who never activated gets an account the first time they are let in', async () => {
  const s = fresh(); s.startCheckin('7-A');
  const id = (await ask(s, '2023-1230104')).body.request_id;
  eq(s.accounts.has('pedro@student.test'), false, 'no account while only waiting');
  s.letIn([String(id)]);
  eq((await poll(s, id)).body.status, 'let_in', 'let in');
  eq(s.accounts.has('pedro@student.test'), true, 'account created');
});

Deno.test('17. separators and spaces do not matter; junk is rejected before anything is looked up', async () => {
  const s = fresh(); s.startCheckin('7-A');
  for (const typed of ['2023 1230101', '2023-1230101', ' 20231230101 ']) eq((await lookup(s, typed)).status, 200, `"${typed}"`);
  for (const bad of ['', '12', '2023-123010', '2023-12301011', 'abcdefghijk']) eq((await lookup(s, bad)).status, 422, `"${bad}"`);
  eq(s.attempts.length, 0, 'junk is not counted as guesses');
});

Deno.test('18. a request needs a proper secret, and nobody can read a request they did not make', async () => {
  const s = fresh(); s.startCheckin('7-A');
  eq((await ask(s, '2023-1230101', 'short')).status, 400, 'weak secret refused');
  eq((await poll(s, 'req-1', 'nope')).body.status, 'gone', 'bad secret');
  eq((await poll(s, 'req-999', hex(1))).body.status, 'gone', 'no such request looks the same');
});
