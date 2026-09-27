// ==========================================
// ACCOUNT ACTIVATION / PASSWORD SETUP
// (sign-up.html lang ang gumagamit nito -- ito ang landing page ng
//  "Send Activation Email" at "Reset Password" magic-link mula sa admin.
//  Ang normal na sign-in + forgot-password (OTP) flow ay nasa auth.js na
//  modal -- hindi na dinuplicate dito.)
// ==========================================

const setupForm = document.getElementById('setup-password-form');
const setupStatus = document.getElementById('setup-status-box');
const setupSubmitBtn = document.getElementById('setup-submit-btn');

// WHAT OPENED THIS PAGE. Supabase writes the result of an email link into the
// URL it redirects to:
//   #access_token=…&type=invite|magiclink|signup|recovery   a working link
//   #error=…&error_code=otp_expired&error_description=…      a spent/expired link
//   ?token_hash=…&type=…                                     a customised template
// and auth.js adds ?mode=reset after a correct reset CODE. Read from
// PIA_ENTRY_URL (function.js), captured before supabase-js wipes the hash.
// Links that first landed on the home page arrive here the same way, forwarded
// by auth-callback.js with the hash intact.
const entryUrl = new URL(window.PIA_ENTRY_URL || window.location.href);
const linkHash = new URLSearchParams(entryUrl.hash.replace(/^#/, ''));
const linkQuery = entryUrl.searchParams;
const linkType = linkHash.get('type') || linkQuery.get('type') || '';
const linkErrorCode = linkHash.get('error_code') || linkQuery.get('error_code') || '';
const linkError = linkErrorCode || linkHash.get('error') || linkQuery.get('error') || '';
const linkTokenHash = linkQuery.get('token_hash');
const linkHasTokens = linkHash.has('access_token') || !!linkTokenHash;
const pageMode = linkQuery.get('mode');   // 'reset' | 'activate' | null

// RESET vs ACTIVATION. Iisang page ito para sa dalawa. ?mode=reset ang galing
// sa reset CODE (auth.js); ang reset LINK ay type=recovery sa hash, o ang
// PASSWORD_RECOVERY event ng Supabase. Ang invite / magiclink / signup ay
// activation. Salita lang ang nagbabago -- pareho ang updateUser() at ang
// pag-sign out pagkatapos.
let isResetMode = pageMode === 'reset' || linkType === 'recovery';
let submitLabel = 'Activate my account';

function applyResetCopy() {
    isResetMode = true;
    submitLabel = 'Save new password';
    const label = document.querySelector('.auth-identity-label');
    if (label) label.textContent = 'Resetting the password for';
    const title = document.querySelector('.auth-title');
    if (title) title.textContent = 'Choose a new password';
    const lede = document.querySelector('.auth-lede');
    if (lede) lede.textContent = 'Your old password stops working as soon as you save this one. Then sign in again with your school email and the new password.';
    document.title = 'Reset Your Password — PIA';
    if (setupSubmitBtn && !setupSubmitBtn.disabled) {
        setupSubmitBtn.innerHTML = '<svg class="icon"><use href="#i-key"></use></svg> ' + submitLabel;
    }
}

if (isResetMode) applyResetCopy();
if (window.supabaseClient) {
    window.supabaseClient.auth.onAuthStateChange((event) => {
        if (event === 'PASSWORD_RECOVERY') applyResetCopy();
    });
}

function showSetupStatus(message, type) {
    if (!setupStatus) return;

    // Write into the inner <span>, not the row itself: the row also holds an
    // icon, and textContent on the parent would delete it.
    const textEl = setupStatus.querySelector('span') || setupStatus;
    textEl.textContent = message;

    const glyph = setupStatus.querySelector('use');
    if (glyph) glyph.setAttribute('href', type === 'error' ? '#i-alert' : '#i-check');

    setupStatus.classList.remove('hidden', 'auth-status-error', 'auth-status-success');
    setupStatus.classList.add(type === 'error' ? 'auth-status-error' : 'auth-status-success');
}

const EXPIRED_LINK_MESSAGE = "This link has expired or was already used. Each link works once, for a short time — ask for a new one from the sign-in page.";

// Ends the page without a form. Used for every link that cannot be trusted.
function refuseLink(message) {
    showSetupStatus(message, "error");
    if (setupForm) setupForm.classList.add('hidden');
    const identity = document.querySelector('.auth-identity');
    if (identity) identity.hidden = true;
}

window.addEventListener('DOMContentLoaded', async () => {
    if (!window.supabaseClient) {
        showSetupStatus("Connection error. Please refresh the page.", "error");
        return;
    }

    // Every refusal below comes BEFORE getSession() on purpose. This browser
    // may still hold an older session -- another student's on a shared lab
    // PC, or the admin's while testing -- and a bad or missing link must never
    // turn this page into a password change for THAT account.

    // 1. A spent or expired link (most often: opened twice, or opened by a
    //    mail scanner before the student tapped it).
    if (linkError) {
        return refuseLink(linkErrorCode === 'otp_expired'
            ? EXPIRED_LINK_MESSAGE
            : "This link didn't work. Please ask for a new one from the sign-in page.");
    }

    // 2. A customised email template sends a token hash instead of tokens:
    //    exchange it for the session the plain link would have given.
    if (linkTokenHash) {
        const { error } = await window.supabaseClient.auth.verifyOtp({
            token_hash: linkTokenHash,
            type: linkType || 'email'
        });
        if (error) return refuseLink(EXPIRED_LINK_MESSAGE);
    }

    // 3. No link at all: the address was typed, bookmarked or shared.
    if (!linkHasTokens && !pageMode) {
        return refuseLink("Open this page from the link in your email.");
    }

    // For a normal link, supabase-js has turned the #access_token into a
    // session by the time this resolves (and replaced any older one).
    const { data: { session } } = await window.supabaseClient.auth.getSession();
    const user = session?.user;

    if (!user) {
        return refuseLink("This link is invalid or has expired. Please request a new one.");
    }

    // The tokens are spent and gone from the address bar; ?mode= records that
    // this session came from a link, so a refresh keeps the form instead of
    // refusing at step 3.
    history.replaceState(null, '', entryUrl.pathname + '?mode=' + (isResetMode ? 'reset' : 'activate'));

    const passwordField = document.getElementById('setup-password');
    if (passwordField) passwordField.focus();

    // Dynamic greeting gamit ang full_name mula sa profiles table
    const { data: profile } = await window.supabaseClient
        .from('profiles')
        .select('full_name')
        .eq('email', user.email)
        .maybeSingle();

    const fullName = profile?.full_name || 'there';
    const greetingEl = document.getElementById('setup-greeting');
    if (greetingEl) greetingEl.textContent = `${getTimeGreeting()}, ${fullName}!`;

    const emailEl = document.getElementById('setup-email');
    if (emailEl) emailEl.textContent = user.email;
});

// Show/Hide password toggle
const showPasswordCheckbox = document.getElementById('setup-show-password');
if (showPasswordCheckbox) {
    showPasswordCheckbox.addEventListener('change', function () {
        const type = this.checked ? 'text' : 'password';
        const p1 = document.getElementById('setup-password');
        const p2 = document.getElementById('setup-confirm-password');
        if (p1) p1.type = type;
        if (p2) p2.type = type;
    });
}

if (setupForm) {
    setupForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const password = document.getElementById('setup-password').value;
        const confirmPassword = document.getElementById('setup-confirm-password').value;

        // Kapareho ng patakaran sa set-new-password page at sa temporary password
        // ng admin: 8+ character, may letra at may numero.
        if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
            return showSetupStatus("Use at least 8 characters, with at least one letter and one number.", "error");
        }
        if (password !== confirmPassword) return showSetupStatus("Passwords do not match.", "error");

        setupSubmitBtn.disabled = true;
        setupSubmitBtn.textContent = 'Saving…';

        const { error: updateError } = await window.supabaseClient.auth.updateUser({ password });

        if (updateError) {
            const sameAsOld = updateError.code === 'same_password' ||
                /different from the old password/i.test(updateError.message || '');
            showSetupStatus(sameAsOld ? "Choose a password different from your old one." : updateError.message, "error");
            setupSubmitBtn.disabled = false;
            setupSubmitBtn.textContent = submitLabel;
            return;
        }

        const { data: { user } } = await window.supabaseClient.auth.getUser();
        if (user) {
            await window.supabaseClient.from('profiles').update({ status: 'active' }).eq('email', user.email);
        }

        // Palabas na sa session na ito (galing sa magic-link) para pumunta sila
        // sa normal sign-in gamit ang bago nilang password.
        await window.supabaseClient.auth.signOut();

        showSetupStatus(isResetMode
            ? "Password updated! Redirecting to sign in..."
            : "Account activated! Redirecting to sign in...", "success");
        setTimeout(() => { window.location.replace('../../index.html'); }, 2000);
    });
}
