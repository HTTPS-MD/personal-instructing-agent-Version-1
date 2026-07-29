// Global variables
let selectedChar = null;
let isLockedIn = false;

// SUPABASE CONFIGURATION


// STRICT GATEKEEPER CHECK ON LOAD
async function enforceStageLock() {
    if (!supabaseClient) return;
    const currentUserEmail = localStorage.getItem('pia_user_email');

    if (!currentUserEmail) {
        window.location.href = 'sign-in.html';
        return;
    }

    // Check if the character selection stage is open
    const { data: setting } = await supabaseClient.from('settings').select('value').eq('key', 'stage_char').maybeSingle();
    if (!setting || (setting.value !== true && setting.value !== 'true')) {
        window.location.href = 'waiting-room.html'; // Kick to waiting room if closed
        return;
    }

    // Check if the student has already selected a character
    const { data: profile } = await supabaseClient.from('profiles').select('selected_character').eq('email', currentUserEmail).maybeSingle();
    if (profile && profile.selected_character) {
        window.location.href = 'waiting-room.html'; // They already locked in, send to wait for dashboard
    }
}

// Run check immediately
enforceStageLock();

function previewCharacter(element) {
    if (isLockedIn) return;

    document.querySelectorAll('.solid-card').forEach(card => {
        card.classList.remove('selected');
        const img = card.querySelector('.agent-img-thumbnail');
        if (img) img.classList.add('grayscale');
    });

    element.classList.add('selected');
    const activeImg = element.querySelector('.agent-img-thumbnail');
    if (activeImg) activeImg.classList.remove('grayscale');

    selectedChar = element.getAttribute('data-character');
    const name = element.getAttribute('data-name');
    const role = element.getAttribute('data-role');
    const desc = element.getAttribute('data-desc');
    const imgPath = element.getAttribute('data-img');

    document.getElementById('preview-role').textContent = role;
    document.getElementById('preview-name').textContent = name;
    document.getElementById('preview-desc').textContent = desc;
    document.getElementById('preview-bg-img').src = imgPath;

    const lockBtn = document.getElementById('lock-in-btn');
    lockBtn.disabled = false;
    lockBtn.classList.add('glow-primary-shadow');
}

function openConfirmModal() {
    if (!selectedChar || isLockedIn) return;
    const modal = document.getElementById('confirm-modal');
    const content = document.getElementById('modal-content');

    modal.classList.remove('hidden');
    modal.classList.add('modal-active'); // I-enable ang pointer-events
    content.classList.add('modal-content-active');

    setTimeout(() => {
        modal.classList.remove('opacity-0');
        content.classList.remove('scale-95');
        content.classList.add('scale-100');
    }, 10);
}

function closeConfirmModal() {
    const modal = document.getElementById('confirm-modal');
    const content = document.getElementById('modal-content');

    modal.classList.remove('modal-active');
    content.classList.remove('modal-content-active');
    modal.classList.add('opacity-0');
    content.classList.remove('scale-100');
    content.classList.add('scale-95');

    setTimeout(() => {
        modal.classList.add('hidden');
    }, 300);
}

async function finalLockIn() {
    if (!selectedChar) return;

    if (supabaseClient) {
        const currentUserEmail = localStorage.getItem('pia_user_email');

        if (currentUserEmail) {
            await supabaseClient
                .from('profiles')
                .update({ selected_character: selectedChar })
                .eq('email', currentUserEmail);
        } else {
            const { data: { user } } = await supabaseClient.auth.getUser();
            if (user) {
                await supabaseClient
                    .from('profiles')
                    .update({ selected_character: selectedChar })
                    .eq('id', user.id);
            }
        }
    }

    localStorage.setItem('selected_character', selectedChar);

    closeConfirmModal();

    isLockedIn = true;
    document.getElementById('status-text').textContent = 'LOCKED IN';

    document.querySelectorAll('.solid-card').forEach(card => {
        card.style.pointerEvents = 'none';
    });

    document.getElementById('lock-in-btn').style.display = 'none';

    // Suriin kung bukas na ang dashboard stage
    let isDashboardOpen = false;
    if (supabaseClient) {
        const { data: setting } = await supabaseClient.from('settings').select('value').eq('key', 'stage_dash').maybeSingle();
        if (setting && (setting.value === true || setting.value === 'true')) {
            isDashboardOpen = true;
        }
    }

    if (isDashboardOpen) {
        // Kung nakabukas na, saka lang lalabas ang continue button
        document.getElementById('continue-btn').style.display = 'block';
    } else {
        // Kung nakasara pa, ibabato muna siya sa waiting room
        window.location.href = 'waiting-room.html';
    }
}

function goToDashboard() {
    window.location.href = 'student-dashboard.html';
}

// Realtime listener para sa Character Selection
if (supabaseClient) {
    supabaseClient
        .channel('realtime-char-lock')
        .on(
            'postgres_changes',
            {
                event: 'UPDATE',
                schema: 'public',
                table: 'settings',
                filter: `key=eq.stage_char`
            },
            (payload) => {
                const isOpen = payload.new.value === true || payload.new.value === 'true';
                if (!isOpen) {
                    window.location.href = 'waiting-room.html';
                }
            }
        )
        .subscribe();
}