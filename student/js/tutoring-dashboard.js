// ==========================================
// PIA TUTORING ENGINE
// Core loop: present problem -> validate answer -> classify attempt (Decision
// Tree) -> adapt difficulty -> sync progress to Supabase (para makita ng admin
// "Active Game" live view) -> next problem / end session.
// ==========================================

// Ang tatlong tuntunin ng Decision Tree (30s na 'fast' threshold, +1 level
// kada 3 sunod-sunod na smooth, -1 kada 2 struggling) ay NASA SERVER na --
// tingnan ang pia_replay_decision_tree() at record_problem_result_v2() sa
// supabase/migrations/20260822_0004_server_side_tutoring.sql. Sinasadyang
// wala nang kopya rito: kung dalawa ang pinagmumulan, tiyak na maghihiwalay
// sila, at ang naitala sa DB ang siyang mananaig sa research data.
const SESSION_TARGET = 10;
const MAX_ATTEMPTS_PER_PROBLEM = 2;

const characterImages = {
    'pia-open': '/assets/images/char-1.png',
    'pia-conscientious': '/assets/images/char-conscientious.png',
    'pia-extravert': '/assets/images/char-extravert.png',
    'pia-agreeable': '/assets/images/char-agreeable.png',
    'pia-calm': '/assets/images/char-calm.png',
    'pia-neutral': '/assets/images/char-neutral.png'
};

// Anim na "facial expression" states -- isang trait color/ring (OCEAN persona)
// + isang mood icon (kasalukuyang emosyon batay sa laro). Walang hiwalay na
// portrait art pa per-trait kaya ito ang proxy: kulay ng ring = persona,
// icon sa badge = reaction sa kasalukuyang sagot/hint/streak.
const TRAIT_CLASSES = {
    'pia-open': 'agent-trait-open',
    'pia-conscientious': 'agent-trait-conscientious',
    'pia-extravert': 'agent-trait-extravert',
    'pia-agreeable': 'agent-trait-agreeable',
    'pia-calm': 'agent-trait-calm',
    'pia-neutral': 'agent-trait-neutral'
};

const EXPRESSION_ICONS = {
    idle: 'smile',
    thinking: 'lightbulb',
    happy: 'party-popper',
    encouraging: 'heart',
    concerned: 'frown',
    excited: 'star'
};

// C4 -- Tang et al. (2025) found the pedagogical agent slightly DEPRESSED
// transfer while emotional feedback RAISED engagement, and advised caution
// "to avoid potential distractions during the learning process". So the agent
// is not given constant visual weight: this map decides how loud it is
// allowed to be for a given mood, and the CSS does the rest via
// [data-agent-state] on .tut-workspace.
//
//   solving  -> desaturated, smaller, neutral bubble. The state the learner
//               is in while actually thinking, i.e. while an agent hurts.
//   correct  -> full colour + a short spring, mint bubble.
//   retry    -> full colour, coral bubble. Never red.
const EXPRESSION_STATES = {
    idle: 'solving',
    thinking: 'solving',
    happy: 'correct',
    excited: 'correct',
    encouraging: 'retry',
    concerned: 'retry'
};

const gameState = {
    email: null,
    sessionId: null, // server-issued game session (nagtatali sa attempt limits)
    accessToken: null, // naka-cache para gumana ang pagehide beacon (async ang getSession())
    // AUTHORITATIVE MULA SA SERVER. Ang Decision Tree ay tumatakbo na sa
    // pia_replay_decision_tree(), at ang level ay ibinabalik ng serve_problem()
    // at record_problem_result_v2(). Display lang ang silbi ng mga ito dito --
    // wala nang naka-depende sa kanila na naitatalang datos.
    level: 1,
    hintsAvailable: 0, // ilang hint meron ang problemang ito (sinasabi ng server)
    pendingProblemId: null, // problemang naiwang hindi nasagot noong umalis sila
    lastSubmittedValue: null, // huling na-parse na sagot -- ipinapadala sa recorder
    servedIds: new Set(), // problem_id na naipakita na sa session na ito
    isSubmitting: false,  // in-flight guard laban sa double-submit
    currentProblem: null,
    attemptsThisProblem: 0,
    hintsUsedThisProblem: 0,
    hintsUsedTotal: 0,
    consecutiveCorrect: 0,
    problemsAnswered: 0,
    currentProblemNumber: 0, // 1-based index ng problem na nasa screen ngayon

    correctCount: 0,
    medals: []
};

// ==========================================
// INIT
// ==========================================
document.addEventListener('DOMContentLoaded', async () => {
    // Session + buong prerequisite chain (dating stage_dash flag lang +
    // localStorage email, kaya direct-URL accessible nang walang OCEAN test).
    const profile = await enforceStudentStage('dash');
    if (!profile) return;
    gameState.email = profile.email;

    // Kailangan ng raw token para sa pagehide beacon sa dulo ng file -- async
    // ang getSession(), at hindi na ito maaasahan sa oras ng pagsara ng tab.
    const { data: { session } } = await window.supabaseClient.auth.getSession();
    gameState.accessToken = session?.access_token || null;

    // Kailangang may server-issued session bago makapagsimula -- dito nakatali
    // ang per-problem attempt limits. Walang session = walang laro (fail-closed).
    if (!await startGameSession()) {
        showFeedback('incorrect', 'Hindi makapagsimula ng session. Pakisubukan ulit mamaya.');
        return;
    }

    await loadAgentAvatar();
    await markGameStarted();
    renderMedals();
    updateProgressUI();

    // Kung may naiwang problema noong umalis sila, ibalik mismo iyon.
    // Kung wala, tuloy sa susunod na bagong problema.
    if (gameState.pendingProblemId) {
        const pending = findProblemById(gameState.pendingProblemId);
        gameState.pendingProblemId = null;
        if (pending) {
            await presentProblem(pending);
        } else {
            loadNextProblem();
        }
    } else {
        loadNextProblem();
    }

    setupRealtimeStageListener();
});

// Humihingi ng session sa server -- IPINAGPAPATULOY ang naiwan kung meron,
// bago pa gumawa ng bago.
//
// Dati, palaging start_game_session() ang tinatawag dito, at isinasara niyon
// ang naunang session at nagsisimula sa problem 1. Kaya ang estudyanteng
// pumindot ng "Home" at bumalik sa "Mission" ay nawawalan ng buong progreso,
// at naiiwan ang kalahating session bilang abandonadong record sa research
// data. Karaniwan ito sa isang computer lab kung saan may nag-a-alt-tab.
//
// Ang resume_or_start_game_session() ang nagpapasya sa server: kung may
// session na sinimulan pero hindi natapos, iyon ang ibinabalik kasama ang
// progreso; kung wala, bagong session ang ibinibigay.
async function startGameSession() {
    if (!window.supabaseClient) return false;

    const { data, error } = await window.supabaseClient.rpc('resume_or_start_game_session');
    if (error || !data || !data.session_id) {
        console.error('Could not start/resume game session:', error?.message);
        return false;
    }

    gameState.sessionId = data.session_id;

    // Ang server ang may hawak ng totoong progreso -- ito ay display state lang.
    gameState.problemsAnswered   = Number(data.problems_answered) || 0;
    gameState.correctCount       = Number(data.correct_count) || 0;
    gameState.level              = Number(data.level) || 1;
    gameState.consecutiveCorrect = Number(data.consecutive_correct) || 0;
    gameState.pendingProblemId   = data.pending_problem_id || null;

    // Hindi na muling ipapakita ang mga naipakita na sa session na ito.
    gameState.servedIds = new Set(Array.isArray(data.served_problem_ids) ? data.served_problem_ids : []);

    if (data.resumed) {
        // Ibalik ang medals na dapat ay nakuha na sa naabot na level.
        if (gameState.level >= 2 && !gameState.medals.includes('Silver')) gameState.medals.push('Silver');
        if (gameState.level >= 3 && !gameState.medals.includes('Gold')) gameState.medals.push('Gold');
        setAgentSpeech('Balik ka na! Ituloy natin kung saan tayo tumigil.');
    }

    return true;
}

// Hinahanap ang isang problema sa bank gamit ang id nito (para sa resume).
function findProblemById(id) {
    for (const lvl of Object.keys(MATH_PROBLEMS)) {
        const found = (MATH_PROBLEMS[lvl] || []).find(p => p.id === id);
        if (found) return found;
    }
    return null;
}

async function loadAgentAvatar() {
    const img = document.getElementById('agent-avatar-img');
    const wrap = document.getElementById('agent-avatar-wrap');
    if (!img) return;
    img.addEventListener('error', () => { img.src = '/assets/images/char-1.png'; }, { once: true });

    let character = localStorage.getItem('selected_character');
    if (window.supabaseClient && gameState.email) {
        const { data } = await window.supabaseClient.from('profiles').select('selected_character').eq('email', gameState.email).maybeSingle();
        if (data && data.selected_character) character = data.selected_character;
    }
    img.src = characterImages[character] || '/assets/images/char-1.png';

    if (wrap) {
        Object.values(TRAIT_CLASSES).forEach(cls => wrap.classList.remove(cls));
        wrap.classList.add(TRAIT_CLASSES[character] || 'agent-trait-neutral');
    }
    setAgentExpression('idle');
}

// Nagpapalit ng "facial expression" badge ng agent (icon + subtle pulse) batay
// sa kasalukuyang reaction: idle / thinking / happy / encouraging / concerned / excited.
function setAgentExpression(mood) {
    const badge = document.getElementById('agent-expression-badge');
    if (!badge) return;
    const iconName = EXPRESSION_ICONS[mood] || EXPRESSION_ICONS.idle;

    const workspace = document.getElementById('problem-screen');
    if (workspace) workspace.dataset.agentState = EXPRESSION_STATES[mood] || 'solving';

    badge.innerHTML = `<i data-lucide="${iconName}" class="icon-sm"></i>`;
    badge.classList.remove('agent-expression-pulse');
    void badge.offsetWidth; // restart animation
    badge.classList.add('agent-expression-pulse');

    if (typeof lucide !== 'undefined') lucide.createIcons();
}

async function markGameStarted() {
    if (!window.supabaseClient || !gameState.email) return;
    await window.supabaseClient.from('profiles').update({
        is_in_game: true,
        current_difficulty: `Level ${gameState.level}`,
        hints_used: 0,
        consecutive_correct: 0
    }).eq('email', gameState.email);
}

function setupRealtimeStageListener() {
    if (!window.supabaseClient) return;
    registerChannel('realtime-tutoring-lock', (ch) => ch
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'settings', filter: `key=eq.stage_dash` }, (payload) => {
            const isOpen = payload.new.value === true || payload.new.value === 'true';
            if (!isOpen) window.location.href = 'waiting-room.html';
        })
        .subscribe());
}

// ==========================================
// PROBLEM SELECTION
// Dati: isang pool bawat level, at kapag naubos ay ini-reshuffle at inuulit.
// Sa isang 10-problem session, ang estudyanteng nanatili sa Level 1 (6 na
// problema lang noon) ay nakakakuha ng ULIT na problema mula sa ika-7. Ang
// server ay naka-lock per (session, problem_id) -- kasama ang mga nasagot nang
// tama -- kaya ang inulit na problema ay AGAD na `locked`, at naitatala bilang
// MALI nang hindi man lang nabibigyan ng pagkakataong sumagot ang estudyante.
// Ang pinaka-struggling na estudyante ang pinakatinatamaan nito, at sila mismo
// ang cohort na sinusukat ng thesis.
//
// Ngayon: 10 na ang problema bawat level (>= SESSION_TARGET), at hindi na
// muling pinipili ang naipakita nang problem_id. Dalawang beses nang hindi
// posible ang pag-uulit -- structural at logical.
// ==========================================
function pickNextProblem() {
    const unseenAt = (lvl) => (MATH_PROBLEMS[lvl] || []).filter(p => !gameState.servedIds.has(p.id));

    // 1) Unahin ang kasalukuyang level.
    let candidates = unseenAt(gameState.level);

    // 2) Safety net: kung ubos na ang level na iyon (mangyayari lang kung
    //    tinaasan ang SESSION_TARGET o binawasan ang bank), ang PINAKAMALAPIT
    //    na level ang susunod -- para manatiling malapit sa tamang difficulty
    //    ang estudyante sa halip na tumalon sa kabilang dulo ng bank.
    if (candidates.length === 0) {
        const byDistance = [1, 2, 3]
            .filter(l => l !== gameState.level)
            .sort((a, b) => Math.abs(a - gameState.level) - Math.abs(b - gameState.level));

        for (const lvl of byDistance) {
            candidates = unseenAt(lvl);
            if (candidates.length > 0) {
                // Panatilihing tapat ang badge at ang naitatalang level -- ang
                // estudyante ay TALAGANG nasa level na iyon ngayon.
                gameState.level = lvl;
                break;
            }
        }
    }

    // 3) Talagang ubos na ang buong bank: tapusin nang maaga sa halip na
    //    magpakita ng problemang tiyak na mali ang maitatala.
    if (candidates.length === 0) return null;

    const chosen = candidates[Math.floor(Math.random() * candidates.length)];
    gameState.servedIds.add(chosen.id);
    return chosen;
}

// ==========================================
// PROBLEM FLOW
// ==========================================
async function loadNextProblem() {
    if (gameState.problemsAnswered >= SESSION_TARGET) {
        endSession();
        return;
    }

    const next = pickNextProblem();
    if (!next) {
        // Naubos ang bank bago maabot ang target -- isara nang maayos sa halip
        // na mag-crash o magpakita ng paulit-ulit na problema.
        endSession();
        return;
    }
    await presentProblem(next);
}

// Ipinapakita ang isang partikular na problema at tinatatakan ang oras nito sa
// server. Hiwalay sa loadNextProblem() para magamit din ito ng resume path,
// kung saan alam na natin KUNG ALIN ang problema.
async function presentProblem(next) {
    gameState.currentProblem = next;
    // Itinatakda dito -- kung saan talaga naipapakita ang problem -- sa halip
    // na i-derive mula sa problemsAnswered habang nagsi-sync. Iyon ang dating
    // sanhi kung bakit lumalabas na "11 / 10" sa admin Active Game view.
    gameState.currentProblemNumber = gameState.problemsAnswered + 1;
    gameState.attemptsThisProblem = 0;
    gameState.hintsUsedThisProblem = 0;
    gameState.lastSubmittedValue = null;

    // Ang SERVER ang tumatatak ng oras ng pagsisimula (problem_serves.served_at).
    // Dati, Date.now() ng browser ang pinagmumulan ng time_taken_ms at direkta
    // itong ipinapasa sa recorder -- kaya kayang i-report ng kahit sino na
    // 1.2 segundo lang ang inabot nila sa bawat problema, at maitala silang
    // 'smooth' sa lahat. Ang unang serve lang ang tumatatak, kaya hindi rin
    // makakadagdag ng oras ang pag-refresh ng page.
    const { data: served, error } = await window.supabaseClient.rpc('serve_problem', {
        p_session_id: gameState.sessionId,
        p_problem_id: next.id,
        p_problem_number: gameState.currentProblemNumber
    });

    if (error) {
        showFeedback('incorrect', 'Hindi maabot ang server. Pakisubukan ulit.');
        return;
    }

    // Ang level ay galing sa server -- ni-replay mula sa naitalang kasaysayan
    // ng session, hindi sa isang counter sa browser.
    gameState.level = Number(served?.level) || gameState.level;
    gameState.hintsAvailable = Number(served?.hints_available) || 0;
    gameState.consecutiveCorrect = Number(served?.consecutive_correct) || 0;

    renderProblem();
    // I-sync agad para live na ang admin view mula pa sa unang problem
    // (dati, pagkatapos lang ng unang sagot o hint ito nag-a-update).
    syncGameProgress();
}

function renderProblem() {
    const p = gameState.currentProblem;
    document.getElementById('problem-expression').textContent = p.expression;
    document.getElementById('problem-instruction').textContent = 'Solve for x.';
    document.getElementById('answer-input').value = '';
    document.getElementById('answer-input').disabled = false;
    document.getElementById('answer-input').focus();
    document.getElementById('submit-answer-btn').disabled = false;
    document.getElementById('feedback-panel').classList.add('hidden');
    document.getElementById('hint-panel').classList.add('hidden');
    document.getElementById('hint-panel').innerHTML = '';

    const hintBtn = document.getElementById('show-hint-btn');
    hintBtn.disabled = gameState.hintsAvailable === 0;
    hintBtn.textContent = gameState.hintsAvailable > 0
        ? `Show Hint (${gameState.hintsAvailable} available)`
        : 'No hints';

    updateProgressUI();
    setAgentSpeech("Kaya mo 'yan! Isulat ang value ni x.");
    setAgentExpression('idle');
}

function updateProgressUI() {
    const pct = Math.round((gameState.problemsAnswered / SESSION_TARGET) * 100);
    const fill = document.getElementById('progress-bar-fill');
    fill.style.width = `${pct}%`;
    fill.parentElement?.setAttribute('aria-valuenow', String(Math.round(pct)));
    document.getElementById('progress-label').textContent = `${gameState.problemsAnswered} / ${SESSION_TARGET} problems`;
    document.getElementById('level-badge').textContent = gameState.level;
    document.getElementById('streak-count').textContent = gameState.consecutiveCorrect;

    // A reward signal that is always on is not a reward signal -- the streak
    // chip only goes sunny once there is a streak to celebrate.
    document.getElementById('streak-chip')
        ?.classList.toggle('is-hot', gameState.consecutiveCorrect >= 2);
}

function setAgentSpeech(text) {
    const bubble = document.getElementById('agent-speech-bubble');
    if (bubble) bubble.textContent = text;
}

// ==========================================
// HINTS
// ==========================================
// Ang hint text ay galing na sa DB (public.math_hints -- walang select grant,
// kaya hindi ito nababasa ng kahit sino mula sa client) at ang SERVER ang
// nagbibilang kung ilan ang nagamit na. Dati, nasa math-problems.js ang mga
// hint, at ang huling hint ay ang mismong solusyon -- kaya nababasa ang bawat
// sagot sa view-source, at ang pagbabasa nila sa ganoong paraan ay hindi
// nagpapataas ng hints_used. Iyon ang tahimik na nagpapataas ng 'smooth' rate.
const hintBtnEl = () => document.getElementById('show-hint-btn');

async function showHint() {
    const btn = hintBtnEl();
    if (!btn || btn.disabled) return;
    btn.disabled = true; // guard laban sa double-click habang naghihintay

    const { data, error } = await window.supabaseClient.rpc('consume_hint', {
        p_session_id: gameState.sessionId,
        p_problem_id: gameState.currentProblem.id
    });

    if (error) {
        btn.disabled = false;
        showFeedback('incorrect', 'Hindi makuha ang hint. Pakisubukan ulit.');
        return;
    }

    if (data && data.hint_text) {
        gameState.hintsUsedThisProblem = Number(data.hints_used) || 0;
        gameState.hintsUsedTotal++;

        const panel = document.getElementById('hint-panel');
        panel.classList.remove('hidden');
        panel.innerHTML += `<p class="hint-line"><strong>Hint ${escapeHTML(data.hints_used)}:</strong> ${escapeHTML(data.hint_text)}</p>`;
    }

    const left = Number(data?.hints_left) || 0;
    if (data?.exhausted || left === 0) {
        btn.disabled = true;
        btn.textContent = 'No more hints';
    } else {
        btn.disabled = false;
        btn.textContent = `Show Hint (${left} left)`;
    }

    setAgentSpeech("Narito, tignan natin ang susunod na hakbang.");
    setAgentExpression('thinking');
    syncGameProgress();
}

// ==========================================
// SUBMIT / VALIDATION
// ==========================================
async function submitAnswer() {
    // DOUBLE-SUBMIT GUARD: ang Enter key handler ay direktang tumatawag dito,
    // kaya hindi sapat ang pag-disable ng button -- dalawang magkasunod na
    // Enter habang naghihintay sa server ay dating nakakaubos ng DALAWANG
    // attempt para sa IISANG sagot. Sa mabagal na koneksyon, natatalo ang
    // estudyante sa problema nang hindi nila alam kung bakit.
    if (gameState.isSubmitting) return;

    const input = document.getElementById('answer-input');
    const submitBtn = document.getElementById('submit-answer-btn');

    // Hindi na binibilang na attempt ang hindi mabasang input (dati, kahit
    // garbage text ay nakakabawas ng attempt).
    const parsed = parseAnswerInput(input.value);
    if (parsed === null) {
        showFeedback('incorrect', 'Maglagay ng numero, hal. "x = 5" o "5".');
        input.select();
        return;
    }

    // Itinatabi para maipasa sa recorder. Ang SERVER ang muling susuri nito
    // laban sa answer key -- hindi tayo nagpapadala ng "correct: true".
    gameState.lastSubmittedValue = parsed;

    // I-lock ang PAREHONG button at input habang naghihintay sa server. Ang
    // disabled na input ay hindi nagpapaputok ng keydown, kaya dito talaga
    // nahaharangan ang Enter-spam.
    gameState.isSubmitting = true;
    submitBtn.disabled = true;
    input.disabled = true;

    let result;
    try {
        result = await validateAnswer(parsed, gameState.currentProblem, gameState.sessionId);
    } catch (e) {
        console.error('Answer submission failed:', e);
        result = { correct: false, attemptsUsed: 0, attemptsLeft: null, locked: false, error: true };
    } finally {
        gameState.isSubmitting = false;
    }

    // Ibalik lang ang kontrol kung may natitira pang pagkakataon ang estudyante
    // sa problemang ito. Kung tapos na ito, ang handler na ang bahala.
    const stillPlaying = !result.correct && !result.locked && result.attemptsLeft > 0;
    if (result.error || stillPlaying) {
        input.disabled = false;
        submitBtn.disabled = false;
    }

    // Network/server issue: fail-closed (hindi tinuturing na tama) pero
    // hindi rin sinasayang ang attempt ng estudyante.
    if (result.error) {
        showFeedback('incorrect', result.message || 'Hindi maabot ang server. Pakisubukan ulit.');
        input.select();
        return;
    }

    // Ang server ang nagbibilang ng attempts. Ang local counter ay pang-display
    // na lang -- kung magkaiba sila, ang server ang masusunod.
    gameState.attemptsThisProblem = result.attemptsUsed || (gameState.attemptsThisProblem + 1);

    if (result.correct) {
        await handleCorrectAnswer();
        return;
    }

    // Naka-lock na sa server (ubos na ang attempts o nasagot na dati nang tama).
    if (result.locked) {
        await handleFinalIncorrectAnswer();
        return;
    }

    if (result.attemptsLeft > 0) {
        showFeedback('incorrect', `Hindi pa tama. Subukan ulit! (${result.attemptsLeft} attempt${result.attemptsLeft > 1 ? 's' : ''} na lang)`);
        setAgentSpeech("Malapit ka na, subukan ulit!");
        setAgentExpression('concerned');
        input.select();
    } else {
        await handleFinalIncorrectAnswer();
    }
}

async function handleCorrectAnswer() {
    gameState.problemsAnswered++;
    gameState.correctCount++;
    lockAnswerInput();

    // Ang SERVER ang nagde-desisyon kung 'smooth' o 'struggling' -- ni-derive
    // mula sa math_attempt_log (attempts), hint_consumptions (hints), at
    // problem_serves (oras). Ang client ay tumatanggap na lang ng hatol.
    const result = await recordProblemResult();
    const isSmooth = result ? result.classification === 'smooth' : false;

    showFeedback('correct', isSmooth ? 'Tama! Ang bilis mo pa! 🎉' : 'Tama! Tuloy tayo.');
    setAgentSpeech(isSmooth ? "Ang galing mo! Susunod, medyo mas mahirap na." : "Ang galing! Tara sa susunod.");
    setAgentExpression(isSmooth ? 'happy' : 'encouraging');

    applyServerResult(result);
    await syncGameProgress();

    setTimeout(loadNextProblem, 1600);
}

async function handleFinalIncorrectAnswer() {
    gameState.problemsAnswered++;
    lockAnswerInput();

    const result = await recordProblemResult();

    // Dating ipinapakita dito ang plaintext na sagot mula sa client-side na
    // hints array. Ngayon, hinihingi ito sa server -- at may gate ang
    // reveal_solution(): ibinibigay lang nito ang solusyon kung LOCKED na ang
    // problema (tama na, o ubos na ang 2 attempts). Kung wala ang gate na iyon,
    // ito mismo ang magiging bagong answer leak.
    const { data: sol } = await window.supabaseClient.rpc('reveal_solution', {
        p_session_id: gameState.sessionId,
        p_problem_id: gameState.currentProblem.id
    });

    showFeedback('incorrect', sol && sol.solution
        ? `Ayos lang! Ganito ang solusyon: ${sol.solution}`
        : 'Ayos lang! Tuloy tayo sa susunod.');
    setAgentSpeech("Okay lang 'yan, matututunan din natin ito.");
    setAgentExpression('concerned');

    applyServerResult(result);
    await syncGameProgress();

    setTimeout(loadNextProblem, 2200);
}

function lockAnswerInput() {
    document.getElementById('answer-input').disabled = true;
    document.getElementById('submit-answer-btn').disabled = true;
    document.getElementById('show-hint-btn').disabled = true;
}

function showFeedback(type, message) {
    const panel = document.getElementById('feedback-panel');
    panel.textContent = message;
    panel.className = `feedback-panel feedback-${type}`;
    panel.classList.remove('hidden');
}

// ==========================================
// DECISION TREE -- adaptive difficulty
// 'smooth'    = tama, walang hint, walang retry, mabilis (<= 30s)
// 'struggling'= mali, o gumamit ng hint, o umulit, o matagal sumagot
//
// WALA NA ANG IMPLEMENTASYON DITO. Nasa pia_replay_decision_tree() na ito sa
// Postgres, at nire-replay mula sa buong kasaysayan ng session sa bawat
// pagtatala. Dalawang dahilan:
//   (1) ang klasipikasyon ang MISMONG finding ng thesis -- hindi ito dapat
//       idineklara ng browser; at
//   (2) kung magkahiwalay ang kopya ng client at ng server, tiyak silang
//       maghihiwalay ng sagot -- at ang naitala ang siyang mananaig.
// Display na lang ang ginagawa ng function sa ibaba.
// ==========================================
function applyServerResult(result) {
    if (!result) return;

    const previousLevel = gameState.level;
    gameState.level = Number(result.level) || gameState.level;
    gameState.consecutiveCorrect = Number(result.consecutive_correct) || 0;

    if (result.levelled_up) {
        awardMedalForLevelUp();
        setAgentSpeech(`Level Up! Level ${gameState.level} na tayo!`);
        setAgentExpression('excited');
    } else if (gameState.level < previousLevel) {
        setAgentSpeech("Bumaba muna tayo ng level para mas madali.");
    }

    updateProgressUI();
}

function awardMedalForLevelUp() {
    const label = gameState.level === 3 ? 'Gold' : 'Silver';
    if (!gameState.medals.includes(label)) {
        gameState.medals.push(label);
        renderMedals();
    }
}

function renderMedals() {
    const container = document.getElementById('medals-container');
    if (!container) return;
    if (gameState.medals.length === 0) {
        container.innerHTML = `<span class="medal-placeholder">Wala pang medal -- itaas ang streak!</span>`;
        return;
    }
    container.innerHTML = gameState.medals.map(m => `<span class="medal medal-${m.toLowerCase()}">${m}</span>`).join('');
}

// ==========================================
// RESEARCH DATA PERSISTENCE
// Dati, WALANG kahit anong resulta ng tutoring session ang naitatala. Ang
// endSession() ay is_in_game at current_difficulty lang ang isinusulat, kaya
// ang accuracy, correct count, timing, hints, at final level ay nawawala sa
// oras na isara ang tab -- ang mismong datos na kailangan ng thesis.
//
// Bawat problema ay itinatala pagkatapos itong ma-resolba, hindi sa dulo ng
// session. Kaya ang estudyanteng umalis sa gitna ng laro ay may totoong data
// point pa rin sa bawat naunang problema, sa halip na wala.
//
// Ang is_correct ay hindi galing dito: muling sinusuri ng RPC ang isinumite
// laban sa answer key, kaya walang maide-deklarang "tama" ang client.
// ==========================================
async function recordProblemResult() {
    if (!window.supabaseClient || !gameState.sessionId || !gameState.currentProblem) return null;

    // DALAWANG argumento lang: aling session, aling problem. Wala nang masasabi
    // ang browser tungkol sa performance ng estudyante.
    //
    // Dating ipinapasa dito ang p_classification, p_hints_used, p_time_taken_ms,
    // at p_level_before/after -- lahat galing sa browser. Tama nga na muling
    // sinusuri ng server ang is_correct laban sa answer key, pero ang 'smooth'
    // vs 'struggling' na label ay idinideklara ng client. Isang linya sa console
    // ang kailangan para maging perpekto ang buong session ng isang estudyante.
    const { data, error } = await window.supabaseClient.rpc('record_problem_result_v2', {
        p_session_id: gameState.sessionId,
        p_problem_id: gameState.currentProblem.id
    });

    // Hindi hinaharangan ang laro kung mabigo ang pagtatala -- mas mabuti nang
    // may kulang na isang row kaysa mag-freeze ang estudyante sa gitna ng
    // session. Lumalabas sa console para makita sa pilot testing.
    if (error) {
        console.error('Failed to record problem result:', error.message);
        return null;
    }
    return data;
}

// ==========================================
// SUPABASE SYNC (para ma-populate ang admin "Active Game" live view)
// ==========================================
async function syncGameProgress() {
    if (!window.supabaseClient || !gameState.email) return;
    await window.supabaseClient.from('profiles').update({
        current_problem: gameState.currentProblemNumber,
        current_difficulty: `Level ${gameState.level}`,
        hints_used: gameState.hintsUsedTotal,
        consecutive_correct: gameState.consecutiveCorrect
    }).eq('email', gameState.email);
}

// ==========================================
// SESSION END
// ==========================================
async function endSession() {
    document.getElementById('problem-screen').classList.add('hidden');
    const summaryEl = document.getElementById('summary-screen');
    summaryEl.classList.remove('hidden');

    // Ang buod ay galing na sa SERVER (v_tutoring_session_summary), hindi sa
    // client-side counters. Iisa ang numerong nakikita ng estudyante at ang
    // nakatala sa research data -- walang pagkakataong maghiwalay sila.
    let s = null;
    if (window.supabaseClient && gameState.sessionId) {
        const { data } = await window.supabaseClient
            .from('v_tutoring_session_summary')
            .select('*')
            .eq('session_id', gameState.sessionId)
            .maybeSingle();
        s = data;
    }

    // Fallback sa local counters kung hindi maabot ang server -- ipinapakita
    // pa rin ang buod sa estudyante kahit nabigo ang network.
    const answered = s ? s.problems_answered : gameState.problemsAnswered;
    const correct = s ? s.correct_count : gameState.correctCount;
    const finalLevel = s ? s.final_level : gameState.level;
    const accuracy = answered > 0 ? Math.round((correct / answered) * 100) : 0;

    document.getElementById('summary-accuracy').textContent = `${accuracy}%`;
    document.getElementById('summary-level').textContent = `Level ${finalLevel}`;
    document.getElementById('summary-correct').textContent = `${correct} / ${answered}`;
    document.getElementById('summary-medals').textContent = gameState.medals.length > 0 ? gameState.medals.join(' · ') : 'None yet';

    if (window.supabaseClient && gameState.email) {
        await window.supabaseClient.from('profiles').update({
            is_in_game: false,
            current_difficulty: `Level ${finalLevel}`
        }).eq('email', gameState.email);

        // Isara ang server-side session para hindi na ito magamit pa sa
        // karagdagang answer checks pagkatapos ng laro.
        if (gameState.sessionId) {
            await window.supabaseClient.rpc('end_game_session', { p_session_id: gameState.sessionId });
            gameState.sessionId = null;
        }
    }
}

function backToDashboard() {
    window.location.href = 'student-dashboard.html';
}

// ==========================================
// EVENT WIRING
// ==========================================
document.getElementById('submit-answer-btn')?.addEventListener('click', submitAnswer);
document.getElementById('show-hint-btn')?.addEventListener('click', showHint);
document.getElementById('answer-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitAnswer(); }
});
document.getElementById('back-to-dashboard-btn')?.addEventListener('click', backToDashboard);

// ==========================================
// ABANDONED SESSION CLEANUP
// Kapag isinara ang tab sa kalagitnaan ng laro, dating naiiwang
// `is_in_game = true` ang estudyante nang habang-buhay -- kaya may mga multo
// sa "Active Game" counter ng admin. Ginagamit ang fetch keepalive dahil ang
// normal na supabase-js call ay kinakansela kapag namatay ang page.
//
// Walang research data na nawawala dito: naitala na ang bawat naunang
// problema, at ang summary view ang magsasabi kung abandoned ang session
// (completed = false).
// ==========================================
window.addEventListener('pagehide', () => {
    if (!gameState.email || !gameState.accessToken || !window.SUPABASE_URL) return;

    fetch(`${window.SUPABASE_URL}/rest/v1/profiles?email=eq.${encodeURIComponent(gameState.email)}`, {
        method: 'PATCH',
        keepalive: true,
        headers: {
            'apikey': window.SUPABASE_ANON_KEY,
            'Authorization': 'Bearer ' + gameState.accessToken,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
        },
        body: JSON.stringify({ is_in_game: false })
    }).catch(() => { /* best-effort lang -- huwag harangan ang pagsara */ });
});
