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

    modal.classList.add('modal-active');
    box.classList.add('modal-content-active');
    document.body.style.overflow = 'hidden';

    if (closeBtn) closeBtn.classList.remove('hidden');

    switchAuthView(view);
    hideModalStatus();
}

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
    modal.classList.remove('modal-active');
    box.classList.remove('modal-content-active');
    document.body.style.overflow = '';
}

function switchAuthView(view) {
    document.getElementById('view-signin').classList.add('hidden');
    document.getElementById('view-forgot-email').classList.add('hidden');
    document.getElementById('view-forgot-otp').classList.add('hidden');
    document.getElementById('view-set-password').classList.add('hidden');

    document.getElementById(`view-${view}`).classList.remove('hidden');
    currentAuthView = view;
    hideModalStatus();
    clearAllFieldErrors();
}

// View-to-status-box mapping for per-view error/success banners
const viewStatusMap = {
    'signin': 'signin-status-box',
    'forgot-email': 'forgot-email-status-box',
    'forgot-otp': 'forgot-otp-status-box',
    'set-password': 'set-password-status-box'
};

let currentAuthView = 'signin';

function getActiveStatusBox() {
    const id = viewStatusMap[currentAuthView];
    return id ? document.getElementById(id) : null;
}

function showModalStatus(message, type) {
    const statusBox = getActiveStatusBox();
    if (!statusBox) return;
    statusBox.textContent = message;
    statusBox.classList.remove('hidden', 'status-error', 'status-success');
    statusBox.classList.add(type === 'error' ? 'status-error' : 'status-success');
}

function hideModalStatus() {
    Object.values(viewStatusMap).forEach(id => {
        const box = document.getElementById(id);
        if (box) box.classList.add('hidden');
    });
}

// --- Validation Helpers ---
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function showFieldError(inputId, message) {
    const errorEl = document.getElementById(inputId + '-error');
    const inputEl = document.getElementById(inputId);
    if (errorEl) {
        errorEl.textContent = message;
        errorEl.classList.remove('hidden');
    }
    if (inputEl) inputEl.classList.add('input-error');
}

function clearFieldError(inputId) {
    const errorEl = document.getElementById(inputId + '-error');
    const inputEl = document.getElementById(inputId);
    if (errorEl) {
        errorEl.textContent = '';
        errorEl.classList.add('hidden');
    }
    if (inputEl) inputEl.classList.remove('input-error');
}

function clearAllFieldErrors() {
    document.querySelectorAll('.field-error').forEach(el => {
        el.textContent = '';
        el.classList.add('hidden');
    });
    document.querySelectorAll('.form-input.input-error').forEach(el => {
        el.classList.remove('input-error');
    });
}

function validateEmail(inputId) {
    const val = document.getElementById(inputId)?.value.trim() || '';
    if (!val) { showFieldError(inputId, 'Email is required.'); return false; }
    if (!EMAIL_REGEX.test(val)) { showFieldError(inputId, 'Please enter a valid email address.'); return false; }
    clearFieldError(inputId);
    return true;
}

function validateRequired(inputId, label) {
    const val = document.getElementById(inputId)?.value || '';
    if (!val) { showFieldError(inputId, `${label} is required.`); return false; }
    clearFieldError(inputId);
    return true;
}

function validatePassword(inputId, label = 'Password') {
    const val = document.getElementById(inputId)?.value || '';
    if (!val) { showFieldError(inputId, `${label} is required.`); return false; }
    if (val.length < 6) { showFieldError(inputId, `${label} must be at least 6 characters.`); return false; }
    clearFieldError(inputId);
    return true;
}

// getDeviceSignature() ay nasa function.js na (shared helper)

// ------------------------------------------------------------------
// INIT: AUTH STATE & NAV LOGIC
// ------------------------------------------------------------------
async function initAuthState() {
    const heroBtn = document.getElementById('hero-btn');
    const loggedOutContainer = document.getElementById('logged-out-container');
    const loggedInContainer = document.getElementById('logged-in-container');
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

    const timeGreeting = getTimeGreeting();

    if (email) {
        const { data: profile } = await supabaseClient.from('profiles').select('full_name, group_type, is_ocean_done, selected_character').eq('email', email).maybeSingle();

        let fullName = profile?.full_name || "Player";
        let firstName = fullName.split(' ')[0];

        // Desktop nav: hide Sign In, show user dropdown
        if (loggedOutContainer) loggedOutContainer.classList.add('hidden');
        if (loggedInContainer) loggedInContainer.classList.remove('hidden');
        if (navUserGreeting) navUserGreeting.textContent = `${timeGreeting}, ${firstName}!`;
        if (navUserEmail) navUserEmail.textContent = email;

        if (mobPrefix && mobName && mobAuthBtn) {
            mobPrefix.textContent = `${timeGreeting},`;
            mobPrefix.style.textTransform = 'capitalize';
            mobName.textContent = fullName;
            mobName.style.fontSize = '1.1rem';

            if (mobChangePassBtn) mobChangePassBtn.classList.remove('hidden');
            if (mobAuthText) mobAuthText.textContent = 'SIGN OUT';
            if (mobAuthIcon) mobAuthIcon.setAttribute('data-lucide', 'log-out');

            mobAuthBtn.classList.replace('btn-primary', 'btn-secondary');
            mobAuthBtn.classList.add('mobile-auth-danger');
            mobAuthBtn.setAttribute('onclick', 'executeForceLogout()');
        }

        if (heroBtn && role !== 'admin' && role !== 'teacher') {
            heroBtn.innerHTML = `<span>Start My Mission</span><i data-lucide="play" class="icon-sm"></i>`;
            heroBtn.removeAttribute('onclick');
            heroBtn.addEventListener('click', async () => {
                window.location.replace(await resolveStudentRedirect(profile || {}));
            });
        }
        if (typeof lucide !== 'undefined') lucide.createIcons();

    } else {
        // Desktop nav: show Sign In, hide user dropdown
        if (loggedOutContainer) loggedOutContainer.classList.remove('hidden');
        if (loggedInContainer) loggedInContainer.classList.add('hidden');

        if (heroBtn) {
            heroBtn.innerHTML = `<span>Start Adventure</span><i data-lucide="play" class="icon-sm"></i>`;
            heroBtn.setAttribute('onclick', "openAuthModal('signin')");
        }
        if (mobChangePassBtn) mobChangePassBtn.classList.add('hidden');
        if (mobAuthText) mobAuthText.textContent = 'Sign In';
        if (mobAuthIcon) mobAuthIcon.setAttribute('data-lucide', 'log-in');

        if (mobAuthBtn) {
            mobAuthBtn.classList.replace('btn-secondary', 'btn-primary');
            mobAuthBtn.classList.remove('mobile-auth-danger');
            mobAuthBtn.setAttribute('onclick', "openAuthModal('signin'); document.getElementById('dynamic-close-btn').click();");
        }
    }
}

// ------------------------------------------------------------------
// FORMS & TIMER LOGIC
// ------------------------------------------------------------------
const modalLoginForm = document.getElementById('modal-login-form');
if (modalLoginForm) {
    modalLoginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        clearAllFieldErrors();
        hideModalStatus();

        // --- Client-side validation ---
        const emailValid = validateEmail('modal-email');
        const passValid = validateRequired('modal-password', 'Password');
        if (!emailValid || !passValid) return;

        const btn = document.getElementById('modal-signin-btn');
        btn.disabled = true;
        btn.innerHTML = 'SIGNING IN...';

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
            const deviceCheck = await enforceDeviceLimit(authData.user.email, profile);
            if (!deviceCheck.allowed) {
                await supabaseClient.auth.signOut();
                showModalStatus(deviceCheck.reason, 'error');
                btn.disabled = false;
                btn.innerHTML = 'SIGN IN';
                return;
            }
        }

        if (role === 'admin') window.location.replace('/admin/html/admin-dashboard.html');
        else if (role === 'teacher') window.location.replace('/teacher/html/teacher-dashboard.html');
        else window.location.replace(await resolveStudentRedirect(profile));
    });
}

const forgotEmailForm = document.getElementById('modal-forgot-form');
const verifyOtpForm = document.getElementById('modal-verify-otp-form');
const otpBoxes = document.querySelectorAll('#modal-otp-boxes input');

function startModalTimer() {
    clearInterval(countdownInterval);
    countdownInterval = startResendTimer(
        document.getElementById('modal-resend-btn'),
        document.getElementById('modal-timer')
    );
}

if (forgotEmailForm) {
    forgotEmailForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        clearAllFieldErrors();
        hideModalStatus();

        // --- Client-side validation ---
        if (!validateEmail('forgot-email-input')) return;

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

wireOtpInputs(otpBoxes);

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

const setPasswordForm = document.getElementById('modal-set-password-form');
if (setPasswordForm) {
    setPasswordForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        clearAllFieldErrors();
        hideModalStatus();

        // --- Client-side validation ---
        const newPassValid = validatePassword('modal-new-password', 'New password');
        const confirmPassValid = validatePassword('modal-confirm-password', 'Confirm password');
        if (!newPassValid || !confirmPassValid) return;

        const btn = document.getElementById('modal-save-password-btn');
        const password = document.getElementById('modal-new-password').value;
        const confirmPassword = document.getElementById('modal-confirm-password').value;

        if (password !== confirmPassword) {
            showFieldError('modal-confirm-password', 'Passwords do not match.');
            return;
        }

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

        await supabaseClient.auth.signOut();
        showModalStatus("Password saved successfully! Please sign in.", 'success');

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
// UI INTERACTIONS & SINGLE DOMCONTENTLOADED
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
            <button onclick="selectTutor(${i})" class="tutor-thumb">
                 <img src="${t.img}" alt="${t.name}">
            </button>`;
    });
    selectTutor(0);
}

function toggleFaq(btn) {
    const faqItem = btn.closest('.faq-item');
    if (!faqItem) return;
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
        <div class="framework-item">
            <div class="framework-item-icon-wrap">
                <img src="${item.icon}" alt="">
            </div>
            <div>
                <h4 class="framework-item-title">${item.title}</h4>
                <p class="text-secondary framework-item-desc">${item.desc}</p>
            </div>
        </div>
    `).join('');

    document.getElementById('modal').classList.add('modal-active');
    document.getElementById('modal-content').classList.add('modal-content-active');
    document.body.style.overflow = 'hidden';
}

function closeModal() {
    document.getElementById('modal').classList.remove('modal-active');
    document.getElementById('modal-content').classList.remove('modal-content-active');
    document.body.style.overflow = '';
}

document.getElementById('ocean-btn')?.addEventListener('click', () => openModal('ocean'));
document.getElementById('sdt-btn')?.addEventListener('click', () => openModal('sdt'));

// --- CONSOLIDATED DOM CONTENT LOADED ---
document.addEventListener("DOMContentLoaded", () => {
    initAuthState();

    // 1. Clear input buttons & Password toggles
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

    // Auto-clear inline field errors on typing
    ['modal-email', 'modal-password', 'forgot-email-input', 'modal-new-password', 'modal-confirm-password'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('input', () => clearFieldError(id));
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

    // 2. Scroll Spy Nav Highlighting
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

    // 3. Mobile Menu Toggle Logic (Wala nang nested DOMContentLoaded)
    const mobileToggle = document.getElementById('mobile-toggle');
    const mobileMenu = document.getElementById('mobile-menu');
    const menuBackdrop = document.getElementById('menu-backdrop');
    const closeBtn = document.getElementById('dynamic-close-btn');

    if (mobileToggle && mobileMenu) {
        mobileToggle.addEventListener('click', () => {
            mobileMenu.classList.add('mobile-menu-open');
            if (menuBackdrop) menuBackdrop.classList.remove('hidden');
            if (closeBtn) closeBtn.classList.add('mobile-menu-close-visible');
            document.body.style.overflow = 'hidden';
        });

        const closeMenu = () => {
            mobileMenu.classList.remove('mobile-menu-open');
            if (menuBackdrop) menuBackdrop.classList.add('hidden');
            if (closeBtn) closeBtn.classList.remove('mobile-menu-close-visible');
            document.body.style.overflow = '';
        };

        if (closeBtn) closeBtn.addEventListener('click', closeMenu);
        if (menuBackdrop) menuBackdrop.addEventListener('click', closeMenu);
    }

    // Auto-close mobile menu kapag pinindot ang navigation links
    document.querySelectorAll('#mobile-menu a').forEach(link => {
        link.addEventListener('click', () => {
            const closeBtn = document.getElementById('dynamic-close-btn');
            if (closeBtn) closeBtn.click();
        });
    });

    // 4. Reveal Animations
    const revealOptions = { threshold: 0.15, rootMargin: "0px 0px -50px 0px" };
    const revealObserver = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
            if (entry.isIntersecting) entry.target.classList.add("active");
        });
    }, revealOptions);

    document.querySelectorAll(".reveal").forEach((el) => {
        revealObserver.observe(el);
    });

    // 5. Cinematic Scroll Zoom (Desktop) + Static Glow (Mobile)
    const scrollZone = document.getElementById("cinematic-scroll-zone");
    const zoomText = document.querySelector(".magic-top-text");
    const overlay = document.getElementById("cinematic-overlay");

    if (scrollZone && zoomText && overlay) {
        let ticking = false;

        const updateCinematic = () => {
            if (window.innerWidth <= 768) {
                overlay.style.opacity = "0";
                zoomText.style.transform = "scale(1)";
                zoomText.style.setProperty('--glow-intensity', '0.6');
                zoomText.classList.add('moving-glow');
                return;
            }

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