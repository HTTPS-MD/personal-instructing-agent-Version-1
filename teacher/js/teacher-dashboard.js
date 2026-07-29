// Supabase Configuration


let currentFilter = 'all';

// Fetch and Render Students on Page Load & Setup Realtime Subscriptions
window.addEventListener('DOMContentLoaded', async () => {
    await loadTeacherMonitoring();
    setupRealtimeSubscription();
    lucide.createIcons();
});

async function loadTeacherMonitoring() {
    if (!supabaseClient) return;

    const { data, error } = await supabaseClient
        .from('profiles')
        .select('*')
        .eq('section', 'Earth');

    const tbody = document.getElementById('student-monitoring-body');
    tbody.innerHTML = '';

    if (error || !data || data.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="py-8 text-center text-[var(--text-secondary)]">No students found in Section Earth.</td></tr>`;
        return;
    }

    const now = new Date();

    data.forEach(student => {
        const isLoggedIn = student.status === 'active';

        // Kalkulahin ang tagal ng huling aktibidad (last_seen / updated_at)
        let lastActiveTime = student.last_seen ? new Date(student.last_seen) : (student.updated_at ? new Date(student.updated_at) : null);
        let diffMinutes = lastActiveTime ? (now - lastActiveTime) / (1000 * 60) : 999;

        // Status logic:
        // 1. Offline kung hindi pa nakapag-sign in (status != 'active')
        // 2. Inactive kung nakasigning-in pero lumagpas sa 10 minuto ang huling galaw
        // 3. Online kung active at wala pang 10 minuto ang huling galaw
        let engagementState = 'offline';
        let engagementHtml = '';

        if (!isLoggedIn) {
            engagementState = 'offline';
            engagementHtml = `<span class="status-badge-offline font-mono text-[10px] uppercase tracking-wider flex items-center gap-1"><span class="w-2 h-2 rounded-full status-dot-offline"></span> Offline (Not Signed In)</span>`;
        } else if (diffMinutes > 10) {
            engagementState = 'inactive';
            engagementHtml = `<span class="status-badge-inactive font-mono text-[10px] uppercase tracking-wider flex items-center gap-1"><span class="w-2 h-2 rounded-full status-dot-inactive"></span> Inactive (>10m idle)</span>`;
        } else {
            engagementState = 'online';
            engagementHtml = `<span class="status-badge-online font-mono text-[10px] uppercase tracking-wider flex items-center gap-1"><span class="w-2 h-2 rounded-full status-dot-online animate-pulse"></span> Online (Active)</span>`;
        }

        const isStruggling = student.pre_test_score !== null && student.pre_test_score < 70;
        const learningState = isStruggling ? 'struggling' : 'smooth';

        const learningStatusHtml = isStruggling
            ? `<span class="flex items-center gap-1.5 learning-struggling font-medium"><i data-lucide="alert-triangle" class="w-3.5 h-3.5"></i> Struggling</span>`
            : `<span class="flex items-center gap-1.5 learning-smooth font-medium"><i data-lucide="trending-up" class="w-3.5 h-3.5"></i> Smooth</span>`;

        const tr = document.createElement('tr');
        tr.className = "hover:bg-[var(--bg-hover)] transition-colors student-row";
        tr.setAttribute('data-learning', learningState);
        tr.setAttribute('data-engagement', engagementState);

        const initial = student.full_name ? student.full_name.charAt(0).toUpperCase() : 'S';
        const dotColor = engagementState === 'online' ? 'status-dot-online' : (engagementState === 'inactive' ? 'status-dot-inactive' : 'status-dot-offline');

        tr.innerHTML = `
            <td class="py-4 px-4 font-medium text-[var(--text-primary)] flex items-center gap-3">
                <div class="relative">
                    <div class="w-8 h-8 rounded-full bg-[var(--color-info-bg)] flex items-center justify-center text-[var(--accent-primary)] font-bold">${initial}</div>
                    <span class="absolute bottom-0 right-0 w-2.5 h-2.5 ${dotColor} border border-[var(--bg-main)] rounded-full"></span>
                </div>
                <div>
                    <p>${student.full_name || 'Unnamed Student'}</p>
                    <p class="text-[10px] text-[var(--text-secondary)] font-mono">${student.email || 'no-email@ue.edu.ph'}</p>
                </div>
            </td>
            <td class="py-4 px-4"><span class="px-2.5 py-1 rounded-md badge-group text-[10px]">${student.group_type || 'EXP'}</span></td>
            <td class="py-4 px-4 text-[var(--text-secondary)]">Algebraic Expressions</td>
            <td class="py-4 px-4">${learningStatusHtml}</td>
            <td class="py-4 px-4">${engagementHtml}</td>
            <td class="py-4 px-4 text-right">
                <button onclick="openStudentProfile('${student.full_name || 'Student'}', '${student.email || ''}', '${student.group_type || 'EXP'}', '${student.pre_test_score ?? 'n/a'}', '${student.post_test_score ?? 'n/a'}', '${student.selected_character || 'openness'}')"
                    class="btn-secondary px-3 py-1.5 rounded-lg text-xs">View Details</button>
            </td>
        `;
        tbody.appendChild(tr);
    });

    lucide.createIcons();
    applyCurrentFilter();
}

// Realtime Listener para kusang mag-update kapag may nagbago sa database
function setupRealtimeSubscription() {
    if (!supabaseClient) return;

    supabaseClient
        .channel('teacher-monitoring-channel')
        .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'profiles' },
            async (payload) => {
                // Kapag may nagbago sa profiles table, i-reload agad ang data nang realtime
                await loadTeacherMonitoring();
            }
        )
        .subscribe();
}

function filterTable(filterType, btnElement) {
    currentFilter = filterType;
    const tabs = document.querySelectorAll('.filter-tab');
    tabs.forEach(tab => {
        tab.className = "filter-tab px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-wider text-[var(--text-secondary)] hover:text-primary transition-all flex items-center gap-1.5";
    });

    if (btnElement) {
        btnElement.className = "filter-tab px-4 py-2 rounded-lg text-xs font-bold uppercase tracking-wider text-[var(--accent-primary)] bg-[var(--bg-hover)] transition-all flex items-center gap-1.5";
    }

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
        let nameText = row.querySelector('.font-medium').textContent.toLowerCase();
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

function handleSignOut() {
    localStorage.clear();
    window.location.href = 'index.html';
}