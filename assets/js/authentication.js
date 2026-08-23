// ==========================================
// ACCOUNT ACTIVATION / PASSWORD SETUP
// (sign-up.html lang ang gumagamit nito -- ito ang landing page ng
//  "Send Activation Email" at "Reset Password" magic-link mula sa admin.
//  Ang normal na sign-in + forgot-password (OTP) flow ay nasa index.js na
//  modal -- hindi na dinuplicate dito.)
// ==========================================

const setupForm = document.getElementById('setup-password-form');
const setupStatus = document.getElementById('setup-status-box');
const setupSubmitBtn = document.getElementById('setup-submit-btn');

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

window.addEventListener('DOMContentLoaded', async () => {
    if (!window.supabaseClient) {
        showSetupStatus("Connection error. Please refresh the page.", "error");
        return;
    }

    const { data: { session } } = await window.supabaseClient.auth.getSession();
    const user = session?.user;

    if (!user) {
        showSetupStatus("This link is invalid or has expired. Please request a new one.", "error");
        if (setupForm) setupForm.classList.add('hidden');
        return;
    }

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

        if (password.length < 6) return showSetupStatus("Password must be at least 6 characters.", "error");
        if (password !== confirmPassword) return showSetupStatus("Passwords do not match.", "error");

        setupSubmitBtn.disabled = true;
        setupSubmitBtn.disabled = true;
        setupSubmitBtn.textContent = 'Saving…';

        const { error: updateError } = await window.supabaseClient.auth.updateUser({ password });

        if (updateError) {
            showSetupStatus(updateError.message, "error");
            setupSubmitBtn.disabled = false;
            setupSubmitBtn.textContent = 'Activate my account';
            return;
        }

        const { data: { user } } = await window.supabaseClient.auth.getUser();
        if (user) {
            await window.supabaseClient.from('profiles').update({ status: 'active' }).eq('email', user.email);
        }

        // Palabas na sa session na ito (galing sa magic-link) para pumunta sila
        // sa normal sign-in gamit ang bago nilang password.
        await window.supabaseClient.auth.signOut();

        showSetupStatus("Account activated! Redirecting to sign in...", "success");
        setTimeout(() => { window.location.replace('../../index.html'); }, 2000);
    });
}
