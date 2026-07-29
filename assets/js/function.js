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
// 2. GLOBAL SESSION & AUTH SECURITY
// ==========================================

function showRevokeModal(title, message) {
    if (document.getElementById('global-revoke-modal')) return;

    const modalHTML = `
        <div id="global-revoke-modal" class="fixed inset-0 z-[9999] flex items-center justify-center p-4 opacity-0 transition-opacity duration-300" style="background-color: rgba(0, 0, 0, 0.8); backdrop-filter: blur(5px);">
            <div class="solid-card relative z-10 w-full max-w-sm p-6 sm:p-8 space-y-4 text-center transform scale-95 transition-transform duration-300 shadow-2xl">
                <div class="mx-auto w-16 h-16 rounded-full bg-[var(--bg-main)] border border-custom flex items-center justify-center mb-2 shadow-inner">
                    <i data-lucide="shield-alert" class="w-8 h-8 text-danger"></i>
                </div>
                <h3 class="text-lg font-extrabold text-primary uppercase tracking-wider">${title}</h3>
                <p class="text-sm text-secondary leading-relaxed">${message}</p>
                <div class="pt-4">
                    <button id="revoke-modal-btn" class="btn-primary w-full py-3 rounded-lg text-xs font-bold uppercase tracking-wider shadow-md flex justify-center items-center gap-2">
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
        modal.classList.remove('opacity-0');
        modal.classList.add('opacity-100');
        modalBox.classList.remove('scale-95');
        modalBox.classList.add('scale-100');
    });

    btn.addEventListener('click', async () => {
        btn.innerHTML = '<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i> Logging out...';
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

    supabaseClient.channel('global-device-revocation-' + userEmail)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, async (payload) => {
            if (payload.eventType === 'DELETE') {
                if (payload.old && payload.old.email === userEmail) {
                    showRevokeModal("Account Deleted", "Your account has been permanently removed.");
                }
                return;
            }

            const updatedProfile = payload.new;
            if (!updatedProfile || updatedProfile.email !== userEmail) return;

            const activeDevices = updatedProfile.active_devices || [];
            if (!activeDevices.includes(currentDeviceId)) {
                if (sessionStorage.getItem('is_signing_out') === 'true') return;
                showRevokeModal("Session Revoked", "Your device session was disconnected by the administrator.");
            }
        })
        .subscribe();
}

async function executeForceLogout() {
    if (window.supabaseClient) {
        await window.supabaseClient.auth.signOut();
    }

    localStorage.clear();
    sessionStorage.clear();

    const currentPath = window.location.pathname;
    let pathToRoot = '../../index.html';

    if (currentPath.includes('/student/') || currentPath.includes('/admin/')) {
        pathToRoot = '../../index.html';
    } else if (currentPath.includes('/assets/')) {
        pathToRoot = '../../index.html';
    }

    window.location.replace(pathToRoot);
}

// ==========================================
// 3. STUDENT REAL-TIME STAGE SYNC
// ==========================================
function setupStudentRealtimeStageSync() {
    const userEmail = localStorage.getItem('pia_user_email');
    const userRole = localStorage.getItem('pia_user_role');

    if (!userEmail || !window.supabaseClient || userRole === 'admin') return;

    window.supabaseClient
        .channel('student-stage-sync-' + userEmail.replace(/[@.]/g, '_'))
        .on('postgres_changes', {
            event: 'UPDATE',
            schema: 'public',
            table: 'profiles',
            filter: `email=eq.${userEmail}`
        }, (payload) => {
            const updatedProfile = payload.new;
            if (!updatedProfile || !updatedProfile.current_stage || updatedProfile.role === 'admin') return;

            const stage = updatedProfile.current_stage;
            const currentPath = window.location.pathname;

            if (stage === 'OCEAN' && !currentPath.includes('ocean-test.html')) window.location.replace('ocean-test.html');
            else if (stage === 'Character Selection' && !currentPath.includes('character-selection.html')) window.location.replace('character-selection.html');
            else if (stage === 'Tutoring Dashboard' && !currentPath.includes('student-dashboard.html')) window.location.replace('student-dashboard.html');
            else if (stage === 'Waiting Room' && !currentPath.includes('waiting-room.html')) window.location.replace('waiting-room.html');
        })
        .subscribe();
}

// ==========================================
// 4. EVENT LISTENERS
// ==========================================
document.addEventListener("DOMContentLoaded", () => {
    validateDeviceOnLoad();
    watchDeviceSession();
    setupStudentRealtimeStageSync();
});