/**
 * ============================================================================
 * PIA SYSTEM — BFPT ITEMS
 * ============================================================================
 * The questionnaire's 50 statements and its answer scale, exactly as printed
 * in "The Big Five Personality Test (BFPT)" (openpsychometrics.org printable),
 * as tabulated in 20260722_Table BFPT.pdf. Checked item-for-item, in order,
 * against that document.
 *
 * WHAT IS HERE
 *   The wording a student reads and the five answer labels. The student
 *   questionnaire and the admin results drawer both render from this one
 *   list, so the two can never disagree about what item 23 said.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *   The scoring key. Scores are computed only on the server, by
 *   public.pia_bfpt_score() (migration 0018), from the raw 1-5 answers. The
 *   browser never computes, sends or receives a trait score — so a student
 *   cannot forge one, and cannot read their own.
 *
 * Editing an item here changes what students are asked. The server scores by
 * POSITION (answer 1 is item 1), so reordering this list silently corrupts
 * every result. Do not reorder it.
 * ==========================================================================*/
(function () {
    'use strict';

    /* Each statement completes the stem "I…". */
    var items = [
        /*  1–5  */ "Am the life of the party.", "Feel little concern for others.", "Am always prepared.", "Get stressed out easily.", "Have a rich vocabulary.",
        /*  6–10 */ "Don't talk a lot.", "Am interested in people.", "Leave my belongings around.", "Am relaxed most of the time.", "Have difficulty understanding abstract ideas.",
        /* 11–15 */ "Feel comfortable around people.", "Insult people.", "Pay attention to details.", "Worry about things.", "Have a vivid imagination.",
        /* 16–20 */ "Keep in the background.", "Sympathize with others' feelings.", "Make a mess of things.", "Seldom feel blue.", "Am not interested in abstract ideas.",
        /* 21–25 */ "Start conversations.", "Am not interested in other people's problems.", "Get chores done right away.", "Am easily disturbed.", "Have excellent ideas.",
        /* 26–30 */ "Have little to say.", "Have a soft heart.", "Often forget to put things back in their proper place.", "Get upset easily.", "Do not have a good imagination.",
        /* 31–35 */ "Talk to a lot of different people at parties.", "Am not really interested in others.", "Like order.", "Change my mood a lot.", "Am quick to understand things.",
        /* 36–40 */ "Don't like to draw attention to myself.", "Take time out for others.", "Shirk my duties.", "Have frequent mood swings.", "Use difficult words.",
        /* 41–45 */ "Don't mind being the center of attention.", "Feel others' emotions.", "Follow a schedule.", "Get irritated easily.", "Spend time reflecting on things.",
        /* 46–50 */ "Am quiet around strangers.", "Make people feel at ease.", "Am exacting in my work.", "Often feel blue.", "Am full of ideas."
    ];

    /* Document, p.1: "Person answers questions on a scale of 1-5." */
    var scale = [
        { value: 1, label: 'Disagree' },
        { value: 2, label: 'Slightly disagree' },
        { value: 3, label: 'Neutral' },
        { value: 4, label: 'Slightly agree' },
        { value: 5, label: 'Agree' }
    ];

    window.PIA_BFPT = Object.freeze({
        version: 'bfpt-2026-07-22',
        stem: 'I…',
        items: Object.freeze(items),
        scale: Object.freeze(scale.map(Object.freeze)),
        labelFor: function (value) {
            for (var i = 0; i < scale.length; i++) {
                if (scale[i].value === value) { return scale[i].label; }
            }
            return null;
        }
    });
})();
