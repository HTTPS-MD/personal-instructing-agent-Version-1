// Supabase Configuration ay nasa function.js na

let currentFilter = 'all';
let teacherSection = null;

// ==========================================
// SESSION + ROLE GUARD (security fix)
// Dating walang kahit anong verification dito -- direktang na-render na ang
// buong student roster kahit walang session/role check. Ngayon, i-verify muna
// server-side (via Supabase session + profiles.role) bago ipakita ang laman.
// ==========================================
async function enforceTeacherAccess() {
    if (typeof sb === 'undefined') {
        showAccessError("Database connection failed. Please refresh.");
        return false;
    }

    try {
        const { data: { session }, error: sessionError } = await sb.auth.getSession();
        if (sessionError || !session) throw new Error("Session expired. Please log in again.");

        const email = session.user.email;
        const { data: profile, error } = await sb.from('profiles').select('role, section, full_name').eq('email', email).maybeSingle();

        if (error || !profile || profile.role !== 'teacher') {
            throw new Error("Unauthorized access. Teacher privileges required.");
        }

        localStorage.setItem('pia_user_email', email);

        // Kunin ang section na naka-assign sa naka-login na teacher: profiles.section
        // muna, at kung wala, i-check ang professors.assigned_section bilang fallback.
        teacherSection = profile.section || null;
        let teacherName = profile.full_name || null;
        if (!teacherSection || !teacherName) {
            const { data: profRow } = await sb.from('professors').select('name, assigned_section').eq('email', email).maybeSingle();
            if (!teacherSection) teacherSection = profRow?.assigned_section || null;
            if (!teacherName) teacherName = profRow?.name || null;
        }

        const nameEl = document.querySelector('.teacher-name');
        if (nameEl && teacherName) nameEl.textContent = teacherName;
        const sectionLabelEl = document.getElementById('teacher-section-label');
        if (sectionLabelEl) sectionLabelEl.textContent = `Section ${teacherSection || 'Unassigned'} (Grade 7)`;

        document.body.classList.remove('opacity-0');
        return true;
    } catch (e) {
        console.error("Teacher dashboard access error:", e);
        showAccessError(e.message || "Failed to verify access.");
        localStorage.removeItem('pia_user_email');
        setTimeout(() => window.location.replace('../../index.html'), 3000);
        return false;
    }
}

function showAccessError(message) {
    const banner = document.getElementById('global-error-banner');
    const msgEl = document.getElementById('global-error-message');
    if (banner && msgEl) {
        msgEl.textContent = message;
        banner.classList.remove('hidden');
    }
}

// Fetch and Render Students on Page Load & Setup Realtime Subscriptions
window.addEventListener('DOMContentLoaded', async () => {
    const allowed = await enforceTeacherAccess();
    if (!allowed) return;

    await loadTeacherMonitoring();
    setupRealtimeSubscription();
    lucide.createIcons();
});

async function loadTeacherMonitoring() {
    if (!supabaseClient) return;

    const tbody = document.getElementById('student-monitoring-body');

    if (!teacherSection) {
        tbody.innerHTML = `<tr><td colspan="6" class="empty-cell">No section is assigned to your account yet. Contact the admin.</td></tr>`;
        return;
    }

    // Ang columns lang na talagang ginagamit ng monitoring table. Dating '*',
    // kaya nadadala pati active_devices, max_devices, role, at OCEAN scores ng
    // bawat estudyante papunta sa browser ng teacher kahit hindi ipinapakita.
    const { data, error } = await supabaseClient
        .from('profiles')
        // WALANG `last_seen` at `updated_at` na column sa profiles -- ang
        // paghingi sa kanila ay 42703 (undefined column) -> HTTP 400, kaya
        // BLANGKO ang buong teacher dashboard. Ang `is_in_game` at
        // `stage_started_at` ay totoong umiiral at sapat para sa engagement.
        .select('full_name, email, group_type, status, is_in_game, stage_started_at, selected_character, pre_test_score, post_test_score')
        .eq('section', teacherSection);

    tbody.innerHTML = '';

    if (error || !data || data.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="empty-cell">No students found in Section ${escapeHTML(teacherSection)}.</td></tr>`;
        return;
    }

    const now = new Date();

    data.forEach(student => {
        const isLoggedIn = student.status === 'active';

        // Huling kilalang aktibidad. Ang aktibong naglalaro ay laging Online;
        // kung hindi, ang stage_started_at ang pinakabagong timestamp na
        // talagang isinusulat ng app.
        const lastActiveTime = student.stage_started_at ? new Date(student.stage_started_at) : null;
        const diffMinutes = student.is_in_game
            ? 0
            : (lastActiveTime ? (now - lastActiveTime) / (1000 * 60) : 999);

        // Status logic:
        // 1. Offline kung hindi pa nakapag-sign in (status != 'active')
        // 2. Inactive kung nakasigning-in pero lumagpas sa 10 minuto ang huling galaw
        // 3. Online kung active at wala pang 10 minuto ang huling galaw
        let engagementState = 'offline';
        let engagementHtml = '';

        if (!isLoggedIn) {
            engagementState = 'offline';
            engagementHtml = `<span class="engagement-badge status-badge-offline"><span class="status-dot status-dot-offline"></span> Offline (Not Signed In)</span>`;
        } else if (diffMinutes > 10) {
            engagementState = 'inactive';
            engagementHtml = `<span class="engagement-badge status-badge-inactive"><span class="status-dot status-dot-inactive"></span> Inactive (&gt;10m idle)</span>`;
        } else {
            engagementState = 'online';
            engagementHtml = `<span class="engagement-badge status-badge-online"><span class="status-dot status-dot-online engagement-dot-pulse"></span> Online (Active)</span>`;
        }

        const isStruggling = student.pre_test_score !== null && student.pre_test_score < 70;
        const learningState = isStruggling ? 'struggling' : 'smooth';

        const learningStatusHtml = isStruggling
            ? `<span class="learning-badge learning-struggling"><i data-lucide="alert-triangle" class="icon-xs"></i> Struggling</span>`
            : `<span class="learning-badge learning-smooth"><i data-lucide="trending-up" class="icon-xs"></i> Smooth</span>`;

        const tr = document.createElement('tr');
        tr.className = "student-row";
        tr.setAttribute('data-learning', learningState);
        tr.setAttribute('data-engagement', engagementState);

        const initial = student.full_name ? student.full_name.charAt(0).toUpperCase() : 'S';
        const dotColor = engagementState === 'online' ? 'status-dot-online' : (engagementState === 'inactive' ? 'status-dot-inactive' : 'status-dot-offline');

        tr.innerHTML = `
            <td class="student-name-cell">
                <div class="student-avatar-wrap">
                    <div class="student-avatar-initial">${escapeHTML(initial)}</div>
                    <span class="student-avatar-status ${dotColor}"></span>
                </div>
                <div>
                    <p class="student-name">${escapeHTML(student.full_name || 'Unnamed Student')}</p>
                    <p class="student-email">${escapeHTML(student.email || 'no-email@ue.edu.ph')}</p>
                </div>
            </td>
            <td><span class="badge badge-pill badge-group">${escapeHTML(student.group_type || 'EXP')}</span></td>
            <td class="text-secondary">Algebraic Expressions</td>
            <td>${learningStatusHtml}</td>
            <td>${engagementHtml}</td>
            <td class="text-right">
                <button onclick="openStudentProfile('${escapeJS(student.full_name || 'Student')}', '${escapeJS(student.email || '')}', '${escapeJS(student.group_type || 'EXP')}', '${escapeJS(student.pre_test_score ?? 'n/a')}', '${escapeJS(student.post_test_score ?? 'n/a')}', '${escapeJS(student.selected_character || 'openness')}')"
                    class="btn-secondary btn-sm">View Details</button>
            </td>
        `;
        tbody.appendChild(tr);
    });

    lucide.createIcons();
    applyCurrentFilter();
}

// Realtime Listener para kusang mag-update kapag may nagbago sa database
function setupRealtimeSubscription() {
    if (!supabaseClient || !teacherSection) return;

    // SECURITY FIX: dati, `event:'*'` sa BUONG profiles table -- kaya ang
    // browser ng teacher ay tumatanggap ng bawat pagbabago sa lahat ng
    // estudyante ng buong sistema, pati ang mga section na hindi kanila.
    // Ang sariling section na lang ang sinu-subscribe-an ngayon.
    //
    // Nadagdagan din ng debounce: dati, bawat isang event ay nagpapatakbo ng
    // buong table reload, kaya ang isang bugso ng update (hal. sabay-sabay na
    // pumasok ang klase) ay naghahambalos ng dose-dosenang query.
    const channelSuffix = String(teacherSection).replace(/[^A-Za-z0-9_-]/g, '_');
    let reloadTimer = null;

    registerChannel('teacher-monitoring-' + channelSuffix, (ch) => ch
        .on(
            'postgres_changes',
            {
                event: '*',
                schema: 'public',
                table: 'profiles',
                filter: `section=eq.${teacherSection}`
            },
            () => {
                clearTimeout(reloadTimer);
                reloadTimer = setTimeout(loadTeacherMonitoring, 400);
            }
        )
        .subscribe());
}

function filterTable(filterType, btnElement) {
    currentFilter = filterType;
    document.querySelectorAll('.filter-tab').forEach(tab => tab.classList.remove('active'));
    if (btnElement) btnElement.classList.add('active');

    applyCurrentFilter();
}

function applyCurrentFilter() {
    const rows = document.querySelectorAll('.student-row');
    let visibleCount = 0;

    rows.forEach(row => {
        const learning = row.getAttribute('data-learning');
        const engagement = row.getAttribute('data-engagement');

        let show = false;
        if (currentFilter === 'all') show = true;
        else if (currentFilter === 'online' && engagement === 'online') show = true;
        else if (currentFilter === 'offline' && engagement === 'offline') show = true;
        else if (currentFilter === 'inactive' && engagement === 'inactive') show = true;
        else if (currentFilter === 'smooth' && learning === 'smooth') show = true;
        else if (currentFilter === 'struggling' && learning === 'struggling') show = true;

        row.style.display = show ? '' : 'none';
        if (show) visibleCount++;
    });

    document.getElementById('empty-state').style.display = visibleCount === 0 ? 'block' : 'none';
}

function searchTable() {
    let query = document.getElementById('search-student').value.toLowerCase();
    let rows = document.querySelectorAll('.student-row');
    let visibleCount = 0;

    rows.forEach(row => {
        let nameText = row.querySelector('.student-name').textContent.toLowerCase();
        if (nameText.includes(query)) {
            row.style.display = '';
            visibleCount++;
        } else {
            row.style.display = 'none';
        }
    });

    document.getElementById('empty-state').style.display = visibleCount === 0 ? 'block' : 'none';
}

function openStudentProfile(name, email, type, pretest, posttest, character) {
    document.getElementById('profile-name').textContent = name;
    document.getElementById('profile-email').textContent = email;
    document.getElementById('profile-section').textContent = teacherSection || '--';
    document.getElementById('profile-type').textContent = type;
    document.getElementById('profile-pretest').textContent = pretest;
    document.getElementById('profile-posttest').textContent = posttest;

    const cleanChar = character ? character.replace('pia-', '') : 'openness';
    document.getElementById('profile-persona-badge').textContent = `${cleanChar.toUpperCase()} Agent`;
    document.getElementById('profile-avatar-img').src = `/assets/images/persona-${cleanChar.toLowerCase()}.png`;

    document.getElementById('student-profile-screen').classList.remove('hidden');
}

function closeStudentProfile() {
    document.getElementById('student-profile-screen').classList.add('hidden');
}

// Dating localStorage.clear() lang -- nananatiling buhay ang Supabase session
// (kasama ang refresh token) pagkatapos ng "sign out".
function handleSignOut() {
    return executeForceLogout();
}
