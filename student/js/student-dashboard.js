/**
 * ============================================================================
 * PIA SYSTEM — STUDENT WORKSPACE
 * ============================================================================
 * The Grade 7 tutoring surface. Merges what were two v1 pages (the dashboard
 * hub and the tutoring game) into one page with three screens, which matches
 * how function.js already routes: STUDENT_STAGES.dash.url points here.
 *
 * RESEARCH INTEGRITY — two rules this file must never break:
 *
 *   1. ocean_* is never selected. The Big Five breakdown must not reach the
 *      student's browser at all, not merely be hidden with CSS. A student who
 *      learns they scored low on Conscientiousness may behave differently for
 *      the rest of the study, contaminating the measure the thesis depends on.
 *
 *   2. The browser never asserts performance. Answers are checked by
 *      check_math_answer(), hints are metered by consume_hint(), and the
 *      smooth/struggling verdict comes from record_problem_result_v2(). This
 *      file sends what the student typed and renders what the server replies.
 *      It never sends "correct: true" and never computes a classification.
 * ==========================================================================*/
(function () {
    'use strict';

    var $ = function (sel, root) { return (root || document).querySelector(sel); };
    var $$ = function (sel, root) {
        return Array.prototype.slice.call((root || document).querySelectorAll(sel));
    };

    var esc = (typeof escapeHTML === 'function') ? escapeHTML : function (v) {
        return String(v == null ? '' : v)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    };

    /* Kept in step with tutoring-dashboard.js and the server-side replay. */
    var SESSION_TARGET = 10;
    var MAX_ATTEMPTS = 2;

    var CHARACTER_IMAGES = {
        'pia-open': '../../assets/images/char-1.png',
        'pia-conscientious': '../../assets/images/char-conscientious.png',
        'pia-extravert': '../../assets/images/char-extravert.png',
        'pia-agreeable': '../../assets/images/char-agreeable.png',
        'pia-calm': '../../assets/images/char-calm.png',
        'pia-neutral': '../../assets/images/char-neutral.png'
    };

    var FALLBACK_IMAGE = '../../assets/images/char-1.png';

    /* Display state only. Every number that matters is re-read from the
       server; these exist so the screen has something to paint between
       round trips. */
    var state = {
        profile: null,
        email: null,
        sessionId: null,
        level: 1,
        problem: null,
        problemNumber: 1,
        answered: 0,
        correct: 0,
        streak: 0,
        hintsAvailable: 0,
        hintsUsedTotal: 0,
        attemptsUsed: 0,
        servedIds: [],
        submitting: false,
        finished: false
    };

    /* ============================================ 1. SCREENS =========== */

    function showScreen(name) {
        $$('.screen').forEach(function (node) {
            node.classList.toggle('is-active', node.id === 'screen-' + name);
        });
        window.scrollTo({ top: 0, behavior: 'auto' });
    }

    function setBootText(message) {
        var node = $('#boot-text');
        if (node) { node.textContent = message; }
    }

    function reveal() {
        document.body.removeAttribute('data-boot');
        var veil = $('#boot-veil');
        if (veil) { setTimeout(function () { veil.hidden = true; }, 200); }
    }

    function showGlobalError(message) {
        var banner = $('#global-error-banner');
        if (!banner) { return; }
        $('#global-error-message').textContent = message;
        banner.hidden = false;
    }

    /* ============================================ 2. MODAL + TOAST ===== */
    /* Identical mechanics to the admin console and the landing page. */

    var openLayers = [];
    /* Matches --z-overlay in global.css; see the stacking ladder there. */
    var Z_OVERLAY_BASE = 100;
    var lastFocused = null;
    var FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]),' +
        ' textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

    function lockScroll() {
        var gap = window.innerWidth - document.documentElement.clientWidth;
        document.documentElement.style.setProperty('--scrollbar-w', gap + 'px');
        document.body.classList.add('is-locked');
    }

    function unlockScroll() {
        document.body.classList.remove('is-locked');
        document.documentElement.style.setProperty('--scrollbar-w', '0px');
    }

    function openModal(id) {
        var overlay = document.getElementById(id);
        if (!overlay || openLayers.indexOf(overlay) !== -1) { return; }

        if (!openLayers.length) { lastFocused = document.activeElement; lockScroll(); }

        overlay.classList.add('is-mounted');
        openLayers.push(overlay);
        
        /* Raise this layer above every layer already open. All overlays share
           one base z-index in CSS, so without this the winner is decided by DOM
           source order — which is how an open drawer ended up covering a
           confirmation dialog it had itself triggered. z-index does not affect
           layout, so this costs nothing in CLS. */
        overlay.style.zIndex = String(Z_OVERLAY_BASE + openLayers.length);
        void overlay.offsetWidth;
        overlay.classList.add('is-open');

        var first = overlay.querySelector('button, input, select, textarea');
        if (first) { first.focus({ preventScroll: true }); }
    }

    function closeModal(target) {
        var overlay = (typeof target === 'string') ? document.getElementById(target) : target;
        overlay = overlay || openLayers[openLayers.length - 1];
        if (!overlay) { return; }

        overlay.classList.remove('is-open');
        overlay.style.zIndex = '';
        openLayers = openLayers.filter(function (l) { return l !== overlay; });

        setTimeout(function () {
            overlay.classList.remove('is-mounted');
            if (!openLayers.length) {
                unlockScroll();
                if (lastFocused && lastFocused.focus) { lastFocused.focus({ preventScroll: true }); }
            }
        }, 160);
    }

    function initModals() {
        $$('.overlay').forEach(function (overlay) {
            overlay.addEventListener('mousedown', function (e) {
                if (e.target === overlay) { closeModal(overlay); }
            });
            $$('[data-modal-close]', overlay).forEach(function (btn) {
                btn.addEventListener('click', function () { closeModal(overlay); });
            });
        });

        document.addEventListener('keydown', function (event) {
            if (!openLayers.length) { return; }
            var top = openLayers[openLayers.length - 1];

            if (event.key === 'Escape') { event.preventDefault(); closeModal(top); return; }
            if (event.key !== 'Tab') { return; }

            var nodes = $$(FOCUSABLE, top).filter(function (n) { return n.offsetParent !== null; });
            if (!nodes.length) { return; }

            var first = nodes[0], last = nodes[nodes.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        });
    }

    function confirmAction(options) {
        return new Promise(function (resolve) {
            var overlay = $('#modal-confirm');
            var accept = $('#confirm-accept');

            $('#confirm-title').textContent = options.title || 'Are you sure?';
            $('#confirm-subtitle').textContent = options.subtitle || 'Check before you continue.';
            $('#confirm-heading').textContent = options.heading || options.title || '';
            $('#confirm-text').textContent = options.message || '';
            accept.textContent = options.confirmLabel || 'Continue';

            var fresh = accept.cloneNode(true);
            accept.parentNode.replaceChild(fresh, accept);

            function settle(result) {
                overlay.removeEventListener('click', onBackdrop, true);
                document.removeEventListener('keydown', onEsc, true);
                resolve(result);
            }

            fresh.addEventListener('click', function () { closeModal(overlay); settle(true); });
            function onBackdrop(e) { if (e.target === overlay) { settle(false); } }
            function onEsc(e) { if (e.key === 'Escape') { settle(false); } }

            $$('[data-modal-close]', overlay).forEach(function (b) {
                b.addEventListener('click', function () { settle(false); }, { once: true });
            });
            overlay.addEventListener('click', onBackdrop, true);
            document.addEventListener('keydown', onEsc, true);

            openModal('modal-confirm');
        });
    }

    function toast(title, description, tone) {
        var stack = $('#toast-stack');
        if (!stack) { return; }

        var node = document.createElement('div');
        node.className = 'toast toast-' + (tone === 'danger' ? 'danger' : 'accent');
        node.innerHTML = '<svg class="icon"><use href="#i-' + (tone === 'danger' ? 'alert' : 'check') +
            '"></use></svg><div class="toast-text"><p class="toast-title">' + esc(title) + '</p>' +
            (description ? '<p class="toast-desc">' + esc(description) + '</p>' : '') + '</div>';

        stack.appendChild(node);
        void node.offsetWidth;
        node.classList.add('is-open');

        setTimeout(function () {
            node.classList.remove('is-open');
            setTimeout(function () { node.remove(); }, 200);
        }, 4000);
    }

    /* Width is pinned while the label swaps, so the answer row never resizes
       mid-request. */
    function setBusy(button, label) {
        if (!button) { return function () {}; }
        var html = button.innerHTML;
        var width = button.getBoundingClientRect().width;
        /* width, not min-width: min-width is only a floor, so a longer busy
           label ("Signing in…" vs "Sign in") still grew the button and
           nudged its neighbours. Pinning width locks it both ways. */
        button.style.width = Math.ceil(width) + 'px';
        button.disabled = true;
        button.textContent = label || 'Checking…';

        return function release() {
            button.innerHTML = html;
            button.disabled = false;
            button.style.width = '';
        };
    }

    /* ============================================ 3. AGENT ============= */

    function setSpeech(text) {
        var node = $('#agent-speech');
        if (node) { node.textContent = text; }
    }

    function applyCharacter(key) {
        var src = CHARACTER_IMAGES[key] || FALLBACK_IMAGE;
        ['#agent-img', '#agent-img-start'].forEach(function (sel) {
            var img = $(sel);
            if (!img) { return; }
            img.addEventListener('error', function () { this.src = FALLBACK_IMAGE; }, { once: true });
            img.src = src;
        });

        /* The persona name is shown; the trait scores behind it are not. */
        var label = ({
            'pia-open': 'Ava · your curious tutor',
            'pia-conscientious': 'Cara · your organised tutor',
            'pia-extravert': 'Theo · your energetic tutor',
            'pia-agreeable': 'Amy · your patient tutor',
            'pia-calm': 'Kai · your steady tutor',
            'pia-neutral': 'PIA · your tutor'
        })[key] || 'PIA · your tutor';

        ['#agent-name', '#agent-name-start'].forEach(function (sel) {
            var node = $(sel);
            if (node) { node.textContent = label; }
        });
    }

    /* ============================================ 4. FEEDBACK ========== */

    /* The feedback row and the attempt note keep their space at all times, so
       showing a verdict cannot push the input or the hint button downward. */
    function setFeedback(text, tone) {
        var row = $('#feedback');
        var glyph = $('use', row);

        $('#feedback-text').textContent = text || '';
        row.classList.toggle('is-correct', tone === 'correct');
        row.classList.toggle('is-wrong', tone === 'wrong');
        row.classList.toggle('is-neutral', tone === 'neutral');

        if (glyph) {
            glyph.setAttribute('href',
                tone === 'correct' ? '#i-check' : (tone === 'wrong' ? '#i-alert' : '#i-info'));
        }
    }

    function clearFeedback() { setFeedback('', null); }

    function paintProgress() {
        var done = Math.min(state.answered, SESSION_TARGET);
        $('#progress-count').textContent = done + ' / ' + SESSION_TARGET;
        $('#progress-fill').style.width = Math.round((done / SESSION_TARGET) * 100) + '%';
        $('#stat-correct').textContent = state.correct;
        $('#stat-streak').textContent = state.streak;
        $('#stat-level').textContent = state.level;
    }

    function paintAttempts() {
        var left = Math.max(0, MAX_ATTEMPTS - state.attemptsUsed);
        $('#attempts-note').textContent = left === MAX_ATTEMPTS
            ? 'You have ' + MAX_ATTEMPTS + ' tries'
            : (left === 1 ? '1 try left' : left + ' tries left');
    }

    function paintHintButton() {
        var btn = $('#hint-btn');
        var label = $('#hint-btn-label');
        var note = $('#hints-note');

        if (state.hintsAvailable > 0) {
            btn.disabled = false;
            label.textContent = 'Give me a hint';
            note.textContent = state.hintsAvailable + ' hint' + (state.hintsAvailable === 1 ? '' : 's') + ' available';
        } else {
            btn.disabled = true;
            label.textContent = 'No more hints';
            note.textContent = '';
        }
    }

    /* ============================================ 5. SESSION =========== */

    /* resume_or_start_game_session() decides on the server: an unfinished
       session comes back with its progress, otherwise a new one is issued.
       The browser does not get to pick. */
    async function startOrResume() {
        var res = await sb.rpc('resume_or_start_game_session');

        if (res.error || !res.data || !res.data.session_id) {
            console.error('Could not start/resume session:', res.error && res.error.message);
            toast('Could not start', 'Please check your connection and try again.', 'danger');
            return false;
        }

        var d = res.data;
        state.sessionId = d.session_id;
        state.answered = Number(d.problems_answered) || 0;
        state.correct = Number(d.correct_count) || 0;
        state.level = Number(d.level) || 1;
        state.streak = Number(d.consecutive_correct) || 0;
        return true;
    }

    /* Picks the next unseen problem at the server-reported level, then asks
       the server to serve it. serve_problem() stamps the start time — the
       browser's clock is never the source of time_taken_ms. */
    function pickProblem() {
        var bank = (typeof MATH_PROBLEMS !== 'undefined' && MATH_PROBLEMS[state.level]) || [];
        var unseen = bank.filter(function (p) { return state.servedIds.indexOf(p.id) === -1; });

        if (unseen.length) { return unseen[Math.floor(Math.random() * unseen.length)]; }

        /* Bank for this level is exhausted — fall back to the nearest level
           that still has something, rather than repeating a problem. */
        var levels = Object.keys(MATH_PROBLEMS || {}).map(Number).sort(function (a, b) {
            return Math.abs(a - state.level) - Math.abs(b - state.level);
        });

        for (var i = 0; i < levels.length; i++) {
            var alt = (MATH_PROBLEMS[levels[i]] || []).filter(function (p) {
                return state.servedIds.indexOf(p.id) === -1;
            });
            if (alt.length) { return alt[Math.floor(Math.random() * alt.length)]; }
        }
        return null;
    }

    async function nextProblem() {
        if (state.answered >= SESSION_TARGET) { return endSession(); }

        var problem = pickProblem();
        if (!problem) { return endSession(); }

        state.problemNumber = state.answered + 1;
        state.attemptsUsed = 0;

        var served = await sb.rpc('serve_problem', {
            p_session_id: state.sessionId,
            p_problem_id: problem.id,
            p_problem_number: state.problemNumber
        });

        if (served.error) {
            setFeedback('Could not reach the server. Try again in a moment.', 'wrong');
            return;
        }

        state.servedIds.push(problem.id);
        state.problem = problem;
        state.level = Number(served.data && served.data.level) || state.level;
        state.hintsAvailable = Number(served.data && served.data.hints_available) || 0;
        state.streak = Number(served.data && served.data.consecutive_correct) || 0;

        renderProblem();
        syncProgress();
    }

    function renderProblem() {
        $('#problem-kicker').textContent = 'Problem ' + state.problemNumber;
        $('#problem-expression').textContent = state.problem.expression;
        $('#problem-instruction').textContent = 'Solve for x.';

        var input = $('#answer-input');
        input.value = '';
        input.disabled = false;
        $('#submit-btn').disabled = false;
        $('#hint-zone').innerHTML = '';

        clearFeedback();
        paintAttempts();
        paintHintButton();
        paintProgress();

        input.focus({ preventScroll: true });
    }

    /* ============================================ 6. ANSWERING ========= */

    async function handleSubmit(event) {
        event.preventDefault();
        if (state.submitting || !state.problem) { return; }

        var input = $('#answer-input');
        var parsed = (typeof parseAnswerInput === 'function')
            ? parseAnswerInput(input.value)
            : parseFallback(input.value);

        if (parsed === null) {
            setFeedback('Type a number, like "x = 5" or just "5".', 'neutral');
            input.select();
            return;
        }

        /* Lock BOTH the button and the input. A disabled input fires no
           keydown, which is what actually stops Enter-spam. */
        state.submitting = true;
        input.disabled = true;
        var release = setBusy($('#submit-btn'), 'Checking…');

        var result;
        try {
            result = await validateAnswer(parsed, state.problem, state.sessionId);
        } catch (err) {
            console.error('Answer submission failed:', err);
            result = { correct: false, attemptsUsed: 0, attemptsLeft: null, locked: false, error: true };
        } finally {
            state.submitting = false;
            release();
        }

        /* Network trouble fails closed — not counted correct, but the
           student's attempt is not spent either. */
        if (result.error) {
            input.disabled = false;
            setFeedback(result.message || 'Could not reach the server. Please try again.', 'wrong');
            input.select();
            return;
        }

        state.attemptsUsed = result.attemptsUsed || (state.attemptsUsed + 1);
        paintAttempts();

        if (result.correct) { return handleCorrect(); }
        if (result.locked || result.attemptsLeft <= 0) { return handleOutOfTries(); }

        input.disabled = false;
        setFeedback('Not quite yet — have another go.', 'wrong');
        setSpeech("You're close. Check each step again — I'll wait.");
        input.select();
    }

    /* Only used if math-problems.js is unavailable; the real parser lives
       there alongside the answer-checking call. */
    function parseFallback(raw) {
        var m = String(raw || '').replace(/\s+/g, '').match(/^x?=?(-?\d+(?:\.\d+)?)$/i);
        return m ? parseFloat(m[1]) : null;
    }

    function lockInput() {
        $('#answer-input').disabled = true;
        $('#submit-btn').disabled = true;
        $('#hint-btn').disabled = true;
    }

    async function handleCorrect() {
        state.answered++;
        state.correct++;
        lockInput();

        /* The server decides smooth vs struggling from its own logs. The
           browser only renders the verdict. */
        var recorded = await sb.rpc('record_problem_result_v2', {
            p_session_id: state.sessionId,
            p_problem_id: state.problem.id
        });

        if (recorded.error) { console.error('Failed to record result:', recorded.error.message); }

        var smooth = recorded.data && recorded.data.classification === 'smooth';
        state.streak = state.streak + 1;   /* re-synced from serve_problem next round */

        setFeedback(smooth ? 'Correct — and quickly too!' : 'Correct. Nice work.', 'correct');
        setSpeech(smooth
            ? "That was sharp. The next one steps up a little."
            : "Well done. Let's keep going.");

        paintProgress();
        syncProgress();
        setTimeout(advance, 1400);
    }

    async function handleOutOfTries() {
        state.answered++;
        state.streak = 0;
        lockInput();

        var recorded = await sb.rpc('record_problem_result_v2', {
            p_session_id: state.sessionId,
            p_problem_id: state.problem.id
        });

        if (recorded.error) { console.error('Failed to record result:', recorded.error.message); }

        /* reveal_solution() only answers once the problem is locked. Without
           that gate this call would become the new answer leak. */
        var sol = await sb.rpc('reveal_solution', {
            p_session_id: state.sessionId,
            p_problem_id: state.problem.id
        });

        setFeedback(sol.data && sol.data.solution
            ? 'The answer was ' + sol.data.solution
            : "That's alright — let's move on.", 'neutral');
        setSpeech("No problem at all. We'll see this type again.");

        paintProgress();
        syncProgress();
        setTimeout(advance, 2600);
    }

    function advance() {
        if (state.answered >= SESSION_TARGET) { endSession(); }
        else { nextProblem(); }
    }

    /* ============================================ 7. HINTS ============= */

    /* consume_hint() both returns the text and counts it. A hint read any
       other way would not raise hints_used, which would quietly inflate the
       'smooth' rate — the exact number the study measures. */
    async function handleHint() {
        var btn = $('#hint-btn');
        if (btn.disabled || !state.problem) { return; }
        btn.disabled = true;

        var res = await sb.rpc('consume_hint', {
            p_session_id: state.sessionId,
            p_problem_id: state.problem.id
        });

        if (res.error) {
            btn.disabled = false;
            setFeedback('Could not load a hint. Please try again.', 'wrong');
            return;
        }

        if (res.data && res.data.hint_text) {
            state.hintsUsedTotal++;
            var line = document.createElement('p');
            line.className = 'hint-line';
            line.innerHTML = '<b>Hint ' + esc(res.data.hints_used) + ':</b> ' + esc(res.data.hint_text);
            $('#hint-zone').appendChild(line);
        }

        var left = Number(res.data && res.data.hints_left) || 0;
        state.hintsAvailable = left;

        if ((res.data && res.data.exhausted) || left === 0) {
            $('#hint-btn-label').textContent = 'No more hints';
            $('#hints-note').textContent = '';
        } else {
            btn.disabled = false;
            $('#hints-note').textContent = left + ' hint' + (left === 1 ? '' : 's') + ' left';
        }

        setSpeech("Here's a nudge. Try the next step from there.");
        syncProgress();
    }

    /* ============================================ 8. SYNC + END ======== */

    /* Feeds the admin console's live view. Display fields only — nothing the
       research data is derived from. */
    async function syncProgress() {
        if (!state.email) { return; }
        await sb.from('profiles').update({
            current_problem: state.problemNumber,
            current_difficulty: 'Level ' + state.level,
            hints_used: state.hintsUsedTotal,
            consecutive_correct: state.streak
        }).eq('email', state.email);
    }

    async function endSession() {
        if (state.finished) { return; }
        state.finished = true;

        showScreen('summary');

        /* The summary comes from the server view, so the number the student
           sees and the number in the research data are the same number. */
        var summary = null;
        if (state.sessionId) {
            var res = await sb.from('v_tutoring_session_summary')
                .select('problems_answered, correct_count, final_level')
                .eq('session_id', state.sessionId).maybeSingle();
            summary = res.data;
        }

        var answered = summary ? summary.problems_answered : state.answered;
        var correct = summary ? summary.correct_count : state.correct;
        var level = summary ? summary.final_level : state.level;
        var accuracy = answered > 0 ? Math.round((correct / answered) * 100) : 0;

        $('#summary-correct').textContent = correct + ' / ' + answered;
        $('#summary-accuracy').textContent = accuracy + '%';
        $('#summary-level').textContent = 'Level ' + level;
        $('#summary-lede').textContent = accuracy >= 70
            ? 'Strong session — you worked through the harder ones too.'
            : 'Good effort. Every one of these gets easier with practice.';

        await sb.from('profiles').update({
            is_in_game: false,
            current_difficulty: 'Level ' + level
        }).eq('email', state.email);

        if (state.sessionId) {
            await sb.rpc('end_game_session', { p_session_id: state.sessionId });
        }
    }

    /* ============================================ 9. SIGN OUT ========== */

    /* On a shared lab PC an open session means the next student's answers
       land in this student's row. executeForceLogout() releases the device
       slot, signs out globally and clears storage. */
    async function signOut() {
        var mid = state.sessionId && !state.finished;
        var ok = await confirmAction({
            title: 'Sign out',
            heading: mid ? 'Leave this session?' : 'Sign out?',
            message: mid
                ? 'Your progress is saved. When you sign back in you will pick up from the same problem.'
                : 'You can sign back in any time with your school email.',
            confirmLabel: 'Sign out'
        });
        if (!ok) { return; }

        if (typeof executeForceLogout === 'function') { await executeForceLogout(); }
        else { await sb.auth.signOut({ scope: 'global' }); window.location.replace('../../index.html'); }
    }

    /* ============================================ 10. BOOT ============= */

    async function boot() {
        if (typeof sb === 'undefined' || !sb) {
            setBootText('Could not connect.');
            showGlobalError('Could not reach the server. Please refresh the page.');
            return;
        }

        /* The full gate: real session, prerequisite chain (OCEAN done,
           character chosen if the condition needs one), and the stage flag
           with the admin's per-student override. Redirects on failure. */
        setBootText('Checking your session…');
        var profile = await enforceStudentStage('dash');
        if (!profile) { return; }

        state.profile = profile;
        state.email = profile.email;

        /* Tell the admin view where this student is. If the stage was closed
           in the meantime the server says so, and we follow it. */
        var stageRes = await sb.rpc('set_student_stage', { p_stage: 'Tutoring Dashboard' });
        if (stageRes.data && stageRes.data.granted === false) {
            window.location.replace('waiting-room.html');
            return;
        }

        /* Deliberately narrow: full_name and selected_character only. ocean_*
           must not enter this page — see the header note. */
        var me = await sb.from('profiles')
            .select('full_name, selected_character, section')
            .eq('email', state.email).maybeSingle();

        var name = (me.data && me.data.full_name) || state.email.split('@')[0];
        var firstName = name.trim().split(/\s+/)[0];

        $('#who-name').textContent = name;
        $('#who-meta').textContent = (me.data && me.data.section) ? 'Section ' + me.data.section : 'Student';
        $('#who-initials').textContent = firstName.slice(0, 2).toUpperCase();
        $('#start-hello').textContent = 'Welcome back, ' + firstName + '!';

        applyCharacter(me.data && me.data.selected_character);

        initModals();
        $('#answer-form').addEventListener('submit', handleSubmit);
        $('#hint-btn').addEventListener('click', handleHint);
        $('#signout-btn').addEventListener('click', signOut);
        $('#summary-signout').addEventListener('click', signOut);
        $('#start-btn').addEventListener('click', handleStart);

        /* Show any progress already recorded, so a resumed session is obvious
           before the student presses anything. */
        var peek = await sb.rpc('resume_or_start_game_session');
        if (peek.data) {
            state.sessionId = peek.data.session_id;
            state.answered = Number(peek.data.problems_answered) || 0;
            state.correct = Number(peek.data.correct_count) || 0;
            state.level = Number(peek.data.level) || 1;
            state.streak = Number(peek.data.consecutive_correct) || 0;

            $('#fact-progress').textContent = state.answered;
            $('#fact-target').textContent = SESSION_TARGET;

            if (state.answered > 0) {
                $('#start-btn-label').textContent = 'Continue my session';
                $('#start-lede').textContent =
                    'You already answered ' + state.answered + ' of ' + SESSION_TARGET +
                    '. Pick up right where you left off.';
            }
        }

        reveal();

        /* If the admin closes this stage mid-session, leave for the waiting
           room rather than sitting on a page that is no longer open. */
        if (typeof registerChannel === 'function') {
            registerChannel('student-dash-lock', function (channel) {
                return channel.on('postgres_changes', {
                    event: 'UPDATE', schema: 'public', table: 'settings', filter: 'key=eq.stage_dash'
                }, function (payload) {
                    var open = payload.new.value === true || payload.new.value === 'true';
                    if (!open) { window.location.replace('waiting-room.html'); }
                }).subscribe();
            });
        }
    }

    async function handleStart() {
        var release = setBusy($('#start-btn'), 'Starting…');

        var ok = await startOrResume();
        if (!ok) { release(); return; }

        await sb.from('profiles').update({
            is_in_game: true,
            current_difficulty: 'Level ' + state.level
        }).eq('email', state.email);

        release();
        showScreen('session');
        setSpeech("Let's begin. Read it once, then try the first step.");
        await nextProblem();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
