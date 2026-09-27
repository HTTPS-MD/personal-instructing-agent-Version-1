// ============================================================================
// PIA -- admin-set-temp-password  (Supabase Edge Function, Deno)
// ============================================================================
// The ADMIN OVERRIDE step of password recovery: for a student who cannot
// receive the reset email, an administrator sets a temporary password, and
// the student is forced to replace it at their next sign-in.
//
// WHY AN EDGE FUNCTION
//   Setting another user's password needs the Auth Admin API
//   (auth.admin.updateUserById), which needs the service-role key. That key
//   bypasses every security rule in the database, so it must never reach a
//   browser. Here it stays in the function's environment, and the browser
//   only ever sends the admin's own session token.
//
// WHAT IT DOES, IN ORDER
//   1. Verifies the caller: a signed-in user whose profile says admin, read
//      THROUGH their own token -- so the revocation-aware RLS policies apply
//      and an admin whose sessions were revoked is refused.
//   2. Checks the target: an existing STUDENT account (never an admin or a
//      teacher) that has a sign-in account.
//   3. Sets the password with updateUserById. A database trigger (migration
//      0019) clears any old must_change_password flag on every password
//      change -- which is why step 4 comes after, not before.
//   4. Raises must_change_password and records who set it and when.
//   5. Ends the student's existing sessions (admin_revoke_sessions), so
//      anyone still signed in to that account is signed out.
//   The password is never logged, stored by us, or sent back.
//
// DEPLOY (once)
//   Dashboard: Edge Functions -> Deploy a new function -> Via editor.
//     Name it exactly  admin-set-temp-password  and paste this file.
//   Or CLI:    supabase functions deploy admin-set-temp-password
//   No secrets to add: SUPABASE_URL and the project keys are provided to
//   every function automatically.
//   If calls fail with 401 "Invalid JWT", turn OFF "Enforce JWT verification"
//   for this function -- it verifies the caller's token itself (step 1), and
//   the gateway check can reject newer asymmetric session tokens.
// ============================================================================
import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function reply(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// The same floor the admin dashboard enforces before sending. Supabase's own
// password policy (Auth settings) applies on top, and its message is passed
// back if it is stricter.
function passwordProblem(password: string): string | null {
  if (password.length < 8) return 'The temporary password must be at least 8 characters.';
  if (password.length > 72) return 'The temporary password must be 72 characters or fewer.';
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    return 'The temporary password must contain at least one letter and one number.';
  }
  return null;
}

// PostgREST ilike treats % and _ as wildcards; an email can contain _.
function likeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, (c) => '\\' + c);
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply(405, { error: 'Method not allowed.' });

  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY');
  if (!url || !anonKey || !serviceKey) {
    return reply(500, { error: 'The password service is not configured.' });
  }

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return reply(401, { error: 'Sign in as an administrator first.' });

  const clientOptions = { auth: { persistSession: false, autoRefreshToken: false } };

  // ---- 1. Who is asking ---------------------------------------------------
  const asCaller = createClient(url, anonKey, {
    ...clientOptions,
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const { data: userData, error: userError } = await asCaller.auth.getUser(token);
  const callerEmail = userData?.user?.email;
  if (userError || !callerEmail) {
    return reply(401, { error: 'Your session has expired. Sign in again.' });
  }

  const { data: callerProfile } = await asCaller
    .from('profiles').select('role').eq('email', callerEmail).maybeSingle();
  if ((callerProfile?.role ?? '').trim().toLowerCase() !== 'admin') {
    return reply(403, { error: 'Only an administrator can set a temporary password.' });
  }

  // ---- 2. The request and its target --------------------------------------
  let body: { email?: unknown; password?: unknown };
  try {
    body = await req.json();
  } catch {
    return reply(400, { error: 'The request body must be JSON.' });
  }

  const email = String(body?.email ?? '').trim().toLowerCase();
  const password = String(body?.password ?? '');

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return reply(400, { error: 'A valid student email is required.' });
  }
  const problem = passwordProblem(password);
  if (problem) return reply(422, { error: problem });

  const admin = createClient(url, serviceKey, clientOptions);

  const { data: target, error: targetError } = await admin
    .from('profiles').select('email, role').ilike('email', likeLiteral(email)).maybeSingle();
  if (targetError) return reply(500, { error: 'Could not look up that participant.' });
  if (!target) return reply(404, { error: 'No participant is registered with that email.' });
  if ((target.role ?? 'student').trim().toLowerCase() !== 'student') {
    return reply(403, { error: 'Temporary passwords can only be set for student accounts.' });
  }

  const { data: userId, error: idError } = await admin.rpc('pia_auth_user_id', { p_email: email });
  if (idError) {
    return reply(500, { error: 'Could not find the sign-in account. Has migration 0019 been applied?' });
  }
  if (!userId) {
    return reply(404, { error: 'This participant has no sign-in account yet. Send them an activation email instead.' });
  }

  // ---- 3. Set the temporary password --------------------------------------
  const { error: passwordError } = await admin.auth.admin.updateUserById(userId as string, { password });
  if (passwordError) {
    // 422 is Supabase's password policy (too weak, too short, leaked): its
    // own message says what to fix.
    const status = passwordError.status === 422 ? 422 : 500;
    return reply(status, { error: passwordError.message || 'The password could not be set.' });
  }

  // ---- 4. Force a change at next sign-in ----------------------------------
  const { error: flagError } = await admin
    .from('profiles')
    .update({
      must_change_password: true,
      temp_password_set_at: new Date().toISOString(),
      temp_password_set_by: callerEmail,
    })
    .eq('email', target.email);

  if (flagError) {
    // The password IS set at this point. Say so plainly: the student could
    // sign in with it without being forced to change it, so the admin must
    // retry (setting it again re-raises the flag).
    return reply(500, {
      error: 'The temporary password was set, but the account could not be marked to change it. Set it again.',
    });
  }

  // ---- 5. End any session still open on that account ----------------------
  // Called AS THE ADMIN, so the RPC's own admin check applies. Not fatal: the
  // password has changed either way.
  const { error: revokeError } = await asCaller.rpc('admin_revoke_sessions', { p_email: target.email });

  return reply(200, { ok: true, email: target.email, sessionsRevoked: !revokeError });
});
