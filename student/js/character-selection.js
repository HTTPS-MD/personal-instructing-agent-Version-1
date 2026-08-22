// Global variables
let selectedChar = null;
let isLockedIn = false;

// SUPABASE CONFIGURATION


// STRICT GATEKEEPER CHECK ON LOAD
// Dating stage_char + selected_character lang ang tinitingnan dito -- walang
// session, walang is_ocean_done, walang group_type. Kaya kayang mag-type lang
// ng URL ang kahit sinong naka-login para pumili ng character nang hindi
// dumaan sa OCEAN test. Nasa enforceStudentStage('char') na ang buong chain.
let verifiedEmail = null;

async function enforceStageLock() {
    const profile = await enforceStudentStage('char');
    if (!profile) return;
    verifiedEmail = profile.email;
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
    const style = element.getAttribute('data-style');
    const pace = element.getAttribute('data-pace');
    const best = element.getAttribute('data-best');

    document.getElementById('preview-role').textContent = role;
    document.getElementById('preview-name').textContent = name;
    document.getElementById('preview-desc').textContent = desc;
    document.getElementById('preview-bg-img').src = imgPath;

    document.getElementById('preview-style').textContent = style;
    document.getElementById('preview-pace').textContent = pace;
    document.getElementById('preview-best').textContent = best;
    document.getElementById('preview-characteristics').classList.remove('hidden');

    const lockBtn = document.getElementById('lock-in-btn');
    lockBtn.disabled = false;
    lockBtn.classList.add('glow-primary-shadow');
}

function openConfirmModal() {
    if (!selectedChar || isLockedIn) return;
    const modal = document.getElementById('confirm-modal');
    const content = document.getElementById('modal-content');

    modal.classList.add('modal-active');
    content.classList.add('modal-content-active');
}

function closeConfirmModal() {
    const modal = document.getElementById('confirm-modal');
    const content = document.getElementById('modal-content');

    modal.classList.remove('modal-active');
    content.classList.remove('modal-content-active');
}

async function finalLockIn() {
    if (!selectedChar) return;
    if (!verifiedEmail) return; // hindi pa kumpirmado ng guard ang session

    // Session-verified email, hindi na ang spoofable na localStorage value.
    const { error } = await supabaseClient
        .from('profiles')
        .update({ selected_character: selectedChar })
        .eq('email', verifiedEmail);

    if (error) {
        alert("Could not save your selection: " + error.message);
        return;
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
    if (await isStageOpen('stage_dash')) {
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
    registerChannel('realtime-char-lock', (ch) => ch
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
        .subscribe());
}