// ==========================================
// SET NEW PASSWORD -- ang sapilitang pagpapalit ng temporary password
//
// Kapag ang admin ang nag-set ng temporary password (Edge Function
// admin-set-temp-password), must_change_password = true ang profile. Dito
// sila dinadala sa sign-in, at dito sila ibinabalik ng requireStudentSession()
// mula sa kahit anong ibang student page, hanggang makapili sila ng password na
// SILA LANG ang nakakaalam (zero-knowledge: alam ng admin ang temporary, hindi
// ang susunod).
//
// Paano bumababa ang flag: HINDI ito isinusulat ng page na ito -- bawal iyon sa
// estudyante (0001 write guard). Ang updateUser() ang nagpapalit ng password,
// at ang trigger sa auth.users (migration 0019) ang nagbababa ng flag kapag
// talagang nagbago ang password. Binabasa lang ulit dito para makumpirma.
// ==========================================
(function () {
    'use strict';

    const form = document.getElementById('new-password-form');
    const newField = document.getElementById('pw-new');
    const confirmField = document.getElementById('pw-confirm');
    const submitBtn = document.getElementById('pw-submit');
    const statusEl = document.getElementById('pw-status');
    const showToggle = document.getElementById('pw-show-toggle');

    let profile = null;

    function rulesFor(pw, confirm) {
        return {
            length: pw.length >= 8,
            letter: /[A-Za-z]/.test(pw),
            number: /\d/.test(pw),
            match: pw.length > 0 && pw === confirm
        };
    }

    function renderRules() {
        const r = rulesFor(newField.value, confirmField.value);
        document.querySelectorAll('#pw-rules li').forEach(li => {
            li.classList.toggle('is-met', !!r[li.getAttribute('data-rule')]);
        });
        return r;
    }

    function setFieldMsg(id, message) {
        const field = document.getElementById(id);
        const msg = document.querySelector('[data-msg-for="' + id + '"]');
        if (field) {
            field.classList.toggle('is-invalid', !!message);
            if (message) field.setAttribute('aria-invalid', 'true'); else field.removeAttribute('aria-invalid');
        }
        if (msg) msg.textContent = message || '';
    }

    function setStatus(message, tone) {
        statusEl.textContent = message || '';
        statusEl.classList.toggle('is-error', tone === 'error');
        statusEl.classList.toggle('is-ok', tone === 'ok');
    }

    // Ang mga error ng Supabase Auth, isinalin para sa isang Grade 7.
    function friendlyUpdateError(error) {
        const code = (error && error.code) || '';
        const raw = String((error && error.message) || '');
        if (code === 'same_password' || /different from the old password/i.test(raw)) {
            return 'That is the temporary password. Choose a new one that only you know.';
        }
        if (code === 'weak_password' || /weak|at least|characters/i.test(raw)) {
            return raw || 'That password is too weak. Make it longer, with letters and numbers.';
        }
        if (code === 'session_not_found' || code === 'reauthentication_needed' || /session/i.test(raw)) {
            return 'Your sign-in has expired. Sign out, then sign in again with the temporary password.';
        }
        if (/rate limit|too many/i.test(raw)) {
            return 'Too many attempts. Wait a minute, then try again.';
        }
        return raw || 'The password could not be saved. Please try again.';
    }

    async function onSubmit(event) {
        event.preventDefault();
        setStatus('');

        const pw = newField.value;
        const r = renderRules();

        setFieldMsg('pw-new', (!r.length || !r.letter || !r.number)
            ? 'Use at least 8 characters, with at least one letter and one number.' : '');
        setFieldMsg('pw-confirm', r.match ? '' : 'The two passwords do not match.');
        if (!r.length || !r.letter || !r.number) { newField.focus(); return; }
        if (!r.match) { confirmField.focus(); return; }

        // Bumabalik sa type="password" bago isumite -- ang browser ay nag-aalok
        // lang na i-save ang password na galing sa password field.
        showToggle.checked = false;
        newField.type = confirmField.type = 'password';

        submitBtn.disabled = true;
        submitBtn.textContent = 'Saving…';

        try {
            const { error } = await supabaseClient.auth.updateUser({ password: pw });
            if (error) {
                setStatus(friendlyUpdateError(error), 'error');
                return;
            }

            // Kumpirmahin na naibaba na ng trigger ang flag bago sila palabasin.
            // Kung naka-flag pa, ibabalik lang sila rito ng bawat ibang page.
            const { data: fresh } = await supabaseClient
                .from('profiles')
                .select('email, full_name, role, group_type, is_ocean_done, selected_character, current_stage, must_change_password')
                .eq('email', profile.email)
                .maybeSingle();

            if (!fresh || fresh.must_change_password === true) {
                setStatus('Your new password is saved, but your account is still marked to change it. ' +
                    'Please tell your teacher so the administrator can check it.', 'error');
                return;
            }

            form.reset();
            renderRules();
            setStatus('New password saved. Taking you to your dashboard…', 'ok');
            window.location.replace(await resolveStudentRedirect(fresh));
        } catch (err) {
            console.error('Password change failed:', err);
            setStatus('Could not reach the server. Check your connection and try again.', 'error');
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Save new password';
        }
    }

    async function boot() {
        // allowPasswordChange: ito lang ang page na pwedeng buksan habang
        // naka-flag. Ang admin/teacher ay pinapapunta pa rin sa sarili nilang
        // dashboard ng requireStudentSession().
        profile = await requireStudentSession({ allowPasswordChange: true });
        if (!profile) return;

        // Walang dapat palitan -- diretso sa tamang lugar nila.
        if (profile.must_change_password !== true) {
            window.location.replace(await resolveStudentRedirect(profile));
            return;
        }

        document.getElementById('pw-email').textContent = profile.email;
        document.getElementById('pw-username').value = profile.email;

        newField.addEventListener('input', () => { renderRules(); if (newField.classList.contains('is-invalid')) setFieldMsg('pw-new', ''); });
        confirmField.addEventListener('input', () => { renderRules(); if (confirmField.classList.contains('is-invalid')) setFieldMsg('pw-confirm', ''); });
        showToggle.addEventListener('change', () => {
            const type = showToggle.checked ? 'text' : 'password';
            newField.type = confirmField.type = type;
        });
        form.addEventListener('submit', onSubmit);
        renderRules();

        document.body.classList.remove('opacity-0');
        newField.focus();
    }

    boot();
})();
