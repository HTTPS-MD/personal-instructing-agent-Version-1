const gatekeeperScreen = document.getElementById('gatekeeper-screen');
const testContainer = document.getElementById('test-container');

let isTestAllowed = false;
let currentQuestionIndex = 0;
let userResponses = [];

// Pinagsamang checker para hindi mawala ang account identity
async function getStudentIdentifier() {
    const email = localStorage.getItem('pia_user_email');
    if (email) return { column: 'email', value: email };

    const { data: { session } } = await supabaseClient.auth.getSession();
    if (session && session.user) return { column: 'id', value: session.user.id };

    return null;
}

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

async function checkAccessAndInit() {
    if (!supabaseClient) {
        isTestAllowed = true;
        renderGatekeeper();
        setupRealtimeListener();
        return;
    }

    try {
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000));

        const checkTask = async () => {
            const student = await getStudentIdentifier();

            if (student) {
                const { data: profile } = await supabaseClient
                    .from('profiles')
                    .select('is_ocean_done, group_type')
                    .eq(student.column, student.value)
                    .maybeSingle();

                if (profile && profile.is_ocean_done === true) {
                    const groupType = profile.group_type ? profile.group_type.trim().toLowerCase() : '';
                    if (groupType === 'non-assigned' || groupType === 'non_assigned') {
                        window.location.href = 'waiting-room.html';
                    } else {
                        window.location.href = 'student-dashboard.html';
                    }
                    return;
                }
            }

            const { data } = await supabaseClient.from('settings').select('*').eq('key', 'stage_ocean').maybeSingle();
            isTestAllowed = data && (data.value === true || data.value === 'true');
        };

        await Promise.race([checkTask(), timeoutPromise]);
    } catch (err) {
        console.error("Error or timeout checking status:", err);
        isTestAllowed = true;
    }

    renderGatekeeper();
    setupRealtimeListener();
}

function renderGatekeeper() {
    if (isTestAllowed) {
        gatekeeperScreen.innerHTML = `
                    <div class="w-full h-full relative grid grid-cols-1 md:grid-cols-2">
                        <div class="absolute inset-0 md:relative w-full h-full z-0 pointer-events-none">
                            <img src="/assets/images/ocean.png" class="absolute inset-0 w-full h-full object-cover opacity-20 md:opacity-65">
                            <div class="absolute inset-0 md:hidden" style="background: linear-gradient(to top, var(--bg-main) 10%, transparent);"></div>
                            <div class="hidden md:block absolute inset-0" style="background: linear-gradient(to right, transparent, var(--bg-main));"></div>
                        </div>
                        <div id="step-container" class="relative z-10 flex flex-col justify-center px-8 md:px-16 lg:px-24 pt-32 pb-12 w-full h-full md:col-start-2 transition-opacity duration-300">
                        </div>
                    </div>
                `;
        showPrivacyStep();
    } else {
        gatekeeperScreen.innerHTML = `
                <div class="w-full h-full relative grid grid-cols-1 md:grid-cols-2">
                    <div class="absolute inset-0 md:relative w-full h-full z-0 pointer-events-none">
                        <img src="/assets/images/board.png" class="absolute inset-0 w-full h-full object-cover opacity-20 md:opacity-40">
                    </div>
                    <div class="relative z-10 flex flex-col justify-center px-8 md:px-16 lg:px-24 pt-32 pb-12 w-full h-full md:col-start-2">
                        <span class="text-6xl mb-6 block">🔒</span>
                        <h2 class="text-4xl md:text-5xl font-bold mb-6">Assessment Locked</h2>
                        <p class="text-secondary text-lg mb-12">Sorry, the administrator has closed the OCEAN Personality Assessment stage.</p>
                        <a href="waiting-room.html" class="btn-secondary py-4 px-8 rounded-xl font-bold block text-center">Return to Waiting Room</a>
                    </div>
                </div>
            `;
    }
}

// Unified Realtime Listener para sa pag-Open at pag-Close ng Admin
function setupRealtimeListener() {
    if (supabaseClient) {
        supabaseClient
            .channel('realtime-ocean-stage-sync')
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
                    if (isOpen) {
                        // Kung binuksan ng admin, i-reload ang pahina para magpakita ang test
                        window.location.reload();
                    } else {
                        // Kung sinara ng admin, ibato agad sa waiting room
                        window.location.href = 'waiting-room.html';
                    }
                }
            )
            .subscribe();
    }
}

function showPrivacyStep() {
    const container = document.getElementById('step-container');
    if (!container) return;
    container.classList.remove('opacity-0');
    container.innerHTML = `
                <div class="fade-in flex flex-col h-full justify-center">
                    <h2 class="text-4xl md:text-5xl font-bold mb-4">Start OCEAN Test</h2>
                    <span class="text-accent tracking-widest uppercase text-sm font-bold mb-10">Assessment Setup</span>
                    
                    <div class="bg-muted p-6 rounded-2xl border border-custom mb-10 backdrop-blur-sm">
                        <h3 class="font-bold mb-3 flex items-center gap-2 text-lg">🛡️ Data Privacy Handling</h3>
                        <p class="text-secondary leading-relaxed">Your responses will be strictly used to determine your learning profile. Your results are encrypted and will not be shared.</p>
                    </div>
                    <div class="flex flex-col gap-4 mt-auto md:mt-0">
                        <button onclick="startTestDirectly()" class="btn-primary py-4 rounded-xl font-bold text-lg w-full">I Agree, Continue</button>
                        <a href="waiting-room.html" class="text-secondary hover-text-accent text-center py-2 transition-colors">Return to Waiting Room</a>
                    </div>
                </div>
            `;
}

async function startTestDirectly() {
    // I-update agad ang database sa sandaling pumasok ang student sa test
    if (supabaseClient) {
        const student = await getStudentIdentifier();
        if (student) {
            await supabaseClient
                .from('profiles')
                .update({
                    current_stage: 'OCEAN',
                    stage_started_at: new Date().toISOString()
                })
                .eq(student.column, student.value);
        }
    }

    gatekeeperScreen.classList.add('opacity-0');
    setTimeout(() => {
        gatekeeperScreen.classList.add('hidden');
        testContainer.classList.remove('hidden');
        testContainer.classList.add('fade-in');
        document.body.style.overflow = 'auto';
        loadQuestion();
    }, 500);
}

function loadQuestion() {
    if (currentQuestionIndex < questions.length) {
        document.getElementById('question-counter').textContent = `Question ${currentQuestionIndex + 1} of ${questions.length}`;
        document.getElementById('question-text').textContent = "I... " + `"${questions[currentQuestionIndex]}"`;

        const progress = Math.round((currentQuestionIndex / questions.length) * 100);
        document.getElementById('progress-lbl').textContent = `${progress}% Completed`;
    } else {
        submitTestResults();
    }
}

function handleAnswer(score) {
    userResponses.push(score);
    currentQuestionIndex++;
    loadQuestion();
}

async function submitTestResults() {
    testContainer.innerHTML = `
        <div class="solid-card p-12 text-center space-y-4">
            <h2 class="text-2xl font-bold text-primary">Submitting your assessment...</h2>
            <p class="text-secondary text-sm">Please wait while we save your profile data.</p>
        </div>
    `;

    const a = [0, ...userResponses];

    const E = 20 + a[1] - a[6] + a[11] - a[16] + a[21] - a[26] + a[31] - a[36] + a[41] - a[46];
    const A = 14 - a[2] + a[7] - a[12] + a[17] - a[22] + a[27] - a[32] + a[37] + a[42] + a[47];
    const C = 14 + a[3] - a[8] + a[13] - a[18] + a[23] - a[28] + a[33] - a[38] + a[43] + a[48];
    const N = 38 - a[4] + a[9] - a[14] + a[19] - a[24] - a[29] - a[34] - a[39] - a[44] - a[49];
    const O = 8 + a[5] - a[10] + a[15] - a[20] + a[25] - a[30] + a[35] + a[40] + a[45] + a[50];

    if (supabaseClient) {
        const student = await getStudentIdentifier();

        if (student) {
            const { data: profile } = await supabaseClient
                .from('profiles')
                .select('group_type')
                .eq(student.column, student.value)
                .maybeSingle();

            const groupType = profile && profile.group_type ? profile.group_type.trim().toLowerCase() : '';
            const isNonAssigned = (groupType === 'non-assigned' || groupType === 'non_assigned');

            let nextStage = null;
            let targetUrl = 'waiting-room.html';

            if (isNonAssigned) {
                const { data: charSetting } = await supabaseClient.from('settings').select('value').eq('key', 'stage_char').maybeSingle();
                const isCharOpen = charSetting ? (charSetting.value === true || charSetting.value === 'true') : false;

                if (isCharOpen) {
                    nextStage = 'Character Selection';
                    targetUrl = 'character-selection.html';
                }
            } else {
                const { data: dashSetting } = await supabaseClient.from('settings').select('value').eq('key', 'stage_dash').maybeSingle();
                const isDashOpen = dashSetting ? (dashSetting.value === true || dashSetting.value === 'true') : false;

                if (isDashOpen) {
                    nextStage = 'Tutoring Dashboard';
                    targetUrl = 'student-dashboard.html';
                }
            }

            // I-update ang profile: save scores, tapos i-set ang next stage o i-null kung sa waiting room mapupunta
            const { error: updateError } = await supabaseClient
                .from('profiles')
                .update({
                    is_ocean_done: true,
                    ocean_e: E,
                    ocean_a: A,
                    ocean_c: C,
                    ocean_n: N,
                    ocean_o: O,
                    current_stage: nextStage,
                    stage_started_at: nextStage ? new Date().toISOString() : null
                })
                .eq(student.column, student.value);

            if (updateError) {
                alert("Database Error: " + updateError.message);
                return;
            }

            setTimeout(() => {
                window.location.href = targetUrl;
            }, 2000);
            return;
        }
    }
}

checkAccessAndInit();