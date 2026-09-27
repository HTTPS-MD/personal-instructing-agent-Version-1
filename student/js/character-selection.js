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

    document.querySelectorAll('.persona-card').forEach(card => {
        card.classList.remove('selected');
        card.setAttribute('aria-pressed', 'false');
        const img = card.querySelector('.agent-img-thumbnail');
        if (img) img.classList.add('grayscale');
    });

    element.classList.add('selected');
    element.setAttribute('aria-pressed', 'true');
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
            status.textContent = 'NOT SAVED';
            status.style.color = 'var(--danger)';
        }
        const btn = document.getElementById('lock-in-btn');
        if (btn) {
            btn.disabled = false;
            btn.textContent = 'Try locking in again';
        }
        closeConfirmModal();
        console.error('Could not save selection:', error.message);
        return;
    }

    localStorage.setItem('selected_character', selectedChar);

    closeConfirmModal();

    isLockedIn = true;
    const statusEl = document.getElementById('status-text');
    statusEl.textContent = 'LOCKED IN';
    statusEl.style.color = 'var(--accent)';

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

    const control = event.target.closest('[data-action]');
    if (!control || control.disabled) return;
    const run = ACTIONS[control.getAttribute('data-action')];
    if (run) run();
});

// Persona art fallback. A missing illustration marks its container with
// the persona's initials; CSS then renders a tinted monogram in place of
// the broken image. Wired before first paint so nothing flashes.
(function wireArtFallback() {
    function monogram(name) {
        return (name || 'PIA').replace(/^PIA\s*/i, '').slice(0, 2).toUpperCase() || 'PIA';
    }

    document.querySelectorAll('.persona-card').forEach(function (card) {
        var img = card.querySelector('img');
        var box = card.querySelector('.persona-thumb');
        if (!img || !box) { return; }
        img.addEventListener('error', function () {
            box.setAttribute('data-mono', monogram(card.getAttribute('data-name')));
        }, { once: true });
        if (img.complete && img.naturalWidth === 0) {
            box.setAttribute('data-mono', monogram(card.getAttribute('data-name')));
        }
    });

    var preview = document.querySelector('.preview-portrait');
    var previewImg = document.getElementById('preview-bg-img');
    function markPreview() {
        // Derive the monogram from the SELECTED card, never from the
        // preview heading — before a pick that heading is placeholder
        // copy ("No one chosen yet"), which produced a stray "NO".
        var chosen = document.querySelector('.persona-card.selected');
        preview.setAttribute('data-mono',
            chosen ? monogram(chosen.getAttribute('data-name')) : '·');
    }
    previewImg.addEventListener('error', markPreview);
    // previewCharacter() swaps the src; re-arm the check after each swap.
    new MutationObserver(function () {
        preview.removeAttribute('data-mono');
        if (previewImg.complete && previewImg.naturalWidth === 0) { markPreview(); }
    }).observe(previewImg, { attributes: true, attributeFilter: ['src'] });
    if (previewImg.complete && previewImg.naturalWidth === 0) { markPreview(); }
})();
