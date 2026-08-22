/**
 * ============================================================================
 * PIA SYSTEM: ADMIN DASHBOARD CONTROLLER
 * ============================================================================
 * This file handles all administrative functions, real-time database tracking,
 * student/professor roster management, device limits, and system configurations.
 * ============================================================================
 */

/// ==========================================
// 0. IIFE GLOBAL ENCAPSULATION
// ==========================================
(function (global) {

    // ==========================================
    // 1. STATE MANAGEMENT & UTILS
    // ==========================================

    let currentActiveSection = '';
    let currentManagingEmail = '';
    let currentAdminEmail = null;

    // Unified Roster States
    let studentDataCache = [];
    let stateGroupFilter = 'all';
    let stateSubgroupFilter = 'all';
    let stateStageDrilldown = null;
    let pendingRealtimeUpdate = false;
    let realtimeUpdateTimeout = null;
    let realtimeBackoffMs = 1000;
    let lastSearchQuery = '';

    function triggerDeferredRealtimeUpdate() {
        if (pendingRealtimeUpdate) return;
        pendingRealtimeUpdate = true;

        if (realtimeUpdateTimeout) clearTimeout(realtimeUpdateTimeout);
        realtimeUpdateTimeout = setTimeout(() => {
            pendingRealtimeUpdate = false;

            const activeEl = document.activeElement;
            const isTyping = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA');
            const isInteracting = isTyping || (activeEl && activeEl.closest('form')) || document.querySelector('.modal-active') || document.querySelector('.show-menu');

            if (isInteracting) {
                // Kung aktibong nakikipag-ugnayan ang user, mag-antay sandali.
                // BACKOFF: dati, muling nag-a-arm ito bawat 1s nang walang hanggan
                // habang bukas ang modal -- 600 na wakeup sa 10 minutong nakabukas
                // na form. Dumadoble na ito hanggang 8s, at nire-reset kapag
                // tumakbo na ang refresh.
                realtimeBackoffMs = Math.min(realtimeBackoffMs * 2, 8000);
                triggerDeferredRealtimeUpdate();
                return;
            }
            realtimeBackoffMs = 1000;

            loadStudents();
            loadSections();
            // Dating WALA dito: ang apat na stage counter box (OCEAN /
            // Character / Dashboard / Active Game) ay ina-update lang sa init,
            // sa tab switch, at pagkatapos ng targeted grant. Kaya sa gitna ng
            // isang live na session -- ang mismong oras na tinitingnan mo sila
            // -- naiiwan silang luma habang gumagalaw ang roster sa ibaba.
            updateStageCounters();
        }, realtimeBackoffMs);
    }

    // Pagination States
    let currentStudentPage = 1;
    let totalStudentCount = 0;
    const STUDENTS_PER_PAGE = 50;

    function debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }

    const debouncedSearchStudents = debounce(() => {
        currentStudentPage = 1;
        loadStudents();
    }, 300);

    function previousStudentPage() {
        if (currentStudentPage > 1) {
            currentStudentPage--;
            loadStudents();
        }
    }

    function nextStudentPage() {
        // May bounds check na, katulad ng previousStudentPage(). Dati, walang
        // upper limit dito -- kaya kung luma na ang UI state (halimbawa, may
        // nabura habang nakabukas ang huling page), kayang lumagpas sa huling
        // page at magpakita ng walang laman na table.
        const totalPages = Math.max(1, Math.ceil(totalStudentCount / STUDENTS_PER_PAGE));
        if (currentStudentPage < totalPages) {
            currentStudentPage++;
            loadStudents();
        }
    }

    // UI State Persistence
    const uiState = {
        tab: sessionStorage.getItem('activeTab') || 'sections',
        modal: sessionStorage.getItem('activeModal') || null
    };

    // ==========================================
    // 2. INITIALIZATION
    // ==========================================

    // escapeHTML() / escapeJS() ay nasa function.js na (shared helper)

    // Gumagawa ng random, hindi-nahuhulaang initial password gamit ang Web Crypto API.
    // Hindi na ito naka-store kahit saan at hindi na kailangang malaman ng estudyante --
    // ang account ay 'inactive' hanggang sa i-click nila ang activation magic-link
    // (sign-up.html) at doon nila itatakda ang sarili nilang totoong password.
    function generateSecurePassword(length = 20) {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%';
        const bytes = new Uint32Array(length);
        crypto.getRandomValues(bytes);
        return Array.from(bytes, b => chars[b % chars.length]).join('');
    }

    // fully working
    document.addEventListener("DOMContentLoaded", async () => {
        if (typeof sb === 'undefined') {
            const errorBanner = document.getElementById('global-error-banner');
            if (errorBanner) {
                document.getElementById('global-error-message').textContent = "Database connection failed. Please refresh.";
                errorBanner.classList.remove('hidden');
            }
            return;
        }

        lucide.createIcons();

        // 🔥 MOBILE MENU FIX: Isolated to prevent const 'btn' conflict with function.js
        const hamburgerBtn = document.getElementById('mobile-toggle');
        const mobileBg = document.getElementById('menu-backdrop');

        if (hamburgerBtn && mobileBg) {
            hamburgerBtn.addEventListener('click', toggleMobileMenu);
            mobileBg.addEventListener('click', toggleMobileMenu);

            document.addEventListener('click', (e) => {
                const dynCloseGlobal = document.getElementById('dynamic-close-btn');
                if (dynCloseGlobal && (e.target === dynCloseGlobal || dynCloseGlobal.contains(e.target))) {
                    toggleMobileMenu(e);
                }
            });
        }

        // FIX: dating iisang try/catch lang ang bumabalot sa AUTH check AT sa
        // buong data-loading -- kaya kahit anong maliit na kabiguan sa pag-load
        // ng data (transient network hiccup, isang hindi inaasahang null field,
        // atbp.) pagkatapos ma-verify na valid admin, ay natreat bilang
        // "unauthorized" at pinipilit ang admin na mag-logout + ma-redirect.
        // Ngayon, hiwalay na: (1) AUTH phase -- kapag nabigo ito, tama lang na
        // i-redirect dahil hindi talaga authorized ang user; (2) DATA-LOAD
        // phase -- kapag nabigo ito, ipakita lang ang error banner, HINDI na
        // pipilitin ang pag-logout ng isang valid na admin session.
        let email;
        try {
            const { data: { session }, error: sessionError } = await sb.auth.getSession();
            if (sessionError || !session) {
                throw new Error("Session expired. Please log in again.");
            }

            email = session.user.email;
            const { data: profile, error } = await sb.from('profiles').select('role').eq('email', email).maybeSingle();

            if (error || !profile || profile.role !== 'admin') {
                throw new Error("Unauthorized access. Admin privileges required.");
            }
        } catch (e) {
            console.error("Auth check failed:", e);
            const errorBanner = document.getElementById('global-error-banner');
            const errorMessage = document.getElementById('global-error-message');
            if (errorBanner && errorMessage) {
                errorMessage.textContent = e.message || "Failed to verify admin access.";
                errorBanner.classList.remove('hidden');
            }
            localStorage.removeItem('pia_user_email');
            setTimeout(() => window.location.replace('../../index.html'), 3000);
            return;
        }

        localStorage.setItem('pia_user_email', email); // For legacy calls

        // Reveal the dashboard now that the backend has confirmed admin role.
        // Mula dito, hindi na natin i-eevict ang admin dahil lang sa isang
        // paikutan ng data-loading na nabigo -- na-verify na ang identity nila.
        document.body.classList.remove('opacity-0');

        try {
            await Promise.all([
                initAdminProfile(email),
                loadSections(),
                loadStudents(),
                updateStageCounters(),
                loadProfessors(),
                loadSettings()
            ]);

            restoreUIState();

            currentAdminEmail = email;
            setupRealtimeSubscriptions();

            loadAdminDeviceSettings(currentAdminEmail);
        } catch (e) {
            console.error("Dashboard data failed to load:", e);
            const errorBanner = document.getElementById('global-error-banner');
            const errorMessage = document.getElementById('global-error-message');
            if (errorBanner && errorMessage) {
                errorMessage.textContent = (e.message ? `Some data failed to load: ${e.message}` : "Some data failed to load.") + " Please refresh the page.";
                errorBanner.classList.remove('hidden');
            }
            // Sadyang WALANG logout/redirect dito -- valid pa rin ang session,
            // kaya panatilihin lang ang admin sa page kahit may naging error
            // sa data-loading, sa halip na basta i-force logout.
        }

        // ==========================================
        // TABLE EVENT DELEGATION
        // ==========================================
        // DALAWANG BUG DITO DATI, kaya patay ang 3-dots menu ng student roster:
        //
        // (1) Ang action <td> ay may inline na onclick="event.stopPropagation()".
        //     Ang event ay umaakyat: button -> td -> tr -> tbody. Pinapatigil ito
        //     ng td BAGO pa marating ang tbody, kaya HINDI KAILANMAN tumatakbo
        //     ang delegated listener at walang nangyayari sa pag-click.
        //
        // (2) Kahit tumakbo pa ito, inililipat ng toggleActionMenu() ang menu sa
        //     document.body (para hindi ito ma-clip ng table overflow). Sa
        //     sandaling iyon, ang menu ay WALA NA sa loob ng tbody -- kaya ang
        //     mga item nito (Edit / Delete / Retake) ay hindi rin maaabot ng
        //     isang tbody-scoped na listener.
        //
        // Ang delegation ay nasa `document` na, kaya nahuhuli nito ang toggle
        // button (nasa tbody) AT ang mga menu item (nailipat na sa body).
        // Ang stopPropagation() sa ibaba ang pumipigil sa window-level na
        // closeAllMenus na agad itong isara.
        //
        // Ganito na rin gumagana ang professors tab -- inline onclick ang gamit
        // nito, kaya hindi ito naapektuhan ng bug na ito.
        {
            document.addEventListener('click', (e) => {
                const btn = e.target.closest('button[data-action]');
                if (!btn) return;
                e.stopPropagation();

                const action = btn.getAttribute('data-action');
                if (action === 'toggle-menu') {
                    toggleActionMenu(e, btn.getAttribute('data-email-id'), btn);
                    return;
                }

                const email = btn.getAttribute('data-email');
                const student = studentDataCache.find(s => s.email === email);

                if (action === 'send-activation') { sendActivationEmail(email); closeAllMenus(); }
                else if (action === 'edit-student' && student) {
                    openEditStudent(student.full_name, email, student.section || '', student.pre_test_score ?? '', student.group_type, student.max_devices ?? 1);
                    closeAllMenus();
                }
                else if (action === 'device-manager') { openDeviceManager(email); closeAllMenus(); }
                else if (action === 'retake-ocean') { allowStudentRetakeOcean(email); closeAllMenus(); }
                else if (action === 'retake-character') { allowStudentRetakeCharacter(email); closeAllMenus(); }
                else if (action === 'reset-password') { resetPasswordFromMenu(email); closeAllMenus(); }
                else if (action === 'delete-user') { deleteUserFromMenu(email, 'profiles'); closeAllMenus(); }
            });
        }
    });


    // ==========================================
    // 2. REALTIME TRACKING & TIMERS
    // ==========================================

    // fully working
    function setupRealtimeSubscriptions() {
        registerChannel('admin-realtime-profiles', (ch) => ch
            .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, (payload) => {
                triggerDeferredRealtimeUpdate();

                const modalEmailEl = document.getElementById('device-modal-email');
                if (modalEmailEl && payload.new?.email && modalEmailEl.textContent === payload.new.email) {
                    renderDeviceList(payload.new.active_devices || []);
                }

                if (currentAdminEmail && payload.new?.email && currentAdminEmail === payload.new.email) {
                    loadAdminDeviceSettings(currentAdminEmail);
                }
            })
            .subscribe());

        // Ang mga estudyante ay nakikinig sa `settings`, pero ang admin ay
        // HINDI kailanman -- kaya ang tatlong stage switch ay nananatiling luma
        // kung may ibang admin (o ibang tab) na nagpalit, at walang senyas na
        // hindi na tugma ang ipinapakita sa totoong estado ng lab.
        registerChannel('admin-realtime-settings', (ch) => ch
            .on('postgres_changes', { event: '*', schema: 'public', table: 'settings' }, () => {
                loadSettings();
            })
            .subscribe());
    }

    // fully working
    function calculateDuration(startedAt) {
        if (!startedAt) return 'Not Started';
        const start = new Date(startedAt);
        const now = new Date();
        const diffMs = now - start;
        if (diffMs < 0) return 'Just started';

        const diffHrs = Math.floor(diffMs / (1000 * 60 * 60));
        const diffMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
        const diffSecs = Math.floor((diffMs % (1000 * 60)) / 1000);

        if (diffHrs > 0) return `${diffHrs}h ${diffMins}m ${diffSecs}s`;
        if (diffMins > 0) return `${diffMins}m ${diffSecs}s`;
        return `${diffSecs}s`;
    }

    // fully working
    setInterval(() => {
        document.querySelectorAll('#unified-tbody tr[data-started-at]').forEach(tr => {
            const startedAt = tr.getAttribute('data-started-at');
            const durationEl = tr.querySelector('.student-duration');
            if (durationEl && startedAt) {
                durationEl.textContent = calculateDuration(startedAt);
            }
        });
    }, 1000);


    // ==========================================
    // 3. CORE UI & UTILITY FUNCTIONS
    // ==========================================

    // fully working
    function cleanupGhostMenus() {
        document.querySelectorAll('body > .action-menu, body > [id^="menu-"]').forEach(menu => {
            if (menu.id !== 'menu-backdrop' && menu.id !== 'mobile-menu') {
                if (menu.originalParent && document.body.contains(menu.originalParent)) {
                    menu.originalParent.appendChild(menu);
                } else {
                    menu.remove();
                }
            }
        });
    }

    // fully working
    function toggleMobileMenu(event) {
        // Prevent the click from bubbling up and triggering closeAllMenus()
        if (event && event.stopPropagation) event.stopPropagation();

        const menu = document.querySelector('#mobile-menu');
        const backdrop = document.getElementById('menu-backdrop');
        if (menu && backdrop) {
            menu.classList.toggle('translate-x-full');
            menu.classList.toggle('translate-x-0');
            backdrop.classList.toggle('hidden');

            const isOpen = !menu.classList.contains('translate-x-full');
            document.body.style.overflow = isOpen ? 'hidden' : '';
            document.documentElement.style.overflow = isOpen ? 'hidden' : '';

            const dynClose = document.getElementById('dynamic-close-btn');
            if (dynClose) {
                dynClose.classList.toggle('opacity-0', !isOpen);
                dynClose.classList.toggle('opacity-100', isOpen);
            }
        }
    }

    // fully working
    function restoreUIState() {
        switchTab(uiState.tab);
        const blacklist = ['edit-student-modal', 'section-details-modal', 'device-manager-modal', 'scores-modal', 'targeted-modal'];
        if (uiState.modal && !blacklist.includes(uiState.modal)) {
            openModal(uiState.modal);
        }
    }

    // fully working
    function switchTab(tabName) {
        if (tabName === 'students') updateStageCounters();
        sessionStorage.setItem('activeTab', tabName);
        cleanupGhostMenus();
        ['sections', 'students', 'professors', 'controls', 'settings'].forEach(t => {
            const el = document.getElementById(`view-${t}`);
            if (el) el.style.display = 'none';

            const navBtn = document.getElementById(`nav-${t}`);
            if (navBtn) navBtn.className = "admin-nav-btn inactive";

            const mobBtn = document.getElementById(`mob-nav-${t}`);
            if (mobBtn) mobBtn.className = "mobile-nav-link admin-nav-btn inactive";
        });

        const activeView = document.getElementById(`view-${tabName}`);
        if (activeView) activeView.style.display = 'block';

        const activeBtn = document.getElementById(`nav-${tabName}`);
        if (activeBtn) activeBtn.className = "admin-nav-btn active";

        const activeMobBtn = document.getElementById(`mob-nav-${tabName}`);
        if (activeMobBtn) activeMobBtn.className = "mobile-nav-link admin-nav-btn active";
    }

    function toggleActionMenu(event, safeId, explicitBtn = null) {
        event.stopPropagation();
        const btn = explicitBtn || event.currentTarget;
        const targetMenu = document.getElementById('menu-' + safeId);
        const isOpen = targetMenu && targetMenu.classList.contains('show-menu');
        closeAllMenus();

        if (targetMenu && !isOpen) {
            if (!targetMenu.originalParent) {
                targetMenu.originalParent = targetMenu.parentElement;
            }
            document.body.appendChild(targetMenu);
            targetMenu.classList.remove('hidden');
            targetMenu.classList.add('show-menu');

            const rect = btn.getBoundingClientRect();
            targetMenu.style.position = 'absolute';
            targetMenu.style.zIndex = '999999';

            const menuWidth = targetMenu.offsetWidth || 220;
            let leftPos = rect.right - menuWidth + window.scrollX;
            if (leftPos < 10 + window.scrollX) leftPos = 10 + window.scrollX;

            let topPos = rect.bottom + 4 + window.scrollY;
            const menuHeight = targetMenu.offsetHeight || 200;
            if (rect.bottom + 4 + menuHeight > window.innerHeight) topPos = rect.top - menuHeight - 4 + window.scrollY;

            targetMenu.style.top = topPos + 'px';
            targetMenu.style.left = leftPos + 'px';
        }
    }

    function closeAllMenus() {
        document.querySelectorAll('.action-menu, [id^="menu-"]').forEach(m => {
            if (m.id === 'menu-backdrop' || m.id === 'mobile-menu') return;
            m.classList.add('hidden');
            m.classList.remove('show-menu');

            // Ibalik sa original parent para walang maiwang ghost element sa body
            if (m.originalParent && document.body.contains(m.originalParent)) {
                m.originalParent.appendChild(m);
            }
        });
    }
    window.addEventListener('click', closeAllMenus);


    // ==========================================
    // 4. MODALS & POPUPS
    // ==========================================

    // fully working
    function openModal(id) {
        const modal = document.getElementById(id);
        const content = document.getElementById(id + '-content');
        if (modal) modal.classList.add('modal-active');
        if (content) content.classList.add('modal-content-active');
        document.body.style.overflow = 'hidden';
        sessionStorage.setItem('activeModal', id);
    }

    // fully working
    function closeModal(id) {
        const modal = document.getElementById(id);
        const content = document.getElementById(id + '-content');
        if (modal) modal.classList.remove('modal-active');
        if (content) content.classList.remove('modal-content-active');
        document.body.style.overflow = '';
        sessionStorage.removeItem('activeModal');

        if (pendingRealtimeUpdate && !document.querySelector('.modal-active') && !document.querySelector('.show-menu')) {
            pendingRealtimeUpdate = false;
            triggerDeferredRealtimeUpdate();
        }
    }

    // fully working
    function showCustomAlert(title, message, type = 'info') {
        document.getElementById('alert-title').textContent = title;
        document.getElementById('alert-message').textContent = message;

        const container = document.getElementById('alert-icon-container');
        if (type === 'error') {
            container.innerHTML = `<i data-lucide="alert-circle" class="icon-md text-danger" id="alert-icon"></i>`;
        } else if (type === 'success') {
            container.innerHTML = `<i data-lucide="check-circle" class="icon-md text-accent" id="alert-icon"></i>`;
        } else {
            container.innerHTML = `<i data-lucide="info" class="icon-md text-info" id="alert-icon"></i>`;
        }
        lucide.createIcons();
        openModal('custom-alert');
    }

    // fully working
    function closeCustomAlert() {
        closeModal('custom-alert');
    }

    let currentConfirmCallback = null;

    // fully working
    function showCustomConfirm(title, message, onConfirm) {
        document.getElementById('confirm-title').textContent = title;
        document.getElementById('confirm-message').textContent = message;
        currentConfirmCallback = onConfirm;
        openModal('custom-confirm');
    }

    // fully working
    function closeCustomConfirm() {
        closeModal('custom-confirm');
        currentConfirmCallback = null;
    }

    // fully working
    document.getElementById('confirm-yes-btn').addEventListener('click', async () => {
        const btn = document.getElementById('confirm-yes-btn');
        if (currentConfirmCallback) {
            btn.disabled = true;
            try {
                await currentConfirmCallback();
            } finally {
                btn.disabled = false;
                btn.textContent = 'Proceed';
            }
        }
        closeCustomConfirm();
    });


    // ==========================================
    // 5. STUDENT ROSTER & FILTER MANAGEMENT
    // ==========================================

    // fully working
    async function loadStudents() {
        const searchQueryEl = document.getElementById('search-student');
        const searchQuery = searchQueryEl ? searchQueryEl.value.trim().toLowerCase() : '';

        let query = sb.from('profiles').select('*', { count: 'exact' }).neq('role', 'admin');

        if (searchQuery) {
            query = query.or(`full_name.ilike.%${searchQuery}%,email.ilike.%${searchQuery}%`);
        }

        if (stateStageDrilldown !== null) {
            if (stateStageDrilldown === 'Active Game') {
                query = query.eq('is_in_game', true);
            } else {
                query = query.eq('current_stage', stateStageDrilldown).eq('is_in_game', false);
            }
        } else {
            if (stateGroupFilter === 'experimental') {
                if (stateSubgroupFilter === 'all') {
                    query = query.in('group_type', ['assigned', 'non-assigned', 'neutral']);
                } else {
                    query = query.eq('group_type', stateSubgroupFilter);
                }
            } else if (stateGroupFilter === 'control') {
                query = query.eq('group_type', 'control');
            }
        }

        const startIndex = (currentStudentPage - 1) * STUDENTS_PER_PAGE;
        const endIndex = startIndex + STUDENTS_PER_PAGE - 1;
        query = query.range(startIndex, endIndex).order('full_name', { ascending: true });

        const { data, error, count } = await query;
        if (error) return console.error('Error loading profiles:', error);

        studentDataCache = data || [];
        totalStudentCount = count || 0;
        renderUnifiedTable();
    }

    // fully working
    async function updateStageCounters() {
        const promises = [
            // 'email' sa halip na 'id': ang 'id' ay wala sa profiles, kaya ang
            // apat na counter query na ito ay bumabagsak sa 42703 (undefined
            // column) at nagbabalik ng 400. Dahil head:true + count:'exact'
            // ang gamit, hindi naman talaga binabasa ang column -- kailangan
            // lang nitong umiral. Ang 'email' ay tiyak na meron.
            sb.from('profiles').select('email', { count: 'exact', head: true }).eq('current_stage', 'OCEAN').neq('role', 'admin').eq('is_in_game', false),
            sb.from('profiles').select('email', { count: 'exact', head: true }).eq('current_stage', 'Character Selection').neq('role', 'admin').eq('is_in_game', false),
            sb.from('profiles').select('email', { count: 'exact', head: true }).eq('current_stage', 'Tutoring Dashboard').neq('role', 'admin').eq('is_in_game', false),
            sb.from('profiles').select('email', { count: 'exact', head: true }).eq('is_in_game', true).neq('role', 'admin')
        ];

        try {
            const [oceanRes, charRes, dashRes, gameRes] = await Promise.all(promises);
            document.getElementById('count-ocean').textContent = oceanRes.count || 0;
            document.getElementById('count-char').textContent = charRes.count || 0;
            document.getElementById('count-dash').textContent = dashRes.count || 0;
            document.getElementById('count-game').textContent = gameRes.count || 0;
            lucide.createIcons();
        } catch (err) {
            console.error("Error updating stage counters:", err);
        }
    }

    // fully working
    function setGroupFilter(group) {
        currentStudentPage = 1;
        stateGroupFilter = group; // Ibinalik sa tamang variable
        ['all', 'experimental', 'control'].forEach(g => {
            const btn = document.getElementById(`filter-group-${g}`);
            if (btn) btn.className = (g === group) ? "admin-nav-btn active" : "admin-nav-btn inactive";
        });

        const secContainer = document.getElementById('secondary-filter-container');
        if (group === 'experimental') {
            secContainer.classList.remove('hidden');
            setSubgroupFilter('all');
        } else {
            secContainer.classList.add('hidden');
            stateSubgroupFilter = 'all';
        }
        loadStudents();
    }

    // fully working
    function setSubgroupFilter(subgroup) {
        currentStudentPage = 1;
        stateSubgroupFilter = subgroup; // Ibinalik sa tamang variable
        ['all', 'assigned', 'non-assigned', 'neutral'].forEach(sub => {
            const btn = document.getElementById(`filter-sub-${sub}`);
            if (btn) {
                btn.className = (sub === subgroup)
                    ? "badge badge-pill badge-success"
                    : "badge badge-pill badge-neutral";
            }
        });
        loadStudents();
    }

    function toggleStageDrilldown(stage) {
        currentStudentPage = 1;
        if (stateStageDrilldown === stage) {
            clearStageDrilldown();
            return;
        }
        stateStageDrilldown = stage;
        document.getElementById('nested-filters-container').classList.add('hidden');
        document.getElementById('btn-clear-drilldown').classList.remove('hidden');

        const titleEl = document.getElementById('table-view-title');
        const descEl = document.getElementById('table-view-desc');

        ['ocean', 'char', 'dash', 'game'].forEach(box => {
            document.getElementById(`box-${box}`).classList.remove('selected');
        });

        if (stage === 'OCEAN') {
            titleEl.innerHTML = `<i data-lucide="brain" class="icon-sm text-accent"></i> OCEAN Test Live View`;
            descEl.textContent = "Monitoring students currently taking the Big Five Personality Inventory.";
            document.getElementById('box-ocean').classList.add('selected');
        } else if (stage === 'Character Selection') {
            titleEl.innerHTML = `<i data-lucide="users" class="icon-sm text-info"></i> Character Select Live View`;
            descEl.textContent = "Monitoring Non-Assigned subgroup choosing their persona.";
            document.getElementById('box-char').classList.add('selected');
        } else if (stage === 'Tutoring Dashboard') {
            titleEl.innerHTML = `<i data-lucide="layout-dashboard" class="icon-sm text-warning"></i> Dashboard Live View`;
            descEl.textContent = "Students browsing the main tutoring dashboard.";
            document.getElementById('box-dash').classList.add('selected');
        } else if (stage === 'Active Game') {
            titleEl.innerHTML = `<i data-lucide="gamepad-2" class="icon-sm text-success"></i> Active Session Live View`;
            descEl.textContent = "Students actively solving math problems. Tracking Decision Tree metrics.";
            document.getElementById('box-game').classList.add('selected');
        }
        loadStudents();
    }

    // fully working
    function clearStageDrilldown() {
        currentStudentPage = 1;
        stateStageDrilldown = null;
        document.getElementById('nested-filters-container').classList.remove('hidden');
        document.getElementById('btn-clear-drilldown').classList.add('hidden');
        document.getElementById('table-view-title').innerHTML = `<i data-lucide="users" class="icon-sm text-accent"></i> General Student Roster`;
        document.getElementById('table-view-desc').textContent = "Click any student row to view full-screen profile and alignment metrics.";

        ['ocean', 'char', 'dash', 'game'].forEach(box => {
            document.getElementById(`box-${box}`).classList.remove('selected');
        });
        loadStudents();
    }

    // fully working
    function renderUnifiedTable() {
        cleanupGhostMenus();

        const thead = document.getElementById('unified-thead');
        const tbody = document.getElementById('unified-tbody');

        thead.innerHTML = '';
        tbody.innerHTML = '';

        if (stateStageDrilldown === null) {
            thead.innerHTML = `
            <tr>
                <th>Student Name</th>
                <th>Email Address</th>
                <th>Section</th>
                <th>Group</th>
                <th>Persona Setup</th>
                <th>Current Stage</th>
                <th>Pre-Test</th>
                <th class="text-right">Actions</th>
            </tr>
        `;
        } else if (stateStageDrilldown === 'Active Game') {
            thead.innerHTML = `
            <tr>
                <th>Student Name</th>
                <th>Current Problem</th>
                <th>Difficulty</th>
                <th>Hints Used</th>
                <th>Consecutive Correct</th>
                <th>Duration</th>
                <th class="text-right">Actions</th>
            </tr>
        `;
        } else {
            thead.innerHTML = `
            <tr>
                <th>Student Name</th>
                <th>Section</th>
                <th>Current Activity</th>
                <th>Time Elapsed</th>
                <th class="text-right">Actions</th>
            </tr>
        `;
        }

        if (studentDataCache.length === 0) {
            tbody.innerHTML = `<tr><td colspan="10" class="empty-row">No students match the current filters.</td></tr>`;
            const paginationControls = document.getElementById('pagination-controls');
            if (paginationControls) paginationControls.classList.add('hidden');
            lucide.createIcons();
            return;
        }

        const totalPages = Math.ceil(totalStudentCount / STUDENTS_PER_PAGE);
        const paginationControls = document.getElementById('pagination-controls');
        if (paginationControls) {
            if (totalPages > 1) {
                paginationControls.classList.remove('hidden');
                document.getElementById('pagination-info').textContent = `Page ${currentStudentPage} of ${totalPages} (${totalStudentCount} students)`;
                document.getElementById('btn-prev-page').disabled = currentStudentPage === 1;
                document.getElementById('btn-next-page').disabled = currentStudentPage === totalPages;
                document.getElementById('btn-prev-page').onclick = previousStudentPage;
                document.getElementById('btn-next-page').onclick = nextStudentPage;
            } else {
                paginationControls.classList.add('hidden');
            }
        }

        studentDataCache.forEach(student => {
            const tr = document.createElement('tr');
            tr.className = "student-row";
            tr.setAttribute('data-started-at', student.stage_started_at || '');

            const safeEmailId = escapeHTML(String(student.email).replace(/[@.]/g, '_'));
            const safeEmail = escapeHTML(student.email);
            const isOnline = (student.active_devices || []).length > 0;
            const statusClass = isOnline ? 'status-dot-active' : 'status-dot-offline';

            tr.onclick = (e) => {
                // Ang action cell ay hindi na humihinto ng propagation (tingnan
                // ang delegation fix), kaya dito na tahasang inaalis ang row
                // click -- kung hindi, sabay na magbubukas ang profile overlay
                // at ang menu.
                if (e.target.closest('.action-cell') || e.target.closest('.action-menu')) return;
                openStudentProfile(
                    student.full_name, student.email, student.section || 'N/A', student.group_type || 'N/A',
                    isOnline ? 'Online' : 'Offline', student.max_devices ?? 1,
                    student.pre_test_score ?? 'n/a', student.post_test_score ?? 'n/a',
                    student.ocean_o ?? 'n/a', student.ocean_c ?? 'n/a', student.ocean_e ?? 'n/a', student.ocean_a ?? 'n/a', student.ocean_n ?? 'n/a'
                );
            };

            const actionMenuHTML = `
            <td class="action-cell">
                <button class="action-toggle-btn" data-action="toggle-menu" data-email-id="${safeEmailId}">
                    <i data-lucide="more-vertical" class="icon-xs"></i>
                </button>
                <div id="menu-${safeEmailId}" class="action-menu hidden">
                    <button data-action="send-activation" data-email="${safeEmail}" class="action-menu-item">
                        <i data-lucide="mail" class="icon-xs text-info"></i> Send Activation Email
                    </button>
                    <button data-action="edit-student" data-email="${safeEmail}" class="action-menu-item">
                        <i data-lucide="edit-3" class="icon-xs icon-edit"></i> Edit Details
                    </button>
                    <button data-action="device-manager" data-email="${safeEmail}" class="action-menu-item">
                        <i data-lucide="monitor" class="icon-xs text-accent"></i> Active Devices
                    </button>
                    <div class="action-menu-divider"></div>
                    <button data-action="retake-ocean" data-email="${safeEmail}" class="action-menu-item">
                        <i data-lucide="rotate-ccw" class="icon-xs text-warning"></i> Retake OCEAN Test
                    </button>
                    <button data-action="retake-character" data-email="${safeEmail}" class="action-menu-item">
                        <i data-lucide="user-cog" class="icon-xs text-accent"></i> Retake Char Select
                    </button>
                    <button data-action="reset-password" data-email="${safeEmail}" class="action-menu-item">
                        <i data-lucide="key" class="icon-xs icon-reset"></i> Reset Password
                    </button>
                    <div class="action-menu-divider"></div>
                    <button data-action="delete-user" data-email="${safeEmail}" class="action-menu-item action-delete">
                        <i data-lucide="trash-2" class="icon-xs"></i> Delete User
                    </button>
                </div>
            </td>
        `;

            if (stateStageDrilldown === null) {
                let groupLabel = student.group_type?.toLowerCase() === 'control' ? 'CTRL' : 'EXP';
                let groupColor = groupLabel === 'CTRL' ? 'text-info' : 'text-accent';
                let personaSetup = groupLabel === 'EXP'
                    ? (student.group_type === 'assigned' ? 'Assigned' : student.group_type === 'non-assigned' ? 'Free Choice' : student.group_type === 'neutral' ? 'Neutral' : 'N/A')
                    : 'Traditional';

                tr.innerHTML = `
                <td data-label="Student Name" class="row-name-cell">
                    <div class="row-avatar-wrap">
                        <div class="row-avatar-icon ${groupColor}"><i data-lucide="${groupLabel === 'CTRL' ? 'book' : 'user'}" class="icon-xs"></i></div>
                        <span class="row-status-dot ${statusClass}"></span>
                    </div>
                    <span class="truncate">${escapeHTML(student.full_name)}</span>
                </td>
                <td data-label="Email" class="cell-mono-xs truncate">${escapeHTML(student.email)}</td>
                <td data-label="Section" class="text-secondary truncate">${escapeHTML(student.section || 'N/A')}</td>
                <td data-label="Group" class="cell-label ${groupColor}">${groupLabel}</td>
                <td data-label="Setup" class="cell-label text-secondary truncate">${personaSetup}</td>
                <td data-label="Stage" class="text-primary truncate">${escapeHTML(student.current_stage || 'Idle')}</td>
                <td data-label="Pre-Test" class="cell-mono-xs">${escapeHTML(student.pre_test_score ?? 'n/a')}</td>
                ${actionMenuHTML}
            `;
            } else if (stateStageDrilldown === 'Active Game') {
                const duration = calculateDuration(student.stage_started_at);
                tr.innerHTML = `
                <td data-label="Student Name" class="row-name-cell">
                    <div class="row-avatar-icon text-success"><i data-lucide="gamepad-2" class="icon-xs"></i></div>
                    <span class="truncate">${escapeHTML(student.full_name)}</span>
                </td>
                <td data-label="Problem" class="cell-mono-xs truncate">Question ${safeInt(student.current_problem, 1)}</td>
                <td data-label="Difficulty" class="cell-label text-info">${escapeHTML(student.current_difficulty || 'Normal')}</td>
                <td data-label="Hints" class="cell-mono-xs text-warning">${safeInt(student.hints_used, 0)}</td>
                <td data-label="Correct" class="cell-mono-xs text-success">${safeInt(student.consecutive_correct, 0)}</td>
                <td data-label="Duration" class="cell-mono-xs student-duration">${duration}</td>
                ${actionMenuHTML}
            `;
            } else {
                const duration = calculateDuration(student.stage_started_at);
                let activity = "Reading Instructions";
                if (stateStageDrilldown === 'OCEAN') activity = `Answering Item ${safeInt(student.ocean_current_item, 1)}/50`;
                if (stateStageDrilldown === 'Character Selection') activity = `Browsing Personas`;
                if (stateStageDrilldown === 'Tutoring Dashboard') activity = `Browsing Dashboard`;

                tr.innerHTML = `
                <td data-label="Student Name" class="row-name-cell">
                    <span class="status-dot ${statusClass}"></span>
                    <span class="truncate">${escapeHTML(student.full_name)}</span>
                </td>
                <td data-label="Section" class="text-secondary truncate">${escapeHTML(student.section || 'N/A')}</td>
                <td data-label="Activity" class="cell-label text-accent truncate">${activity}</td>
                <td data-label="Duration" class="cell-mono-xs student-duration">${duration}</td>
                ${actionMenuHTML}
            `;
            }

            tbody.appendChild(tr);
        });
        lucide.createIcons();
    }


    // ==========================================
    // 6. STUDENT PROFILE OVERLAYS & FORMS
    // ==========================================

    // normalizeOceanScore() / OCEAN_SCORE_MAX ay nasa function.js na (shared helper)

    function openStudentProfile(name, email, section, type, status, maxDevices, pre, post, o, c, e, a, n) {
        document.getElementById('profile-name').textContent = name;
        document.getElementById('profile-email').textContent = email;
        document.getElementById('profile-section').textContent = section;
        document.getElementById('profile-type').textContent = type;
        document.getElementById('profile-device-limit').textContent = maxDevices;
        document.getElementById('profile-pre').textContent = pre;
        document.getElementById('profile-post').textContent = post;

        const normalized = {
            Openness: normalizeOceanScore(o),
            Conscientiousness: normalizeOceanScore(c),
            Extroversion: normalizeOceanScore(e),
            Agreeableness: normalizeOceanScore(a),
            Neuroticism: normalizeOceanScore(n)
        };

        document.getElementById('profile-ocean-o').textContent = normalized.Openness !== null ? `${normalized.Openness}%` : 'n/a';
        document.getElementById('profile-ocean-c').textContent = normalized.Conscientiousness !== null ? `${normalized.Conscientiousness}%` : 'n/a';
        document.getElementById('profile-ocean-e').textContent = normalized.Extroversion !== null ? `${normalized.Extroversion}%` : 'n/a';
        document.getElementById('profile-ocean-a').textContent = normalized.Agreeableness !== null ? `${normalized.Agreeableness}%` : 'n/a';
        document.getElementById('profile-ocean-n').textContent = normalized.Neuroticism !== null ? `${normalized.Neuroticism}%` : 'n/a';

        let dominantTraits = [];
        let maxScore = -1;
        for (const [trait, score] of Object.entries(normalized)) {
            if (score === null) continue;
            if (score > maxScore) { maxScore = score; dominantTraits = [trait]; }
            else if (score === maxScore) dominantTraits.push(trait);
        }
        if (dominantTraits.length === 0) dominantTraits = ['Openness'];

        document.getElementById('profile-persona-badge').textContent = `${dominantTraits.join(' & ')} Persona`;
        document.getElementById('student-profile-screen').classList.remove('hidden');
        document.getElementById('student-profile-screen').classList.add('flex');
        document.body.style.overflow = 'hidden';
    }

    // fully working
    function closeStudentProfile() {
        document.getElementById('student-profile-screen').classList.add('hidden');
        document.getElementById('student-profile-screen').classList.remove('flex');
        document.body.style.overflow = 'auto';
    }

    // fully working
    function toggleAvatarVisibility() {
        const container = document.getElementById('avatar-container');
        const btn = document.getElementById('toggle-avatar-btn');
        if (container.classList.contains('hidden')) {
            container.classList.remove('hidden');
            btn.textContent = 'Hide Image';
        } else {
            container.classList.add('hidden');
            btn.textContent = 'Show Image';
        }
    }

    // fully working
    // ==========================================
    // SHARED HELPERS PARA SA REGISTER / EDIT
    // ==========================================

    // Ang Supabase Auth ay nag-iimbak ng email nang LOWERCASE, at ang app ay
    // eksaktong tugma ang hinahanap: .eq('email', session.user.email). Kaya ang
    // isang 'Juan@UE.edu.ph' na na-type sa form ay gumagawa ng profile row na
    // HINDI KAILANMAN matutugma sa session -- nagla-log in ang estudyante, wala
    // namang nakikitang profile ang requireStudentSession(), at agad silang
    // itinatapon pabalik sa index. Iyon ang "Account configuration error".
    // Sa 76 na account na manu-manong itina-type, tiyak itong mangyayari.
    function normalizeEmail(raw) {
        return (raw || '').trim().toLowerCase();
    }

    // Ginagawang nababasang mensahe ang mga Postgres error code.
    function friendlyDbError(error, fallback) {
        if (!error) return fallback;
        const msg = error.message || '';
        if (error.code === '23505' || /duplicate key|already exists/i.test(msg)) {
            return 'An account already uses this email. Only one account per email is allowed.';
        }
        if (error.code === '42501' || /permission denied|row-level security/i.test(msg)) {
            return 'You do not have permission for this action. Make sure you are signed in as an admin.';
        }
        return msg || fallback;
    }

    // 0-100 ang saklaw ng pre/post test. Ang isang mali-type na 1000 ay tahimik
    // na sumisira ng research data -- at ginagamit ito ng teacher dashboard sa
    // threshold na < 70 para sa "Struggling".
    function parseScore(raw) {
        if (raw === null || raw === undefined || String(raw).trim() === '') return { ok: true, value: null };
        const n = parseFloat(raw);
        if (!Number.isFinite(n) || n < 0 || n > 100) return { ok: false, value: null };
        return { ok: true, value: n };
    }

    async function handleRegisterStudent(event) {
        event.preventDefault();

        const form = event.target;
        const btn = form.querySelector('button[type="submit"]');

        const first = document.getElementById('add-first-name').value.trim();
        const middle = document.getElementById('add-middle-name').value.trim();
        const last = document.getElementById('add-last-name').value.trim();
        const full_name = [first, middle, last].filter(Boolean).join(' ');

        const email = normalizeEmail(document.getElementById('student-email').value);
        const section = document.getElementById('student-section').value;
        const group_type = document.getElementById('student-type').value;
        const max_devices = parseInt(document.getElementById('student-device-limit').value) || 1;

        const score = parseScore(document.getElementById('student-pretest').value);
        if (!score.ok) return showCustomAlert("Validation Error", "Pre-test score must be between 0 and 100.", "error");

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return showCustomAlert("Validation Error", "Invalid email address.", "error");
        }

        // DOUBLE-SUBMIT GUARD: kung wala ito, ang dalawang mabilis na click ay
        // dalawang beses tumatawag ng admin_create_auth_user bago pa makabalik
        // ang una.
        if (btn) { btn.disabled = true; btn.textContent = 'Registering...'; }

        try {
            // PRE-CHECK BAGO GUMAWA NG AUTH USER. Ang admin_create_auth_user ay
            // tumatakbo MUNA; kung mabibigo ang profiles insert pagkatapos (hal.
            // duplicate email), may naiwang auth user na WALANG profile -- at
            // ang susunod na pagsubok ay babagsak sa "user already exists",
            // kaya hindi na talaga mairerehistro ang estudyanteng iyon.
            // Ang pagsusuri muna ang umiiwas sa buong sitwasyong iyon.
            const { data: existing } = await sb.from('profiles')
                .select('email').eq('email', email).maybeSingle();

            if (existing) {
                return showCustomAlert("Duplicate Email",
                    `${email} is already on the roster. Use Edit Details to change it.`, "error");
            }

            const { error: authError } = await sb.rpc('admin_create_auth_user', {
                target_email: email,
                default_password: generateSecurePassword()
            });

            if (authError) {
                return showCustomAlert("Auth Error", friendlyDbError(authError, "Could not create the auth user."), "error");
            }

            const { error } = await sb.from('profiles').insert([{
                full_name, email, section, group_type,
                pre_test_score: score.value, max_devices,
                status: 'inactive', role: 'student'
            }]);

            if (error) {
                // Naging matagumpay ang auth user pero nabigo ang profile row.
                // Sabihin ito nang tahasan -- may naiwang orphan na kailangang
                // linisin bago muling subukan.
                return showCustomAlert("Registration Error",
                    friendlyDbError(error, "Could not save the profile.") +
                    ' (NOTE: an auth user was already created for ' + email +
                    ' -- it must be deleted before registering again.)', "error");
            }

            document.getElementById('add-student-form').reset();
            closeModal('add-student-modal');
            loadStudents();
            showCustomAlert("Registration Success", `${full_name} added to roster (Inactive until emailed).`, "success");
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = 'Register'; }
        }
    }

    // fully working
    function openEditStudent(fullName, email, section, pretest, type, maxDevices) {
        const nameParts = fullName.trim().split(' ');
        let first = nameParts[0] || '', middle = '', last = '';
        if (nameParts.length === 2) last = nameParts[1];
        else if (nameParts.length > 2) { last = nameParts[nameParts.length - 1]; middle = nameParts.slice(1, -1).join(' '); }

        document.getElementById('edit-student-original-email').value = email;
        document.getElementById('edit-first-name').value = first;
        document.getElementById('edit-middle-name').value = middle;
        document.getElementById('edit-last-name').value = last;
        document.getElementById('edit-student-email-input').value = email;

        const sectionSelect = document.getElementById('edit-student-section');
        const optionExists = Array.from(sectionSelect.options).some(opt => opt.value === section);
        if (!optionExists && section) {
            const newOpt = document.createElement('option');
            newOpt.value = section;
            newOpt.textContent = section;
            sectionSelect.appendChild(newOpt);
        }
        sectionSelect.value = section;

        document.getElementById('edit-student-pretest').value = pretest;
        document.getElementById('edit-student-type').value = type;
        document.getElementById('edit-student-device-limit').value = maxDevices || 1;

        openModal('edit-student-modal');
    }

    async function handleUpdateStudent(event) {
        event.preventDefault();

        const form = event.target;
        const btn = form.querySelector('button[type="submit"]');
        const originalEmail = document.getElementById('edit-student-original-email').value;

        const first = document.getElementById('edit-first-name').value.trim();
        const middle = document.getElementById('edit-middle-name').value.trim();
        const last = document.getElementById('edit-last-name').value.trim();
        const full_name = [first, middle, last].filter(Boolean).join(' ');

        const email = normalizeEmail(document.getElementById('edit-student-email-input').value);
        const section = document.getElementById('edit-student-section').value;
        const group_type = document.getElementById('edit-student-type').value;
        const max_devices = parseInt(document.getElementById('edit-student-device-limit').value) || 1;

        const score = parseScore(document.getElementById('edit-student-pretest').value);
        if (!score.ok) return showCustomAlert("Validation Error", "Pre-test score must be between 0 and 100.", "error");

        const emailChanged = (email !== normalizeEmail(originalEmail));

        if (emailChanged && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return showCustomAlert("Validation Error", "Invalid email address.", "error");
        }

        if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }

        try {
            // BANGGAAN MUNA, BAGO ANG AUTH. Dati, tumatakbo agad ang
            // admin_update_user_email, tapos saka lang ang profiles update.
            // Kapag nabigo ang pangalawa (hal. may ibang profile na gamit na ang
            // bagong email), ang auth ay may BAGONG email na, ang profiles ay
            // LUMA pa rin -- at wala nang tumutugmang profile ang session ng
            // estudyante. Hindi na sila makaka-login, at tahimik ang pagkasira.
            if (emailChanged) {
                const { data: clash } = await sb.from('profiles')
                    .select('email').eq('email', email).maybeSingle();

                if (clash) {
                    return showCustomAlert("Duplicate Email",
                        `${email} is already using that email. Choose a different one.`, "error");
                }

                const { error: rpcError } = await sb.rpc('admin_update_user_email', {
                    target_email: originalEmail,
                    new_email: email
                });
                if (rpcError) {
                    return showCustomAlert("Auth Sync Error",
                        friendlyDbError(rpcError, "Could not update the auth email."), "error");
                }
            }

            const updatePayload = {
                full_name, section, pre_test_score: score.value, group_type, max_devices
            };
            if (emailChanged) updatePayload.email = email;

            const { error } = await sb.from('profiles').update(updatePayload).eq('email', originalEmail);

            if (error) {
                return showCustomAlert("Update Error",
                    friendlyDbError(error, "Could not update the profile.") +
                    (emailChanged ? ' (WARNING: the auth email was already changed to ' + email +
                                    ' but the profile was not -- these must be reconciled immediately.)' : ''), "error");
            }

            closeModal('edit-student-modal');
            loadStudents();
            showCustomAlert("Update Success", `Student details updated successfully.`, "success");
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = 'Save Changes'; }
        }
    }

    // fully working
    async function allowStudentRetakeOcean(email) {
        showCustomConfirm("Retake OCEAN Test", `Allow ${email} to retake OCEAN test?`, async () => {
            await sb.from('profiles').update({
                is_ocean_done: false, current_stage: 'OCEAN', stage_started_at: new Date().toISOString(),
                ocean_e: null, ocean_a: null, ocean_c: null, ocean_n: null, ocean_o: null
            }).eq('email', email);
            showCustomAlert("Success", `${email} can now retake OCEAN test.`, "success");
            loadStudents();
        });
    }

    // fully working
    async function allowStudentRetakeCharacter(email) {
        showCustomConfirm("Retake Character Select", `Allow ${email} to re-select character?`, async () => {
            await sb.from('profiles').update({
                selected_character: null, current_stage: 'Character Selection', stage_started_at: new Date().toISOString()
            }).eq('email', email);
            showCustomAlert("Success", `${email} can now re-select character.`, "success");
            loadStudents();
        });
    }


    // ==========================================
    // 7. SECTION & SCORES MANAGEMENT
    // ==========================================

    // fully working
    let lastSectionsSignature = null;

    async function loadSections() {
        const { data, error } = await sb.from('sections').select('*');
        if (error) return console.error('Error loading sections:', error);

        // Tumatakbo ito bawat realtime tick. Dati, muling itinatayo nito ang
        // buong sections grid, nililinis at pinupuno ang APAT na <select>, at
        // pinapatakbo ang lucide.createIcons() sa buong DOM -- bawat segundo sa
        // isang live na session. Kapag hindi nagbago ang listahan, laktawan.
        const signature = JSON.stringify((data || []).map(x => x.name).sort());
        const sectionsChanged = (signature !== lastSectionsSignature);
        lastSectionsSignature = signature;

        const grid = document.getElementById('sections-grid');
        grid.innerHTML = '';

        const sectionSelects = document.querySelectorAll('#student-section, #edit-student-section, #prof-section, #target-section-select');
        sectionSelects.forEach(select => { select.innerHTML = ''; });

        if (!data || data.length === 0) {
            grid.innerHTML = `<p class="empty-row admin-grid-span-all">No sections found. Click "Add Section" to create one.</p>`;
            return;
        }

        const { data: allProfiles } = await sb.from('profiles').select('section').neq('role', 'admin');

        // Ang enrolled count lang ang nagbabago kapag pareho pa rin ang mga
        // section -- pero mura ang buong redraw sa ganitong laki, at ang
        // mahalaga ay hindi na natatanggal ang napili ng admin sa dropdown
        // kung walang tunay na pagbabago.
        if (!sectionsChanged && grid.childElementCount > 0) {
            const counts = {};
            (allProfiles || []).forEach(pr => { if (pr.section) counts[pr.section] = (counts[pr.section] || 0) + 1; });
            grid.querySelectorAll('.section-card').forEach(card => {
                const title = card.querySelector('.section-card-title');
                const badge = card.querySelector('.badge');
                if (title && badge) badge.textContent = `${counts[title.textContent] || 0} Enrolled`;
            });
            return;
        }
        const sectionCounts = {};
        if (allProfiles) {
            allProfiles.forEach(p => {
                if (p.section) sectionCounts[p.section] = (sectionCounts[p.section] || 0) + 1;
            });
        }

        for (const sec of (data || [])) {
            const name = sec.name;
            sectionSelects.forEach(select => {
                const option = document.createElement('option');
                option.value = name;
                option.textContent = name;
                select.appendChild(option);
            });

            const count = sectionCounts[name] || 0;

            const card = document.createElement('div');
            card.className = "solid-card card-padded section-card";
            card.onclick = () => openSectionDetails(name);

            card.innerHTML = `
            <div class="section-card-head">
                <div class="flex-row gap-sm">
                    <h3 class="section-card-title">${escapeHTML(name)}</h3>
                    <span class="badge badge-neutral">${count} Enrolled</span>
                </div>
                <span class="section-card-arrow"><i data-lucide="chevron-right" class="icon-sm"></i></span>
            </div>
            <div class="admin-grid-2">
                <div class="section-action-tile" onclick="event.stopPropagation(); openScoresModal('${escapeJS(name)}')">
                    <p class="section-action-label">Scores <i data-lucide="edit-2" class="icon-xs text-accent"></i></p>
                    <p class="section-action-value">Input / View</p>
                </div>
                <div class="section-action-tile" onclick="event.stopPropagation(); sendSectionEmails('${escapeJS(name)}')">
                    <p class="section-action-label">Broadcast <i data-lucide="send" class="icon-xs text-accent"></i></p>
                    <p class="section-action-value text-accent">Email Roster</p>
                </div>
            </div>
        `;
            grid.appendChild(card);
        }
        lucide.createIcons();
    }

    // fully working
    async function saveNewSection() {
        const name = document.getElementById('new-section-name').value.trim();
        if (!name) return showCustomAlert("Validation Error", "Please enter a section name.", "error");

        const { error } = await sb.from('sections').insert([{ name }]);
        if (error) return showCustomAlert("Creation Error", error.message, "error");

        document.getElementById('new-section-name').value = '';
        closeModal('add-section-modal');
        loadSections();
        showCustomAlert("Section Added", `Section ${name} created successfully!`, "success");
    }

    // fully working
    async function openSectionDetails(sectionName) {
        currentActiveSection = sectionName;
        document.getElementById('modal-section-title').textContent = `Section: ${sectionName}`;

        // Ang eksaktong columns lang na ginagamit ng table na ito (dating '*',
        // na naghahatid ng buong row kasama ang active_devices at iba pang
        // field na hindi naman ipinapakita dito).
        const { data } = await sb.from('profiles').select('role, full_name, email, section, group_type, status, max_devices, pre_test_score, post_test_score, ocean_o, ocean_c, ocean_e, ocean_a, ocean_n').eq('section', sectionName);
        const studentsOnly = data ? data.filter(student => (student.role || '').toLowerCase() !== 'admin') : [];
        const tbody = document.getElementById('section-students-tbody');
        tbody.innerHTML = '';

        if (studentsOnly.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" class="empty-row">No students found in this section.</td></tr>`;
        } else {
            studentsOnly.forEach(student => {
                const safeEmailId = escapeHTML(String(student.email).replace(/[@.]/g, '_'));
                const tr = document.createElement('tr');
                tr.className = "student-row";
                tr.onclick = () => { openStudentProfile(student.full_name, student.email, sectionName, student.group_type, student.status, student.max_devices ?? 1, student.pre_test_score ?? 'n/a', student.post_test_score ?? 'n/a', student.ocean_o ?? 'n/a', student.ocean_c ?? 'n/a', student.ocean_e ?? 'n/a', student.ocean_a ?? 'n/a', student.ocean_n ?? 'n/a'); };

                tr.innerHTML = `
                <td class="text-primary" style="font-weight:500;">${escapeHTML(student.full_name)}</td>
                <td class="text-secondary">${escapeHTML(student.email)}</td>
                <td><span class="badge badge-success">${escapeHTML(student.group_type || 'N/A')}</span></td>
                <td>
                    <div class="flex-row gap-xs">
                        <span class="status-dot ${student.status === 'active' ? 'status-dot-active' : 'status-dot-inactive'}"></span>
                        <span class="cell-label text-secondary">${student.status === 'active' ? 'Active' : 'Inactive'}</span>
                    </div>
                </td>
                <td class="action-cell" onclick="event.stopPropagation()">
                    <button onclick="toggleActionMenu(event, 'sec-${safeEmailId}')" class="action-toggle-btn">
                        <i data-lucide="more-vertical" class="icon-sm"></i>
                    </button>
                    <div id="menu-sec-${safeEmailId}" onclick="event.stopPropagation()" class="action-menu hidden">
                        <button onclick="sendActivationEmail('${escapeJS(student.email)}'); closeAllMenus();" class="action-menu-item">
                            <i data-lucide="mail" class="icon-xs text-info"></i> Send Email
                        </button>
                        <button onclick="closeModal('section-details-modal'); openEditStudent('${escapeJS(student.full_name)}', '${escapeJS(student.email)}', '${escapeJS(student.section || '')}', '${escapeJS(student.pre_test_score ?? '')}', '${escapeJS(student.group_type || '')}', ${safeInt(student.max_devices, 1)}); closeAllMenus();" class="action-menu-item">
                            <i data-lucide="edit-3" class="icon-xs icon-edit"></i> Edit Details
                        </button>
                        <button onclick="resetPasswordFromMenu('${escapeJS(student.email)}'); closeAllMenus();" class="action-menu-item">
                            <i data-lucide="key" class="icon-xs icon-reset"></i> Reset Password
                        </button>
                    </div>
                </td>
            `;
                tbody.appendChild(tr);
            });
            lucide.createIcons();
        }
        openModal('section-details-modal');
    }

    // fully working
    async function openScoresModal(sectionName) {
        currentActiveSection = sectionName;
        document.getElementById('scores-modal-title').textContent = `Input Scores: ${sectionName}`;

        const { data } = await sb.from('profiles').select('role, full_name, email, group_type, pre_test_score, post_test_score').eq('section', sectionName);
        const studentsOnly = data ? data.filter(student => (student.role || '').toLowerCase() !== 'admin') : [];
        const tbody = document.getElementById('scores-table-body');
        tbody.innerHTML = '';

        if (studentsOnly.length === 0) {
            tbody.innerHTML = `<tr><td colspan="4" class="empty-row">No students found in this section.</td></tr>`;
        } else {
            studentsOnly.forEach(student => {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                <td class="text-primary" style="font-weight:500;">${escapeHTML(student.full_name)}</td>
                <td><span class="badge badge-neutral">${escapeHTML(student.group_type || '')}</span></td>
                <td><input type="number" step="0.1" class="form-input score-input score-pre" value="${escapeHTML(student.pre_test_score ?? '')}" data-email="${escapeHTML(student.email)}"></td>
                <td><input type="number" step="0.1" class="form-input score-input score-post text-accent" value="${escapeHTML(student.post_test_score ?? '')}" data-email="${escapeHTML(student.email)}"></td>
            `;
                tbody.appendChild(tr);
            });
        }
        openModal('scores-modal');
    }

    // fully working
    function openScoresModalFromDetails() {
        closeModal('section-details-modal');
        setTimeout(() => openScoresModal(currentActiveSection), 300);
    }

    // fully working
    async function saveBatchScores() {
        const btn = document.querySelector('#scores-modal .btn-primary');
        if (btn) { btn.disabled = true; btn.textContent = 'PROCESSING...'; }

        const rows = document.querySelectorAll('#scores-table-body tr');
        const updates = [];

        for (const tr of rows) {
            const preInput = tr.querySelector('.score-pre');
            const postInput = tr.querySelector('.score-post');
            if (!preInput || !postInput) continue;

            const email = preInput.getAttribute('data-email');
            const pre = parseScore(preInput.value);
            const post = parseScore(postInput.value);

            // 0-100 lang. Ang isang mali-type na 1000 ay tahimik na sumisira ng
            // research data, at ginagamit ito ng teacher dashboard sa threshold
            // na < 70 para sa "Struggling".
            if (!pre.ok || !post.ok) {
                if (btn) { btn.disabled = false; btn.textContent = 'SAVE SCORES'; }
                return showCustomAlert("Validation Error",
                    `The score for ${email} must be between 0 and 100.`, "error");
            }

            updates.push({ email, pre_test_score: pre.value, post_test_score: post.value });
        }

        if (updates.length > 0) {
            // Dating .upsert(..., { onConflict: 'email' }).
            //
            // Dalawang bagay ang mahalaga:
            //   * Bago ang 0010, WALANG unique constraint sa email -- kaya ang
            //     ON CONFLICT (email) ay palaging bumabagsak. Hindi kailanman
            //     gumana ang batch scores hangga't hindi naidadagdag iyon.
            //   * Kahit gumagana na ito, ang upsert ay NAG-I-INSERT kapag walang
            //     tugma. Kung may ibang admin na magbubura ng estudyante habang
            //     nakabukas ang modal na ito, MULING BUBUHAYIN ng pag-save ang
            //     row nila bilang multo: email at score lang, NULL ang pangalan,
            //     at role='student' dahil sa default -- tapos lalabas ito sa
            //     roster at sa research export.
            //
            // UPDATE na lang: kung wala na ang row, 0 row ang matatamaan --
            // walang multong nagagawa.
            const results = await Promise.all(updates.map(u =>
                sb.from('profiles')
                  .update({ pre_test_score: u.pre_test_score, post_test_score: u.post_test_score })
                  .eq('email', u.email)
            ));

            const failed = results.find(r => r.error);
            if (failed) {
                if (btn) { btn.disabled = false; btn.textContent = 'SAVE SCORES'; }
                console.error('Batch save error:', failed.error);
                return showCustomAlert("Error", friendlyDbError(failed.error, "Could not save the scores."), "error");
            }
        }

        if (btn) { btn.disabled = false; btn.textContent = 'SAVE SCORES'; }
        closeModal('scores-modal');
        showCustomAlert("Scores Updated", `Grades for ${currentActiveSection} have been saved successfully.`, "success");
    }


    // ==========================================
    // 8. PROFESSOR MANAGEMENT
    // ==========================================

    // fully working
    async function loadProfessors() {
        cleanupGhostMenus();

        const { data, error } = await sb.from('professors').select('*');
        if (error) return console.error('Error loading professors:', error);

        const tbody = document.getElementById('professor-table-body');
        const cardsContainer = document.getElementById('professor-cards-container');

        tbody.innerHTML = '';
        if (cardsContainer) cardsContainer.innerHTML = '';

        (data || []).forEach(prof => {
            const safeEmailId = prof.email.replace(/[@.]/g, '_');

            // Desktop Row HTML
            const tr = document.createElement('tr');
            tr.className = "professor-row";
            tr.onclick = () => { openProfessorProfile(prof.name, prof.email, prof.department, prof.assigned_section, prof.status); };

            tr.innerHTML = `
            <td class="row-name-cell">
                <div class="row-avatar-icon text-info">
                    <i data-lucide="shield-alert" class="icon-xs"></i>
                </div>
                ${escapeHTML(prof.name)}
            </td>
            <td class="text-secondary">${escapeHTML(prof.email)}</td>
            <td class="text-secondary">${escapeHTML(prof.department)}</td>
            <td><span class="badge badge-info">${escapeHTML(prof.assigned_section)}</span></td>
            <td>
                <div class="flex-row gap-xs">
                    <span class="status-dot ${prof.status === 'active' ? 'status-dot-active' : 'status-dot-inactive'}"></span>
                    <span class="cell-label text-secondary">${prof.status === 'active' ? 'Active' : 'Inactive'}</span>
                </div>
            </td>
            <td class="action-cell" onclick="event.stopPropagation()">
                <button onclick="toggleActionMenu(event, 'prof-${safeEmailId}')" class="action-toggle-btn">
                    <i data-lucide="more-vertical" class="icon-sm"></i>
                </button>
                <div id="menu-prof-${safeEmailId}" onclick="event.stopPropagation()" class="action-menu hidden">
                    <button onclick="resetPasswordFromMenu('${escapeJS(prof.email)}'); closeAllMenus();" class="action-menu-item">
                        <i data-lucide="key" class="icon-xs icon-reset"></i> Reset Password
                    </button>
                    <div class="action-menu-divider"></div>
                    <button onclick="deleteUserFromMenu('${escapeJS(prof.email)}', 'professors'); closeAllMenus();" class="action-menu-item action-delete">
                        <i data-lucide="trash-2" class="icon-xs"></i> Remove Faculty
                    </button>
                </div>
            </td>
        `;
            tbody.appendChild(tr);

            // Mobile Card HTML
            if (cardsContainer) {
                const card = document.createElement('div');
                card.className = "solid-card card-padded professor-row prof-card";
                card.onclick = () => { openProfessorProfile(prof.name, prof.email, prof.department, prof.assigned_section, prof.status); };

                card.innerHTML = `
                <div class="prof-card-head">
                    <div class="row-name-cell">
                        <div class="row-avatar-icon text-info prof-card-icon">
                            <i data-lucide="shield-alert" class="icon-sm"></i>
                        </div>
                        <div>
                            <p class="prof-card-name">${escapeHTML(prof.name)}</p>
                            <p class="cell-mono-xs">${escapeHTML(prof.email)}</p>
                        </div>
                    </div>
                    <div class="action-cell" onclick="event.stopPropagation()">
                        <button onclick="toggleActionMenu(event, 'prof-mob-${safeEmailId}')" class="action-toggle-btn">
                            <i data-lucide="more-vertical" class="icon-sm"></i>
                        </button>
                        <div id="menu-prof-mob-${safeEmailId}" class="action-menu hidden">
                            <button onclick="resetPasswordFromMenu('${escapeJS(prof.email)}'); closeAllMenus();" class="action-menu-item">
                                <i data-lucide="key" class="icon-xs icon-reset"></i> Reset Password
                            </button>
                            <div class="action-menu-divider"></div>
                            <button onclick="deleteUserFromMenu('${escapeJS(prof.email)}', 'professors'); closeAllMenus();" class="action-menu-item action-delete">
                                <i data-lucide="trash-2" class="icon-xs"></i> Remove Faculty
                            </button>
                        </div>
                    </div>
                </div>
                <div class="prof-card-details">
                    <div>
                        <p class="cell-label text-secondary">Department</p>
                        <p class="prof-card-detail-value truncate">${escapeHTML(prof.department)}</p>
                    </div>
                    <div>
                        <p class="cell-label text-secondary">Section</p>
                        <p class="prof-card-detail-value text-info truncate">${escapeHTML(prof.assigned_section)}</p>
                    </div>
                </div>
            `;
                cardsContainer.appendChild(card);
            }
        });

        lucide.createIcons();
    }

    // fully working
    function filterProfessors() {
        let query = document.getElementById('search-professor').value.toLowerCase();
        document.querySelectorAll('.professor-row').forEach(row => {
            let text = row.textContent.toLowerCase();
            row.style.display = text.includes(query) ? '' : 'none';
        });
    }

    // fully working
    async function handleRegisterProfessor(event) {
        event.preventDefault();

        const form = event.target;
        const btn = form.querySelector('button[type="submit"]');

        const name = document.getElementById('prof-name').value.trim();
        const email = normalizeEmail(document.getElementById('prof-email').value);
        const department = document.getElementById('prof-dept').value;
        const assigned_section = document.getElementById('prof-section').value;

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return showCustomAlert("Validation Error", "Invalid email address.", "error");
        }

        if (btn) { btn.disabled = true; btn.textContent = 'Registering...'; }

        try {
        // Katulad ng student registration: suriin MUNA bago gumawa ng auth user.
        // Ang admin_register_teacher ay naglalagay ng profiles row, at may
        // UNIQUE(email) na ito mula sa 0010 -- kaya ang email na ginagamit na ng
        // isang estudyante ay babagsak DOON, pagkatapos nang magawa ang auth
        // user, at maiiwan ang isang orphan na hindi na kayang irehistro muli.
        const { data: existing } = await sb.from('profiles')
            .select('email').eq('email', email).maybeSingle();

        if (existing) {
            return showCustomAlert("Duplicate Email",
                `${email} is already used by another account.`, "error");
        }

        const authRes = await sb.rpc('admin_create_auth_user', { target_email: email, default_password: generateSecurePassword() });
        if (authRes.error) return showCustomAlert("Auth Creation Error", friendlyDbError(authRes.error, "Could not create the auth user."), "error");

        // FIX: dati, sa `professors` table lang ipinapasok ang bagong teacher.
        // Pero ang login (index.js) at ang teacher guard (teacher-dashboard.js)
        // ay parehong naghahanap ng profiles row na may role='teacher' -- kaya
        // WALA NI ISANG admin-created na teacher ang nakapasok kailanman.
        // Iisang RPC na ngayon ang naglalagay ng DALAWANG row sa isang
        // transaction, kaya hindi na pwedeng ma-create nang kalahati lang.
        const { error } = await sb.rpc('admin_register_teacher', {
            p_email: email,
            p_name: name,
            p_department: department,
            p_assigned_section: assigned_section
        });
        if (error) return showCustomAlert("Registration Error",
            friendlyDbError(error, "Could not save the teacher.") +
            ' (NOTE: an auth user was already created for ' + email +
            ' -- it must be deleted before registering again.)', "error");

        document.getElementById('add-professor-form').reset();
        closeModal('add-professor-modal');
        loadProfessors();
        showCustomAlert("Registration Success", `${name} added to the faculty roster.`, "success");
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = 'Register'; }
        }
    }

    // fully working
    // Tinatawag ito ng dalawang call site na may 5 argument (kasama ang status),
    // pero 4 lang ang dating parameter dito kaya tahimik na nalalaglag ang status.
    function openProfessorProfile(name, email, dept, section, status) {
        document.getElementById('prof-profile-name').textContent = name;
        document.getElementById('prof-profile-email').textContent = email;
        document.getElementById('prof-profile-dept').textContent = dept;
        document.getElementById('prof-profile-section').textContent = section || 'Unassigned';

        const statusEl = document.getElementById('prof-profile-status');
        const statusDot = document.getElementById('prof-profile-status-dot');
        if (statusEl && statusDot) {
            const isActive = status === 'active';
            statusEl.textContent = isActive ? 'Active' : 'Offline';
            statusDot.className = isActive
                ? 'status-dot status-dot-active'
                : 'status-dot status-dot-offline';
        }

        document.getElementById('professor-profile-screen').classList.remove('hidden');
        document.getElementById('professor-profile-screen').classList.add('flex');
        document.body.style.overflow = 'hidden';
    }

    // fully working
    function closeProfessorProfile() {
        document.getElementById('professor-profile-screen').classList.add('hidden');
        document.getElementById('professor-profile-screen').classList.remove('flex');
        document.body.style.overflow = 'auto';
    }


    // ==========================================
    // 9. DEVICE & SECURITY MANAGEMENT
    // ==========================================

    // fully working
    // getDeviceSignature() ay nasa function.js na (shared helper)

    // fully working
    async function openDeviceManager(email) {
        currentManagingEmail = email;
        document.getElementById('device-modal-email').textContent = email;

        const { data: student } = await sb.from('profiles').select('active_devices').eq('email', email).maybeSingle();
        renderDeviceList(student?.active_devices || []);
        openModal('device-manager-modal');
    }

    // fully working
    function renderDeviceList(devices) {
        const container = document.getElementById('device-list-container');
        container.innerHTML = '';

        if (!devices || devices.length === 0) {
            container.innerHTML = `<p class="empty-row">No active devices logged in.</p>`;
            return;
        }

        devices.forEach((devId) => {
            let platform = "Unknown Device";
            let iconName = "monitor";
            if (devId.includes('Android')) { platform = "Android Smartphone"; iconName = "smartphone"; }
            else if (devId.includes('iOS')) { platform = "iOS Device"; iconName = "smartphone"; }
            else if (devId.includes('iPad')) { platform = "iPad Tablet"; iconName = "tablet"; }
            else if (devId.includes('macOS')) { platform = "macOS Computer"; iconName = "laptop"; }
            else if (devId.includes('Windows')) { platform = "Windows PC"; iconName = "monitor"; }

            const item = document.createElement('div');
            item.className = "device-item";
            item.innerHTML = `
            <div class="device-item-info">
                <p class="device-item-name">
                    <i data-lucide="${iconName}" class="icon-xs text-accent"></i>
                    <span>${platform}</span>
                </p>
                <p class="device-item-id truncate">${escapeHTML(devId)}</p>
            </div>
            <button onclick="revokeStudentDevice('${escapeJS(currentManagingEmail)}', '${escapeJS(devId)}')" class="btn-danger-outline btn-sm">
                Logout
            </button>
        `;
            container.appendChild(item);
        });
        lucide.createIcons();
    }

    // fully working
    // BAGONG SEMANTICS: sinasara nito ang LAHAT ng session ng estudyante, hindi
    // lang ang isang device. Ito lang ang paraan para talagang mamatay ang mga
    // access token na naipamahagi na -- ang dating pag-edit lang sa
    // active_devices array ay pampalamuti: nananatiling gumagana ang session ng
    // estudyante hanggang sa mag-expire ito nang kusa (hanggang isang oras).
    async function revokeStudentDevice(email, deviceId) {
        showCustomConfirm(
            "Log Out Student",
            `Sign ${email} out of ALL devices? Kakailanganin nilang mag-log in ulit.`,
            async () => {
                const { error } = await sb.rpc('admin_revoke_sessions', { p_email: email });
                if (error) return showCustomAlert("Revoke Failed", error.message, "error");

                showCustomAlert("Success", "Student signed out of all devices.", "success");
                renderDeviceList([]);
                loadStudents();
            }
        );
    }

    // Pigilan ang magkakapatong na tawag: ang pag-register ng device ay
    // gumagawa ng UPDATE sa profiles table, na nagpapa-trigger ulit ng
    // realtime event pabalik dito (setupRealtimeSubscriptions). Kung tatakbo
    // nang sabay-sabay ang dalawang tawag, pwedeng magbasa sila ng parehong
    // "lumang" active_devices bago pa magcommit ang isa't isa (race condition).
    let isRegisteringAdminDevice = false;

    // fully working
    async function loadAdminDeviceSettings(email) {
        if (isRegisteringAdminDevice) return;

        const { data, error } = await sb.from('profiles').select('max_devices, active_devices').eq('email', email).maybeSingle();
        if (error) {
            console.error('loadAdminDeviceSettings: failed to read profile', error);
            return;
        }
        if (!data) return;

        const limitInput = document.getElementById('admin-device-limit-input');
        const currentLimit = data.max_devices || 1;
        if (limitInput) limitInput.value = currentLimit;

        let activeDevices = data.active_devices || [];
        const currentDeviceId = getOrCreateDeviceId();

        if (!activeDevices.includes(currentDeviceId)) {
            // Ang huling read-then-write sa device path. Ang
            // `isRegisteringAdminDevice` na flag ay in-page lang -- wala itong
            // nakikitang ibang tab, ibang PC, o ang login ng estudyante mismo,
            // kaya hindi ito tunay na proteksyon laban sa race.
            //
            // Ang claim_device() ay gumagamit ng SELECT ... FOR UPDATE, at ito
            // rin ang nagpapatupad ng limit sa server -- kaya iisa na lang ang
            // desisyon, hindi dalawang magkahiwalay na kopya ng parehong tuntunin.
            isRegisteringAdminDevice = true;
            try {
                const { data: claimed, error: claimError } = await sb.rpc('claim_device', {
                    p_device_id: currentDeviceId
                });

                if (claimError) {
                    console.error('loadAdminDeviceSettings: claim_device failed', claimError);
                } else if (claimed && claimed.allowed === false) {
                    showDeviceLimitModal(claimed.devices || activeDevices, email);
                    return;
                } else if (claimed && claimed.devices) {
                    activeDevices = claimed.devices;
                }
            } finally {
                isRegisteringAdminDevice = false;
            }
        }
        renderAdminDeviceList(activeDevices);
    }

    // Shows a forced modal when the admin's device limit is reached.
    // The admin must revoke an older session to free up a slot — no dismiss without action.
    function showDeviceLimitModal(activeDevices, email) {
        const currentDeviceId = localStorage.getItem('pia_device_id');
        const modal = document.getElementById('device-limit-modal');
        const list = document.getElementById('device-limit-list');
        if (!modal || !list) return;

        list.innerHTML = '';

        activeDevices.forEach((devId) => {
            let platform = "Unknown Device";
            let iconName = "monitor";
            if (devId.includes('Android')) { platform = "Android Smartphone"; iconName = "smartphone"; }
            else if (devId.includes('iOS')) { platform = "iOS Device"; iconName = "smartphone"; }
            else if (devId.includes('iPad')) { platform = "iPad Tablet"; iconName = "tablet"; }
            else if (devId.includes('macOS')) { platform = "macOS Computer"; iconName = "laptop"; }
            else if (devId.includes('Windows')) { platform = "Windows PC"; iconName = "monitor"; }

            const isCurrentDevice = (devId === currentDeviceId);
            const badgeHTML = isCurrentDevice ? `<span class="badge badge-neutral">This Device</span>` : '';

            const item = document.createElement('div');
            item.className = "device-item";
            item.innerHTML = `
            <div class="device-item-info">
                <p class="device-item-name">
                    <i data-lucide="${iconName}" class="icon-xs text-accent"></i>
                    <span>${platform}</span>
                    ${badgeHTML}
                </p>
                <p class="device-item-id truncate">${escapeHTML(devId)}</p>
            </div>
            <button onclick="revokeDeviceFromLimitModal('${escapeJS(devId)}', '${escapeJS(email)}')" class="btn-danger-outline btn-sm">
                Revoke
            </button>
        `;
            list.appendChild(item);
        });

        lucide.createIcons();
        openModal('device-limit-modal');
    }

    // Revokes a device from the device-limit modal, then re-registers the current device and continues loading.
    async function revokeDeviceFromLimitModal(deviceId, email) {
        // Dalawang atomic na hakbang sa halip na isang read-filter-write:
        // (1) palayain ang slot, (2) angkinin ito para sa device na ito.
        // Ang dating bersyon ay nagsusulat ng buong array nang minsanan, kaya
        // ang kahit anong login na nangyari sa pagitan ng read at write ay
        // tahimik na nabubura.
        const { error: revokeError } = await sb.rpc('admin_revoke_device', {
            p_email: email, p_device_id: deviceId
        });
        if (revokeError) return showCustomAlert("Error", revokeError.message, "error");

        const currentDeviceId = getOrCreateDeviceId();
        let updated = [];

        if (deviceId !== currentDeviceId) {
            const { data: claimed, error: claimError } = await sb.rpc('claim_device', {
                p_device_id: currentDeviceId
            });
            if (claimError) return showCustomAlert("Error", claimError.message, "error");
            updated = (claimed && claimed.devices) || [];
        } else {
            const { data: after } = await sb.from('profiles')
                .select('active_devices').eq('email', email).maybeSingle();
            updated = (after && after.active_devices) || [];
        }

        closeModal('device-limit-modal');
        showCustomAlert("Device Revoked", "The session was revoked and this device is now registered.", "success");
        renderAdminDeviceList(updated);

        // If the admin revoked their own current device, sign them out
        if (localStorage.getItem('pia_device_id') === deviceId) {
            await handleAdminSignOut();
        }
    }

    // fully working
    function toggleEditAdminLimit() {
        const input = document.getElementById('admin-device-limit-input');
        input.disabled = false;
        input.classList.remove('opacity-50');
        input.focus();
        document.getElementById('edit-admin-limit-btn').style.display = 'none';
        document.getElementById('save-admin-limit-btn').style.display = 'inline-block';
    }

    // fully working
    async function saveAdminDeviceLimit() {
        const input = document.getElementById('admin-device-limit-input');
        const newLimit = parseInt(input.value) || 1;

        const { error } = await sb.from('profiles').update({ max_devices: newLimit }).eq('email', currentAdminEmail);
        if (error) return showCustomAlert("Update Failed", friendlyDbError(error, "Could not update the device limit."), "error");

        input.disabled = true;
        input.classList.add('opacity-50');
        document.getElementById('edit-admin-limit-btn').style.display = 'inline-block';
        document.getElementById('save-admin-limit-btn').style.display = 'none';
        showCustomAlert("Settings Updated", "Admin device limit updated successfully!", "success");
    }

    // fully working
    function renderAdminDeviceList(devices) {
        const container = document.getElementById('admin-active-devices-list');
        if (!container) return;
        container.innerHTML = '';

        if (!devices || devices.length === 0) {
            container.innerHTML = `<p class="empty-row">No active devices found.</p>`;
            return;
        }

        const currentDeviceId = localStorage.getItem('pia_device_id');

        devices.forEach((devId) => {
            let platform = "Unknown Device";
            let iconName = "monitor";
            if (devId.includes('Android')) { platform = "Android Smartphone"; iconName = "smartphone"; }
            else if (devId.includes('iOS')) { platform = "iOS Device"; iconName = "smartphone"; }
            else if (devId.includes('iPad')) { platform = "iPad Tablet"; iconName = "tablet"; }
            else if (devId.includes('macOS')) { platform = "macOS Computer"; iconName = "laptop"; }
            else if (devId.includes('Windows')) { platform = "Windows PC"; iconName = "monitor"; }

            const isCurrentDevice = (devId === currentDeviceId);
            const badgeHTML = isCurrentDevice ? `<span class="badge badge-neutral">This Device</span>` : '';

            const item = document.createElement('div');
            item.className = "device-item";
            item.innerHTML = `
            <div class="device-item-info">
                <p class="device-item-name">
                    <i data-lucide="${iconName}" class="icon-xs text-accent"></i>
                    <span>${platform}</span>
                    ${badgeHTML}
                </p>
                <p class="device-item-id truncate">${escapeHTML(devId)}</p>
            </div>
            <button onclick="revokeAdminDevice('${escapeJS(devId)}')" class="btn-danger-outline btn-sm">
                Logout
            </button>
        `;
            container.appendChild(item);
        });
        lucide.createIcons();
    }

    // fully working
    async function revokeAdminDevice(deviceId) {
        showCustomConfirm("Logout Device", `Are you sure you want to log out this admin device session?`, async () => {
            // Atomic na ngayon: dating read-filter-write, na tahimik na
            // nagpapawalang-bisa sa isang login na nangyari sa pagitan.
            const { data, error } = await sb.rpc('admin_revoke_device', {
                p_email: currentAdminEmail, p_device_id: deviceId
            });
            if (error) return showCustomAlert("Revoke Failed", error.message, "error");

            const updated = (data && data.devices) || [];
            showCustomAlert("Success", "Admin device logged out.", "success");
            renderAdminDeviceList(updated);

            if (localStorage.getItem('pia_device_id') === deviceId) {
                await handleAdminSignOut();
            }
        });
    }

    // fully working
    async function deleteUserFromMenu(email, table) {
        showCustomConfirm("Critical Warning", `Completely delete ${email}?`, async () => {
            let error = null;
            if (table === 'profiles' || table === 'professors') {
                const { error: rpcError } = await sb.rpc('admin_delete_user', { target_email: email });
                error = rpcError;
            } else {
                const { error: dbError } = await sb.from(table).delete().eq('email', email);
                error = dbError;
            }

            if (error) return showCustomAlert("Deletion Failed", error.message, "error");
            if (table === 'profiles') loadStudents();
            if (table === 'professors') loadProfessors();
            showCustomAlert("Success", "User deleted successfully.", "success");
        });
    }


    // ==========================================
    // 10. SYSTEM CONTROLS & STAGE SETTINGS
    // ==========================================

    // fully working
    // NOTE: 'global_password' ay tinanggal na mula sa settings table (security fix --
    // dating readable ito ng kahit sino via ang public anon key dahil parehong
    // table ang binabasa pre-login para sa stage_ocean/stage_char/stage_dash flags).
    // Random na password na per-student na ang ginagamit ngayon (generateSecurePassword()),
    // kaya wala nang password value na kailangang i-load dito.
    async function loadSettings() {
        const { data } = await sb.from('settings').select('*');
        if (!data) return;

        data.forEach(item => {
            if (item.key && item.key.startsWith('stage_')) {
                const stageKey = item.key.replace('stage_', '');
                const checkbox = document.getElementById(`toggle-${stageKey}`);
                const lbl = document.getElementById(`${stageKey}-status-lbl`);
                if (checkbox && lbl) {
                    checkbox.checked = item.value === true || item.value === 'true';
                    lbl.textContent = checkbox.checked ? "Open" : "Closed";
                    lbl.className = checkbox.checked ? "stage-status-lbl open" : "stage-status-lbl";
                }
            }
        });
    }

    // fully working
    async function updateStageControl(stage, checkbox) {
        const isOpen = checkbox.checked;
        const lbl = document.getElementById(`${stage}-status-lbl`);
        lbl.textContent = isOpen ? "Open" : "Closed";
        lbl.className = isOpen ? "stage-status-lbl open" : "stage-status-lbl";

        // Dating direktang `settings` upsert. Ang problema: ang pagsasara ng
        // stage ay HINDI nagpapaalis ng mga nakapasok na -- dahil ang sarili
        // nilang current_stage ang nagsisilbing targeted grant, tuloy-tuloy pa
        // rin silang nakakapasok sa pamamagitan ng direktang URL. Ang RPC ang
        // nagbabalik sa kanila sa Waiting Room kasabay ng pagsasara.
        const { data, error } = await sb.rpc('admin_set_stage_open', {
            p_stage: stage,
            p_open: isOpen
        });

        if (error) {
            checkbox.checked = !isOpen;
            lbl.textContent = !isOpen ? "Open" : "Closed";
            lbl.className = !isOpen ? "stage-status-lbl open" : "stage-status-lbl";
            return showCustomAlert("Stage Control Error", error.message, "error");
        }

        if (!isOpen && data && data.evicted > 0) {
            showCustomAlert("Stage Closed", `${data.evicted} student(s) were returned to the Waiting Room.`, "info");
        }
    }

    // fully working
    function openTargetedModal(stage, targetMode) {
        document.getElementById('target-stage-key').value = stage;
        document.getElementById('target-mode').value = targetMode;

        if (targetMode === 'section') {
            document.getElementById('target-section-container').classList.remove('hidden');
            document.getElementById('target-student-container').classList.add('hidden');
        } else {
            document.getElementById('target-section-container').classList.add('hidden');
            document.getElementById('target-student-container').classList.remove('hidden');

            document.getElementById('target-student-search').value = '';
            document.getElementById('target-student-email-selected').value = '';
            document.getElementById('selected-target-student-lbl').textContent = 'No student selected';
            document.getElementById('selected-target-student-lbl').className = 'target-selected-lbl';
            filterTargetStudents();
        }

        document.getElementById('grant-access-btn').disabled = false;
        document.getElementById('grant-access-btn').classList.remove('opacity-50', 'cursor-not-allowed');

        openModal('targeted-modal');
    }

    // fully working
    // DALAWANG BUG DITO DATI:
    //
    // (1) Ang hinahanap ay `studentDataCache` -- ang KASALUKUYANG PAHINA lang
    //     ng roster (50 row), at sinasalamin pa nito ang aktibong group/stage
    //     filter. Sa 76 na estudyante, ang nasa page 2 ay HINDI kayang i-target
    //     kahit kailan, at kapag may drilldown na aktibo ay iilan lang ang
    //     makikita. Direktang query na sa DB ngayon -- hiwalay sa roster.
    //
    // (2) `s.full_name.toLowerCase()` ay pumuputok kapag NULL ang full_name,
    //     at kasama ang buong listahan sa pagkabigo.
    let targetSearchTimer = null;

    function filterTargetStudents() {
        clearTimeout(targetSearchTimer);
        targetSearchTimer = setTimeout(runTargetStudentSearch, 250);
    }

    async function runTargetStudentSearch() {
        const listContainer = document.getElementById('target-student-list');
        if (!listContainer) return;

        const raw = (document.getElementById('target-student-search').value || '').trim();
        // Ang koma at parentheses ang mga delimiter ng PostgREST .or() filter --
        // kung hindi aalisin, sisira sila ng query o magpapalabas ng 400.
        const query = raw.replace(/[,()]/g, ' ').trim();

        listContainer.innerHTML = '<p class="empty-row">Searching...</p>';

        let q = sb.from('profiles')
            .select('full_name, email, section')
            .neq('role', 'admin')
            .order('full_name', { ascending: true })
            .limit(50);

        if (query) q = q.or(`full_name.ilike.%${query}%,email.ilike.%${query}%`);

        const { data, error } = await q;

        if (error) {
            listContainer.innerHTML = `<p class="empty-row">Search failed: ${escapeHTML(error.message)}</p>`;
            return;
        }

        listContainer.innerHTML = '';

        if (!data || data.length === 0) {
            listContainer.innerHTML = '<p class="empty-row">No student found.</p>';
            return;
        }

        data.forEach(student => {
            const item = document.createElement('div');
            item.className = 'target-student-item';

            item.onclick = () => {
                document.getElementById('target-student-email-selected').value = student.email;
                document.getElementById('selected-target-student-lbl').textContent =
                    student.full_name || student.email;
                document.getElementById('selected-target-student-lbl').className = 'target-selected-lbl selected';
            };

            item.innerHTML = `
            <div class="truncate">
                <p class="target-student-item-name truncate">${escapeHTML(student.full_name || '(no name)')}</p>
                <p class="cell-mono-xs truncate">${escapeHTML(student.email)}</p>
            </div>
        `;
            listContainer.appendChild(item);
        });
    }

    // fully working
    // Dati, current_stage lang ang isinusulat nito. Pero sinusuri rin ng route
    // guard (canEnterStage) ang is_ocean_done at selected_character, kaya ang
    // grant ay agad na binabawi: ibinabalik ng guard ang estudyante sa waiting
    // room, at ino-overwrite ng waiting room ang current_stage pabalik sa
    // "Waiting Room" -- habang nakikita mo namang "success" ang toast.
    //
    // Ang RPC na ngayon ang nagre-reset ng TAMANG prerequisite flag bawat
    // stage, at nag-uulat kung sino ang hindi kayang bigyan (hal. hindi pa
    // tapos ang OCEAN test) sa halip na tahimik na palitan ang datos nila.
    async function executeTargetedOpen() {
        const stageKey = document.getElementById('target-stage-key').value;
        const mode = document.getElementById('target-mode').value;
        const btn = document.getElementById('grant-access-btn');

        const args = { p_stage: stageKey, p_emails: null, p_section: null };

        if (mode === 'section') {
            const section = document.getElementById('target-section-select').value;
            // Dating walang check dito: ang blangkong section ay nagre-resulta
            // sa .eq('section', '') na tumatama sa lahat ng walang section.
            if (!section) return showCustomAlert("Validation Error", "Please select a section first.", "error");
            args.p_section = section;
        } else {
            const email = document.getElementById('target-student-email-selected').value;
            if (!email) return showCustomAlert("Validation Error", "Please select a student first.", "error");
            args.p_emails = [email];
        }

        btn.disabled = true;
        btn.innerHTML = 'Processing...';

        const { data, error } = await sb.rpc('admin_grant_stage', args);

        btn.disabled = false;
        btn.innerHTML = 'Grant Access';

        if (error) return showCustomAlert("Error", error.message, "error");

        const granted = (data && data.granted) || [];
        const skipped = (data && data.skipped) || [];

        closeModal('targeted-modal');
        loadStudents();
        updateStageCounters();

        if (skipped.length === 0) {
            showCustomAlert("Access Granted", `${granted.length} student(s) moved to ${stageKey.toUpperCase()}.`, "success");
            return;
        }

        const lines = skipped.slice(0, 5).map(s => `• ${s.email}: ${s.reason}`).join('\n');
        const more = skipped.length > 5 ? `\n…at ${skipped.length - 5} pa.` : '';
        showCustomAlert(
            granted.length ? "Partially Granted" : "Nothing Granted",
            `Granted: ${granted.length}\nSkipped: ${skipped.length}\n\n${lines}${more}`,
            granted.length ? "info" : "error"
        );
    }


    // ==========================================
    // 11. ADMIN ACCOUNT & SUPER ADMIN LOGIC
    // ==========================================

    // fully working
    async function initAdminProfile(email) {
        try {
            let name = "Admin";
            if (email) {
                name = email.split('@')[0];
                if (typeof sb !== 'undefined') {
                    const { data: profile } = await sb.from('profiles').select('full_name').eq('email', email).maybeSingle();
                    if (profile && profile.full_name) {
                        name = profile.full_name.trim().split(' ')[0];
                    }
                }
            }

            const hour = new Date().getHours();
            let greeting = "Good evening";
            if (hour >= 0 && hour < 12) greeting = "Good morning";
            else if (hour >= 12 && hour < 18) greeting = "Good afternoon";

            const desktopEmailEl = document.getElementById('desktop-admin-email');
            const desktopGreetingEl = document.getElementById('desktop-admin-greeting');
            const mobileEmailEl = document.getElementById('mobile-admin-email');
            const prefixEl = document.getElementById('mobile-greeting-prefix');
            const nameEl = document.getElementById('mobile-greeting-name');

            if (desktopEmailEl) desktopEmailEl.textContent = email || "admin@ue.edu.ph";
            if (desktopGreetingEl) desktopGreetingEl.textContent = `${greeting}, ${name}`;
            if (mobileEmailEl) mobileEmailEl.textContent = email || "admin@ue.edu.ph";
            if (prefixEl) prefixEl.textContent = `${greeting},`;
            if (nameEl) nameEl.textContent = name;

        } catch (error) {
            console.error("Profile Fetch Error:", error);
        }
    }

    // fully working
    async function handleAdminPasswordUpdate(event) {
        event.preventDefault();
        const newPass = document.getElementById('admin-new-password').value;
        const confirmPass = document.getElementById('admin-confirm-password').value;

        if (newPass !== confirmPass) {
            return showCustomAlert("Error", "Passwords do not match.", "error");
        }

        const { error } = await sb.auth.updateUser({ password: newPass });
        if (error) {
            showCustomAlert("Update Failed", error.message, "error");
        } else {
            showCustomAlert("Success", "Admin password updated successfully.", "success");
            document.getElementById('admin-password-form').reset();
        }
    }

    // Security fix: hindi na admin ang nagse-set ng known password (na dating
    // nire-reuse mula sa isang public-readable setting). Sa halip, magpapadala
    // ng self-service reset email kung saan ang estudyante/professor mismo ang
    // magtatakda ng bago at sarili nilang password.
    async function resetPasswordFromMenu(email) {
        showCustomConfirm("Reset Password", `Send a password-reset email to ${email}? They'll set their own new password via the link.`, async () => {
            const { error } = await sb.auth.resetPasswordForEmail(email, {
                redirectTo: new URL('../../assets/html/sign-up.html', window.location.href).href
            });
            if (error) return showCustomAlert("Reset Failed", error.message, "error");
            showCustomAlert("Success", `Password-reset email sent to ${email}.`, "success");
        });
    }

    // fully working
    async function handleAdminSignOut() {
        // Ang shared helper ang humahawak ng device release + GLOBAL signOut
        // (pinapatay ang refresh tokens sa server, hindi lang ang lokal na
        // kopya) + storage cleanup. Dati, local-scope signOut lang ito.
        await executeForceLogout();
    }


    // ==========================================
    // 12. EMAIL BROADCAST TOOLS
    // ==========================================

    // fully working
    async function sendActivationEmail(email) {
        showCustomConfirm("Send Email", `Trigger activation link to ${email}?`, async () => {
            const btn = document.getElementById('confirm-yes-btn');
            if (btn) { btn.disabled = true; btn.textContent = 'SENDING...'; }

            // Palitan ang '/index.html' papunta sa '/assets/html/sign-up.html'
            const redirectPath = new URL('../../assets/html/sign-up.html', window.location.href).href;
            const { error } = await sb.auth.signInWithOtp({
                email: email,
                options: { shouldCreateUser: false, emailRedirectTo: redirectPath }
            });

            if (error) {
                if (btn) { btn.disabled = false; btn.textContent = 'PROCEED'; }
                return showCustomAlert("Error", error.message, "error");
            }
            showCustomAlert("Email Sent", `Activation link successfully sent to ${email}.`, "success");
        });
    }

    // fully working
    async function sendSectionEmails(sectionName) {
        showCustomConfirm("Broadcast Section", `Send activation emails to all inactive students in section ${sectionName}?`, async () => {
            const btn = document.getElementById('confirm-yes-btn');
            btn.disabled = true;
            btn.textContent = 'Sending...';

            const { data: students } = await sb.from('profiles').select('email').eq('section', sectionName).eq('status', 'inactive');
            if (!students || students.length === 0) {
                btn.disabled = false;
                btn.textContent = 'Proceed';
                return showCustomAlert("Notice", "No inactive students found in this section.", "info");
            }

            // Palitan ang '/index.html' papunta sa '/assets/html/sign-up.html'
            const redirectPath = new URL('../../assets/html/sign-up.html', window.location.href).href;
            let successCount = 0;

            for (const student of students) {
                const { error: mailError } = await sb.auth.signInWithOtp({
                    email: student.email,
                    options: { shouldCreateUser: false, emailRedirectTo: redirectPath }
                });
                if (!mailError) successCount++;
                await new Promise(r => setTimeout(r, 1500));
            }
            showCustomAlert("Broadcast Complete", `Successfully sent activation emails to ${successCount} student(s) in section ${sectionName}.`, "success");
        });
    }

    // Export functions to global scope for HTML inline handlers
    Object.assign(global, {
        switchTab, toggleMobileMenu, handleAdminSignOut, openModal, closeModal,
        toggleStageDrilldown, clearStageDrilldown, setGroupFilter, setSubgroupFilter,
        openTargetedModal, executeTargetedOpen,
        toggleEditAdminLimit, saveAdminDeviceLimit, closeStudentProfile, toggleAvatarVisibility,
        closeProfessorProfile, revokeAdminDevice, deleteUserFromMenu,
        sendActivationEmail, sendSectionEmails, resetPasswordFromMenu,
        debouncedSearchStudents,
        openEditStudent, openDeviceManager, allowStudentRetakeOcean, allowStudentRetakeCharacter,
        openProfessorProfile, openSectionDetails, filterProfessors,
        previousStudentPage, nextStudentPage,
        showCustomAlert, handleAdminPasswordUpdate,
        handleRegisterStudent, handleUpdateStudent, handleRegisterProfessor, toggleActionMenu,
        openStudentProfile, saveBatchScores, showCustomConfirm,
        saveNewSection, updateStageControl, openScoresModal,
        openScoresModalFromDetails, filterTargetStudents, revokeStudentDevice,
        revokeDeviceFromLimitModal, closeCustomAlert, closeCustomConfirm
    });

})(window);