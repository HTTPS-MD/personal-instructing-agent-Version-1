// Use-case rehearsal for the student-number door with a roll call. Runs the REAL
// handler.ts against the in-memory store: no database, no network.
//   deno test tests/sim/join-usecases.test.ts
import {
  handleJoin, MESSAGES, MAX_FAILURES_PER_NUMBER, MAX_FAILURES_ALL, WINDOW_MS,
} from '../../supabase/functions/join-with-number/handler.ts';
import { MemoryStore, sampleRoster } from './memory-store.ts';

function eq(actual: unknown, expected: unknown, msg: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const call = (s: MemoryStore, body: Record<string, unknown>, ip = '10.0.0.1') => handleJoin(body, ip, s.deps());
const lookup = (s: MemoryStore, number: string, ip?: string) => call(s, { action: 'lookup', number }, ip);
const enter = (s: MemoryStore, number: string, ip?: string) => call(s, { action: 'enter', number }, ip);
const fresh = () => new MemoryStore(sampleRoster(), ['juan@student.test', 'maria@student.test']);
const JUAN = '2023-1230101';
const juan = 'juan@student.test';

Deno.test('1. attendance not started: nobody gets in, no name is read, and it says so', async () => {
  const s = fresh();
  const r = await lookup(s, JUAN);
  eq([r.status, r.body.error, r.body.closed, r.body.name], [403, MESSAGES.notReady, true, undefined], 'closed');
  eq((await enter(s, JUAN)).status, 403, 'entering is refused too');
  eq(s.attempts.length, 0, 'a closed attendance is not a failed try');
});

Deno.test('2. the normal case: marked present, confirms the name, walks straight in, once', async () => {
  const s = fresh(); s.startCheckin('7-A');
  s.mark('7-A', juan, true);
  const look = await lookup(s, '20231230101');
  eq([look.status, look.body.name, look.body.section], [200, 'Dela Cruz, Juan P.', '7-A'], 'name and section shown to confirm');
  const got = await enter(s, JUAN);
  eq([got.status, got.body.status, got.body.email], [200, 'let_in', juan], 'in, with no waiting');
  eq(s.redeem(String(got.body.token_hash), 'PC-01')?.email, juan, 'session opened on the browser that asked');
});

Deno.test('3. not marked yet, or marked absent: told to see the admin, and nothing is opened', async () => {
  const s = fresh(); s.startCheckin('7-A');
  const none = await enter(s, JUAN);
  eq([none.status, none.body.error, none.body.token_hash], [403, MESSAGES.notMarked, undefined], 'no mark');
  s.mark('7-A', juan, false);
  eq((await enter(s, JUAN)).body.error, MESSAGES.notMarked, 'marked absent');
  eq(s.attempts.length, 0, 'not counted as a guess: a real student can be unmarked');
  s.mark('7-A', juan, true);                                   // late: the admin marks them after the call
  eq((await enter(s, JUAN)).status, 200, 'marked present later: in');
});

Deno.test('4. unknown number and a section that is not open get the SAME words', async () => {
  const s = fresh(); s.startCheckin('7-A');
  const unknown = await lookup(s, '9999-9999999');
  const otherSection = await lookup(s, '2023-1230201');
  eq([unknown.status, unknown.body], [404, { error: MESSAGES.notFound }], 'unknown');
  eq(otherSection.body, unknown.body, 'identical reply for 7-B while only 7-A is open');
});

Deno.test('5. the admin stops attendance: the door is shut again, even for a student marked present', async () => {
  const s = fresh(); s.startCheckin('7-A'); s.mark('7-A', juan, true);
  s.stopCheckin('7-A');
  const r = await enter(s, JUAN);
  eq([r.status, r.body.closed], [403, true], 'closed');
});

Deno.test('6. a classmate types a present student\'s number first: the real one is refused, the admin sees it and lets them back in', async () => {
  const s = fresh(); s.startCheckin('7-A'); s.mark('7-A', juan, true);
  const copy = await enter(s, JUAN);
  s.redeem(String(copy.body.token_hash), 'PC-09');
  const real = await enter(s, JUAN);
  eq([real.status, real.body.error], [409, MESSAGES.alreadyIn], 'the real student is told');
  eq(s.markOf('7-A', juan)?.refused, 1, 'and the row shows one refused try');
  s.letBackIn('7-A', juan);
  const again = await enter(s, JUAN);
  const got = s.redeem(String(again.body.token_hash), 'PC-01');
  eq([got?.kickedDevice, s.sessionOn(juan)], ['PC-09', 'PC-01'], 'the copy is signed out when the real student gets in');
});

Deno.test('7. two computers type the same number at the same moment: exactly one gets in', async () => {
  const s = fresh(); s.startCheckin('7-A'); s.mark('7-A', juan, true);
  const [a, b] = await Promise.all([enter(s, JUAN, '10.0.0.1'), enter(s, JUAN, '10.0.0.2')]);
  eq([a.status, b.status].sort(), [200, 409], 'one in, one refused');
});

Deno.test('8. a one-time token cannot be used twice', async () => {
  const s = fresh(); s.startCheckin('7-A'); s.mark('7-A', juan, true);
  const t = String((await enter(s, JUAN)).body.token_hash);
  eq(s.redeem(t, 'PC-01') !== null, true, 'first use');
  eq(s.redeem(t, 'PC-02'), null, 'second use refused');
});

Deno.test('9. a new attendance starts clean: yesterday\'s check marks do not carry over', async () => {
  const s = fresh(); s.startCheckin('7-A'); s.mark('7-A', juan, true);
  s.stopCheckin('7-A'); s.startCheckin('7-A');
  eq((await enter(s, JUAN)).body.error, MESSAGES.notMarked, 'unmarked again');
});

Deno.test('10. the admin takes a check mark back before the student types: the student is turned away', async () => {
  const s = fresh(); s.startCheckin('7-A'); s.mark('7-A', juan, true); s.mark('7-A', juan, null);
  eq((await enter(s, JUAN)).status, 403, 'no mark, no entry');
});

Deno.test('11. marks only work while that section\'s attendance is open', async () => {
  const s = fresh();
  eq(s.mark('7-A', juan, true), false, 'nothing open: refused');
  s.startCheckin('7-B');
  eq(s.mark('7-A', juan, true), false, 'only 7-B is open');
});

Deno.test('12. guessing one number is throttled, a different student still gets through', async () => {
  const s = fresh(); s.startCheckin('7-A');
  for (let i = 0; i < MAX_FAILURES_PER_NUMBER; i++) await lookup(s, '2023-1239999', '10.0.0.' + i);
  eq((await lookup(s, '2023-1239999', '10.0.0.77')).status, 429, 'that number is throttled');
  eq((await lookup(s, JUAN, '10.0.0.77')).status, 200, 'a different student is fine');
  s.advance(WINDOW_MS + 1000);
  eq((await lookup(s, '2023-1239999', '10.0.0.77')).status, 404, 'the throttle lifts after the window');
});

Deno.test('13. a whole lab on one IP: ordinary typos do not lock the room', async () => {
  const s = fresh(); s.startCheckin('7-A');
  for (let i = 0; i < 20; i++) await lookup(s, '2023-1239' + String(i).padStart(3, '0'), '192.168.1.5');
  eq((await lookup(s, JUAN, '192.168.1.5')).status, 200, 'still fine after 20 typos');
});

Deno.test('14. faking the IP address cannot beat the brake: all failures together are capped', async () => {
  const s = fresh(); s.startCheckin('7-A');
  for (let i = 0; i < MAX_FAILURES_ALL; i++) await lookup(s, '20239' + String(i).padStart(6, '0'), '203.0.113.' + i);
  eq((await lookup(s, JUAN, '198.51.100.1')).status, 429, 'even a real student waits');
  s.advance(WINDOW_MS + 1000);
  eq((await lookup(s, JUAN, '198.51.100.1')).status, 200, 'and is fine once the window passes');
});

Deno.test('15. a teacher or admin number never opens a student session', async () => {
  const s = fresh(); s.startCheckin('7-A');
  const r = await enter(s, '2019-4560001');
  eq([r.status, r.body.error], [404, MESSAGES.notFound], 'refused like any unknown number');
});

Deno.test('16. a student who never activated gets an account the first time they walk in', async () => {
  const s = fresh(); s.startCheckin('7-A'); s.mark('7-A', 'pedro@student.test', true);
  eq(s.accounts.has('pedro@student.test'), false, 'no account before');
  eq((await enter(s, '2023-1230104')).status, 200, 'in');
  eq(s.accounts.has('pedro@student.test'), true, 'account created');
});

Deno.test('17. separators and spaces do not matter; junk is rejected before anything is looked up', async () => {
  const s = fresh(); s.startCheckin('7-A');
  for (const typed of ['2023 1230101', '2023-1230101', ' 20231230101 ']) eq((await lookup(s, typed)).status, 200, `"${typed}"`);
  for (const bad of ['', '12', '2023-123010', '2023-12301011', 'abcdefghijk']) eq((await lookup(s, bad)).status, 422, `"${bad}"`);
  eq(s.attempts.length, 0, 'junk is not counted as guesses');
});

Deno.test('18. the old request actions are gone', async () => {
  const s = fresh(); s.startCheckin('7-A');
  eq((await call(s, { action: 'request', number: JUAN })).status, 400, 'request');
  eq((await call(s, { action: 'poll', request_id: 'x' })).status, 400, 'poll');
});
