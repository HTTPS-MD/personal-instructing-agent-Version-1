/* Tutor dialogue and art, ported verbatim from the attached PIA game (pia-test-main/index.html).
   Dialogue only: nothing here knows an answer, a score or an OCEAN result. Keyed by the saved
   profiles.selected_character value; the tutor shown is always the one on the student's profile. */
window.PIA_TUTORS = (function () {
    'use strict';
const PERSONA_CONFIG = {
    openness: {
        name: "Explorer Mentor",
        images: {
            default: "../../assets/images/tutors/pia-open/default.webp",
            happy: "../../assets/images/tutors/pia-open/happy.webp",
            sad: "../../assets/images/tutors/pia-open/sad.webp",
            thinking: "../../assets/images/tutors/pia-open/default.webp"
        },
        profiles: {
            struggling: {
                greet: [
                    "Let's explore this carefully, one small step at a time.",
                    "No rush, explorer. We'll uncover this problem piece by piece.",
                    "This one may look tricky, but every puzzle becomes clearer when we inspect one clue at a time."
                ],
                correct: [
                    "Great discovery! You found the right step. Let's build on it.",
                    "Nice work! That idea opened the right path forward.",
                    "You found an important clue. Keep following that same reasoning."
                ],
                wrong: [
                    "Interesting try! Let's explore just one part of the problem first.",
                    "Not quite yet. Try looking at the numbers from a different angle.",
                    "That path did not work this time. Let's inspect the clue that matters most."
                ],
                hint: [
                    "Let's uncover one clue together:",
                    "Focus on one small part first:",
                    "Try exploring this clue before solving the whole problem:"
                ],
                mastery: [
                    "Look how far you've explored! Your problem-solving path is getting stronger.",
                    "Excellent progress! You kept exploring until the pattern became clear."
                ]
                ,
                reactions: {
                    wrongFirst: [
                        "Interesting route. Let's inspect one clue and try the step from a new angle.",
                        "That path didn't land yet, but it gave us information. Let's explore one smaller piece."
                    ],
                    wrongRepeated: [
                        "We've tested a couple of paths. Let's narrow the search and focus on the operation this step needs.",
                        "This puzzle is resisting us a little. Let's explore one detail at a time instead of changing everything."
                    ],
                    correctFirstTry: [
                        "Nice discovery! You found the right path on your first try.",
                        "Great insight! You uncovered the key idea right away."
                    ],
                    correctAfterStruggle: [
                        "There it is! Exploring those earlier paths helped you uncover the right one.",
                        "Great comeback, explorer! You kept investigating until the pattern clicked."
                    ],
                    fastCorrect: [
                        "Sharp discovery! You spotted that pattern quickly.",
                        "That connection clicked fast, great pattern spotting!"
                    ],
                    correctStreak: [
                        "You're connecting the patterns now. Keep following that curiosity.",
                        "Nice! You're uncovering the structure from one step to the next."
                    ],
                    hintRequested: [
                        "Let's reveal one clue, not the whole answer, so you can keep exploring.",
                        "Here's one clue to open another path. See what you can discover from it."
                    ],
                    finalFormatError: [
                        "Your idea may be there; now translate it into the exact final form the step is asking for.",
                        "You're close. Keep the reasoning, but express the result in the required final form."
                    ],
                    correctWorkNeedsFinal: [
                        "That reasoning works. Now turn your exploration into one clear final value.",
                        "Nice path! You've done the calculation, now state the final result by itself."
                    ]
                }
            },
            average: {
                greet: [
                    "Hey explorer! Let's discover fresh ways to crack this problem step by step!",
                    "Math is just a puzzle waiting for us to unravel. Ready to explore?"
                ],
                correct: [
                    "Brilliant insight! Your creative approach solved this step perfectly!",
                    "Aha! That's the exact logic we were searching for. Brilliant job!"
                ],
                wrong: [
                    "An interesting attempt! Let's look at this step from a different angle.",
                    "Not quite, but every mistake opens up a new perspective! Let's re-examine."
                ],
                hint: [
                    "Here's a clue to spark your imagination:",
                    "Think about breaking the number down step by step:"
                ],
                mastery: [
                    "Amazing achievement! You have mastered this topic. Choose where you would like to continue."
                ]
                ,
                reactions: {
                    wrongFirst: [
                        "Interesting attempt. Try viewing the calculation from another angle.",
                        "That route was close. Re-examine the relationship between the values."
                    ],
                    wrongRepeated: [
                        "We've explored more than one route. Compare them and identify the point where the logic changes.",
                        "Let's stop guessing paths and inspect the pattern that should connect these numbers."
                    ],
                    correctFirstTry: [
                        "Aha! You found the right pattern on the first try.",
                        "Great insight, you connected the clues immediately."
                    ],
                    correctAfterStruggle: [
                        "Nice recovery! Testing different ideas led you to the right pattern.",
                        "There it is! You used the earlier attempts to discover the better route."
                    ],
                    fastCorrect: [
                        "Excellent pattern recognition, that was quick.",
                        "You spotted the connection fast. Nice exploratory thinking!"
                    ],
                    correctStreak: [
                        "You're seeing the relationships consistently now. Keep exploring efficiently.",
                        "Strong pattern streak! You're connecting each new clue faster."
                    ],
                    hintRequested: [
                        "Here's a clue to spark a new line of thinking:",
                        "Try this clue, then see what connection you can uncover:"
                    ],
                    finalFormatError: [
                        "The reasoning may be right; now express the result in the exact form requested.",
                        "Keep your idea, but convert it into the required final answer format."
                    ],
                    correctWorkNeedsFinal: [
                        "Good reasoning. Now distill that calculation into the final value.",
                        "You found the route, now write only the result it leads to."
                    ]
                }
            },
            outstanding: {
                greet: [
                    "New challenge ahead, explorer. See if you can spot the pattern quickly.",
                    "Let's test your insight. Try finding the most efficient path through this problem.",
                    "Ready for a sharper puzzle? Look for the relationship before you calculate."
                ],
                correct: [
                    "Excellent insight! You recognized the pattern quickly.",
                    "Strong reasoning. You found an efficient route to the answer.",
                    "Sharp discovery! You connected the clues with very little guidance."
                ],
                wrong: [
                    "Interesting result. See if you can identify exactly where the reasoning changed direction.",
                    "That was a strong attempt. Revisit the pattern and find the hidden slip.",
                    "Challenge accepted. Try diagnosing the error before changing your strategy."
                ],
                hint: [
                    "A small clue should be enough:",
                    "Look for a more efficient relationship between the values:",
                    "Use this clue, then see if you can finish the rest independently:"
                ],
                mastery: [
                    "Excellent exploration! You're ready to investigate a more demanding challenge.",
                    "Outstanding reasoning. Keep looking for elegant and efficient solutions."
                ]
                ,
                reactions: {
                    wrongFirst: [
                        "Interesting result. Diagnose where the reasoning changed direction.",
                        "That was a plausible route. Find the exact assumption or operation that caused the miss."
                    ],
                    wrongRepeated: [
                        "Several routes have missed. Compare them and identify the common point of failure.",
                        "Treat this like a puzzle: isolate the step that keeps sending the reasoning off course."
                    ],
                    correctFirstTry: [
                        "Excellent insight. You identified the structure immediately.",
                        "Sharp work, you found an elegant route on the first attempt."
                    ],
                    correctAfterStruggle: [
                        "Excellent recovery. You tested alternatives and found the stronger pattern.",
                        "That adjustment was smart, you used the failed paths to refine the solution."
                    ],
                    fastCorrect: [
                        "Outstanding pattern recognition, you saw the efficient route almost immediately.",
                        "Very sharp. You connected the structure with impressive speed."
                    ],
                    correctStreak: [
                        "You're reading the structure consistently now. Keep looking for the most elegant route.",
                        "Excellent streak. Your pattern recognition is staying both fast and accurate."
                    ],
                    hintRequested: [
                        "One small clue should be enough, use it to infer the rest.",
                        "Here's a minimal nudge. See if you can reconstruct the full path from it."
                    ],
                    finalFormatError: [
                        "The mathematics is close; tighten the presentation into the exact final form required.",
                        "Refine the output format without changing the reasoning."
                    ],
                    correctWorkNeedsFinal: [
                        "The reasoning is sound. Compress it into the final value now.",
                        "Good work. You've shown the path; finish by stating only the result."
                    ]
                }
            }
        }
    },

    conscientiousness: {
        name: "Structured Guide",
        images: {
            default: "../../assets/images/tutors/pia-conscientious/default.webp",
            happy: "../../assets/images/tutors/pia-conscientious/happy.webp",
            sad: "../../assets/images/tutors/pia-conscientious/sad.webp",
            thinking: "../../assets/images/tutors/pia-conscientious/default.webp"
        },
        profiles: {
            struggling: {
                greet: [
                    "We'll handle this carefully. Focus on one step, verify it, then move to the next.",
                    "Let's organize the problem first, then solve each part in order.",
                    "Take your time. A clear sequence will make this problem easier to manage."
                ],
                correct: [
                    "Good. That step is accurate. Keep following the same organized process.",
                    "Correct calculation. Your careful checking is working.",
                    "Well done. One verified step at a time is getting you closer to the solution."
                ],
                wrong: [
                    "Let's slow down and verify the first operation before continuing.",
                    "There is an error here. Recheck each value in order and try again.",
                    "Review the sequence carefully. Fix one step before moving to the next."
                ],
                hint: [
                    "Let's organize the next move:",
                    "Use this step-by-step checkpoint:",
                    "Focus on this part before continuing:"
                ],
                mastery: [
                    "Your careful process has improved. You are solving with more consistency now.",
                    "Excellent progress. Your organized approach is producing reliable results."
                ]
                ,
                reactions: {
                    wrongFirst: [
                        "Let's check the sequence carefully. Verify the first operation before changing anything else.",
                        "One part is off. Recheck each value in order and correct the first mismatch you find."
                    ],
                    wrongRepeated: [
                        "Let's slow the process down. Check one operation at a time and confirm it before moving on.",
                        "We have repeated errors in this step. Use a clear sequence: identify, calculate, then verify."
                    ],
                    correctFirstTry: [
                        "Correct on the first attempt. Your careful setup worked.",
                        "Well organized and accurate. Keep using that same step-by-step process."
                    ],
                    correctAfterStruggle: [
                        "Good correction. You found the error and brought the process back into order.",
                        "Well done. Careful checking paid off and the step is now accurate."
                    ],
                    fastCorrect: [
                        "Accurate and efficient. You completed the step quickly without losing precision.",
                        "Excellent, fast execution with the details still correct."
                    ],
                    correctStreak: [
                        "Your accuracy is becoming consistent. Keep the same organized routine.",
                        "Strong sequence of correct work. Your checking process is reliable."
                    ],
                    hintRequested: [
                        "Let's add one structured checkpoint to guide the next move:",
                        "Use this hint as the next item in your step-by-step process:"
                    ],
                    finalFormatError: [
                        "The final form needs correction. Check the required format, then resubmit only that value.",
                        "Your submission format is the issue. Match the requested form exactly."
                    ],
                    correctWorkNeedsFinal: [
                        "The calculation is correct. Complete the process by writing the final value only.",
                        "Good computation. Now record the final result in the required format."
                    ]
                }
            },
            average: {
                greet: [
                    "Precision mode active. Let's work methodically through each problem step.",
                    "Welcome! Double-check each detail, and we will achieve 100% accuracy."
                ],
                correct: [
                    "Exact calculation! You executed this step with absolute precision.",
                    "Structured and accurate. Perfect work on this computation!"
                ],
                wrong: [
                    "Discrepancy detected in your answer. Verify your calculations and re-submit.",
                    "There is a small arithmetic error in this step. Double-check your numbers carefully."
                ],
                hint: [
                    "Systematic Hint:",
                    "Follow the exact sequence carefully:"
                ],
                mastery: [
                    "Mastery threshold reached. All requirements are met. Choose where you would like to continue."
                ]
                ,
                reactions: {
                    wrongFirst: [
                        "Recheck the calculation in order and verify each value.",
                        "There's a mismatch. Trace the sequence and identify the first incorrect operation."
                    ],
                    wrongRepeated: [
                        "The step needs a more systematic check. Verify each operation before resubmitting.",
                        "Repeated errors suggest one part of the process is being skipped. Review the sequence carefully."
                    ],
                    correctFirstTry: [
                        "Precise work. You completed that step correctly on the first attempt.",
                        "Accurate and orderly, that process worked exactly as intended."
                    ],
                    correctAfterStruggle: [
                        "Good correction. You identified the discrepancy and fixed it accurately.",
                        "Nice recovery. Your verification process caught the error."
                    ],
                    fastCorrect: [
                        "Precise and efficient. That was a clean, fast solution.",
                        "Excellent control, quick without sacrificing accuracy."
                    ],
                    correctStreak: [
                        "Your work is consistently accurate. Maintain the same structured process.",
                        "Strong accuracy streak. Your method is producing reliable results."
                    ],
                    hintRequested: [
                        "Systematic hint, use this as the next checkpoint:",
                        "Add this clue to your sequence, then continue methodically:"
                    ],
                    finalFormatError: [
                        "Your result needs the exact required format. Correct the presentation and resubmit.",
                        "Check the answer format carefully; the final value must match the requested form."
                    ],
                    correctWorkNeedsFinal: [
                        "The calculation checks out. Now submit the final value only.",
                        "Correct process. Finish by recording the result in its required form."
                    ]
                }
            },
            outstanding: {
                greet: [
                    "Let's solve this with precision and efficiency. Plan the sequence before calculating.",
                    "Your goal is not only accuracy today, but a clean and efficient solution path.",
                    "Review the structure first, then execute the shortest reliable sequence."
                ],
                correct: [
                    "Precise and efficient. That step was executed cleanly.",
                    "Excellent control of the process. Your reasoning is both accurate and organized.",
                    "Verified and correct. You maintained precision without unnecessary steps."
                ],
                wrong: [
                    "Recheck the sequence and identify the exact point where the calculation diverged.",
                    "Your structure is close. Audit each operation and locate the single inconsistency.",
                    "Verify the inputs before changing the method; the issue may be one precise detail."
                ],
                hint: [
                    "Use this checkpoint, then complete the remaining sequence independently:",
                    "One precise clue:",
                    "Verify this relationship before proceeding:"
                ],
                mastery: [
                    "Excellent precision. You are ready for a more complex sequence of reasoning.",
                    "Outstanding consistency. Your method is accurate, organized, and efficient."
                ]
                ,
                reactions: {
                    wrongFirst: [
                        "Audit the solution path and locate the exact point where precision was lost.",
                        "Your structure is close. Identify the specific operation that failed verification."
                    ],
                    wrongRepeated: [
                        "Repeated misses mean the process needs a full audit. Verify assumptions, order, and arithmetic.",
                        "Rebuild the sequence cleanly rather than patching the last answer."
                    ],
                    correctFirstTry: [
                        "Excellent precision. The full sequence was correct on the first pass.",
                        "Clean execution, accurate, organized, and complete."
                    ],
                    correctAfterStruggle: [
                        "Strong correction. You isolated the fault and restored an accurate solution path.",
                        "Excellent verification work. You found the exact issue and corrected it."
                    ],
                    fastCorrect: [
                        "Outstanding efficiency, fast execution with full precision.",
                        "Very strong: accurate, concise, and completed quickly."
                    ],
                    correctStreak: [
                        "Your precision is highly consistent. Keep optimizing without skipping verification.",
                        "Excellent run of accurate work. The process is both disciplined and efficient."
                    ],
                    hintRequested: [
                        "Use this as a minimal checkpoint, then complete the remaining sequence independently:",
                        "One verification cue should be enough. Apply it and finish the process."
                    ],
                    finalFormatError: [
                        "The reasoning is strong; tighten the final presentation to the exact required form.",
                        "Only the output format needs correction. Make it precise."
                    ],
                    correctWorkNeedsFinal: [
                        "Verified. Now reduce the work to the exact final value requested.",
                        "The computation is complete; record the result cleanly and precisely."
                    ]
                }
            }
        }
    },

    extraversion: {
        name: "Energetic Coach",
        images: {
            default: "../../assets/images/tutors/pia-extravert/default.webp",
            happy: "../../assets/images/tutors/pia-extravert/happy.webp",
            sad: "../../assets/images/tutors/pia-extravert/sad.webp",
            thinking: "../../assets/images/tutors/pia-extravert/default.webp"
        },
        profiles: {
            struggling: {
                greet: [
                    "We're doing this together! Let's take one small win at a time!",
                    "You got this! We'll break the problem down and build momentum step by step!",
                    "Game on! Start with one part, then we'll power through the rest together!"
                ],
                correct: [
                    "YES! That's it! One strong step down, keep the momentum going!",
                    "Nice one! You got that step right. Let's carry that energy forward!",
                    "There we go! That correct step is exactly the boost we needed!"
                ],
                wrong: [
                    "Still in the game! Let's tackle one smaller piece and come right back at it!",
                    "Almost! Shake that one off, check the numbers, and give it another shot!",
                    "No stop signs here! Let's find the tiny slip and keep moving!"
                ],
                hint: [
                    "Quick boost, try this clue:",
                    "Here's a power-up for the next step:",
                    "Let's get some momentum with this hint:"
                ],
                mastery: [
                    "Look at that progress! You kept pushing and built real momentum!",
                    "Awesome comeback! Your effort turned into stronger problem solving."
                ]
                ,
                reactions: {
                    wrongFirst: [
                        "Not there yet, but you're still in it! Let's hit this step again with one small change.",
                        "Almost! Keep the energy up, we'll tackle one piece at a time."
                    ],
                    wrongRepeated: [
                        "This one is putting up a fight, but so are we! Let's focus on one operation and win that part first.",
                        "Still with me? Good! Let's reset this step, use the clue, and go again."
                    ],
                    correctFirstTry: [
                        "YES! First try, you nailed that step!",
                        "Boom! Right out of the gate, that's correct!"
                    ],
                    correctAfterStruggle: [
                        "YES! There it is! You fought through that one and got it!",
                        "That's the comeback! You stayed with it and smashed the step!"
                    ],
                    fastCorrect: [
                        "Whoa, that was fast AND right! Great work!",
                        "Boom, quick and accurate! That's strong momentum!"
                    ],
                    correctStreak: [
                        "You're on a roll! Keep that correct-answer streak moving!",
                        "Yes! The momentum is building, keep it going!"
                    ],
                    hintRequested: [
                        "Power hint coming in! Use this and take another swing:",
                        "Alright, teammate, here's one boost to get you moving again:"
                    ],
                    finalFormatError: [
                        "You've got the idea, now land it in the exact answer format!",
                        "So close! Keep the math and fix the final form."
                    ],
                    correctWorkNeedsFinal: [
                        "Nice calculation! Now finish strong, write just the final answer.",
                        "Great work! You've done the hard part; now give me the final value."
                    ]
                }
            },
            average: {
                greet: [
                    "Hey hey! Super pumped to solve these awesome math challenges with you today!",
                    "Let me hear you say math! We're gonna crush these questions together!"
                ],
                correct: [
                    "BOOM! You nailed it! Keep that high energy going!",
                    "YESSS! That's what I'm talking about! Total genius power!"
                ],
                wrong: [
                    "No worries at all! Shake it off and let me see you smash it on the next try!",
                    "Almost there! Put your game face on, try once more!"
                ],
                hint: [
                    "Pro-tip coming through!",
                    "You got this! Here's a power hint:"
                ],
                mastery: [
                    "Mastery unlocked. You completed this topic. Choose where you would like to continue."
                ]
                ,
                reactions: {
                    wrongFirst: [
                        "Almost! Shake off that miss and check the calculation once more.",
                        "Close one! Spot the slip and take another shot."
                    ],
                    wrongRepeated: [
                        "Okay, this step is challenging us! Let's lock onto the key operation and try again.",
                        "We're not giving this one away, check the setup, then come back strong."
                    ],
                    correctFirstTry: [
                        "YES! First attempt and it's right!",
                        "Boom! You nailed that step immediately!"
                    ],
                    correctAfterStruggle: [
                        "There it is! Great comeback, you fixed it and got the win!",
                        "YESSS! You turned those misses into a correct answer!"
                    ],
                    fastCorrect: [
                        "Lightning quick AND correct! That's awesome!",
                        "Boom! Fast, accurate, and ready for the next one!"
                    ],
                    correctStreak: [
                        "You're on fire! Keep that streak alive!",
                        "That's another one! Great momentum, keep rolling!"
                    ],
                    hintRequested: [
                        "Pro-tip incoming! Use this boost and go for it:",
                        "Here's your power hint, take it and make the next move:"
                    ],
                    finalFormatError: [
                        "Math looks close, now stick the landing with the right final format!",
                        "Almost scored it! Fix the answer format and send it again."
                    ],
                    correctWorkNeedsFinal: [
                        "Great calculation! Now finish the play with the final value.",
                        "You worked it out, now give me the answer by itself!"
                    ]
                }
            },
            outstanding: {
                greet: [
                    "Big challenge incoming! Let's see how fast you can spot the winning strategy!",
                    "You're on a roll, time to push for a sharp, efficient solution!",
                    "Bring the energy! Try solving this with fewer clues and maximum focus!"
                ],
                correct: [
                    "BOOM, fast and accurate! That's some serious math momentum!",
                    "YES! Clean reasoning and a strong finish. Keep that streak alive!",
                    "That's championship-level focus! You solved it with confidence and control!"
                ],
                wrong: [
                    "Good challenge! Find the slip, fix it, and jump right back in!",
                    "So close! Diagnose that one mistake and keep the streak moving!",
                    "You've got the skills, spot the mismatch and hit it again!"
                ],
                hint: [
                    "Tiny power hint, see what you can do with just this:",
                    "One clue, then you're taking it from here:",
                    "Quick nudge, finish the rest with your own strategy:"
                ],
                mastery: [
                    "Outstanding performance! You're ready to take on a bigger challenge!",
                    "You crushed that level with speed and accuracy. Keep the momentum going!"
                ]
                ,
                reactions: {
                    wrongFirst: [
                        "Good swing! Find the tiny slip and bounce right back.",
                        "That was close, diagnose it fast and attack the step again."
                    ],
                    wrongRepeated: [
                        "This one's a real challenge! Reset the approach and come back with a cleaner play.",
                        "A couple misses now, time to change the game plan and target the exact weak spot."
                    ],
                    correctFirstTry: [
                        "BOOM! Clean first-try finish!",
                        "Yes! You stepped up and nailed it immediately!"
                    ],
                    correctAfterStruggle: [
                        "Huge recovery! You adjusted and came back with the correct answer.",
                        "That's a clutch comeback, you found the fix and delivered!"
                    ],
                    fastCorrect: [
                        "That was blazing fast and dead-on accurate!",
                        "WOW, quick read, quick solve, correct answer!"
                    ],
                    correctStreak: [
                        "You're absolutely rolling! Keep the speed and accuracy together!",
                        "Big streak! Stay sharp and keep the momentum high!"
                    ],
                    hintRequested: [
                        "Tiny boost only, you can take it from here!",
                        "Quick cue coming in. Use it, then finish the challenge yourself!"
                    ],
                    finalFormatError: [
                        "You've got the play, just clean up the final answer format.",
                        "Almost perfect! Tighten the format and finish it."
                    ],
                    correctWorkNeedsFinal: [
                        "Calculation crushed. Now close it out with the final value.",
                        "Great work, finish strong and state the result only."
                    ]
                }
            }
        }
    },

    agreeableness: {
        name: "Supportive Pal",
        images: {
            default: "../../assets/images/tutors/pia-agreeable/default.webp",
            happy: "../../assets/images/tutors/pia-agreeable/happy.webp",
            sad: "../../assets/images/tutors/pia-agreeable/sad.webp",
            thinking: "../../assets/images/tutors/pia-agreeable/default.webp"
        },
        profiles: {
            struggling: {
                greet: [
                    "I'm right here with you. We'll take this gently, one step at a time.",
                    "Take all the time you need. We can work through each part together.",
                    "Let's make this feel manageable. We'll focus on one small step first."
                ],
                correct: [
                    "Wonderful! That step is correct, and your effort is really paying off.",
                    "You did it! Keep trusting the process, we'll take the next step together.",
                    "That's right! I'm glad you kept trying. Let's continue from here."
                ],
                wrong: [
                    "That's okay. Let's look at one smaller part together and try again.",
                    "We're still making progress. Check this step gently and give it another try.",
                    "No worries. We can slow it down and work through the numbers together."
                ],
                hint: [
                    "Here's a gentle clue to help you forward:",
                    "Let's use this small hint together:",
                    "Try this helpful starting point:"
                ],
                mastery: [
                    "You kept going and made wonderful progress. Be proud of how much stronger you've become.",
                    "Your steady effort really showed. You've built more confidence and skill."
                ]
                ,
                reactions: {
                    wrongFirst: [
                        "That's okay, we'll work through this part together. Check one piece and try again.",
                        "You're still making progress. Let's gently revisit the step and see what needs changing."
                    ],
                    wrongRepeated: [
                        "This step is being difficult, but we can stay with it together. Let's use one clue and try a smaller piece.",
                        "A few tries are okay. Let's make the next attempt simpler and focus on just one operation."
                    ],
                    correctFirstTry: [
                        "Wonderful, you got that on your first try! Nice work.",
                        "You did it right away! I'm glad to see your effort paying off."
                    ],
                    correctAfterStruggle: [
                        "You got it! I'm really glad you stayed with that one.",
                        "Wonderful comeback. Your patience and effort paid off."
                    ],
                    fastCorrect: [
                        "Great job! You found the answer quickly and carefully.",
                        "That came together so smoothly, well done!"
                    ],
                    correctStreak: [
                        "You're doing really well. One correct step is building nicely on the next.",
                        "What a lovely streak, your effort is becoming very consistent."
                    ],
                    hintRequested: [
                        "Of course. Here's one helpful clue, and we'll keep working from there:",
                        "I'm with you. Try this hint and see what feels clearer:"
                    ],
                    finalFormatError: [
                        "You're very close. The idea is there; we just need to adjust the final answer format.",
                        "Nice effort. Let's keep the reasoning and gently fix how the final value is written."
                    ],
                    correctWorkNeedsFinal: [
                        "Your calculation is right. Now let's finish it by writing only the final value.",
                        "Lovely work so far, just one last thing: state the final answer clearly."
                    ]
                }
            },
            average: {
                greet: [
                    "Hello my friend! I'm right here beside you, so take all the time you need.",
                    "Don't worry about making mistakes, we'll support each other every step of the way!"
                ],
                correct: [
                    "Wonderful job! I'm so proud of how hard you're working!",
                    "You did so well! Your effort is truly paying off, keep going!"
                ],
                wrong: [
                    "It's completely okay! Math can be tricky, so let's try it again together gently.",
                    "Take a deep breath! Everyone makes mistakes, let's take a peaceful second look."
                ],
                hint: [
                    "Here is a gentle hint for you:",
                    "Don't stress! Here is a helpful tip:"
                ],
                mastery: [
                    "You achieved mastery. Choose where you would like to continue."
                ]
                ,
                reactions: {
                    wrongFirst: [
                        "Almost there. Let's check the calculation together and try once more.",
                        "That's a good attempt. Look over the step again and see what you would change."
                    ],
                    wrongRepeated: [
                        "This one needs a little more support. Let's focus on the key operation and work through it together.",
                        "It's okay to need another try. Let's make the next attempt more focused."
                    ],
                    correctFirstTry: [
                        "Wonderful job, you got it right on the first try!",
                        "You did that beautifully. Great first attempt!"
                    ],
                    correctAfterStruggle: [
                        "You got it! I'm glad you kept working through the tricky part.",
                        "Great recovery. Your persistence really paid off."
                    ],
                    fastCorrect: [
                        "Wonderful, quick and correct! You handled that smoothly.",
                        "Nice work! You found the answer quickly without losing accuracy."
                    ],
                    correctStreak: [
                        "You're building a really strong rhythm. Keep going!",
                        "Another correct one, your steady effort is showing."
                    ],
                    hintRequested: [
                        "Absolutely. Here's a helpful clue to support your next try:",
                        "I'm happy to help. Use this hint and see what you notice:"
                    ],
                    finalFormatError: [
                        "You're close, the reasoning looks promising. Let's just fix the final format.",
                        "Good work. We only need to adjust how the answer is written."
                    ],
                    correctWorkNeedsFinal: [
                        "That's correct work. Now let's complete it with the final value only.",
                        "Nicely done, finish the step by writing the result clearly."
                    ]
                }
            },
            outstanding: {
                greet: [
                    "You've been doing really well. I'll give you more room to lead this solution.",
                    "I'm here if you need me, but try trusting your own strategy on this challenge.",
                    "Let's see what you can do independently. I know you can handle a stronger challenge."
                ],
                correct: [
                    "Beautiful work! You handled that step confidently on your own.",
                    "Excellent! Your reasoning is becoming more independent and reliable.",
                    "You solved that with confidence. Keep trusting your mathematical judgment."
                ],
                wrong: [
                    "That's a useful challenge. Give yourself a moment to find the slip before I step in.",
                    "You're capable of catching this one. Recheck your reasoning and try once more.",
                    "Close! Trust what you know and see if you can identify the mismatch yourself."
                ],
                hint: [
                    "Just a small nudge, you can take it from here:",
                    "I'll give you one clue, then let you lead the rest:",
                    "Use this light hint and trust your own reasoning:"
                ],
                mastery: [
                    "Wonderful achievement. Your independence and confidence have grown so much.",
                    "Excellent work. You're ready to take on a challenge with even more independence."
                ]
                ,
                reactions: {
                    wrongFirst: [
                        "That's a small slip. I think you can spot it, check the step once more.",
                        "Your approach is strong. Look closely and see where one detail needs adjusting."
                    ],
                    wrongRepeated: [
                        "This is a tougher one. Let's stay patient and identify the exact part that keeps causing trouble.",
                        "A couple of misses don't erase your good reasoning. Refocus on the key operation and try again."
                    ],
                    correctFirstTry: [
                        "Beautiful work, correct on the first try.",
                        "Excellent. You handled that confidently and accurately."
                    ],
                    correctAfterStruggle: [
                        "Excellent recovery. You stayed with the challenge and found the correction.",
                        "I'm glad you kept going, that was a thoughtful comeback."
                    ],
                    fastCorrect: [
                        "Excellent, quick, confident, and correct.",
                        "That was very smooth. You understood the step almost immediately."
                    ],
                    correctStreak: [
                        "You're showing wonderful consistency. Keep that calm momentum going.",
                        "Another strong answer. Your accuracy is staying beautifully steady."
                    ],
                    hintRequested: [
                        "Here's a small nudge. I think you'll be able to carry the rest from here:",
                        "Of course, just one clue, then see how far your reasoning takes you:"
                    ],
                    finalFormatError: [
                        "Your reasoning is strong; only the final presentation needs a small adjustment.",
                        "You're essentially there. Refine the answer format and you're done."
                    ],
                    correctWorkNeedsFinal: [
                        "The work is solid. Now finish neatly with the final value.",
                        "Excellent reasoning, just state the final answer clearly now."
                    ]
                }
            }
        }
    },

    neuroticism: {
        name: "Cautious Mentor",
        images: {
            default: "../../assets/images/tutors/pia-calm/default.webp",
            happy: "../../assets/images/tutors/pia-calm/happy.webp",
            sad: "../../assets/images/tutors/pia-calm/sad.webp",
            thinking: "../../assets/images/tutors/pia-calm/default.webp"
        },
        profiles: {
            struggling: {
                greet: [
                    "Let's go carefully. We only need to handle one step at a time.",
                    "No need to rush. We'll check each part before moving forward.",
                    "We'll keep this manageable, one calculation, one check, then the next step."
                ],
                correct: [
                    "Good, that step checks out. Let's continue carefully from here.",
                    "That's correct. Your careful work is keeping us on the right track.",
                    "Nice job. We verified that part, so we can move forward with confidence."
                ],
                wrong: [
                    "Something is off, but we can fix it. Let's check the numbers one at a time.",
                    "Careful here. Revisit the last operation and make sure each value is in the right place.",
                    "We caught an error. That's useful, let's correct it before we continue."
                ],
                hint: [
                    "Let's use one careful clue:",
                    "Check this part first:",
                    "To avoid another slip, focus on this clue:"
                ],
                mastery: [
                    "You handled the challenge carefully and made strong progress.",
                    "Your careful checking paid off. You're becoming more confident with each problem."
                ]
                ,
                reactions: {
                    wrongFirst: [
                        "That one slipped, but we can check it carefully. Start with the first operation and see what changed.",
                        "Not quite. Let's be cautious and verify one part before trying again."
                    ],
                    wrongRepeated: [
                        "This step keeps catching us, so let's reduce the risk: check one operation at a time.",
                        "A few errors have appeared here. Let's slow the checking down and make the next attempt carefully."
                    ],
                    correctFirstTry: [
                        "Good, that one is correct on the first try. Nice careful work.",
                        "That worked! Your careful approach paid off immediately."
                    ],
                    correctAfterStruggle: [
                        "Good, you found it! Careful checking helped you recover from those earlier slips.",
                        "That's a relief, you corrected the tricky part and got the step right."
                    ],
                    fastCorrect: [
                        "Nice, quick and correct. You stayed accurate even at that pace.",
                        "That was fast, and the answer still checks out. Great work."
                    ],
                    correctStreak: [
                        "You're getting a steady run of correct answers now. Keep checking carefully.",
                        "Good consistency. Your careful approach is working step after step."
                    ],
                    hintRequested: [
                        "Let's use one safe clue so we know what to check next:",
                        "Here's a clue to reduce the uncertainty in this step:"
                    ],
                    finalFormatError: [
                        "The calculation may be fine; let's carefully fix the final format before moving on.",
                        "We're very close. Check exactly how the final answer needs to be written."
                    ],
                    correctWorkNeedsFinal: [
                        "The calculation checks out. Now carefully write the final value only.",
                        "Good, your work is correct. Finish by stating the result in the required form."
                    ]
                }
            },
            average: {
                greet: [
                    "Yikes, math problem ahead! Let's go really slow so we don't trip up.",
                    "Take a calm breath... We can tackle this step without getting overwhelmed!"
                ],
                correct: [
                    "Phew! That was a relief! Fantastic job getting that right!",
                    "Oh good, we survived that step! Excellent work!"
                ],
                wrong: [
                    "Oh dear, that wasn't right! Don't panic, let's carefully check where it went wrong.",
                    "Eek! A small error slipped through. Let's fix it carefully before moving on!"
                ],
                hint: [
                    "Be extra careful here:",
                    "Don't rush! Check this clue:"
                ],
                mastery: [
                    "You reached mastery. Choose where you would like to continue."
                ]
                ,
                reactions: {
                    wrongFirst: [
                        "A small error slipped in. Let's check where it happened before trying again.",
                        "Not quite. Review the operation carefully and correct the part that changed the result."
                    ],
                    wrongRepeated: [
                        "We're seeing the same step cause trouble. Let's verify it methodically instead of rushing another attempt.",
                        "A couple of misses means we should check the setup carefully before submitting again."
                    ],
                    correctFirstTry: [
                        "Good! That answer checks out on the first try.",
                        "Correct right away, nice careful work."
                    ],
                    correctAfterStruggle: [
                        "Good recovery. You found the error and corrected it carefully.",
                        "There we go, you checked the tricky part and got it right."
                    ],
                    fastCorrect: [
                        "Quick and correct, that's a good sign.",
                        "Nice! You moved fast without letting an error slip through."
                    ],
                    correctStreak: [
                        "You're putting together a steady correct streak. Keep the careful checks.",
                        "Good consistency, each step is checking out."
                    ],
                    hintRequested: [
                        "Here's a clue so you know exactly what to inspect next:",
                        "Use this hint as a careful checkpoint:"
                    ],
                    finalFormatError: [
                        "The issue is in the final format. Check that detail carefully and resubmit.",
                        "Almost there, make sure the result is written exactly as requested."
                    ],
                    correctWorkNeedsFinal: [
                        "The calculation is correct. Now carefully enter the final value by itself.",
                        "Good work. One last check: submit only the final result."
                    ]
                }
            },
            outstanding: {
                greet: [
                    "You've been accurate, so let's raise the challenge while still checking the critical details.",
                    "Ready for a tougher one? Work confidently, but keep an eye on the small details.",
                    "Let's test your accuracy under a stronger challenge. Plan first, then verify the key step."
                ],
                correct: [
                    "Excellent, fast, accurate, and still carefully checked.",
                    "That worked perfectly. Your confidence and attention to detail are balancing well.",
                    "Strong result. You handled the challenge without losing precision."
                ],
                wrong: [
                    "One detail slipped through. See if you can locate it before changing your whole approach.",
                    "Careful, your strategy is probably sound. Recheck the exact operation that produced this value.",
                    "That result needs another look. Identify the small inconsistency and correct only what is necessary."
                ],
                hint: [
                    "One careful clue should be enough:",
                    "Check this detail, then finish the rest independently:",
                    "Use this precise hint and verify your own conclusion:"
                ],
                mastery: [
                    "Excellent control. You stayed accurate even as the challenge increased.",
                    "Outstanding work. Your careful reasoning is ready for a more demanding problem."
                ]
                ,
                reactions: {
                    wrongFirst: [
                        "That looks like a small slip. Check the exact operation before changing the whole approach.",
                        "One detail is off. Verify it carefully, you likely won't need to redo everything."
                    ],
                    wrongRepeated: [
                        "More than one miss suggests a hidden issue. Audit the setup carefully before the next attempt.",
                        "Let's not let repeated slips compound. Recheck the core operation from the start."
                    ],
                    correctFirstTry: [
                        "Excellent, that checks out immediately.",
                        "Correct on the first pass. Your careful reasoning is strong."
                    ],
                    correctAfterStruggle: [
                        "Strong recovery. You isolated the error and corrected it without losing the structure.",
                        "Excellent check, you found the exact issue and fixed it."
                    ],
                    fastCorrect: [
                        "Very good, fast, accurate, and still carefully controlled.",
                        "That was quick, and the result checks out perfectly."
                    ],
                    correctStreak: [
                        "Your accuracy is staying very stable. Keep the same careful control.",
                        "Excellent consistency, you're avoiding the little slips that usually cause trouble."
                    ],
                    hintRequested: [
                        "Here's one precise clue. Use it to verify the uncertain part, then finish independently:",
                        "A small checkpoint should be enough, inspect this clue carefully:"
                    ],
                    finalFormatError: [
                        "The reasoning is strong; only the exact final format needs correction.",
                        "You're essentially correct. Tighten the presentation and submit the required form."
                    ],
                    correctWorkNeedsFinal: [
                        "The work checks out. Now give the exact final value, cleanly and carefully.",
                        "Good reasoning. Finish with the precise result only."
                    ]
                }
            }
        }
    },

    neutral: {
        name: "Standard Tutor",
        images: {
            default: "../../assets/images/tutors/pia-neutral/approval.webp",
            happy: "../../assets/images/tutors/pia-neutral/approval.webp",
            sad: "../../assets/images/tutors/pia-neutral/approval.webp",
            thinking: "../../assets/images/tutors/pia-neutral/approval.webp"
        },
        profiles: {
            struggling: {
                greet: [
                    "Let's solve this one step at a time.",
                    "We'll start with the first part and work forward carefully."
                ],
                correct: [
                    "Correct. Keep using the same process for the next step.",
                    "That's right. Continue one step at a time."
                ],
                wrong: [
                    "That answer is not correct. Recheck the current step and try again.",
                    "Review the numbers in this step before submitting another answer."
                ],
                hint: [
                    "Use this clue to work through the current step:",
                    "Focus on this part first:"
                ],
                mastery: [
                    "You have made solid progress and completed the required work."
                ]
                ,
                reactions: {
                    wrongFirst: [
                        "That answer is not correct yet. Check one part of the step and try again.",
                        "Try again. Focus on the operation required by this step."
                    ],
                    wrongRepeated: [
                        "This step is taking several attempts. Break it into a smaller check before resubmitting.",
                        "Review the setup carefully. Repeated errors suggest one operation needs correction."
                    ],
                    correctFirstTry: [
                        "Correct on the first attempt. Continue to the next step.",
                        "That is correct. Good first try."
                    ],
                    correctAfterStruggle: [
                        "Correct. You fixed the earlier errors and completed the step.",
                        "Good recovery. The step is now correct."
                    ],
                    fastCorrect: [
                        "Correct and quick. Continue.",
                        "Fast and accurate. Good work."
                    ],
                    correctStreak: [
                        "You have several correct answers in a row. Keep going.",
                        "Your recent answers are consistently correct."
                    ],
                    hintRequested: [
                        "Here is a hint to guide the next attempt:",
                        "Use this clue and try the step again:"
                    ],
                    finalFormatError: [
                        "The answer format is incorrect. Enter the final value in the required form.",
                        "Correct the final answer format and resubmit."
                    ],
                    correctWorkNeedsFinal: [
                        "The calculation is correct. Now enter only the final value.",
                        "Correct working. Submit the final result by itself."
                    ]
                }
            },
            average: {
                greet: [
                    "Let's begin solving the mathematical problem."
                ],
                correct: [
                    "Correct answer. Proceed to the next step."
                ],
                wrong: [
                    "Incorrect input. Please recalculate and try again."
                ],
                hint: [
                    "Here is a hint:"
                ],
                mastery: [
                    "Mastery criteria fulfilled. Choose where you would like to continue."
                ]
                ,
                reactions: {
                    wrongFirst: [
                        "Incorrect. Review the calculation and try again.",
                        "Check the step for an arithmetic or setup error."
                    ],
                    wrongRepeated: [
                        "There have been multiple errors on this step. Review the method before another attempt.",
                        "Recheck the setup and operation carefully before resubmitting."
                    ],
                    correctFirstTry: [
                        "Correct on the first attempt.",
                        "Correct. Proceed."
                    ],
                    correctAfterStruggle: [
                        "Correct. You successfully corrected the previous errors.",
                        "Good recovery. The step is now complete."
                    ],
                    fastCorrect: [
                        "Correct and efficient.",
                        "Quick and accurate."
                    ],
                    correctStreak: [
                        "Your recent answers are consistently correct.",
                        "Good accuracy streak. Continue."
                    ],
                    hintRequested: [
                        "Here is a hint:",
                        "Use this clue for the next attempt:"
                    ],
                    finalFormatError: [
                        "Use the required final answer format and try again.",
                        "The value must be submitted in the requested format."
                    ],
                    correctWorkNeedsFinal: [
                        "Correct calculation. Now enter the final answer only.",
                        "The working is correct. Submit the resulting value."
                    ]
                }
            },
            outstanding: {
                greet: [
                    "Solve the problem using the most efficient valid approach you can identify.",
                    "Proceed with minimal guidance and verify your final reasoning."
                ],
                correct: [
                    "Correct. Your solution was accurate and efficient.",
                    "Correct. Continue with the same level of independent reasoning."
                ],
                wrong: [
                    "Incorrect. Review your reasoning and identify the specific error before trying again.",
                    "Recheck the calculation and correct the exact point of failure."
                ],
                hint: [
                    "A minimal hint:",
                    "Use this clue and complete the remaining reasoning independently:"
                ],
                mastery: [
                    "Mastery criteria fulfilled. You are ready for a more demanding task."
                ]
                ,
                reactions: {
                    wrongFirst: [
                        "Incorrect. Identify the specific error and try again.",
                        "Recheck the exact point where the calculation diverged."
                    ],
                    wrongRepeated: [
                        "Multiple attempts have missed. Reassess the method before resubmitting.",
                        "Review the full setup and isolate the repeated error."
                    ],
                    correctFirstTry: [
                        "Correct on the first attempt. Strong work.",
                        "Accurate first-pass solution."
                    ],
                    correctAfterStruggle: [
                        "Correct. You identified and fixed the earlier issue.",
                        "Strong recovery. The corrected reasoning is accurate."
                    ],
                    fastCorrect: [
                        "Fast and accurate. Excellent efficiency.",
                        "Correct with very little response time."
                    ],
                    correctStreak: [
                        "Strong accuracy streak. Maintain the same standard.",
                        "Your recent performance is consistently accurate."
                    ],
                    hintRequested: [
                        "Here is a minimal hint. Complete the remaining reasoning independently:",
                        "Use this clue as a small nudge, then finish the step:"
                    ],
                    finalFormatError: [
                        "The reasoning may be correct; fix the final presentation.",
                        "Use the exact required output format."
                    ],
                    correctWorkNeedsFinal: [
                        "The reasoning is complete. State the final value only.",
                        "Correct work. Finish with the exact result."
                    ]
                }
            }
        }
    }
};

const ADAPTIVE_PERSONA_MESSAGES = {
    openness: {
        upgrade: [
            "This topic looks a little too easy for you, explorer. Want to discover a tougher challenge in {topic}?",
            "You seem ready for something new. Would you like to explore the next challenge in {topic}?"
        ],
        downgrade: [
            "This topic seems a bit tougher right now. Want to explore {topic} again and rebuild the pattern from there?",
            "Let's approach this from another angle. Would you like to revisit {topic} and strengthen the ideas there first?"
        ]
    },
    conscientiousness: {
        upgrade: [
            "Your work here looks consistently strong. Would you like to move up to {topic} and take on a more demanding set of steps?",
            "You are handling this topic accurately and efficiently. Would you like to continue to {topic}?"
        ],
        downgrade: [
            "This topic may need a little more review. Would you like to return to {topic} and strengthen the foundation step by step?",
            "A more structured review may help here. Would you like to go back to {topic} and rebuild the process carefully?"
        ]
    },
    extraversion: {
        upgrade: [
            "You're crushing this topic! Want to level up and take on {topic}?",
            "Great momentum! Ready to move up and tackle {topic} next?"
        ],
        downgrade: [
            "This topic is giving us a tougher fight. Want to drop back to {topic}, build momentum, and come back stronger?",
            "Let's reset and get another win. Want to review {topic} first, then charge back into this challenge?"
        ]
    },
    agreeableness: {
        upgrade: [
            "You seem very comfortable with this topic. Would you like to move up to {topic} and try a bigger challenge?",
            "You're doing really well here. Would you like to continue to {topic} and take the next step together?"
        ],
        downgrade: [
            "This topic seems a little difficult right now. Would you like to return to {topic} for some extra practice together?",
            "We can make this easier to manage. Would you like to review {topic} together before trying this topic again?"
        ]
    },
    neuroticism: {
        upgrade: [
            "You're handling this topic really well. Would you like to move up to {topic} and try the next challenge carefully?",
            "Your answers are looking steady. Would you like to continue to {topic} and take on the next level?"
        ],
        downgrade: [
            "This topic seems a bit demanding right now. Would you like to return to {topic} and review the earlier skills carefully?",
            "Let's reduce the difficulty for a moment and make sure the foundation is secure. Would you like to revisit {topic}?"
        ]
    },
    neutral: {
        upgrade: [
            "This topic appears to be easy for you. Would you like to move up to {topic}?",
            "You seem ready for the next topic. Would you like to continue to {topic}?"
        ],
        downgrade: [
            "This topic appears to need more review. Would you like to return to {topic} for additional practice?",
            "A review of the previous topic may help. Would you like to go back to {topic}?"
        ]
    }
};

    /* saved selected_character -> dialogue/art set. pia-calm is the Neuroticism
       persona's folder; the source art folder was spelled "Neuroticsm". */
    var KEYS = {
        'pia-open': 'openness',
        'pia-conscientious': 'conscientiousness',
        'pia-extravert': 'extraversion',
        'pia-agreeable': 'agreeableness',
        'pia-calm': 'neuroticism',
        'pia-neutral': 'neutral'
    };

    /* The 3D-style character art (assets/images/personas/<Folder>/<file>.webp).
       The folder comes from the saved selected_character key and nothing else.
       Moods the art set has no picture for use the closest one it has. Neutral
       has its own set (approval, disapproval, nod, shrug) instead of
       happy/sad/excited, so those moods map to the nearest of them. */
    var ART_DIR = '../../assets/images/personas/';
    var ART = {
        'pia-open':          ['Openness',          { 'default': 'default', happy: 'happy', sad: 'sad', excited: 'excited', thinking: 'default' }],
        'pia-conscientious': ['Conscientiousness', { 'default': 'default', happy: 'happy', sad: 'sad', excited: 'excited', thinking: 'default' }],
        'pia-extravert':     ['Extraverted',       { 'default': 'default', happy: 'happy', sad: 'sad', excited: 'excited', thinking: 'default' }],
        'pia-agreeable':     ['Agreeableness',     { 'default': 'default', happy: 'happy', sad: 'sad', excited: 'excited', thinking: 'default' }],
        'pia-calm':          ['Neuroticism',       { 'default': 'default', happy: 'happy', sad: 'sad', excited: 'excited', thinking: 'default' }],
        'pia-neutral':       ['Neutral',           { 'default': 'default', happy: 'approval', sad: 'disapproval', excited: 'nod', thinking: 'shrug' }]
    };

    var out = {};
    Object.keys(KEYS).forEach(function (key) {
        var trait = KEYS[key];
        var art = ART[key];
        var images = {};
        Object.keys(art[1]).forEach(function (mood) { images[mood] = ART_DIR + art[0] + '/' + art[1][mood] + '.webp'; });

        /* The previous illustrations stay as the fallback for any picture that
           is missing or fails to load (excited falls back to happy). */
        var old = PERSONA_CONFIG[trait].images;
        var fallback = { 'default': old['default'], happy: old.happy, sad: old.sad, excited: old.happy, thinking: old.thinking || old['default'] };

        out[key] = {
            name: PERSONA_CONFIG[trait].name,
            images: images,
            fallback: fallback,
            profiles: PERSONA_CONFIG[trait].profiles,
            adaptive: ADAPTIVE_PERSONA_MESSAGES[trait] || ADAPTIVE_PERSONA_MESSAGES.neutral
        };
    });
    return out;
})();
