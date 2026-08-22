// ==========================================
// GRADE 7 ALGEBRAIC EXPRESSIONS -- MOCK QUESTION BANK
// ==========================================
// Level 1: one/two-step equations (x + 15 = 40)
// Level 2: variable on both sides (5x = 3x + 12)
// Level 3: distributive property both sides (4(x+2) = 3(x+5))
//
// Bawat problem ay pre-computed at manually verified ang tamang sagot -- walang
// random/auto-generated equations dito para masigurong tama lagi ang math.
//
// SECURITY: WALA nang `answer` field dito. Dati, nasa client ang plaintext na
// sagot ng bawat problem, kaya nababasa ito ng estudyante sa view-source o sa
// console (`gameState.currentProblem.answer`). Ang mga sagot ay nasa
// public.math_answers na ngayon -- isang table na WALANG select policy, kaya
// hindi ito kayang basahin ninuman mula sa client. Ang pag-validate ay
// dumadaan sa check_math_answer() RPC.
//
// SECURITY (HIGH 2): WALA na ring `hints` dito. Ang huling hint ng bawat
// problema ay ang mismong solusyon ('x = 40 - 15'), kaya ang pag-alis ng
// `answer` ay hindi naman talaga nagsara ng butas -- nasa view-source pa rin
// ang bawat sagot. Mas masama pa: ang pagbabasa nila sa paraang iyon ay HINDI
// nagpapataas ng hints_used, kaya naitatala pa rin silang 'smooth'. Tahimik
// nitong pinapataas ang performance ng experimental group -- ang mismong
// bilang na sinusukat ng thesis.
//
// Ang hints ay nasa public.math_hints na ngayon, at dumadaan sa consume_hint()
// RPC na siyang nagbibilang. Ang expression lang ang natitira dito: kailangan
// itong ipakita, at wala itong sinasabi tungkol sa sagot.

const MATH_PROBLEMS = {
    1: [
        { id: 'l1-1', expression: 'x + 15 = 40' },
        { id: 'l1-2', expression: 'x - 8 = 12' },
        { id: 'l1-3', expression: '3x = 21' },
        { id: 'l1-4', expression: 'x / 4 = 6' },
        { id: 'l1-5', expression: '2x + 5 = 17' },
        { id: 'l1-6', expression: 'x - 9 = -3' },
        { id: 'l1-7', expression: 'x + 7 = 23' },
        { id: 'l1-8', expression: '5x = 45' },
        { id: 'l1-9', expression: 'x / 3 = 8' },
        { id: 'l1-10', expression: '4x - 6 = 18' }
    ],
    2: [
        { id: 'l2-1', expression: '5x = 3x + 12' },
        { id: 'l2-2', expression: '7x - 4 = 2x + 16' },
        { id: 'l2-3', expression: '6x + 3 = 2x + 19' },
        { id: 'l2-4', expression: '9x - 5 = 4x + 20' },
        { id: 'l2-5', expression: '3x + 8 = x + 20' },
        { id: 'l2-6', expression: '8x = 5x + 21' },
        { id: 'l2-7', expression: '4x + 9 = 2x + 23' },
        { id: 'l2-8', expression: '10x - 7 = 6x + 13' },
        { id: 'l2-9', expression: '5x + 6 = 2x + 18' },
        { id: 'l2-10', expression: '7x - 2 = 3x + 14' }
    ],
    3: [
        { id: 'l3-1', expression: '4(x + 2) = 3(x + 5)' },
        { id: 'l3-2', expression: '2(3x - 1) = 5(x + 4)' },
        { id: 'l3-3', expression: '3(x + 4) = 2(x + 9)' },
        { id: 'l3-4', expression: '5(x - 2) = 3(x + 4)' },
        { id: 'l3-5', expression: '2(x + 5) = 3(x + 1)' },
        { id: 'l3-6', expression: '6(x - 1) = 4(x + 3)' },
        { id: 'l3-7', expression: '3(2x + 1) = 5(x + 4)' },
        { id: 'l3-8', expression: '4(x + 5) = 2(x + 11)' },
        { id: 'l3-9', expression: '5(x + 3) = 4(x + 6)' },
        { id: 'l3-10', expression: '2(4x - 3) = 6(x + 1)' }
    ]
};

// Fisher-Yates shuffle (walang binabago sa orihinal na array)
function shuffleProblems(problems) {
    const arr = [...problems];
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

// Pina-parse ang isinulat ng estudyante tungo sa isang numero.
// Tinatanggap: "x=5", "5=x", "x = 5", o direktang "5" -- pareho lang lahat.
// Parsing lang ito, hindi validation -- ligtas na nasa client dahil walang
// sagot na nabubunyag dito.
function parseAnswerInput(rawInput) {
    if (typeof rawInput !== 'string') return null;

    const cleaned = rawInput.trim().toLowerCase().replace(/\s+/g, '');
    if (!cleaned) return null;

    const NUM = '(-?\\d+(?:\\.\\d+)?)';
    const patterns = [
        new RegExp(`^x=${NUM}$`),
        new RegExp(`^${NUM}=x$`),
        new RegExp(`^${NUM}$`)
    ];

    for (const pattern of patterns) {
        const match = cleaned.match(pattern);
        if (match) {
            const n = parseFloat(match[1]);
            return isNaN(n) ? null : n;
        }
    }
    return null;
}

// Ipinapadala ang sagot sa server para suriin. Ang tamang sagot ay hindi
// kailanman umaalis sa database -- verdict lang ang bumabalik dito.
//
// Ang bilang ng attempt ay binibilang at ipinatutupad ng SERVER (bawat
// session + problem), hindi ng client. Kaya hindi na kayang mag-brute-force
// sa pamamagitan ng paulit-ulit na pagtawag mula sa console: kapag naubos
// na ang 2 attempts, `locked` na ang ibinabalik at hindi na sinusuri ang sagot.
//
// Nagbabalik ng { correct, attemptsUsed, attemptsLeft, locked, error }.
// Kapag error === true, koneksyon ang problema -- hindi ito ituturing na
// maling sagot at hindi rin mababawasan ang attempts.
async function validateAnswer(parsedValue, problem, sessionId) {
    const miss = { correct: false, attemptsUsed: 0, attemptsLeft: null, locked: false };

    if (parsedValue === null || !problem) return { ...miss, error: false };
    if (!window.supabaseClient || !sessionId) return { ...miss, error: true };

    const { data, error } = await window.supabaseClient.rpc('check_math_answer', {
        p_session_id: sessionId,
        p_problem_id: problem.id,
        p_submitted: parsedValue
    });

    if (error) {
        console.error('Answer validation failed:', error.message);
        // Ang rate limiter ay nagbabalik ng malinaw na mensahe. Ipinapasa ito
        // pataas para malaman ng estudyante kung bakit sila na-block, sa halip
        // na makakita ng maling "hindi maabot ang server".
        return { ...miss, error: true, message: error.message || null };
    }

    return {
        correct: data?.correct === true,
        attemptsUsed: data?.attempts_used ?? 0,
        attemptsLeft: data?.attempts_left ?? 0,
        locked: data?.locked === true,
        error: false
    };
}
