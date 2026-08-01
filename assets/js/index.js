// ==========================================
// UNIFIED AUTH MODAL & LOGIC 
// ==========================================

let pendingResetEmail = '';
let countdownInterval;
let isActivationFlow = false;

function openAuthModal(view = 'signin') {
    const modal = document.getElementById('auth-modal');
    const box = document.getElementById('auth-box');
    const closeBtn = document.getElementById('modal-close-btn');

    modal.classList.remove('opacity-0', 'pointer-events-none');
    box.classList.remove('scale-95');
    document.body.style.overflow = 'hidden';

    // Ipakita ulit ang X button by default kapag normal na pagbukas
    if (closeBtn) closeBtn.classList.remove('hidden');

    switchAuthView(view);
    hideModalStatus();
}

// Global Wrapper para ma-access ang Change Password sa Dropdown menu
window.openChangePasswordModal = function () {
    isActivationFlow = false;
    document.getElementById('setup-logo').classList.add('hidden');
    document.getElementById('setup-title').innerText = "Change Password";
    document.getElementById('setup-desc').innerText = "Enter your new password below.";

    const greetingEl = document.getElementById('setup-greeting');
    if (greetingEl) greetingEl.classList.add('hidden');

    openAuthModal('set-password');
};

function closeAuthModal() {
    const modal = document.getElementById('auth-modal');
    const box = document.getElementById('auth-box');
    modal.classList.add('opacity-0', 'pointer-events-none');
    box.classList.add('scale-95');
    document.body.style.overflow = '';
}

function switchAuthView(view) {
    document.getElementById('view-signin').classList.add('hidden');
    document.getElementById('view-forgot-email').classList.add('hidden');
    document.getElementById('view-forgot-otp').classList.add('hidden');
    document.getElementById('view-set-password').classList.add('hidden');

    document.getElementById(`view-${view}`).classList.remove('hidden');
    hideModalStatus();
}

function showModalStatus(message, type) {
    const statusBox = document.getElementById('modal-status-box');
    statusBox.textContent = message;
    statusBox.classList.remove('hidden', 'bg-danger-light', 'text-danger', 'border-danger-border', 'bg-success-light', 'text-success', 'border-success-border');

    if (type === 'error') {
        statusBox.classList.add('bg-danger-light', 'text-danger', 'border-danger-border');
    } else {
        statusBox.classList.add('bg-success-light', 'text-success', 'border-success-border');
    }
}

function hideModalStatus() {
    document.getElementById('modal-status-box').classList.add('hidden');
}

function getDeviceSignature() {
    const ua = navigator.userAgent;
    let platform = "Unknown Device";
    if (/android/i.test(ua)) platform = "Android Smartphone";
    else if (/iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) platform = "iPadOS";
    else if (/iPhone|iPod/.test(ua)) platform = "iOS";
    else if (/Macintosh|MacIntel|MacPPC|Mac68K/.test(ua)) platform = "macOS";
    else if (/Windows/.test(ua)) platform = "Windows PC";

    return `${Math.random().toString(36).substring(2, 9)} [${platform}]`;
}

// ------------------------------------------------------------------
// INIT: AUTH STATE, NAV LOGIC & HERO BUTTON LOGIC
// ------------------------------------------------------------------
async function initAuthState() {
    const heroBtn = document.getElementById('hero-btn');
    const navAuthBtn = document.getElementById('nav-auth-btn');
    const navUserDropdown = document.getElementById('nav-user-dropdown');
    const navUserGreeting = document.getElementById('nav-user-greeting');
    const navUserEmail = document.getElementById('nav-user-email');

    const mobPrefix = document.getElementById('mobile-greeting-prefix');
    const mobName = document.getElementById('mobile-greeting-name');
    const mobAuthBtn = document.getElementById('mobile-auth-btn');
    const mobChangePassBtn = document.getElementById('mobile-change-pass-btn');
    const mobAuthIcon = document.getElementById('mobile-auth-icon');
    const mobAuthText = document.getElementById('mobile-auth-text');

    if (!window.supabaseClient) return;

    const email = localStorage.getItem('pia_user_email');
    const role = localStorage.getItem('pia_user_role') || 'student';

    const hour = new Date().getHours();
    let timeGreeting = "Good evening";
    if (hour >= 0 && hour < 12) timeGreeting = "Good morning";
    else if (hour >= 12 && hour < 18) timeGreeting = "Good afternoon";

    if (email) {
        // 🔥 MAY NAKA-LOGIN
        const { data: profile } = await supabaseClient.from('profiles').select('full_name, group_type, is_ocean_done, selected_character').eq('email', email).maybeSingle();

        let fullName = profile?.full_name || "Player";
        let firstName = fullName.split(' ')[0];

        // 1. UPDATE DESKTOP NAVBAR
        if (navAuthBtn && navUserDropdown) {
            navAuthBtn.classList.add('hidden');
            navUserDropdown.classList.remove('hidden');
            navUserDropdown.classList.add('flex');
            navUserGreeting.textContent = `${timeGreeting}, ${firstName}!`;
            if (navUserEmail) navUserEmail.textContent = email;
        }

        // 2. UPDATE MOBILE MENU
        if (mobPrefix && mobName && mobAuthBtn) {
            mobPrefix.textContent = `${timeGreeting},`;
            mobPrefix.classList.replace('uppercase', 'capitalize');
            mobName.textContent = fullName;
            mobName.style.fontSize = '1.1rem';

            if (mobChangePassBtn) mobChangePassBtn.classList.remove('hidden');

            if (mobAuthText) mobAuthText.textContent = 'SIGN OUT';
            if (mobAuthIcon) mobAuthIcon.setAttribute('data-lucide', 'log-out');

            mobAuthBtn.classList.replace('btn-primary', 'btn-secondary');
            mobAuthBtn.classList.add('text-danger', 'border-danger-border', 'hover:bg-[var(--color-danger-bg)]');
            mobAuthBtn.setAttribute('onclick', 'executeForceLogout()');
        }

        // 3. UPDATE HERO BUTTON
        if (heroBtn && role !== 'admin' && role !== 'teacher') {
            heroBtn.innerHTML = `<span>Start My Mission</span><i data-lucide="play" class="w-4 h-4 fill-current pointer-events-none"></i>`;
            heroBtn.removeAttribute('onclick');
            heroBtn.addEventListener('click', async () => {
                const groupType = profile?.group_type ? profile.group_type.trim().toLowerCase() : '';
                const isNonAssigned = (groupType === 'non-assigned' || groupType === 'non_assigned');

                if (!profile?.is_ocean_done) {
                    const { data: settingData } = await supabaseClient.from('settings').select('value').eq('key', 'stage_ocean').maybeSingle();
                    const isOceanOpen = settingData ? (settingData.value === true || settingData.value === 'true') : false;
                    window.location.replace(isOceanOpen ? '/student/html/ocean-test.html' : '/student/html/waiting-room.html');
                } else if (isNonAssigned && !profile?.selected_character) {
                    const { data: charSetting } = await supabaseClient.from('settings').select('value').eq('key', 'stage_char').maybeSingle();
                    const isCharOpen = charSetting ? (charSetting.value === true || charSetting.value === 'true') : false;
                    window.location.replace(isCharOpen ? '/student/html/character-selection.html' : '/student/html/waiting-room.html');
                } else {
                    const { data: dashSetting } = await supabaseClient.from('settings').select('value').eq('key', 'stage_dash').maybeSingle();
                    const isDashOpen = dashSetting ? (dashSetting.value === true || dashSetting.value === 'true') : false;
                    window.location.replace(isDashOpen ? '/student/html/student-dashboard.html' : '/student/html/waiting-room.html');
                }
            });
        }
        if (typeof lucide !== 'undefined') lucide.createIcons();

    } else {
        // 🔥 WALANG NAKA-LOGIN
        if (heroBtn) {
            heroBtn.innerHTML = `<span>Start Adventure</span><i data-lucide="play" class="w-4 h-4 fill-current pointer-events-none"></i>`;
            heroBtn.setAttribute('onclick', "openAuthModal('signin')");
        }
        if (mobChangePassBtn) mobChangePassBtn.classList.add('hidden');
        if (mobAuthText) mobAuthText.textContent = 'Sign In';
        if (mobAuthIcon) mobAuthIcon.setAttribute('data-lucide', 'log-in');

        if (mobAuthBtn) {
            mobAuthBtn.classList.replace('btn-secondary', 'btn-primary');
            mobAuthBtn.classList.remove('text-danger', 'border-danger-border', 'hover:bg-[var(--color-danger-bg)]');
            mobAuthBtn.setAttribute('onclick', "openAuthModal('signin'); document.getElementById('dynamic-close-btn').click();");
        }
    }
}

// ------------------------------------------------------------------
// UTILITY: CLEAR "X" BUTTONS & SHOW PASSWORD TOGGLES
// ------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.clear-input-btn').forEach(btn => {
        const input = btn.previousElementSibling;
        input.addEventListener('input', () => {
            if (input.value.length > 0) btn.classList.remove('hidden');
            else btn.classList.add('hidden');
        });
        btn.addEventListener('click', () => {
            input.value = '';
            btn.classList.add('hidden');
            input.focus();
        });
    });

    const showSigninPass = document.getElementById('show-signin-password');
    const signinPassInput = document.getElementById('modal-password');
    if (showSigninPass && signinPassInput) {
        showSigninPass.addEventListener('change', function () {
            signinPassInput.type = this.checked ? 'text' : 'password';
        });
    }

    const showSetupPass = document.getElementById('show-setup-password');
    const setupPassInput1 = document.getElementById('modal-new-password');
    const setupPassInput2 = document.getElementById('modal-confirm-password');
    if (showSetupPass && setupPassInput1 && setupPassInput2) {
        showSetupPass.addEventListener('change', function () {
            const newType = this.checked ? 'text' : 'password';
            setupPassInput1.type = newType;
            setupPassInput2.type = newType;
        });
    }
});


// ------------------------------------------------------------------
// AUTO-DETECT MAGIC LINK & INCOMPLETE SESSIONS (DATABASE VERIFIED)
// ------------------------------------------------------------------
window.addEventListener('DOMContentLoaded', () => {
    setTimeout(async () => {
        if (!window.supabaseClient) return;

        const { data: { session } } = await supabaseClient.auth.getSession();
        const localEmail = localStorage.getItem('pia_user_email');
        const closeBtn = document.getElementById('modal-close-btn');
        const greetingEl = document.getElementById('setup-greeting');

        if (session && !localEmail) {
            openAuthModal('set-password');
            if (closeBtn) closeBtn.classList.add('hidden');

            const { data: profile } = await supabaseClient.from('profiles')
                .select('full_name, status')
                .eq('email', session.user.email)
                .maybeSingle();

            let fullName = profile?.full_name || "Student";
            let isActivationFlow = profile?.status === 'inactive';

            if (isActivationFlow) {
                document.getElementById('setup-title').innerText = "Activate Account";
                document.getElementById('setup-desc').innerText = "Create a secure password to activate your PIA account.";
                if (greetingEl) {
                    greetingEl.innerText = `Hello, ${fullName}! Welcome to PIA!`;
                    greetingEl.classList.remove('hidden');
                }
            } else {
                document.getElementById('setup-logo').classList.add('hidden');
                document.getElementById('setup-title').innerText = "Reset Password";
                document.getElementById('setup-desc').innerText = "Enter your new password below.";
                if (greetingEl) greetingEl.classList.add('hidden');
            }

            if (window.history.replaceState && window.location.hash) {
                window.history.replaceState(null, null, window.location.pathname);
            }
        }
    }, 600);
});

// ------------------------------------------------------------------
// VIEW 1: SIGN IN FORM HANDLING
// ------------------------------------------------------------------
const modalLoginForm = document.getElementById('modal-login-form');
if (modalLoginForm) {
    modalLoginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = document.getElementById('modal-signin-btn');
        btn.disabled = true;
        btn.innerHTML = 'SIGNING IN...';
        hideModalStatus();

        const email = document.getElementById('modal-email').value.trim();
        const password = document.getElementById('modal-password').value;

        const { data: authData, error: authError } = await supabaseClient.auth.signInWithPassword({ email, password });

        if (authError) {
            showModalStatus(authError.message, 'error');
            btn.disabled = false;
            btn.innerHTML = 'SIGN IN';
            return;
        }

        localStorage.setItem('pia_user_email', email);

        const { data: profile, error: profileError } = await supabaseClient
            .from('profiles').select('*').eq('email', authData.user.email).maybeSingle();

        if (profileError || !profile) {
            showModalStatus("Account configuration error. Contact admin.", 'error');
            btn.disabled = false;
            btn.innerHTML = 'SIGN IN';
            return;
        }

        const role = profile.role ? profile.role.trim().toLowerCase() : 'student';
        localStorage.setItem('pia_user_role', role);

        if (role !== 'admin') {
            const maxAllowedDevices = profile.max_devices ?? 1;
            let currentDeviceId = localStorage.getItem('pia_device_id') || getDeviceSignature();
            localStorage.setItem('pia_device_id', currentDeviceId);

            let activeDevices = profile.active_devices || [];
            if (!activeDevices.includes(currentDeviceId)) {
                if (activeDevices.length >= maxAllowedDevices) {
                    await supabaseClient.auth.signOut();
                    showModalStatus(`Device limit reached. Log out from other devices first.`, 'error');
                    btn.disabled = false;
                    btn.innerHTML = 'SIGN IN';
                    return;
                } else {
                    activeDevices.push(currentDeviceId);
                    await supabaseClient.from('profiles').update({ active_devices: activeDevices }).eq('email', authData.user.email);
                }
            }
        }

        if (role === 'admin') window.location.replace('/admin/html/admin-dashboard.html');
        else if (role === 'teacher') window.location.replace('/teacher/html/teacher-dashboard.html');
        else {
            const groupType = profile.group_type ? profile.group_type.trim().toLowerCase() : '';
            const isNonAssigned = (groupType === 'non-assigned' || groupType === 'non_assigned');

            if (!profile.is_ocean_done) {
                const { data: settingData } = await supabaseClient.from('settings').select('value').eq('key', 'stage_ocean').maybeSingle();
                const isOceanOpen = settingData ? (settingData.value === true || settingData.value === 'true') : false;
                window.location.replace(isOceanOpen ? '/student/html/ocean-test.html' : '/student/html/waiting-room.html');
            } else if (isNonAssigned && !profile.selected_character) {
                const { data: charSetting } = await supabaseClient.from('settings').select('value').eq('key', 'stage_char').maybeSingle();
                const isCharOpen = charSetting ? (charSetting.value === true || charSetting.value === 'true') : false;
                window.location.replace(isCharOpen ? '/student/html/character-selection.html' : '/student/html/waiting-room.html');
            } else {
                const { data: dashSetting } = await supabaseClient.from('settings').select('value').eq('key', 'stage_dash').maybeSingle();
                const isDashOpen = dashSetting ? (dashSetting.value === true || dashSetting.value === 'true') : false;
                window.location.replace(isDashOpen ? '/student/html/student-dashboard.html' : '/student/html/waiting-room.html');
            }
        }
    });
}

// ------------------------------------------------------------------
// VIEW 2 & 3: FORGOT PASSWORD FLOW (EMAIL & OTP)
// ------------------------------------------------------------------
const forgotEmailForm = document.getElementById('modal-forgot-form');
const verifyOtpForm = document.getElementById('modal-verify-otp-form');
const otpBoxes = document.querySelectorAll('#modal-otp-boxes input');

function startModalTimer() {
    const resendBtn = document.getElementById('modal-resend-btn');
    const timerSpan = document.getElementById('modal-timer');
    let timeLeft = 60;
    resendBtn.disabled = true;
    timerSpan.textContent = timeLeft;

    clearInterval(countdownInterval);
    countdownInterval = setInterval(() => {
        timeLeft--;
        timerSpan.textContent = timeLeft;
        if (timeLeft <= 0) {
            clearInterval(countdownInterval);
            resendBtn.disabled = false;
            resendBtn.innerHTML = "Resend Code";
        }
    }, 1000);
}

if (forgotEmailForm) {
    forgotEmailForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        hideModalStatus();
        const btn = document.getElementById('modal-send-otp-btn');
        const email = document.getElementById('forgot-email-input').value.trim();

        btn.disabled = true;
        btn.innerHTML = 'SENDING...';

        const { error } = await supabaseClient.auth.resetPasswordForEmail(email);

        if (error) {
            showModalStatus(error.message, 'error');
            btn.disabled = false;
            btn.innerHTML = 'SEND OTP';
            return;
        }

        pendingResetEmail = email;
        switchAuthView('forgot-otp');
        showModalStatus("OTP sent to your email.", "success");
        startModalTimer();
        btn.disabled = false;
        btn.innerHTML = 'SEND OTP';
    });
}

document.getElementById('modal-resend-btn')?.addEventListener('click', async (e) => {
    hideModalStatus();
    e.target.disabled = true;
    e.target.innerHTML = 'Resending...';

    const { error } = await supabaseClient.auth.resetPasswordForEmail(pendingResetEmail);
    if (error) {
        showModalStatus(error.message, 'error');
        e.target.disabled = false;
        e.target.innerHTML = 'Resend Code';
        return;
    }

    showModalStatus("New code sent!", 'success');
    e.target.innerHTML = 'Resend code in <span id="modal-timer">60</span>s';
    startModalTimer();
});

// OTP Input Grid Logic 
if (otpBoxes.length > 0) {
    otpBoxes.forEach((input, index) => {
        input.addEventListener('input', (e) => {
            let val = e.target.value.replace(/\D/g, '');
            if (val.length > 1) {
                const chars = val.split('');
                otpBoxes.forEach((box, i) => box.value = chars[i] || '');
                const lastIdx = Math.min(chars.length, otpBoxes.length) - 1;
                otpBoxes[lastIdx].focus();
            } else {
                e.target.value = val;
                if (val && index < otpBoxes.length - 1) otpBoxes[index + 1].focus();
            }
        });

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Backspace' && !input.value && index > 0) otpBoxes[index - 1].focus();
        });

        input.addEventListener('paste', (e) => {
            e.preventDefault();
            const chars = e.clipboardData.getData('text').replace(/\D/g, '').split('');
            otpBoxes.forEach((box, i) => box.value = chars[i] || '');
            const lastIdx = Math.min(chars.length, otpBoxes.length) - 1;
            if (lastIdx >= 0) otpBoxes[lastIdx].focus();
        });
    });
}

if (verifyOtpForm) {
    verifyOtpForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        hideModalStatus();
        const btn = document.getElementById('modal-verify-btn');
        let otpCode = '';
        otpBoxes.forEach(input => otpCode += input.value.trim());

        if (otpCode.length < 8) return showModalStatus("Complete the 8-digit code.", 'error');

        btn.disabled = true;
        btn.innerHTML = 'VERIFYING...';

        const { error } = await supabaseClient.auth.verifyOtp({
            email: pendingResetEmail,
            token: otpCode,
            type: 'recovery'
        });

        if (error) {
            showModalStatus(error.message, 'error');
            btn.disabled = false;
            btn.innerHTML = 'VERIFY CODE';
            return;
        }

        isActivationFlow = false;
        document.getElementById('setup-logo').classList.add('hidden');
        document.getElementById('setup-title').innerText = "Reset Password";
        document.getElementById('setup-desc').innerText = "Enter your new password below.";

        const greetingEl = document.getElementById('setup-greeting');
        if (greetingEl) greetingEl.classList.add('hidden');

        switchAuthView('set-password');
        showModalStatus("Verified! Create a new password.", 'success');
        btn.disabled = false;
        btn.innerHTML = 'VERIFY CODE';
    });
}

// ------------------------------------------------------------------
// VIEW 4: SET / SAVE PASSWORD (Magic Link & Reset Password)
// ------------------------------------------------------------------
const setPasswordForm = document.getElementById('modal-set-password-form');
if (setPasswordForm) {
    setPasswordForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        hideModalStatus();
        const btn = document.getElementById('modal-save-password-btn');
        const password = document.getElementById('modal-new-password').value;
        const confirmPassword = document.getElementById('modal-confirm-password').value;

        if (password !== confirmPassword) return showModalStatus("Passwords do not match.", 'error');

        btn.disabled = true;
        btn.innerHTML = 'SAVING...';

        const { error: updateError } = await supabaseClient.auth.updateUser({ password });

        if (updateError) {
            showModalStatus(updateError.message, 'error');
            btn.disabled = false;
            btn.innerHTML = 'SAVE PASSWORD';
            return;
        }

        if (isActivationFlow) {
            const { data: authData } = await supabaseClient.auth.getUser();
            if (authData?.user) {
                await supabaseClient.from('profiles').update({ status: 'active' }).eq('email', authData.user.email);
            }
        }

        // I-sign out si user mula sa background session para pwersahin mag-login gamit ang bagong credentials
        await supabaseClient.auth.signOut();

        showModalStatus("Password saved successfully! Please sign in.", 'success');

        // Matapos ang 1.5 segundo, i-switch pabalik sa Sign In screen
        setTimeout(() => {
            const closeBtn = document.getElementById('modal-close-btn');
            if (closeBtn) closeBtn.classList.remove('hidden');

            setPasswordForm.reset();
            document.querySelectorAll('.clear-input-btn').forEach(b => b.classList.add('hidden'));

            switchAuthView('signin');
            btn.disabled = false;
            btn.innerHTML = 'SAVE PASSWORD';
        }, 1500);
    });
}

// ==========================================
// UI INTERACTIONS (Tutors, FAQ, Modals, Scroll Spy)
// ==========================================

const tutors = [
    { name: "The Visionary", desc: "Specializes in Openness. Always ready with creative solutions and imaginative math puzzles.", img: "/assets/images/char-1.png" },
    { name: "The Planner", desc: "Specializes in Conscientiousness. Focuses on discipline, structure, and mastery of every topic.", img: "/assets/images/char-1.png" },
    { name: "The Collaborator", desc: "Specializes in Extraversion. Engages through active communication and group-learning styles.", img: "/assets/images/char-1.png" },
    { name: "The Analyst", desc: "Specializes in Logic. Breaks down complex equations into simple, bite-sized steps.", img: "/assets/images/char-1.png" }
];

const imgEl = document.getElementById('tutor-img');
const nameEl = document.getElementById('tutor-name');
const descEl = document.getElementById('tutor-desc');
const gridEl = document.getElementById('tutor-grid');

function selectTutor(index) {
    const t = tutors[index];
    if (!t || !imgEl) return;
    imgEl.style.opacity = 0;
    setTimeout(() => {
        imgEl.src = t.img;
        nameEl.innerText = t.name;
        descEl.innerText = t.desc;
        imgEl.style.opacity = 1;
    }, 200);
}

if (gridEl) {
    tutors.forEach((t, i) => {
        gridEl.innerHTML += `
            <button onclick="selectTutor(${i})" class="w-14 h-14 md:w-16 md:h-16 rounded-xl md:rounded-2xl overflow-hidden border-2 border-custom hover-border-accent transition-all hover:scale-105 active:scale-95 focus:outline-none shrink-0">
                 <img src="${t.img}" class="w-full h-full object-cover">
            </button>`;
    });
    selectTutor(0);
}

// ==========================================
// FAQ ANIMATION LOGIC
// ==========================================
function toggleFaq(btn) {
    const faqItem = btn.closest('.faq-item');

    // Opsiyonal: Kung gusto mong sumara yung iba kapag may binuksang bago
    document.querySelectorAll('.faq-item').forEach(item => {
        if (item !== faqItem) item.classList.remove('faq-active');
    });

    faqItem.classList.toggle('faq-active');
}

const modalContentMap = {
    ocean: {
        title: "OCEAN Framework",
        desc: "Everyone has a unique way of thinking! We match you with a tutor who knows exactly how to help you learn.",
        items: [
            { title: "Openness", desc: "Creative side! Imagination for math puzzles.", icon: "/assets/images/char-1.png" },
            { title: "Conscientiousness", desc: "Your planner side! Neat notes and focus.", icon: "/assets/images/char-1.png" }
        ]
    },
    sdt: {
        title: "SDT Theory",
        desc: "Self-Determination Theory focuses on the needs that drive human motivation.",
        items: [
            { title: "Autonomy", desc: "Feeling in control of your own learning.", icon: "/assets/images/char-1.png" },
            { title: "Competence", desc: "Feeling capable of mastering math.", icon: "/assets/images/char-1.png" }
        ]
    }
};

function openModal(id) {
    const data = modalContentMap[id];
    if (!data) return;
    document.getElementById('modal-title').innerText = data.title;
    document.getElementById('modal-desc').innerText = data.desc;
    document.getElementById('modal-list-container').innerHTML = data.items.map(item => `
        <div class="flex items-start gap-4">
            <div class="bg-muted p-3 rounded-xl border border-custom">
                <img src="${item.icon}" class="w-10 h-10 object-cover">
            </div>
            <div>
                <h4 class="font-semibold">${item.title}</h4>
                <p class="text-secondary text-sm font-light">${item.desc}</p>
            </div>
        </div>
    `).join('');

    document.getElementById('modal').classList.remove('opacity-0', 'pointer-events-none');
    document.getElementById('modal-content').classList.remove('scale-95');
    document.body.style.overflow = 'hidden';
}

function closeModal() {
    document.getElementById('modal').classList.add('opacity-0', 'pointer-events-none');
    document.getElementById('modal-content').classList.add('scale-95');
    document.body.style.overflow = '';
}

document.getElementById('ocean-btn')?.addEventListener('click', () => openModal('ocean'));
document.getElementById('sdt-btn')?.addEventListener('click', () => openModal('sdt'));

document.addEventListener("DOMContentLoaded", () => {
    const sections = document.querySelectorAll("main[id], section[id]");
    const desktopLinks = document.querySelectorAll("nav a.admin-nav-btn[href^='#']");

    function highlightActiveNav() {
        const mobileLinks = document.querySelectorAll("#mobile-menu a.admin-nav-btn[href^='#']");
        let scrollY = window.scrollY;
        let currentSection = "home";

        if (scrollY > 50) {
            sections.forEach(section => {
                const sectionTop = section.offsetTop - 150;
                if (scrollY >= sectionTop && scrollY < sectionTop + section.offsetHeight) {
                    currentSection = section.getAttribute("id");
                }
            });
        }

        const updateLinks = (links) => {
            links.forEach(link => {
                link.getAttribute("href") === `#${currentSection}` ? link.classList.add("active") : link.classList.remove("active");
            });
        };

        updateLinks(desktopLinks);
        updateLinks(mobileLinks);
    }

    window.addEventListener("scroll", highlightActiveNav);
    window.addEventListener("load", highlightActiveNav);
});


// Tanggalin ang DOMContentLoaded wrapper para dito:
const mobileToggle = document.getElementById('mobile-toggle');
const mobileMenu = document.getElementById('mobile-menu');
const menuBackdrop = document.getElementById('menu-backdrop');
const closeBtn = document.getElementById('dynamic-close-btn');

if (mobileToggle && mobileMenu) {
    mobileToggle.addEventListener('click', () => {
        mobileMenu.classList.remove('translate-x-full');
        if (menuBackdrop) menuBackdrop.classList.remove('hidden');
        if (closeBtn) closeBtn.classList.remove('opacity-0');
        document.body.style.overflow = 'hidden';
    });

    const closeMenu = () => {
        mobileMenu.classList.add('translate-x-full');
        if (menuBackdrop) menuBackdrop.classList.add('hidden');
        if (closeBtn) closeBtn.classList.add('opacity-0');
        document.body.style.overflow = '';
    };

    if (closeBtn) closeBtn.addEventListener('click', closeMenu);
    if (menuBackdrop) menuBackdrop.addEventListener('click', closeMenu);
}

// ==========================================
// ANIMATIONS: REVEAL & APPLE-STYLE ZOOM
// ==========================================
document.addEventListener("DOMContentLoaded", () => {
    // 1. Reveal Animation (Fade in & Slide up)
    const revealOptions = {
        threshold: 0.15,
        rootMargin: "0px 0px -50px 0px"
    };

    const revealObserver = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
            if (entry.isIntersecting) {
                entry.target.classList.add("active");
            }
        });
    }, revealOptions);

    document.querySelectorAll(".reveal").forEach((el) => {
        revealObserver.observe(el);
    });
});

// ==========================================
// CINEMATIC SCROLL ZOOM (DESKTOP) + STATIC GLOW (MOBILE)
// ==========================================
document.addEventListener("DOMContentLoaded", () => {
    const scrollZone = document.getElementById("cinematic-scroll-zone");
    const zoomText = document.querySelector(".magic-top-text");
    const overlay = document.getElementById("cinematic-overlay");

    if (scrollZone && zoomText && overlay) {
        let ticking = false;

        const updateCinematic = () => {
            // KAPAG MOBILE (<= 768px): Walang zoom/blackout, pero naka-on ang glow
            if (window.innerWidth <= 768) {
                overlay.style.opacity = "0";
                zoomText.style.transform = "scale(1)";

                // Naka-steady sa 0.6 ang intensity ng ilaw para smooth sa phone
                zoomText.style.setProperty('--glow-intensity', '0.6');
                zoomText.classList.add('moving-glow');
                return;
            }

            // KAPAG DESKTOP: Full cinematic effect
            const rect = scrollZone.getBoundingClientRect();
            const windowHeight = window.innerHeight;

            let scrollProgress = -rect.top / (rect.height - windowHeight);
            scrollProgress = Math.max(0, Math.min(1, scrollProgress));

            let intensity = 1 - Math.abs((scrollProgress - 0.5) * 2);

            if (intensity > 0.05) {
                overlay.style.opacity = (intensity * 0.95).toString();
                zoomText.style.setProperty('--glow-intensity', intensity);
                zoomText.classList.add('moving-glow');
                zoomText.style.transform = `scale(${1 + (intensity * 0.35)})`;
            } else {
                overlay.style.opacity = "0";
                zoomText.style.transform = "scale(1)";
                zoomText.classList.remove('moving-glow');
                zoomText.style.removeProperty('--glow-intensity');
            }
        };

        window.addEventListener("scroll", () => {
            if (!ticking) {
                window.requestAnimationFrame(() => {
                    updateCinematic();
                    ticking = false;
                });
                ticking = true;
            }
        }, { passive: true });

        window.addEventListener("resize", updateCinematic);
        updateCinematic();
    }
});