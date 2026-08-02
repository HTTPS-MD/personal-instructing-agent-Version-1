// ==========================================
// 1. PAGE IDENTIFIERS & MAGIC LINK HANDLER
// ==========================================
const isSignUpPage = document.getElementById('signup-form') !== null;
const isResetPage = document.getElementById('reset-form') !== null;
const loginForm = document.getElementById('login-form');

// Auto-detect Magic Link Token from Email
window.addEventListener('DOMContentLoaded', async () => {
    if ((isSignUpPage || isResetPage) && window.supabaseClient) {
        const hash = window.location.hash;

        // 🚨 Idinagdag ang 'type=magiclink' sa detector
        if (hash && (hash.includes('type=recovery') || hash.includes('type=invite') || hash.includes('type=magiclink'))) {

            // TAMA NA ANG ID DITO (Tumutugma na sa HTML)
            const passwordContainer = document.getElementById('password-setup-container');

            if (passwordContainer) {
                // Ipakita ang dalawang field (New Password at Confirm Password)
                passwordContainer.classList.remove('hidden');

                // Fetch user data para sa Dynamic Greeting
                const { data: { session } } = await window.supabaseClient.auth.getSession();
                const user = session?.user;

                if (user) {
                    // Kunin ang full name sa profiles table gamit ang authenticated email
                    const { data: profile } = await window.supabaseClient
                        .from('profiles')
                        .select('full_name')
                        .eq('email', user.email)
                        .maybeSingle();

                    const fullName = profile?.full_name || 'Student';

                    // Dynamic Time Checker
                    const hour = new Date().getHours();
                    let timeGreeting = "Good evening";
                    if (hour >= 0 && hour < 12) timeGreeting = "Good morning";
                    else if (hour >= 12 && hour < 18) timeGreeting = "Good afternoon";

                    // Ipasok ang value sa HTML placeholders
                    const greetingEl = document.getElementById('dynamic-greeting');
                    const subtitleEl = document.getElementById('dynamic-subtitle');

                    if (greetingEl) greetingEl.textContent = `${timeGreeting} ${fullName}!`;
                    if (subtitleEl) subtitleEl.textContent = "Welcome to PIA create password below:";

                } else {
                    // Fallback kapag mabagal ang API fetch
                    showStatus("Email verified! Please set your new password.", "success");
                }
            }
        }
    }
});

// ==========================================
// 2. CAROUSEL LOGIC
// ==========================================
const slides = document.querySelectorAll('.slide');
const indicatorsContainer = document.getElementById('carousel-indicators');
let currentSlide = 0;
let indicators = [];
let autoSlideInterval;

slides.forEach((_, index) => {
    const dot = document.createElement('div');
    dot.className = 'w-8 h-1.5 rounded-full cursor-pointer transition-all duration-300';
    dot.style.backgroundColor = index === 0 ? 'var(--accent-primary)' : 'var(--bg-card)';
    dot.style.border = '1px solid var(--border-color)';
    dot.addEventListener('click', () => { currentSlide = index; showSlide(currentSlide); resetAutoSlide(); });
    if (indicatorsContainer) indicatorsContainer.appendChild(dot);
    indicators.push(dot);
});

function showSlide(index) {
    slides.forEach((slide, i) => {
        slide.classList.replace('opacity-100', 'opacity-0');
        slide.classList.replace('z-10', 'z-0');
        if (indicators[i]) indicators[i].style.backgroundColor = 'var(--bg-card)';

        if (i === index) {
            slide.classList.replace('opacity-0', 'opacity-100');
            slide.classList.replace('z-0', 'z-10');
            if (indicators[i]) indicators[i].style.backgroundColor = 'var(--accent-primary)';
        }
    });
}

function nextSlide() {
    currentSlide = (currentSlide + 1) % slides.length;
    showSlide(currentSlide);
}

function startAutoSlide() {
    autoSlideInterval = setInterval(nextSlide, 4000);
}

function resetAutoSlide() {
    clearInterval(autoSlideInterval);
    startAutoSlide();
}

if (slides.length > 0) startAutoSlide();

// ==========================================
// 3. SHOW PASSWORD LOGIC
// ==========================================
const showPasswordCheckbox = document.getElementById('show-password');

if (showPasswordCheckbox) {
    showPasswordCheckbox.addEventListener('change', function () {
        const type = this.checked ? 'text' : 'password';
        const passwordInput = document.getElementById('password');
        const confirmPasswordInput = document.getElementById('confirm-password');
        if (passwordInput) passwordInput.type = type;
        if (confirmPasswordInput) confirmPasswordInput.type = type;
    });
}

// ==========================================
// 4. 8-BOX OTP LOGIC (PARA SA RESET PASSWORD)
// ==========================================
const otpInputs = document.querySelectorAll('.auth-otp-input');

if (otpInputs.length > 0) {
    otpInputs[0].setAttribute('autocomplete', 'one-time-code');

    otpInputs.forEach((input, index) => {
        input.removeAttribute('maxlength');

        input.addEventListener('input', (e) => {
            let val = e.target.value.replace(/\D/g, '');

            if (val.length > 1) {
                const chars = val.split('');
                otpInputs.forEach((box, i) => {
                    box.value = chars[i] || '';
                });
                const lastIdx = Math.min(chars.length, otpInputs.length) - 1;
                otpInputs[lastIdx].focus();
            } else {
                e.target.value = val;
                if (val && index < otpInputs.length - 1) {
                    otpInputs[index + 1].focus();
                }
            }
        });

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Backspace' && !input.value && index > 0) {
                otpInputs[index - 1].focus();
            }
        });

        input.addEventListener('paste', (e) => {
            e.preventDefault();
            const pasteData = e.clipboardData.getData('text').replace(/\D/g, '');
            const chars = pasteData.split('');
            otpInputs.forEach((box, i) => box.value = chars[i] || '');
            const lastIdx = Math.min(chars.length, otpInputs.length) - 1;
            if (lastIdx >= 0) otpInputs[lastIdx].focus();
        });
    });
}

// ==========================================
// 5. HELPER FUNCTIONS & DEVICE DETECTOR
// ==========================================
const statusMessage = document.getElementById('status-message') || document.getElementById('error-message');
const resendBtn = document.getElementById('resend-btn');
let countdownInterval;

function getDeviceSignature() {
    const ua = navigator.userAgent;
    let platform = "Unknown Device";
    if (/android/i.test(ua)) platform = "Android Smartphone";
    else if (/iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) platform = "iPadOS";
    else if (/iPhone|iPod/.test(ua)) platform = "iOS";
    else if (/Macintosh|MacIntel|MacPPC|Mac68K/.test(ua)) platform = "macOS";
    else if (/Windows/.test(ua)) platform = "Windows PC";

    const uniqueId = Math.random().toString(36).substring(2, 9);
    return `${uniqueId} [${platform}]`;
}

function showStatus(message, type) {
    if (!statusMessage) return;
    statusMessage.textContent = message;
    statusMessage.className = `text-xs text-center py-3 px-4 rounded-lg mt-4 ${type === 'error' ? 'auth-status-error' : 'auth-status-success'}`;
    statusMessage.classList.remove('hidden');
}

function startTimer() {
    if (!resendBtn) return;
    let timeLeft = 60;
    resendBtn.disabled = true;
    
    let currentTimerSpan = document.getElementById('timer');
    if (currentTimerSpan) currentTimerSpan.textContent = timeLeft;

    clearInterval(countdownInterval);
    countdownInterval = setInterval(() => {
        timeLeft--;
        currentTimerSpan = document.getElementById('timer');
        if (currentTimerSpan) currentTimerSpan.textContent = timeLeft;
        
        if (timeLeft <= 0) {
            clearInterval(countdownInterval);
            resendBtn.disabled = false;
            resendBtn.innerHTML = "Resend Code";
        }
    }, 1000);
}

// ==========================================
// 6. SIGN IN LOGIC
// ==========================================
if (loginForm) {
    const submitBtn = document.getElementById('submit-btn');
    const loginEmailInput = document.getElementById('email');

    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        submitBtn.disabled = true;
        submitBtn.innerHTML = 'Signing in...';
        if (statusMessage) statusMessage.classList.add('hidden');

        const passwordInput = document.getElementById('password');
        const { data: authData, error: authError } = await window.supabaseClient.auth.signInWithPassword({
            email: loginEmailInput.value.trim(),
            password: passwordInput ? passwordInput.value : ''
        });

        if (authError) {
            showStatus(authError.message, 'error');
            submitBtn.disabled = false;
            submitBtn.innerHTML = 'Sign In';
            return;
        }

        localStorage.setItem('pia_user_email', loginEmailInput.value.trim());

        const { data: profile, error: profileError } = await window.supabaseClient
            .from('profiles')
            .select('*')
            .eq('email', authData.user.email)
            .maybeSingle();

        if (profileError || !profile) {
            showStatus("Failed to load user profile. Please check if your account is fully registered.", 'error');
            submitBtn.disabled = false;
            submitBtn.innerHTML = 'Sign In';
            return;
        }

        const role = profile.role ? profile.role.trim().toLowerCase() : 'student';
        localStorage.setItem('pia_user_role', role);

        if (role !== 'admin') {
            const maxAllowedDevices = profile.max_devices ?? 1;
            let currentDeviceId = localStorage.getItem('pia_device_id');
            if (!currentDeviceId || !currentDeviceId.includes('[')) {
                currentDeviceId = getDeviceSignature();
                localStorage.setItem('pia_device_id', currentDeviceId);
            }

            let activeDevices = profile.active_devices || [];
            if (!activeDevices.includes(currentDeviceId)) {
                if (activeDevices.length >= maxAllowedDevices) {
                    await window.supabaseClient.auth.signOut();
                    localStorage.removeItem('pia_user_email');
                    showStatus(`${maxAllowedDevices} device limit lang. Please log out from your other active device.`, 'error');
                    submitBtn.disabled = false;
                    submitBtn.innerHTML = 'Sign In';
                    return;
                } else {
                    activeDevices.push(currentDeviceId);
                    await window.supabaseClient.from('profiles').update({ active_devices: activeDevices }).eq('email', authData.user.email);
                }
            }
        }

        if (role === 'admin') {
            window.location.replace('../../admin/html/admin-dashboard.html');
            return;
        }

        if (role === 'teacher') {
            window.location.replace('teacher-dashboard.html');
            return;
        }

        const groupType = profile.group_type ? profile.group_type.trim().toLowerCase() : '';
        const isNonAssigned = (groupType === 'non-assigned' || groupType === 'non_assigned');

        if (!profile.is_ocean_done) {
            const { data: settingData } = await window.supabaseClient.from('settings').select('value').eq('key', 'stage_ocean').maybeSingle();
            const isOceanOpen = settingData ? (settingData.value === true || settingData.value === 'true') : false;
            window.location.replace(isOceanOpen ? '../../student/html/ocean-test.html' : '../../student/html/waiting-room.html');
        } else if (isNonAssigned && !profile.selected_character) {
            const { data: charSetting } = await window.supabaseClient.from('settings').select('value').eq('key', 'stage_char').maybeSingle();
            const isCharOpen = charSetting ? (charSetting.value === true || charSetting.value === 'true') : false;
            window.location.replace(isCharOpen ? '../../student/html/character-selection.html' : '../../student/html/waiting-room.html');
        } else {
            const { data: dashSetting } = await window.supabaseClient.from('settings').select('value').eq('key', 'stage_dash').maybeSingle();
            const isDashOpen = dashSetting ? (dashSetting.value === true || dashSetting.value === 'true') : false;
            window.location.replace(isDashOpen ? '../../student/html/student-dashboard.html' : '../../student/html/waiting-room.html');
        }
    });
}

// ==========================================
// 7. RESET PASSWORD FLOW (Check Email -> Send OTP)
// ==========================================
const step1Container = document.getElementById('step-1-container');
const step2Container = document.getElementById('step-2-container');
const step3Container = document.getElementById('step-3-container');
const checkEmailBtn = document.getElementById('check-email-btn');
const verifyBtn = document.getElementById('verify-btn');
const finalizeBtn = document.getElementById('finalize-btn');
const resetEmailInput = document.getElementById('email');

// Check Email (Para sa Reset Password page lang ito ngayon)
if (checkEmailBtn && isResetPage) {
    checkEmailBtn.addEventListener('click', async () => {
        if (statusMessage) statusMessage.classList.add('hidden');
        const email = resetEmailInput.value.trim();
        if (!email) return showStatus("Please enter an email address.", 'error');

        checkEmailBtn.disabled = true;
        checkEmailBtn.innerHTML = 'Sending OTP...';

        const { data: student, error: dbError } = await window.supabaseClient
            .from('profiles')
            .select('id, email, status')
            .eq('email', email)
            .maybeSingle();

        if (dbError || !student) {
            showStatus("Email not found in our records.", 'error');
            checkEmailBtn.disabled = false;
            checkEmailBtn.innerHTML = 'Send OTP Code';
            return;
        }

        const { error: otpError } = await window.supabaseClient.auth.resetPasswordForEmail(email);

        if (otpError) {
            showStatus("Error sending OTP: " + otpError.message, 'error');
            checkEmailBtn.disabled = false;
            checkEmailBtn.innerHTML = 'Send OTP Code';
            return;
        }

        sessionStorage.setItem('pending_reset_email', email);
        step1Container.classList.add('hidden');
        step2Container.classList.remove('hidden');
        showStatus("Verification code sent to your email.", 'success');
        startTimer();
    });
}

// Resend OTP (Reset Password)
if (resendBtn && isResetPage) {
    resendBtn.addEventListener('click', async () => {
        if (statusMessage) statusMessage.classList.add('hidden');
        resendBtn.disabled = true;
        resendBtn.innerHTML = 'Resending...';

        const pendingEmail = sessionStorage.getItem('pending_reset_email');
        if (!pendingEmail) return showStatus("Session expired. Please start over.", 'error');

        const { error: otpError } = await window.supabaseClient.auth.resetPasswordForEmail(pendingEmail);

        if (otpError) {
            showStatus("Error resending OTP: " + otpError.message, 'error');
            resendBtn.disabled = false;
            resendBtn.innerHTML = 'Resend Code';
            return;
        }

        showStatus("New verification code sent!", 'success');
        resendBtn.innerHTML = 'Resend code in <span id="timer">60</span>s';
        startTimer();
    });
}

// Verify OTP (Reset Password)
if (verifyBtn && isResetPage) {
    verifyBtn.addEventListener('click', async () => {
        if (statusMessage) statusMessage.classList.add('hidden');
        let otpCode = '';
        otpInputs.forEach(input => otpCode += input.value.trim());

        if (otpCode.length < 8) return showStatus("Please enter the complete 8-digit verification code.", 'error');

        verifyBtn.disabled = true;
        verifyBtn.innerHTML = 'Verifying...';

        const pendingEmail = sessionStorage.getItem('pending_reset_email');
        if (!pendingEmail) return showStatus("Session expired. Please start over.", 'error');

        const { error } = await window.supabaseClient.auth.verifyOtp({
            email: pendingEmail,
            token: otpCode,
            type: 'recovery'
        });

        if (error) {
            showStatus(error.message, 'error');
            verifyBtn.disabled = false;
            verifyBtn.innerHTML = 'Verify Code';
            return;
        }

        step2Container.classList.add('hidden');
        step3Container.classList.remove('hidden');
        showStatus("Verified! Please set your new password.", 'success');
    });
}

// ==========================================
// 8. FINALIZE (Update Password para sa Magic Link AT OTP Flow)
// ==========================================
if (finalizeBtn) {
    finalizeBtn.addEventListener('click', async () => {
        if (statusMessage) statusMessage.classList.add('hidden');
        const passwordInput = document.getElementById('password');
        const confirmPasswordInput = document.getElementById('confirm-password');
        const password = passwordInput ? passwordInput.value : '';
        const confirmPassword = confirmPasswordInput ? confirmPasswordInput.value : '';

        if (password.length < 6) return showStatus("Password must be at least 6 characters.", 'error');
        if (password !== confirmPassword) return showStatus("Passwords do not match.", 'error');

        finalizeBtn.disabled = true;
        finalizeBtn.innerHTML = isSignUpPage ? 'Activating...' : 'Updating...';

        const { error: updateError } = await window.supabaseClient.auth.updateUser({ password });

        if (updateError) {
            showStatus(updateError.message, 'error');
            finalizeBtn.disabled = false;
            finalizeBtn.innerHTML = isSignUpPage ? 'Activate Account' : 'Update Password';
            return;
        }

        // Kung sign-up page (Activation via Magic Link), i-set na rin natin sa active status sa DB
        if (isSignUpPage) {
            const { data: authData } = await window.supabaseClient.auth.getUser();
            if (authData?.user) {
                await window.supabaseClient.from('profiles')
                    .update({ status: 'active' })
                    .eq('email', authData.user.email);
            }
        }

        sessionStorage.removeItem('pending_reset_email');
        
        const successMsg = isSignUpPage ? "Account activated successfully! Redirecting to sign in..." : "Password updated successfully! Redirecting to sign in...";
        showStatus(successMsg, 'success');
        setTimeout(() => { window.location.replace('sign-in.html'); }, 2000);
    });
}