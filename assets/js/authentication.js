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

// RESET vs ACTIVATION. Iisang page ito para sa dalawa. ?mode=reset ang galing
// sa reset CODE (auth.js); ang reset LINK ay nakikilala sa PASSWORD_RECOVERY
// event ng Supabase (o sa type=recovery sa hash, kung naabutan pa). Salita lang
// ang nagbabago -- pareho ang updateUser() at ang pag-sign out pagkatapos.
let isResetMode = new URLSearchParams(window.location.search).get('mode') === 'reset' ||
    /type=recovery/.test(window.location.hash);
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

        // Kapareho ng patakaran sa set-new-password page at sa temporary password
        // ng admin: 8+ character, may letra at may numero.
        if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
            return showSetupStatus("Use at least 8 characters, with at least one letter and one number.", "error");
        }
        if (password !== confirmPassword) return showSetupStatus("Passwords do not match.", "error");

        setupSubmitBtn.disabled = true;
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
