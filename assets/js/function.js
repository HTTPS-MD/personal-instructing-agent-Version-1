// /SHARED ASSETS/JS/function.js

// ==========================================
// 1. SUPABASE INITIALIZATION
// ==========================================
const supabaseUrl = 'https://hvfqqdtemayhhfavmfbs.supabase.co';
const supabaseKey = 'sb_publishable_NXpgU16p8YZ4oedc7MY5ng_J3F-2Mgy';

// Where links INSIDE EMAILS point (activation, invite, password reset). It is
// deliberately NOT taken from the page's own address: an admin who sends an
// activation while working on 127.0.0.1 would otherwise email every student a
// link to their own laptop, which a phone cannot open (ERR_CONNECTION_REFUSED).
// Supabase only honours it if it is on the allow list: Authentication → URL
// Configuration → Redirect URLs must contain this address followed by /**
// To test the set-password page on your own machine, point this at your local
// server for that session, and change it back before deploying.
const PUBLIC_SITE_URL = 'https://personal-instructing-agent-version-1.pages.dev/';

function emailLinkTo(path) {
    return new URL(path, PUBLIC_SITE_URL).href;
}

// The address this page was opened with, captured BEFORE the client below
// exists. supabase-js reads the tokens out of an email link's #hash and then
// wipes it, but the set-password page still needs to know what kind of link it
// was (invite, magic link, recovery) and whether it arrived with an error.
window.PIA_ENTRY_URL = window.location.href;

window.supabaseClient = null;
window.sb = null;

if (window.supabase) {
    window.supabaseClient = window.supabase.createClient(supabaseUrl, supabaseKey, {
        // auth-callback.js raises this on the landing page while it hands an
        // email link on to the set-password page: the one-time tokens belong
        // to that page and must not be spent here on the way through.
        auth: { detectSessionInUrl: !window.PIA_AUTH_FORWARDING }
    });
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

// STUDENTS: ONE ACTIVE SESSION, THE LATEST SIGN-IN WINS (migration 0027).
// Students no longer use the device slots above. Right after the password
// check, this device claims the account; the server signs every other device
// out (their tokens are refused at once, their refresh tokens deleted), and
// their 10-second check (section 1C-6) shows them why. Teachers keep the
// slots; the server ignores this call for staff.
//
// Returns { allowed: true } or { allowed: false, reason }. `missing` means
// 0027 is not applied yet -- the caller falls back to enforceDeviceLimit, so
// shipping this file before the SQL changes nothing.
async function claimStudentSession() {
    if (!window.supabaseClient) return { allowed: false, reason: 'No connection to the server.' };

    const { error } = await supabaseClient.rpc('claim_student_session', {
        p_device_id: getOrCreateDeviceId()
    });

    if (error) {
        if (isMissingFunction(error)) return { allowed: false, missing: true };
        return {
            allowed: false,
            reason: isNetworkFailure(error)
                ? 'Can’t reach the server. Check your Wi-Fi, then try again.'
                : 'We couldn’t start your session. Please try again.'
        };
    }
    return { allowed: true };
}

// PGRST202 = PostgREST has no such function; 42883 = Postgres has none.
function isMissingFunction(error) {
    return !!error && (error.code === 'PGRST202' || error.code === '42883');
}

// supabase-js reports a failed fetch as an error with no code, rather than
// throwing. Anything with a code is a real answer from the server.
function isNetworkFailure(error) {
    if (navigator.onLine === false) return true;
    if (!error || error.code || error.status) return false;
    return /fetch|network|load failed|timeout|offline/i.test(String(error.message || ''));
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

// Ang page kung saan pinapalitan ng estudyante ang temporary password na
// ibinigay ng admin. Dito lang sila pwedeng pumunta habang naka-flag.
const SET_NEW_PASSWORD_URL = '/student/html/set-new-password.html';

// I-verify ang tunay na session at kunin ang profile. Nagbabalik ng profile,
// o null kung nag-redirect na (huwag nang ituloy ang caller).
//
// opts.allowPasswordChange -- ang set-new-password page lang ang nagpapasa
// nito. Lahat ng iba ay nire-redirect doon habang must_change_password = true,
// kaya walang ibang student page na mabubuksan hangga't hindi napapalitan ang
// temporary password (migration 0019).
async function requireStudentSession(opts) {
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

    const PROFILE_COLUMNS = 'email, full_name, role, group_type, is_ocean_done, selected_character, current_stage';

    let { data: profile, error: profileError } = await supabaseClient
        .from('profiles')
        .select(PROFILE_COLUMNS + ', must_change_password')
        .eq('email', email)
        .maybeSingle();

    // 42703 = walang ganitong column: hindi pa na-apply ang migration 0019.
    // Bumalik sa dating column set. Kung hindi, ang error na ito ay magiging
    // "walang profile" sa ibaba -- at mapapa-sign out ang LAHAT ng estudyante
    // na parang na-revoke ang session nila.
    if (profileError && profileError.code === '42703') {
        ({ data: profile } = await supabaseClient
            .from('profiles')
            .select(PROFILE_COLUMNS)
            .eq('email', email)
            .maybeSingle());
    }

    if (!profile) {
        // Umaabot din dito ang na-revoke na session: hinaharangan ng
        // jwt_is_current() ang SELECT, kaya walang naibabalik na profile
        // kahit teknikal na hindi pa expired ang access token.
        //
        // Kasama na rito ang device na napalitan ng mas bagong sign-in
        // (0027). Tinatanong muna ang server kung bakit, para masabi sa
        // estudyante ang totoong dahilan -- at para LOCAL lang ang sign-out:
        // ang global sa ibaba ay kayang i-sign out pati ang bagong device.
        const why = await fetchSessionStatus();
        if (why === 'replaced' || why === 'revoked') {
            endStudentSession(why);
            return null;
        }

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

    // FORCED PASSWORD CHANGE. Ang admin ang nakakaalam ng temporary password,
    // kaya bawal munang pumasok kahit saan hanggang mapalitan ito. Ang flag ay
    // ibinababa ng database trigger kapag talagang nagbago ang password -- hindi
    // ito kayang i-clear ng estudyante nang direkta.
    if (profile.must_change_password === true && !(opts && opts.allowPasswordChange)) {
        window.location.replace(SET_NEW_PASSWORD_URL);
        return null;
    }

    // Isinusulat MULA sa na-verify na session (derived output, hindi input).
    localStorage.setItem('pia_user_email', email);
    localStorage.setItem('pia_user_role', role);

    // Lab safeguards -- dito lang, pagkatapos makumpirma ang session. Dahil
    // dinadaanan ito ng lahat ng limang student page, isang lugar lang ang
    // kailangang baguhin para magkaroon silang lahat ng sign-out control.
    renderSignOutControl(profile);
    startIdleWatchdog();
    startPresenceHeartbeat();
    startSessionGuard();

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
            background:var(--bg-surface); border-radius:var(--r-pill);
            padding:.35rem .5rem .35rem 1rem; box-shadow:var(--shadow-md);
        }
        #pia-signout-who { color:var(--text); font-size:var(--fs-xs); line-height:1.2;
            white-space:nowrap; max-width:42vw; overflow:hidden; text-overflow:ellipsis; }
        #pia-signout-who.pia-signout-inline { max-width:26vw; text-align:right; }
        #pia-signout-who small { display:block; color:var(--text-faint); font-size:var(--fs-xs); }
    `;
    document.head.appendChild(style);

    // May sariling Sign out button na ang header ng page ([data-signout], o
    // ang #signout-btn ng dashboard). Dati, lumulutang pa rin ang pangalawang
    // control sa kanang itaas -- nakapatong sa mismong button na iyon at sa
    // anumang katabi nito (hal. ang "CHOOSING" pill). Ngayon ang pangalan lang
    // ang idinadagdag, katabi ng button ng page -- nananatili ang identity
    // check nang walang dobleng control. Ang dashboard ay may sarili nang
    // #who-name, kaya wala nang idinadagdag doon.
    const own = document.querySelector('[data-signout], #signout-btn');
    if (own) {
        if (!document.getElementById('who-name') && !document.getElementById('pia-signout-who')) {
            const who = document.createElement('span');
            who.id = 'pia-signout-who';
            who.className = 'pia-signout-inline';
            who.innerHTML = `<small>Signed in as:</small>${escapeHTML(name)}`;
            own.parentNode.insertBefore(who, own);
        }
        return;
    }

    const wrap = document.createElement('div');
    wrap.id = 'pia-signout-control';
    wrap.innerHTML = `
        <span id="pia-signout-who"><small>Signed in as:</small>${escapeHTML(name)}</span>
        <button id="pia-signout-btn" class="btn btn-signout" type="button">Sign out</button>
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
        e.currentTarget.textContent = 'Signing out…';
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
        if (piaSessionEnded) return;   // nothing left to protect on this device
        clearTimeout(idleTimeoutId);
        dismissWarning();
        idleTimeoutId = setTimeout(showIdleWarning, IDLE_LIMIT_MS - IDLE_WARNING_MS);
    };

    function showIdleWarning() {
        if (document.getElementById('pia-idle-modal')) return;
        let left = Math.round(IDLE_WARNING_MS / 1000);

        const modal = document.createElement('div');
        modal.id = 'pia-idle-modal';
        modal.style.cssText = 'position:fixed;inset:0;z-index:var(--z-boot);display:flex;align-items:center;justify-content:center;padding:1rem;background:color-mix(in srgb, var(--ink) 62%, transparent);backdrop-filter:blur(5px);-webkit-backdrop-filter:blur(5px)';
        modal.innerHTML = `
            <div style="max-width:22rem;width:100%;background:var(--bg-surface);border-radius:var(--r-card);padding:var(--sp-7);text-align:center;color:var(--text);box-shadow:var(--shadow-lg)">
                <h3 style="margin:0 0 .5rem;font-size:var(--fs-h4);font-weight:800;letter-spacing:-0.01em">Nandiyan ka pa ba?</h3>
                <p style="margin:0 0 1.25rem;font-size:var(--fs-sm);line-height:1.6;color:var(--text-muted)">Awtomatiko kang isa-sign out sa <strong id="pia-idle-count" style="color:var(--text)">${left}</strong> segundo para maprotektahan ang account mo sa PC na ito.</p>
                <button id="pia-idle-stay" type="button" style="cursor:pointer;border:0;border-radius:var(--r-pill);padding:.85rem 1.5rem;font-size:var(--fs-body);font-weight:700;background:var(--accent);color:var(--on-accent);width:100%">Nandito pa ako</button>
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
// 1C-5. PRESENCE HEARTBEAT (teacher live monitor)
// Tells the server "this student is here" every 45 seconds while the page is
// visible. The server stamps the time itself (touch_presence, migration
// 0026), so a student cannot fake it, and a teacher's dashboard shows them
// offline two minutes after the tab closes. A hidden tab stops beating --
// a student on another tab is not working in PIA -- and beats again the
// moment it is shown. Failures are ignored: presence is a convenience for
// the teacher, never a reason to interrupt a student.
// ==========================================
const PRESENCE_EVERY_MS = 45 * 1000;
let presenceTimerId = null;

function beatPresence() {
    if (!window.supabaseClient || document.hidden || piaSessionEnded) return;
    window.supabaseClient.rpc('touch_presence', { p_online: true }).then(() => {}, () => {});
}

function startPresenceHeartbeat() {
    if (presenceTimerId !== null) return;
    beatPresence();
    presenceTimerId = setInterval(beatPresence, PRESENCE_EVERY_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) beatPresence(); });
}

// ==========================================
// 1C-6. ONE ACTIVE SESSION (students, migration 0027)
// Every 10 seconds a student page asks check_student_session() whether this
// browser still holds the account. When another device has signed in since,
// the answer is 'replaced', and this page:
//   (1) stops every beat at once -- this check, presence, the idle timer and
//       the realtime channels -- so nothing more is sent from here;
//   (2) locks the page behind a notice that says why;
//   (3) signs out LOCALLY and clears storage. Never 'global': that would end
//       the new device's session too.
// The database has already refused this device's token by then (0027 stamps
// sessions_revoked_at), so an answer typed in the last few seconds is
// rejected server-side; the notice is what tells the student.
//
// Only a definite answer from the server ends the session. A dropped request,
// a server error or a missing function (0027 not applied) never does -- a
// Wi-Fi blip in the lab must not sign a class out. A hidden tab skips its
// checks and checks again the moment it is shown.
// ==========================================
const SESSION_CHECK_MS = 10 * 1000;
let sessionCheckTimerId = null;
let sessionCheckInFlight = false;
let sessionGuardOff = false;
let piaSessionEnded = false;
let piaUserSigningOut = false;

// The auth session a token belongs to (its session_id claim). Used only to
// notice that THIS browser signed in again (in another tab) while a check was
// in flight -- never trusted for anything the server decides.
function tokenSessionId(token) {
    try {
        const part = String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        const json = JSON.parse(atob(part + '='.repeat((4 - (part.length % 4)) % 4)));
        return json.session_id || 'unknown';
    } catch (e) {
        return 'unknown';
    }
}

// null = this browser holds no session at all; undefined = could not tell.
async function localSessionId() {
    try {
        const { data } = await supabaseClient.auth.getSession();
        const session = data && data.session;
        return session ? tokenSessionId(session.access_token) : null;
    } catch (e) {
        return undefined;
    }
}

// 'active' | 'replaced' | 'revoked' | 'none', or null when there is no
// definite answer (offline, server error, 0027 not applied).
async function fetchSessionStatus() {
    if (!window.supabaseClient) return null;
    try {
        const { data, error } = await supabaseClient.rpc('check_student_session');
        if (error) {
            if (isMissingFunction(error)) stopSessionGuard();
            return null;
        }
        const status = data && data.status;
        return ['active', 'replaced', 'revoked', 'none'].indexOf(status) === -1 ? null : status;
    } catch (e) {
        return null;
    }
}

async function checkStudentSession() {
    if (piaSessionEnded || sessionGuardOff || sessionCheckInFlight) return;
    if (document.hidden || navigator.onLine === false) return;

    sessionCheckInFlight = true;
    try {
        const before = await localSessionId();
        if (before === null) { endStudentSession('ended'); return; }

        const status = await fetchSessionStatus();
        if (status === null || status === 'active') return;

        // Another tab of THIS browser signed in meanwhile: that session is
        // this device's too. Ask again on the next beat instead.
        const after = await localSessionId();
        if (after !== null && after !== before) return;

        endStudentSession(status === 'none' ? 'ended' : status);
    } finally {
        sessionCheckInFlight = false;
    }
}

function stopSessionGuard() {
    sessionGuardOff = true;
    clearInterval(sessionCheckTimerId);
}

function startSessionGuard() {
    if (sessionCheckTimerId !== null || piaSessionEnded || !window.supabaseClient) return;

    sessionCheckTimerId = setInterval(checkStudentSession, SESSION_CHECK_MS);
    checkStudentSession();

    document.addEventListener('visibilitychange', () => { if (!document.hidden) checkStudentSession(); });
    window.addEventListener('online', checkStudentSession);

    // The refresh token was deleted by a takeover or by "Sign out
    // everywhere", or another tab signed out: supabase-js drops the session
    // and says so. Deferred a tick -- calling back into the auth client from
    // inside its own callback can deadlock it.
    supabaseClient.auth.onAuthStateChange((event) => {
        if (event !== 'SIGNED_OUT' || piaUserSigningOut) return;
        setTimeout(() => endStudentSession('ended'), 0);
    });
}

const SESSION_ENDED_COPY = {
    replaced: {
        title: 'Signed in on another device',
        text: 'Your account was logged in from another device. You have been securely logged out here.',
        note: 'To keep working on this device instead, sign in again. The other device will be signed out.'
    },
    revoked: {
        title: 'You’ve been signed out',
        text: 'Your teacher or the study team signed this account out. You have been securely logged out here.',
        note: ''
    },
    ended: {
        title: 'Your session has ended',
        text: 'For your security, you have been signed out on this device.',
        note: ''
    }
};

// Local-only cleanup, shared by the notice's button. Keeps the device ID (the
// device manager knows this PC by it) and the theme choice.
function clearLocalSession() {
    try {
        const deviceId = localStorage.getItem('pia_device_id');
        const theme = localStorage.getItem('pia_theme');
        localStorage.clear();
        sessionStorage.clear();
        if (deviceId) localStorage.setItem('pia_device_id', deviceId);
        if (theme) localStorage.setItem('pia_theme', theme);
    } catch (e) { /* private mode */ }
}

async function endStudentSession(reason) {
    if (piaSessionEnded) return;
    piaSessionEnded = true;

    // (1) Nothing more leaves this device.
    stopSessionGuard();
    clearInterval(presenceTimerId);
    clearTimeout(idleTimeoutId);
    clearInterval(idleCountdownId);
    const idleModal = document.getElementById('pia-idle-modal');
    if (idleModal) idleModal.remove();
    removeAllChannels();

    // (2) Say why, before any network call can stall.
    showSessionEnded(SESSION_ENDED_COPY[reason] ? reason : 'ended');
    window.dispatchEvent(new CustomEvent('pia:session-ended', { detail: { reason } }));

    // (3) This device only. Capped, so a dead connection cannot keep the
    //     token in storage: clearing storage signs this browser out anyway.
    try {
        await Promise.race([
            supabaseClient.auth.signOut({ scope: 'local' }),
            new Promise((resolve) => setTimeout(resolve, 4000))
        ]);
    } catch (e) { /* the storage clear below is what matters */ }
    clearLocalSession();
}

// The notice. Fixed-position, so it cannot move anything behind it (zero
// CLS); everything else on the page is made inert, so the only thing a
// keyboard, mouse or screen reader can reach is the way back to sign-in.
// Built with textContent -- no markup from anywhere reaches innerHTML except
// the constant icon below.
function showSessionEnded(reason) {
    if (document.getElementById('pia-session-ended')) return;
    const copy = SESSION_ENDED_COPY[reason];

    Array.prototype.forEach.call(document.body.children, (node) => {
        if (node.tagName !== 'SCRIPT') node.inert = true;
    });
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();

    // Stage pages stay transparent until their guard passes; the notice
    // lives in <body>, so it must not inherit that.
    document.body.classList.remove('opacity-0');

    const root = document.createElement('div');
    root.id = 'pia-session-ended';
    root.className = 'session-ended';
    root.setAttribute('role', 'alertdialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', 'pia-session-ended-title');
    root.setAttribute('aria-describedby', 'pia-session-ended-text');

    const card = document.createElement('div');
    card.className = 'session-ended-card';

    const glyph = document.createElement('span');
    glyph.className = 'session-ended-glyph';
    glyph.setAttribute('aria-hidden', 'true');
    glyph.innerHTML =
        '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8" ' +
        'stroke-linecap="round" stroke-linejoin="round" focusable="false">' +
        '<rect x="2.5" y="4" width="13" height="9.5" rx="1.5"/><path d="M6 17h6"/>' +
        '<rect x="15.5" y="9" width="6" height="11" rx="1.5"/><path d="M18.5 17.5h.01"/></svg>';

    const title = document.createElement('h2');
    title.className = 'session-ended-title';
    title.id = 'pia-session-ended-title';
    title.textContent = copy.title;

    const text = document.createElement('p');
    text.className = 'session-ended-text';
    text.id = 'pia-session-ended-text';
    text.textContent = copy.text;

    card.append(glyph, title, text);

    if (copy.note) {
        const note = document.createElement('p');
        note.className = 'session-ended-note';
        note.textContent = copy.note;
        card.append(note);
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-primary session-ended-btn';
    btn.textContent = 'Sign in again';
    btn.addEventListener('click', () => {
        btn.disabled = true;
        btn.textContent = 'Opening sign-in…';
        clearLocalSession();
        window.location.replace('/index.html');
    });
    card.append(btn);

    root.append(card);
    document.body.append(root);

    // A frame lets the fade run. rAF does not fire in a background tab, and
    // a takeover can land there (SIGNED_OUT from a failed refresh), so a
    // timer opens it too -- whichever comes first.
    let opened = false;
    const open = () => {
        if (opened) return;
        opened = true;
        root.classList.add('is-open');
        btn.focus({ preventScroll: true });
    };
    requestAnimationFrame(open);
    setTimeout(open, 100);
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
                    <button id="revoke-modal-btn" class="btn btn-primary btn-lg btn-block">
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

    // 'admin-dashboard' (walang .html) para matugma ang admin-dashboard.html AT
    // admin-dashboard.html. Ang student device watcher na ito ay hindi dapat
    // tumakbo sa admin console -- ang claim_device() ng admin ang humahawak doon.
    if (!userEmail || !currentDeviceId || window.location.pathname.includes('admin-dashboard') || window.location.pathname.includes('sign-in.html')) {
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
                deviceDropped("Your device session was revoked by the administrator.");
            }
        }
    }
}

// This device fell off the account's device list. For a student that now
// usually means a newer sign-in took over (0027), not an admin -- ask the
// server which, and say the right thing. Staff always get the admin message
// (check_student_session answers 'active' for them).
async function deviceDropped(adminMessage) {
    if (piaSessionEnded) return;
    const status = localStorage.getItem('pia_user_role') === 'student' ? await fetchSessionStatus() : null;
    if (status === 'replaced') { endStudentSession('replaced'); return; }
    showRevokeModal("Session Revoked", adminMessage);
}

async function watchDeviceSession() {
    const userEmail = localStorage.getItem('pia_user_email');
    const currentDeviceId = localStorage.getItem('pia_device_id');

    if (!userEmail || !currentDeviceId) return;
    if (window.location.pathname.includes('admin-dashboard') || window.location.pathname.includes('sign-in.html')) return;

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
                deviceDropped("Your device session was disconnected by the administrator.");
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
    // Already signed out here by a newer sign-in elsewhere (section 1C-6).
    // Everything below would act on the account -- global sign-out, presence,
    // the device list -- and the account now belongs to the other device.
    if (piaSessionEnded) {
        clearLocalSession();
        window.location.replace('/index.html');
        return;
    }
    piaUserSigningOut = true;

    // Sinasabihan ang realtime watcher na huwag magpakita ng "Session Revoked"
    // modal habang tayo mismo ang nag-aalis ng device sa listahan.
    sessionStorage.setItem('is_signing_out', 'true');

    const deviceId = localStorage.getItem('pia_device_id');

    try {
        if (window.supabaseClient) {
            // Off the teacher's "online" list at once, not two minutes later.
            // (Staff accounts are not monitored; the server ignores them.)
            clearInterval(presenceTimerId);
            await window.supabaseClient.rpc('touch_presence', { p_online: false });
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
// Ang .endsWith('/' + page) ay eksaktong tugma sa filename. Dati .includes()
// ang gamit, at ang substring collision nito sa lumang tutoring-dashboard.html
// ang nagtatapon sa estudyante palabas ng laro sa bawat syncGameProgress().
// Ang lesson ay tumatakbo na ngayon sa loob mismo ng student-dashboard.html.
const STAGE_PAGES = {
    'OCEAN': { url: 'ocean-test.html', pages: ['ocean-test.html'] },
    'Character Selection': { url: 'character-selection.html', pages: ['character-selection.html'] },
    'Tutoring Dashboard': { url: 'student-dashboard.html', pages: ['student-dashboard.html'] },
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

    // Ang Sign out button ng bawat student page ([data-signout]). Dating inline
    // <script> sa bawat page -- inilipat dito para ang CSP (_headers) ay
    // makapagbawal ng inline script sa buong site. Sa shared lab PC, ang
    // naiwang session ay nangangahulugang sa row ng estudyanteng ito
    // mapupunta ang sagot ng susunod.
    document.querySelectorAll('[data-signout]').forEach((btn) => {
        btn.addEventListener('click', () => {
            if (typeof executeForceLogout === 'function') executeForceLogout();
        });
    });
});