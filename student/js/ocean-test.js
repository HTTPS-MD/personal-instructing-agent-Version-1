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

// Ang 50 pahayag ng BFPT, galing sa assets/js/bfpt-items.js -- iisang listahan
// para sa page na ito at sa results drawer ng admin. Na-tsek na item-by-item
// laban sa 20260722_Table BFPT.pdf. POSISYON ang basehan ng scoring sa server
// (sagot 1 = item 1), kaya hindi dapat baguhin ang pagkakasunod nito.
const questions = window.PIA_BFPT.items;

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
            <div class="gate-wrap">
                <div id="step-container"></div>
            </div>
        `;
        showPrivacyStep();
    } else {
        gatekeeperScreen.innerHTML = `
            <div class="gate-wrap">
                <div class="gate-glyph is-locked">
                    <svg class="icon icon-lg"><use href="#i-lock"></use></svg>
                </div>
                <h1 class="gate-title">Not open yet</h1>
                <p class="gate-lede">
                    Your teacher hasn't started the questionnaire. Head back to the waiting
                    room and it will bring you here automatically when it opens.
                </p>
                <div class="gate-actions">
                    <a href="waiting-room.html" class="btn btn-secondary btn-block">Back to the waiting room</a>
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
    container.innerHTML = `
        <div class="gate-glyph">
            <svg class="icon icon-lg"><use href="#i-brain"></use></svg>
        </div>
        <h1 class="gate-title">A few questions about you</h1>
        <p class="gate-lede">
            There are 50 short statements, and there are no right or wrong answers —
            read each one as starting with "I…" and choose how much you agree or
            disagree. It takes about ten minutes, and you can go back and change any
            answer before you submit.
        </p>

        <div class="privacy-box">
            <svg class="icon"><use href="#i-shield"></use></svg>
            <div>
                <p class="privacy-title">Your answers are private</p>
                <p class="privacy-text">
                    They are used only to set up your tutor. Your classmates never see them,
                    and this is not graded — it does not affect your marks in any way.
                </p>
            </div>
        </div>

        <div class="gate-actions">
            <button type="button" onclick="startTestDirectly()" class="btn btn-primary btn-block">
                I understand — start
            </button>
            <a href="waiting-room.html" class="btn btn-secondary btn-block">Not right now</a>
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

    gatekeeperScreen.classList.add('hidden');
    testContainer.classList.remove('hidden');
    document.body.style.overflow = 'auto';
    initTestUI();
    loadQuestion();
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

    // Ang label ng bawat sagot ay galing sa scale ng BFPT sheet (1 = Disagree
    // ... 5 = Agree), para iisa ang wording dito at sa admin drawer.
    document.querySelectorAll('#ocean-answer-list button[data-score]').forEach(btn => {
        const label = window.PIA_BFPT.labelFor(Number(btn.getAttribute('data-score')));
        const slot = btn.querySelector('.answer-label');
        if (label && slot) slot.textContent = label;
    });

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
    const pctDone = Math.round((done / total) * 100);
    document.getElementById('progress-lbl').textContent = `${pctDone}% completed`;

    const fill = document.getElementById('ocean-progress-fill');
    if (fill) fill.style.width = `${pctDone}%`;

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
        <div class="state-card">
            <div class="spinner" aria-hidden="true"></div>
            <h2>Saving your answers…</h2>
            <p>This only takes a moment. Please don't close this page.</p>
        </div>
    `;

    // Walang scoring dito, at walang resultang bumabalik dito.
    //
    // Ang RAW na 50 sagot (1..5) lang ang ipinapadala. Ang server ang
    // nag-i-score gamit ang scoring sheet ng BFPT (public.pia_bfpt_score,
    // migration 0018) at itinatago ang resulta sa ocean_submissions -- na
    // admin LAMANG ang nakakabasa. Ang ibinabalik ng RPC ay { next_stage }
    // lang: walang score, trait o persona na umaabot sa browser ng
    // estudyante, kahit sa network tab.
    if (!supabaseClient) return;

    const { error } = await supabaseClient.rpc('submit_ocean_results', {
        p_responses: userResponses
    });

    if (error) {
        testContainer.innerHTML = `
            <div class="state-card">
                <h2>We couldn't save your answers</h2>
                <p>${escapeHTML(error.message)}</p>
                <p style="margin-top:12px">Your answers are still saved on this computer, so
                   nothing is lost — try again.</p>
                <button onclick="window.location.reload()" class="btn btn-primary">Try again</button>
            </div>
        `;
        return;
    }

    // Tapos na -- linisin ang naka-save na progreso para hindi na ito mabuhay
    // muli kung babalik sila sa page na ito.
    clearOceanProgress();

    // Diretso sa simpleng thank-you screen. replace(), hindi href: ang Back
    // button ay hindi dapat magbalik sa isang questionnaire na naisumite na.
    // Ang thank-you page na ang bahala sa kung saan sila susunod.
    window.location.replace('assessment-complete.html');
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