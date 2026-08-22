// Supabase Configuration & Initialization ay nasa function.js na

/**
 * Initializes the student dashboard upon DOM content loading.
 * Enforces stage accessibility locks, validates student session identity,
 * updates real-time tracking status to 'Tutoring Dashboard', and loads user profile details.
 */
document.addEventListener('DOMContentLoaded', async () => {
    lucide.createIcons();

    // --- STRICT GATEKEEPER CHECK ON LOAD ---
    // Dating stage_dash flag lang + localStorage email. Kaya kayang laktawan
    // ang OCEAN test at character selection sa pamamagitan lang ng pag-type
    // ng URL. Nasa enforceStudentStage('dash') na ang session + buong chain.
    const profile = await enforceStudentStage('dash');
    if (!profile) return;

    const currentUserEmail = profile.email; // verified, hindi galing localStorage
    // --------------------------------------------

    // --- REALTIME ADMIN TRACKING UPDATE ---
    // Dumadaan na sa set_student_stage() RPC (hinaharangan na ng profile write
    // guard ang direktang pagsulat sa current_stage). Kung sinara na pala ng
    // admin ang stage, 'Waiting Room' ang ibinabalik ng server -- sundin natin,
    // sa halip na manatili sa isang page na hindi na dapat bukas.
    const { data: stageRes } = await window.supabaseClient
        .rpc('set_student_stage', { p_stage: 'Tutoring Dashboard' });

    if (stageRes && stageRes.granted === false) {
        window.location.replace('waiting-room.html');
        return;
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
    document.getElementById('dashboard-agent-img').addEventListener('error', function () {
        this.src = '/assets/images/char-1.png';
    }, { once: true });

    if (window.supabaseClient && currentUserEmail) {
        try {
            const { data, error } = await window.supabaseClient
                .from('profiles')
                // RESEARCH INTEGRITY: ocean_* is deliberately NOT selected.
                // The Big Five breakdown must not reach the student's browser
                // at all -- not merely be hidden with CSS. A student who learns
                // they scored low on Conscientiousness may behave differently
                // for the rest of the study, which would contaminate the very
                // measure the thesis depends on. Scores are for the admin and
                // researcher views only.
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
                renderOceanProfile(data);
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
 * Panelist Revision: nagpapakita ng UI indicator na integrated ang OCEAN Test
 * sa system -- nire-render ang Big Five trait breakdown ng estudyante bilang
 * mga proportional bars sa Learning Profile card.
 */
// Dating ipinapakita nito ang lahat ng limang OCEAN trait bilang porsyento.
// Wala nang score na ipinapakita: kinukumpirma lang nito na tapos na ang
// assessment at may naka-match nang agent. Ang mga numero ay nasa admin view.
function renderOceanProfile(profile) {
    const container = document.getElementById('ocean-trait-bars');
    if (!container) return;

    container.innerHTML = `
        <p class="ocean-profile-empty">
            Tapos na ang iyong assessment. Ang iyong agent ay naitugma na sa
            iyong learning profile -- handa ka nang magsimula!
        </p>
    `;
}

/**
 * Redirects the student to the active math tutoring problem-solving session page.
 */
function startGame() {
    window.location.href = 'tutoring-dashboard.html';
}

/**
 * Dating nag-aalis lang ng dalawang localStorage key at hindi kailanman
 * tumatawag ng auth.signOut() -- kaya nananatili ang buong Supabase session sa
 * PC. (Hindi rin ito kailanman na-wire sa kahit anong button.) Ang shared na
 * executeForceLogout() na ang gumagawa ng totoong trabaho: device release,
 * global signOut, at storage cleanup.
 */
function handleSignOut() {
    return executeForceLogout();
}

// Modal Logic
const aboutAgentBtn = document.getElementById('about-agent-btn');
const agentModal = document.getElementById('agent-modal');
const closeModalBtn = document.getElementById('close-modal-btn');
const modalContent = document.getElementById('modal-content');

/**
 * Opens the 'About the Agent' modal with smooth transition animation.
 */
function openModal() {
    agentModal.classList.add('modal-active');
    modalContent.classList.add('modal-content-active');
    document.body.style.overflow = 'hidden';
}

/**
 * Closes the 'About the Agent' modal and restores standard body scrolling.
 */
function closeModal() {
    agentModal.classList.remove('modal-active');
    modalContent.classList.remove('modal-content-active');
    document.body.style.overflow = 'auto';
}

if (aboutAgentBtn) aboutAgentBtn.addEventListener('click', openModal);
if (closeModalBtn) closeModalBtn.addEventListener('click', closeModal);
if (agentModal) agentModal.addEventListener('click', (e) => {
    if (e.target === agentModal) closeModal();
});

// Realtime listener para sa Student Dashboard (Mag-a-auto close pag sinara ni admin)
if (window.supabaseClient) {
    registerChannel('realtime-dashboard-lock', (ch) => ch
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
        .subscribe());
}
