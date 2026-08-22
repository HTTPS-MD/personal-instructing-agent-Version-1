// /SHARED ASSETS/JS/function.js

// ==========================================
// 1. SUPABASE INITIALIZATION
// ==========================================
const supabaseUrl = 'https://hvfqqdtemayhhfavmfbs.supabase.co';
const supabaseKey = 'sb_publishable_NXpgU16p8YZ4oedc7MY5ng_J3F-2Mgy';

window.supabaseClient = null;
window.sb = null;

if (window.supabase) {
    window.supabaseClient = window.supabase.createClient(supabaseUrl, supabaseKey);
    window.sb = window.supabaseClient;
    window.SUPABASE_URL = supabaseUrl;
    window.SUPABASE_ANON_KEY = supabaseKey;
}

// ==========================================
// 1B. SHARED SECURITY / FORMAT HELPERS
// (Dating magkakahiwalay na kopya sa admin-dashboard.js, index.js, at
//  authentication.js -- pinagsama dito para may iisang source of truth.)
// ==========================================

// Escapes a value for safe use as HTML TEXT content.
// FIX: dating `if (!str) return ''` -- kaya ang score na 0 ay lumalabas na
// blangko. Ang null/undefined lang ang dapat maging ''.
function escapeHTML(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// Escapes a value for use inside a JS string literal na nasa loob mismo ng
// isang HTML attribute -- hal. onclick="fn('<dito>')".
//
// SECURITY FIX: ang lumang bersyon ay backslash at single-quote lang ang
// ini-escape. Pero ang value ay dumadaan sa DALAWANG parser: una ang HTML
// attribute parser, tapos ang JS parser. Kaya sapat na ang isang `"` para
// isara ang onclick="..." attribute at magdikit ng bagong handler -- XSS
// kahit "escaped" na. Ang device ID at selected_character ay parehong
// isinusulat ng browser ng estudyante, kaya sila ang tunay na sasakyan nito.
//
// Ang bagong bersyon ay hex-encode ang LAHAT maliban sa [A-Za-z0-9_.-]. Ang
// output ay purong alphanumeric + backslash, kaya wala nang HTML-significant
// na character na natitira: ligtas itong dumaan sa HTML decode, at saka
// nagiging orihinal na string sa loob ng JS string literal.
function escapeJS(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/[^A-Za-z0-9_.\-]/g, (ch) => {
        const code = ch.charCodeAt(0);
        return code < 256
            ? '\\x' + code.toString(16).padStart(2, '0')
            : '\\u' + code.toString(16).padStart(4, '0');
    });
}

// Para sa mga numeric telemetry column na isinusulat mismo ng browser ng
// estudyante (current_problem, hints_used, consecutive_correct,
// ocean_current_item). Hindi lang escape -- pinipilit talaga itong maging
// numero, kaya kahit anong string na naisingit sa DB ay nagiging fallback
// number, hindi markup.
function safeInt(value, fallback = 0) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? n : fallback;
}

// Bumubuo ng humanized na device label (hindi totoong device fingerprint,
// pero sapat na para ma-distinguish ang mga session sa device manager UI).
function getDeviceSignature() {
    const ua = navigator.userAgent;
    let platform = "Unknown Device";
    if (/android/i.test(ua)) platform = "Android Smartphone";
    else if (/iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) platform = "iPadOS Tablet";
    else if (/iPhone|iPod/.test(ua)) platform = "iOS Device";
    else if (/Macintosh|MacIntel|MacPPC|Mac68K/.test(ua)) platform = "macOS Computer";
    else if (/Windows/.test(ua)) platform = "Windows PC";

    const uniqueId = Math.random().toString(36).substring(2, 9);
    return `${uniqueId} [${platform}]`;
}

// Kinukuha (o ginagawa, kung wala pa/invalid) ang stable device ID sa localStorage.
function getOrCreateDeviceId() {
    let deviceId = localStorage.getItem('pia_device_id');
    if (!deviceId || !deviceId.includes('[')) {
        deviceId = getDeviceSignature();
        localStorage.setItem('pia_device_id', deviceId);
    }
    return deviceId;
}

function getTimeGreeting() {
    const hour = new Date().getHours();
    if (hour >= 0 && hour < 12) return "Good morning";
    if (hour >= 12 && hour < 18) return "Good afternoon";
    return "Good evening";
}

// Tumutukoy kung saan dapat ipadala ang student pagkatapos mag-sign in,
// batay sa kanilang profile progress + kasalukuyang stage settings.
// Gumagamit ng absolute paths (mula root) para gumana kahit saang page tumatawag.
// NOTE: gumagamit na ng canEnterStage()/isStageOpen() (nasa section 1C sa ibaba)
// para iisa lang ang prerequisite rules sa buong app. Dating may sariling
// kopya ito ng chain + 3 magkaparehong settings-flag parser.
async function resolveStudentRedirect(profile) {
    if (canEnterStage(profile, 'ocean')) {
        return (await isStageOpen('stage_ocean'))
            ? '/student/html/ocean-test.html' : '/student/html/waiting-room.html';
    }
    if (canEnterStage(profile, 'char')) {
        return (await isStageOpen('stage_char'))
            ? '/student/html/character-selection.html' : '/student/html/waiting-room.html';
    }
    return (await isStageOpen('stage_dash'))
        ? '/student/html/student-dashboard.html' : '/student/html/waiting-room.html';
}

// Pagkatapos ng successful password check, tinitiyak na hindi lalagpas ang
// account sa max_devices bago ilista ang bagong device.
// Nagbabalik ng { allowed: boolean, reason?: string }.
//
// RACE FIX: dating read-then-write mula sa client --
//     basahin ang active_devices -> tingnan ang haba -> i-push -> isulat
// Walang lock sa pagitan ng mga hakbang. Sa isang computer lab kung saan
// sabay-sabay bumabagsak ang 76 na login, ang dalawang magkasabay na login ng
// IISANG account ay parehong nakakabasa ng lumang array at parehong nagsusulat
// -- kaya ang huli ang mananaig at may device na tahimik na nawawala, o
// nakakalusot ang dalawa sa limit na isa.
//
// Nasa claim_device() na ito, na gumagamit ng SELECT ... FOR UPDATE, kaya
// nagseseryalisa ang magkasabay na tawag sa iisang row. Ang mga parameter na
// `email` at `profile` ay pinananatili para hindi mabago ang mga call site --
// ang server na ang kumukuha ng identity mula sa JWT.
async function enforceDeviceLimit(email, profile) {
    if (!window.supabaseClient) return { allowed: false, reason: 'No connection to the server.' };

    const { data, error } = await supabaseClient.rpc('claim_device', {
        p_device_id: getOrCreateDeviceId()
    });

    if (error) {
        return { allowed: false, reason: error.message || 'Could not check the device limit.' };
    }
    if (!data || data.allowed !== true) {
        return { allowed: false, reason: (data && data.reason) || 'Device limit reached.' };
    }
    return { allowed: true };
}

// I-wire ang isang set ng OTP digit inputs (auto-advance, backspace, paste-split).
function wireOtpInputs(inputs) {
    if (!inputs || inputs.length === 0) return;

    inputs.forEach((input, index) => {
        input.addEventListener('input', (e) => {
            let val = e.target.value.replace(/\D/g, '');
            if (val.length > 1) {
                const chars = val.split('');
                inputs.forEach((box, i) => { box.value = chars[i] || ''; });
                const lastIdx = Math.min(chars.length, inputs.length) - 1;
                inputs[lastIdx].focus();
            } else {
                e.target.value = val;
                if (val && index < inputs.length - 1) inputs[index + 1].focus();
            }
        });

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Backspace' && !input.value && index > 0) inputs[index - 1].focus();
        });

        input.addEventListener('paste', (e) => {
            e.preventDefault();
            const chars = e.clipboardData.getData('text').replace(/\D/g, '').split('');
            inputs.forEach((box, i) => { box.value = chars[i] || ''; });
            const lastIdx = Math.min(chars.length, inputs.length) - 1;
            if (lastIdx >= 0) inputs[lastIdx].focus();
        });
    });
}

// Ang 5 IPIP-50 domain scores (E/A/C/N/O, tingnan sa ocean-test.js) ay dinisenyo
// ng orihinal na scoring key na may parehong theoretical range na 0-40 bawat isa,
// kaya iisa lang ang scale na pinagkukumparahan. Dine-normalize pa rin sa 0-100%
// para mas madaling basahin (percentile-style) sa admin at student dashboards.
const OCEAN_SCORE_MAX = 40;
function normalizeOceanScore(raw) {
    const n = parseFloat(raw);
    if (isNaN(n)) return null;
    return Math.max(0, Math.min(100, Math.round((n / OCEAN_SCORE_MAX) * 100)));
}

// Nagpapatakbo ng 60s na resend countdown sa ibinigay na button/timer span.
function startResendTimer(resendBtn, timerSpan, onDone) {
    if (!resendBtn) return null;
    let timeLeft = 60;
    resendBtn.disabled = true;
    if (timerSpan) timerSpan.textContent = timeLeft;

    const intervalId = setInterval(() => {
        timeLeft--;
        if (timerSpan) timerSpan.textContent = timeLeft;
        if (timeLeft <= 0) {
            clearInterval(intervalId);
            resendBtn.disabled = false;
            resendBtn.innerHTML = "Resend Code";
            if (onDone) onDone();
        }
    }, 1000);
    return intervalId;
}

// ==========================================
// 1C. STUDENT ROUTE GUARD (security fix)
// Dati, ang gating ng 5 student pages ay puro localStorage lang
// ('pia_user_email'). Kaya kahit sino, pwedeng mag-set ng ibang email sa
// devtools at ma-render ang page bilang ibang student. Ngayon, ang session
// ng Supabase Auth na lang ang pinagkakatiwalaang identity -- ang localStorage
// ay isinusulat MULA sa na-verify na session, hindi na binabasa bilang input.
// ==========================================

// Iisang parser na lang para sa settings flags (dating inuulit 9x sa student JS).
async function isStageOpen(stageKey) {
    if (!window.supabaseClient) return false;
    const { data } = await supabaseClient
        .from('settings').select('value').eq('key', stageKey).maybeSingle();
    return data ? (data.value === true || data.value === 'true') : false;
}

// Metadata bawat student stage page.
const STUDENT_STAGES = {
    ocean: { flag: 'stage_ocean', currentStage: 'OCEAN', url: '/student/html/ocean-test.html' },
    char: { flag: 'stage_char', currentStage: 'Character Selection', url: '/student/html/character-selection.html' },
    dash: { flag: 'stage_dash', currentStage: 'Tutoring Dashboard', url: '/student/html/student-dashboard.html' }
};

function isNonAssignedGroup(profile) {
    const g = profile.group_type ? profile.group_type.trim().toLowerCase() : '';
    return (g === 'non-assigned' || g === 'non_assigned');
}

// ISANG SOURCE OF TRUTH para sa prerequisite chain. Ginagamit ng route guard
// (para harangan ang direct-URL access) AT ng waiting room (para hindi nito
// i-redirect ang student sa page na hindi naman nila pwedeng puntahan).
// Dahil iisa ang rule, imposible ang redirect loop sa pagitan nila.
function canEnterStage(profile, pageKey) {
    if (!profile) return false;
    const needsCharacter = isNonAssignedGroup(profile) && !profile.selected_character;

    if (pageKey === 'ocean') return !profile.is_ocean_done;
    if (pageKey === 'char') return !!profile.is_ocean_done && needsCharacter;
    if (pageKey === 'dash') return !!profile.is_ocean_done && !needsCharacter;
    return false;
}

// I-verify ang tunay na session at kunin ang profile. Nagbabalik ng profile,
// o null kung nag-redirect na (huwag nang ituloy ang caller).
async function requireStudentSession() {
    if (!window.supabaseClient) {
        window.location.replace('/index.html');
        return null;
    }

    const { data: { session }, error } = await supabaseClient.auth.getSession();
    if (error || !session || !session.user) {
        localStorage.removeItem('pia_user_email');
        localStorage.removeItem('pia_user_role');
        window.location.replace('/index.html');
        return null;
    }

    // Ang email ng session ang TANGING pinagkakatiwalaang identity.
    const email = session.user.email;

    const { data: profile } = await supabaseClient
        .from('profiles')
        .select('email, full_name, role, group_type, is_ocean_done, selected_character, current_stage')
        .eq('email', email)
        .maybeSingle();

    if (!profile) {
        // Umaabot din dito ang na-revoke na session: hinaharangan ng
        // jwt_is_current() ang SELECT, kaya walang naibabalik na profile
        // kahit teknikal na hindi pa expired ang access token.
        const keptDeviceId = localStorage.getItem('pia_device_id');
        await supabaseClient.auth.signOut({ scope: 'global' });
        localStorage.clear();
        if (keptDeviceId) localStorage.setItem('pia_device_id', keptDeviceId);
        window.location.replace('/index.html');
        return null;
    }

    const role = profile.role ? profile.role.trim().toLowerCase() : 'student';
    if (role === 'admin') { window.location.replace('/admin/html/admin-dashboard.html'); return null; }
    if (role === 'teacher') { window.location.replace('/teacher/html/teacher-dashboard.html'); return null; }

    // Isinusulat MULA sa na-verify na session (derived output, hindi input).
    localStorage.setItem('pia_user_email', email);
    localStorage.setItem('pia_user_role', role);

    // Lab safeguards -- dito lang, pagkatapos makumpirma ang session. Dahil
    // dinadaanan ito ng lahat ng limang student page, isang lugar lang ang
    // kailangang baguhin para magkaroon silang lahat ng sign-out control.
    renderSignOutControl(profile);
    startIdleWatchdog();

    return profile;
}

// Buong guard: session + chained prerequisites + stage flag.
// Tawagin ito sa simula ng bawat student stage page.
async function enforceStudentStage(pageKey) {
    const profile = await requireStudentSession();
    if (!profile) return null;

    const cfg = STUDENT_STAGES[pageKey];

    // (a) PREREQUISITE CHAIN -- hindi kayang laktawan kahit may targeted grant.
    if (!canEnterStage(profile, pageKey)) {
        // Dating waiting-room LAGI. Pero ang pinakakaraniwang dahilan ng
        // pagbagsak dito ay TAPOS NA sila sa stage na ito -- hal. bumalik sila
        // sa OCEAN test na sagot na. Ang itapon sila sa waiting room ay
        // mukhang sira; ang tamang lugar nila ang dapat puntahan.
        //
        // Walang loop: ang resolveStudentRedirect() ay gumagamit ng
        // KAPAREHONG canEnterStage() chain, kaya hindi ito magbabalik ng page
        // na tatanggihan ng guard na ito, at bumabagsak sa waiting room kapag
        // sarado ang susunod na stage.
        window.location.replace(await resolveStudentRedirect(profile));
        return null;
    }

    // (b) STAGE FLAG -- ang per-student targeted grant ng admin (current_stage)
    //     ang tanging nag-o-override sa global flag. Ligtas ito dahil ang mga
    //     admin retake flows ay sabay na nire-reset ang is_ocean_done /
    //     selected_character, kaya consistent pa rin ang chain sa (a).
    const hasTargetedGrant = (profile.current_stage === cfg.currentStage);
    if (!hasTargetedGrant && !(await isStageOpen(cfg.flag))) {
        window.location.replace('/student/html/waiting-room.html');
        return null;
    }

    document.body.classList.remove('opacity-0');
    return profile;
}

// ==========================================
// 1C-3. SIGN-OUT CONTROL (computer lab safeguard)
// WALA NI ISANG student page ang may sign-out control dati. Ang
// handleSignOut() sa student-dashboard.js ay hindi kailanman na-wire sa
// markup, at hindi rin naman tumatawag ng auth.signOut(). Sa isang shared na
// PC, ibig sabihin nito ay nananatiling bukas ang session ni Student A para
// gamitin ni Student B -- at mapupunta sa row ni A ang lahat ng sasagutin ni B.
//
// Ini-render lang ito PAGKATAPOS ma-verify ang session, kaya hindi ito lalabas
// sa hindi authenticated na page. Kasama ang pangalan ng naka-sign in: ito na
// rin ang identity check bago umupo ang susunod na estudyante.
// ==========================================
function renderSignOutControl(profile) {
    if (document.getElementById('pia-signout-control')) return;

    const name = (profile && profile.full_name) || (profile && profile.email) || 'Student';

    const style = document.createElement('style');
    style.textContent = `
        #pia-signout-control { display:flex; align-items:center; gap:.6rem; }
        #pia-signout-control.pia-signout-floating {
            position:fixed; top:.75rem; right:.75rem; z-index:9998;
            background:rgba(15,23,42,.85); backdrop-filter:blur(6px);
            border:1px solid rgba(255,255,255,.14); border-radius:999px;
            padding:.35rem .5rem .35rem .9rem; box-shadow:0 6px 20px rgba(0,0,0,.28);
        }
        #pia-signout-who { color:#e2e8f0; font-size:.78rem; line-height:1.15;
            white-space:nowrap; max-width:42vw; overflow:hidden; text-overflow:ellipsis; }
        #pia-signout-who small { display:block; opacity:.6; font-size:.66rem; }
        #pia-signout-btn { cursor:pointer; border:0; border-radius:999px;
            padding:.4rem .85rem; font-size:.75rem; font-weight:700;
            background:#dc2626; color:#fff; }
        #pia-signout-btn:hover { background:#b91c1c; }
        #pia-signout-btn:disabled { opacity:.6; cursor:default; }
    `;
    document.head.appendChild(style);

    const wrap = document.createElement('div');
    wrap.id = 'pia-signout-control';
    wrap.innerHTML = `
        <span id="pia-signout-who"><small>Naka-sign in:</small>${escapeHTML(name)}</span>
        <button id="pia-signout-btn" type="button">SIGN OUT</button>
    `;

    // Kung naglagay ka ng <div id="pia-signout-slot"></div> sa header ng page,
    // doon ito ilalagay nang inline. Kung wala, lumulutang sa kanang itaas --
    // kaya gumagana agad ito sa lahat ng limang student page nang walang
    // binabagong markup.
    const slot = document.getElementById('pia-signout-slot');
    if (slot) slot.appendChild(wrap);
    else { wrap.classList.add('pia-signout-floating'); document.body.appendChild(wrap); }

    document.getElementById('pia-signout-btn').addEventListener('click', async (e) => {
        e.currentTarget.disabled = true;
        e.currentTarget.textContent = 'SIGNING OUT...';
        await executeForceLogout();
    });
}

// ==========================================
// 1C-4. IDLE AUTO SIGN-OUT
// Ang estudyanteng umalis nang hindi nag-sign out ay nag-iiwan ng bukas na
// session para sa susunod na uupo sa PC. Pagkatapos ng katahimikan, may
// 60-segundong babala, tapos awtomatikong sign-out.
//
// Ligtas ito kahit nasa gitna ng laro: naitala na ang bawat natapos na
// problema (record_problem_result), at ang pagehide beacon ang bahala sa
// pag-clear ng is_in_game.
// ==========================================
const IDLE_LIMIT_MS = 15 * 60 * 1000;
const IDLE_WARNING_MS = 60 * 1000;
let idleTimeoutId = null;
let idleCountdownId = null;
let idleWatchdogStarted = false;

function startIdleWatchdog() {
    if (idleWatchdogStarted) return;
    idleWatchdogStarted = true;

    const dismissWarning = () => {
        clearInterval(idleCountdownId);
        idleCountdownId = null;
        const box = document.getElementById('pia-idle-modal');
        if (box) box.remove();
    };

    const resetIdle = () => {
        clearTimeout(idleTimeoutId);
        dismissWarning();
        idleTimeoutId = setTimeout(showIdleWarning, IDLE_LIMIT_MS - IDLE_WARNING_MS);
    };

    function showIdleWarning() {
        if (document.getElementById('pia-idle-modal')) return;
        let left = Math.round(IDLE_WARNING_MS / 1000);

        const modal = document.createElement('div');
        modal.id = 'pia-idle-modal';
        modal.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(2,6,23,.72);backdrop-filter:blur(3px)';
        modal.innerHTML = `
            <div style="max-width:22rem;width:88%;background:#0f172a;border:1px solid rgba(255,255,255,.14);border-radius:1rem;padding:1.5rem;text-align:center;color:#e2e8f0;box-shadow:0 20px 50px rgba(0,0,0,.5)">
                <h3 style="margin:0 0 .5rem;font-size:1.05rem;font-weight:700">Nandiyan ka pa ba?</h3>
                <p style="margin:0 0 1rem;font-size:.85rem;opacity:.75">Awtomatiko kang isa-sign out sa <strong id="pia-idle-count">${left}</strong> segundo para maprotektahan ang account mo sa PC na ito.</p>
                <button id="pia-idle-stay" type="button" style="cursor:pointer;border:0;border-radius:.6rem;padding:.6rem 1.2rem;font-weight:700;background:#2563eb;color:#fff;width:100%">NANDITO PA AKO</button>
            </div>
        `;
        document.body.appendChild(modal);
        document.getElementById('pia-idle-stay').addEventListener('click', resetIdle);

        idleCountdownId = setInterval(() => {
            left--;
            const el = document.getElementById('pia-idle-count');
            if (el) el.textContent = left;
            if (left <= 0) {
                clearInterval(idleCountdownId);
                idleCountdownId = null;
                executeForceLogout();
            }
        }, 1000);
    }

    ['pointerdown', 'keydown', 'scroll', 'touchstart'].forEach(evt =>
        window.addEventListener(evt, resetIdle, { passive: true }));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) resetIdle(); });

    resetIdle();
}

// ==========================================
// 1C-2. GLOBAL IMAGE FALLBACK
// May 11 na larawang tinutukoy ng markup pero wala sa /assets/images:
//   icon-trophy, icon-star, icon-stopwatch, icon-howtoplay, icon-contact,
//   agent-character, char-conscientious, char-extravert, char-agreeable,
//   char-calm, char-neutral
// Dahil dito, lumalabas ang broken-image icon ng browser -- pinaka-halata sa
// character selection, kung saan lahat ng 5 thumbnail ay sira.
//
// Ang mga character portrait ay bumabagsak sa char-1.png (existing); ang mga
// decorative na icon ay itinatago na lang. Pansamantalang panakip ito --
// palitan pa rin ng totoong art assets kapag meron na.
// ==========================================
document.addEventListener('error', (e) => {
    const el = e.target;
    if (!el || el.tagName !== 'IMG' || el.dataset.fallbackApplied) return;
    el.dataset.fallbackApplied = '1';

    if (/char-|agent-character/.test(el.getAttribute('src') || '')) {
        el.src = '/assets/images/char-1.png';
    } else {
        el.classList.add('img-missing');
    }
}, true); // capture phase -- hindi bumubulusok ('bubble') ang error events

// ==========================================
// 1D. REALTIME CHANNEL REGISTRY
// Dati, walang kahit isang channel sa buong app ang na-u-unsubscribe. Kapag
// natawag nang dalawang beses ang isang setup function (o kapag na-re-run ang
// init sa parehong page), nagpapatong-patong ang mga subscription at nadodoble
// ang mga handler. Dinadaanan na ngayon ng lahat ng channel ang registry na
// ito, at nililinis lahat pagsara/pag-navigate palayo sa page.
// ==========================================
const activeChannels = new Map();

// Gumagawa (o muling ginagamit) ng named channel. Kung may kaparehong pangalan
// nang naka-subscribe, tinatanggal muna ito bago gumawa ng bago -- kaya
// idempotent ang pagtawag nang paulit-ulit.
function registerChannel(name, buildFn) {
    if (!window.supabaseClient) return null;

    if (activeChannels.has(name)) {
        supabaseClient.removeChannel(activeChannels.get(name));
        activeChannels.delete(name);
    }

    const channel = buildFn(supabaseClient.channel(name));
    activeChannels.set(name, channel);
    return channel;
}

function removeAllChannels() {
    if (!window.supabaseClient) return;
    activeChannels.forEach((channel) => supabaseClient.removeChannel(channel));
    activeChannels.clear();
}

// 'pagehide' sa halip na 'unload': gumagana ito sa bfcache at sa mobile Safari,
// kung saan hindi maaasahang tumatakbo ang 'unload'.
window.addEventListener('pagehide', removeAllChannels);

// ==========================================
// 2. GLOBAL SESSION & AUTH SECURITY
// ==========================================

function showRevokeModal(title, message) {
    if (document.getElementById('global-revoke-modal')) return;

    const modalHTML = `
        <div id="global-revoke-modal" class="revoke-modal-overlay">
            <div class="solid-card revoke-modal-box">
                <div class="revoke-modal-icon-wrap">
                    <i data-lucide="shield-alert" class="icon-lg text-danger"></i>
                </div>
                <h3 class="revoke-modal-title">${title}</h3>
                <p class="text-secondary revoke-modal-desc">${message}</p>
                <div class="revoke-modal-actions">
                    <button id="revoke-modal-btn" class="btn-primary btn-lg btn-block">
                        <span>Understood</span>
                    </button>
                </div>
            </div>
        </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHTML);
    if (typeof lucide !== 'undefined') lucide.createIcons();

    const modal = document.getElementById('global-revoke-modal');
    const modalBox = modal.querySelector('.solid-card');
    const btn = document.getElementById('revoke-modal-btn');

    requestAnimationFrame(() => {
        modal.classList.add('revoke-modal-visible');
        modalBox.classList.add('revoke-modal-box-visible');
    });

    btn.addEventListener('click', async () => {
        btn.innerHTML = '<i data-lucide="loader-2" class="icon-sm spin"></i> Logging out...';
        if (typeof lucide !== 'undefined') lucide.createIcons();
        btn.disabled = true;
        await executeForceLogout();
    });
}

async function validateDeviceOnLoad() {
    const userEmail = localStorage.getItem('pia_user_email');
    const currentDeviceId = localStorage.getItem('pia_device_id');

    if (!userEmail || !currentDeviceId || window.location.pathname.includes('admin-dashboard.html') || window.location.pathname.includes('sign-in.html')) {
        return;
    }

    if (window.supabaseClient) {
        const { data } = await window.supabaseClient
            .from('profiles')
            .select('active_devices')
            .eq('email', userEmail)
            .maybeSingle();

        if (data && data.active_devices) {
            if (!data.active_devices.includes(currentDeviceId)) {
                showRevokeModal("Session Revoked", "Your device session was revoked by the administrator.");
            }
        }
    }
}

async function watchDeviceSession() {
    const userEmail = localStorage.getItem('pia_user_email');
    const currentDeviceId = localStorage.getItem('pia_device_id');

    if (!userEmail || !currentDeviceId) return;
    if (window.location.pathname.includes('admin-dashboard.html') || window.location.pathname.includes('sign-in.html')) return;

    // SECURITY FIX: dati, `event:'*'` na WALANG filter -- kaya ang bawat
    // pagbabago sa BUONG profiles table ay ipinapadala sa browser ng bawat
    // estudyante, at client-side lang (`payload.new.email !== userEmail`) ang
    // pagsala. Ibig sabihin, natatanggap nila ang email, OCEAN scores, device
    // ID, at test scores ng lahat ng kaklase nila.
    //
    // Server-side na ang pagsala ngayon. TANDAAN: ang filter ay bandwidth at
    // defense-in-depth lang -- kayang mag-subscribe ng kahit sino nang walang
    // filter mula sa console. Ang TUNAY na pananggalang ay ang SELECT policy
    // sa profiles.
    registerChannel('global-device-revocation-' + userEmail, (ch) => ch
        .on('postgres_changes', {
            event: '*',
            schema: 'public',
            table: 'profiles',
            filter: `email=eq.${userEmail}`
        }, async (payload) => {
            if (payload.eventType === 'DELETE') {
                // Kailangan ng REPLICA IDENTITY FULL para tumugma ang filter sa
                // DELETE events -- kung wala, hindi lalabas ang modal na ito.
                showRevokeModal("Account Deleted", "Your account has been permanently removed.");
                return;
            }

            const updatedProfile = payload.new;
            if (!updatedProfile) return;

            const activeDevices = updatedProfile.active_devices || [];
            if (!activeDevices.includes(currentDeviceId)) {
                if (sessionStorage.getItem('is_signing_out') === 'true') return;
                showRevokeModal("Session Revoked", "Your device session was disconnected by the administrator.");
            }
        })
        .subscribe());
}

// Kumpletong sign-out. Apat na bagay ang dapat mangyari, at tatlo sa mga ito
// ay nawawala sa lumang bersyon:
//   (1) palayain ang device slot -- kung hindi, hindi na makaka-login ang
//       estudyante sa ibang PC hanggang sa manu-manong burahin ng admin;
//   (2) GLOBAL signOut -- pinapatay ang refresh tokens sa SERVER, hindi lang
//       ang lokal na kopya;
//   (3) linisin ang storage, pero PANATILIHIN ang device ID para manatiling
//       kilala ang PC na ito sa device manager;
//   (4) absolute path na redirect -- ang '../../index.html' ay mali kapag
//       tinawag mula sa root.
async function executeForceLogout() {
    // Sinasabihan ang realtime watcher na huwag magpakita ng "Session Revoked"
    // modal habang tayo mismo ang nag-aalis ng device sa listahan.
    sessionStorage.setItem('is_signing_out', 'true');

    const deviceId = localStorage.getItem('pia_device_id');

    try {
        if (window.supabaseClient) {
            if (deviceId) {
                await window.supabaseClient.rpc('release_device', { p_device_id: deviceId });
            }
            await window.supabaseClient.auth.signOut({ scope: 'global' });
        }
    } catch (e) {
        // Ituloy pa rin ang paglilinis. Mas mahalagang mawala ang session sa PC
        // na ito kaysa sa maging perpekto ang server-side cleanup.
        console.error('Sign-out cleanup failed:', e);
    }

    localStorage.clear();
    sessionStorage.clear();
    if (deviceId) localStorage.setItem('pia_device_id', deviceId);

    window.location.replace('/index.html');
}

// ==========================================
// 3. STUDENT REAL-TIME STAGE SYNC
// ==========================================

// Ang mga page na TUMUTUGMA na sa bawat stage. Kung nandoon na ang estudyante,
// walang gagawin.
//
// CRITICAL FIX: ang 'Tutoring Dashboard' ay may DALAWANG page --
// student-dashboard.html (hub) at tutoring-dashboard.html (mismong laro). Ang
// lumang code ay `student-dashboard.html` lang ang tinitingnan, sa pamamagitan
// pa ng .includes(). Dahil ang '/student/html/tutoring-dashboard.html' ay HINDI
// naglalaman ng substring na 'student-dashboard.html' (sumusunod sa 'student'
// ay '/', hindi '-'), ang bawat syncGameProgress() -- na tumatakbo sa bawat
// problem, hint, at sagot -- ay nagpapaputok ng SARILING subscription ng
// estudyante at nagtatapon sa kanila palabas ng laro. Walang naitatalang
// tutoring data kailanman.
//
// Ang .endsWith('/' + page) ay eksaktong tugma sa filename, kaya hindi na
// maaaring maulit ang ganitong substring collision.
const STAGE_PAGES = {
    'OCEAN': { url: 'ocean-test.html', pages: ['ocean-test.html'] },
    'Character Selection': { url: 'character-selection.html', pages: ['character-selection.html'] },
    'Tutoring Dashboard': { url: 'student-dashboard.html', pages: ['student-dashboard.html', 'tutoring-dashboard.html'] },
    'Waiting Room': { url: 'waiting-room.html', pages: ['waiting-room.html'] }
};

function setupStudentRealtimeStageSync() {
    const userEmail = localStorage.getItem('pia_user_email');
    const userRole = localStorage.getItem('pia_user_role');

    if (!userEmail || !window.supabaseClient || userRole === 'admin') return;

    // Pangalawang sapin: ang stage lang na TALAGANG nagbago ang nagpapagalaw ng
    // page. Ang mga telemetry write (is_in_game, hints_used, current_problem)
    // ay dumadaan din sa subscription na ito, at hindi sila dapat maging dahilan
    // ng navigation.
    let lastSeenStage = null;

    registerChannel('student-stage-sync-' + userEmail.replace(/[@.]/g, '_'), (ch) => ch
        .on('postgres_changes', {
            event: 'UPDATE',
            schema: 'public',
            table: 'profiles',
            filter: `email=eq.${userEmail}`
        }, (payload) => {
            const updatedProfile = payload.new;
            if (!updatedProfile || !updatedProfile.current_stage || updatedProfile.role === 'admin') return;

            const stage = updatedProfile.current_stage;
            if (stage === lastSeenStage) return;
            lastSeenStage = stage;

            const target = STAGE_PAGES[stage];
            if (!target) return;

            const currentPath = window.location.pathname;
            if (target.pages.some(page => currentPath.endsWith('/' + page))) return; // nandito na

            window.location.replace(target.url);
        })
        .subscribe());
}

// ==========================================
// 4. EVENT LISTENERS
// ==========================================
document.addEventListener("DOMContentLoaded", () => {
    validateDeviceOnLoad();
    watchDeviceSession();
    setupStudentRealtimeStageSync();
});