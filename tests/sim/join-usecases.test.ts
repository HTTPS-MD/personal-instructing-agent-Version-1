// Use-case rehearsal for the student-number door. Runs the REAL handler.ts
// against the in-memory store: no database, no network.
//   deno test tests/sim/join-usecases.test.ts
import { handleJoin, MESSAGES, MAX_FAILURES_PER_NUMBER, MAX_FAILURES_ALL, WINDOW_MS } from '../../supabase/functions/join-with-number/handler.ts';
import { MemoryStore, sampleRoster } from './memory-store.ts';

function eq(actual: unknown, expected: unknown, msg: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const join = (s: MemoryStore, number: string, ip = '10.0.0.1', action = 'join') =>
  handleJoin({ action, number }, ip, s.deps());
const fresh = () => new MemoryStore(sampleRoster(), ['juan@student.test', 'maria@student.test']);

Deno.test('1. class not opened yet: nobody gets in, and it says so', async () => {
  const s = fresh();
  const r = await join(s, '2023-1230101');
  eq([r.status, r.body.error, r.body.closed], [403, MESSAGES.notReady, true], 'closed');
  eq(s.attempts.length, 0, 'a closed class is not a failed try');
});

Deno.test('2. the normal case: open class, own number, confirm, in', async () => {
  const s = fresh(); s.openClass('7-A');
  const look = await join(s, '20231230101', '10.0.0.1', 'lookup');
  eq([look.status, look.body.name], [200, 'Dela Cruz, Juan P.'], 'lookup shows the name to confirm');
  const r = await join(s, '2023-1230101');
  eq(r.status, 200, 'join');
  const got = s.redeem(String(r.body.token_hash), 'PC-01');
  eq([got?.email, s.sessionOn('juan@student.test')], ['juan@student.test', 'PC-01'], 'session opened');
});

Deno.test('3. the absent classmate: someone types the number of a student marked absent', async () => {
  const s = fresh(); s.openClass('7-A'); s.setPresent('7-A', 'maria@student.test', false);
  const r = await join(s, '2023-1230102');
  eq([r.status, r.body.error], [404, MESSAGES.notFound], 'refused');
  eq(s.sessionOn('maria@student.test'), null, 'no session was opened for the absent student');
});

Deno.test('4. unknown number and absent student get the SAME words', async () => {
  const s = fresh(); s.openClass('7-A'); s.setPresent('7-A', 'maria@student.test', false);
  const absent = await join(s, '2023-1230102');
  const unknown = await join(s, '9999-9999999');
  eq(absent.body, unknown.body, 'identical reply');
});

Deno.test('5. a late student: the admin marks them present and they get in', async () => {
  const s = fresh(); s.openClass('7-A'); s.setPresent('7-A', 'ana@student.test', false);
  eq((await join(s, '2023-1230103')).status, 404, 'refused while absent');
  s.setPresent('7-A', 'ana@student.test', true);
  eq((await join(s, '2023-1230103')).status, 200, 'in once marked present');
});

Deno.test('6. only the opened section: 7-B cannot get in while only 7-A is open', async () => {
  const s = fresh(); s.openClass('7-A');
  const r = await join(s, '2023-1230201');
  eq([r.status, r.body.error], [404, MESSAGES.notFound], '7-B refused');
  s.openClass('7-B');
  eq((await join(s, '2023-1230201')).status, 200, '7-B in after the admin opens it');
});

Deno.test('7. the class closes by itself at its closing time', async () => {
  const s = fresh(); s.openClass('7-A', 60);
  eq((await join(s, '2023-1230101')).status, 200, 'in at minute 0');
  s.advance(61 * 60_000);
  const r = await join(s, '2023-1230101');
  eq([r.status, r.body.closed], [403, true], 'closed after 61 minutes');
});

Deno.test('8. impersonation of a PRESENT classmate: the real student is signed out, so it is noticed', async () => {
  const s = fresh(); s.openClass('7-A');
  const real = await join(s, '2023-1230101');
  s.redeem(String(real.body.token_hash), 'PC-01');
  const fake = await join(s, '2023-1230101');
  const got = s.redeem(String(fake.body.token_hash), 'PC-09');
  eq([got?.kickedDevice, s.sessionOn('juan@student.test')], ['PC-01', 'PC-09'], 'the first browser is kicked out');
});

Deno.test('9. a one-time token cannot be used twice', async () => {
  const s = fresh(); s.openClass('7-A');
  const r = await join(s, '2023-1230101');
  eq(s.redeem(String(r.body.token_hash), 'PC-01') !== null, true, 'first use');
  eq(s.redeem(String(r.body.token_hash), 'PC-02'), null, 'second use refused');
});

Deno.test('10. guessing one number is throttled, and a wrong guess on one number does not lock the class', async () => {
  const s = fresh(); s.openClass('7-A');
  for (let i = 0; i < MAX_FAILURES_PER_NUMBER; i++) await join(s, '2023-1239999', '10.0.0.' + i);
  eq((await join(s, '2023-1239999', '10.0.0.77')).status, 429, 'that number is throttled');
  eq((await join(s, '2023-1230101', '10.0.0.77')).status, 200, 'a different student still gets in');
  s.advance(WINDOW_MS + 1000);
  eq((await join(s, '2023-1239999', '10.0.0.77')).status, 404, 'the throttle lifts after the window');
});

Deno.test('11. a whole lab on one IP: ordinary mistakes do not lock the room', async () => {
  const s = fresh(); s.openClass('7-A');
  for (let i = 0; i < 20; i++) await join(s, '2023-1239' + String(i).padStart(3, '0'), '192.168.1.5');
  eq((await join(s, '2023-1230101', '192.168.1.5')).status, 200, 'still gets in after 20 typos from the same IP');
});

Deno.test('12. a teacher or admin number never opens a student session', async () => {
  const s = fresh(); s.openClass('7-A');
  const r = await join(s, '2019-4560001');
  eq([r.status, r.body.error], [404, MESSAGES.notFound], 'refused like any unknown number');
});

Deno.test('13. a student who never activated gets an account the first time', async () => {
  const s = fresh(); s.openClass('7-A');
  eq(s.accounts.has('pedro@student.test'), false, 'no account yet');
  eq((await join(s, '2023-1230104')).status, 200, 'join');
  eq(s.accounts.has('pedro@student.test'), true, 'account created');
});

Deno.test('14. separators and case do not matter', async () => {
  const s = fresh(); s.openClass('7-A');
  for (const typed of ['2023 1230101', '2023-1230101', ' 20231230101 ']) {
    eq((await join(s, typed)).status, 200, `"${typed}"`);
  }
});

Deno.test('15. junk input is rejected before anything is looked up', async () => {
  const s = fresh(); s.openClass('7-A');
  eq((await join(s, '')).status, 422, 'empty');
  eq((await join(s, '12')).status, 422, 'too short');
  eq((await join(s, '2023-123010')).status, 422, '10 digits');
  eq((await join(s, '2023-12301011')).status, 422, '12 digits');
  eq((await join(s, 'abcdefghijk')).status, 422, 'letters only');
  eq(s.attempts.length, 0, 'not counted as guesses');
});

Deno.test('16. faking the IP address cannot beat the brake: all failures together are capped', async () => {
  const s = fresh(); s.openClass('7-A');
  for (let i = 0; i < MAX_FAILURES_ALL; i++) {
    await join(s, '20239' + String(i).padStart(6, '0'), '203.0.113.' + (i % 250) + '.' + i);   // a new fake address every time
  }
  eq((await join(s, '2023-1230101', '198.51.100.1')).status, 429, 'even a real student waits');
  s.advance(WINDOW_MS + 1000);
  eq((await join(s, '2023-1230101', '198.51.100.1')).status, 200, 'and is let in once the window passes');
});
