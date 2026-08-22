const gatekeeperScreen = document.getElementById('gatekeeper-screen');
const testContainer = document.getElementById('test-container');

let isTestAllowed = false;
let currentQuestionIndex = 0;
let hasSubmitted = false;

// ANSWER MODEL: 50 na slot, `null` = hindi pa nasasagot.
// Dating push-only array ito (userResponses.push), kaya ang posisyon sa array
// ang siyang nagsasabi kung ilan ang nasagot -- at imposibleng bumalik sa isang
// tanong nang hindi sinisira ang lahat ng sumunod. Kailangan ng navigator grid
// na ma-set ang sagot sa KAHIT ANONG index, kaya indexed na ito.
let userResponses = new Array(50).fill(null);

function answeredCount() {
    return userResponses.reduce((n, v) => n + (v === null ? 0 : 1), 0);
}

function isComplete() {
    return answeredCount() === questions.length;
}

// Session-verified identity lang. Dati, localStorage muna ang binabasa bago
// ang session, kaya spoofable ang target ng lahat ng sumusunod na update().
// Ngayon, wala nang .eq() na target dito: ang identity ng sumusulat ay
// kinukuha na ng mga RPC mismo mula sa JWT (auth.jwt() ->> 'email'), kaya
// wala nang email na ipinapadala ang browser bilang parameter.
let verifiedProfile = null;

const questions = [
    "Am the life of the party.", "Feel little concern for others.", "Am always prepared.", "Get stressed out easily.", "Have a rich vocabulary.",
    "Don't talk a lot.", "Am interested in people.", "Leave my belongings around.", "Am relaxed most of the time.", "Have difficulty understanding abstract ideas.",
    "Feel comfortable around people.", "Insult people.", "Pay attention to details.", "Worry about things.", "Have a vivid imagination.",
    "Keep in the background.", "Sympathize with others' feelings.", "Make a mess of things.", "Seldom feel blue.", "Am not interested in abstract ideas.",
    "Start conversations.", "Am not interested in other people's problems.", "Get chores done right away.", "Am easily disturbed.", "Have excellent ideas.",
    "Have little to say.", "Have a soft heart.", "Often forget to put things back in their proper place.", "Get upset easily.", "Do not have a good imagination.",
    "Talk to a lot of different people at parties.", "Am not really interested in others.", "Like order.", "Change my mood a lot.", "Am quick to understand things.",
    "Don't like to draw attention to myself.", "Take time out for others.", "Shirk my duties.", "Have frequent mood swings.", "Use difficult words.",
    "Don't mind being the center of attention.", "Feel others' emotions.", "Follow a schedule.", "Get irritated easily.", "Spend time reflecting on things.",
    "Am quiet around strangers.", "Make people feel at ease.", "Am exacting in my work.", "Often feel blue.", "Am full of ideas."
];

document.body.style.overflow = 'hidden';

// ==========================================
// IN-PROGRESS PERSISTENCE
// Ang userResponses ay nasa memory lang dati. Ang pagpindot ng Home, ang
// pag-refresh, o ang reload na pinapaputok ng realtime listener ay nagbubura
// ng LAHAT ng nasagot na at nagbabalik sa Question 1 -- 50 tanong ang nawawala
// nang walang babala.
//
// Naka-key sa EMAIL: sa isang shared na lab PC, hindi dapat mamana ng susunod
// na uupo ang sagot ng nauna -- ang hindi tugmang email ay itinatapon.
//
// localStorage, hindi sessionStorage: ang sessionStorage ay nawawala kapag
// isinara ang tab, at ang pagsasara ng browser ang isa sa mga pinakakaraniwang
// paraan ng pagkawala ng progreso sa isang lab. Nililinis ito ng
// executeForceLogout() (localStorage.clear()), kaya hindi ito nabubuhay
// pagkatapos mag-sign out.
// ==========================================
const OCEAN_PROGRESS_KEY = 'pia_ocean_progress';

function saveOceanProgress() {
    if (!verifiedProfile) return;
    try {
        localStorage.setItem(OCEAN_PROGRESS_KEY, JSON.stringify({
            email: verifiedProfile.email,
            responses: userResponses,
            index: currentQuestionIndex
        }));
    } catch (e) { /* storage full o naka-block -- huwag sirain ang test */ }
}

function loadOceanProgress() {
    if (!verifiedProfile) return false;
    try {
        const raw = localStorage.getItem(OCEAN_PROGRESS_KEY);
        if (!raw) return false;
        const saved = JSON.parse(raw);

        // Ibang estudyante ang nag-iwan nito sa PC na ito.
        if (!saved || saved.email !== verifiedProfile.email) {
            localStorage.removeItem(OCEAN_PROGRESS_KEY);
            return false;
        }
        if (!Array.isArray(saved.responses) || saved.responses.length === 0) return false;

        // Tinatanggap ang DALAWANG hugis: ang bagong 50-slot na array na may
        // null, at ang lumang dense na push-only array mula sa naunang bersyon
        // (nakaligtas iyon sa isang bukas na tab habang nag-deploy).
        const restored = new Array(questions.length).fill(null);
        saved.responses.slice(0, questions.length).forEach((v, i) => {
            if (Number.isInteger(v) && v >= 1 && v <= 5) restored[i] = v;
        });
        userResponses = restored;

        // Ibalik sila sa UNANG hindi pa nasasagot, hindi sa dulo -- doon nila
        // talaga kailangang magpatuloy.
        const firstGap = userResponses.indexOf(null);
        currentQuestionIndex = (firstGap === -1)
            ? Math.min(saved.index || 0, questions.length - 1)
            : firstGap;

        return answeredCount() > 0;
    } catch (e) {
        return false;
    }
}

function clearOceanProgress() {
    try { localStorage.removeItem(OCEAN_PROGRESS_KEY); } catch (e) { /* ignore */ }
}

function isTestInProgress() {
    return isTestAllowed && !hasSubmitted && answeredCount() > 0 && !isComplete();
}

async function checkAccessAndInit() {
    // Tinanggal ang dating 5s timeout + `isTestAllowed = true` na catch block:
    // fail-OPEN iyon -- kapag mabagal/nabigo ang network, bumubukas ang test
    // kahit walang session at kahit sarado ang stage. Fail-closed na ngayon:
    // kung hindi ma-verify ang session, nagre-redirect ang guard at hindi
    // kailanman nase-set sa true ang isTestAllowed.
    verifiedProfile = await enforceStudentStage('ocean');
    if (!verifiedProfile) return;

    isTestAllowed = true;

    // May naiwang sagot? Diretso na sa tanong na tinigilan nila.
    if (loadOceanProgress()) {
        gatekeeperScreen.classList.add('hidden');
        testContainer.classList.remove('hidden');
        testContainer.classList.add('fade-in');
        document.body.style.overflow = 'auto';
        initTestUI();
        loadQuestion();
    } else {
        renderGatekeeper();
    }

    setupRealtimeListener();
    setupExitGuard();
}

function renderGatekeeper() {
    if (isTestAllowed) {
        gatekeeperScreen.innerHTML = `
                    <div class="gatekeeper-layout">
                        <div class="gatekeeper-media">
                            <img src="/assets/images/ocean.png" alt="">
                            <div class="gatekeeper-media-fade-mobile"></div>
                            <div class="gatekeeper-media-fade-desktop"></div>
                        </div>
                        <div id="step-container" class="gatekeeper-panel fade-in">
                        </div>
                    </div>
                `;
        showPrivacyStep();
    } else {
        gatekeeperScreen.innerHTML = `
                <div class="gatekeeper-layout">
                    <div class="gatekeeper-media">
                        <img src="/assets/images/board.png" alt="" class="gatekeeper-media-dim">
                    </div>
                    <div class="gatekeeper-panel">
                        <span class="gatekeeper-locked-icon">🔒</span>
                        <h2 class="gatekeeper-locked-title">Assessment Locked</h2>
                        <p class="text-secondary gatekeeper-locked-desc">Sorry, the administrator has closed the OCEAN Personality Assessment stage.</p>
                        <a href="waiting-room.html" class="btn btn-secondary btn-lg">Return to Waiting Room</a>
                    </div>
                </div>
            `;
    }
}

// Unified Realtime Listener para sa pag-Open at pag-Close ng Admin
function setupRealtimeListener() {
    if (supabaseClient) {
        registerChannel('realtime-ocean-stage-sync', (ch) => ch
            .on(
                'postgres_changes',
                {
                    event: '*',
                    schema: 'public',
                    table: 'settings',
                    filter: `key=eq.stage_ocean`
                },
                (payload) => {
                    const isOpen = payload.new.value === true || payload.new.value === 'true';

                    // HUWAG i-reload ang isang test na kasalukuyang sinasagutan.
                    // Dati, ang bawat pagbabago sa stage_ocean ay nagre-reload --
                    // kaya ang isang pagpindot mo sa toggle habang live ang
                    // session ay sabay-sabay na nagbabalik sa Question 1 ng
                    // LAHAT ng estudyanteng nasa gitna ng test. Ligtas na ang
                    // progreso sa localStorage, pero mas mabuting huwag na
                    // silang gambalain.
                    if (isTestInProgress()) return;

                    if (isOpen) {
                        window.location.reload();
                    } else {
                        window.location.href = 'waiting-room.html';
                    }
                }
            )
            .subscribe());
    }
}

function showPrivacyStep() {
    const container = document.getElementById('step-container');
    if (!container) return;
    container.classList.remove('opacity-0');
    container.innerHTML = `
                <div class="fade-in gatekeeper-step">
                    <h2 class="gatekeeper-step-title">Start OCEAN Test</h2>
                    <span class="eyebrow gatekeeper-step-eyebrow">Assessment Setup</span>

                    <div class="privacy-note-box">
                        <h3 class="privacy-note-title">🛡️ Data Privacy Handling</h3>
                        <p class="text-secondary privacy-note-desc">Your responses will be strictly used to determine your learning profile. Your results are encrypted and will not be shared.</p>
                    </div>
                    <div class="gatekeeper-step-actions">
                        <button onclick="startTestDirectly()" class="btn btn-primary btn-lg btn-block">I Agree, Continue</button>
                        <a href="waiting-room.html" class="gatekeeper-return-link">Return to Waiting Room</a>
                    </div>
                </div>
            `;
}

async function startTestDirectly() {
    // I-update agad ang database sa sandaling pumasok ang student sa test.
    // Dumadaan na sa set_student_stage() RPC: sine-check ng server ang
    // prerequisite chain at ang stage flag bago sumulat. Ang direktang
    // .update({ current_stage }) ay hinaharangan na ng profile write guard --
    // iyon ang dating nagpapahintulot sa kahit sinong estudyante na ibigay sa
    // sarili nila ang kahit anong stage sa isang linya sa console.
    if (supabaseClient) {
        await supabaseClient.rpc('set_student_stage', { p_stage: 'OCEAN' });
    }

    gatekeeperScreen.classList.add('opacity-0');
    setTimeout(() => {
        gatekeeperScreen.classList.add('hidden');
        testContainer.classList.remove('hidden');
        testContainer.classList.add('fade-in');
        document.body.style.overflow = 'auto';
        initTestUI();
        loadQuestion();
    }, 500);
}

// Binubuo ang 50-button na navigator at ikinakabit ang lahat ng kontrol.
// Isang beses lang -- pagkatapos ay estado na lang ang ina-update.
let testUIReady = false;

function initTestUI() {
    if (testUIReady) return;
    testUIReady = true;

    const grid = document.getElementById('question-grid');
    if (grid) {
        grid.innerHTML = '';
        for (let i = 0; i < questions.length; i++) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'qgrid-btn';
            b.textContent = String(i + 1);
            b.setAttribute('aria-label', `Question ${i + 1}`);
            b.addEventListener('click', () => goToQuestion(i));
            grid.appendChild(b);
        }
    }

    // Ang mga answer button ay may data-score na (dating inline onclick), kaya
    // isang delegated listener na lang ang kailangan.
    const list = document.getElementById('ocean-answer-list');
    if (list) {
        list.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-score]');
            if (btn) handleAnswer(Number(btn.getAttribute('data-score')));
        });
    }

    document.getElementById('btn-prev')?.addEventListener('click', () => goToQuestion(currentQuestionIndex - 1));
    document.getElementById('btn-next')?.addEventListener('click', () => goToQuestion(currentQuestionIndex + 1));
    document.getElementById('btn-submit-ocean')?.addEventListener('click', () => {
        if (isComplete()) submitTestResults();
    });

    // Arrow keys para sa mabilis na pag-navigate.
    document.addEventListener('keydown', (e) => {
        if (!isTestAllowed || hasSubmitted) return;
        if (document.getElementById('quit-modal')?.classList.contains('modal-active')) return;
        if (e.key === 'ArrowLeft') goToQuestion(currentQuestionIndex - 1);
        if (e.key === 'ArrowRight') goToQuestion(currentQuestionIndex + 1);
    });

    if (typeof lucide !== 'undefined') lucide.createIcons();
}

function goToQuestion(index) {
    if (index < 0 || index >= questions.length) return;
    currentQuestionIndex = index;
    saveOceanProgress();
    loadQuestion();
}

function loadQuestion() {
    initTestUI();

    const total = questions.length;
    const i = currentQuestionIndex;

    document.getElementById('question-counter').textContent = `Question ${i + 1} of ${total}`;
    document.getElementById('question-text').textContent = `I... "${questions[i]}"`;

    // Ang progreso ay batay na sa BILANG NG NASAGOT, hindi sa posisyon --
    // ngayong makakagalaw na sila nang malaya, ang posisyon ay walang sinasabi
    // tungkol sa kung gaano na sila katapos.
    const done = answeredCount();
    document.getElementById('progress-lbl').textContent = `${Math.round((done / total) * 100)}% Completed`;

    const tally = document.getElementById('answered-tally');
    if (tally) tally.textContent = `${done} of ${total} answered`;

    const navCount = document.getElementById('qnav-count');
    if (navCount) navCount.textContent = `${done}/${total}`;

    // I-highlight ang naunang sagot kapag binalikan nila ang tanong.
    document.querySelectorAll('#ocean-answer-list .ocean-answer-btn').forEach(btn => {
        btn.classList.toggle('is-selected', Number(btn.getAttribute('data-score')) === userResponses[i]);
    });

    const prevBtn = document.getElementById('btn-prev');
    const nextBtn = document.getElementById('btn-next');
    if (prevBtn) prevBtn.disabled = (i === 0);
    if (nextBtn) nextBtn.disabled = (i === total - 1);

    document.querySelectorAll('#question-grid .qgrid-btn').forEach((btn, idx) => {
        btn.classList.toggle('is-answered', userResponses[idx] !== null);
        btn.classList.toggle('is-current', idx === i);
    });

    const submitBtn = document.getElementById('btn-submit-ocean');
    const hint = document.getElementById('submit-hint');
    if (submitBtn) submitBtn.disabled = !isComplete();
    if (hint) {
        hint.textContent = isComplete()
            ? 'All questions answered -- ready to submit.'
            : `${total - done} question${total - done === 1 ? '' : 's'} left.`;
    }
}

function handleAnswer(score) {
    userResponses[currentQuestionIndex] = score;
    saveOceanProgress();

    // Sunod na hindi pa nasasagot; kung wala na, manatili at hayaang mag-review
    // sila bago isumite. WALA nang auto-submit: sa malayang pag-navigate,
    // ang pag-abot sa tanong 50 ay hindi na nangangahulugang tapos na sila.
    const nextGap = userResponses.indexOf(null, currentQuestionIndex + 1);
    const anyGap = nextGap === -1 ? userResponses.indexOf(null) : nextGap;

    if (anyGap !== -1) {
        currentQuestionIndex = anyGap;
        saveOceanProgress();
    }

    loadQuestion();
}

async function submitTestResults() {
    // Huling harang bago ang server. Ang submit_ocean_results() ay tumatanggi
    // sa anumang hindi eksaktong 50 na sagot na 1..5, kaya mas mabuting dito
    // pa lang mahuli kaysa magpakita ng error mula sa database.
    if (!isComplete()) {
        const missing = userResponses.indexOf(null);
        goToQuestion(missing);
        return;
    }
    hasSubmitted = true;

    testContainer.innerHTML = `
        <div class="solid-card p-12 text-center space-y-4">
            <h2 class="text-2xl font-bold text-primary">Submitting your assessment...</h2>
            <p class="text-secondary text-sm">Please wait while we save your profile data.</p>
        </div>
    `;

    // SECURITY FIX (CRITICAL): wala nang scoring dito.
    //
    // Dati, ang browser ang kumu-compute ng E/A/C/N/O at direktang isinusulat
    // ang is_ocean_done + ocean_* sa profiles. Ibig sabihin, kayang gawin ng
    // kahit sinong estudyante ang buong personality profile nila nang hindi
    // sinasagutan ang test -- at ang personality ang mismong independent
    // variable ng thesis na ito. Ang paglipat lang ng WRITE sa isang RPC ay
    // hindi sapat: pwede pa rin silang mag-POST ng gawa-gawang score.
    //
    // Kaya ang RAW na 50 sagot (1..5) na ang ipinapadala, at ang SERVER ang
    // nag-i-score gamit ang IPIP-50 key (submit_ocean_results). Ang browser ay
    // wala nang masabi tungkol sa resulta. Naitatago rin ng server ang
    // per-item responses sa ocean_submissions -- dati, itinatapon ang mga ito,
    // kaya imposible ang item analysis / Cronbach's alpha.
    if (!supabaseClient) return;

    const { data, error } = await supabaseClient.rpc('submit_ocean_results', {
        p_responses: userResponses
    });

    if (error) {
        testContainer.innerHTML = `
            <div class="solid-card p-12 text-center space-y-4">
                <h2 class="text-2xl font-bold text-danger">Assessment could not be saved</h2>
                <p class="text-secondary text-sm">${escapeHTML(error.message)}</p>
                <button onclick="window.location.reload()" class="btn btn-primary btn-lg">Try Again</button>
            </div>
        `;
        return;
    }

    // Tapos na -- linisin ang naka-save na progreso para hindi na ito mabuhay
    // muli kung babalik sila sa page na ito.
    clearOceanProgress();

    // Ang server ang nagpasya kung saan sila susunod na pupunta.
    const nextStage = data && data.next_stage;
    const targetUrl = (STAGE_PAGES[nextStage] && STAGE_PAGES[nextStage].url) || 'waiting-room.html';

    setTimeout(() => {
        window.location.href = targetUrl;
    }, 2000);
}

// ==========================================
// EXIT GUARD
// May Home button sa nav ng page na ito. Kung wala ito, isang aksidenteng
// pindot ay nagtatapon sa kanila palabas sa kalagitnaan ng 50 tanong. Naka-save
// na ang progreso, pero sinasabihan pa rin natin sila -- at binibigyan ng
// pagkakataong manatili.
// ==========================================
// Kapag kinumpirma na nilang aalis, hindi na dapat sumingit pa ang native
// beforeunload prompt sa ibabaw ng sarili nating modal.
let isQuittingDeliberately = false;

// Ipinapakita ang custom na quit modal. Nagbabalik ng Promise<boolean>:
// true = aalis, false = mananatili.
function confirmQuit() {
    return new Promise((resolve) => {
        const modal = document.getElementById('quit-modal');
        const box = document.getElementById('quit-modal-content');
        const stayBtn = document.getElementById('quit-modal-stay');
        const leaveBtn = document.getElementById('quit-modal-leave');

        // Kung nawawala ang markup, huwag i-trap ang estudyante -- payagan na
        // lang silang umalis kaysa mag-hang ang page.
        if (!modal || !box || !stayBtn || !leaveBtn) return resolve(true);

        const answered = answeredCount();
        const total = questions.length;
        const pct = Math.round((answered / total) * 100);

        const countEl = document.getElementById('quit-progress-count');
        const fillEl = document.getElementById('quit-progress-fill');
        if (countEl) countEl.textContent = `${answered} of ${total}`;
        if (fillEl) fillEl.style.width = `${pct}%`;

        modal.classList.add('modal-active');
        box.classList.add('modal-content-active');
        modal.setAttribute('aria-hidden', 'false');
        document.body.style.overflow = 'hidden';

        if (typeof lucide !== 'undefined') lucide.createIcons();

        // Ang ligtas na opsyon ang naka-focus: ang isang pagpindot ng Enter ay
        // nagpapatuloy sa test, hindi umaalis dito.
        stayBtn.focus();

        const close = (result) => {
            modal.classList.remove('modal-active');
            box.classList.remove('modal-content-active');
            modal.setAttribute('aria-hidden', 'true');
            document.body.style.overflow = 'auto';

            stayBtn.removeEventListener('click', onStay);
            leaveBtn.removeEventListener('click', onLeave);
            modal.removeEventListener('click', onBackdrop);
            document.removeEventListener('keydown', onKey);

            resolve(result);
        };

        function onStay() { close(false); }
        function onLeave() { close(true); }
        function onBackdrop(e) { if (e.target === modal) close(false); }
        function onKey(e) {
            if (e.key === 'Escape') close(false);
            if (e.key === 'Tab') {
                // Panatilihin ang focus sa loob ng modal.
                const focusables = [stayBtn, leaveBtn];
                const i = focusables.indexOf(document.activeElement);
                if (i !== -1) {
                    e.preventDefault();
                    focusables[(i + (e.shiftKey ? -1 : 1) + focusables.length) % focusables.length].focus();
                }
            }
        }

        stayBtn.addEventListener('click', onStay);
        leaveBtn.addEventListener('click', onLeave);
        modal.addEventListener('click', onBackdrop);
        document.addEventListener('keydown', onKey);
    });
}

// ==========================================
// EXIT GUARD
// May Home button sa nav ng page na ito. Kung wala ito, isang aksidenteng
// pindot ay nagtatapon sa kanila palabas sa kalagitnaan ng 50 tanong. Naka-save
// na ang progreso, pero sinasabihan pa rin natin sila -- at binibigyan ng
// pagkakataong manatili.
// ==========================================
function setupExitGuard() {
    document.querySelectorAll('a[href]').forEach(link => {
        link.addEventListener('click', async (e) => {
            if (!isTestInProgress() || isQuittingDeliberately) return;

            // Kailangang pigilan agad ang navigation -- async ang modal.
            e.preventDefault();
            const href = link.href;

            if (await confirmQuit()) {
                isQuittingDeliberately = true;   // pigilan ang beforeunload
                window.location.href = href;
            }
        });
    });

    // Ang refresh at ang pagsara ng tab ay HINDI kayang gamitan ng custom na
    // modal -- pinipilit ng browser ang sarili nitong dialog dito. Nananatili
    // ito bilang huling sapin, pero hindi ito pumuputok kapag ang estudyante
    // mismo ang pumili ng "Quit for now" sa modal natin.
    window.addEventListener('beforeunload', (e) => {
        if (!isTestInProgress() || isQuittingDeliberately) return;
        e.preventDefault();
        e.returnValue = '';
    });
}

checkAccessAndInit();