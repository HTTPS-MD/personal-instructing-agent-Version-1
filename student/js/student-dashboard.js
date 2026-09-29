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
 *   2. The browser never asserts performance, and never holds an answer.
 *      The questions are the Percentages bank (question_bank, migration
 *      0029): serve_next_question() picks one and sends only its statement;
 *      check_question_answer() says right or wrong; consume_question_hint()
 *      gives and counts each hint; record_question_result() decides smooth /
 *      struggling and the topic; reveal_question_solution() shows the answer
 *      only once the question is closed. This file sends what the student
 *      typed and renders what the server replies. It never sends
 *      "correct: true", never computes a classification, and never picks a
 *      question.
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

    /* Kept in step with the server-side replay. */
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
        topic: 1,
        problem: null,       /* { id, number, question, questionTopic, locked } */
        problemNumber: 1,
        answered: 0,
        correct: 0,
        streak: 0,
        hintsTotal: 0,
        hintsUsed: 0,
        hintsLeft: 0,
        hintsUsedTotal: 0,
        lastHintStep: null,
        attemptsUsed: 0,
        submitting: false,
        recording: false,
        hinting: false,
        awaitingNext: false,
        bankEmpty: false,
        finished: false,
        inSession: false,   /* a lesson has been started and not yet ended (see PIA_HAS_ACTIVE_WORK) */
        ended: false        /* another device took the account (function.js 1C-6) */
    };

    /* The database already refuses this device's writes; this stops the page
       queuing more of them (the next problem, a progress sync) behind the
       notice. */
    window.addEventListener('pia:session-ended', function () { state.ended = true; });

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

    /* The three study topics. The server numbers them 1-3 (question_bank's
       EASY / MEDIUM / HARD); these are only the words on screen. */
    var TOPICS = {
        1: { short: 'Finding %', title: 'finding a percentage' },
        2: { short: '% Increase', title: 'percentage increase' },
        3: { short: '% Decrease', title: 'percentage decrease' }
    };

    function topicOf(n) { return TOPICS[n] || TOPICS[1]; }

    function paintProgress() {
        var done = Math.min(state.answered, SESSION_TARGET);
        $('#progress-count').textContent = done + ' / ' + SESSION_TARGET;
        $('#progress-fill').style.width = Math.round((done / SESSION_TARGET) * 100) + '%';
        $('#stat-correct').textContent = state.correct;
        $('#stat-streak').textContent = state.streak;
        $('#stat-level').textContent = state.topic;
    }

    function paintAttempts() {
        var left = Math.max(0, MAX_ATTEMPTS - state.attemptsUsed);
        $('#attempts-note').textContent = left === MAX_ATTEMPTS
            ? 'You have ' + MAX_ATTEMPTS + ' tries'
            : (left === 1 ? '1 try left' : (left === 0 ? 'No tries left' : left + ' tries left'));
    }

    function problemOpen() { return !!state.problem && !state.problem.locked; }

    function paintHintButton() {
        var btn = $('#hint-btn');
        var label = $('#hint-btn-label');
        var note = $('#hints-note');

        if (problemOpen() && state.hintsLeft > 0) {
            btn.disabled = false;
            label.textContent = state.hintsUsed > 0 ? 'Next hint' : 'Give me a hint';
            note.textContent = state.hintsLeft + (state.hintsLeft === 1 ? ' hint' : ' hints') + ' left';
        } else {
            btn.disabled = true;
            label.textContent = state.hintsTotal > 0 ? 'No more hints' : 'No hints for this one';
            note.textContent = '';
            suggestHint(false);
        }
    }

    /* ---- 4.1 Hint offers ----
       When the student struggles -- a wrong first try, or a minute with no
       progress -- the tutor OFFERS the next hint and the button lights up.
       The hint itself is only taken when the student taps it: hints_used is
       a measure in the study, and a hint pushed onto a student who did not
       ask would inflate it. */
    var HINT_OFFER_IDLE_MS = 60 * 1000;
    var hintOfferTimer = null;

    function suggestHint(on) { $('#hint-btn').classList.toggle('is-suggested', !!on); }

    function offerHint(reason) {
        if (!problemOpen() || state.hintsLeft <= 0) { return; }
        var first = state.hintsUsed === 0;
        if (reason === 'wrong') {
            setSpeech(first
                ? 'Not quite. Want a nudge? Tap “Give me a hint” — the first one explains the idea.'
                : 'Close. The next hint builds on the last one — tap “Next hint” if you want it.');
        } else {
            setSpeech(first
                ? 'Take your time. If you are not sure where to start, a hint can show you.'
                : 'Still thinking? The next hint takes you one step further.');
        }
        suggestHint(true);
    }

    function armHintOffer() {
        clearTimeout(hintOfferTimer);
        if (!problemOpen() || state.hintsLeft <= 0) { return; }
        hintOfferTimer = setTimeout(function () { offerHint('idle'); }, HINT_OFFER_IDLE_MS);
    }

    /* ---- 4.2 Hints and the worked solution on screen ----
       Built with textContent: hint text is authored in the admin console and
       is never treated as markup. */
    function stripStepPrefix(text) {
        return String(text || '').replace(/^\s*step\s*\d+\s*[:.\-–—]\s*/i, '');
    }

    function appendHint(h) {
        if (!h || !h.text) { return; }
        var zone = $('#hint-zone');
        var step = h.step == null ? null : Number(h.step);

        /* Each step's prompt appears once, with its first hint. */
        if (step !== null && step !== state.lastHintStep) {
            var head = document.createElement('p');
            head.className = 'hint-step';
            var label = document.createElement('span');
            label.className = 'hint-step-label';
            label.textContent = 'Step ' + step + (Number(h.steps_total) > 1 ? ' of ' + h.steps_total : '');
            head.appendChild(label);
            if (h.step_prompt) {
                var prompt = document.createElement('span');
                prompt.className = 'hint-step-prompt';
                prompt.textContent = stripStepPrefix(h.step_prompt);
                head.appendChild(prompt);
            }
            zone.appendChild(head);
            state.lastHintStep = step;
        }

        var line = document.createElement('p');
        line.className = 'hint-line hint-tier-' + (Number(h.tier) || 1);
        var tag = document.createElement('b');
        tag.textContent = (h.tier_label || 'Hint') + ':';
        line.appendChild(tag);
        line.appendChild(document.createTextNode(' ' + h.text));
        zone.appendChild(line);
    }

    function showWorkedSolution(steps) {
        var rows = (steps || []).filter(function (s) { return s && (s.prompt || s.answer || s.worked); });
        if (!rows.length) { return; }

        var box = document.createElement('div');
        box.className = 'worked';
        var title = document.createElement('p');
        title.className = 'worked-title';
        title.textContent = 'How to solve it';
        box.appendChild(title);

        var list = document.createElement('ol');
        list.className = 'worked-steps';
        rows.forEach(function (s) {
            var li = document.createElement('li');
            li.appendChild(document.createTextNode(stripStepPrefix(s.prompt) + (s.prompt ? ' ' : '')));
            var result = document.createElement('b');
            result.textContent = s.worked || s.answer || '';
            li.appendChild(result);
            list.appendChild(li);
        });
        box.appendChild(list);
        $('#hint-zone').appendChild(box);
    }

    /* ============================================ 5. SESSION =========== */

    /* resume_or_start_game_session() decides on the server: an unfinished
       percentages session comes back with its progress, otherwise a new one
       is issued. The student's topic comes with it. */
    async function startOrResume() {
        var res = await sb.rpc('resume_or_start_game_session');

        if (res.error || !res.data || !res.data.session_id) {
            console.error('Could not start/resume session:', res.error && res.error.message);
            toast('Could not start', 'Please check your connection and try again.', 'danger');
            return false;
        }

        applySession(res.data);
        return true;
    }

    function applySession(d) {
        state.sessionId = d.session_id;
        state.answered = Number(d.problems_answered) || 0;
        state.correct = Number(d.correct_count) || 0;
        state.topic = Number(d.topic) || 1;
        state.streak = Number(d.consecutive_correct) || 0;
    }

    /* The SERVER picks the question (serve_next_question): the student's
       topic, questions they have seen least, then at random. Only the problem
       statement and hints already taken come back -- never an answer. A
       question still open comes back unchanged, so reloading cannot swap it. */
    async function nextProblem() {
        if (state.ended || state.finished) { return; }
        clearTimeout(hintOfferTimer);

        var res = await sb.rpc('serve_next_question', { p_session_id: state.sessionId });

        if (res.error || !res.data) {
            console.error('Could not load the next question:', res.error && res.error.message);
            setFeedback('Could not reach the server. Trying again…', 'wrong');
            setTimeout(nextProblem, 4000);
            return;
        }

        var d = res.data;
        if (d.done) {
            state.bankEmpty = d.reason === 'bank_empty';
            return endSession();
        }

        state.problem = {
            id: d.problem_id,
            number: Number(d.problem_number) || (state.answered + 1),
            question: String(d.question || ''),
            questionTopic: Number(d.question_topic) || Number(d.topic) || 1,
            locked: d.locked === true
        };
        state.problemNumber = state.problem.number;
        state.topic = Number(d.topic) || state.topic;
        state.attemptsUsed = Number(d.attempts_used) || 0;
        state.hintsTotal = Number(d.hints_total) || 0;
        state.hintsUsed = Number(d.hints_used) || 0;
        state.hintsLeft = Number(d.hints_left) || 0;
        state.lastHintStep = null;

        renderProblem(Array.isArray(d.hints) ? d.hints : []);
        syncProgress();

        /* Answered on an earlier visit but never recorded: finish it now. */
        if (state.problem.locked) { finishProblem(); }
    }

    function renderProblem(hintsTaken) {
        $('#problem-kicker').textContent = 'Problem ' + state.problemNumber + ' · ' +
            topicOf(state.problem.questionTopic).short;
        $('#problem-expression').textContent = state.problem.question;
        $('#problem-instruction').textContent = 'Type your answer as a number. The % sign is optional.';

        var input = $('#answer-input');
        input.value = '';
        input.disabled = state.problem.locked;
        setAnswerButton('check');

        $('#hint-zone').textContent = '';
        hintsTaken.forEach(appendHint);

        clearFeedback();
        suggestHint(false);
        paintAttempts();
        paintHintButton();
        paintProgress();

        if (!state.problem.locked) {
            input.focus({ preventScroll: true });
            armHintOffer();
        }
    }

    /* ============================================ 6. ANSWERING ========= */

    /* The answer button doubles as "Next problem" after a missed question,
       so the worked solution can be read at the student's own pace. Its
       min-width fits both labels, so the swap moves nothing. */
    function setAnswerButton(mode) {
        var btn = $('#submit-btn');
        state.awaitingNext = mode === 'next';
        btn.textContent = mode === 'next' ? 'Next problem' : 'Check';
        btn.disabled = mode === 'check' ? !problemOpen() : false;
    }

    async function handleSubmit(event) {
        event.preventDefault();

        if (state.awaitingNext) {
            setAnswerButton('check');
            $('#submit-btn').disabled = true;
            advance();
            return;
        }
        if (state.submitting || !problemOpen()) { return; }

        var input = $('#answer-input');
        var raw = input.value.trim();

        if (!/\d/.test(raw)) {
            setFeedback('Type your answer as a number, like 25 or 25%.', 'neutral');
            input.select();
            return;
        }

        /* Lock BOTH the button and the input. A disabled input fires no
           keydown, which is what actually stops Enter-spam. */
        state.submitting = true;
        input.disabled = true;
        clearTimeout(hintOfferTimer);
        var release = setBusy($('#submit-btn'), 'Checking…');

        var result;
        try {
            result = await checkAnswer(raw);
        } catch (err) {
            console.error('Answer submission failed:', err);
            result = { error: true };
        } finally {
            state.submitting = false;
            release();
        }

        /* Network trouble fails closed: not counted correct, and the attempt
           is not spent either. */
        if (result.error) {
            input.disabled = false;
            setFeedback('Could not reach the server. Please try again.', 'wrong');
            input.select();
            armHintOffer();
            return;
        }

        state.attemptsUsed = result.attemptsUsed;
        paintAttempts();

        if (result.correct || result.locked) {
            state.problem.locked = true;
            return finishProblem();
        }

        input.disabled = false;
        setFeedback('Not quite yet — have another go.', 'wrong');
        offerHint('wrong');
        input.select();
        armHintOffer();
    }

    /* check_question_answer() compares on the server and says right or
       wrong. The key never leaves the database. */
    async function checkAnswer(raw) {
        var res = await sb.rpc('check_question_answer', {
            p_session_id: state.sessionId,
            p_problem_id: state.problem.id,
            p_submitted: raw
        });
        if (res.error || !res.data) {
            console.error('Answer check failed:', res.error && res.error.message);
            return { error: true };
        }
        return {
            correct: res.data.correct === true,
            attemptsUsed: Number(res.data.attempts_used) || 0,
            attemptsLeft: Number(res.data.attempts_left) || 0,
            locked: res.data.locked === true,
            error: false
        };
    }

    function lockInput() {
        $('#answer-input').disabled = true;
        $('#submit-btn').disabled = true;
        $('#hint-btn').disabled = true;
    }

    function topicSpeech(change, from, to) {
        if (change === 'up') {
            return 'You have mastered ' + topicOf(from).title + '! Next up: ' + topicOf(to).title + '.';
        }
        if (change === 'down') {
            return 'Let’s go back to ' + topicOf(to).title + ' for a little while — it will make the next part easier.';
        }
        return null;
    }

    /* The question is closed (solved, or both tries used). The server
       records it -- time, hints, tries, smooth/struggling, and the topic
       rules -- and the page only shows what it says. */
    async function finishProblem() {
        if (state.recording || state.ended) { return; }
        state.recording = true;
        clearTimeout(hintOfferTimer);
        suggestHint(false);
        lockInput();

        var recorded = await sb.rpc('record_question_result', {
            p_session_id: state.sessionId,
            p_problem_id: state.problem.id
        });
        state.recording = false;

        if (recorded.error || !recorded.data) {
            console.error('Failed to record result:', recorded.error && recorded.error.message);
            setFeedback('Saving your answer… one moment.', 'neutral');
            setTimeout(finishProblem, 3000);
            return;
        }

        var r = recorded.data;
        var correct = r.is_correct === true;
        var from = Number(r.topic_before) || state.topic;
        var to = Number(r.topic) || state.topic;

        state.answered = Number(r.problems_answered) || (state.answered + 1);
        if (correct) { state.correct++; }
        state.streak = Number(r.streak) || 0;
        state.topic = to;
        paintProgress();
        paintHintButton();
        syncProgress();

        if (r.topic_change === 'up') {
            toast('Topic ' + to + ' unlocked', 'Next: ' + topicOf(to).title + '.', 'accent');
        } else if (r.topic_change === 'down') {
            toast('Back to topic ' + to, 'A little more practice on ' + topicOf(to).title + '.', 'accent');
        }

        if (correct) {
            var smooth = r.classification === 'smooth';
            setFeedback(smooth ? 'Correct — and quickly too!' : 'Correct. Nice work.', 'correct');
            setSpeech(topicSpeech(r.topic_change, from, to) ||
                (smooth ? 'That was sharp. Let’s keep going.' : 'Well done. Let’s keep going.'));
            setTimeout(advance, r.topic_change ? 2400 : 1400);
            return;
        }

        /* Only now, with the question closed, may the answer be shown. */
        var sol = await sb.rpc('reveal_question_solution', {
            p_session_id: state.sessionId,
            p_problem_id: state.problem.id
        });
        var answer = sol.data && sol.data.final_answer;
        setFeedback(answer ? 'The answer was ' + answer : 'That’s alright — let’s move on.', 'neutral');
        if (sol.data) { showWorkedSolution(sol.data.steps); }
        setSpeech(topicSpeech(r.topic_change, from, to) ||
            'No problem at all. Read how it works, then carry on when you are ready.');

        setAnswerButton('next');
        $('#submit-btn').focus({ preventScroll: true });
    }

    function advance() {
        if (state.ended) { return; }
        if (state.answered >= SESSION_TARGET) { endSession(); }
        else { nextProblem(); }
    }

    /* ============================================ 7. HINTS ============= */

    /* consume_question_hint() returns the next hint -- Concept, Setup, then
       Worked calculation, step by step -- and counts it. A hint read any
       other way would not raise hints_used, which would quietly inflate the
       'smooth' rate, the number the study measures. */
    async function handleHint() {
        var btn = $('#hint-btn');
        if (btn.disabled || !problemOpen() || state.hinting) { return; }
        state.hinting = true;
        btn.disabled = true;
        suggestHint(false);

        var res = await sb.rpc('consume_question_hint', {
            p_session_id: state.sessionId,
            p_problem_id: state.problem.id
        });
        state.hinting = false;

        if (res.error || !res.data) {
            paintHintButton();
            setFeedback('Could not load a hint. Please try again.', 'wrong');
            return;
        }

        var d = res.data;
        if (d.hint) {
            appendHint(d.hint);
            state.hintsUsedTotal++;
        }
        state.hintsUsed = Number(d.hints_used) || state.hintsUsed;
        state.hintsLeft = Number(d.hints_left) || 0;
        if (d.locked) { state.problem.locked = true; }
        paintHintButton();

        var tier = d.hint ? Number(d.hint.tier) : 0;
        setSpeech(tier === 1 ? 'Here’s the idea behind this step. Try it from there.'
            : tier === 2 ? 'Here’s how to set it up. Can you finish the calculation?'
            : tier === 3 ? 'Here’s the worked calculation. Use it for the next part.'
            : 'That was the last hint for this one. You can do it!');

        armHintOffer();
        syncProgress();
    }

    /* ============================================ 8. SYNC + END ======== */

    /* Feeds the admin console's live view. Display fields only — nothing the
       research data is derived from. */
    async function syncProgress() {
        if (!state.email || state.ended) { return; }
        await sb.from('profiles').update({
            current_problem: state.problemNumber,
            current_difficulty: 'Topic ' + state.topic + ' · ' + topicOf(state.topic).short,
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

        var answered = summary ? Number(summary.problems_answered) || 0 : state.answered;
        var correct = summary ? Number(summary.correct_count) || 0 : state.correct;
        /* The topic is the one record_question_result() last returned. The
           view's final_level is not used: it was defined outside this repo
           and may still replay the algebra rules. */
        var topic = state.topic;
        var accuracy = answered > 0 ? Math.round((correct / answered) * 100) : 0;

        $('#summary-correct').textContent = correct + ' / ' + answered;
        $('#summary-accuracy').textContent = accuracy + '%';
        $('#summary-level').textContent = 'Topic ' + topic;
        $('#summary-lede').textContent = state.bankEmpty && answered < SESSION_TARGET
            ? 'That’s every question available for now. Your teacher will add more.'
            : (accuracy >= 70
                ? 'Strong session — you worked through the harder ones too.'
                : 'Good effort. Every one of these gets easier with practice.');

        await sb.from('profiles').update({
            is_in_game: false,
            current_difficulty: 'Topic ' + topic + ' · ' + topicOf(topic).short
        }).eq('email', state.email);

        if (state.sessionId) {
            await sb.rpc('end_game_session', { p_session_id: state.sessionId });
        }

        /* The final payload: locks the seconds spent on this stage. */
        await finalizeStageTime('Tutoring Dashboard');
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

        /* A stage closed mid-lesson lets the student finish it (function.js
           1C-5c); time in the stage is counted while the tab is visible. */
        window.PIA_HAS_ACTIVE_WORK = function () { return state.inSession && !state.finished; };

        /* Tell the admin view where this student is. If the stage was closed
           in the meantime the server says so, and we follow it. */
        var stageRes = await sb.rpc('set_student_stage', { p_stage: 'Tutoring Dashboard' });
        if (stageRes.data && stageRes.data.granted === false) {
            window.location.replace('waiting-room.html');
            return;
        }
        startStageHeartbeat('Tutoring Dashboard');

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
        /* Typing is progress: the "stuck?" offer waits while they work. */
        $('#answer-input').addEventListener('input', armHintOffer);

        /* Show any progress already recorded, so a resumed session is obvious
           before the student presses anything. The session this returns is
           the one Start uses -- asking twice used to open a second one. */
        var peek = await sb.rpc('resume_or_start_game_session');
        if (peek.data && peek.data.session_id) {
            applySession(peek.data);

            $('#fact-progress').textContent = state.answered;
            $('#fact-target').textContent = SESSION_TARGET;

            var where = 'You are on topic ' + state.topic + ': ' + topicOf(state.topic).title + '.';
            if (peek.data.resumed) {
                $('#start-btn-label').textContent = 'Continue my session';
                $('#start-lede').textContent = (state.answered > 0
                    ? 'You already answered ' + state.answered + ' of ' + SESSION_TARGET + '. '
                    : '') + where + ' Pick up right where you left off.';
            } else if (state.topic > 1) {
                $('#start-lede').textContent = where + ' Take your time — there’s no timer, and you can ask ' +
                    'for a hint whenever you’re stuck.';
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
                    if (open) { return; }
                    if (window.PIA_HAS_ACTIVE_WORK()) { showStageClosedNotice(); return; }
                    window.location.replace('waiting-room.html');
                }).subscribe();
            });
        }
    }

    async function handleStart() {
        if (state.starting) { return; }
        state.starting = true;
        var release = setBusy($('#start-btn'), 'Starting…');

        var ok = state.sessionId ? true : await startOrResume();
        if (!ok) { release(); state.starting = false; return; }

        await sb.from('profiles').update({
            is_in_game: true,
            current_difficulty: 'Topic ' + state.topic + ' · ' + topicOf(state.topic).short
        }).eq('email', state.email);

        release();
        state.inSession = true;
        showScreen('session');
        setSpeech('Let’s begin. Read the problem carefully, then work it out step by step.');
        await nextProblem();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
