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
    startStageHeartbeat('Character Selection');
}

// Run check immediately
enforceStageLock();

/* The picked tutor stands in the room on the right: a picture, a line in the speech bubble, and a tap on the
   picture changes the expression and the line (poses and lines come from the card, the same as the landing page). */
let poses = [];
let lines = [];
let poseIndex = 0;

function showPose() {
    const img = document.getElementById('preview-bg-img');
    if (poses.length) { img.src = poses[poseIndex % poses.length]; }
    if (lines.length) { document.getElementById('preview-desc').textContent = lines[poseIndex % lines.length]; }
}

function hopBig() {
    const big = document.getElementById('pick-big');
    big.classList.remove('is-hop');
    void big.offsetWidth;                       // restart the animation
    big.classList.add('is-hop');
}

function previewCharacter(element) {
    if (isLockedIn) return;

    document.querySelectorAll('.persona-card').forEach(card => {
        card.classList.remove('selected');
        card.setAttribute('aria-pressed', 'false');
    });

    element.classList.add('selected');
    element.setAttribute('aria-pressed', 'true');

    selectedChar = element.getAttribute('data-character');
    const name = element.getAttribute('data-name');
    poses = (element.getAttribute('data-poses') || '').split(/\s+/).filter(Boolean);
    lines = (element.getAttribute('data-lines') || '').split('|').filter(Boolean);
    poseIndex = 0;

    document.getElementById('preview-name').textContent = name;
    document.getElementById('pick-hello').textContent = 'Say hi to ' + name + '!';
    document.getElementById('pick-big').setAttribute('aria-label', 'Tap ' + name + ' to hear more');
    document.getElementById('pick-big').hidden = false;
    document.getElementById('pick-bubble').hidden = false;
    document.getElementById('preview-card').classList.add('has-pick');
    showPose();
    hopBig();

    const lockBtn = document.getElementById('lock-in-btn');
    lockBtn.hidden = false;
    lockBtn.textContent = 'Choose ' + name;
    lockBtn.disabled = false;
}

/* Tap the tutor: the next expression and the next line. */
function nextPose() {
    if (isLockedIn || poses.length < 2) { hopBig(); return; }
    poseIndex = (poseIndex + 1) % poses.length;
    showPose();
    hopBig();
}

// Keyboard handling for the irreversible lock-in dialog: focus starts on the
// safe "Let me look again" button, Tab stays inside, Escape = look again, and
// focus returns to the control that opened it. Selection logic is untouched.
let confirmReturnFocus = null;

function confirmModalKeys(e) {
    const modal = document.getElementById('confirm-modal');
    if (!modal || !modal.classList.contains('modal-active')) return;
    if (e.key === 'Escape') { e.preventDefault(); closeConfirmModal(); return; }
    if (e.key !== 'Tab') return;
    const nodes = Array.from(modal.querySelectorAll('button:not([disabled])'));
    if (!nodes.length) return;
    const first = nodes[0], last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

function openConfirmModal() {
    if (!selectedChar || isLockedIn) return;
    const modal = document.getElementById('confirm-modal');
    const content = document.getElementById('modal-content');

    confirmReturnFocus = document.activeElement;
    modal.classList.add('modal-active');
    content.classList.add('modal-content-active');
    document.addEventListener('keydown', confirmModalKeys);
    const safe = modal.querySelector('.modal-foot [data-action="close"]');
    if (safe) safe.focus({ preventScroll: true });
}

function closeConfirmModal() {
    const modal = document.getElementById('confirm-modal');
    const content = document.getElementById('modal-content');

    modal.classList.remove('modal-active');
    content.classList.remove('modal-content-active');
    document.removeEventListener('keydown', confirmModalKeys);
    if (confirmReturnFocus && confirmReturnFocus.focus && !confirmReturnFocus.disabled) {
        confirmReturnFocus.focus({ preventScroll: true });
    }
    confirmReturnFocus = null;
}

async function finalLockIn() {
    if (!selectedChar) return;
    if (!verifiedEmail) return; // hindi pa kumpirmado ng guard ang session

    // Double-tap guard: without it two quick taps send two updates.
    const lockBtn = document.getElementById('lock-in-btn');
    if (lockBtn) {
        if (lockBtn.dataset.busy === '1') return;
        lockBtn.dataset.busy = '1';
        lockBtn.disabled = true;
    }

    // Session-verified email, hindi na ang spoofable na localStorage value.
    const { error } = await supabaseClient
        .from('profiles')
        .update({ selected_character: selectedChar })
        .eq('email', verifiedEmail);

    if (error) {
        const status = document.getElementById('status-text');
        if (status) {
            status.textContent = 'Not saved. Please try again.';
            status.style.color = 'var(--danger)';
        }
        const btn = document.getElementById('lock-in-btn');
        if (btn) {
            btn.disabled = false;
            btn.textContent = 'Try again';
        }
        closeConfirmModal();
        console.error('Could not save selection:', error.message);
        return;
    }

    localStorage.setItem('selected_character', selectedChar);

    // The final payload: locks the seconds spent on this stage.
    await finalizeStageTime('Character Selection');

    closeConfirmModal();

    isLockedIn = true;
    const statusEl = document.getElementById('status-text');
    statusEl.textContent = 'Locked in!';
    statusEl.style.color = '';
    statusEl.classList.add('is-done');

    /* The picked tutor stays up front, happy; the others sit back and cannot be pressed (see .is-locked in student-paper.css). */
    const happy = poses.findIndex(src => /happy|approval/.test(src));
    if (happy !== -1) { poseIndex = happy; }
    const name = document.getElementById('preview-name').textContent;
    document.getElementById('pick-hello').textContent = 'You picked ' + name + '!';
    document.getElementById('preview-desc').textContent = 'Great choice! Let’s do this together.';
    const img = document.getElementById('preview-bg-img');
    if (poses.length) { img.src = poses[poseIndex % poses.length]; }
    document.getElementById('pick-scene').classList.add('is-locked');
    hopBig();

    document.querySelectorAll('.persona-card').forEach(card => {
        card.style.pointerEvents = 'none';
        card.disabled = true;
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

// Every control on the page is wired here, not with onclick="" attributes:
// the site's Content-Security-Policy (_headers) forbids inline script, and an
// inline handler counts as inline script. One delegated listener serves the
// six tutor cards and every button that carries data-action.
const ACTIONS = {
    confirm: openConfirmModal,
    continue: goToDashboard,
    close: closeConfirmModal,
    lock: finalLockIn
};

document.addEventListener('click', (event) => {
    const card = event.target.closest('.persona-card');
    if (card) { previewCharacter(card); return; }

    if (event.target.closest('#pick-big')) { nextPose(); return; }

    const control = event.target.closest('[data-action]');
    if (!control || control.disabled) return;
    const run = ACTIONS[control.getAttribute('data-action')];
    if (run) run();
});

// Try the previous tutor illustration if a persona image is unavailable.
// Only show initials if both images fail.
(function wireArtFallback() {
    function monogram(name) {
        return (name || 'PIA').replace(/^PIA\s*/i, '').slice(0, 2).toUpperCase() || 'PIA';
    }

    document.querySelectorAll('.persona-card').forEach(function (card) {
        var img = card.querySelector('img');
        var box = card.querySelector('.persona-thumb');
        if (!img || !box) { return; }
        function useFallbackOrMonogram() {
            var fallback = card.getAttribute('data-fallback-img');
            if (fallback && img.getAttribute('src') !== fallback) {
                img.src = fallback;
            } else {
                box.setAttribute('data-mono', monogram(card.getAttribute('data-name')));
            }
        }
        img.addEventListener('error', useFallbackOrMonogram);
        if (img.complete && img.naturalWidth === 0) {
            useFallbackOrMonogram();
        }
    });

    /* The big picture: if a pose is missing, the card's other illustration stands in; if that fails too, the tutor's
       line is still there in the bubble. */
    var previewImg = document.getElementById('preview-bg-img');
    previewImg.addEventListener('error', function () {
        var chosen = document.querySelector('.persona-card.selected');
        var fallback = chosen && chosen.getAttribute('data-fallback-img');
        if (fallback && previewImg.getAttribute('src') !== fallback) {
            previewImg.src = fallback;
        } else {
            previewImg.style.visibility = 'hidden';
        }
    });
    previewImg.addEventListener('load', function () { previewImg.style.visibility = ''; });
})();
