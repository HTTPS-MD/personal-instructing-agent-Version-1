// Supabase Configuration & Initialization ay nasa function.js na

/**
 * Initializes the student dashboard upon DOM content loading. 
 * Enforces stage accessibility locks, validates student session identity, 
 * updates real-time tracking status to 'Tutoring Dashboard', and loads user profile details.
 */
document.addEventListener('DOMContentLoaded', async () => {
    lucide.createIcons();

    // --- STRICT GATEKEEPER CHECK ON LOAD ---
    if (window.supabaseClient) {
        const { data: setting } = await window.supabaseClient.from('settings').select('value').eq('key', 'stage_dash').maybeSingle();
        if (!setting || (setting.value !== true && setting.value !== 'true')) {
            window.location.href = 'waiting-room.html'; // Bawal um-access kung naka-lock ang stage
            return;
        }
    }
    // --------------------------------------------

    const currentUserEmail = localStorage.getItem('pia_user_email');

    // Redirect kapag walang nakasave na email
    if (!currentUserEmail) {
        window.location.href = '../sign-in.html';
        return;
    }

    // --- REALTIME ADMIN TRACKING UPDATE ---
    if (window.supabaseClient && currentUserEmail) {
        await window.supabaseClient
            .from('profiles')
            .update({
                current_stage: 'Tutoring Dashboard',
                stage_started_at: new Date().toISOString()
            })
            .eq('email', currentUserEmail);
    }
    // --------------------------------------

    const characterImages = {
        'pia-open': '/assets/images/char-1.png',
        'pia-conscientious': '/assets/images/char-conscientious.png',
        'pia-extravert': '/assets/images/char-extravert.png',
        'pia-agreeable': '/assets/images/char-agreeable.png',
        'pia-calm': '/assets/images/char-calm.png',
        'pia-neutral': '/assets/images/char-neutral.png'
    };

    if (window.supabaseClient && currentUserEmail) {
        try {
            const { data, error } = await window.supabaseClient
                .from('profiles')
                .select('full_name, selected_character')
                .eq('email', currentUserEmail)
                .single();

            if (data) {
                if (data.full_name) {
                    document.getElementById('welcome-title').textContent = `Welcome, ${data.full_name.split(' ')[0]}!`;
                }
                if (data.selected_character && characterImages[data.selected_character]) {
                    document.getElementById('dashboard-agent-img').src = characterImages[data.selected_character];
                } else {
                    // Fallback sa localStorage kung walang nakuha sa DB
                    loadFromLocalStorage(characterImages);
                }
            } else {
                loadFromLocalStorage(characterImages);
            }
        } catch (err) {
            console.error('Error fetching profile data:', err);
            loadFromLocalStorage(characterImages);
        }
    } else {
        loadFromLocalStorage(characterImages);
    }
});

/**
 * Fallback function to load and render the selected character image from local storage.
 */
function loadFromLocalStorage(characterImages) {
    const savedCharacter = localStorage.getItem('selected_character');
    if (savedCharacter && characterImages[savedCharacter]) {
        document.getElementById('dashboard-agent-img').src = characterImages[savedCharacter];
    }
}

/**
 * Redirects the student to the active math tutoring problem-solving session page.
 */
function startGame() {
    window.location.href = 'tutoring-dashboard.html';
}

/**
 * Clears local session caches and signs out the user back to the landing page.
 */
function handleSignOut() {
    localStorage.removeItem('pia_user_email');
    localStorage.removeItem('selected_character');
    window.location.href = '../../index.html';
}

// Modal Logic
const aboutAgentBtn = document.getElementById('about-agent-btn');
const agentModal = document.getElementById('agent-modal');
const modalBackdrop = document.getElementById('modal-backdrop');
const closeModalBtn = document.getElementById('close-modal-btn');
const modalContent = document.getElementById('modal-content');

/**
 * Opens the 'About the Agent' modal with smooth transition animation.
 */
function openModal() {
    agentModal.classList.remove('hidden');
    setTimeout(() => {
        agentModal.classList.remove('opacity-0');
        modalContent.classList.remove('scale-95');
        modalContent.classList.add('scale-100');
    }, 10);
    document.body.style.overflow = 'hidden';
}

/**
 * Closes the 'About the Agent' modal and restores standard body scrolling.
 */
function closeModal() {
    agentModal.classList.add('opacity-0');
    modalContent.classList.remove('scale-100');
    modalContent.classList.add('scale-95');

    setTimeout(() => {
        agentModal.classList.add('hidden');
        document.body.style.overflow = 'auto';
    }, 300);
}

if (aboutAgentBtn) aboutAgentBtn.addEventListener('click', openModal);
if (closeModalBtn) closeModalBtn.addEventListener('click', closeModal);
if (modalBackdrop) modalBackdrop.addEventListener('click', closeModal);

// Realtime listener para sa Student Dashboard (Mag-a-auto close pag sinara ni admin)
if (window.supabaseClient) {
    window.supabaseClient
        .channel('realtime-dashboard-lock')
        .on(
            'postgres_changes',
            {
                event: 'UPDATE',
                schema: 'public',
                table: 'settings',
                filter: `key=eq.stage_dash`
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