/**
 * ============================================================================
 * PIA SYSTEM: ADMIN DASHBOARD CONTROLLER
 * ============================================================================
 * This file handles all administrative functions, real-time database tracking,
 * student/professor roster management, device limits, and system configurations.
 * ============================================================================
 */

// ==========================================
// 1. GLOBAL STATE & INITIALIZATION
// ==========================================

let currentActiveSection = '';
let currentManagingEmail = '';
let currentAdminEmail = '';

// Unified Roster States
let studentDataCache = [];
let stateGroupFilter = 'all';
let stateSubgroupFilter = 'all';
let stateStageDrilldown = null;

// UI State Persistence
const uiState = {
    tab: sessionStorage.getItem('activeTab') || 'sections',
    modal: JSON.parse(sessionStorage.getItem('activeModal')) || null
};

// fully working
document.addEventListener("DOMContentLoaded", async () => {
    lucide.createIcons();

    // 🔥 MOBILE MENU FIX: Isolated to prevent const 'btn' conflict with function.js
    const hamburgerBtn = document.getElementById('mobile-toggle');
    const mobileBg = document.getElementById('menu-backdrop');

    if (hamburgerBtn && mobileBg) {
        hamburgerBtn.addEventListener('click', toggleMobileMenu);
        mobileBg.addEventListener('click', toggleMobileMenu);

        document.addEventListener('click', (e) => {
            const dynCloseGlobal = document.getElementById('dynamic-close-btn');
            if (dynCloseGlobal && (e.target === dynCloseGlobal || dynCloseGlobal.contains(e.target))) {
                toggleMobileMenu(e);
            }
        });
    }

    const email = localStorage.getItem('pia_user_email');

    // 🚨 STRICT AUTHORIZATION GUARD
    if (email && typeof sb !== 'undefined') {
        const { data: profile, error } = await sb.from('profiles')
            .select('role')
            .eq('email', email)
            .maybeSingle();

        if (error || !profile || profile.role !== 'admin') {
            localStorage.removeItem('pia_user_email');
            window.location.replace('../../index.html');
            return;
        }
    } else if (!email) {
        window.location.replace('../../index.html');
        return;
    }

    await Promise.all([
        initAdminProfile(),
        loadSections(),
        loadStudents(),
        loadProfessors(),
        loadSettings(),
        checkSuperAdmin()
    ]);

    restoreUIState();
    setupRealtimeSubscriptions();

    if (email) {
        currentAdminEmail = email;
        loadAdminDeviceSettings(email);
    }
});


// ==========================================
// 2. REALTIME TRACKING & TIMERS
// ==========================================

// fully working
function setupRealtimeSubscriptions() {
    sb.channel('admin-realtime-profiles')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, (payload) => {
            loadStudents();
            loadSections();

            const modalEmailEl = document.getElementById('device-modal-email');
            if (modalEmailEl && payload.new && modalEmailEl.textContent === payload.new.email) {
                renderDeviceList(payload.new.active_devices || []);
            }

            if (currentAdminEmail && payload.new && currentAdminEmail === payload.new.email) {
                loadAdminDeviceSettings(currentAdminEmail);
            }
        })
        .subscribe();
}

// fully working
function calculateDuration(startedAt) {
    if (!startedAt) return 'Not Started';
    const start = new Date(startedAt);
    const now = new Date();
    const diffMs = now - start;
    if (diffMs < 0) return 'Just started';

    const diffHrs = Math.floor(diffMs / (1000 * 60 * 60));
    const diffMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
    const diffSecs = Math.floor((diffMs % (1000 * 60)) / 1000);

    if (diffHrs > 0) return `${diffHrs}h ${diffMins}m ${diffSecs}s`;
    if (diffMins > 0) return `${diffMins}m ${diffSecs}s`;
    return `${diffSecs}s`;
}

// fully working
setInterval(() => {
    document.querySelectorAll('tr[data-started-at]').forEach(tr => {
        const startedAt = tr.getAttribute('data-started-at');
        const durationEl = tr.querySelector('.student-duration');
        if (durationEl && startedAt) {
            durationEl.textContent = calculateDuration(startedAt);
        }
    });
}, 1000);


// ==========================================
// 3. CORE UI & UTILITY FUNCTIONS
// ==========================================

// fully working
function cleanupGhostMenus() {
    document.querySelectorAll('body > .action-menu, body > [id^="menu-"]').forEach(menu => {
        if (menu.id !== 'menu-backdrop' && menu.id !== 'mobile-menu') {
            menu.remove();
        }
    });
}

// fully working
function toggleMobileMenu(event) {
    // Prevent the click from bubbling up and triggering closeAllMenus()
    if (event && event.stopPropagation) event.stopPropagation();

    const menu = document.querySelector('#mobile-menu');
    const backdrop = document.getElementById('menu-backdrop');
    if (menu && backdrop) {
        menu.classList.toggle('translate-x-full');
        menu.classList.toggle('translate-x-0');
        backdrop.classList.toggle('hidden');

        const isOpen = !menu.classList.contains('translate-x-full');
        document.body.style.overflow = isOpen ? 'hidden' : '';
        document.documentElement.style.overflow = isOpen ? 'hidden' : '';

        const dynClose = document.getElementById('dynamic-close-btn');
        if (dynClose) {
            dynClose.classList.toggle('opacity-0', !isOpen);
            dynClose.classList.toggle('opacity-100', isOpen);
        }
    }
}

// fully working
function restoreUIState() {
    switchTab(uiState.tab);
}

// fully working
function switchTab(tabName) {
    sessionStorage.setItem('activeTab', tabName);
    ['sections', 'students', 'professors', 'controls', 'settings'].forEach(t => {
        const el = document.getElementById(`view-${t}`);
        if (el) el.style.display = 'none';

        const navBtn = document.getElementById(`nav-${t}`);
        if (navBtn) navBtn.className = "admin-nav-btn inactive";

        const mobBtn = document.getElementById(`mob-nav-${t}`);
        if (mobBtn) mobBtn.className = "mobile-nav-link admin-nav-btn text-left block inactive";
    });

    const activeView = document.getElementById(`view-${tabName}`);
    if (activeView) activeView.style.display = 'block';

    const activeBtn = document.getElementById(`nav-${tabName}`);
    if (activeBtn) activeBtn.className = "admin-nav-btn active";

    const activeMobBtn = document.getElementById(`mob-nav-${tabName}`);
    if (activeMobBtn) activeMobBtn.className = "mobile-nav-link admin-nav-btn text-left block active";
}

// fully working
function toggleActionMenu(event, safeId) {
    event.stopPropagation();
    const btn = event.currentTarget;
    const targetMenu = document.getElementById('menu-' + safeId);
    const isOpen = targetMenu && targetMenu.classList.contains('show-menu');
    closeAllMenus();

    if (targetMenu && !isOpen) {
        document.body.appendChild(targetMenu);
        targetMenu.classList.remove('hidden');
        targetMenu.classList.add('show-menu');

        const rect = btn.getBoundingClientRect();
        targetMenu.style.position = 'fixed';
        targetMenu.style.zIndex = '999999';

        const menuWidth = targetMenu.offsetWidth || 220;
        let leftPos = rect.right - menuWidth;
        if (leftPos < 10) leftPos = 10;

        let topPos = rect.bottom + 4;
        const menuHeight = targetMenu.offsetHeight || 200;
        if (topPos + menuHeight > window.innerHeight) topPos = rect.top - menuHeight - 4;

        targetMenu.style.top = topPos + 'px';
        targetMenu.style.left = leftPos + 'px';
    }
}

// fully working
function closeAllMenus() {
    document.querySelectorAll('.action-menu, [id^="menu-"]').forEach(m => {
        // 🔥 FIX: Prevent this function from accidentally closing the mobile background
        if (m.id === 'menu-backdrop' || m.id === 'mobile-menu') return;

        m.classList.add('hidden');
        m.classList.remove('show-menu');
    });
}
window.addEventListener('click', closeAllMenus);


// ==========================================
// 4. MODALS & POPUPS
// ==========================================

// fully working
function openModal(id) {
    const modal = document.getElementById(id);
    const content = document.getElementById(id + '-content');
    if (modal) modal.classList.add('modal-active');
    if (content) content.classList.add('modal-content-active');
}

// fully working
function closeModal(id) {
    const modal = document.getElementById(id);
    const content = document.getElementById(id + '-content');
    if (modal) modal.classList.remove('modal-active');
    if (content) content.classList.remove('modal-content-active');
}

// fully working
function showCustomAlert(title, message, type = 'info') {
    document.getElementById('alert-title').textContent = title;
    document.getElementById('alert-message').textContent = message;

    const icon = document.getElementById('alert-icon');
    if (type === 'error') {
        icon.setAttribute('data-lucide', 'alert-circle');
        icon.className = 'w-6 h-6 text-danger';
    } else if (type === 'success') {
        icon.setAttribute('data-lucide', 'check-circle');
        icon.className = 'w-6 h-6 text-accent';
    } else {
        icon.setAttribute('data-lucide', 'info');
        icon.className = 'w-6 h-6 text-info';
    }
    lucide.createIcons();
    openModal('custom-alert');
}

// fully working
function closeCustomAlert() {
    closeModal('custom-alert');
}

let currentConfirmCallback = null;

// fully working
function showCustomConfirm(title, message, onConfirm) {
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-message').textContent = message;
    currentConfirmCallback = onConfirm;
    openModal('custom-confirm');
}

// fully working
function closeCustomConfirm() {
    closeModal('custom-confirm');
    currentConfirmCallback = null;
}

// fully working
document.getElementById('confirm-yes-btn').addEventListener('click', () => {
    if (currentConfirmCallback) currentConfirmCallback();
    closeCustomConfirm();
});


// ==========================================
// 5. STUDENT ROSTER & FILTER MANAGEMENT
// ==========================================

// fully working
async function loadStudents() {
    const { data, error } = await sb.from('profiles').select('*');
    if (error) return console.error('Error loading profiles:', error);

    studentDataCache = data.filter(student => (student.role || '').toLowerCase() !== 'admin');
    updateStageCounters();
    renderUnifiedTable();
}

// fully working
function updateStageCounters() {
    let counts = { 'OCEAN': 0, 'Character Selection': 0, 'Tutoring Dashboard': 0, 'Active Game': 0 };

    studentDataCache.forEach(student => {
        const stage = student.current_stage || '';
        const inGame = student.is_in_game || false;

        if (inGame) counts['Active Game']++;
        else if (counts[stage] !== undefined) counts[stage]++;
    });

    document.getElementById('count-ocean').textContent = counts['OCEAN'];
    document.getElementById('count-char').textContent = counts['Character Selection'];
    document.getElementById('count-dash').textContent = counts['Tutoring Dashboard'];
    document.getElementById('count-game').textContent = counts['Active Game'];
    lucide.createIcons();
}

// fully working
function setGroupFilter(group) {
    stateGroupFilter = group;
    ['all', 'experimental', 'control'].forEach(g => {
        const btn = document.getElementById(`filter-group-${g}`);
        if (btn) btn.className = (g === group) ? "admin-nav-btn active" : "admin-nav-btn inactive";
    });

    const secContainer = document.getElementById('secondary-filter-container');
    if (group === 'experimental') {
        secContainer.classList.remove('hidden');
        setSubgroupFilter('all');
    } else {
        secContainer.classList.add('hidden');
        stateSubgroupFilter = 'all';
    }
    renderUnifiedTable();
}

// fully working
function setSubgroupFilter(subgroup) {
    stateSubgroupFilter = subgroup;
    ['all', 'assigned', 'non-assigned', 'neutral'].forEach(sub => {
        const btn = document.getElementById(`filter-sub-${sub}`);
        if (btn) {
            btn.className = (sub === subgroup)
                ? "px-3 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-[var(--bg-hover)] text-accent border border-accent transition-colors"
                : "px-3 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-[var(--bg-main)] text-secondary border border-custom hover:text-primary transition-colors";
        }
    });
    renderUnifiedTable();
}

// fully working
function toggleStageDrilldown(stage) {
    stateStageDrilldown = stage;
    document.getElementById('nested-filters-container').classList.add('hidden');
    document.getElementById('btn-clear-drilldown').classList.remove('hidden');

    const titleEl = document.getElementById('table-view-title');
    const descEl = document.getElementById('table-view-desc');

    ['ocean', 'char', 'dash', 'game'].forEach(box => {
        document.getElementById(`box-${box}`).classList.remove('border-accent', 'border-info', 'border-warning', 'border-success', 'bg-[var(--bg-hover)]');
    });

    if (stage === 'OCEAN') {
        titleEl.innerHTML = `<i data-lucide="brain" class="w-5 h-5 text-accent"></i> OCEAN Test Live View`;
        descEl.textContent = "Monitoring students currently taking the Big Five Personality Inventory.";
        document.getElementById('box-ocean').classList.add('border-accent', 'bg-[var(--bg-hover)]');
    } else if (stage === 'Character Selection') {
        titleEl.innerHTML = `<i data-lucide="users" class="w-5 h-5 text-info"></i> Character Select Live View`;
        descEl.textContent = "Monitoring Non-Assigned subgroup choosing their persona.";
        document.getElementById('box-char').classList.add('border-info', 'bg-[var(--bg-hover)]');
    } else if (stage === 'Tutoring Dashboard') {
        titleEl.innerHTML = `<i data-lucide="layout-dashboard" class="w-5 h-5 text-warning"></i> Dashboard Live View`;
        descEl.textContent = "Students browsing the main tutoring dashboard.";
        document.getElementById('box-dash').classList.add('border-warning', 'bg-[var(--bg-hover)]');
    } else if (stage === 'Active Game') {
        titleEl.innerHTML = `<i data-lucide="gamepad-2" class="w-5 h-5 text-success"></i> Active Session Live View`;
        descEl.textContent = "Students actively solving math problems. Tracking Decision Tree metrics.";
        document.getElementById('box-game').classList.add('border-success', 'bg-[var(--bg-hover)]');
    }
    renderUnifiedTable();
}

// fully working
function clearStageDrilldown() {
    stateStageDrilldown = null;
    document.getElementById('nested-filters-container').classList.remove('hidden');
    document.getElementById('btn-clear-drilldown').classList.add('hidden');
    document.getElementById('table-view-title').innerHTML = `<i data-lucide="users" class="w-5 h-5 text-accent"></i> General Student Roster`;
    document.getElementById('table-view-desc').textContent = "Click any student row to view full-screen profile and alignment metrics.";

    ['ocean', 'char', 'dash', 'game'].forEach(box => {
        document.getElementById(`box-${box}`).classList.remove('border-accent', 'border-info', 'border-warning', 'border-success', 'bg-[var(--bg-hover)]');
    });
    renderUnifiedTable();
}

// fully working
function renderUnifiedTable() {
    cleanupGhostMenus();

    const thead = document.getElementById('unified-thead');
    const tbody = document.getElementById('unified-tbody');
    const searchQuery = (document.getElementById('search-student') ? document.getElementById('search-student').value.toLowerCase() : '');

    thead.innerHTML = '';
    tbody.innerHTML = '';

    if (stateStageDrilldown === null) {
        thead.innerHTML = `
            <tr>
                <th class="w-[20%]">Student Name</th>
                <th class="w-[18%]">Email Address</th>
                <th class="w-[10%]">Section</th>
                <th class="w-[10%]">Group</th>
                <th class="w-[14%]">Persona Setup</th>
                <th class="w-[12%]">Current Stage</th>
                <th class="w-[8%]">Pre-Test</th>
                <th class="w-[8%] text-right">Actions</th>
            </tr>
        `;
    } else if (stateStageDrilldown === 'Active Game') {
        thead.innerHTML = `
            <tr>
                <th class="w-[20%]">Student Name</th>
                <th class="w-[15%]">Current Problem</th>
                <th class="w-[12%]">Difficulty</th>
                <th class="w-[10%]">Hints Used</th>
                <th class="w-[15%]">Consecutive Correct</th>
                <th class="w-[15%]">Duration</th>
                <th class="w-[13%] text-right">Actions</th>
            </tr>
        `;
    } else {
        thead.innerHTML = `
            <tr>
                <th class="w-[25%]">Student Name</th>
                <th class="w-[15%]">Section</th>
                <th class="w-[25%]">Current Activity</th>
                <th class="w-[20%]">Time Elapsed</th>
                <th class="w-[15%] text-right">Actions</th>
            </tr>
        `;
    }

    const filteredData = studentDataCache.filter(student => {
        const matchesSearch = student.full_name.toLowerCase().includes(searchQuery) || student.email.toLowerCase().includes(searchQuery);
        if (!matchesSearch) return false;

        const groupRaw = (student.group_type || '').toLowerCase();
        const inGame = student.is_in_game || false;
        const isOnline = (student.active_devices || []).length > 0;

        if (stateStageDrilldown !== null) {
            if (!isOnline) return false;
            if (stateStageDrilldown === 'Active Game' && inGame) return true;
            if (stateStageDrilldown !== 'Active Game' && student.current_stage === stateStageDrilldown && !inGame) return true;
            return false;
        }

        if (stateGroupFilter === 'experimental' && groupRaw !== 'assigned' && groupRaw !== 'non-assigned' && groupRaw !== 'neutral') return false;
        if (stateGroupFilter === 'control' && groupRaw !== 'control') return false;
        if (stateGroupFilter === 'experimental' && stateSubgroupFilter !== 'all' && groupRaw !== stateSubgroupFilter) return false;

        return true;
    });

    if (filteredData.length === 0) {
        tbody.innerHTML = `<tr><td colspan="10" class="text-center py-10 text-secondary text-xs">No students match the current filters.</td></tr>`;
        lucide.createIcons();
        return;
    }

    filteredData.forEach(student => {
        const tr = document.createElement('tr');
        tr.className = "hover:bg-[var(--bg-hover)] transition-colors cursor-pointer student-row";
        tr.setAttribute('data-started-at', student.stage_started_at || '');

        const safeEmailId = student.email.replace(/[@.]/g, '_');
        const isOnline = (student.active_devices || []).length > 0;
        const statusClass = isOnline ? 'status-dot-active' : 'status-dot-offline';

        tr.onclick = () => {
            openStudentProfile(
                student.full_name, student.email, student.section || 'N/A', student.group_type || 'N/A',
                isOnline ? 'Online' : 'Offline', student.max_devices ?? 1,
                student.pre_test_score ?? 'n/a', student.post_test_score ?? 'n/a',
                student.ocean_o ?? 'n/a', student.ocean_c ?? 'n/a', student.ocean_e ?? 'n/a', student.ocean_a ?? 'n/a', student.ocean_n ?? 'n/a'
            );
        };

        const actionMenuHTML = `
            <td class="py-3 px-3 text-right relative action-cell" onclick="event.stopPropagation()">
                <button class="action-toggle-btn p-1.5 rounded-lg bg-[var(--bg-main)] border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-primary transition-colors" onclick="toggleActionMenu(event, '${safeEmailId}')">
                    <i data-lucide="more-vertical" class="w-3.5 h-3.5"></i>
                </button>
                <div id="menu-${safeEmailId}" class="action-menu hidden absolute right-0 w-56 bg-[var(--bg-card)] p-1.5 shadow-2xl rounded-xl border border-[var(--border-color)] space-y-1 text-left z-50">
                    <button onclick="sendActivationEmail('${student.email}'); closeAllMenus();" class="w-full px-3 py-2 rounded-xs text-xs text-left text-[var(--text-primary)] hover:bg-[var(--bg-hover)] flex items-center gap-2">
                        <i data-lucide="mail" class="w-3.5 h-3.5 text-info"></i> Send Activation Email
                    </button>
                    <button onclick="openEditStudent('${student.full_name}', '${student.email}', '${student.section || ''}', '${student.pre_test_score ?? ''}', '${student.group_type}', ${student.max_devices ?? 1}); closeAllMenus();" class="w-full px-3 py-2 rounded-xs text-xs text-left text-[var(--text-primary)] hover:bg-[var(--bg-hover)] flex items-center gap-2">
                        <i data-lucide="edit-3" class="w-3.5 h-3.5 icon-edit"></i> Edit Details
                    </button>
                    <button onclick="openDeviceManager('${student.email}'); closeAllMenus();" class="w-full px-3 py-2 rounded-xs text-xs text-left text-[var(--text-primary)] hover:bg-[var(--bg-hover)] flex items-center gap-2">
                        <i data-lucide="monitor" class="w-3.5 h-3.5 text-accent"></i> Active Devices
                    </button>
                    <div class="border-t border-[var(--border-color)] my-1"></div>
                    <button onclick="allowStudentRetakeOcean('${student.email}'); closeAllMenus();" class="w-full px-3 py-2 rounded-xs text-xs text-left text-[var(--text-primary)] hover:bg-[var(--bg-hover)] flex items-center gap-2">
                        <i data-lucide="rotate-ccw" class="w-3.5 h-3.5 text-warning"></i> Retake OCEAN Test
                    </button>
                    <button onclick="allowStudentRetakeCharacter('${student.email}'); closeAllMenus();" class="w-full px-3 py-2 rounded-xs text-xs text-left text-[var(--text-primary)] hover:bg-[var(--bg-hover)] flex items-center gap-2">
                        <i data-lucide="user-cog" class="w-3.5 h-3.5 text-accent"></i> Retake Char Select
                    </button>
                    <button onclick="resetPasswordFromMenu('${student.email}'); closeAllMenus();" class="w-full px-3 py-2 rounded-xs text-xs text-left text-[var(--text-primary)] hover:bg-[var(--bg-hover)] flex items-center gap-2">
                        <i data-lucide="key" class="w-3.5 h-3.5 icon-reset"></i> Reset Password
                    </button>
                    <div class="border-t border-[var(--border-color)] my-1"></div>
                    <button onclick="deleteUserFromMenu('${student.email}', 'profiles'); closeAllMenus();" class="w-full px-3 py-2 rounded-xs text-xs text-left action-delete hover:bg-[var(--color-danger-bg)] flex items-center gap-2">
                        <i data-lucide="trash-2" class="w-3.5 h-3.5"></i> Delete User
                    </button>
                </div>
            </td>
        `;

        if (stateStageDrilldown === null) {
            let groupLabel = student.group_type?.toLowerCase() === 'control' ? 'CTRL' : 'EXP';
            let groupColor = groupLabel === 'CTRL' ? 'text-info' : 'text-accent';
            let personaSetup = groupLabel === 'EXP'
                ? (student.group_type === 'assigned' ? 'Assigned' : student.group_type === 'non-assigned' ? 'Free Choice' : student.group_type === 'neutral' ? 'Neutral' : 'N/A')
                : 'Traditional';

            tr.innerHTML = `
                <td class="py-3 px-3 font-medium text-primary text-xs flex items-center gap-2.5">
                    <div class="relative flex items-center justify-center shrink-0">
                        <div class="w-6 h-6 rounded-full bg-[var(--bg-main)] border border-[var(--border-color)] flex items-center justify-center ${groupColor}"><i data-lucide="${groupLabel === 'CTRL' ? 'book' : 'user'}" class="w-3 h-3"></i></div>
                        <span class="status-dot absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full border border-card ${statusClass}"></span>
                    </div>
                    <span class="truncate">${student.full_name}</span>
                </td>
                <td class="py-3 px-3 font-mono text-secondary text-[10px] truncate">${student.email}</td>
                <td class="py-3 px-3 text-secondary text-xs truncate">${student.section || 'N/A'}</td>
                <td class="py-3 px-3 font-bold ${groupColor} text-[10px] uppercase tracking-wider">${groupLabel}</td>
                <td class="py-3 px-3 text-secondary text-[10px] uppercase tracking-wider truncate">${personaSetup}</td>
                <td class="py-3 px-3 font-medium text-primary text-xs truncate">${student.current_stage || 'Idle'}</td>
                <td class="py-3 px-3 font-mono text-primary text-xs">${student.pre_test_score ?? 'n/a'}</td>
                ${actionMenuHTML}
            `;
        } else if (stateStageDrilldown === 'Active Game') {
            const duration = calculateDuration(student.stage_started_at);
            tr.innerHTML = `
                <td class="py-3 px-3 font-medium text-primary text-xs flex items-center gap-2.5">
                    <div class="w-6 h-6 rounded-full bg-[var(--bg-main)] border border-[var(--border-color)] flex items-center justify-center text-success"><i data-lucide="gamepad-2" class="w-3 h-3"></i></div>
                    <span class="truncate">${student.full_name}</span>
                </td>
                <td class="py-3 px-3 font-mono text-secondary text-xs truncate">Question ${student.current_problem || '1'}</td>
                <td class="py-3 px-3 font-bold text-info text-xs uppercase tracking-wider">${student.current_difficulty || 'Normal'}</td>
                <td class="py-3 px-3 font-mono text-warning text-xs font-bold">${student.hints_used || 0}</td>
                <td class="py-3 px-3 font-mono text-success text-xs font-bold">${student.consecutive_correct || 0}</td>
                <td class="py-3 px-3 font-mono text-primary text-xs student-duration">${duration}</td>
                ${actionMenuHTML}
            `;
        } else {
            const duration = calculateDuration(student.stage_started_at);
            let activity = "Reading Instructions";
            if (stateStageDrilldown === 'OCEAN') activity = `Answering Item ${student.ocean_current_item || 1}/50`;
            if (stateStageDrilldown === 'Character Selection') activity = `Browsing Personas`;
            if (stateStageDrilldown === 'Tutoring Dashboard') activity = `Browsing Dashboard`;

            tr.innerHTML = `
                <td class="py-3 px-3 font-medium text-primary text-xs flex items-center gap-2.5">
                    <span class="status-dot w-2 h-2 rounded-full ${statusClass}"></span>
                    <span class="truncate">${student.full_name}</span>
                </td>
                <td class="py-3 px-3 text-secondary text-xs truncate">${student.section || 'N/A'}</td>
                <td class="py-3 px-3 font-bold text-accent text-xs truncate">${activity}</td>
                <td class="py-3 px-3 font-mono text-primary text-xs student-duration">${duration}</td>
                ${actionMenuHTML}
            `;
        }

        tbody.appendChild(tr);
    });
    lucide.createIcons();
}


// ==========================================
// 6. STUDENT PROFILE OVERLAYS & FORMS
// ==========================================

// fully working
function openStudentProfile(name, email, section, type, status, maxDevices, pre, post, o, c, e, a, n) {
    document.getElementById('profile-name').textContent = name;
    document.getElementById('profile-email').textContent = email;
    document.getElementById('profile-section').textContent = section;
    document.getElementById('profile-type').textContent = type;
    document.getElementById('profile-device-limit').textContent = maxDevices;
    document.getElementById('profile-pre').textContent = pre;
    document.getElementById('profile-post').textContent = post;

    document.getElementById('profile-ocean-o').textContent = o;
    document.getElementById('profile-ocean-c').textContent = c;
    document.getElementById('profile-ocean-e').textContent = e;
    document.getElementById('profile-ocean-a').textContent = a;
    document.getElementById('profile-ocean-n').textContent = n;

    let dominantTraits = ['Openness'];
    if (o !== 'n/a' && o !== 'undefined') {
        const scores = { 'Openness': parseFloat(o) || 0, 'Conscientiousness': parseFloat(c) || 0, 'Extroversion': parseFloat(e) || 0, 'Agreeableness': parseFloat(a) || 0, 'Neuroticism': parseFloat(n) || 0 };
        let maxScore = -1; dominantTraits = [];
        for (const [trait, score] of Object.entries(scores)) {
            if (score > maxScore) { maxScore = score; dominantTraits = [trait]; }
            else if (score === maxScore) dominantTraits.push(trait);
        }
    }

    document.getElementById('profile-persona-badge').textContent = `${dominantTraits.join(' & ')} Persona`;
    document.getElementById('student-profile-screen').classList.remove('hidden');
    document.getElementById('student-profile-screen').classList.add('flex');
    document.body.style.overflow = 'hidden';
}

// fully working
function closeStudentProfile() {
    document.getElementById('student-profile-screen').classList.add('hidden');
    document.getElementById('student-profile-screen').classList.remove('flex');
    document.body.style.overflow = 'auto';
}

// fully working
function toggleAvatarVisibility() {
    const container = document.getElementById('avatar-container');
    const btn = document.getElementById('toggle-avatar-btn');
    if (container.classList.contains('hidden')) {
        container.classList.remove('hidden');
        btn.textContent = 'Hide Image';
    } else {
        container.classList.add('hidden');
        btn.textContent = 'Show Image';
    }
}

// fully working
async function handleRegisterStudent(event) {
    event.preventDefault();

    const first = document.getElementById('add-first-name').value.trim();
    const middle = document.getElementById('add-middle-name').value.trim();
    const last = document.getElementById('add-last-name').value.trim();
    const full_name = [first, middle, last].filter(Boolean).join(' ');

    const email = document.getElementById('student-email').value;
    const section = document.getElementById('student-section').value;
    const group_type = document.getElementById('student-type').value;
    const pretest = document.getElementById('student-pretest').value;
    const pre_test_score = pretest ? parseFloat(pretest) : null;
    const max_devices = parseInt(document.getElementById('student-device-limit').value) || 1;
    const defaultPass = document.getElementById('global-default-pass')?.value || 'PIA2026!';

    const { error: authError } = await sb.rpc('admin_create_auth_user', {
        target_email: email,
        default_password: defaultPass
    });

    if (authError) return showCustomAlert("Auth Error", authError.message, "error");

    const { error } = await sb.from('profiles').insert([{
        full_name, email, section, group_type, pre_test_score, max_devices, status: 'inactive'
    }]);

    if (error) return showCustomAlert("Registration Error", error.message, "error");

    document.getElementById('add-student-form').reset();
    closeModal('add-student-modal');
    loadStudents();
    showCustomAlert("Registration Success", `${full_name} added to roster (Inactive until emailed).`, "success");
}

// fully working
function openEditStudent(fullName, email, section, pretest, type, maxDevices) {
    const nameParts = fullName.trim().split(' ');
    let first = nameParts[0] || '', middle = '', last = '';
    if (nameParts.length === 2) last = nameParts[1];
    else if (nameParts.length > 2) { last = nameParts[nameParts.length - 1]; middle = nameParts.slice(1, -1).join(' '); }

    document.getElementById('edit-student-original-email').value = email;
    document.getElementById('edit-first-name').value = first;
    document.getElementById('edit-middle-name').value = middle;
    document.getElementById('edit-last-name').value = last;
    document.getElementById('edit-student-email-input').value = email;
    document.getElementById('edit-student-section').value = section;
    document.getElementById('edit-student-pretest').value = pretest;
    document.getElementById('edit-student-type').value = type;
    document.getElementById('edit-student-device-limit').value = maxDevices || 1;

    openModal('edit-student-modal');
}

// fully working
async function handleUpdateStudent(event) {
    event.preventDefault();
    const originalEmail = document.getElementById('edit-student-original-email').value;

    const first = document.getElementById('edit-first-name').value.trim();
    const middle = document.getElementById('edit-middle-name').value.trim();
    const last = document.getElementById('edit-last-name').value.trim();
    const full_name = [first, middle, last].filter(Boolean).join(' ');

    const email = document.getElementById('edit-student-email-input').value;
    const section = document.getElementById('edit-student-section').value;
    const pre_test_val = document.getElementById('edit-student-pretest').value;
    const pre_test_score = pre_test_val ? parseFloat(pre_test_val) : null;
    const group_type = document.getElementById('edit-student-type').value;
    const max_devices = parseInt(document.getElementById('edit-student-device-limit').value) || 1;

    const { error } = await sb.from('profiles').update({
        full_name, email, section, pre_test_score, group_type, max_devices
    }).eq('email', originalEmail);

    if (error) return showCustomAlert("Update Error", error.message, "error");

    closeModal('edit-student-modal');
    loadStudents();
    showCustomAlert("Update Success", `Student details updated successfully.`, "success");
}

// fully working
async function allowStudentRetakeOcean(email) {
    showCustomConfirm("Retake OCEAN Test", `Allow ${email} to retake OCEAN test?`, async () => {
        await sb.from('profiles').update({
            is_ocean_done: false, current_stage: 'OCEAN', stage_started_at: new Date().toISOString(),
            ocean_e: null, ocean_a: null, ocean_c: null, ocean_n: null, ocean_o: null
        }).eq('email', email);
        showCustomAlert("Success", `${email} can now retake OCEAN test.`, "success");
        loadStudents();
    });
}

// fully working
async function allowStudentRetakeCharacter(email) {
    showCustomConfirm("Retake Character Select", `Allow ${email} to re-select character?`, async () => {
        await sb.from('profiles').update({
            selected_character: null, current_stage: 'Character Selection', stage_started_at: new Date().toISOString()
        }).eq('email', email);
        showCustomAlert("Success", `${email} can now re-select character.`, "success");
        loadStudents();
    });
}


// ==========================================
// 7. SECTION & SCORES MANAGEMENT
// ==========================================

// fully working
async function loadSections() {
    const { data, error } = await sb.from('sections').select('*');
    if (error) return console.error('Error loading sections:', error);

    const grid = document.getElementById('sections-grid');
    grid.innerHTML = '';

    const sectionSelects = document.querySelectorAll('#student-section, #edit-student-section, #prof-section, #target-section-select');
    sectionSelects.forEach(select => { select.innerHTML = ''; });

    if (!data || data.length === 0) {
        grid.innerHTML = `<p class="text-xs text-[var(--text-secondary)] col-span-3">No sections found. Click "Add Section" to create one.</p>`;
        return;
    }

    for (const sec of data) {
        const name = sec.name;
        sectionSelects.forEach(select => {
            const option = document.createElement('option');
            option.value = name;
            option.textContent = name;
            select.appendChild(option);
        });

        const { data: profileData } = await sb.from('profiles').select('role').eq('section', name);
        const count = profileData ? profileData.filter(p => p.role !== 'admin').length : 0;

        const card = document.createElement('div');
        card.className = "solid-card p-6 space-y-5 cursor-pointer hover:border-[var(--accent-primary)] transition-all group";
        card.onclick = () => openSectionDetails(name);

        card.innerHTML = `
            <div class="flex justify-between items-center border-b border-[var(--border-color)] pb-4">
                <div class="flex items-center gap-3">
                    <h3 class="text-lg font-bold text-primary group-hover:text-[var(--accent-primary)] transition-colors">${name}</h3>
                    <span class="px-2.5 py-1 rounded-lg bg-[var(--bg-main)] text-[var(--text-secondary)] text-[10px] font-mono border border-[var(--border-color)]">${count} Enrolled</span>
                </div>
                <div class="flex items-center gap-2">
                    <span class="text-xs text-[var(--text-secondary)] flex items-center gap-1 group-hover:text-primary"><i data-lucide="chevron-right" class="w-4 h-4"></i></span>
                </div>
            </div>
            <div class="grid grid-cols-2 gap-3">
                <div class="bg-[var(--bg-main)] p-4 rounded-xl border border-[var(--border-color)] space-y-1 hover:border-[var(--accent-primary)] transition-colors" onclick="event.stopPropagation(); openScoresModal('${name}')">
                    <p class="text-[10px] uppercase tracking-widest text-[var(--text-secondary)] font-mono flex justify-between">Scores <i data-lucide="edit-2" class="w-3 h-3 text-[var(--accent-primary)]"></i></p>
                    <p class="text-primary text-xs font-medium pt-1">Input / View</p>
                </div>
                <div class="bg-[var(--bg-main)] p-4 rounded-xl border border-[var(--border-color)] space-y-1 cursor-pointer hover:border-[var(--accent-primary)] transition-colors" onclick="event.stopPropagation(); sendSectionEmails('${name}')">
                    <p class="text-[10px] uppercase tracking-widest text-[var(--text-secondary)] font-mono flex justify-between">Broadcast <i data-lucide="send" class="w-3 h-3 text-[var(--accent-primary)]"></i></p>
                    <p class="text-[var(--accent-primary)] text-xs font-bold pt-1">Email Roster</p>
                </div>
            </div>
        `;
        grid.appendChild(card);
    }
    lucide.createIcons();
}

// fully working
async function saveNewSection() {
    const name = document.getElementById('new-section-name').value.trim();
    if (!name) return showCustomAlert("Validation Error", "Please enter a section name.", "error");

    const { error } = await sb.from('sections').insert([{ name }]);
    if (error) return showCustomAlert("Creation Error", error.message, "error");

    document.getElementById('new-section-name').value = '';
    closeModal('add-section-modal');
    loadSections();
    showCustomAlert("Section Added", `Section ${name} created successfully!`, "success");
}

// fully working
async function openSectionDetails(sectionName) {
    currentActiveSection = sectionName;
    document.getElementById('modal-section-title').textContent = `Section: ${sectionName}`;

    const { data } = await sb.from('profiles').select('*').eq('section', sectionName);
    const studentsOnly = data ? data.filter(student => (student.role || '').toLowerCase() !== 'admin') : [];
    const tbody = document.getElementById('section-students-tbody');
    tbody.innerHTML = '';

    if (studentsOnly.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="py-8 text-center text-[var(--text-secondary)]">No students found in this section.</td></tr>`;
    } else {
        studentsOnly.forEach(student => {
            const safeEmailId = student.email.replace(/[@.]/g, '_');
            const tr = document.createElement('tr');
            tr.className = "hover:bg-[var(--bg-hover)] transition-colors cursor-pointer student-row";
            tr.onclick = () => { openStudentProfile(student.full_name, student.email, sectionName, student.group_type, student.status, student.max_devices ?? 1, student.pre_test_score ?? 'n/a', student.post_test_score ?? 'n/a', student.ocean_o ?? 'n/a', student.ocean_c ?? 'n/a', student.ocean_e ?? 'n/a', student.ocean_a ?? 'n/a', student.ocean_n ?? 'n/a'); };

            tr.innerHTML = `
                <td class="py-4 px-3 font-medium text-primary">${student.full_name}</td>
                <td class="py-4 px-3 text-secondary">${student.email}</td>
                <td class="py-4 px-3"><span class="px-3 py-1 rounded-md bg-[var(--bg-main)] border border-[var(--border-color)] text-[var(--accent-primary)] text-[10px] font-bold uppercase tracking-wider">${student.group_type}</span></td>
                <td class="py-4 px-3">
                    <div class="flex items-center gap-1.5">
                        <span class="w-2 h-2 rounded-full ${student.status === 'active' ? 'status-dot-active' : 'status-dot-inactive'}"></span>
                        <span class="text-[10px] uppercase tracking-wider text-[var(--text-secondary)]">${student.status === 'active' ? 'Active' : 'Inactive'}</span>
                    </div>
                </td>
                <td class="py-4 px-3 text-right relative" onclick="event.stopPropagation()">
                    <button onclick="toggleActionMenu(event, 'sec-${safeEmailId}')" class="p-2 rounded-lg bg-[var(--bg-main)] border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-primary transition-colors">
                        <i data-lucide="more-vertical" class="w-4 h-4"></i>
                    </button>
                    <div id="menu-sec-${safeEmailId}" onclick="event.stopPropagation()" class="hidden absolute w-44 bg-[var(--bg-card)] p-1.5 shadow-2xl rounded-xl border border-[var(--border-color)] space-y-1 text-left z-50">
                        <button onclick="sendActivationEmail('${student.email}'); closeAllMenus();" class="w-full px-3 py-2 rounded-xs text-xs text-left text-[var(--text-primary)] hover:bg-[var(--bg-hover)] flex items-center gap-2">
                            <i data-lucide="mail" class="w-3.5 h-3.5 text-info"></i> Send Email
                        </button>
                        <button onclick="openEditStudent('${student.full_name}', '${student.email}', '${student.section || ''}', '${student.pre_test_score ?? ''}', '${student.group_type}', ${student.max_devices ?? 1}); closeAllMenus();" class="w-full px-3 py-2.5 rounded-lg text-xs text-left text-[var(--text-primary)] hover:bg-[var(--bg-hover)] flex items-center gap-2 transition-all">
                            <i data-lucide="edit-3" class="w-3.5 h-3.5 icon-edit"></i> Edit Details
                        </button>
                        <button onclick="resetPasswordFromMenu('${student.email}'); closeAllMenus();" class="w-full px-3 py-2.5 rounded-lg text-xs text-left text-[var(--text-primary)] hover:bg-[var(--bg-hover)] flex items-center gap-2 transition-colors">
                            <i data-lucide="key" class="w-3.5 h-3.5 icon-reset"></i> Reset Password
                        </button>
                    </div>
                </td>
            `;
            tbody.appendChild(tr);
        });
        lucide.createIcons();
    }
    openModal('section-details-modal');
}

// fully working
async function openScoresModal(sectionName) {
    currentActiveSection = sectionName;
    document.getElementById('scores-modal-title').textContent = `Input Scores: ${sectionName}`;

    const { data } = await sb.from('profiles').select('*').eq('section', sectionName);
    const studentsOnly = data ? data.filter(student => (student.role || '').toLowerCase() !== 'admin') : [];
    const tbody = document.getElementById('scores-table-body');
    tbody.innerHTML = '';

    if (studentsOnly.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" class="py-8 text-center text-[var(--text-secondary)]">No students found in this section.</td></tr>`;
    } else {
        studentsOnly.forEach(student => {
            const tr = document.createElement('tr');
            tr.className = "hover:bg-[var(--bg-hover)] transition-colors";
            tr.innerHTML = `
                <td class="py-4 px-3 font-medium text-primary">${student.full_name}</td>
                <td class="py-4 px-3"><span class="px-3 py-1 rounded-md bg-[var(--bg-main)] border border-[var(--border-color)] text-[var(--text-secondary)] text-[10px] font-bold uppercase tracking-wider">${student.group_type}</span></td>
                <td class="py-4 px-3"><input type="number" step="0.1" class="score-pre w-full max-w-[120px] bg-[var(--bg-main)] border border-[var(--border-color)] rounded-xl px-4 py-2.5 h-[44px] text-sm text-primary input-focus font-mono" value="${student.pre_test_score ?? ''}" data-email="${student.email}"></td>
                <td class="py-4 px-3"><input type="number" step="0.1" class="score-post w-full max-w-[120px] bg-[var(--bg-main)] border border-[var(--border-color)] rounded-xl px-4 py-2.5 h-[44px] text-sm text-[var(--accent-primary)] font-bold input-focus font-mono" value="${student.post_test_score ?? ''}" data-email="${student.email}"></td>
            `;
            tbody.appendChild(tr);
        });
    }
    openModal('scores-modal');
}

// fully working
function openScoresModalFromDetails() {
    closeModal('section-details-modal');
    setTimeout(() => openScoresModal(currentActiveSection), 300);
}

// fully working
async function saveBatchScores() {
    const rows = document.querySelectorAll('#scores-table-body tr');
    for (const tr of rows) {
        const preInput = tr.querySelector('.score-pre');
        const postInput = tr.querySelector('.score-post');
        if (!preInput || !postInput) continue;

        const email = preInput.getAttribute('data-email');
        const pre_test_score = preInput.value !== '' ? parseFloat(preInput.value) : null;
        const post_test_score = postInput.value !== '' ? parseFloat(postInput.value) : null;

        await sb.from('profiles').update({ pre_test_score, post_test_score }).eq('email', email);
    }
    closeModal('scores-modal');
    showCustomAlert("Scores Updated", `Grades for ${currentActiveSection} have been saved successfully.`, "success");
}


// ==========================================
// 8. PROFESSOR MANAGEMENT
// ==========================================

// fully working
async function loadProfessors() {
    cleanupGhostMenus();

    const { data, error } = await sb.from('professors').select('*');
    if (error) return console.error('Error loading professors:', error);

    const tbody = document.getElementById('professor-table-body');
    const cardsContainer = document.getElementById('professor-cards-container');

    tbody.innerHTML = '';
    if (cardsContainer) cardsContainer.innerHTML = '';

    data.forEach(prof => {
        const safeEmailId = prof.email.replace(/[@.]/g, '_');

        // Desktop Row HTML
        const tr = document.createElement('tr');
        tr.className = "hover:bg-[var(--bg-hover)] transition-colors professor-row cursor-pointer";
        tr.onclick = () => { openProfessorProfile(prof.name, prof.email, prof.department, prof.assigned_section, prof.status); };

        tr.innerHTML = `
            <td class="py-4 px-4 font-medium text-primary prof-name flex items-center gap-3">
                <div class="w-8 h-8 rounded-full bg-[var(--bg-main)] border border-[var(--border-color)] flex items-center justify-center text-info">
                    <i data-lucide="shield-alert" class="w-4 h-4"></i>
                </div>
                ${prof.name}
            </td>
            <td class="py-4 px-4 text-secondary prof-email">${prof.email}</td>
            <td class="py-4 px-4 text-secondary">${prof.department}</td>
            <td class="py-4 px-4"><span class="px-3 py-1 rounded-md bg-[var(--bg-main)] border border-[var(--border-color)] text-info text-[10px] font-bold uppercase tracking-wider">${prof.assigned_section}</span></td>
            <td class="py-4 px-4">
                <div class="flex items-center gap-1.5">
                    <span class="w-2 h-2 rounded-full ${prof.status === 'active' ? 'status-dot-active' : 'status-dot-inactive'}"></span>
                    <span class="text-[10px] uppercase tracking-wider text-secondary">${prof.status === 'active' ? 'Active' : 'Inactive'}</span>
                </div>
            </td>
            <td class="py-4 px-4 text-right relative" onclick="event.stopPropagation()">
                <button onclick="toggleActionMenu(event, 'prof-${safeEmailId}')" class="p-2 rounded-lg bg-[var(--bg-main)] border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-primary transition-colors">
                    <i data-lucide="more-vertical" class="w-4 h-4"></i>
                </button>
                <div id="menu-prof-${safeEmailId}" onclick="event.stopPropagation()" class="hidden absolute w-44 bg-[var(--bg-card)] p-1.5 shadow-2xl rounded-xl border border-[var(--border-color)] space-y-1 text-left">
                    <button onclick="resetPasswordFromMenu('${prof.email}'); closeAllMenus();" class="w-full px-3 py-2.5 rounded-lg text-xs text-left text-[var(--text-primary)] hover:bg-[var(--bg-hover)] flex items-center gap-2 transition-all">
                        <i data-lucide="key" class="w-3.5 h-3.5 icon-reset"></i> Reset Password
                    </button>
                    <div class="border-t border-[var(--border-color)] my-1"></div>
                    <button onclick="deleteUserFromMenu('${prof.email}', 'professors'); closeAllMenus();" class="w-full px-3 py-2.5 rounded-lg text-xs text-left action-delete hover:bg-[var(--color-danger-bg)] flex items-center gap-2 transition-all">
                        <i data-lucide="trash-2" class="w-3.5 h-3.5"></i> Remove Faculty
                    </button>
                </div>
            </td>
        `;
        tbody.appendChild(tr);

        // Mobile Card HTML
        if (cardsContainer) {
            const card = document.createElement('div');
            card.className = "solid-card p-4 space-y-4 cursor-pointer professor-row hover:border-info transition-colors";
            card.onclick = () => { openProfessorProfile(prof.name, prof.email, prof.department, prof.assigned_section, prof.status); };

            card.innerHTML = `
                <div class="flex justify-between items-start">
                    <div class="flex items-center gap-3">
                        <div class="w-10 h-10 rounded-full bg-[var(--bg-main)] border border-[var(--border-color)] flex items-center justify-center text-info shrink-0">
                            <i data-lucide="shield-alert" class="w-5 h-5"></i>
                        </div>
                        <div>
                            <p class="font-bold text-primary text-sm">${prof.name}</p>
                            <p class="text-[10px] text-secondary font-mono">${prof.email}</p>
                        </div>
                    </div>
                    <div class="relative" onclick="event.stopPropagation()">
                        <button onclick="toggleActionMenu(event, 'prof-mob-${safeEmailId}')" class="p-1.5 rounded-lg bg-[var(--bg-main)] border border-[var(--border-color)] text-[var(--text-secondary)] hover:text-primary transition-colors">
                            <i data-lucide="more-vertical" class="w-4 h-4"></i>
                        </button>
                        <div id="menu-prof-mob-${safeEmailId}" class="hidden absolute right-0 w-44 bg-[var(--bg-card)] p-1.5 shadow-2xl rounded-xl border border-[var(--border-color)] space-y-1 text-left z-50">
                            <button onclick="resetPasswordFromMenu('${prof.email}'); closeAllMenus();" class="w-full px-3 py-2.5 rounded-lg text-xs text-left text-[var(--text-primary)] hover:bg-[var(--bg-hover)] flex items-center gap-2 transition-all">
                                <i data-lucide="key" class="w-3.5 h-3.5 icon-reset"></i> Reset Password
                            </button>
                            <div class="border-t border-[var(--border-color)] my-1"></div>
                            <button onclick="deleteUserFromMenu('${prof.email}', 'professors'); closeAllMenus();" class="w-full px-3 py-2.5 rounded-lg text-xs text-left action-delete hover:bg-[var(--color-danger-bg)] flex items-center gap-2 transition-all">
                                <i data-lucide="trash-2" class="w-3.5 h-3.5"></i> Remove Faculty
                            </button>
                        </div>
                    </div>
                </div>
                <div class="grid grid-cols-2 gap-3 pt-3 border-t border-[var(--border-color)]">
                    <div>
                        <p class="text-[9px] uppercase tracking-widest text-secondary font-mono">Department</p>
                        <p class="text-xs text-primary font-medium truncate">${prof.department}</p>
                    </div>
                    <div>
                        <p class="text-[9px] uppercase tracking-widest text-secondary font-mono">Section</p>
                        <p class="text-xs text-info font-bold uppercase truncate">${prof.assigned_section}</p>
                    </div>
                </div>
            `;
            cardsContainer.appendChild(card);
        }
    });

    lucide.createIcons();
}

// fully working
function filterProfessors() {
    let query = document.getElementById('search-professor').value.toLowerCase();
    document.querySelectorAll('.professor-row').forEach(row => {
        let text = row.textContent.toLowerCase();
        row.style.display = text.includes(query) ? '' : 'none';
    });
}

// fully working
async function handleRegisterProfessor(event) {
    event.preventDefault();
    const name = document.getElementById('prof-name').value;
    const email = document.getElementById('prof-email').value;
    const department = document.getElementById('prof-dept').value;
    const assigned_section = document.getElementById('prof-section').value;

    const { error } = await sb.from('professors').insert([{ name, email, department, assigned_section, status: 'inactive' }]);
    if (error) return showCustomAlert("Registration Error", error.message, "error");

    document.getElementById('add-professor-form').reset();
    closeModal('add-professor-modal');
    loadProfessors();
    showCustomAlert("Registration Success", `${name} added to the faculty roster.`, "success");
}

// fully working
function openProfessorProfile(name, email, dept, section) {
    document.getElementById('prof-profile-name').textContent = name;
    document.getElementById('prof-profile-email').textContent = email;
    document.getElementById('prof-profile-dept').textContent = dept;
    document.getElementById('prof-profile-section').textContent = section;

    document.getElementById('professor-profile-screen').classList.remove('hidden');
    document.getElementById('professor-profile-screen').classList.add('flex');
    document.body.style.overflow = 'hidden';
}

// fully working
function closeProfessorProfile() {
    document.getElementById('professor-profile-screen').classList.add('hidden');
    document.getElementById('professor-profile-screen').classList.remove('flex');
    document.body.style.overflow = 'auto';
}


// ==========================================
// 9. DEVICE & SECURITY MANAGEMENT
// ==========================================

// fully working
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

// fully working
async function openDeviceManager(email) {
    currentManagingEmail = email;
    document.getElementById('device-modal-email').textContent = email;

    const { data: student } = await sb.from('profiles').select('active_devices').eq('email', email).maybeSingle();
    renderDeviceList(student?.active_devices || []);
    openModal('device-manager-modal');
}

// fully working
function renderDeviceList(devices) {
    const container = document.getElementById('device-list-container');
    container.innerHTML = '';

    if (!devices || devices.length === 0) {
        container.innerHTML = `<p class="text-xs text-[var(--text-secondary)] text-center py-6">No active devices logged in.</p>`;
        return;
    }

    devices.forEach((devId) => {
        let platform = "Unknown Device";
        let iconName = "monitor";
        if (devId.includes('Android')) { platform = "Android Smartphone"; iconName = "smartphone"; }
        else if (devId.includes('iOS')) { platform = "iOS Device"; iconName = "smartphone"; }
        else if (devId.includes('iPad')) { platform = "iPad Tablet"; iconName = "tablet"; }
        else if (devId.includes('macOS')) { platform = "macOS Computer"; iconName = "laptop"; }
        else if (devId.includes('Windows')) { platform = "Windows PC"; iconName = "monitor"; }

        const item = document.createElement('div');
        item.className = "flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-[var(--bg-main)] p-3 rounded-xl border border-[var(--border-color)]";
        item.innerHTML = `
            <div class="space-y-1">
                <p class="text-xs font-bold text-primary flex items-center flex-wrap gap-2">
                    <i data-lucide="${iconName}" class="w-3.5 h-3.5 text-accent shrink-0"></i> 
                    <span>${platform}</span>
                </p>
                <p class="text-[10px] font-mono text-[var(--text-secondary)] truncate max-w-[200px]">${devId}</p>
            </div>
            <button onclick="revokeStudentDevice('${currentManagingEmail}', '${devId}')" class="w-full sm:w-auto px-4 py-2 rounded-lg btn-danger-outline text-[10px] font-bold uppercase tracking-wider shrink-0">
                Logout
            </button>
        `;
        container.appendChild(item);
    });
    lucide.createIcons();
}

// fully working
async function revokeStudentDevice(email, deviceId) {
    showCustomConfirm("Logout Device", `Log out this device session for ${email}?`, async () => {
        const { data: student } = await sb.from('profiles').select('active_devices').eq('email', email).maybeSingle();
        let updated = (student?.active_devices || []).filter(id => id !== deviceId);

        await sb.from('profiles').update({ active_devices: updated }).eq('email', email);
        showCustomAlert("Success", "Device logged out.", "success");
        renderDeviceList(updated);
        loadStudents();
    });
}

// fully working
async function loadAdminDeviceSettings(email) {
    const { data } = await sb.from('profiles').select('max_devices, active_devices').eq('email', email).maybeSingle();
    if (!data) return;

    const limitInput = document.getElementById('admin-device-limit-input');
    const currentLimit = data.max_devices || 1;
    if (limitInput) limitInput.value = currentLimit;

    let activeDevices = data.active_devices || [];
    let currentDeviceId = localStorage.getItem('pia_device_id');
    if (!currentDeviceId || !currentDeviceId.includes('[')) {
        currentDeviceId = getDeviceSignature();
        localStorage.setItem('pia_device_id', currentDeviceId);
    }

    if (!activeDevices.includes(currentDeviceId)) {
        if (activeDevices.length >= currentLimit) {
            showCustomAlert("Device Limit Reached", `You have reached the limit of ${currentLimit} admin device(s).`, "error");
            setTimeout(() => { handleAdminSignOut(); }, 3000);
            return;
        } else {
            activeDevices.push(currentDeviceId);
            await sb.from('profiles').update({ active_devices: activeDevices }).eq('email', email);
        }
    }
    renderAdminDeviceList(activeDevices);
}

// fully working
function toggleEditAdminLimit() {
    const input = document.getElementById('admin-device-limit-input');
    input.disabled = false;
    input.classList.remove('opacity-50');
    input.focus();
    document.getElementById('edit-admin-limit-btn').style.display = 'none';
    document.getElementById('save-admin-limit-btn').style.display = 'inline-block';
}

// fully working
async function saveAdminDeviceLimit() {
    const input = document.getElementById('admin-device-limit-input');
    const newLimit = parseInt(input.value) || 1;

    await sb.from('profiles').update({ max_devices: newLimit }).eq('email', currentAdminEmail);
    input.disabled = true;
    input.classList.add('opacity-50');
    document.getElementById('edit-admin-limit-btn').style.display = 'inline-block';
    document.getElementById('save-admin-limit-btn').style.display = 'none';
    showCustomAlert("Settings Updated", "Admin device limit updated successfully!", "success");
}

// fully working
function renderAdminDeviceList(devices) {
    const container = document.getElementById('admin-active-devices-list');
    if (!container) return;
    container.innerHTML = '';

    if (!devices || devices.length === 0) {
        container.innerHTML = `<p class="text-xs text-[var(--text-secondary)]">No active devices found.</p>`;
        return;
    }

    const currentDeviceId = localStorage.getItem('pia_device_id');

    devices.forEach((devId) => {
        let platform = "Unknown Device";
        let iconName = "monitor";
        if (devId.includes('Android')) { platform = "Android Smartphone"; iconName = "smartphone"; }
        else if (devId.includes('iOS')) { platform = "iOS Device"; iconName = "smartphone"; }
        else if (devId.includes('iPad')) { platform = "iPad Tablet"; iconName = "tablet"; }
        else if (devId.includes('macOS')) { platform = "macOS Computer"; iconName = "laptop"; }
        else if (devId.includes('Windows')) { platform = "Windows PC"; iconName = "monitor"; }

        const isCurrentDevice = (devId === currentDeviceId);
        const badgeHTML = isCurrentDevice ? `<span class="px-2 py-0.5 rounded bg-[var(--bg-main)] border border-[var(--border-color)] text-[var(--accent-primary)] text-[9px] uppercase tracking-wider font-bold shadow-sm">This Device</span>` : '';

        const item = document.createElement('div');
        item.className = "flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-[var(--bg-main)] p-3 rounded-xl border border-[var(--border-color)]";
        item.innerHTML = `
            <div class="space-y-1">
                <p class="text-xs font-bold text-primary flex items-center flex-wrap gap-2">
                    <i data-lucide="${iconName}" class="w-3.5 h-3.5 text-accent shrink-0"></i> 
                    <span>${platform}</span>
                    ${badgeHTML}
                </p>
                <p class="text-[10px] font-mono text-[var(--text-secondary)] truncate max-w-[200px]">${devId}</p>
            </div>
            <button onclick="revokeAdminDevice('${devId}')" class="w-full sm:w-auto px-4 py-2 rounded-lg btn-danger-outline text-[10px] font-bold uppercase tracking-wider shrink-0">
                Logout
            </button>
        `;
        container.appendChild(item);
    });
    lucide.createIcons();
}

// fully working
async function revokeAdminDevice(deviceId) {
    showCustomConfirm("Logout Device", `Are you sure you want to log out this admin device session?`, async () => {
        const { data: adminProfile } = await sb.from('profiles').select('active_devices').eq('email', currentAdminEmail).maybeSingle();
        let updated = (adminProfile?.active_devices || []).filter(id => id !== deviceId);

        await sb.from('profiles').update({ active_devices: updated }).eq('email', currentAdminEmail);
        showCustomAlert("Success", "Admin device logged out.", "success");
        renderAdminDeviceList(updated);

        if (localStorage.getItem('pia_device_id') === deviceId) {
            await handleAdminSignOut();
        }
    });
}

// fully working
async function deleteUserFromMenu(email, table) {
    showCustomConfirm("Critical Warning", `Completely delete ${email}?`, async () => {
        let error = null;
        if (table === 'profiles') {
            const rpcRes = await sb.rpc('admin_delete_user', { target_email: email });
            error = rpcRes.error ? (await sb.from('profiles').delete().eq('email', email)).error : null;
        } else {
            error = (await sb.from(table).delete().eq('email', email)).error;
        }

        if (error) return showCustomAlert("Deletion Failed", error.message, "error");
        if (table === 'profiles') loadStudents();
        if (table === 'professors') loadProfessors();
        showCustomAlert("Success", "User deleted successfully.", "success");
    });
}


// ==========================================
// 10. SYSTEM CONTROLS & STAGE SETTINGS
// ==========================================

// fully working
async function loadSettings() {
    const { data } = await sb.from('settings').select('*');
    if (!data) return;

    data.forEach(item => {
        if (item.key === 'global_password') {
            const passEl = document.getElementById('global-default-pass');
            if (passEl) passEl.value = item.value;
        } else if (item.key.startsWith('stage_')) {
            const stageKey = item.key.replace('stage_', '');
            const checkbox = document.getElementById(`toggle-${stageKey}`);
            const lbl = document.getElementById(`${stageKey}-status-lbl`);
            if (checkbox && lbl) {
                checkbox.checked = item.value === true || item.value === 'true';
                lbl.textContent = checkbox.checked ? "Open" : "Closed";
                lbl.className = checkbox.checked ? "text-xs font-bold text-[var(--accent-primary)]" : "text-xs font-bold text-[var(--text-secondary)]";
            }
        }
    });
}

// fully working
async function saveGlobalPassword() {
    const input = document.getElementById('global-default-pass');
    await sb.from('settings').upsert({ key: 'global_password', value: input.value });
    input.disabled = true;
    input.classList.add('opacity-50');
    document.getElementById('edit-pass-btn').style.display = 'inline-block';
    document.getElementById('save-pass-btn').style.display = 'none';
    showCustomAlert("Settings Updated", "Global default password updated!", "success");
}

// fully working
function toggleEditPassword() {
    const input = document.getElementById('global-default-pass');
    input.disabled = false;
    input.classList.remove('opacity-50');
    input.focus();
    document.getElementById('edit-pass-btn').style.display = 'none';
    document.getElementById('save-pass-btn').style.display = 'inline-block';
}

// fully working
function togglePasswordVisibilityCheckbox() {
    document.getElementById('global-default-pass').type = document.getElementById('show-pass-checkbox').checked ? 'text' : 'password';
}

// fully working
async function updateStageControl(stage, checkbox) {
    const isOpen = checkbox.checked;
    const lbl = document.getElementById(`${stage}-status-lbl`);
    lbl.textContent = isOpen ? "Open" : "Closed";
    lbl.className = isOpen ? "text-xs font-bold text-[var(--accent-primary)]" : "text-xs font-bold text-[var(--text-secondary)]";
    await sb.from('settings').upsert({ key: `stage_${stage}`, value: isOpen }, { onConflict: 'key' });
}

// fully working
function openTargetedModal(stage, targetMode) {
    document.getElementById('target-stage-key').value = stage;
    document.getElementById('target-mode').value = targetMode;

    if (targetMode === 'section') {
        document.getElementById('target-section-container').classList.remove('hidden');
        document.getElementById('target-student-container').classList.add('hidden');
    } else {
        document.getElementById('target-section-container').classList.add('hidden');
        document.getElementById('target-student-container').classList.remove('hidden');

        document.getElementById('target-student-search').value = '';
        document.getElementById('target-student-email-selected').value = '';
        document.getElementById('selected-target-student-lbl').textContent = 'No student selected';
        document.getElementById('selected-target-student-lbl').className = 'text-[10px] font-mono text-accent';
        filterTargetStudents();
    }

    document.getElementById('grant-access-btn').disabled = false;
    document.getElementById('grant-access-btn').classList.remove('opacity-50', 'cursor-not-allowed');

    openModal('targeted-modal');
}

// fully working
function filterTargetStudents() {
    const query = document.getElementById('target-student-search').value.toLowerCase();
    const listContainer = document.getElementById('target-student-list');
    listContainer.innerHTML = '';

    const filtered = studentDataCache.filter(s =>
        s.full_name.toLowerCase().includes(query) ||
        s.email.toLowerCase().includes(query)
    );

    if (filtered.length === 0) {
        listContainer.innerHTML = '<p class="text-[10px] text-secondary text-center py-2">No student found.</p>';
        return;
    }

    filtered.forEach(student => {
        const item = document.createElement('div');
        item.className = 'flex justify-between items-center p-2 hover:bg-[var(--bg-hover)] cursor-pointer rounded border border-transparent hover:border-[var(--border-color)] transition-colors';

        item.onclick = () => {
            document.getElementById('target-student-email-selected').value = student.email;
            document.getElementById('selected-target-student-lbl').textContent = student.full_name;
            document.getElementById('selected-target-student-lbl').className = 'text-[10px] font-mono text-success font-bold';
        };

        item.innerHTML = `
            <div class="overflow-hidden">
                <p class="text-xs font-bold text-primary truncate">${student.full_name}</p>
                <p class="text-[10px] font-mono text-secondary truncate">${student.email}</p>
            </div>
        `;
        listContainer.appendChild(item);
    });
}

// fully working
async function executeTargetedOpen() {
    const stageKey = document.getElementById('target-stage-key').value;
    const mode = document.getElementById('target-mode').value;
    const btn = document.getElementById('grant-access-btn');

    let targetStage = 'Waiting Room';
    if (stageKey === 'ocean') targetStage = 'OCEAN';
    if (stageKey === 'char') targetStage = 'Character Selection';
    if (stageKey === 'dash') targetStage = 'Tutoring Dashboard';

    btn.disabled = true;
    btn.innerHTML = 'Processing...';

    let error = null;

    if (mode === 'section') {
        const section = document.getElementById('target-section-select').value;
        const res = await sb.from('profiles').update({ current_stage: targetStage }).eq('section', section);
        error = res.error;
    } else {
        const email = document.getElementById('target-student-email-selected').value;
        if (!email) {
            showCustomAlert("Validation Error", "Please select a student first.", "error");
            btn.disabled = false;
            btn.innerHTML = 'Grant Access';
            return;
        }
        const res = await sb.from('profiles').update({ current_stage: targetStage }).eq('email', email);
        error = res.error;
    }

    btn.disabled = false;
    btn.innerHTML = 'Grant Access';

    if (error) {
        showCustomAlert("Error", error.message, "error");
    } else {
        closeModal('targeted-modal');
        showCustomAlert("Access Granted", `Successfully moved target to ${targetStage}.`, "success");
        loadStudents();
    }
}


// ==========================================
// 11. ADMIN ACCOUNT & SUPER ADMIN LOGIC
// ==========================================

const SUPER_ADMIN_EMAIL = 'personalinstructingagent@gmail.com';

// fully working
async function initAdminProfile() {
    try {
        let email = localStorage.getItem('pia_user_email');
        if (!email && typeof sb !== 'undefined') {
            const { data: { user } } = await sb.auth.getUser();
            if (user) {
                email = user.email;
                localStorage.setItem('pia_user_email', email);
            }
        }

        let name = "Admin";
        if (email) {
            name = email.split('@')[0];
            if (typeof sb !== 'undefined') {
                const { data: profile } = await sb.from('profiles').select('full_name').eq('email', email).maybeSingle();
                if (profile && profile.full_name) {
                    name = profile.full_name.trim().split(' ')[0];
                }
            }
        }

        const hour = new Date().getHours();
        let greeting = "Good evening";
        if (hour >= 0 && hour < 12) greeting = "Good morning";
        else if (hour >= 12 && hour < 18) greeting = "Good afternoon";

        const desktopEmailEl = document.getElementById('desktop-admin-email');
        const desktopGreetingEl = document.getElementById('desktop-admin-greeting');
        const mobileEmailEl = document.getElementById('mobile-admin-email');
        const prefixEl = document.getElementById('mobile-greeting-prefix');
        const nameEl = document.getElementById('mobile-greeting-name');

        if (desktopEmailEl) desktopEmailEl.textContent = email || "admin@ue.edu.ph";
        if (desktopGreetingEl) desktopGreetingEl.textContent = `${greeting}, ${name}`;
        if (mobileEmailEl) mobileEmailEl.textContent = email || "admin@ue.edu.ph";
        if (prefixEl) prefixEl.textContent = `${greeting},`;
        if (nameEl) nameEl.textContent = name;

    } catch (error) {
        console.error("Profile Fetch Error:", error);
    }
}

// fully working
async function checkSuperAdmin() {
    const currentEmail = localStorage.getItem('pia_user_email');
    if (currentEmail === SUPER_ADMIN_EMAIL) {
        document.getElementById('super-admin-panel').classList.remove('hidden');
        loadCoAdmins();
    }
}

// fully working
async function loadCoAdmins() {
    const { data } = await sb.from('profiles').select('*').eq('role', 'admin');
    const tbody = document.getElementById('admins-tbody');
    tbody.innerHTML = '';

    data.forEach(admin => {
        const isMe = admin.email === SUPER_ADMIN_EMAIL;
        const actionBtn = isMe
            ? `<span class="text-[10px] text-accent font-bold uppercase tracking-wider">Super Admin</span>`
            : `<button onclick="kickAdmin('${admin.email}')" class="btn-danger-outline px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider">Kick</button>`;

        const tr = document.createElement('tr');
        tr.className = "hover:bg-[var(--bg-hover)] transition-colors";
        tr.innerHTML = `
            <td class="py-3 px-3 font-medium text-primary text-xs flex items-center gap-2">
                <i data-lucide="shield-check" class="w-4 h-4 text-accent"></i> ${admin.full_name}
            </td>
            <td class="py-3 px-3 text-secondary text-[10px] font-mono">${admin.email}</td>
            <td class="py-3 px-3 text-right">${actionBtn}</td>
        `;
        tbody.appendChild(tr);
    });
    lucide.createIcons();
}

// fully working
async function handleRegisterAdmin(event) {
    event.preventDefault();
    const first = document.getElementById('new-admin-first').value.trim();
    const middle = document.getElementById('new-admin-middle').value.trim();
    const last = document.getElementById('new-admin-last').value.trim();
    const full_name = [first, middle, last].filter(Boolean).join(' ');
    const email = document.getElementById('new-admin-email').value.trim();
    const defaultPass = document.getElementById('global-default-pass')?.value || 'PIA2026!';

    const { error: authError } = await sb.rpc('admin_create_auth_user', {
        target_email: email,
        default_password: defaultPass
    });

    if (authError) return showCustomAlert("Auth Error", authError.message, "error");

    const { error } = await sb.from('profiles').insert([{
        full_name, email, role: 'admin', status: 'inactive', max_devices: 1
    }]);

    if (error) return showCustomAlert("Registration Error", error.message, "error");

    document.getElementById('add-admin-form').reset();
    closeModal('add-admin-modal');
    loadCoAdmins();
    showCustomAlert("Success", `${full_name} added as admin (Inactive until emailed).`, "success");
}

// fully working
function kickAdmin(email) {
    showCustomConfirm("Kick Admin", `Remove ${email} from admin roster?`, async () => {
        await sb.rpc('admin_delete_user', { target_email: email });
        await sb.from('profiles').delete().eq('email', email);
        showCustomAlert("Admin Kicked", `${email} removed successfully.`, "success");
        loadCoAdmins();
    });
}

// fully working
async function handleAdminPasswordUpdate(event) {
    event.preventDefault();
    const newPass = document.getElementById('admin-new-password').value;
    const confirmPass = document.getElementById('admin-confirm-password').value;

    if (newPass !== confirmPass) {
        return showCustomAlert("Error", "Passwords do not match.", "error");
    }

    const { error } = await sb.auth.updateUser({ password: newPass });
    if (error) {
        showCustomAlert("Update Failed", error.message, "error");
    } else {
        showCustomAlert("Success", "Admin password updated successfully.", "success");
        document.getElementById('admin-password-form').reset();
    }
}

// fully working
async function resetPasswordFromMenu(email) {
    const defaultPass = document.getElementById('global-default-pass')?.value || 'PIA2026!';
    showCustomConfirm("Reset Password", `Reset password for ${email} to ${defaultPass}?`, async () => {
        const { error } = await sb.rpc('admin_reset_password', { target_email: email, new_password: defaultPass });
        if (error) return showCustomAlert("Reset Failed", error.message, "error");
        showCustomAlert("Success", `Password reset successfully to: ${defaultPass}`, "success");
    });
}

// fully working
async function handleAdminSignOut() {
    try {
        const email = localStorage.getItem('pia_user_email');
        if (email && typeof sb !== 'undefined') await sb.from('profiles').update({ active_devices: [] }).eq('email', email);
        if (typeof sb !== 'undefined') await sb.auth.signOut();
    } catch (err) {
        console.error("Sign out error:", err);
    }
    localStorage.clear();
    sessionStorage.clear();
    window.location.replace('../../index.html');
}


// ==========================================
// 12. EMAIL BROADCAST TOOLS
// ==========================================

// fully working
async function sendActivationEmail(email) {
    showCustomConfirm("Send Email", `Trigger activation link to ${email}?`, async () => {
        const redirectPath = window.location.origin + encodeURI('/index.html');
        const { error } = await sb.auth.signInWithOtp({
            email: email,
            options: { shouldCreateUser: false, emailRedirectTo: redirectPath }
        });
        if (error) return showCustomAlert("Error", error.message, "error");
        showCustomAlert("Email Sent", `Activation link successfully sent to ${email}.`, "success");
    });
}

// fully working
async function sendSectionEmails(sectionName) {
    showCustomConfirm("Broadcast Section", `Send activation emails to all inactive students in section ${sectionName}?`, async () => {
        const { data: students } = await sb.from('profiles').select('email').eq('section', sectionName).eq('status', 'inactive');
        if (!students || students.length === 0) {
            return showCustomAlert("Notice", "No inactive students found in this section.", "info");
        }

        const redirectPath = window.location.origin + encodeURI('/assets/html/sign-up.html');
        let successCount = 0;

        for (const student of students) {
            const { error: mailError } = await sb.auth.signInWithOtp({
                email: student.email,
                options: { shouldCreateUser: false, emailRedirectTo: redirectPath }
            });
            if (!mailError) successCount++;
        }
        showCustomAlert("Broadcast Complete", `Successfully sent activation emails to ${successCount} student(s) in section ${sectionName}.`, "success");
    });
}