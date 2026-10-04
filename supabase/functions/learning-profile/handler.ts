// PIA -- learning-profile: the request logic, free of Deno imports so it can be
// tested in Node (tests/learning-profile-edge.cjs). index.ts wires it to Supabase.
//
// Flow: student's browser -> THIS function -> pia-ml-api (Cloudflare).
//   1. The student's own token is required. The numbers come from the database
//      (get_learning_features, run AS the student, so the game's guard applies:
//      Control, teachers and signed-out callers are refused).
//   2. Exactly seven numbers are sent to the ML service, picked by name below:
//      no name, email, student id, session id, tutor or group. The token for the
//      ML service lives only in this function's secrets.
//   3. Only {profile, confidence} goes back to the browser. Any failure is a
//      plain error and the page keeps its current wording.
// The browser sends only {session_id}. It cannot send features and cannot send
// "learn": there is nothing in this path that can change the model.

export type Env = {
  mlUrl: string;
  mlToken: string;
  allowedOrigins: string[];
  timeoutMs?: number;
};
export type Rpc = (authHeader: string, sessionId: string) => Promise<{ data: unknown; error: { message?: string } | null }>;

const FEATURES = [
  'recent_accuracy', 'average_attempts', 'hint_rate', 'average_response_time',
  'correct_response_efficiency', 'consecutive_correct', 'consecutive_wrong',
] as const;
const PROFILES = ['struggling', 'average', 'outstanding'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIN_EVENTS = 2; // the attached game waits for two answers before asking

function cors(origin: string | null, env: Env): Record<string, string> {
  const h: Record<string, string> = { Vary: 'Origin' };
  if (origin && env.allowedOrigins.includes(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Headers'] = 'authorization, x-client-info, apikey, content-type';
    h['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
  }
  return h;
}

function reply(status: number, body: Record<string, unknown>, origin: string | null, env: Env): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(origin, env), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export async function handle(req: Request, env: Env, rpc: Rpc, fetchFn: typeof fetch = fetch): Promise<Response> {
  const origin = req.headers.get('Origin');
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin, env) });
  if (req.method !== 'POST') return reply(405, { error: 'POST only.' }, origin, env);

  // Off until both the ML address and its secret are configured.
  if (!env.mlUrl || !env.mlToken) return reply(503, { error: 'Not configured.' }, origin, env);

  const auth = req.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ') || auth.length < 20) return reply(401, { error: 'Sign in first.' }, origin, env);

  let sessionId = '';
  try {
    const body = await req.json();
    if (!body || typeof body !== 'object' || Object.keys(body).join() !== 'session_id') throw new Error('shape');
    sessionId = String((body as Record<string, unknown>).session_id);
    if (!UUID.test(sessionId)) throw new Error('uuid');
  } catch (_e) {
    return reply(400, { error: 'Send only {"session_id": "<uuid>"}.' }, origin, env);
  }

  const res = await rpc(auth, sessionId);
  if (res.error || !res.data || typeof res.data !== 'object') {
    return reply(403, { error: 'Not available for this account.' }, origin, env);
  }
  const src = res.data as { events?: number; features?: Record<string, unknown> };
  const events = Number(src.events || 0);
  if (events < MIN_EVENTS) return reply(200, { profile: 'average', confidence: null, source: 'default' }, origin, env);

  // Pick the seven by name; nothing else is ever forwarded.
  const payload: Record<string, number> = {};
  for (const k of FEATURES) {
    const v = Number(src.features ? src.features[k] : NaN);
    if (!Number.isFinite(v)) return reply(502, { error: 'Bad features.' }, origin, env);
    payload[k] = v;
  }

  try {
    const ml = await fetchFn(env.mlUrl.replace(/\/+$/, '') + '/predict', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.mlToken },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(env.timeoutMs || 5000),
    });
    if (!ml.ok) return reply(502, { error: 'Profile service unavailable.' }, origin, env);
    const out = await ml.json() as { profile?: string; confidence?: number };
    if (!PROFILES.includes(String(out.profile)) || typeof out.confidence !== 'number') {
      return reply(502, { error: 'Profile service unavailable.' }, origin, env);
    }
    return reply(200, { profile: out.profile, confidence: out.confidence, source: 'ml' }, origin, env);
  } catch (_e) {
    return reply(502, { error: 'Profile service unavailable.' }, origin, env);
  }
}
