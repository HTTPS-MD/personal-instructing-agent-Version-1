/**
 * ============================================================================
 * PIA SYSTEM — STUDENT WORKSPACE (the tutoring game)
 * ============================================================================
 * The Grade 7 tutoring surface: a start screen, the step-by-step game, and a
 * time-limit dialog. One page, because function.js routes STUDENT_STAGES.dash here.
 *
 * WHO GETS HERE. Only an experimental group with a saved tutor: assigned and
 * neutral students have the tutor their admin set; free-choice students have
 * the one they chose in Character Selection. Control never does. That is
 * decided by enforceStudentStage('dash') in the browser and, again, by
 * pia_game_email() in every game call on the server (migration 0038). This
 * file never reads a group, a tutor or a result from the URL or from
 * localStorage: the tutor on screen is profiles.selected_character.
 *
 * RESEARCH INTEGRITY — two rules this file must never break:
 *
 *   1. ocean_* is never selected. The Big Five breakdown must not reach the
 *      student's browser at all, not merely be hidden with CSS.
 *
 *   2. The browser never asserts performance, and never holds an answer.
 *      serve_next_step_question() picks a question and sends its statement;
 *      check_step_answer() compares what the student typed and says what
 *      happened (wrong / working accepted / step done); consume_step_hint()
 *      gives and counts each hint; finish_step_question() records the
 *      question and decides whether to OFFER a topic change;
 *      respond_topic_offer() applies the student's answer. This file sends
 *      what the student typed and renders what the server replies. It never
 *      sends "correct: true", never evaluates an answer, never picks a
 *      question and never decides a topic.
 *
 * TIME. The admin sets one CLOSING TIME for the tutoring (app_config.game_closes_at,
 * migration 0045). The SERVER owns it: after it, answers and hints are refused,
 * whether the student stays, quits or comes back, until the admin sets a later one.
 * The student is shown no clock, no limit and no time at all, so there is no
 * pressure; the page only learns "closed or not" and says "Tutoring is closed".
 *
 * TUTOR WORDING. The words the tutor says come from tutor-personas.js and are
 * cosmetic. Their "learning profile" comes from the ML service, reached
 * ONLY through the Edge Function `learning-profile` (never from this page).
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

    /* The tutor's wording profile: 'struggling', 'average' or 'outstanding'.
       It starts at 'average' and is moved ONE step at a time toward the profile
       the ML service returns. The page never talks to that service:
       it asks the Edge Function `learning-profile` with the session id and nothing
       else. The function reads the numbers from the database as this student and
       holds the service's secret. If the call fails or the function is not set up,
       the profile simply stays where it is. Wording only: never what is asked or
       how anything is checked. */
    var LEARNING_PROFILE = 'average';
    var PROFILE_ORDER = ['struggling', 'average', 'outstanding'];
    var profileCall = 0;

    var TUTOR_NAMES = {
        'pia-open': 'Ava · your curious tutor',
        'pia-conscientious': 'Cara · your organised tutor',
        'pia-extravert': 'Theo · your energetic tutor',
        'pia-agreeable': 'Amy · your patient tutor',
        'pia-calm': 'Kai · your careful tutor',
        'pia-neutral': 'PIA · your tutor'
    };

    /* The three study topics. The server numbers them 1-3 (question_bank's
       EASY / MEDIUM / HARD); these are only the words on screen. */
    var TOPICS = {
        1: { short: 'Finding a percentage', name: 'Topic 1 - Finding Percentage' },
        2: { short: 'Percentage increase', name: 'Topic 2 - Percentage Increase' },
        3: { short: 'Percentage decrease', name: 'Topic 3 - Percentage Decrease' }
    };

    function topicOf(n) { return TOPICS[n] || TOPICS[1]; }

    /* The game's own wording above the problem. */
    var TOPIC_TITLES = { 1: 'Topic 1: Finding Percentage', 2: 'Topic 2: Percentage Increase', 3: 'Topic 3: Percentage Decrease' };
    function topicTitle(n) { return TOPIC_TITLES[n] || TOPIC_TITLES[1]; }

    /* What the confirm box asks for once correct working has been accepted. */
    var CONFIRM = {
        decimal: {
            label: 'Converted decimal', prompt: 'Now write the converted decimal.',
            placeholder: 'e.g. 0.8', button: 'Submit conversion',
            error: 'Enter the converted decimal value only.'
        },
        percentage: {
            label: 'Final percentage', prompt: 'Now write the final percentage.',
            placeholder: 'e.g. 20 or 20%', button: 'Submit conversion',
            error: 'Enter the final percentage as a number, with or without the % sign.'
        },
        number: {
            label: 'Final answer', prompt: 'Now write the final answer.',
            placeholder: 'Enter final value', button: 'Submit final answer',
            error: 'Enter the final numeric answer only, not the calculation.'
        }
    };

    var FAST_CORRECT_MS = 12000;      /* wording only: picks a "that was quick" line */
    var STREAK_FOR_PRAISE = 3;

    /* Display state only. Every number that matters is re-read from the
       server; these exist so the screen has something to paint between
       round trips. */
    var state = {
        profile: null,
        email: null,
        sessionId: null,
        topic: 1,
        problem: null,       /* see applyQuestion() */
        answered: 0,
        clean: 0,            /* questions finished without a wrong answer */
        streak: 0,
        hintsUsedTotal: 0,
        solved: [],          /* this visit only: { number, topic, question, steps } */
        errors: [],          /* this visit only: the student's own wrong entries */
        preview: null,       /* index into solved[] while a solved question is being reviewed */
        stepWrong: 0,        /* wording only */
        correctRun: 0,       /* wording only */
        stepStartedAt: 0,    /* wording only; never sent anywhere */
        submitting: false,
        hinting: false,
        finishing: false,
        offering: false,
        pendingOffer: null,
        starting: false,
        bankEmpty: false,
        expired: false,
        expiring: false,
        restarting: false,
        finished: false,
        inSession: false,   /* a lesson has been started and not yet ended (see PIA_HAS_ACTIVE_WORK) */
        ended: false        /* another device took the account (function.js 1C-6) */
    };

    /* The database already refuses this device's writes; this stops the page
       queuing more of them (the next problem, a progress sync) behind the
       notice. */
    window.addEventListener('pia:session-ended', function () { state.ended = true; });

    /* ============================================ 1. SCREENS =========== */

    /* The game frame fills the space under whatever is above it (the header, and the
       tutorial's replay note when it is showing), so its panes scroll inside it and
       the page itself never does. Phones stack instead and need no fixed height. */
    var fitQueued = false;
    function fitGameFrame() {
        var frame = $('.game-frame');
        if (!frame || !document.body.classList.contains('is-playing')) { return; }
        if (window.innerWidth <= 900) { frame.style.height = ''; return; }
        frame.style.height = '';
        var top = frame.getBoundingClientRect().top;
        frame.style.height = Math.max(560, Math.floor(window.innerHeight - top - 22)) + 'px';
    }
    function queueFit() {
        if (fitQueued) { return; }
        fitQueued = true;
        requestAnimationFrame(function () { fitQueued = false; fitGameFrame(); });
    }
    window.addEventListener('resize', queueFit);
    if (window.ResizeObserver) { new ResizeObserver(queueFit).observe(document.body); }

    function showScreen(name) {
        $$('.screen').forEach(function (node) {
            node.classList.toggle('is-active', node.id === 'screen-' + name);
        });
        /* The game fills the space under the header; the start screen scrolls. */
        document.body.classList.toggle('is-playing', name === 'session');
        queueFit();
        window.scrollTo({ top: 0, behavior: 'auto' });

        /* The classroom video behind the tutor: only while the game is showing,
           and never for people who ask for reduced motion (the poster stays). */
        if (name === 'session') { startMentorVideo(); }
    }

    /* The classroom behind the tutor: the landing page's own hero film, added only
       when the game starts and never for people who ask for reduced motion (they
       keep the still, which is the CSS background). */
    function startMentorVideo() {
        var side = $('.video-mentor-sidebar');
        if (!side || $('#mentor-video')) { return; }
        var calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (calm) { return; }

        var video = document.createElement('video');
        video.id = 'mentor-video';
        video.className = 'mentor-bg-video';
        video.muted = true; video.loop = true; video.playsInline = true;
        video.setAttribute('aria-hidden', 'true');
        video.tabIndex = -1;
        video.preload = 'metadata';
        video.poster = '../../assets/images/hero-classroom-poster.jpg';
        var src = document.createElement('source');
        src.src = '../../assets/videos/hero-classroom-720.mp4';
        src.type = 'video/mp4';
        video.appendChild(src);
        side.insertBefore(video, side.firstChild);
        var p = video.play();
        if (p && p.catch) { p.catch(function () {}); }
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

    /* The game closed a solved-question review with Escape. */
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && state.preview !== null && !openLayers.length) { closePreview(); }
    });

    function initModals() {
        $$('.overlay').forEach(function (overlay) {
            overlay.addEventListener('mousedown', function (e) {
                if (e.target === overlay && !overlay.hasAttribute('data-static')) { closeModal(overlay); }
            });
            $$('[data-modal-close]', overlay).forEach(function (btn) {
                btn.addEventListener('click', function () { closeModal(overlay); });
            });
        });

        document.addEventListener('keydown', function (event) {
            if (!openLayers.length) { return; }
            var top = openLayers[openLayers.length - 1];

            if (event.key === 'Escape') {
                event.preventDefault();
                /* A pending choice (the topic offer) is answered, not dismissed. */
                if (!top.hasAttribute('data-static')) { closeModal(top); }
                return;
            }
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

    /* ============================================ 3. TUTOR ============= */

    var tutor = null;          /* PIA_TUTORS[selected_character] */
    var tutorKey = null;

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) { node.className = className; }
        if (text != null) { node.textContent = text; }
        return node;
    }

    /* The attached game never lets a tutor line contain a long dash. */
    function clean(text) {
        return String(text == null ? '' : text).replace(/\s*[—–]\s*/g, ', ');
    }

    /* Shuffle bag: every line is used once before any repeats, and a new
       round never opens with the line that closed the last one. */
    var bags = {};

    function pickLine(bucket, lines) {
        var pool = [];
        (Array.isArray(lines) ? lines : []).forEach(function (l) {
            var t = String(l || '').trim();
            if (t && pool.indexOf(t) === -1) { pool.push(t); }
        });
        if (!pool.length) { return ''; }
        if (pool.length === 1) { return pool[0]; }

        var sig = pool.join('␞');
        var bag = bags[bucket];
        if (!bag || bag.sig !== sig || !bag.left.length) {
            var left = pool.slice();
            for (var i = left.length - 1; i > 0; i--) {
                var j = Math.floor(Math.random() * (i + 1));
                var tmp = left[i]; left[i] = left[j]; left[j] = tmp;
            }
            if (bag && bag.last && left[0] === bag.last) {
                var swap = left.findIndex(function (l, n) { return n > 0 && l !== bag.last; });
                if (swap > 0) { var t2 = left[0]; left[0] = left[swap]; left[swap] = t2; }
            }
            bag = bags[bucket] = { sig: sig, left: left, last: bag ? bag.last : '' };
        }
        bag.last = bag.left.shift();
        return bag.last;
    }

    function wording() {
        if (!tutor) { return null; }
        return tutor.profiles[LEARNING_PROFILE] || tutor.profiles.average;
    }

    function line(type) {
        var bank = wording();
        return bank ? pickLine('say:' + tutorKey + ':' + type, bank[type]) : '';
    }

    function reaction(type, fallbackType) {
        var bank = wording();
        var list = bank && bank.reactions && bank.reactions[type];
        if (Array.isArray(list) && list.length) { return pickLine('react:' + tutorKey + ':' + type, list); }
        return fallbackType ? line(fallbackType) : '';
    }

    function setSpeech(text) {
        var node = $('#agent-speech');
        if (node) { node.textContent = clean(text); }
    }

    /* The tutor's pictures. Each expression is decoded before it replaces the
       last, so the figure never blinks empty between two moods. A picture that is
       missing or fails to load is replaced, for that mood only, by the previous
       illustration of the same tutor (tutor.fallback); excited falls back to
       happy. Nothing here ever chooses a different tutor. */
    var preloaded = {};
    var missing = {};          /* mood -> true once its 3D picture failed to load */
    var moodToken = 0;
    var currentMood = 'default';

    function knownMood(mood) { return tutor && tutor.images[mood] ? mood : 'default'; }

    function moodSrc(mood) {
        var m = knownMood(mood);
        return missing[m] ? tutor.fallback[m] : tutor.images[m];
    }

    /* Wired to every tutor <img>: if the picture it is showing cannot load, show
       that mood's fallback instead (once; a failing fallback is left alone). */
    function guardImage(img) {
        if (!img || img.dataset.guarded) { return; }
        img.dataset.guarded = '1';
        img.addEventListener('error', function () {
            if (!tutor) { return; }
            var shown = img.getAttribute('src');
            Object.keys(tutor.images).forEach(function (m) {
                if (tutor.images[m] === shown) {
                    missing[m] = true;
                    if (tutor.fallback[m] && tutor.fallback[m] !== shown) { img.setAttribute('src', tutor.fallback[m]); }
                }
            });
        });
    }

    function setMood(mood) {
        if (!tutor) { return; }
        currentMood = knownMood(mood);
        var src = moodSrc(currentMood);
        var img = $('#agent-img');
        if (!img || !src || img.getAttribute('src') === src) { return; }

        var token = ++moodToken;
        var pre = preloaded[currentMood];
        var ready = pre && pre.decode && !missing[currentMood] ? pre.decode().catch(function () {}) : Promise.resolve();
        ready.then(function () {
            if (token === moodToken) { img.setAttribute('src', moodSrc(currentMood)); }
        });
    }

    /* A line with a face to go with it: default, happy, excited, sad or thinking. */
    var talkTimer = null;

    function speak(text, mood) {
        if (text) {
            setSpeech(text);
            /* The game's little bubble pop and tutor bounce; CSS turns both off
               for people who ask for reduced motion. */
            var box = $('#status-msg'), img = $('#agent-img');
            if (box) { box.classList.remove('speaking'); void box.offsetWidth; box.classList.add('speaking'); }
            if (img) {
                img.classList.add('talking');
                clearTimeout(talkTimer);
                talkTimer = setTimeout(function () { img.classList.remove('talking'); }, 1400);
            }
        }
        setMood(mood || 'default');
    }

    /* Returns false when the saved tutor is not one this game knows. The page
       then refuses to start: a tutor is never picked for the student. */
    function applyCharacter(key) {
        var found = window.PIA_TUTORS && window.PIA_TUTORS[key];
        if (!found) { return false; }

        tutor = found;
        tutorKey = key;

        /* Load every expression now, so a mood change never flashes. One that
           cannot be loaded is marked missing and its fallback is used. */
        preloaded = {};
        missing = {};
        currentMood = 'default';
        Object.keys(tutor.images).forEach(function (m) {
            var p = new Image();
            p.onerror = function () {
                missing[m] = true;
                var fb = new Image(); fb.src = tutor.fallback[m];
                var shown = $('#agent-img');
                if (shown && currentMood === m) { shown.setAttribute('src', moodSrc(m)); }
            };
            p.src = tutor.images[m];
            preloaded[m] = p;
        });

        var label = TUTOR_NAMES[key] || 'PIA · your tutor';
        var first = label.split(' · ')[0];
        ['#agent-name', '#agent-name-start'].forEach(function (sel) {
            var node = $(sel); if (node) { node.textContent = label; }
        });
        ['#agent-img', '#agent-img-start'].forEach(function (sel) {
            var img = $(sel);
            if (!img) { return; }
            guardImage(img);
            img.setAttribute('src', moodSrc('default'));
            img.setAttribute('alt', 'Your tutor, ' + first);
        });
        return true;
    }

    /* ============================================ 4. PROGRESS ========== */

    function problemOpen() { return !!state.problem && !state.problem.locked && state.preview === null; }

    /* The hint button keeps its place from the first paint; it is only
       invisible until the server says two wrong answers have unlocked it (and
       while a solved question is being reviewed). */
    function paintHintButton() {
        var btn = $('#hint-btn');
        var open = !!state.problem && !state.problem.locked && state.problem.hintUnlocked && state.preview === null && !state.expired;
        btn.classList.toggle('is-away', !open);
        btn.disabled = !open || state.hinting;

        var tier = state.problem && state.problem.hint;
        $('#hint-tier-label').textContent = tier ? '(Tier ' + tier.tier + '/' + tier.total + ')' : '';
    }

    /* ---- 4.1 Solved questions (click to review) and the error log ---- */

    function paintSolved() {
        var list = $('#solved-list');
        list.textContent = '';
        if (!state.solved.length) {
            list.appendChild(el('div', 'q-history-empty', 'No solved questions yet'));
            return;
        }
        state.solved.forEach(function (q, idx) {
            var btn = el('div', 'q-btn active' + (state.preview === idx ? ' previewing' : ''));
            btn.setAttribute('role', 'button');
            btn.setAttribute('tabindex', '0');
            btn.setAttribute('title', 'Click to preview this solved question');
            btn.setAttribute('aria-label', 'Preview solved question: ' + q.question);
            if (state.preview === idx) { btn.setAttribute('aria-pressed', 'true'); }
            btn.appendChild(el('span', 'q-btn-equation', q.question));
            btn.addEventListener('click', function () { openPreview(idx); });
            btn.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPreview(idx); }
            });
            list.appendChild(btn);
        });
    }

    /* The game kept the last five. */
    function paintErrors() {
        var list = $('#error-list');
        list.textContent = '';
        state.errors.slice(-5).forEach(function (e) { list.appendChild(el('div', 'history-item', e)); });
    }

    /* The game's solved-question preview: the workspace shows the student's own
       work for that question, read-only, until they go back. */
    function openPreview(idx) {
        var q = state.solved[idx];
        if (!q || state.expired) { return; }
        state.preview = idx;
        $('#center-panel').classList.add('solved-preview-mode');
        $('#problem-kicker').textContent = 'Solved Review • ' + topicTitle(q.topic);
        $('#problem-expression').textContent = q.question;

        var box = $('#steps');
        box.textContent = '';
        var bar = el('div', 'workspace-preview-toolbar');
        bar.appendChild(el('div', 'workspace-preview-heading', 'Your solved work'));
        var back = el('button', 'workspace-preview-back', '← Back to current question');
        back.type = 'button';
        back.id = 'preview-back';
        back.addEventListener('click', closePreview);
        bar.appendChild(back);
        box.appendChild(bar);

        q.steps.forEach(function (st) {
            var block = el('div', 'workspace-preview-step');
            block.appendChild(el('div', 'workspace-preview-step-title', st.title));
            block.appendChild(el('div', 'workspace-preview-answer-label', 'Your answer'));
            block.appendChild(el('div', 'workspace-preview-answer', st.confirmed ? st.text + ' → ' + st.confirmed : st.text));
            box.appendChild(block);
        });

        paintSolved();
        paintHintButton();
        back.focus({ preventScroll: true });
        $('#center-panel').scrollTop = 0;
    }

    function closePreview() {
        if (state.preview === null) { return; }
        state.preview = null;
        $('#center-panel').classList.remove('solved-preview-mode');
        paintSolved();
        if (state.problem) { renderProblem(); }
        else if (state.bankEmpty) { noQuestions(); }
    }

    /* ============================================ 4b. CLOSING TIME ===== */

    /* The admin sets one closing time for the tutoring. The student is never shown a
       clock, a limit or the time: only the server knows it. Every reply that carries
       a `clock` says whether the tutoring is closed; once it is, nothing more is
       accepted (the server refuses answers and hints) and the page says so, with no
       time in it. Opened again by the admin, a refresh continues where they stopped. */
    function syncClock(c) {
        if (!c) { return; }
        if ((c.closed === true || c.expired === true) && state.inSession) { expire(); }
    }

    function lockForExpiry() {
        var input = $('#step-input'), submit = $('#step-submit');
        if (input) { input.disabled = true; }
        if (submit) { submit.disabled = true; }
        $('#hint-btn').disabled = true;
    }

    function expire() {
        if (state.expired) { return; }
        closePreview();
        state.expired = true;
        lockForExpiry();
        speak('Tutoring is closed for now. Thank you for your hard work!', 'default');
        $('#time-announce').textContent = 'Tutoring is closed.';
        openModal('modal-time');
    }

    function noQuestions() {
        state.bankEmpty = true;
        $('#problem-kicker').textContent = 'No problems yet';
        $('#problem-expression').textContent = 'No configured questions are available. Please ask your teacher to check the question bank.';
        $('#steps').textContent = '';
        speak(null, 'default');
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
        state.clean = Number(d.correct_count) || 0;
        state.topic = Number(d.topic) || 1;
        state.streak = Number(d.consecutive_correct) || 0;
    }

    /* The question as the server describes it. Nothing in here is a key: the
       steps the student has already finished carry their own entries. */
    function applyQuestion(d) {
        var prev = state.problem;
        var sameQuestion = prev && prev.id === d.problem_id;
        state.problem = {
            id: d.problem_id,
            number: Number(d.problem_number) || (state.answered + 1),
            question: String(d.question || ''),
            topic: Number(d.topic) || state.topic,
            questionTopic: Number(d.question_topic) || Number(d.topic) || 1,
            stepsTotal: Number(d.steps_total) || 0,
            labels: Array.isArray(d.step_labels) ? d.step_labels : [],
            stepIndex: Number(d.current_step) || 0,
            stage: d.stage === 'confirm' ? 'confirm' : 'work',
            confirmKind: CONFIRM[d.confirm_kind] ? d.confirm_kind : 'number',
            workText: d.work_text || '',
            doneSteps: Array.isArray(d.done_steps) ? d.done_steps : [],
            hintUnlocked: d.hint_unlocked === true,
            hintTier: Number(d.hint_tier) || 0,
            locked: d.locked === true,
            hint: sameQuestion ? prev.hint : null
        };
        state.topic = state.problem.topic;
    }

    /* The SERVER picks the question (serve_next_step_question): the student's
       topic, questions they have seen least, then at random. A question still
       open comes back as it was left, so reloading cannot swap it or undo a
       step; an unanswered topic offer comes back instead of a question. */
    async function nextProblem() {
        if (state.ended) { return; }

        var res = await sb.rpc('serve_next_step_question', { p_session_id: state.sessionId });

        if (res.error || !res.data) {
            console.error('Could not load the next question:', res.error && res.error.message);
            speak('I could not reach the server. Trying again…', 'default');
            setTimeout(nextProblem, 4000);
            return;
        }

        var d = res.data;
        syncClock(d.clock);
        if (d.done) { return noQuestions(); }
        if (d.pending_offer) {
            return showOffer(d.pending_offer);
        }

        applyQuestion(d);
        state.stepWrong = 0;
        state.stepStartedAt = Date.now();
        renderProblem();
        syncProgress();
        if (state.expired) { lockForExpiry(); }

        /* Finished on an earlier visit but never recorded: record it now. */
        if (state.problem.locked) { finishProblem(); }
    }

    function renderProblem() {
        var p = state.problem;
        $('#problem-kicker').textContent = topicTitle(p.questionTopic);
        $('#problem-expression').textContent = p.question;
        renderSteps(true);
        paintHintButton();
    }

    /* ============================================ 6. STEPS ============= */

    /* Every finished step stays on screen, in order; the step being worked on
       sits directly below the last one. Built with textContent throughout:
       what the student typed is never treated as markup. */
    function renderSteps(focus) {
        var p = state.problem;
        var box = $('#steps');
        box.textContent = '';

        for (var i = 0; i <= p.stepIndex && i < p.stepsTotal; i++) {
            box.appendChild(buildStep(i, p));
        }

        if (focus && problemOpen()) {
            var input = $('#step-input');
            if (input) {
                input.focus({ preventScroll: true });
                var card = input.closest('.step-card');
                if (card && card.scrollIntoView) {
                    card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                }
            }
        }
    }

    /* One worksheet strip, as in the game: a ruler down the left edge, a
       "Step n of N" pill, the step's name, the student's work, and a footer
       with the verdict and the submit button. Finished steps stay, in order. */
    function lockedInput(value) {
        var input = el('input', 'solution-input');
        input.type = 'text';
        input.disabled = true;
        input.value = value || '';
        input.setAttribute('aria-label', 'Your accepted entry');
        var row = el('div', 'solution-input-row');
        row.appendChild(input);
        return row;
    }

    function buildStep(i, p) {
        var done = i < p.stepIndex || p.locked;
        var label = p.labels[i] || ('Step ' + (i + 1));
        var card = el('section', 'step-card' + (done ? ' correct' : ''));
        card.setAttribute('aria-label', 'Step ' + (i + 1) + ': ' + label);

        var head = el('div', 'step-header');
        head.appendChild(el('div', 'step-number-badge', done ? 'Completed' : 'Step ' + (i + 1) + ' of ' + p.stepsTotal));
        head.appendChild(el('h3', 'step-title', 'Step ' + (i + 1) + ': ' + label));
        card.appendChild(head);

        if (done) {
            var entry = p.doneSteps[i] || {};
            card.appendChild(el('div', 'solution-label', 'Your Step Solution'));
            card.appendChild(lockedInput(entry.text));
            if (entry.confirmed) {
                var conf = CONFIRM[kindOfLabel(label, p.questionTopic)];
                var again = el('div', 'conversion-confirmation');
                again.appendChild(el('div', 'solution-label', conf.label));
                again.appendChild(lockedInput(entry.confirmed));
                card.appendChild(again);
            }
            return card;
        }

        var confirming = p.stage === 'confirm';
        var conf2 = CONFIRM[p.confirmKind];

        if (confirming) {
            card.appendChild(el('div', 'solution-label', 'Your Step Solution'));
            card.appendChild(lockedInput(p.workText));
            card.appendChild(el('div', 'feedback-msg correct', 'Correct calculation.'));
        }

        var form = el('form', 'step-form' + (confirming ? ' conversion-confirmation' : ''));
        form.noValidate = true;
        form.addEventListener('submit', onStepSubmit);

        var labelEl = el('label', 'solution-label', confirming ? conf2.prompt : 'Your Step Solution');
        labelEl.setAttribute('for', 'step-input');
        form.appendChild(labelEl);

        var row = el('div', 'solution-input-row');
        var input = el('input', 'solution-input');
        input.id = 'step-input';
        input.type = 'text';
        input.setAttribute('inputmode', 'text');
        input.setAttribute('autocomplete', 'off');
        input.setAttribute('autocapitalize', 'off');
        input.setAttribute('spellcheck', 'false');
        input.setAttribute('maxlength', '60');
        input.setAttribute('placeholder', confirming ? conf2.placeholder : 'Enter answer');
        input.setAttribute('aria-describedby', 'step-feedback');
        row.appendChild(input);
        form.appendChild(row);

        /* The verdict and the button share one footer row whose height is already
           reserved, so a message arriving moves nothing. */
        var footer = el('div', 'step-footer');
        var feedback = el('div', 'feedback-msg', '');
        feedback.id = 'step-feedback';
        feedback.setAttribute('role', 'status');
        feedback.setAttribute('aria-live', 'polite');
        footer.appendChild(feedback);
        var submit = el('button', 'btn-check-step', confirming ? conf2.button : 'Submit Step');
        submit.type = 'submit';
        submit.id = 'step-submit';
        footer.appendChild(submit);
        form.appendChild(footer);
        card.appendChild(form);
        return card;
    }

    /* The label alone says which box a finished step used. */
    function kindOfLabel(label, topic) {
        if (label !== 'Conversion') { return 'number'; }
        return topic === 1 ? 'decimal' : 'percentage';
    }

    function setStepFeedback(text, tone) {
        var node = $('#step-feedback');
        if (!node) { return; }
        node.textContent = text || '';
        node.classList.toggle('wrong', tone === 'wrong');
        node.classList.toggle('correct', tone === 'correct');
        node.classList.toggle('neutral', tone === 'neutral');
        if (tone === 'wrong') { node.classList.remove('shake'); void node.offsetWidth; node.classList.add('shake'); }
    }

    function onStepSubmit(event) {
        event.preventDefault();
        submitStep();
    }

    async function submitStep() {
        if (state.submitting || !problemOpen()) { return; }

        var input = $('#step-input');
        if (!input) { return; }
        var raw = input.value.trim();

        if (!raw) {
            setStepFeedback('Type your answer first.', 'neutral');
            input.focus();
            return;
        }

        /* Lock BOTH the button and the input. A disabled input fires no
           keydown, which is what actually stops Enter-spam. */
        state.submitting = true;
        input.disabled = true;
        var release = setBusy($('#step-submit'), 'Checking…');

        var res;
        try {
            res = await sb.rpc('check_step_answer', {
                p_session_id: state.sessionId,
                p_problem_id: state.problem.id,
                p_submitted: raw
            });
        } catch (err) {
            res = { error: err };
        }

        state.submitting = false;
        release();

        /* Network trouble fails closed: nothing is counted either way. */
        if (res.error || !res.data || !res.data.state) {
            console.error('Answer check failed:', res.error && res.error.message);
            input.disabled = false;
            setStepFeedback('Could not reach the server. Please try again.', 'wrong');
            input.select();
            return;
        }

        onStepResult(res.data, raw, input);
    }

    /* Ask the database for the profile and move one step toward it. Fire and
       forget: a failure or a stale answer leaves the wording unchanged. */
    async function refreshProfile() {
        var mine = ++profileCall;
        var res;
        try { res = await sb.functions.invoke('learning-profile', { body: { session_id: state.sessionId } }); }
        catch (e) { return; }
        if (mine !== profileCall || !res || res.error || !res.data) { return; }
        var target = PROFILE_ORDER.indexOf(res.data.profile);
        var now = PROFILE_ORDER.indexOf(LEARNING_PROFILE);
        if (target < 0 || now < 0 || target === now) { return; }
        LEARNING_PROFILE = PROFILE_ORDER[now + (target > now ? 1 : -1)];
    }

    function onStepResult(d, raw, input) {
        var p = state.problem;
        var stepNo = p.stepIndex + 1;
        var wasConfirming = p.stage === 'confirm';
        var kind = p.confirmKind;
        var outcome = d.outcome;

        syncClock(d.clock);
        applyQuestion(d.state);
        input.disabled = false;
        refreshProfile();

        if (outcome === 'time_expired') { renderSteps(false); lockForExpiry(); return; }

        if (outcome === 'locked') {
            renderSteps(false);
            paintHintButton();
            if (state.problem.locked) { finishProblem(); }
            return;
        }

        if (outcome === 'wrong' || outcome === 'format_error') {
            state.stepWrong++;
            state.correctRun = 0;

            if (outcome === 'format_error') {
                setStepFeedback(CONFIRM[kind].error, 'wrong');
                speak(reaction('finalFormatError', 'wrong'), 'sad');
                state.errors.push('Step ' + stepNo + ': Final-answer error on "' + raw + '"');
            } else {
                setStepFeedback('Incorrect answer. Try again.', 'wrong');
                speak(reaction(Number(d.state.wrong_streak) >= 2 ? 'wrongRepeated' : 'wrongFirst', 'wrong'), 'sad');
                state.errors.push('Step ' + stepNo + ': Error on "' + raw + '"');
            }
            paintErrors();
            paintHintButton();
            input.select();
            return;
        }

        if (outcome === 'needs_final') {
            /* Right value, but working or the wrong shape: the box changes. */
            state.correctRun++;
            state.problem.hint = null;
            speak((reaction('correctWorkNeedsFinal', 'correct') + ' ' + CONFIRM[state.problem.confirmKind].prompt).trim(), 'happy');
            renderSteps(true);
            paintHintButton();
            return;
        }

        /* step_done / question_done */
        state.correctRun++;
        state.problem.hint = null;
        var kindOfReaction = state.stepWrong > 0 ? 'correctAfterStruggle'
            : (!wasConfirming && Date.now() - state.stepStartedAt <= FAST_CORRECT_MS) ? 'fastCorrect'
            : (state.correctRun >= STREAK_FOR_PRAISE) ? 'correctStreak'
            : 'correctFirstTry';
        /* Quick answers and streaks get the excited picture; the rest, happy. */
        speak(reaction(kindOfReaction, 'correct'),
            (kindOfReaction === 'fastCorrect' || kindOfReaction === 'correctStreak') ? 'excited' : 'happy');

        state.stepWrong = 0;
        state.stepStartedAt = Date.now();
        renderSteps(outcome !== 'question_done');
        paintHintButton();

        if (outcome === 'question_done') {
            var q = state.problem;
            state.solved.push({
                number: q.number,
                topic: q.questionTopic,
                question: q.question,
                steps: q.doneSteps.map(function (s, n) {
                    return { title: 'Step ' + (n + 1) + ': ' + (q.labels[n] || ('Step ' + (n + 1))), text: s.text, confirmed: s.confirmed };
                })
            });
            paintSolved();
            setTimeout(finishProblem, 900);
        }
    }

    /* ============================================ 7. HINTS ============= */

    /* consume_step_hint() returns the next hint for the current step -- tier 1,
       2, 3, then the last tier again -- and counts it. The server refuses until
       two wrong answers have unlocked the button. */
    async function handleHint() {
        var btn = $('#hint-btn');
        if (btn.disabled || !problemOpen() || state.hinting) { return; }
        state.hinting = true;
        btn.disabled = true;

        var res = await sb.rpc('consume_step_hint', {
            p_session_id: state.sessionId,
            p_problem_id: state.problem.id
        });
        state.hinting = false;

        if (res.error || !res.data || !res.data.state) {
            paintHintButton();
            setStepFeedback('Could not load a hint. Please try again.', 'wrong');
            return;
        }

        var d = res.data;
        syncClock(d.clock);
        refreshProfile();
        var keep = state.problem.hint;
        applyQuestion(d.state);
        state.problem.hint = keep;

        if (d.hint) {
            state.problem.hint = { text: d.hint.text, tier: d.hint.tier, total: d.hint.tiers_total, step: d.hint.step };
            state.hintsUsedTotal++;
            speak((reaction('hintRequested', 'hint') + ' ' + d.hint.text).trim(), 'thinking');

            syncProgress();
        }
        paintHintButton();

        var input = $('#step-input');
        if (input) { input.focus({ preventScroll: true }); }
    }

    /* ============================================ 8. FINISH + OFFERS === */

    /* The question is finished. The server records it -- time, hints, errors,
       smooth/struggling -- and says whether to OFFER a topic change. */
    async function finishProblem() {
        if (state.finishing || state.ended) { return; }
        state.finishing = true;

        var res = await sb.rpc('finish_step_question', {
            p_session_id: state.sessionId,
            p_problem_id: state.problem.id
        });
        state.finishing = false;

        if (res.error || !res.data) {
            console.error('Failed to record result:', res.error && res.error.message);
            speak('Saving your work… one moment.', 'default');
            setTimeout(finishProblem, 3000);
            return;
        }

        var r = res.data;
        state.answered = Number(r.problems_answered) || (state.answered + 1);
        if (r.is_correct === true) { state.clean++; }
        state.streak = Number(r.streak) || 0;
        syncProgress();

        if (r.offer) {
            r.offer.problem_id = r.offer.problem_id || state.problem.id;
            return showOffer(r.offer);
        }
        nextProblem();
    }

    /* The tutor offers to move up or back a topic. Only the student's answer
       moves them; the server holds the offer until it has one. */
    function showOffer(offer) {
        var up = offer.type === 'up';
        var target = Number(offer.target_topic) || state.topic;
        var text = clean(pickLine('adapt:' + tutorKey + ':' + offer.type,
            tutor.adaptive[up ? 'upgrade' : 'downgrade']).replace(/\{topic\}/g, topicOf(target).name));

        closePreview();
        $('#offer-text').textContent = text;
        $('#offer-destination').textContent = (up ? 'Available progression: ' : 'Recommended review: ') + topicOf(target).name;

        var img = $('#offer-img');
        guardImage(img);
        img.setAttribute('src', moodSrc(up ? 'excited' : 'default'));
        img.setAttribute('alt', '');

        speak(null, up ? 'excited' : 'default');
        state.pendingOffer = offer;
        state.offering = false;
        openModal('modal-offer');
    }

    async function answerOffer(accept) {
        if (state.offering || !state.pendingOffer) { return; }
        state.offering = true;
        var buttons = [$('#offer-accept'), $('#offer-stay')];
        buttons.forEach(function (b) { b.disabled = true; });

        var res = await sb.rpc('respond_topic_offer', {
            p_session_id: state.sessionId,
            p_problem_id: state.pendingOffer.problem_id || (state.problem && state.problem.id),
            p_accept: accept
        });

        buttons.forEach(function (b) { b.disabled = false; });
        state.offering = false;

        if (res.error || !res.data) {
            console.error('Could not save the choice:', res.error && res.error.message);
            toast('Could not save your choice', 'Please try again.', 'danger');
            return;
        }

        state.topic = Number(res.data.topic) || state.topic;
        state.pendingOffer = null;
        closeModal('modal-offer');
        syncProgress();
        nextProblem();
    }

    /* ============================================ 9. SYNC + END ======== */

    /* Feeds the admin console's live view. Display fields only — nothing the
       research data is derived from. */
    async function syncProgress() {
        if (!state.email || state.ended) { return; }
        var p = state.problem;
        await sb.from('profiles').update({
            current_problem: p ? p.number : state.answered + 1,
            current_difficulty: 'Topic ' + state.topic + ' · ' + topicOf(state.topic).short,
            hints_used: state.hintsUsedTotal,
            consecutive_correct: state.streak
        }).eq('email', state.email);
    }

    /* ============================================ 10. SIGN OUT ========= */

    /* On a shared lab PC an open session means the next student's answers
       land in this student's row. executeForceLogout() releases the device
       slot, signs out globally and clears storage. */
    async function signOut() {
        var mid = !!state.sessionId;
        var ok = await confirmAction({
            title: 'Sign out',
            heading: mid ? 'Leave this session?' : 'Sign out?',
            message: mid
                ? 'Your progress is saved. When you sign back in you will pick up from the same problem.'
                : 'You can sign back in any time with your school email.',
            confirmLabel: 'Sign out'
        });
        if (!ok) { return; }

        /* Nothing ends a session in this game, so this is the one place the
           "in a tutoring session" flag is cleared. It is display-only (the
           admin's Active session view). Deliberately NOT finalizeStageTime():
           that freezes tutoring_time for good, and the student will be back. */
        if (state.inSession && state.email) {
            try { await sb.from('profiles').update({ is_in_game: false }).eq('email', state.email); } catch (e) { /* signing out anyway */ }
        }

        if (typeof executeForceLogout === 'function') { await executeForceLogout(); }
        else { await sb.auth.signOut({ scope: 'global' }); window.location.replace('../../index.html'); }
    }

    /* ============================================ 11. BOOT ============= */

    async function boot() {
        if (typeof sb === 'undefined' || !sb) {
            setBootText('Could not connect.');
            showGlobalError('Could not reach the server. Please refresh the page.');
            return;
        }

        /* The full gate: real session, prerequisite chain (OCEAN done, an
           experimental group, a saved tutor), and the stage flag with the
           admin's per-student override. Redirects on failure -- Control and
           a direct URL included. */
        setBootText('Checking your session…');
        var profile = await enforceStudentStage('dash');
        if (!profile) { return; }

        state.profile = profile;
        state.email = profile.email;

        /* A stage closed mid-lesson lets the student finish it (function.js
           1C-5c); time in the stage is counted while the tab is visible. */
        window.PIA_HAS_ACTIVE_WORK = function () { return state.inSession; };

        /* Tell the admin view where this student is. If the stage was closed
           in the meantime the server says so, and we follow it. */
        var stageRes = await sb.rpc('set_student_stage', { p_stage: 'Tutoring Dashboard' });
        if (stageRes.data && stageRes.data.granted === false) {
            window.location.replace('waiting-room.html');
            return;
        }
        startStageHeartbeat('Tutoring Dashboard');

        /* Deliberately narrow: full_name, selected_character and section only.
           ocean_* must not enter this page — see the header note. */
        var me = await sb.from('profiles')
            .select('full_name, selected_character, section')
            .eq('email', state.email).maybeSingle();

        var name = (me.data && me.data.full_name) || state.email.split('@')[0];
        var firstName = name.trim().split(/\s+/)[0];

        $('#who-name').textContent = name;
        $('#who-meta').textContent = (me.data && me.data.section) ? 'Section ' + me.data.section : 'Student';
        $('#who-initials').textContent = firstName.slice(0, 2).toUpperCase();
        $('#start-hello').textContent = 'Welcome back, ' + firstName + '!';

        initModals();
        $('#hint-btn').addEventListener('click', handleHint);
        $('#signout-btn').addEventListener('click', signOut);
        $('#start-btn').addEventListener('click', handleStart);
        $('#offer-accept').addEventListener('click', function () { answerOffer(true); });
        $('#offer-stay').addEventListener('click', function () { answerOffer(false); });
        $('#closed-signout').addEventListener('click', signOut);
        paintSolved();
        paintErrors();
        paintHintButton();

        /* The tutor is the one on the profile and nothing else. If it is not
           one this game knows, nothing starts and no other is chosen. */
        if (!applyCharacter(me.data && me.data.selected_character)) {
            $('#start-btn').disabled = true;
            showGlobalError(me.data && me.data.selected_character
                ? 'Your tutor could not be loaded. Please tell your teacher.'
                : 'Your tutor has not been assigned yet. Please tell your teacher.');
            reveal();
            return;
        }

        /* Show any progress already recorded, so a resumed session is obvious
           before the student presses anything. The session this returns is
           the one Start uses -- asking twice used to open a second one. */
        var peek = await sb.rpc('resume_or_start_game_session');
        if (peek.error) {
            $('#start-btn').disabled = true;
            showGlobalError('Your session could not be loaded. Please refresh the page.');
        } else if (peek.data && peek.data.session_id) {
            applySession(peek.data);

            $('#fact-progress').textContent = state.answered;

            var where = 'You are on topic ' + state.topic + ': ' + topicOf(state.topic).short.toLowerCase() + '.';
            if (peek.data.resumed) {
                $('#start-btn-label').textContent = 'Continue my session';
                $('#start-lede').textContent = (state.answered > 0
                    ? 'You already answered ' + state.answered + ' questions. '
                    : '') + where + ' Pick up right where you left off.';
            } else if (state.topic > 1) {
                $('#start-lede').textContent = where + ' The session has a time limit, and you can ask ' +
                    'for a hint whenever you’re stuck.';
            }
        }

        /* Closed by the admin? Say so on the start screen; the server refuses everything
           anyway. If this call is not available yet, the tutoring is treated as open. */
        var status = await sb.rpc('tutoring_status');
        if (status.data && status.data.closed === true) {
            $('#start-btn').disabled = true;
            $('#start-lede').textContent = 'Tutoring is closed right now. Please wait for your teacher to open it again.';
        }

        reveal();

        /* First visit only, per account (student-tutorial.js). Never blocks
           the dashboard: a failure there leaves the page fully usable. */
        if (window.PIATutorial) { window.PIATutorial.init(sb).catch(function () {}); }

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
        speak(line('greet') || 'Let’s begin. Read the problem carefully, then work it out step by step.', 'default');
        await nextProblem();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
