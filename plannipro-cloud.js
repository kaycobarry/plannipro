/* PlanniPro Cloud — authentification, droits et synchronisation local-first. */
(function () {
  'use strict';

  const CONFIG = window.PLANNIPRO_SUPABASE_CONFIG;
  const CLOUD_DB = 'plannipro-secure-cache';
  const CLOUD_DB_VERSION = 1;
  const EMPTY_ARRAY = Object.freeze([]);
  const NAV_PERMISSIONS = {
    planning: ['planning', 'view'],
    employees: ['employees', 'view'],
    timesheet: ['timesheets', 'view'],
    pointage: ['pointage', 'view'],
    hr: ['leaves', 'view'],
    vault: ['documents', 'view'],
    registre: ['register', 'view'],
    erp: ['financial', 'view'],
    analytics: ['dashboard', 'view'],
    rapport: ['reports', 'view'],
    settings: ['settings', 'view'],
    users: ['users', 'view']
  };
  const BUTTON_PERMISSIONS = {
    'openShiftModal(null,null)': ['planning', 'create'],
    'openDupModal()': ['planning', 'copy'],
    'openEmpModal()': ['employees', 'create'],
    'openManagerModal()': ['employees', 'create'],
    'openAbsModal()': ['leaves', 'request'],
    'openRegModal()': ['register', 'manage'],
    'syncAllEmployeesToRegister()': ['register', 'manage'],
    'exportRegCSV()': ['register', 'export'],
    'openErpModal()': ['financial', 'create'],
    'openSiteModal()': ['establishments', 'create'],
    'openTimeClockApp()': ['pointage', 'edit_schedule'],
    'exportCSV()': ['planning', 'export'],
    'exportPDF()': ['planning', 'export'],
    'printWeeklyPlanning()': ['planning', 'print']
  };
  const RECORD_MODULES = {
    shift: 'planning', absence: 'leaves', punch: 'pointage',
    timesheet: 'timesheets', register: 'register', erp: 'financial',
    setting: 'settings', report: 'reports', notification: 'dashboard'
  };
  const TIME_CLOCK_LEGACY_PREFIX = 'time-clock:';
  const DEPRECATED_PERMISSIONS = new Set(['pointage.manage_settings', 'users.manage_users']);
  // Only scheduling metadata is replicated in the broadly readable employee
  // row.  Every other legacy field is treated as RH-private by default.  A
  // whitelist is safer than trying to maintain an ever-growing blacklist of
  // salary, identity, contract and personal-contact field names.
  const PUBLIC_EMPLOYEE_FIELDS = new Set([
    'name', 'role', 'site', 'team', 'teamId', 'service', 'serviceId', 'color',
    'planningColor', 'archived'
  ]);

  const App = {
    client: null,
    session: null,
    user: null,
    contexts: EMPTY_ARRAY,
    context: null,
    online: navigator.onLine,
    applyingRemote: false,
    syncing: false,
    localChangeRevision: 0,
    syncTimer: null,
    initialized: false,
    cacheKey: null,
    remoteReady: false,
    lastError: null,
    realtimeChannel: null,
    usePrivateCache: () => Boolean(App.session && App.context),
    can(module, action = 'view') {
      if (!App.context || !Array.isArray(App.context.permissions)) return false;
      const key = `${module}.${action}`;
      const permission = App.context.permissions.find((item) => item && item.key === key);
      return Boolean(permission && permission.allowed);
    },
    require(module, action = 'view', message) {
      if (App.can(module, action)) return true;
      safeToast(message || 'Cette action n’est pas autorisée pour votre profil.', 'err');
      return false;
    },
    status(label, kind = 'idle') {
      const node = document.querySelector('[data-pp-sync-status]');
      if (node) {
        node.textContent = label;
        node.dataset.kind = kind;
        node.title = label;
      }
    }
  };
  window.PlanniProCloud = App;

  function safeToast(message, type) {
    if (typeof window.toast === 'function') window.toast(message, type || 'info');
    else console.info('[PlanniPro]', message);
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>'"]/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[char]));
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  let queueSequence = 0;

  function makeQueueEntry(reason, state) {
    queueSequence += 1;
    const randomPart = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);
    return {
      generation: `${Date.now()}-${queueSequence}-${randomPart}`,
      reason,
      state,
      queuedAt: new Date().toISOString()
    };
  }

  function queueGeneration(entry) {
    return entry?.generation || entry?.queuedAt || null;
  }

  function appUrl() {
    return new URL('.', window.location.href).href.replace(/\/$/, '');
  }

  function getInviteToken() {
    try { return new URL(window.location.href).searchParams.get('invite'); }
    catch (_) { return null; }
  }

  function clearInviteToken() {
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete('invite');
      window.history.replaceState({}, '', url);
    } catch (_) { /* no-op */ }
  }

  function openCloudDatabase() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error('IndexedDB indisponible'));
      const request = window.indexedDB.open(CLOUD_DB, CLOUD_DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        ['auth', 'kv', 'queue', 'backups'].forEach((name) => {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'key' });
        });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Ouverture IndexedDB impossible'));
    });
  }

  async function dbGet(store, key) {
    const db = await openCloudDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction(store, 'readonly');
        const request = transaction.objectStore(store).get(key);
        request.onsuccess = () => resolve(request.result ? request.result.value : null);
        request.onerror = () => reject(request.error || new Error('Lecture IndexedDB impossible'));
      });
    } finally { db.close(); }
  }

  async function dbPut(store, key, value) {
    const db = await openCloudDatabase();
    try {
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(store, 'readwrite');
        transaction.objectStore(store).put({ key, value, updatedAt: new Date().toISOString() });
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error('Écriture IndexedDB impossible'));
        transaction.onabort = () => reject(transaction.error || new Error('Écriture IndexedDB annulée'));
      });
    } finally { db.close(); }
  }

  async function dbPutStateAndQueue(cacheKey, cacheValue, pendingKey, pendingValue) {
    const db = await openCloudDatabase();
    try {
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(['kv', 'queue'], 'readwrite');
        const updatedAt = new Date().toISOString();
        transaction.objectStore('kv').put({ key: cacheKey, value: cacheValue, updatedAt });
        transaction.objectStore('queue').put({ key: pendingKey, value: pendingValue, updatedAt });
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error('Écriture IndexedDB impossible'));
        transaction.onabort = () => reject(transaction.error || new Error('Écriture IndexedDB annulée'));
      });
    } finally { db.close(); }
  }

  async function dbDelete(store, key) {
    const db = await openCloudDatabase();
    try {
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(store, 'readwrite');
        transaction.objectStore(store).delete(key);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error('Suppression IndexedDB impossible'));
      });
    } finally { db.close(); }
  }

  async function dbDeleteIfUnchanged(store, key, expectedGeneration) {
    const db = await openCloudDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction(store, 'readwrite');
        const objectStore = transaction.objectStore(store);
        const request = objectStore.get(key);
        let deleted = false;
        request.onsuccess = () => {
          const current = request.result ? request.result.value : null;
          if (queueGeneration(current) === expectedGeneration) {
            objectStore.delete(key);
            deleted = true;
          }
        };
        request.onerror = () => reject(request.error || new Error('Lecture IndexedDB impossible'));
        transaction.oncomplete = () => resolve(deleted);
        transaction.onerror = () => reject(transaction.error || new Error('Suppression IndexedDB impossible'));
        transaction.onabort = () => reject(transaction.error || new Error('Suppression IndexedDB annulée'));
      });
    } finally { db.close(); }
  }

  const indexedDbAuthStorage = {
    getItem: (key) => dbGet('auth', key),
    setItem: (key, value) => dbPut('auth', key, value),
    removeItem: (key) => dbDelete('auth', key)
  };

  function installStyle() {
    if (document.getElementById('pp-cloud-style')) return;
    const style = document.createElement('style');
    style.id = 'pp-cloud-style';
    style.textContent = `
      #pp-auth-gate{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;padding:22px;background:radial-gradient(circle at 10% 10%,#5065e8 0,transparent 31%),linear-gradient(135deg,#101936 0%,#1b2859 54%,#0b1023 100%);color:#14203b}
      #pp-auth-gate[hidden]{display:none!important}.pp-auth-card{width:min(460px,100%);max-height:calc(100dvh - 44px);overflow:auto;border-radius:24px;background:#fff;box-shadow:0 26px 75px rgba(2,7,27,.42);padding:28px}.pp-auth-brand{display:flex;align-items:center;gap:10px;font:800 23px/1 system-ui,sans-serif;color:#17224a;margin-bottom:7px}.pp-auth-brand b{color:#5165e8}.pp-auth-kicker{font-size:13px;color:#65708a;line-height:1.55;margin:0 0 22px}.pp-auth-form{display:grid;gap:13px}.pp-auth-form label{display:grid;gap:6px;font-size:12px;font-weight:760;color:#34415e}.pp-auth-form input,.pp-auth-form select{border:1px solid #d9dfec;border-radius:11px;padding:11px 12px;font:inherit;color:#14203b;background:#fff}.pp-auth-form input:focus,.pp-auth-form select:focus{outline:3px solid rgba(79,99,231,.18);border-color:#4f63e7}.pp-auth-submit{border:0;border-radius:11px;padding:12px 14px;background:#4f63e7;color:#fff;font:750 14px/1 system-ui,sans-serif;cursor:pointer}.pp-auth-submit:disabled{opacity:.6;cursor:wait}.pp-auth-links{display:flex;flex-wrap:wrap;gap:8px 14px;margin-top:18px}.pp-auth-link{border:0;padding:0;background:transparent;color:#4359df;cursor:pointer;font:650 12px/1.3 system-ui,sans-serif}.pp-auth-note{margin:0 0 15px;border-radius:10px;padding:10px 12px;background:#eef2ff;color:#2e3a82;font-size:12px;line-height:1.45}.pp-auth-note.err{background:#fff0f1;color:#a62937}.pp-account{position:relative;flex:0 0 auto}.pp-account-button{display:flex;align-items:center;gap:8px;border:1px solid var(--bd1,#dfe4ef);border-radius:12px;background:#fff;color:var(--tx1,#1f2940);padding:6px 8px;max-width:220px;cursor:pointer}.pp-account-avatar{width:29px;height:29px;border-radius:50%;display:grid;place-items:center;background:#4f63e7;color:#fff;font-size:11px;font-weight:800}.pp-account-lines{min-width:0;text-align:left}.pp-account-name,.pp-account-role{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.pp-account-name{font:750 11px/1.1 system-ui,sans-serif}.pp-account-role{font:600 10px/1.25 system-ui,sans-serif;color:#6b7590;margin-top:2px}.pp-account-menu{position:absolute;right:0;top:calc(100% + 8px);z-index:900;width:min(330px,calc(100vw - 24px));padding:12px;border:1px solid #e0e5ef;border-radius:14px;background:#fff;box-shadow:0 17px 35px rgba(16,26,58,.18);display:none}.pp-account.open .pp-account-menu{display:block}.pp-account-menu p{margin:0 0 8px;font-size:11px;color:#6b7590}.pp-account-menu select{width:100%;padding:8px;border:1px solid #dfe4ef;border-radius:8px;background:#fff}.pp-account-actions{display:grid;gap:6px;margin-top:11px}.pp-account-actions button{border:0;border-radius:8px;padding:8px 9px;text-align:left;background:#f4f6fa;color:#26314d;font:650 12px system-ui,sans-serif;cursor:pointer}.pp-account-actions button.danger{background:#fff0f1;color:#b1283a}.pp-action-disabled{opacity:.48!important;cursor:not-allowed!important}.pp-sync-status{display:inline-flex;align-items:center;gap:5px;font-size:10px;font-weight:700;color:#66718c}.pp-sync-status:before{content:'';width:7px;height:7px;border-radius:50%;background:#95a1bb}.pp-sync-status[data-kind="ok"]:before{background:#19a974}.pp-sync-status[data-kind="pending"]:before{background:#e69f19}.pp-sync-status[data-kind="error"]:before{background:#e34d5c}.pp-users-wrap{padding:20px;overflow:auto;min-height:0}.pp-users-head{display:flex;align-items:flex-start;justify-content:space-between;gap:15px;margin-bottom:18px}.pp-users-head h2{margin:0;font-size:22px}.pp-users-head p{margin:5px 0 0;color:#69738c;font-size:12px}.pp-users-card{border:1px solid #e0e5ef;border-radius:14px;background:#fff;overflow:hidden;margin-bottom:16px}.pp-users-card h3{margin:0;padding:14px 16px;border-bottom:1px solid #edf0f5;font-size:14px}.pp-users-table{width:100%;border-collapse:collapse;font-size:12px}.pp-users-table th,.pp-users-table td{padding:11px 14px;text-align:left;border-bottom:1px solid #edf0f5;vertical-align:middle}.pp-users-table th{font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:#78829a}.pp-users-table td:last-child{text-align:right}.pp-users-table button,.pp-users-card .btn{font:650 11px system-ui,sans-serif}.pp-users-status{display:inline-flex;padding:4px 7px;border-radius:99px;background:#edf2ff;color:#3a50bf;font-size:10px;font-weight:800}.pp-users-status.suspended,.pp-users-status.disabled{background:#fff0f1;color:#bf3143}.pp-users-status.invited{background:#fff8e7;color:#9b6908}.pp-dialog-backdrop{position:fixed;inset:0;z-index:10020;background:rgba(12,18,42,.46);display:grid;place-items:center;padding:18px}.pp-dialog{width:min(780px,100%);max-height:calc(100dvh - 36px);overflow:auto;border-radius:18px;background:#fff;padding:20px;box-shadow:0 20px 60px rgba(12,18,42,.28)}.pp-dialog h2{margin:0 0 6px;font-size:19px}.pp-dialog p{font-size:12px;color:#68738d;line-height:1.5}.pp-dialog-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:11px;margin:16px 0}.pp-dialog-grid label{display:grid;gap:5px;font-size:11px;font-weight:750;color:#43506d}.pp-dialog-grid input,.pp-dialog-grid select{padding:9px;border:1px solid #dce2ee;border-radius:8px}.pp-dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}.pp-permission-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px}.pp-permission-grid label{display:flex;align-items:center;gap:6px;padding:7px;border:1px solid #edf0f5;border-radius:8px;font-size:11px;font-weight:600}.pp-permission-grid input{accent-color:#4f63e7}@media(max-width:700px){.pp-account-lines{display:none}.pp-account-button{padding:5px}.pp-users-wrap{padding:12px}.pp-users-head{display:block}.pp-users-head .btn{margin-top:10px}.pp-users-table th:nth-child(3),.pp-users-table td:nth-child(3),.pp-users-table th:nth-child(4),.pp-users-table td:nth-child(4){display:none}.pp-dialog-grid,.pp-permission-grid{grid-template-columns:1fr}.pp-auth-card{padding:22px}}
    `;
    document.head.appendChild(style);
  }

  function mountGate() {
    if (document.getElementById('pp-auth-gate')) return;
    const gate = document.createElement('section');
    gate.id = 'pp-auth-gate';
    gate.setAttribute('aria-live', 'polite');
    document.body.appendChild(gate);
    document.addEventListener('click', handleUiClick);
    document.addEventListener('submit', handleUiSubmit);
  }

  function gate(message, isError) {
    const node = document.getElementById('pp-auth-gate');
    if (!node) return;
    node.hidden = false;
    node.innerHTML = `<div class="pp-auth-card"><div class="pp-auth-brand">Planni<b>Pro</b></div><p class="pp-auth-kicker">${escapeHtml(message || 'Préparation de votre espace sécurisé…')}</p>${isError ? '<p class="pp-auth-note err">' + escapeHtml(isError) + '</p>' : '<p class="pp-auth-note">Connexion sécurisée et synchronisation des données autorisées.</p>'}</div>`;
  }

  function hideGate() {
    const node = document.getElementById('pp-auth-gate');
    if (node) node.hidden = true;
  }

  function authForm(mode, message, error) {
    const node = document.getElementById('pp-auth-gate');
    if (!node) return;
    const isSignup = mode === 'signup';
    const isReset = mode === 'reset';
    const isUpdate = mode === 'update-password';
    const title = isSignup ? 'Créer un compte' : isReset ? 'Réinitialiser le mot de passe' : isUpdate ? 'Choisir un nouveau mot de passe' : 'Connexion à PlanniPro';
    const copy = isSignup ? 'Un compte seul ne donne accès à aucune entreprise : un salarié ou manager doit être invité par un gérant.' : isReset ? 'Nous vous enverrons un lien de récupération sécurisé.' : isUpdate ? 'Choisissez un mot de passe robuste pour protéger votre espace.' : 'Connectez-vous pour charger uniquement les données auxquelles votre profil a accès.';
    node.hidden = false;
    node.innerHTML = `<div class="pp-auth-card"><div class="pp-auth-brand">Planni<b>Pro</b></div><p class="pp-auth-kicker">${copy}</p>${message ? '<p class="pp-auth-note' + (error ? ' err' : '') + '">' + escapeHtml(message) + '</p>' : ''}<form class="pp-auth-form" id="pp-auth-form" data-mode="${mode}">${isSignup ? '<label>Nom complet<input name="full_name" autocomplete="name" required maxlength="120"></label>' : ''}${!isUpdate ? '<label>Adresse e-mail<input name="email" type="email" autocomplete="email" required></label>' : ''}${!isReset ? '<label>Mot de passe<input name="password" type="password" autocomplete="' + (isSignup || isUpdate ? 'new-password' : 'current-password') + '" minlength="8" required></label>' : ''}<button class="pp-auth-submit" type="submit">${isSignup ? 'Créer mon compte' : isReset ? 'Envoyer le lien' : isUpdate ? 'Mettre à jour le mot de passe' : 'Se connecter'}</button></form><div class="pp-auth-links">${!isUpdate && !isReset ? '<button class="pp-auth-link" data-pp-auth-mode="reset" type="button">Mot de passe oublié ?</button>' : ''}${!isUpdate && !isSignup ? '<button class="pp-auth-link" data-pp-auth-mode="signup" type="button">Créer un compte gérant</button>' : ''}${!isUpdate && !isReset ? '' : '<button class="pp-auth-link" data-pp-auth-mode="login" type="button">Retour à la connexion</button>'}</div></div>`;
    node.querySelector('input')?.focus();
  }

  function bootstrapForm(message, error) {
    const node = document.getElementById('pp-auth-gate');
    if (!node) return;
    const hasLocal = localStateHasContent();
    node.hidden = false;
    node.innerHTML = `<div class="pp-auth-card"><div class="pp-auth-brand">Bienvenue dans Planni<b>Pro</b></div><p class="pp-auth-kicker">Vous êtes le premier utilisateur de cet espace : votre compte deviendra automatiquement <strong>Gérant / Super administrateur</strong>.</p>${message ? '<p class="pp-auth-note' + (error ? ' err' : '') + '">' + escapeHtml(message) + '</p>' : ''}<form class="pp-auth-form" id="pp-bootstrap-form"><label>Nom de l’entreprise<input name="organization_name" required maxlength="120" placeholder="ex. Commerce Martin"></label><label>Premier établissement<input name="establishment_name" required maxlength="120" placeholder="ex. Nantes Charcot"></label><button class="pp-auth-submit" type="submit">${hasLocal ? 'Créer l’espace et importer mes données locales' : 'Créer mon espace sécurisé'}</button></form>${hasLocal ? '<p class="pp-auth-note">Une copie de sauvegarde de vos données actuelles sera conservée dans le cache privé IndexedDB du navigateur avant import. Les doublons sont évités avec les identifiants locaux existants.</p>' : ''}</div>`;
  }

  async function handleUiSubmit(event) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (form.id !== 'pp-auth-form' && form.id !== 'pp-bootstrap-form' && form.id !== 'pp-existing-import-form') return;
    event.preventDefault();
    const submit = form.querySelector('button[type="submit"]');
    if (submit) { submit.disabled = true; submit.textContent = 'Patientez…'; }
    const fields = new FormData(form);
    try {
      if (form.id === 'pp-bootstrap-form') {
        await bootstrapOrganization(String(fields.get('organization_name') || ''), String(fields.get('establishment_name') || ''));
      } else if (form.id === 'pp-existing-import-form') {
        await importExistingLocalState();
      } else {
        await submitAuth(form.dataset.mode || 'login', fields);
      }
    } catch (error) {
      const mode = form.dataset.mode || 'login';
      if (form.id === 'pp-bootstrap-form') bootstrapForm(error.message || 'Impossible de créer l’espace.', true);
      else if (form.id === 'pp-existing-import-form') existingImportForm(error.message || 'Import impossible.', true);
      else authForm(mode, error.message || 'Une erreur est survenue.', true);
    } finally {
      if (submit && document.body.contains(submit)) { submit.disabled = false; }
    }
  }

  async function submitAuth(mode, fields) {
    const email = String(fields.get('email') || '').trim().toLowerCase();
    const password = String(fields.get('password') || '');
    if (mode === 'login') {
      const { error } = await App.client.auth.signInWithPassword({ email, password });
      if (error) throw error;
      return;
    }
    if (mode === 'signup') {
      const { data, error } = await App.client.auth.signUp({
        email, password,
        options: { data: { full_name: String(fields.get('full_name') || '').trim() }, emailRedirectTo: appUrl() }
      });
      if (error) throw error;
      if (!data.session) authForm('login', 'Vérifiez votre e-mail puis revenez vous connecter.');
      return;
    }
    if (mode === 'reset') {
      const { error } = await App.client.auth.resetPasswordForEmail(email, { redirectTo: appUrl() });
      if (error) throw error;
      authForm('login', 'Le lien de réinitialisation a été envoyé si cette adresse possède un compte.');
      return;
    }
    if (mode === 'update-password') {
      const { error } = await App.client.auth.updateUser({ password });
      if (error) throw error;
      authForm('login', 'Mot de passe mis à jour. Vous pouvez vous reconnecter.');
    }
  }

  function handleUiClick(event) {
    const target = event.target instanceof Element ? event.target.closest('[data-pp-auth-mode], [data-pp-action]') : null;
    if (!target) return;
    if (target.dataset.ppAuthMode) {
      authForm(target.dataset.ppAuthMode);
      return;
    }
    const action = target.dataset.ppAction;
    if (action === 'account-toggle') target.closest('.pp-account')?.classList.toggle('open');
    if (action === 'logout') void logout();
    if (action === 'change-password') authForm('update-password');
    if (action === 'sync-now') void App.syncNow?.('manual');
    if (action === 'open-users') goAllowedView('users');
    if (action === 'self-service') void openSelfServiceDialog();
    if (action === 'continue-empty-workspace') { hideGate(); renderAccount(); applyPermissionsToUi(); }
    if (action === 'close-dialog') target.closest('.pp-dialog-backdrop')?.remove();
  }

  async function waitForLocalState() {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      if (typeof stateReady !== 'undefined' && stateReady) return;
      await new Promise((resolve) => setTimeout(resolve, 35));
    }
  }

  function localStateHasContent() {
    try {
      return Boolean((S.employees || []).length || (S.shifts || []).length || (S.absences || []).length || (S.registre || []).length || (S.erpEntries || []).length);
    } catch (_) { return false; }
  }

  async function archiveAndClearLegacyStorage() {
    let local = null;
    let session = null;
    try {
      local = window.localStorage.getItem('ppv3');
      session = window.sessionStorage.getItem('ppv3');
    } catch (_) { return false; }
    if (!local && !session) return false;
    await dbPut('backups', `legacy-raw:${App.user?.id || 'unknown'}:${Date.now()}`, {
      localStorage: local,
      sessionStorage: session,
      migratedAt: new Date().toISOString()
    });
    try {
      window.localStorage.removeItem('ppv3');
      window.sessionStorage.removeItem('ppv3');
    } catch (_) { /* storage can be disabled */ }
    return true;
  }

  async function refreshContext() {
    const { data, error } = await App.client.rpc('get_access_context');
    if (error) throw error;
    App.contexts = Array.isArray(data) ? data : [];
    if (!App.contexts.length) { App.context = null; return null; }
    const preference = await dbGet('kv', `active-org:${App.user.id}`);
    App.context = App.contexts.find((context) => context.organization_id === preference) || App.contexts[0];
    App.cacheKey = `state:${App.user.id}:${App.context.organization_id}`;
    return App.context;
  }

  let activationInFlight = null;
  let activationUserId = null;

  async function activateSession(session, eventName) {
    const userId = session?.user?.id || null;
    if (activationInFlight) {
      // Supabase emits INITIAL_SESSION and getSession() can resolve at nearly
      // the same time. Reuse the same activation so an invitation token is
      // never claimed twice. A genuinely different account is processed once
      // the previous activation has settled.
      if (activationUserId === userId && eventName !== 'PASSWORD_RECOVERY') return activationInFlight;
      try { await activationInFlight; } catch (_) { /* the next state still needs processing */ }
      return activateSession(session, eventName);
    }
    const work = activateSessionNow(session, eventName);
    activationInFlight = work;
    activationUserId = userId;
    try { return await work; }
    finally {
      if (activationInFlight === work) {
        activationInFlight = null;
        activationUserId = null;
      }
    }
  }

  async function activateSessionNow(session, eventName) {
    App.session = session;
    App.user = session?.user || null;
    if (!session) {
      App.context = null;
      App.contexts = EMPTY_ARRAY;
      App.remoteReady = false;
      authForm('login');
      return;
    }
    try {
      await waitForLocalState();
      if (eventName === 'PASSWORD_RECOVERY') { authForm('update-password'); return; }
      const invite = getInviteToken();
      if (invite) {
        const { error } = await App.client.rpc('claim_invitation', { p_token: invite });
        if (error) throw error;
        clearInviteToken();
        safeToast('Invitation acceptée : vos droits sont maintenant actifs.', 'ok');
      }
      const context = await refreshContext();
      if (!context) {
        // A suspended/disabled membership has no access context.  Do not offer
        // the first-owner bootstrap flow to an existing, revoked account.
        const { data: ownMemberships } = await App.client
          .from('organization_members')
          .select('status')
          .eq('user_id', App.user.id);
        const blocked = (ownMemberships || []).some((membership) =>
          ['invited', 'suspended', 'disabled', 'expired'].includes(membership.status)
        );
        if (blocked) {
          await App.client.auth.signOut({ scope: 'local' });
          authForm('login', 'Votre accès à PlanniPro n’est pas actif. Contactez votre gérant.', true);
          return;
        }
        bootstrapForm();
        return;
      }
      await App.client.rpc('touch_member_session');
      const restored = await App.restoreOrPull?.();
      if (restored?.needsImport) return;
      subscribeRealtime();
      App.remoteReady = true;
      hideGate();
      renderAccount();
      updateCloudMessaging();
      applyPermissionsToUi();
      window.dispatchEvent(new CustomEvent('plannipro:cloud-ready'));
      App.status(
        restored?.pending ? 'Synchronisation en attente' : (navigator.onLine ? 'Synchronisé' : 'Hors ligne'),
        restored?.pending || !navigator.onLine ? 'pending' : 'ok'
      );
    } catch (error) {
      console.error('PlanniPro Cloud context', error);
      authForm('login', error.message || 'Impossible de vérifier vos droits.', true);
    }
  }

  async function bootstrapOrganization(name, establishment) {
    const { data, error } = await App.client.rpc('bootstrap_organization', {
      p_name: name.trim(), p_establishment_name: establishment.trim()
    });
    if (error) throw error;
    await refreshContext();
    if (!App.context) throw new Error('L’espace a été créé mais les droits ne sont pas encore disponibles.');
    const hasLegacy = localStateHasContent();
    if (hasLegacy) await dbPut('backups', `legacy:${App.user.id}:${Date.now()}`, clone(S));
    else {
      App.applyingRemote = true;
      try {
        S = { ...S, employees: [], shifts: [], absences: [], punchLog: [], erpEntries: [], registre: [], sites: [] };
      } finally { App.applyingRemote = false; }
    }
    const firstSnapshot = snapshotState();
    const pendingKey = `pending:${App.user.id}:${App.context.organization_id}`;
    await dbPutStateAndQueue(
      App.cacheKey,
      { state: firstSnapshot, cachedRemote: true, savedAt: new Date().toISOString() },
      pendingKey,
      makeQueueEntry('first-import', firstSnapshot)
    );
    const synced = await App.syncNow?.('first-import');
    if (synced) {
      try { await archiveAndClearLegacyStorage(); }
      catch (backupError) { console.warn('Sauvegarde legacy à finaliser', backupError); }
    }
    App.remoteReady = true;
    hideGate();
    renderAccount();
    updateCloudMessaging();
    applyPermissionsToUi();
    safeToast('Espace créé : vous êtes le gérant principal.', 'ok');
    return data;
  }

  function existingImportForm(message, error) {
    const node = document.getElementById('pp-auth-gate');
    if (!node) return;
    node.hidden = false;
    node.innerHTML = `<div class="pp-auth-card"><div class="pp-auth-brand">Importer vers Planni<b>Pro</b></div><p class="pp-auth-kicker">Cet espace sécurisé existe déjà et ne contient pas encore de données synchronisées. Vous pouvez importer les données locales de cet appareil sans créer de doublons.</p>${message ? '<p class="pp-auth-note' + (error ? ' err' : '') + '">' + escapeHtml(message) + '</p>' : ''}<form class="pp-auth-form" id="pp-existing-import-form"><button class="pp-auth-submit" type="submit">Sauvegarder et importer mes données locales</button></form><div class="pp-auth-links"><button type="button" class="pp-auth-link" data-pp-action="continue-empty-workspace">Continuer sans importer</button></div></div>`;
  }

  async function importExistingLocalState() {
    if (!App.context || !localStateHasContent()) throw new Error('Aucune donnée locale à importer.');
    await dbPut('backups', `legacy:${App.user.id}:${Date.now()}`, clone(S));
    const snapshot = snapshotState();
    const pendingKey = `pending:${App.user.id}:${App.context.organization_id}`;
    await dbPutStateAndQueue(
      App.cacheKey,
      { state: snapshot, cachedRemote: true, savedAt: new Date().toISOString() },
      pendingKey,
      makeQueueEntry('legacy-import', snapshot)
    );
    const synced = await App.syncNow('legacy-import');
    if (!synced) throw new Error('Les données restent en attente locale : reconnectez l’appareil puis relancez la synchronisation.');
    try { await archiveAndClearLegacyStorage(); }
    catch (backupError) { console.warn('Sauvegarde legacy à finaliser', backupError); }
    hideGate(); renderAccount(); updateCloudMessaging(); applyPermissionsToUi();
    safeToast('Données locales importées et sauvegardées.', 'ok');
  }

  async function logout() {
    const client = App.client;
    const realtimeChannel = App.realtimeChannel;

    // Clear the authenticated UI and in-memory identity immediately. Realtime
    // teardown can wait for a socket timeout, but must never prevent logout.
    clearTimeout(App.syncTimer);
    App.syncTimer = null;
    App.realtimeChannel = null;
    App.session = null;
    App.user = null;
    App.context = null;
    App.contexts = EMPTY_ARRAY;
    App.cacheKey = null;
    App.syncing = false;
    App.applyingRemote = false;
    App.remoteReady = false;
    document.querySelector('.pp-account')?.remove();
    authForm('login');

    try {
      // Sign out before closing channels: a stalled Realtime socket must not
      // leave the Supabase session active on this device.
      await client.auth.signOut({ scope: 'local' });
    }
    finally {
      // Tear down all sockets in one operation before any feature-specific
      // cleanup can wait on an already-disconnected channel.
      try { await client.removeAllChannels(); } catch (_) {
        if (realtimeChannel) {
          try { await client.removeChannel(realtimeChannel); } catch (_) { /* Session is already closed locally. */ }
        }
      }
      try { await window.PlanniProVault?.shutdown?.(); } catch (_) { /* Identity and Realtime are already cleared. */ }
    }
  }

  function renderAccount() {
    let root = document.querySelector('.pp-account');
    if (!App.user || !App.context) { root?.remove(); return; }
    if (!root) {
      root = document.createElement('div');
      root.className = 'pp-account';
      document.querySelector('.topbar > div:last-child, .topbar')?.appendChild(root);
    }
    const initials = (App.user.user_metadata?.full_name || App.user.email || 'U').split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
    const options = App.contexts.map((context) => `<option value="${escapeHtml(context.organization_id)}" ${context.organization_id === App.context.organization_id ? 'selected' : ''}>${escapeHtml(context.organization_name)} · ${escapeHtml(context.role_label)}</option>`).join('');
    const canOpenUsers = ['view', 'invite', 'disable', 'reactivate', 'delete', 'manage_roles', 'manage_permissions'].some((action) => App.can('users', action));
    root.innerHTML = `<button class="pp-account-button" type="button" data-pp-action="account-toggle" aria-label="Menu utilisateur"><span class="pp-account-avatar">${escapeHtml(initials)}</span><span class="pp-account-lines"><span class="pp-account-name">${escapeHtml(App.user.user_metadata?.full_name || App.user.email || 'Utilisateur')}</span><span class="pp-account-role">${escapeHtml(App.context.role_label)} · ${escapeHtml(App.context.organization_name)}</span></span></button><div class="pp-account-menu"><p><strong>${escapeHtml(App.context.role_label)}</strong> · ${escapeHtml(App.context.status)}</p>${App.contexts.length > 1 ? '<select data-pp-org-switch>' + options + '</select>' : ''}<p style="margin-top:9px"><span class="pp-sync-status" data-pp-sync-status>Synchronisé</span></p><div class="pp-account-actions"><button type="button" data-pp-action="sync-now">Synchroniser maintenant</button>${App.context.employee_id ? '<button type="button" data-pp-action="self-service">Mes coordonnées</button>' : ''}<button type="button" data-pp-action="change-password">Modifier le mot de passe</button>${canOpenUsers ? '<button type="button" data-pp-action="open-users">Utilisateurs et droits d’accès</button>' : ''}<button type="button" class="danger" data-pp-action="logout">Se déconnecter</button></div></div>`;
    root.querySelector('[data-pp-org-switch]')?.addEventListener('change', async (event) => {
      const organizationId = event.target.value;
      const next = App.contexts.find((context) => context.organization_id === organizationId);
      if (!next) return;
      await window.PlanniProVault?.shutdown?.();
      App.context = next;
      App.cacheKey = `state:${App.user.id}:${next.organization_id}`;
      await dbPut('kv', `active-org:${App.user.id}`, organizationId);
      await App.restoreOrPull?.();
      subscribeRealtime();
      renderAccount();
      applyPermissionsToUi();
      window.dispatchEvent(new CustomEvent('plannipro:cloud-ready'));
    });
  }

  function updateCloudMessaging() {
    document.querySelectorAll('.hr-local-banner div').forEach((node) => {
      node.innerHTML = '<strong>Dossier RH protégé et synchronisé.</strong><br>Les documents sont conservés uniquement dans le coffre-fort privé Supabase, avec contrôle RBAC, versionnage et journal d’audit. Aucun fichier RH n’est stocké dans le navigateur.';
    });
  }

  function applyPermissionsToUi() {
    Object.entries(NAV_PERMISSIONS).forEach(([view, [module, action]]) => {
      const button = document.getElementById(`sb-${view}`);
      if (button) button.hidden = !canNavigateView(view, module, action);
    });
    document.querySelectorAll('[data-pp-permission]').forEach((node) => {
      const [module, action] = node.dataset.ppPermission.split('.');
      node.hidden = !App.can(module, action || 'view');
    });
    document.querySelectorAll('button[onclick]').forEach((button) => {
      const rule = BUTTON_PERMISSIONS[(button.getAttribute('onclick') || '').trim()];
      if (!rule) return;
      const allowed = App.can(rule[0], rule[1]);
      if (!button.dataset.ppOriginalTitle) button.dataset.ppOriginalTitle = button.title || '';
      button.disabled = !allowed;
      button.setAttribute('aria-disabled', String(!allowed));
      button.title = allowed ? button.dataset.ppOriginalTitle : 'Action non autorisée pour votre profil';
      if (!allowed) button.classList.add('pp-action-disabled');
      else button.classList.remove('pp-action-disabled');
    });
    const mainButton = document.getElementById('mainBtn');
    const mainRule = typeof curView !== 'undefined' ? BUTTON_PERMISSIONS[{ planning: 'openShiftModal(null,null)', employees: 'openEmpModal()', hr: 'openAbsModal()', registre: 'openEmpModal()', erp: 'openErpModal()' }[curView]] : null;
    if (mainButton && mainRule) mainButton.hidden = !App.can(mainRule[0], mainRule[1]);
    if (typeof curView !== 'undefined' && NAV_PERMISSIONS[curView]) {
      const [module, action] = NAV_PERMISSIONS[curView];
      if (!canNavigateView(curView, module, action)) {
        const first = Object.keys(NAV_PERMISSIONS).find((view) => canNavigateView(view, ...NAV_PERMISSIONS[view]));
        if (first) goAllowedView(first);
      }
    }
  }

  function goAllowedView(view) {
    const permission = NAV_PERMISSIONS[view];
    if (permission && !canNavigateView(view, permission[0], permission[1])) {
      safeToast('Cette page n’est pas autorisée pour votre profil.', 'err');
      return false;
    }
    if (view === 'users') renderUsersView?.();
    return rawGoView ? rawGoView(view) : false;
  }

  function canNavigateView(view, module, action) {
    if (view === 'users') return ['view', 'invite', 'disable', 'reactivate', 'delete', 'manage_roles', 'manage_permissions']
      .some((candidate) => App.can('users', candidate));
    return App.can(module, action);
  }

  let rawGoView = null;
  function wrapNavigation() {
    if (typeof goView !== 'function' || rawGoView) return;
    rawGoView = goView;
    goView = goAllowedView;
    window.goView = goAllowedView;
  }

  function registerServiceWorker() {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch((error) => console.warn('Service worker indisponible', error));
  }

  async function init() {
    installStyle();
    mountGate();
    gate('Vérification de votre session sécurisée…');
    if (!CONFIG?.url || !CONFIG?.publishableKey || !window.supabase?.createClient) {
      authForm('login', 'La bibliothèque ou la configuration Supabase est indisponible.', true);
      return;
    }
    App.client = window.supabase.createClient(CONFIG.url, CONFIG.publishableKey, {
      auth: { storage: indexedDbAuthStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    wrapNavigation();
    finishCloudMount();
    registerServiceWorker();
    App.client.auth.onAuthStateChange((eventName, session) => setTimeout(() => { void activateSession(session, eventName); }, 0));
    const { data } = await App.client.auth.getSession();
    await activateSession(data.session, 'INITIAL_SESSION');
    window.addEventListener('online', () => { App.online = true; void App.syncNow?.('online'); });
    window.addEventListener('offline', () => { App.online = false; App.status('Hors ligne · modifications en attente', 'pending'); });
    App.initialized = true;
  }

  function snapshotState() {
    return clone({
      // Les métadonnées et fichiers du coffre-fort sont gérés exclusivement
      // par les tables dédiées et Supabase Storage, jamais par le cache métier.
      employees: Array.isArray(S.employees) ? S.employees.map(({ documents, ...employee }) => employee) : [],
      shifts: Array.isArray(S.shifts) ? S.shifts : [],
      absences: Array.isArray(S.absences) ? S.absences : [],
      punchLog: Array.isArray(S.punchLog) ? S.punchLog : [],
      sites: Array.isArray(S.sites) ? S.sites : [],
      erpEntries: Array.isArray(S.erpEntries) ? S.erpEntries : [],
      registre: Array.isArray(S.registre) ? S.registre : [],
      templates: Array.isArray(S.templates) ? S.templates : [],
      locks: S.locks && typeof S.locks === 'object' ? S.locks : { week: {}, day: {} },
      weekStart: S.weekStart || null,
      settings: S.settings || {},
      meta: S.meta || {}
    });
  }

  function splitEmployee(employee) {
    const publicData = {};
    const privateData = {};
    Object.entries(employee || {}).forEach(([key, value]) => {
      if (key === 'id' || key === 'cloudEmployeeId' || key === 'documents') return;
      if (PUBLIC_EMPLOYEE_FIELDS.has(key)) publicData[key] = value;
      else privateData[key] = value;
    });
    return { publicData, privateData };
  }

  function splitName(employee) {
    const first = String(employee?.identity?.firstName || '').trim();
    const last = String(employee?.identity?.lastName || '').trim();
    if (first || last) return { first, last };
    const parts = String(employee?.name || '').trim().split(/\s+/).filter(Boolean);
    return { first: parts.shift() || '', last: parts.join(' ') };
  }

  function employeeEstablishment(employee, siteMap, fallback) {
    return siteMap.get(String(employee?.site || '')) || fallback || null;
  }

  function recordRows(snapshot, organizationId, siteMap, employeeMap) {
    const records = [];
    const employeeFor = (legacyId) => employeeMap.get(String(legacyId || '')) || null;
    const employeeContext = (legacyId) => snapshot.employees.find((employee) => String(employee.id) === String(legacyId || '')) || null;
    const add = (recordType, entries) => (entries || []).forEach((entry) => {
      if (!entry || entry.id == null) return;
      const employee = employeeContext(entry.empId);
      records.push({
        organization_id: organizationId,
        establishment_id: employeeEstablishment(employee, siteMap, null),
        employee_id: employeeFor(entry.empId),
        team_id: employee?.teamId || employee?.team || null,
        service_id: employee?.serviceId || employee?.service || null,
        record_type: recordType,
        legacy_id: String(entry.id),
        payload: entry,
        deleted_at: null
      });
    });
    add('shift', snapshot.shifts);
    add('absence', snapshot.absences);
    add('punch', snapshot.punchLog);
    add('erp', snapshot.erpEntries);
    add('register', snapshot.registre);
    records.push({
      organization_id: organizationId,
      establishment_id: null,
      employee_id: null,
      team_id: null,
      service_id: null,
      record_type: 'setting',
      legacy_id: 'application-state',
      payload: {
        settings: snapshot.settings || {},
        templates: Array.isArray(snapshot.templates) ? snapshot.templates : [],
        locks: snapshot.locks && typeof snapshot.locks === 'object' ? snapshot.locks : { week: {}, day: {} },
        weekStart: snapshot.weekStart || null,
        meta: { source: 'plannipro-web' }
      },
      deleted_at: null
    });
    return records;
  }

  function canonicalValue(value) {
    if (Array.isArray(value)) return value.map(canonicalValue);
    if (value && typeof value === 'object') {
      return Object.keys(value).sort().reduce((result, key) => {
        result[key] = canonicalValue(value[key]);
        return result;
      }, {});
    }
    return value;
  }

  function sameValue(left, right) {
    return JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right));
  }

  function sameRecord(row, remote) {
    return Boolean(remote)
      && String(row.establishment_id || '') === String(remote.establishment_id || '')
      && String(row.employee_id || '') === String(remote.employee_id || '')
      && String(row.team_id || '') === String(remote.team_id || '')
      && String(row.service_id || '') === String(remote.service_id || '')
      && sameValue(row.payload || {}, remote.payload || {});
  }

  function mergeAuthorizedLocks(remoteLocks, localLocks) {
    const result = clone(remoteLocks && typeof remoteLocks === 'object' ? remoteLocks : { week: {}, day: {} });
    ['week', 'day'].forEach((scope) => {
      const remote = remoteLocks?.[scope] && typeof remoteLocks[scope] === 'object' ? remoteLocks[scope] : {};
      const local = localLocks?.[scope] && typeof localLocks[scope] === 'object' ? localLocks[scope] : {};
      result[scope] = { ...remote };
      new Set([...Object.keys(remote), ...Object.keys(local)]).forEach((key) => {
        const hadRemote = Object.prototype.hasOwnProperty.call(remote, key);
        const hasLocal = Object.prototype.hasOwnProperty.call(local, key);
        if (!hadRemote && hasLocal && App.can('planning', 'lock')) result[scope][key] = local[key];
        else if (hadRemote && !hasLocal && App.can('planning', 'unlock')) delete result[scope][key];
        else if (hadRemote && hasLocal && !sameValue(remote[key], local[key])
          && App.can('planning', 'lock') && App.can('planning', 'unlock')) result[scope][key] = local[key];
      });
    });
    return result;
  }

  function authorizedRecordRow(row, remote) {
    if (!remote) {
      if (row.record_type === 'shift') return App.can('planning', row.payload?.copiedFrom ? 'copy' : 'create') ? row : null;
      if (row.record_type === 'absence') return App.can('leaves', 'request') ? row : null;
      if (row.record_type === 'punch') return App.can('pointage', 'badge') ? row : null;
      if (row.record_type === 'register') return App.can('register', 'manage') ? row : null;
      const module = RECORD_MODULES[row.record_type];
      return module && App.can(module, 'create') ? row : null;
    }
    if (row.record_type === 'setting' && row.legacy_id === 'application-state') {
      const next = { ...row, payload: clone(remote.payload || {}) };
      const localPayload = row.payload || {};
      if (App.can('settings', 'update')) {
        Object.keys(localPayload).filter((key) => !['locks', 'templates'].includes(key)).forEach((key) => { next.payload[key] = clone(localPayload[key]); });
      }
      if (App.can('planning', 'update')) next.payload.templates = clone(localPayload.templates || []);
      next.payload.locks = mergeAuthorizedLocks(remote.payload?.locks, localPayload.locks);
      // La semaine affichée n'est pas une donnée sensible ; elle accompagne
      // uniquement une autre mutation autorisée du même enregistrement.
      if (localPayload.weekStart != null && (
        App.can('settings', 'update') || App.can('planning', 'update')
        || App.can('planning', 'lock') || App.can('planning', 'unlock')
      )) next.payload.weekStart = localPayload.weekStart;
      return sameRecord(next, remote) ? null : next;
    }
    if (sameRecord(row, remote)) return null;
    if (row.record_type === 'shift') {
      const moved = String(row.establishment_id || '') !== String(remote.establishment_id || '')
        || String(row.employee_id || '') !== String(remote.employee_id || '')
        || String(row.team_id || '') !== String(remote.team_id || '')
        || String(row.service_id || '') !== String(remote.service_id || '')
        || String(row.payload?.date || '') !== String(remote.payload?.date || '');
      const localContent = { ...(row.payload || {}) }; delete localContent.date;
      const remoteContent = { ...(remote.payload || {}) }; delete remoteContent.date;
      const edited = !sameValue(localContent, remoteContent);
      return (!moved || App.can('planning', 'move')) && (!edited || App.can('planning', 'update')) ? row : null;
    }
    if (row.record_type === 'absence') return App.can('leaves', 'update') ? row : null;
    if (row.record_type === 'punch') return App.can('pointage', 'correct') ? row : null;
    if (row.record_type === 'register') return App.can('register', 'manage') ? row : null;
    const module = RECORD_MODULES[row.record_type];
    return module && App.can(module, 'update') ? row : null;
  }

  function canDeleteRecord(record) {
    if (record.record_type === 'absence') return App.can('leaves', 'cancel');
    if (record.record_type === 'register') return App.can('register', 'manage');
    const module = RECORD_MODULES[record.record_type];
    return Boolean(module && App.can(module, 'delete'));
  }

  function tableError(error, table) {
    if (error) {
      error.message = `${table} : ${error.message || 'opération refusée'}`;
      throw error;
    }
  }

  async function fetchRemoteState() {
    const organizationId = App.context.organization_id;
    const [sitesResult, employeesResult, privateResult, recordsResult] = await Promise.all([
      App.client.from('establishments').select('*').eq('organization_id', organizationId).order('name'),
      App.client.from('employees').select('*').eq('organization_id', organizationId).order('created_at'),
      App.client.from('employee_private_data').select('*').eq('organization_id', organizationId),
      App.client.from('business_records').select('*').eq('organization_id', organizationId).is('deleted_at', null).order('updated_at')
    ]);
    tableError(sitesResult.error, 'Établissements');
    tableError(employeesResult.error, 'Salariés');
    tableError(privateResult.error, 'Données RH privées');
    tableError(recordsResult.error, 'Données métier');
    return {
      sites: sitesResult.data || [], employees: employeesResult.data || [], privateData: privateResult.data || [],
      records: recordsResult.data || []
    };
  }

  function remoteHasContent(remote) {
    return Boolean(remote.employees.length || remote.records.some((record) => record.record_type !== 'setting'));
  }

  function shouldApplyRemoteState(remote, cached, pending) {
    return !pending?.state;
  }

  function applyRemoteState(remote) {
    const siteByDbId = new Map();
    const sites = remote.sites.map((site) => {
      const localId = site.legacy_id || `site-${site.id}`;
      siteByDbId.set(site.id, localId);
      return { id: localId, name: site.name, address: site.address || site.data?.address || '', icon: site.data?.icon || '🏪', ...site.data };
    });
    const privateByEmployee = new Map(remote.privateData.map((item) => [item.employee_id, item.data || {}]));
    const employeeByDbId = new Map();
    const employees = remote.employees.map((employee) => {
      const localId = employee.legacy_id || `employee-${employee.id}`;
      employeeByDbId.set(employee.id, localId);
      const record = {
        ...(employee.public_data || {}),
        ...(privateByEmployee.get(employee.id) || {}),
        id: localId,
        cloudEmployeeId: employee.id,
        name: employee.display_name || [employee.first_name, employee.last_name].filter(Boolean).join(' ') || localId,
        site: siteByDbId.get(employee.establishment_id) || (employee.public_data || {}).site || '',
        archived: employee.employment_status !== 'active'
      };
      if (typeof normalizeEmployeeRecord === 'function') return normalizeEmployeeRecord(record);
      return record;
    });
    App.currentEmployeeLegacyId = employees.find((employee) => employee.cloudEmployeeId === App.context?.employee_id)?.id || null;
    const collections = { shifts: [], absences: [], punchLog: [], erpEntries: [], registre: [] };
    let remoteSettings = null;
    remote.records.forEach((record) => {
      const payload = { ...(record.payload || {}) };
      payload.id = payload.id || record.legacy_id;
      if (record.employee_id) payload.empId = employeeByDbId.get(record.employee_id) || payload.empId;
      if (record.record_type === 'shift') collections.shifts.push(payload);
      if (record.record_type === 'absence') collections.absences.push(payload);
      if (record.record_type === 'punch') collections.punchLog.push(payload);
      if (record.record_type === 'erp') collections.erpEntries.push(payload);
      if (record.record_type === 'register') collections.registre.push(payload);
      if (record.record_type === 'setting' && record.legacy_id === 'application-state') remoteSettings = payload;
    });

    App.applyingRemote = true;
    try {
      S = {
        ...S,
        employees,
        shifts: collections.shifts,
        absences: collections.absences,
        punchLog: collections.punchLog,
        sites,
        erpEntries: collections.erpEntries,
        registre: collections.registre,
        templates: Array.isArray(remoteSettings?.templates) ? remoteSettings.templates : [],
        locks: remoteSettings?.locks && typeof remoteSettings.locks === 'object'
          ? remoteSettings.locks
          : { week: {}, day: {} },
        weekStart: remoteSettings?.weekStart || S.weekStart,
        settings: remoteSettings?.settings && typeof remoteSettings.settings === 'object'
          ? remoteSettings.settings
          : {},
        meta: { ...(S.meta || {}), cloudOrganizationId: App.context.organization_id, cloudUpdatedAt: new Date().toISOString() }
      };
      if (typeof normalizeState === 'function') normalizeState();
      if (typeof renderAll === 'function') renderAll();
    } finally {
      App.applyingRemote = false;
    }
  }

  // Point de compatibilité pour les anciennes files de synchronisation : les
  // documents ne transitent plus par le cache métier générique.
  async function pushDocuments(snapshot, employeeMap, siteMap) {
    void snapshot; void employeeMap; void siteMap;
    return [];
  }

  async function pruneRemote(snapshot) {
    const organizationId = App.context.organization_id;
    const remoteRecords = await App.client.from('business_records').select('id,record_type,legacy_id,payload').eq('organization_id', organizationId).is('deleted_at', null);
    tableError(remoteRecords.error, 'Vérification des suppressions');
    const localKeys = new Set(recordRows(snapshot, organizationId, new Map(), new Map()).map((row) => `${row.record_type}:${row.legacy_id}`));
    const removable = (remoteRecords.data || []).filter((record) => {
      const module = RECORD_MODULES[record.record_type];
      const managedByTimeClock = record.record_type === 'punch'
        && (String(record.legacy_id || '').startsWith(TIME_CLOCK_LEGACY_PREFIX) || record.payload?.source === 'external-time-clock');
      // Les résumés venant de la tablette sont produits à partir des badges
      // immuables côté base. Une application qui n'a pas encore téléchargé un
      // badge ne doit jamais pouvoir le supprimer pendant une autre synchro.
      return module && !managedByTimeClock && canDeleteRecord(record) && !localKeys.has(`${record.record_type}:${record.legacy_id}`);
    });
    if (removable.length) {
      const { error } = await App.client.from('business_records').delete().in('id', removable.map((record) => record.id));
      tableError(error, 'Suppression des données métier');
    }

    if (App.can('employees', 'delete')) {
      const remoteEmployees = await App.client.from('employees').select('id,legacy_id').eq('organization_id', organizationId);
      tableError(remoteEmployees.error, 'Vérification des salariés supprimés');
      const localEmployeeIds = new Set((snapshot.employees || []).map((employee) => String(employee.id)));
      const deleted = (remoteEmployees.data || []).filter((employee) => !localEmployeeIds.has(String(employee.legacy_id))).map((employee) => employee.id);
      if (deleted.length) {
        const { error } = await App.client.from('employees').delete().in('id', deleted);
        tableError(error, 'Suppression des salariés');
      }
    }

  }

  async function pushSnapshot(snapshot) {
    const organizationId = App.context.organization_id;
    const sites = Array.isArray(snapshot.sites) ? snapshot.sites : [];
    const siteRows = sites.map((site) => ({
      organization_id: organizationId,
      legacy_id: String(site.id),
      name: site.name || 'Établissement',
      address: site.address || null,
      data: { ...site, id: undefined, name: undefined, address: undefined }
    }));
    let storedSites = [];
    const visibleSites = await App.client.from('establishments').select('id,legacy_id').eq('organization_id', organizationId);
    tableError(visibleSites.error, 'Établissements');
    storedSites = visibleSites.data || [];
    if (siteRows.length && (App.can('establishments', 'create') || App.can('establishments', 'update'))) {
      // The establishment created at workspace bootstrap has no legacy id yet.
      // Match it to the first local site instead of creating a duplicate.
      if (storedSites.length === 1 && !storedSites[0].legacy_id && sites.length === 1 && App.context.primary_establishment_id === storedSites[0].id) {
        const first = siteRows[0];
        const seeded = await App.client.from('establishments').update({ legacy_id: first.legacy_id, name: first.name, address: first.address, data: first.data }).eq('id', storedSites[0].id).select('id,legacy_id');
        tableError(seeded.error, 'Établissement initial');
        storedSites = seeded.data || storedSites;
      } else {
        const result = await App.client.from('establishments').upsert(siteRows, { onConflict: 'organization_id,legacy_id' }).select('id,legacy_id');
        tableError(result.error, 'Établissements');
        storedSites = result.data || storedSites;
      }
    }
    const siteMap = new Map(storedSites.map((site) => [String(site.legacy_id), site.id]));
    const fallbackEstablishment = App.context.primary_establishment_id || storedSites[0]?.id || null;
    const employeeRows = (snapshot.employees || []).filter((employee) => employee && employee.id != null).map((employee) => {
      const { publicData } = splitEmployee(employee);
      const parts = splitName(employee);
      return {
        organization_id: organizationId,
        establishment_id: employeeEstablishment(employee, siteMap, fallbackEstablishment),
        legacy_id: String(employee.id),
        employee_number: employee.employeeNumber || null,
        first_name: parts.first,
        last_name: parts.last,
        team_id: employee.teamId || employee.team || null,
        service_id: employee.serviceId || employee.service || null,
        employment_status: employee.archived ? 'archived' : 'active',
        public_data: publicData
      };
    });
    let storedEmployees = [];
    if (employeeRows.length && (App.can('employees', 'create') || App.can('employees', 'update'))) {
      const result = await App.client.from('employees').upsert(employeeRows, { onConflict: 'organization_id,legacy_id' }).select('id,legacy_id');
      tableError(result.error, 'Salariés');
      storedEmployees = result.data || [];
    } else {
      const result = await App.client.from('employees').select('id,legacy_id').eq('organization_id', organizationId);
      tableError(result.error, 'Salariés');
      storedEmployees = result.data || [];
    }
    const employeeMap = new Map(storedEmployees.map((employee) => [String(employee.legacy_id), employee.id]));
    if (App.can('employees', 'create_sensitive') || App.can('employees', 'update_sensitive')) {
      const privateRows = (snapshot.employees || []).map((employee) => {
        const employeeId = employeeMap.get(String(employee?.id));
        if (!employeeId) return null;
        return { employee_id: employeeId, organization_id: organizationId, data: splitEmployee(employee).privateData };
      }).filter(Boolean);
      if (privateRows.length) {
        const result = await App.client.from('employee_private_data').upsert(privateRows, { onConflict: 'employee_id' });
        tableError(result.error, 'Données RH privées');
      }
    }
    const currentRecords = await App.client.from('business_records')
      .select('id,record_type,legacy_id,establishment_id,employee_id,team_id,service_id,payload')
      .eq('organization_id', organizationId).is('deleted_at', null);
    tableError(currentRecords.error, 'État courant des données métier');
    const currentByKey = new Map((currentRecords.data || []).map((record) => [`${record.record_type}:${record.legacy_id}`, record]));
    const rows = recordRows(snapshot, organizationId, siteMap, employeeMap)
      .map((row) => authorizedRecordRow(row, currentByKey.get(`${row.record_type}:${row.legacy_id}`)))
      .filter(Boolean);
    if (rows.length) {
      const result = await App.client.from('business_records').upsert(rows, { onConflict: 'organization_id,record_type,legacy_id' });
      tableError(result.error, 'Données métier');
    }
    await pruneRemote(snapshot);
  }

  async function restoreOrPull() {
    if (!App.context || !App.cacheKey) return;
    const pendingKey = `pending:${App.user.id}:${App.context.organization_id}`;
    const [cached, pending] = await Promise.all([
      dbGet('kv', App.cacheKey),
      dbGet('queue', pendingKey)
    ]);
    const legacyWasPresent = !cached && localStateHasContent();
    const localSnapshot = pending?.state || cached?.state;
    if (localSnapshot) {
      App.applyingRemote = true;
      try {
        S = clone(localSnapshot);
        App.currentEmployeeLegacyId = S.employees?.find((employee) => employee.cloudEmployeeId === App.context?.employee_id)?.id || null;
        if (typeof normalizeState === 'function') normalizeState();
        if (typeof renderAll === 'function') renderAll();
      }
      finally { App.applyingRemote = false; }
    }
    if (!navigator.onLine) {
      App.status('Hors ligne · données mises en cache', 'pending');
      return;
    }
    if (pending?.state) {
      const synced = await syncNow('restore-pending');
      return { pending: !synced };
    }
    const remote = await fetchRemoteState();
    if (!remoteHasContent(remote) && !cached && App.context?.role_key === 'owner' && localStateHasContent()) {
      existingImportForm();
      return { needsImport: true };
    }
    // An existing cloud workspace is authoritative. A freshly created workspace
    // keeps the local snapshot until the explicit first import is flushed.
    if (shouldApplyRemoteState(remote, cached, pending)) applyRemoteState(remote);
    await dbPut('kv', App.cacheKey, { state: snapshotState(), cachedRemote: true, savedAt: new Date().toISOString() });
    if (remoteHasContent(remote) && legacyWasPresent) {
      try { await archiveAndClearLegacyStorage(); }
      catch (backupError) { console.warn('Sauvegarde legacy à finaliser', backupError); }
    }
  }

  function captureLocalChange(reason) {
    if (!App.session || !App.context || App.applyingRemote) return;
    App.localChangeRevision += 1;
    const snapshot = snapshotState();
    const pendingKey = `pending:${App.user.id}:${App.context.organization_id}`;
    void dbPutStateAndQueue(
      App.cacheKey,
      { state: snapshot, cachedRemote: true, savedAt: new Date().toISOString() },
      pendingKey,
      makeQueueEntry(reason || 'local-change', snapshot)
    ).then(() => {
      App.status(navigator.onLine ? 'Modifications à synchroniser' : 'Hors ligne · modifications en attente', 'pending');
      if (navigator.onLine) {
        scheduleQueuedSync();
      }
    }).catch((error) => console.warn('File hors ligne indisponible', error));
  }

  function scheduleQueuedSync(delay = 700) {
    clearTimeout(App.syncTimer);
    App.syncTimer = setTimeout(() => { void syncNow('queued'); }, delay);
  }

  async function syncNow(reason) {
    if (!App.session || !App.context || App.syncing) return false;
    if (!navigator.onLine) { App.status('Hors ligne · modifications en attente', 'pending'); return false; }
    App.syncing = true;
    App.status('Vérification des droits…', 'pending');
    const pendingKey = `pending:${App.user.id}:${App.context.organization_id}`;
    const revisionAtStart = App.localChangeRevision;
    try {
      const priorOrganization = App.context.organization_id;
      await refreshContext();
      if (!App.context || App.context.organization_id !== priorOrganization) throw new Error('Vos accès ont été retirés ou votre périmètre a changé.');
      let passes = 0;
      while (passes < 8) {
        const pending = await dbGet('queue', pendingKey);
        if (!pending?.state) break;
        App.status('Synchronisation en cours…', 'pending');
        await pushSnapshot(pending.state);
        const removed = await dbDeleteIfUnchanged('queue', pendingKey, queueGeneration(pending));
        passes += 1;
        if (removed) break;
      }
      let remaining = await dbGet('queue', pendingKey);
      if (remaining?.state || App.localChangeRevision !== revisionAtStart) {
        scheduleQueuedSync();
        App.status('Modifications à synchroniser', 'pending');
        return false;
      }
      const remote = await fetchRemoteState();
      remaining = await dbGet('queue', pendingKey);
      if (remaining?.state || App.localChangeRevision !== revisionAtStart) {
        scheduleQueuedSync();
        App.status('Modifications à synchroniser', 'pending');
        return false;
      }
      applyRemoteState(remote);
      await dbPut('kv', App.cacheKey, { state: snapshotState(), cachedRemote: true, savedAt: new Date().toISOString(), reason });
      App.lastError = null;
      App.status('Synchronisé', 'ok');
      return true;
    } catch (error) {
      App.lastError = error;
      console.error('Synchronisation PlanniPro', error);
      App.status('Synchronisation en attente', 'error');
      if (/accès|access|not authorized|permission|membership|rights/i.test(String(error?.message || ''))) {
        safeToast('Vos droits ont changé : la synchronisation a été bloquée.', 'err');
        await logout();
      } else if (reason === 'manual') {
        safeToast(error.message || 'Synchronisation impossible pour le moment.', 'err');
      }
      return false;
    } finally {
      App.syncing = false;
    }
  }

  App.restoreOrPull = restoreOrPull;
  App.captureLocalChange = captureLocalChange;
  App.syncNow = syncNow;

  function subscribeRealtime() {
    if (!App.client || !App.context) return;
    if (App.realtimeChannel) App.client.removeChannel(App.realtimeChannel);
    const organizationId = App.context.organization_id;
    const refresh = () => {
      if (App.syncing) return;
      clearTimeout(App.syncTimer);
      App.syncTimer = setTimeout(() => { void App.syncNow('realtime'); }, 650);
    };
    const refreshAccess = () => {
      refresh();
      void refreshPermissions();
    };
    App.realtimeChannel = App.client.channel(`plannipro:${organizationId}:${App.user.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'employees', filter: `organization_id=eq.${organizationId}` }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'business_records', filter: `organization_id=eq.${organizationId}` }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'organization_members', filter: `organization_id=eq.${organizationId}` }, refreshAccess)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'roles', filter: `organization_id=eq.${organizationId}` }, refreshPermissions)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'role_permissions' }, refreshPermissions)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'user_permissions', filter: `organization_id=eq.${organizationId}` }, refreshPermissions)
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') App.status('Synchronisé en direct', 'ok');
      });
  }

  async function refreshPermissions() {
    if (!App.client || !App.user) return;
    try {
      const previousOrganization = App.context?.organization_id;
      await refreshContext();
      if (!App.context || App.context.organization_id !== previousOrganization) return void logout();
      renderAccount();
      applyPermissionsToUi();
      if (typeof curView !== 'undefined' && curView === 'users') await loadUsersView();
    } catch (error) {
      console.warn('Actualisation immédiate des permissions impossible', error);
      await logout();
    }
  }

  function hasAny(module, actions) {
    return actions.some((action) => App.can(module, action));
  }

  function logClientAudit(action, resourceType, resourceId) {
    if (!App.client || !App.context) return;
    void App.client.rpc('log_audit_event', {
      p_organization_id: App.context.organization_id,
      p_action: action,
      p_resource_type: resourceType || 'ui_action',
      p_resource_id: resourceId || null
    }).catch((error) => console.warn('Journal d’activité indisponible', error));
  }

  function protectFunction(name, permission, options = {}) {
    const original = window[name];
    if (typeof original !== 'function' || original.__planniProProtected) return;
    const wrapped = function (...args) {
      const requested = typeof permission === 'function' ? permission(args) : permission;
      const allowed = Array.isArray(requested?.action)
        ? hasAny(requested.module, requested.action)
        : App.can(requested?.module, requested?.action || 'view');
      if (!allowed) {
        safeToast(options.message || 'Cette action est interdite pour votre profil.', 'err');
        return options.returnValue;
      }
      if (options.before && options.before(args) === false) return options.returnValue;
      const result = original.apply(this, args);
      if (options.audit) logClientAudit(options.audit, options.resourceType || requested?.module || 'ui_action');
      return result;
    };
    wrapped.__planniProProtected = true;
    wrapped.__planniProOriginal = original;
    window[name] = wrapped;
  }

  function protectActions() {
    if (protectActions.done) return;
    protectActions.done = true;
    const originalSave = window.save;
    if (typeof originalSave === 'function') {
      const cloudSave = function (...args) {
        const result = originalSave.apply(this, args);
        App.captureLocalChange('local-save');
        return result;
      };
      window.save = cloudSave;
      try { save = cloudSave; } catch (_) { /* classic global binding unavailable */ }
    }
    const originalRenderAll = window.renderAll;
    if (typeof originalRenderAll === 'function') {
      const cloudRenderAll = function (...args) {
        const result = originalRenderAll.apply(this, args);
        queueMicrotask(applyPermissionsToUi);
        return result;
      };
      window.renderAll = cloudRenderAll;
      try { renderAll = cloudRenderAll; } catch (_) { /* classic global binding unavailable */ }
    }
    protectFunction('openShiftModal', (args) => ({ module: 'planning', action: args[2] ? 'update' : ['create', 'view'] }));
    protectFunction('saveShift', () => ({ module: 'planning', action: document.getElementById('editSid')?.value ? 'update' : 'create' }));
    protectFunction('deleteShift', { module: 'planning', action: 'delete' });
    protectFunction('transferPlanningShift', (args) => ({ module: 'planning', action: args[3] === 'copy' ? 'copy' : 'move' }));
    protectFunction('setPlanningDragMode', { module: 'planning', action: ['move', 'copy'] });
    protectFunction('pastePlanningClipboard', { module: 'planning', action: ['copy', 'move'] });
    protectFunction('openWeeklyRestModal', { module: 'planning', action: ['create', 'update'] });
    protectFunction('executeDup', { module: 'planning', action: 'copy' }, {
      before: () => document.getElementById('dupConflict')?.value !== 'replace'
        || App.require('planning', 'delete', 'Le mode « remplacer » nécessite aussi le droit de supprimer.')
    });
    protectFunction('toggleWeekLock', () => ({ module: 'planning', action: typeof isWeekLocked === 'function' && isWeekLocked() ? 'unlock' : 'lock' }));
    protectFunction('toggleDayLock', (args) => ({ module: 'planning', action: typeof isDayLocked === 'function' && isDayLocked(args[0]) ? 'unlock' : 'lock' }));
    protectFunction('openEmpModal', { module: 'employees', action: ['view', 'create', 'update'] });
    protectFunction('openManagerModal', { module: 'employees', action: 'create' });
    protectFunction('saveEmp', { module: 'employees', action: ['create', 'update'] }, {
      before: () => {
        const contract = document.getElementById('eCt')?.value;
        if (contract === 'Gérant / TNS' && App.context?.role_key !== 'owner') {
          safeToast('Seul le gérant peut créer ou modifier la fiche du gérant.', 'err');
          return false;
        }
        return true;
      }
    });
    protectFunction('archiveEmp', { module: 'employees', action: 'update' });
    protectFunction('restoreEmp', { module: 'employees', action: 'update' });
    protectFunction('deleteEmp', { module: 'employees', action: 'delete' });
    protectFunction('addEmployeeAmendment', { module: 'employees', action: 'manage_contracts' });
    protectFunction('deleteEmployeeAmendment', { module: 'employees', action: 'manage_contracts' });
    protectFunction('openEmployeeVault', { module: 'documents', action: 'view' });
    protectFunction('openAbsModal', { module: 'leaves', action: ['request', 'view'] });
    protectFunction('saveAbs', { module: 'leaves', action: ['request', 'update'] });
    protectFunction('approveAbs', { module: 'leaves', action: 'validate' });
    protectFunction('rejectAbs', { module: 'leaves', action: 'refuse' });
    protectFunction('editPendingAbs', { module: 'leaves', action: 'update' });
    protectFunction('editApprovedAbs', { module: 'leaves', action: 'update' });
    protectFunction('revertAbs', { module: 'leaves', action: 'update' });
    protectFunction('deleteAbs', { module: 'leaves', action: 'cancel' });
    protectFunction('openRegModal', { module: 'register', action: ['view', 'manage'] });
    protectFunction('saveReg', { module: 'register', action: 'manage' });
    protectFunction('deleteReg', { module: 'register', action: 'manage' });
    protectFunction('syncAllEmployeesToRegister', { module: 'register', action: 'manage' });
    protectFunction('exportRegCSV', { module: 'register', action: 'export' }, { audit: 'register.export' });
    protectFunction('openErpModal', { module: 'financial', action: ['view', 'create', 'update'] });
    protectFunction('saveErp', { module: 'financial', action: ['create', 'update'] });
    protectFunction('deleteErp', { module: 'financial', action: 'delete' });
    protectFunction('openSiteModal', { module: 'establishments', action: ['view', 'create', 'update'] });
    protectFunction('saveSite', { module: 'establishments', action: ['create', 'update'] });
    protectFunction('deleteSite', { module: 'establishments', action: 'delete' });
    protectFunction('doPunch', { module: 'pointage', action: 'badge' }, {
      before: () => {
        const selected = document.getElementById('punchSel')?.value;
        const ownEmployee = App.currentEmployeeLegacyId || S.employees.find((employee) => employee.cloudEmployeeId === App.context?.employee_id)?.id;
        if (App.context?.employee_id && selected && selected !== ownEmployee) {
          safeToast('Un salarié peut pointer uniquement pour son propre profil.', 'err');
          return false;
        }
        return true;
      }
    });
    protectFunction('openTimeClockApp', { module: 'pointage', action: 'edit_schedule' });
    protectFunction('updatePunch', { module: 'pointage', action: 'correct' });
    protectFunction('updatePunchPause', { module: 'pointage', action: 'correct' });
    protectFunction('setPtValidated', { module: 'pointage', action: 'validate' });
    protectFunction('setPtNote', { module: 'pointage', action: 'correct' });
    protectFunction('toggleSet', { module: 'settings', action: 'update' });
    protectFunction('exportCSV', { module: 'planning', action: 'export' }, { audit: 'planning.export_csv' });
    protectFunction('exportPDF', { module: 'planning', action: 'export' }, { audit: 'planning.export_pdf' });
    protectFunction('printWeeklyPlanning', { module: 'planning', action: 'print' }, { audit: 'planning.print' });
    protectFunction('exportRapportPDF', { module: 'reports', action: 'export' }, { audit: 'reports.export_pdf' });
  }

  function mountUsersView() {
    if (document.getElementById('view-users')) return;
    try { VIEW_TITLES.users = 'Utilisateurs et droits d’accès'; } catch (_) { /* legacy title map unavailable */ }
    const settingsButton = document.getElementById('sb-settings');
    const button = document.createElement('button');
    button.className = 'sb-btn';
    button.id = 'sb-users';
    button.hidden = true;
    button.type = 'button';
    button.onclick = () => goView('users');
    button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6"/><path d="M22 11h-6"/></svg><span class="sb-lbl-txt">Utilisateurs &amp; droits</span><span class="sb-tip">Utilisateurs &amp; droits</span>';
    settingsButton?.before(button);
    const view = document.createElement('section');
    view.className = 'view';
    view.id = 'view-users';
    view.innerHTML = '<div class="pp-users-wrap" id="pp-users-root"></div>';
    document.querySelector('.app')?.appendChild(view);
  }

  function renderUsersView() {
    const root = document.getElementById('pp-users-root');
    if (!root || !App.can('users', 'view')) return;
    root.innerHTML = '<div class="pp-users-head"><div><h2>Utilisateurs et droits d’accès</h2><p>Comptes actifs, invitations, périmètres et permissions de votre établissement.</p></div>' + (App.can('users', 'invite') ? '<button class="btn btn-primary" type="button" data-pp-user-action="invite">Inviter un utilisateur</button>' : '') + '</div><div class="pp-users-card"><h3>Chargement des accès…</h3></div>';
    void loadUsersView();
  }

  async function loadUsersView() {
    const root = document.getElementById('pp-users-root');
    if (!root || !App.context) return;
    try {
      const organizationId = App.context.organization_id;
      const [membersResult, invitationsResult, rolesResult, establishmentsResult] = await Promise.all([
        App.client.from('organization_members').select('id,user_id,role_id,status,primary_establishment_id,employee_id,invited_at,activated_at,last_seen_at,profiles(full_name,email),roles(id,key,label,rank,is_read_only,is_active),establishments(name)').eq('organization_id', organizationId).order('created_at'),
        App.client.from('invitations').select('id,email,status,expires_at,created_at,roles(label),establishments(name)').eq('organization_id', organizationId).order('created_at', { ascending: false }),
        App.client.from('roles').select('*').eq('organization_id', organizationId).order('rank', { ascending: false }),
        App.client.from('establishments').select('id,name').eq('organization_id', organizationId).order('name')
      ]);
      tableError(membersResult.error, 'Utilisateurs');
      tableError(invitationsResult.error, 'Invitations');
      tableError(rolesResult.error, 'Rôles');
      tableError(establishmentsResult.error, 'Établissements');
      const members = membersResult.data || [];
      const invitations = invitationsResult.data || [];
      const roles = rolesResult.data || [];
      const membersRows = members.map((member) => {
        const profile = member.profiles || {};
        const role = member.roles || {};
        const establishment = member.establishments || {};
        const lastSeen = member.last_seen_at ? new Date(member.last_seen_at).toLocaleString('fr-FR') : '—';
        const other = member.user_id !== App.user.id;
        const actions = [];
        if (other && App.can('users','manage_roles')) actions.push('<button class="btn btn-outline btn-sm" data-pp-user-action="role" data-member-id="' + escapeHtml(member.id) + '">Rôle</button>');
        if (other && App.can('users','manage_permissions')) actions.push('<button class="btn btn-outline btn-sm" data-pp-user-action="permissions" data-member-id="' + escapeHtml(member.id) + '">Droits</button> <button class="btn btn-outline btn-sm" data-pp-user-action="scope" data-member-id="' + escapeHtml(member.id) + '">Périmètre</button>');
        if (other && member.status === 'active' && App.can('users','disable')) actions.push('<button class="btn btn-danger btn-sm" data-pp-user-action="status" data-member-id="' + escapeHtml(member.id) + '" data-status="suspended">Suspendre</button>');
        if (other && member.status !== 'active' && App.can('users','reactivate')) actions.push('<button class="btn btn-primary btn-sm" data-pp-user-action="status" data-member-id="' + escapeHtml(member.id) + '" data-status="active">Réactiver</button>');
        return `<tr><td><strong>${escapeHtml(profile.full_name || profile.email || 'Utilisateur')}</strong><br><span style="color:#74809a">${escapeHtml(profile.email || '')}</span></td><td>${escapeHtml(role.label || '—')}${role.is_active === false ? ' · désactivé' : ''}</td><td>${escapeHtml(establishment.name || 'Tous périmètres')}</td><td><span class="pp-users-status ${escapeHtml(member.status)}">${escapeHtml(member.status)}</span></td><td>${escapeHtml(lastSeen)}</td><td>${actions.join(' ') || '—'}</td></tr>`;
      }).join('') || '<tr><td colspan="6">Aucun utilisateur.</td></tr>';
      const invitationRows = invitations.map((invitation) => {
        const canManageInvitation = App.can('users', 'invite') && invitation.status === 'sent';
        const actions = canManageInvitation
          ? '<button class="btn btn-outline btn-sm" data-pp-user-action="resend-invitation" data-invitation-id="' + escapeHtml(invitation.id) + '">Renvoyer</button> <button class="btn btn-danger btn-sm" data-pp-user-action="cancel-invitation" data-invitation-id="' + escapeHtml(invitation.id) + '">Annuler</button>'
          : '—';
        return `<tr><td>${escapeHtml(invitation.email)}</td><td>${escapeHtml(invitation.roles?.label || '—')}</td><td>${escapeHtml(invitation.establishments?.name || 'Tous périmètres')}</td><td><span class="pp-users-status invited">${escapeHtml(invitation.status)}</span></td><td>${new Date(invitation.expires_at).toLocaleDateString('fr-FR')}</td><td>${actions}</td></tr>`;
      }).join('') || '<tr><td colspan="6">Aucune invitation en attente.</td></tr>';
      const roleButton = App.can('users','manage_roles') ? '<button class="btn btn-outline" type="button" data-pp-user-action="roles">Rôles et permissions</button> ' : '';
      const inviteButton = App.can('users','invite') ? '<button class="btn btn-primary" type="button" data-pp-user-action="invite">Inviter un utilisateur</button>' : '';
      root.innerHTML = `<div class="pp-users-head"><div><h2>Utilisateurs et droits d’accès</h2><p>${escapeHtml(App.context.organization_name)} · les restrictions sont aussi appliquées par Supabase RLS.</p></div>${roleButton || inviteButton ? '<div>' + roleButton + inviteButton + '</div>' : ''}</div><div class="pp-users-card"><h3>Utilisateurs actifs et accès</h3><div style="overflow:auto"><table class="pp-users-table"><thead><tr><th>Utilisateur</th><th>Rôle</th><th>Établissement</th><th>Statut</th><th>Dernière connexion</th><th>Actions</th></tr></thead><tbody>${membersRows}</tbody></table></div></div><div class="pp-users-card"><h3>Invitations</h3><div style="overflow:auto"><table class="pp-users-table"><thead><tr><th>E-mail</th><th>Rôle</th><th>Établissement</th><th>Statut</th><th>Expiration</th><th>Actions</th></tr></thead><tbody>${invitationRows}</tbody></table></div></div>`;
      root.dataset.roles = JSON.stringify(roles);
      root.dataset.establishments = JSON.stringify(establishmentsResult.data || []);
      root.dataset.members = JSON.stringify(members);
    } catch (error) {
      root.innerHTML = '<div class="pp-users-card"><h3>Impossible de charger les droits</h3><p style="padding:0 16px 16px">' + escapeHtml(error.message || 'Erreur inconnue') + '</p></div>';
    }
  }

  function openDialog(content) {
    document.querySelector('.pp-dialog-backdrop')?.remove();
    const backdrop = document.createElement('div');
    backdrop.className = 'pp-dialog-backdrop';
    backdrop.innerHTML = `<div class="pp-dialog" role="dialog" aria-modal="true">${content}</div>`;
    backdrop.addEventListener('click', (event) => { if (event.target === backdrop) backdrop.remove(); });
    document.body.appendChild(backdrop);
    return backdrop;
  }

  async function openSelfServiceDialog() {
    if (!App.context?.employee_id) return;
    try {
      const { data, error } = await App.client.from('employee_self_service').select('*').eq('employee_id', App.context.employee_id).maybeSingle();
      tableError(error, 'Coordonnées personnelles');
      const contact = data || {};
      const emergency = contact.emergency_contact || {};
      const dialog = openDialog(`<h2>Mes coordonnées</h2><p>Ces informations personnelles non sensibles sont visibles uniquement selon les droits RH définis pour votre organisation.</p><form id="pp-self-service-form"><div class="pp-dialog-grid"><label>Téléphone<input name="phone" value="${escapeHtml(contact.phone || '')}" maxlength="40"></label><label>E-mail personnel<input name="personal_email" type="email" value="${escapeHtml(contact.personal_email || '')}" maxlength="160"></label><label style="grid-column:1/-1">Adresse<input name="address" value="${escapeHtml(contact.address || '')}" maxlength="250"></label><label>Contact d’urgence<input name="emergency_name" value="${escapeHtml(emergency.name || '')}" maxlength="120"></label><label>Téléphone urgence<input name="emergency_phone" value="${escapeHtml(emergency.phone || '')}" maxlength="40"></label></div>${dialogButtons('Enregistrer mes coordonnées')}</form>`);
      dialog.querySelector('#pp-self-service-form')?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        try {
          const { error: updateError } = await App.client.from('employee_self_service').upsert({
            employee_id: App.context.employee_id,
            organization_id: App.context.organization_id,
            phone: String(form.get('phone') || '').trim() || null,
            personal_email: String(form.get('personal_email') || '').trim() || null,
            address: String(form.get('address') || '').trim() || null,
            emergency_contact: { name: String(form.get('emergency_name') || '').trim(), phone: String(form.get('emergency_phone') || '').trim() }
          }, { onConflict: 'employee_id' });
          tableError(updateError, 'Coordonnées personnelles');
          dialog.remove(); safeToast('Vos coordonnées ont été enregistrées.', 'ok');
        } catch (updateFailure) { safeToast(updateFailure.message || 'Enregistrement impossible.', 'err'); }
      });
    } catch (error) { safeToast(error.message || 'Impossible de charger vos coordonnées.', 'err'); }
  }

  function getUsersData() {
    const root = document.getElementById('pp-users-root');
    try {
      return {
        roles: JSON.parse(root?.dataset.roles || '[]'),
        establishments: JSON.parse(root?.dataset.establishments || '[]'),
        members: JSON.parse(root?.dataset.members || '[]')
      };
    } catch (_) { return { roles: [], establishments: [], members: [] }; }
  }

  document.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('[data-pp-user-action]') : null;
    if (!button) return;
    const action = button.dataset.ppUserAction;
    if (action === 'invite') openInviteDialog();
    if (action === 'role') void openRoleAssignmentDialog(button.dataset.memberId);
    if (action === 'permissions') void openPermissionsDialog(button.dataset.memberId);
    if (action === 'scope') void openScopeDialog(button.dataset.memberId);
    if (action === 'roles') void openRolesDialog();
    if (action === 'status') void changeMemberStatus(button.dataset.memberId, button.dataset.status);
    if (action === 'resend-invitation') void resendInvitation(button.dataset.invitationId);
    if (action === 'cancel-invitation') void cancelInvitation(button.dataset.invitationId);
  });

  function finishCloudMount() {
    mountUsersView();
    protectActions();
  }

  function dialogButtons(primaryLabel) {
    return `<div class="pp-dialog-actions"><button class="btn btn-outline" type="button" data-pp-action="close-dialog">Annuler</button><button class="btn btn-primary" type="submit">${escapeHtml(primaryLabel)}</button></div>`;
  }

  function openInviteDialog() {
    if (!App.require('users', 'invite')) return;
    const { roles, establishments } = getUsersData();
    const canManagePermissions = App.can('users', 'manage_permissions');
    const roleOptions = roles.filter((role) => role.key !== 'owner' && role.is_active !== false)
      .filter((role) => App.context?.role_key === 'owner' || Number(role.rank) < Number(App.context?.role_rank || 0))
      .map((role) => `<option value="${escapeHtml(role.id)}">${escapeHtml(role.label)}</option>`).join('');
    const establishmentOptions = '<option value="">Tous les établissements autorisés</option>' + establishments.map((establishment) => `<option value="${escapeHtml(establishment.id)}">${escapeHtml(establishment.name)}</option>`).join('');
    const employeeOptions = '<option value="">Choisir un salarié lié</option>' + S.employees.filter((employee) => !employee.archived).map((employee) => `<option value="${escapeHtml(employee.cloudEmployeeId || '')}" ${employee.cloudEmployeeId ? '' : 'disabled'}>${escapeHtml(employee.name || 'Salarié')}${employee.cloudEmployeeId ? '' : ' · synchronisation requise'}</option>`).join('');
    const scopeEditor = canManagePermissions ? '<label>Équipe / service (facultatif)<input name="team_id" maxlength="80" placeholder="ex. Boulangerie"></label>' : '';
    const dialog = openDialog(`<h2>Inviter un utilisateur</h2><p>Le rôle et le périmètre sont appliqués par les règles RLS lors de l’acceptation.</p><form id="pp-invite-form"><div class="pp-dialog-grid"><label>E-mail<input type="email" name="email" required autocomplete="email"></label><label>Rôle<select name="role_id" required>${roleOptions}</select></label><label>Salarié lié (obligatoire pour le rôle Salarié)<select name="employee_id">${employeeOptions}</select></label><label>Établissement principal<select name="establishment_id" ${canManagePermissions ? '' : 'required'}>${establishmentOptions}</select></label>${scopeEditor}<label>Expiration<input type="date" name="expires_at" min="${new Date().toISOString().slice(0,10)}"></label></div>${dialogButtons('Envoyer l’invitation')}</form>`);
    dialog.querySelector('#pp-invite-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const establishmentId = String(form.get('establishment_id') || '');
      const team = String(form.get('team_id') || '').trim();
      const role = roles.find((item) => item.id === String(form.get('role_id') || ''));
      const employeeId = String(form.get('employee_id') || '') || null;
      if (role?.key === 'employee' && !employeeId) { safeToast('Choisissez le salarié correspondant avant d’inviter ce compte.', 'err'); return; }
      const scopes = role?.key === 'employee' ? []
        : !canManagePermissions ? (establishmentId ? [{ scope_type: 'establishment', establishment_id: establishmentId }] : [])
          : team ? [{ scope_type: 'team', team_id: team, establishment_id: establishmentId || null }]
            : establishmentId ? [{ scope_type: 'establishment', establishment_id: establishmentId }] : [{ scope_type: 'organization' }];
      const date = String(form.get('expires_at') || '');
      const expiresAt = date ? new Date(`${date}T23:59:59`).toISOString() : undefined;
      const submit = event.currentTarget.querySelector('[type="submit"]');
      submit.disabled = true;
      try {
        const { data, error } = await App.client.functions.invoke('invite-user', {
          body: {
            organization_id: App.context.organization_id,
            email: String(form.get('email') || ''),
            role_id: String(form.get('role_id') || ''),
            primary_establishment_id: establishmentId || null,
            employee_id: employeeId,
            scopes,
            permission_overrides: [],
            expires_at: expiresAt
          }
        });
        if (error) throw error;
        dialog.remove();
        safeToast(data?.emailed ? 'Invitation envoyée par e-mail.' : 'Invitation créée. Partagez le lien sécurisé affiché.', data?.emailed ? 'ok' : 'warn');
        if (data?.accept_url) window.prompt('Lien sécurisé à transmettre à un compte existant :', data.accept_url);
        await App.client.rpc('log_audit_event', { p_organization_id: App.context.organization_id, p_action: 'invitation.sent', p_resource_type: 'invitation', p_resource_id: data?.invitation_id || null });
        await loadUsersView();
      } catch (error) {
        safeToast(error.message || 'Invitation impossible. Vérifiez que la fonction Edge est déployée.', 'err');
      } finally { submit.disabled = false; }
    });
  }

  async function cancelInvitation(invitationId) {
    if (!App.require('users', 'invite') || !invitationId) return;
    if (!window.confirm('Supprimer cette invitation non acceptée ?')) return;
    try {
      const { error } = await App.client.from('invitations').delete().eq('id', invitationId);
      tableError(error, 'Invitation');
      safeToast('Invitation supprimée.', 'ok');
      await loadUsersView();
    } catch (error) { safeToast(error.message || 'Suppression impossible.', 'err'); }
  }

  async function resendInvitation(invitationId) {
    if (!App.require('users', 'invite') || !invitationId) return;
    try {
      const { data, error } = await App.client.functions.invoke('invite-user', {
        body: { resend_invitation_id: invitationId }
      });
      if (error) throw error;
      safeToast(data?.emailed ? 'Invitation renvoyée par e-mail.' : 'Nouvelle invitation créée : partagez le lien sécurisé.', data?.emailed ? 'ok' : 'warn');
      if (data?.accept_url) window.prompt('Lien sécurisé à transmettre à un compte existant :', data.accept_url);
      await App.client.rpc('log_audit_event', { p_organization_id: App.context.organization_id, p_action: 'invitation.resent', p_resource_type: 'invitation', p_resource_id: data?.invitation_id || null });
      await loadUsersView();
    } catch (error) { safeToast(error.message || 'Renvoi impossible. Vérifiez que la fonction Edge est déployée.', 'err'); }
  }

  async function changeMemberStatus(memberId, status) {
    const requiredPermission = status === 'active' ? 'reactivate' : 'disable';
    if (!App.require('users', requiredPermission) || !memberId) return;
    const verb = status === 'active' ? 'réactiver' : 'suspendre';
    if (!window.confirm(`Voulez-vous ${verb} ce compte ?`)) return;
    try {
      const { data, error } = await App.client.functions.invoke('revoke-user-sessions', { body: { member_id: memberId, status } });
      if (error) throw error;
      safeToast(status === 'active' ? 'Accès réactivé.' : 'Compte suspendu : l’accès aux données est révoqué immédiatement.', 'ok');
      await loadUsersView();
    } catch (error) { safeToast(error.message || 'Mise à jour du compte impossible.', 'err'); }
  }

  function groupPermissions(permissions) {
    return permissions.filter((permission) => !DEPRECATED_PERMISSIONS.has(permission.key)).reduce((groups, permission) => {
      (groups[permission.module] ||= []).push(permission);
      return groups;
    }, {});
  }

  async function openRoleAssignmentDialog(memberId) {
    if (!App.require('users', 'manage_roles') || !memberId) return;
    const { members, roles } = getUsersData();
    const member = members.find((item) => item.id === memberId);
    if (!member) return;
    const availableRoles = roles.filter((role) => {
      if (App.context?.role_key === 'owner') return true;
      return Number(role.rank) < Number(App.context?.role_rank || 0);
    }).filter((role) => role.is_active !== false).filter((role) => role.key !== 'employee' || member.employee_id);
    if (!availableRoles.length) { safeToast('Aucun rôle que votre profil puisse attribuer.', 'err'); return; }
    const dialog = openDialog(`<h2>Attribuer un rôle</h2><p>${escapeHtml(member.profiles?.full_name || member.profiles?.email || 'Utilisateur')} · le périmètre et les règles RLS restent appliqués après le changement.</p><form id="pp-member-role-form"><div class="pp-dialog-grid"><label>Rôle<select name="role_id">${availableRoles.map((role) => `<option value="${escapeHtml(role.id)}" ${role.id === member.role_id ? 'selected' : ''}>${escapeHtml(role.label)}</option>`).join('')}</select></label></div>${dialogButtons('Enregistrer le rôle')}</form>`);
    dialog.querySelector('#pp-member-role-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const fields = new FormData(event.currentTarget);
      try {
        const { error } = await App.client.from('organization_members').update({ role_id: String(fields.get('role_id') || '') }).eq('id', memberId);
        tableError(error, 'Rôle');
        dialog.remove(); safeToast('Rôle mis à jour.', 'ok'); await loadUsersView();
      } catch (error) { safeToast(error.message || 'Changement de rôle impossible.', 'err'); }
    });
  }

  async function openPermissionsDialog(memberId) {
    if (!App.require('users', 'manage_permissions') || !memberId) return;
    try {
      const [permissionsResult, overridesResult] = await Promise.all([
        App.client.from('permissions').select('*').order('module').order('action'),
        App.client.from('user_permissions').select('permission_key,effect').eq('organization_id', App.context.organization_id).eq('user_id', getUsersData().members.find((member) => member.id === memberId)?.user_id || '')
      ]);
      tableError(permissionsResult.error, 'Permissions');
      tableError(overridesResult.error, 'Permissions individuelles');
      const member = getUsersData().members.find((item) => item.id === memberId);
      if (!member) throw new Error('Utilisateur introuvable');
      const overrides = new Map((overridesResult.data || []).map((item) => [item.permission_key, item.effect]));
      const groups = groupPermissions(permissionsResult.data || []);
      const matrix = Object.entries(groups).map(([module, permissions]) => `<div style="margin:13px 0 6px;font-size:12px;font-weight:800;text-transform:capitalize">${escapeHtml(module)}</div><div class="pp-permission-grid">${permissions.map((permission) => `<label>${escapeHtml(permission.label)}<select data-pp-override="${escapeHtml(permission.key)}"><option value="">Hériter du rôle</option><option value="grant" ${overrides.get(permission.key) === 'grant' ? 'selected' : ''}>Accorder</option><option value="revoke" ${overrides.get(permission.key) === 'revoke' ? 'selected' : ''}>Retirer</option></select></label>`).join('')}</div>`).join('');
      const dialog = openDialog(`<h2>Droits individuels</h2><p>${escapeHtml(member.profiles?.full_name || member.profiles?.email || 'Utilisateur')} · les droits individuels complètent ou retirent ceux du rôle.</p><form id="pp-overrides-form" data-user-id="${escapeHtml(member.user_id)}">${matrix}${dialogButtons('Enregistrer les droits')}</form>`);
      dialog.querySelector('#pp-overrides-form')?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const userId = event.currentTarget.dataset.userId;
        const desired = Array.from(event.currentTarget.querySelectorAll('[data-pp-override]')).map((select) => ({ key: select.dataset.ppOverride, effect: select.value })).filter((item) => item.effect);
        const remove = Array.from(overrides.keys()).filter((key) => !desired.some((item) => item.key === key));
        const submit = event.currentTarget.querySelector('[type="submit"]'); submit.disabled = true;
        try {
          if (remove.length) {
            const { error } = await App.client.from('user_permissions').delete().eq('organization_id', App.context.organization_id).eq('user_id', userId).in('permission_key', remove);
            tableError(error, 'Suppression des exceptions');
          }
          if (desired.length) {
            const rows = desired.map((item) => ({ organization_id: App.context.organization_id, user_id: userId, permission_key: item.key, effect: item.effect }));
            const { error } = await App.client.from('user_permissions').upsert(rows, { onConflict: 'organization_id,user_id,permission_key' });
            tableError(error, 'Enregistrement des exceptions');
          }
          dialog.remove(); safeToast('Droits individuels enregistrés.', 'ok'); await loadUsersView();
        } catch (error) { safeToast(error.message || 'Enregistrement impossible.', 'err'); }
        finally { submit.disabled = false; }
      });
    } catch (error) { safeToast(error.message || 'Impossible de charger les permissions.', 'err'); }
  }

  async function openScopeDialog(memberId) {
    if (!App.require('users', 'manage_permissions') || !memberId) return;
    const { establishments, members } = getUsersData();
    const member = members.find((item) => item.id === memberId);
    if (!member) return;
    try {
      const { data: scopes, error } = await App.client.from('manager_scopes').select('*').eq('member_id', memberId);
      tableError(error, 'Périmètres');
      const first = scopes?.[0] || { scope_type: 'organization' };
      const options = establishments.map((establishment) => `<option value="${escapeHtml(establishment.id)}" ${first.establishment_id === establishment.id ? 'selected' : ''}>${escapeHtml(establishment.name)}</option>`).join('');
      const dialog = openDialog(`<h2>Périmètre d’accès</h2><p>${escapeHtml(member.profiles?.full_name || member.profiles?.email || 'Utilisateur')} — les autorisations sont limitées à ce périmètre, y compris via les requêtes directes.</p><form id="pp-scope-form"><div class="pp-dialog-grid"><label>Type de périmètre<select name="scope_type"><option value="organization" ${first.scope_type === 'organization' ? 'selected' : ''}>Toute l’entreprise</option><option value="establishment" ${first.scope_type === 'establishment' ? 'selected' : ''}>Un établissement</option><option value="team" ${first.scope_type === 'team' ? 'selected' : ''}>Une équipe</option><option value="service" ${first.scope_type === 'service' ? 'selected' : ''}>Un service</option></select></label><label>Établissement<select name="establishment_id"><option value="">—</option>${options}</select></label><label>Équipe<input name="team_id" value="${escapeHtml(first.team_id || '')}" maxlength="80"></label><label>Service<input name="service_id" value="${escapeHtml(first.service_id || '')}" maxlength="80"></label></div>${dialogButtons('Enregistrer le périmètre')}</form>`);
      dialog.querySelector('#pp-scope-form')?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const scopeType = String(form.get('scope_type'));
        const establishmentId = String(form.get('establishment_id') || '') || null;
        const teamId = String(form.get('team_id') || '').trim() || null;
        const serviceId = String(form.get('service_id') || '').trim() || null;
        if ((scopeType === 'establishment' || scopeType === 'team') && !establishmentId && scopeType === 'establishment') { safeToast('Choisissez un établissement.', 'err'); return; }
        if (scopeType === 'team' && !teamId) { safeToast('Indiquez une équipe.', 'err'); return; }
        if (scopeType === 'service' && !serviceId) { safeToast('Indiquez un service.', 'err'); return; }
        try {
          const { error: deleteError } = await App.client.from('manager_scopes').delete().eq('member_id', memberId);
          tableError(deleteError, 'Suppression du périmètre précédent');
          const { error: insertError } = await App.client.from('manager_scopes').insert({ organization_id: App.context.organization_id, member_id: memberId, scope_type: scopeType, establishment_id: scopeType === 'organization' ? null : establishmentId, team_id: scopeType === 'team' ? teamId : null, service_id: scopeType === 'service' ? serviceId : null });
          tableError(insertError, 'Enregistrement du périmètre');
          dialog.remove(); safeToast('Périmètre enregistré.', 'ok'); await loadUsersView();
        } catch (error) { safeToast(error.message || 'Périmètre impossible à enregistrer.', 'err'); }
      });
    } catch (error) { safeToast(error.message || 'Chargement du périmètre impossible.', 'err'); }
  }

  async function openRolesDialog(selectedRoleId) {
    if (!App.require('users', 'manage_roles')) return;
    try {
      const { data: roles, error: rolesError } = await App.client.from('roles').select('*').eq('organization_id', App.context.organization_id).order('rank', { ascending: false });
      tableError(rolesError, 'Rôles');
      const manageableRoles = (roles || []).filter((item) => App.context?.role_key === 'owner'
        || Number(item.rank) < Number(App.context?.role_rank || 0));
      const role = manageableRoles.find((item) => item.id === selectedRoleId) || manageableRoles[0];
      if (!role) throw new Error('Aucun rôle disponible');
      const [permissionsResult, rolePermissionsResult] = await Promise.all([
        App.client.from('permissions').select('*').order('module').order('action'),
        App.client.from('role_permissions').select('permission_key').eq('role_id', role.id)
      ]);
      tableError(permissionsResult.error, 'Permissions');
      tableError(rolePermissionsResult.error, 'Droits du rôle');
      const selected = new Set((rolePermissionsResult.data || []).map((item) => item.permission_key));
      const canEditPermissions = App.can('users', 'manage_permissions');
      const roleOptions = manageableRoles.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === role.id ? 'selected' : ''}>${escapeHtml(item.label)}${item.is_active === false ? ' · désactivé' : ''}</option>`).join('');
      const groups = groupPermissions(permissionsResult.data || []);
      const matrix = Object.entries(groups).map(([module, permissions]) => `<section class="pp-role-module"><div style="margin:13px 0 6px;font-size:12px;font-weight:800;text-transform:capitalize">${escapeHtml(module)}</div><div class="pp-permission-grid">${permissions.map((permission) => `<label><input type="checkbox" value="${escapeHtml(permission.key)}" ${selected.has(permission.key) ? 'checked' : ''} ${canEditPermissions ? '' : 'disabled'}>${escapeHtml(permission.label)}</label>`).join('')}</div></section>`).join('');
      const activeControl = role.key === 'owner' ? '<input type="hidden" name="is_active" value="on"><span>Le rôle Super Administrateur reste toujours actif.</span>' : `<label style="display:flex;align-items:center;gap:8px"><input type="checkbox" name="is_active" ${role.is_active === false ? '' : 'checked'}>Rôle actif</label>`;
      const dialog = openDialog(`<h2>Rôles et permissions</h2><p>Les changements sont vérifiés par PostgreSQL et appliqués immédiatement dans l’interface, l’API, RLS et Realtime.</p><form id="pp-role-form"><div class="pp-dialog-grid"><label>Rôle<select name="role_id" onchange="window.PlanniProCloud.openRolesDialog(this.value)">${roleOptions}</select></label><label>Nom du rôle<input name="role_label" maxlength="80" value="${escapeHtml(role.label)}" required></label><div>${activeControl}</div><label>Nouveau rôle<input name="new_role" maxlength="80" placeholder="ex. Responsable régional"></label></div><div class="pp-dialog-actions" style="justify-content:flex-start"><button class="btn btn-outline" type="button" data-pp-rbac-action="create">Créer</button><button class="btn btn-outline" type="button" data-pp-rbac-action="duplicate">Dupliquer ce rôle</button></div>${matrix}${dialogButtons(canEditPermissions ? 'Enregistrer le rôle et la matrice' : 'Enregistrer le rôle')}</form>`);
      dialog.querySelector('[data-pp-rbac-action="create"]')?.addEventListener('click', async () => {
        const label = String(new FormData(dialog.querySelector('#pp-role-form')).get('new_role') || '').trim();
        if (!label) return safeToast('Indiquez le nom du nouveau rôle.', 'err');
        try {
          const proposedRank = Math.max(1, Math.min(50, Number(App.context.role_rank || 51) - 1));
          const { data, error } = await App.client.rpc('create_custom_role', { p_organization_id: App.context.organization_id, p_label: label, p_rank: proposedRank });
          tableError(error, 'Création du rôle');
          dialog.remove(); safeToast('Rôle créé.', 'ok'); await openRolesDialog(data?.id);
        } catch (error) { safeToast(error.message || 'Création impossible.', 'err'); }
      });
      dialog.querySelector('[data-pp-rbac-action="duplicate"]')?.addEventListener('click', async () => {
        const label = String(new FormData(dialog.querySelector('#pp-role-form')).get('new_role') || '').trim();
        if (!label) return safeToast('Indiquez le nom de la copie.', 'err');
        try {
          const { data, error } = await App.client.rpc('duplicate_role', { p_source_role_id: role.id, p_label: label });
          tableError(error, 'Duplication du rôle');
          dialog.remove(); safeToast('Rôle dupliqué.', 'ok'); await openRolesDialog(data?.id);
        } catch (error) { safeToast(error.message || 'Duplication impossible.', 'err'); }
      });
      dialog.querySelector('#pp-role-form')?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const roleId = String(form.get('role_id'));
        const label = String(form.get('role_label') || '').trim();
        const isActive = form.get('is_active') === 'on';
        try {
          const desired = Array.from(event.currentTarget.querySelectorAll('input[type="checkbox"][value]:checked')).map((input) => input.value);
          const { error: roleError } = await App.client.rpc('update_role_configuration', { p_role_id: roleId, p_label: label, p_is_active: isActive });
          tableError(roleError, 'Configuration du rôle');
          if (canEditPermissions) {
            const { error: matrixError } = await App.client.rpc('set_role_permissions', { p_role_id: roleId, p_permission_keys: desired });
            tableError(matrixError, 'Matrice des permissions');
          }
          dialog.remove(); safeToast('Rôle et permissions enregistrés.', 'ok'); await refreshPermissions(); await loadUsersView();
        } catch (error) { safeToast(error.message || 'Matrice impossible à enregistrer.', 'err'); }
      });
    } catch (error) { safeToast(error.message || 'Impossible de charger la matrice.', 'err'); }
  }

  // Exposed solely for the role selector rendered in the dialog above.
  App.openRolesDialog = (roleId) => { void openRolesDialog(roleId); };

  window.addEventListener('load', () => { void init(); }, { once: true });
}());
