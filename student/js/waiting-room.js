/**
 * Fetches and returns the unique student identifier (email or user ID) from local storage or Supabase session.
 */
async function getStudentIdentifier() {
    const email = localStorage.getItem('pia_user_email');
    if (email) return { column: 'email', value: email };

    const { data: { user } } = await supabaseClient.auth.getUser();
    if (user) return { column: 'id', value: user.id };

    return null;
}

/**
 * Evaluates the student's progress state and routes them accordingly without overriding targeted access.
 */
async function checkUserAndStage() {
    const student = await getStudentIdentifier();
    if (!student) return window.location.replace('index.html');

    const { data: profile } = await supabaseClient.from('profiles').select('*').eq(student.column, student.value).maybeSingle();
    if (!profile) return;

    // 🚨 FIX: Check for Targeted Access Bypass FIRST!
    // Kung binigyan sila ng Admin ng explicit access sa isang stage, ibalik sila doon.
    if (profile.current_stage === 'OCEAN') return window.location.replace('ocean-test.html');
    if (profile.current_stage === 'Character Selection') return window.location.replace('character-selection.html');
    if (profile.current_stage === 'Tutoring Dashboard') return window.location.replace('student-dashboard.html');

    // I-set lang sa Waiting Room kung talagang wala silang targeted access
    if (profile.current_stage !== 'Waiting Room') {
        await supabaseClient
            .from('profiles')
            .update({ current_stage: 'Waiting Room' })
            .eq(student.column, student.value);
    }

    const groupType = profile.group_type ? profile.group_type.trim().toLowerCase() : '';

    if (!profile.is_ocean_done) {
        document.getElementById('waiting-title').textContent = "Waiting for OCEAN Test";
        checkAndListen('stage_ocean', 'ocean-test.html');
    }
    else if ((groupType === 'non-assigned' || groupType === 'non_assigned') && !profile.selected_character) {
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
    const { data } = await supabaseClient
        .from('settings')
        .select('value')
        .eq('key', stageKey)
        .maybeSingle();

    const isOpen = data ? (data.value === true || data.value === 'true') : false;

    if (isOpen) {
        window.location.replace(redirectUrl);
        return;
    }

    // Realtime listener
    supabaseClient
        .channel('waiting-room-' + stageKey)
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
        .subscribe();
}

checkUserAndStage();