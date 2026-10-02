/* Shared activation/recovery setup. A URL mode or a cached session alone
   never authorizes this form. Tokens stay in the existing Supabase client;
   this controller adds no token/password persistence. */
(function () {
    'use strict';
    const form = document.getElementById('setup-password-form');
    const submit = document.getElementById('setup-submit-btn');
    const status = document.querySelector('#setup-status-box span');
    const identity = document.querySelector('.auth-identity');
    const retry = document.getElementById('setup-retry');
    const actions = document.getElementById('setup-link-actions');
    const continuation = document.getElementById('setup-signin');
    const entry = new URL(window.PIA_ENTRY_URL || location.href);
    const hash = new URLSearchParams(entry.hash.slice(1));
    const type = hash.get('type') || entry.searchParams.get('type');
    const tokenHash = entry.searchParams.get('token_hash');
    const accessToken = hash.get('access_token');
    const errorCode = hash.get('error_code') || entry.searchParams.get('error_code');
    const linkError = errorCode || hash.get('error') || entry.searchParams.get('error');
    let verifiedUser = null;
    let verifiedSession = null;
    let mode = null;
    let busy = false;
    let passwordSaved = false;
    let profileSaved = false;
    let uncertain = false;
    let verifiedExchange = null;
    let label = 'Save password';
    let accountRole = 'student';

    function message(text, error = false) {
        status.textContent = text;
        const row = status.parentElement;
        row.classList.remove('hidden', 'auth-status-error', 'auth-status-success');
        row.classList.add(error ? 'auth-status-error' : 'auth-status-success');
        row.querySelector('use').setAttribute('href', error ? '#i-alert' : '#i-check');
    }
    function fieldError(id, text) {
        document.getElementById(id).setAttribute('aria-invalid', String(!!text));
        document.getElementById(id + '-error').textContent = text;
    }
    function temporary(error) {
        return !error || !error.status || error.status >= 500 || error.status === 429 ||
            /fetch|network|connection/i.test(error.message || '');
    }
    function refuse(text, canRetry = false) {
        verifiedUser = null;
        submit.disabled = true;
        form.hidden = true;
        identity.hidden = true;
        actions.hidden = false;
        retry.hidden = !canRetry;
        message(text, true);
    }
    function unusable(error) {
        if (error && error.code === 'otp_expired') {
            refuse('This link has expired or was already used. Request a new activation or reset email.');
        } else if (temporary(error)) {
            refuse('We could not verify this link right now. Check your connection and retry.', true);
        } else {
            refuse('This link could not be verified. Request a new activation or reset email.');
        }
    }
    async function verifyLink() {
        if (busy) return;
        busy = true;
        retry.disabled = true;
        submit.disabled = true;
        message('Verifying your email link…');
        try {
            if (!window.supabaseClient) {
                return refuse('The sign-in service is unavailable. Reload this page when your connection is restored.');
            }
            if (linkError) {
                return refuse(errorCode === 'otp_expired'
                    ? 'This link has expired or was already used. Request a new email below.'
                    : 'The email link reported an error and could not be verified. Request a new email below.');
            }
            if ((!accessToken && !tokenHash) || !['recovery', 'invite', 'magiclink', 'signup', 'email'].includes(type)) {
                return refuse('Open this page using the activation or reset link in your email. An existing sign-in alone cannot verify this request.');
            }
            // A token hash must pass the provider's exchange for the requested
            // purpose. A hash-token callback must match the SDK's new session.
            if (tokenHash && !verifiedExchange) {
                const result = await supabaseClient.auth.verifyOtp({ token_hash: tokenHash, type });
                if (result.error) return unusable(result.error);
                verifiedExchange = result.data.session;
            }
            const result = await supabaseClient.auth.getSession();
            if (result.error) return unusable(result.error);
            const session = result.data.session;
            const linkToken = tokenHash ? verifiedExchange?.access_token : accessToken;
            if (!session || !linkToken || session.access_token !== linkToken) {
                return refuse('No verified session matches this email link. Open a new activation or reset link.');
            }
            const identityResult = await supabaseClient.auth.getUser(linkToken);
            if (identityResult.error) return unusable(identityResult.error);
            if (!identityResult.data.user || identityResult.data.user.id !== session.user.id) {
                return refuse('The account for this link could not be verified. Request a new email.');
            }
            verifiedUser = identityResult.data.user;
            verifiedSession = session.access_token;
            // Only interpret the link's purpose AFTER its provider verification;
            // ?mode and entered addresses are deliberately ignored.
            mode = type === 'recovery' ? 'reset' : type === 'email' ? null : 'activate';
            if (!mode) return refuse('This link does not identify an activation or password reset. Request the email you need below.');
            label = mode === 'reset' ? 'Save new password' : 'Activate account';
            document.querySelector('.auth-title').textContent = mode === 'reset' ? 'Choose a new password' : 'Set up your account';
            document.title = document.querySelector('.auth-title').textContent + ' — PIA';
            document.querySelector('.auth-lede').textContent = 'Use your school email and this password to sign in after saving.';
            document.getElementById('setup-email').textContent = verifiedUser.email;
            identity.hidden = false;
            actions.hidden = true;
            retry.hidden = true;
            form.hidden = false;
            submit.disabled = false;
            submit.textContent = label;
            message('Email link verified. Choose your password.');
            // No secret or untrusted mode is put in a recovery URL. Refreshing
            // requires reopening the original link; cached sessions cannot bypass verification.
            history.replaceState(null, '', entry.pathname);
            document.getElementById('setup-password').focus();
        } catch (error) {
            refuse('We could not verify the link. Check your connection and retry.', true);
        } finally {
            busy = false;
            retry.disabled = false;
        }
    }

    document.getElementById('setup-show-password').addEventListener('change', function () {
        ['setup-password', 'setup-confirm-password'].forEach(id => {
            document.getElementById(id).type = this.checked ? 'text' : 'password';
        });
    });
    retry.addEventListener('click', verifyLink);
    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (busy || uncertain || !verifiedUser || submit.disabled) return;
        const password = document.getElementById('setup-password').value;
        const confirm = document.getElementById('setup-confirm-password').value;
        fieldError('setup-password', '');
        fieldError('setup-confirm-password', '');
        if (!passwordSaved) {
            if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
                fieldError('setup-password', 'Use at least 8 characters, including a letter and a number.');
                document.getElementById('setup-password').focus(); return;
            }
            if (password !== confirm) {
                fieldError('setup-confirm-password', 'Passwords do not match.');
                document.getElementById('setup-confirm-password').focus(); return;
            }
        }
        busy = true;
        submit.disabled = true;
        submit.textContent = passwordSaved ? 'Finishing…' : 'Saving…';
        let operation = 'identity';
        try {
            // Once both writes are confirmed, only session cleanup remains.
            // Retrying cleanup is safe even if a prior sign-out cleared the local session.
            if (!passwordSaved || !profileSaved) {
            const current = await supabaseClient.auth.getSession();
            if (current.error) throw current.error;
            if (current.data.session?.access_token !== verifiedSession) {
                return refuse('Your session changed. Reopen your email link before setting a password.');
            }
            const checked = await supabaseClient.auth.getUser();
            if (checked.error) throw checked.error;
            if (checked.data.user?.id !== verifiedUser.id) {
                return refuse('Your account could not be verified. Request a new email link.');
            }
            }
            if (!passwordSaved) {
                operation = 'password';
                const updated = await supabaseClient.auth.updateUser({ password });
                if (updated.error) {
                    if (temporary(updated.error)) throw updated.error;
                    const same = updated.error.code === 'same_password';
                    fieldError('setup-password', same ? 'Choose a password different from your old one.' : 'The password was not accepted. Check the requirements and try again.');
                    document.getElementById('setup-password').focus();
                    message('Your password was not saved.', true);
                    return;
                }
                passwordSaved = true;
                document.getElementById('setup-password').value = '';
                document.getElementById('setup-confirm-password').value = '';
                form.querySelectorAll('input').forEach(input => { input.disabled = true; });
            }
            if (!profileSaved) {
                operation = 'profile';
                const profile = await supabaseClient.from('profiles').update({ status: 'active' }).eq('email', verifiedUser.email).select('email, role').maybeSingle();
                if (profile.error) throw profile.error;
                if (!profile.data) throw new Error('Profile confirmation unavailable');
                accountRole = profile.data.role || 'student';
                profileSaved = true;
            }
            operation = 'signout';
            const signedOut = await supabaseClient.auth.signOut();
            if (signedOut.error) throw signedOut.error;
            form.hidden = true;
            identity.hidden = true;
            continuation.href = '../../index.html?signin=' + (['admin', 'teacher'].includes(accountRole) ? 'staff' : 'student');
            continuation.hidden = false;
            message(mode === 'reset' ? 'Your password has been updated. Sign in with your new password.' : 'Your account is activated. Sign in with your new password.');
            verifiedUser = null;
        } catch (error) {
            if (operation === 'password') {
                uncertain = true;
                message('The save result could not be confirmed. Do not submit again. Check your connection, then request a fresh reset email if needed.', true);
                actions.hidden = false;
            } else {
                message(passwordSaved
                    ? 'Your password was saved, but setup could not finish. Check your connection, then choose Finish setup. This will not resubmit your password.'
                    : 'Your account could not be checked. Check your connection and try again.', true);
            }
        } finally {
            busy = false;
            submit.disabled = uncertain || !verifiedUser;
            submit.textContent = passwordSaved ? 'Finish setup' : label;
        }
    });
    verifyLink();
})();
