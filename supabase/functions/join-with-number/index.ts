// ============================================================================
// PIA -- join-with-number  (Supabase Edge Function, Deno)
// ============================================================================
// The student door for the computer lab: a student number, confirmed by name,
// then an admin lets the student in. The rules live in handler.ts (and are
// rehearsed in tests/sim); this file only connects them to Supabase.
//
// HOW A SESSION IS OPENED: when the admin has let a request in, the student's
// own browser (the one holding the request's secret) polls; the Auth Admin API
// then makes a one-time sign-in token for the EXISTING account and hands it to
// that browser once; the browser redeems it with verifyOtp. Everything after
// that (profile lookup, claim_student_session, routing) is the normal pipeline,
// so RLS, stages and the one-device rule behave as after a password sign-in.
//
// WHY AN EDGE FUNCTION: minting a session for another user needs the
// service-role key, which must never reach a browser.
//
// WHAT THIS DOES NOT PROVE: who is typing. A student number is known to a
// student's classmates, which is why typing it opens nothing: an admin who can
// see the lab lets people in, and a second entry takes the account over and
// signs the first one out, so a stolen entry is noticed.
//
// A student who never activated has a profile but no auth user: the function
// creates it (email confirmed, a random password nobody knows) the first time
// they are let in.
//
// DEPLOY (once; needs migration 0052)
//   supabase functions deploy join-with-number --no-verify-jwt
//   The caller is an anonymous visitor, so JWT verification is OFF here.
// ============================================================================
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { type Deps, handleJoin } from './handler.ts';

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function send(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

const like = (value: string) => value.replace(/[\\%_]/g, (c) => '\\' + c);

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return send(405, { error: 'Method not allowed.' });

  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY');
  if (!url || !serviceKey) return send(500, { error: 'The join service is not configured.' });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return send(400, { error: 'The request body must be JSON.' }); }

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  // Prefer the address the edge itself saw. The FIRST x-forwarded-for entry can be written by the
  // caller, so fall back to the LAST one, which the platform's own proxy appended.
  const forwarded = (req.headers.get('x-forwarded-for') ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  const ip = req.headers.get('cf-connecting-ip') ?? forwarded[forwarded.length - 1] ?? 'unknown';
  const nowIso = () => new Date().toISOString();

  const openCount = async (section?: string) => {
    let q = admin.from('checkins').select('id', { count: 'exact', head: true }).is('stopped_at', null).gt('ends_at', nowIso());
    if (section) q = q.eq('section', section);
    const { count } = await q;
    return count ?? 0;
  };

  const deps: Deps = {
    now: () => Date.now(),

    async countFailures(key, sinceMs) {
      const { count } = await admin.from('join_attempts').select('id', { count: 'exact', head: true })
        .eq('key', key).eq('ok', false).gte('at', new Date(sinceMs).toISOString());
      return count ?? 0;
    },
    async record(key, ok) { await admin.from('join_attempts').insert({ key, ok }); },

    async findStudent(numberKey) {
      const { data: row } = await admin.from('student_numbers').select('email').eq('number_key', numberKey).maybeSingle();
      if (!row) return null;
      const { data: p } = await admin.from('profiles').select('email, full_name, section, role')
        .ilike('email', like(String(row.email))).maybeSingle();
      return p ? { email: p.email, full_name: p.full_name, section: String(p.section ?? '').trim(), role: p.role } : null;
    },

    anyCheckinOpen: async () => (await openCount()) > 0,
    checkinOpenFor: async (section) => (await openCount(section)) > 0,

    async countWaiting(email, sinceMs) {
      let q = admin.from('join_requests').select('id', { count: 'exact', head: true })
        .eq('status', 'waiting').gte('created_at', new Date(sinceMs).toISOString());
      if (email) q = q.eq('email', email);
      const { count } = await q;
      return count ?? 0;
    },
    async createRequest({ email, section, secretHash }) {
      const { data, error } = await admin.from('join_requests')
        .insert({ email, section, secret_hash: secretHash }).select('id').single();
      if (error || !data) throw error ?? new Error('no request');
      return String(data.id);
    },
    async getRequest(id) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
      const { data } = await admin.from('join_requests')
        .select('id, email, section, secret_hash, status, created_at, let_in_at, delivered').eq('id', id).maybeSingle();
      if (!data) return null;
      return {
        id: String(data.id), email: data.email, section: data.section, secretHash: data.secret_hash,
        status: data.status, createdMs: Date.parse(data.created_at),
        letInMs: data.let_in_at ? Date.parse(data.let_in_at) : null, delivered: data.delivered === true,
      };
    },
    async markDelivered(id) { await admin.from('join_requests').update({ delivered: true }).eq('id', id); },

    async ensureAccount(email) {
      const { data: id, error } = await admin.rpc('pia_auth_user_id', { p_email: email });
      if (error) throw error;
      if (id) return;
      const random = crypto.getRandomValues(new Uint8Array(24));
      const password = Array.from(random, (b) => b.toString(16).padStart(2, '0')).join('');
      const { error: createError } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (createError) throw createError;
    },
    async mintToken(email) {
      const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
      return error ? null : (data?.properties?.hashed_token ?? null);
    },
  };

  const reply = await handleJoin(body, ip, deps);
  return send(reply.status, reply.body);
});
