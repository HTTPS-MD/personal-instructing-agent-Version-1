/**
 * Evaluates the student's progress state and routes them accordingly without overriding targeted access.
 */
async function checkUserAndStage() {
    // Session-verified na ang identity dito (dating localStorage muna bago
    // session, kaya spoofable). Ang waiting room mismo ay walang prerequisite
    // -- ito ang fallback destination -- kaya requireStudentSession() lang.
    const profile = await requireStudentSession();
    if (!profile) return;

    document.body.classList.remove('opacity-0');

    // Targeted access ng Admin -- pero i-honor LANG kung pasado rin sa
    // prerequisite chain. Kung hindi, ibabalik dito ng guard ang student mula
    // sa destination page at magiging redirect loop. Iisang canEnterStage()
    // ang ginagamit ng dalawang panig kaya imposible ang loop.
    const targeted = {
        'OCEAN': 'ocean',
        'Character Selection': 'char',
        'Tutoring Dashboard': 'dash'
    }[profile.current_stage];

    if (targeted && canEnterStage(profile, targeted)) {
        return window.location.replace(STUDENT_STAGES[targeted].url);
    }

    // I-set lang sa Waiting Room kung talagang wala silang (valid na) targeted
    // access. Dumadaan sa RPC -- ang 'Waiting Room' ay laging pinapayagan ng
    // server, kaya walang mababagong asal dito maliban na hindi na direktang
    // sinusulatan ng browser ang current_stage.
    if (profile.current_stage !== 'Waiting Room') {
        await supabaseClient.rpc('set_student_stage', { p_stage: 'Waiting Room' });
    }

    if (canEnterStage(profile, 'ocean')) {
        document.getElementById('waiting-title').textContent = "Waiting for OCEAN Test";
        checkAndListen('stage_ocean', 'ocean-test.html');
    }
    else if (canEnterStage(profile, 'char')) {
        document.getElementById('waiting-title').textContent = "Waiting for Character Selection";
        document.getElementById('waiting-desc').textContent = "The character selection stage is currently closed. Please wait for your instructor to open it.";
        checkAndListen('stage_char', 'character-selection.html');
    }
    else {
        document.getElementById('waiting-title').textContent = "Waiting for Dashboard";
        document.getElementById('waiting-desc').textContent = "The tutoring dashboard is currently closed. Please stand by.";
        checkAndListen('stage_dash', 'student-dashboard.html');
    }
}

/**
 * Checks if a specific stage key is open in settings; redirects immediately if open, 
 * otherwise establishes a real-time subscription listener to catch changes dynamically.
 */
async function checkAndListen(stageKey, redirectUrl) {
    if (await isStageOpen(stageKey)) {
        window.location.replace(redirectUrl);
        return;
    }

    // Realtime listener
    registerChannel('waiting-room-' + stageKey, (ch) => ch
        .on(
            'postgres_changes',
            {
                event: 'UPDATE',
                schema: 'public',
                table: 'settings',
                filter: `key=eq.${stageKey}`
            },
            (payload) => {
                const newValue = payload.new.value;
                if (newValue === true || newValue === 'true') {
                    window.location.replace(redirectUrl);
                }
            }
        )
        .subscribe());
}

checkUserAndStage();