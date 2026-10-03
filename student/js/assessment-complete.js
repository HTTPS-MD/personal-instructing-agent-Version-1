// ==========================================
// THANK-YOU SCREEN -- pagkatapos ng questionnaire
// Dito napupunta ang estudyante sa sandaling maisumite ang 50 sagot.
//
// Sinasadyang WALANG ipinapakitang resulta: walang score, trait o persona.
// At wala rin itong mababasa kahit gustuhin -- ang resulta ay nasa
// ocean_submissions, na admin lang ang nakakabasa (migration 0018), at ang
// profiles ay wala nang hawak na score. is_ocean_done lang ang tinitingnan
// dito, na completion flag lang, hindi resulta.
// ==========================================
(async function () {
    // Tunay na session lang ang pinagkakatiwalaan (requireStudentSession ang
    // nagre-redirect kapag wala, at ang admin/teacher ay pinapapunta sa sarili
    // nilang dashboard).
    const profile = await requireStudentSession();
    if (!profile) return;

    // Walang dahilan para makita ito ng hindi pa tapos -- ibalik sila sa
    // questionnaire (ang sariling guard nito ang bahala kung sarado ang stage).
    if (!profile.is_ocean_done) {
        window.location.replace('ocean-test.html');
        return;
    }

    // Ang susunod nilang hakbang, gamit ang KAPAREHONG prerequisite chain ng
    // route guard: character selection para sa free-choice group, ang
    // dashboard para sa iba, o ang waiting room kapag sarado pa ang stage.
    const continueBtn = document.getElementById('btn-continue');
    if (isControlGroup(profile)) {
        // Control ends here (migration 0038): no next stage, so no Continue.
        const actions = continueBtn && continueBtn.closest('.gate-actions');
        if (actions) actions.remove();
        const lede = document.querySelector('.gate-lede');
        if (lede) lede.textContent = 'Your answers have been saved. That is everything for now.';
    } else if (continueBtn) {
        continueBtn.href = await resolveStudentRedirect(profile);
    }

    document.body.classList.remove('opacity-0');
})();
