/* PlanniPro Pointeuse — tablette hors ligne, synchronisation par Supabase RPC. */
(function () {
  'use strict';

  const root = document.getElementById('time-clock-root');
  const config = window.PLANNIPRO_SUPABASE_CONFIG;
  const DB_NAME = 'plannipro-time-clock';
  const DB_VERSION = 1;
  const PBKDF2_ITERATIONS = 310000;
  const MAX_LOCAL_ATTEMPTS = 5;
  const LOCAL_LOCK_MS = 5 * 60 * 1000;

  if (!root || !config?.url || !config?.publishableKey || !window.supabase?.createClient) {
    if (root) root.innerHTML = '<div class="tc-empty">La configuration sécurisée de la pointeuse est indisponible.</div>';
    return;
  }

  // A manager session only exists in memory during configuration. The kiosk
  // never persists an e-mail/password session in localStorage.
  const api = window.supabase.createClient(config.url, config.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });

  const state = {
    device: null,
    roster: [],
    queue: [],
    screen: 'loading',
    search: '',
    selectedEmployeeId: null,
    pin: '',
    verified: null,
    message: null,
    busy: false,
    manager: null,
    managerPurpose: 'pair',
    managerEmployees: [],
    managerDevices: [],
    setupOrganizationId: '',
    setupEstablishments: [],
    pinTargetId: null,
    localFailures: 0,
    localLockedUntil: 0,
    lastSyncError: null
  };

  const escapeHtml = (value) => String(value == null ? '' : value).replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[char]));
  const byId = (id) => document.getElementById(id);
  const asArray = (value) => Array.isArray(value) ? value : [];
  const nowIso = () => new Date().toISOString();

  function appError(message) {
    const error = new Error(message || 'Une erreur est survenue.');
    error.userMessage = message;
    return error;
  }

  function errorMessage(error) {
    const message = String(error?.message || error?.userMessage || 'Opération impossible pour le moment.');
    if (/not authorized|permission|JWT|row-level|rls/i.test(message)) return 'Cette action n’est pas autorisée pour ce profil.';
    if (/time clock is no longer active|not authorized/i.test(message)) return 'Cette tablette a été désactivée.';
    if (/invalid time clock code/i.test(message)) return 'Code personnel incorrect.';
    if (/offline badge proof/i.test(message)) return 'Ce badge hors ligne doit être vérifié par un manager.';
    if (/temporarily locked/i.test(message)) return 'La tablette est temporairement verrouillée après plusieurs essais.';
    if (/timestamp/i.test(message)) return 'L’heure du badge est invalide. Vérifiez l’heure de la tablette.';
    if (/attendance state/i.test(message)) return 'Cette action ne correspond pas au dernier badge enregistré.';
    if (/failed to fetch|network|fetch failed/i.test(message)) return 'Connexion indisponible : le badge reste en attente.';
    return message.length > 180 ? 'Opération impossible pour le moment.' : message;
  }

  function isNetworkFailure(error) {
    return !navigator.onLine || /failed to fetch|network|fetch failed|timeout|load failed/i.test(String(error?.message || ''));
  }

  function bytesToBase64(bytes) {
    let binary = '';
    bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
    return btoa(binary);
  }

  function base64ToBytes(value) {
    const binary = atob(String(value || ''));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  function randomBytes(size) {
    const bytes = new Uint8Array(size);
    window.crypto.getRandomValues(bytes);
    return bytes;
  }

  function newId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    const bytes = randomBytes(16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  async function sha256Hex(value) {
    const bytes = new TextEncoder().encode(String(value));
    const digest = await window.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  async function deriveOfflineHash(pin, saltBase64, iterations) {
    const material = await window.crypto.subtle.importKey('raw', new TextEncoder().encode(String(pin)), 'PBKDF2', false, ['deriveBits']);
    const bits = await window.crypto.subtle.deriveBits({
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: base64ToBytes(saltBase64),
      iterations: Number(iterations || PBKDF2_ITERATIONS)
    }, material, 256);
    return bytesToBase64(new Uint8Array(bits));
  }

  async function proofForEvent(employee, event) {
    const key = await window.crypto.subtle.importKey('raw', base64ToBytes(employee.offline_hash), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const message = `${event.deviceId}|${event.employeeId}|${event.eventType}|${event.occurredAt}|${event.id}`;
    const signature = await window.crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
    return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  function sameValue(left, right) {
    const a = String(left || '');
    const b = String(right || '');
    if (a.length !== b.length) return false;
    let difference = 0;
    for (let index = 0; index < a.length; index += 1) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
    return difference === 0;
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(appError('IndexedDB est nécessaire au mode hors connexion.'));
      const request = window.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('queue')) db.createObjectStore('queue', { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || appError('Impossible d’ouvrir le cache local.'));
    });
  }

  async function dbGet(store, key) {
    const db = await openDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const request = db.transaction(store, 'readonly').objectStore(store).get(key);
        request.onsuccess = () => resolve(request.result ? request.result.value : null);
        request.onerror = () => reject(request.error || appError('Lecture locale impossible.'));
      });
    } finally { db.close(); }
  }

  async function dbSet(store, key, value) {
    const db = await openDatabase();
    try {
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(store, 'readwrite');
        transaction.objectStore(store).put(store === 'queue' ? value : { key, value });
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || appError('Écriture locale impossible.'));
      });
    } finally { db.close(); }
  }

  async function dbDelete(store, key) {
    const db = await openDatabase();
    try {
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(store, 'readwrite');
        transaction.objectStore(store).delete(key);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || appError('Suppression locale impossible.'));
      });
    } finally { db.close(); }
  }

  async function dbAll(store) {
    const db = await openDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const request = db.transaction(store, 'readonly').objectStore(store).getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error || appError('Lecture de la file impossible.'));
      });
    } finally { db.close(); }
  }

  async function deviceCryptoKey() {
    let key = await dbGet('kv', 'device-crypto-key');
    if (key) return key;
    key = await window.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await dbSet('kv', 'device-crypto-key', key);
    return key;
  }

  async function encryptDeviceSecret(secret) {
    const iv = randomBytes(12);
    const key = await deviceCryptoKey();
    const encrypted = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(secret));
    return { iv: bytesToBase64(iv), data: bytesToBase64(new Uint8Array(encrypted)) };
  }

  async function decryptDeviceSecret(cipher) {
    if (!cipher?.iv || !cipher?.data) throw appError('Le secret local de cette tablette est indisponible. Reconfigurez l’appareil.');
    const key = await deviceCryptoKey();
    const decrypted = await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(cipher.iv) }, key, base64ToBytes(cipher.data));
    return new TextDecoder().decode(decrypted);
  }

  async function callRpc(name, args) {
    const { data, error } = await api.rpc(name, args || {});
    if (error) throw error;
    const parsed = data && typeof data === 'string' ? JSON.parse(data) : data;
    if (parsed && typeof parsed === 'object' && parsed.error) throw appError(parsed.error);
    return parsed;
  }

  function hasPermission(context, key) {
    return asArray(context?.permissions).some((permission) => permission?.key === key && permission?.allowed);
  }

  function activeManagerContexts(contexts, required) {
    const keys = required ? asArray(required) : [
      'pointage.edit_schedule', 'pointage.suspend_device',
      'pointage.reactivate_device', 'pointage.manage_settings'
    ];
    return asArray(contexts).filter((context) => keys.some((key) => hasPermission(context, key)));
  }

  function managerCan(key, organizationId) {
    return activeManagerContexts(state.manager?.contexts, [key, 'pointage.manage_settings'])
      .some((context) => !organizationId || context.organization_id === organizationId);
  }

  function employeeById(id) {
    return state.roster.find((employee) => employee.employee_id === id) || null;
  }

  function employeeName(employee) {
    return String(employee?.display_name || 'Collaborateur').trim() || 'Collaborateur';
  }

  function employeeInitials(employee) {
    return employeeName(employee).split(/\s+/).map((part) => part[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
  }

  function eventLabel(type) {
    return ({
      clock_in: 'Entrée',
      break_start: 'Début de pause',
      break_end: 'Reprise',
      clock_out: 'Sortie'
    })[type] || 'Badge';
  }

  function employeeAttendanceState(employeeId) {
    const employee = employeeById(employeeId);
    let last = employee?.last_event_type || null;
    let at = employee?.last_event_at || null;
    state.queue
      .filter((event) => event.employeeId === employeeId && event.status === 'pending')
      .sort((left, right) => String(left.occurredAt).localeCompare(String(right.occurredAt)))
      .forEach((event) => { last = event.eventType; at = event.occurredAt; });
    return { type: last, at };
  }

  function deviceCanBadge() {
    return state.device?.status === 'active';
  }

  function attendanceLabel(employeeId) {
    const current = employeeAttendanceState(employeeId).type;
    if (current === 'clock_in' || current === 'break_end') return 'En poste';
    if (current === 'break_start') return 'En pause';
    return 'À pointer';
  }

  function allowedActions(employeeId) {
    const current = employeeAttendanceState(employeeId).type;
    if (!current || current === 'clock_out') return ['clock_in'];
    if (current === 'break_start') return ['break_end'];
    return ['break_start', 'clock_out'];
  }

  function connectionKind() {
    if (!navigator.onLine) return 'pending';
    if (state.lastSyncError) return 'error';
    return state.queue.some((event) => event.status === 'pending') ? 'pending' : 'online';
  }

  function connectionText() {
    const pending = state.queue.filter((event) => event.status === 'pending').length;
    const blocked = state.queue.filter((event) => event.status === 'blocked').length;
    if (!navigator.onLine) return pending ? `${pending} badge${pending > 1 ? 's' : ''} en attente · hors connexion` : 'Hors connexion';
    if (blocked) return `${blocked} badge${blocked > 1 ? 's' : ''} à vérifier`;
    if (pending) return `${pending} badge${pending > 1 ? 's' : ''} en attente`;
    return 'Synchronisé';
  }

  function topbar() {
    const deviceName = state.device?.name || 'Configuration requise';
    return `<header class="tc-top"><div class="tc-brand"><span class="tc-brand-mark">✓</span><span>Planni<b>Pro</b></span></div><div class="tc-device"><span class="tc-status ${connectionKind()}">${escapeHtml(connectionText())}</span><span>· ${escapeHtml(deviceName)}</span><button class="tc-icon-btn" type="button" data-tc-action="open-manager" aria-label="Configuration de la tablette" title="Configuration">⚙</button></div></header>`;
  }

  function setRoot(html) {
    root.className = '';
    root.innerHTML = html;
    updateClock();
  }

  function updateClock() {
    const time = new Date();
    const timeNode = byId('tc-clock-time');
    const dateNode = byId('tc-clock-date');
    if (timeNode) timeNode.textContent = time.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    if (dateNode) dateNode.textContent = time.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }

  function messageHtml() {
    if (!state.message) return '';
    return `<div class="tc-message ${state.message.kind || ''}">${escapeHtml(state.message.text)}</div>`;
  }

  function render() {
    if (state.screen === 'manager-login') return renderManagerLogin();
    if (state.screen === 'pair-device') return renderPairDevice();
    if (state.screen === 'manager-console') return renderManagerConsole();
    if (state.screen === 'device-list') return renderDeviceList();
    if (state.screen === 'set-pin') return renderSetPin();
    if (state.screen === 'pin-entry') return renderPinEntry();
    if (state.screen === 'choose-action') return renderChooseAction();
    if (!state.device) return renderUnconfigured();
    return renderKiosk();
  }

  function renderUnconfigured() {
    setRoot(`${topbar()}<section class="tc-main"><article class="tc-card tc-dialog" style="margin:clamp(18px,9vh,82px) auto"><p class="tc-overline">Pointeuse tablette</p><h2>Cette tablette n’est pas encore enregistrée.</h2><p>Un gérant ou un manager habilité doit l’associer à un établissement, puis définir les codes individuels des collaborateurs. Aucun mot de passe manager ne restera sur cet appareil.</p>${messageHtml()}<div class="tc-dialog-actions"><button class="tc-btn" type="button" data-tc-action="start-device-management">Gérer les pointeuses</button><button class="tc-btn primary" type="button" data-tc-action="start-pair">Configurer la tablette</button></div><div class="tc-note">Les pointages sont conservés localement en cas de coupure, puis synchronisés dès le retour d’Internet.</div></article></section>`);
  }

  function renderKiosk() {
    const query = state.search.trim().toLocaleLowerCase('fr-FR');
    const employees = state.roster.filter((employee) => employeeName(employee).toLocaleLowerCase('fr-FR').includes(query));
    const pending = state.queue.filter((event) => event.status === 'pending').length;
    const blocked = state.queue.filter((event) => event.status === 'blocked').length;
    const active = deviceCanBadge();
    const cards = employees.map((employee) => `<button class="tc-employee" type="button" data-tc-action="select-employee" data-tc-employee="${escapeHtml(employee.employee_id)}" ${active ? '' : 'disabled'}><span class="tc-avatar">${escapeHtml(employeeInitials(employee))}</span><span class="tc-employee-name">${escapeHtml(employeeName(employee))}</span><span class="tc-employee-state">${escapeHtml(attendanceLabel(employee.employee_id))}</span></button>`).join('');
    const availabilityMessage = active
      ? messageHtml()
      : '<div class="tc-message error">Cette tablette a été désactivée. Contactez un manager.</div>';
    setRoot(`${topbar()}<section class="tc-main"><article class="tc-card tc-hero"><div><p class="tc-overline">${escapeHtml(state.device?.name || 'Pointeuse')}</p><h1>Qui pointe maintenant&nbsp;?</h1><p>Sélectionnez votre nom, saisissez votre code personnel puis choisissez votre action.</p></div><div class="tc-clock"><div class="tc-clock-time" id="tc-clock-time"></div><div class="tc-clock-date" id="tc-clock-date"></div></div></article>${availabilityMessage}<article class="tc-card tc-section"><div class="tc-section-head"><div><h2>Équipe de l’établissement</h2><p class="tc-sub">Seuls les collaborateurs avec un code actif apparaissent ici.</p></div><span class="tc-badge ${pending || blocked ? 'pending' : 'ok'}">${escapeHtml(connectionText())}</span></div><input id="tc-search" class="tc-search" type="search" autocomplete="off" placeholder="Rechercher un collaborateur" value="${escapeHtml(state.search)}" aria-label="Rechercher un collaborateur"><div class="tc-grid">${cards || '<div class="tc-empty">Aucun collaborateur avec un code actif. Ouvrez la configuration pour créer les codes.</div>'}</div></article><footer class="tc-footer"><span>Les badges ne modifient jamais le planning prévu.</span><span>${blocked ? `${blocked} badge${blocked > 1 ? 's' : ''} nécessitent une vérification` : pending ? 'Synchronisation automatique en attente' : active ? 'Mode hors connexion disponible' : 'Pointage suspendu'}</span></footer></section>`);
  }

  function renderPinEntry() {
    const employee = employeeById(state.selectedEmployeeId);
    if (!employee) { state.screen = state.device ? 'kiosk' : 'loading'; return render(); }
    const dots = Array.from({ length: 6 }, (_, index) => `<span class="tc-pin-dot ${index < state.pin.length ? 'filled' : ''}"></span>`).join('');
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'cancel', '0', 'back'].map((key) => {
      const label = key === 'cancel' ? 'Annuler' : key === 'back' ? '⌫' : key;
      const cls = key === 'cancel' || key === 'back' ? ' subtle' : '';
      return `<button class="tc-key${cls}" type="button" data-tc-action="pin-key" data-tc-key="${key}">${label}</button>`;
    }).join('');
    setRoot(`${topbar()}<section class="tc-main"><article class="tc-dialog" style="margin:clamp(12px,6vh,56px) auto"><p class="tc-overline">Identification</p><h2>Saisissez votre code personnel</h2><div class="tc-pin-person"><span class="tc-avatar">${escapeHtml(employeeInitials(employee))}</span><strong>${escapeHtml(employeeName(employee))}</strong></div>${messageHtml()}<div class="tc-pin-dots" aria-label="Code à six chiffres">${dots}</div><div class="tc-keypad">${keys}</div><button class="tc-btn tc-back" type="button" data-tc-action="back-kiosk">← Retour à l’équipe</button></article></section>`);
  }

  function actionCard(type) {
    const styles = { clock_in: 'in', break_start: 'pause', break_end: 'in', clock_out: 'out' };
    const copy = {
      clock_in: ['Entrée', 'Je commence mon service'],
      break_start: ['Début de pause', 'Je pars en pause'],
      break_end: ['Reprise', 'Je reprends mon service'],
      clock_out: ['Sortie', 'Je termine mon service']
    }[type];
    return `<button type="button" class="tc-action ${styles[type]}" data-tc-action="record-badge" data-tc-event="${type}"><strong>${copy[0]}</strong><span>${copy[1]}</span></button>`;
  }

  function renderChooseAction() {
    const employee = employeeById(state.verified?.employeeId);
    if (!employee || !state.verified || state.verified.expiresAt < Date.now()) {
      state.verified = null; state.pin = ''; state.screen = 'pin-entry'; return render();
    }
    const status = attendanceLabel(employee.employee_id);
    setRoot(`${topbar()}<section class="tc-main"><article class="tc-dialog" style="margin:clamp(12px,7vh,62px) auto"><p class="tc-overline">${escapeHtml(status)}</p><h2>Bonjour ${escapeHtml(employeeName(employee).split(/\s+/)[0])}</h2><p>Quelle action souhaitez-vous enregistrer&nbsp;?</p>${messageHtml()}<div class="tc-actions-grid">${allowedActions(employee.employee_id).map(actionCard).join('')}</div><div class="tc-dialog-actions"><button class="tc-btn" type="button" data-tc-action="cancel-verified">Annuler</button></div></article></section>`);
  }

  function renderManagerLogin() {
    const title = state.managerPurpose === 'pair' ? 'Configurer la tablette' : 'Accès manager';
    setRoot(`${topbar()}<section class="tc-main"><article class="tc-dialog" style="margin:clamp(18px,7vh,72px) auto"><p class="tc-overline">Accès sécurisé</p><h2>${title}</h2><p>Connectez-vous temporairement avec un compte disposant du droit requis pour cette action sur la pointeuse. La session sera effacée lorsque vous aurez terminé.</p>${messageHtml()}<form class="tc-form" id="tc-manager-login"><label class="tc-label">Adresse e-mail<input class="tc-field" name="email" type="email" autocomplete="username" required></label><label class="tc-label">Mot de passe<input class="tc-field" name="password" type="password" autocomplete="current-password" required minlength="8"></label><div class="tc-dialog-actions"><button class="tc-btn" type="button" data-tc-action="back-kiosk">Annuler</button><button class="tc-btn primary" type="submit" ${state.busy ? 'disabled' : ''}>${state.busy ? 'Connexion…' : 'Continuer'}</button></div></form></article></section>`);
  }

  function renderPairDevice() {
    const contexts = activeManagerContexts(state.manager?.contexts, ['pointage.edit_schedule', 'pointage.manage_settings']);
    const selectedContext = contexts.find((context) => context.organization_id === state.setupOrganizationId) || contexts[0];
    const establishmentOptions = state.setupEstablishments.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join('');
    setRoot(`${topbar()}<section class="tc-main"><article class="tc-dialog" style="margin:clamp(12px,5vh,52px) auto"><div class="tc-config-top"><div><p class="tc-overline">Association de la tablette</p><h2>Choisir l’établissement</h2></div><span class="tc-badge">Étape 1 / 2</span></div><p>Cette tablette n’affichera que les collaborateurs autorisés de l’établissement sélectionné.</p><div class="tc-setup-steps"><span class="tc-step on"></span><span class="tc-step"></span></div>${messageHtml()}<form class="tc-form" id="tc-pair-device"><label class="tc-label">Entreprise<select class="tc-field" name="organization_id" data-tc-change="setup-organization">${contexts.map((context) => `<option value="${escapeHtml(context.organization_id)}" ${context.organization_id === selectedContext?.organization_id ? 'selected' : ''}>${escapeHtml(context.organization_name)}</option>`).join('')}</select></label><label class="tc-label">Établissement<select class="tc-field" name="establishment_id" required>${establishmentOptions || '<option value="">Aucun établissement accessible</option>'}</select></label><label class="tc-label">Nom de la tablette<input class="tc-field" name="device_name" required minlength="2" maxlength="80" value="Pointeuse accueil" placeholder="ex. Pointeuse réserve"></label><label class="tc-label">Fuseau horaire<select class="tc-field" name="timezone"><option value="Europe/Paris">Europe/Paris</option></select></label><div class="tc-dialog-actions"><button class="tc-btn" type="button" data-tc-action="close-manager">Annuler</button><button class="tc-btn primary" type="submit" ${!establishmentOptions || state.busy ? 'disabled' : ''}>${state.busy ? 'Association…' : 'Associer la tablette'}</button></div></form><div class="tc-note">Un secret aléatoire est créé dans le stockage chiffrable de la tablette. Il ne donne accès ni aux dossiers RH ni aux plannings.</div></article></section>`);
  }

  function renderManagerConsole() {
    const device = state.device;
    const employees = state.managerEmployees;
    const canEdit = managerCan('pointage.edit_schedule', device?.organization_id);
    const rows = employees.map((employee) => `<div class="tc-manager-row"><div><strong>${escapeHtml(employee.display_name || 'Collaborateur')}</strong><span>${employee.has_pin ? `Code actif · version ${escapeHtml(employee.credential_version || 1)}` : 'Aucun code de pointage'}</span></div><div class="tc-row-actions">${canEdit ? `<button class="tc-btn tc-small" type="button" data-tc-action="set-pin" data-tc-employee="${escapeHtml(employee.employee_id)}">${employee.has_pin ? 'Modifier le code' : 'Créer le code'}</button>` : ''}</div></div>`).join('');
    const isActive = device?.status !== 'suspended' && device?.status !== 'revoked';
    const canToggle = managerCan(isActive ? 'pointage.suspend_device' : 'pointage.reactivate_device', device?.organization_id);
    setRoot(`${topbar()}<section class="tc-main"><article class="tc-card tc-section"><div class="tc-section-head"><div><p class="tc-overline">Configuration manager</p><h2>${escapeHtml(device?.name || 'Pointeuse')}</h2><p class="tc-sub">Les codes ne sont jamais affichés ni stockés en clair.</p></div><span class="tc-badge ${isActive ? 'ok' : 'pending'}">${isActive ? 'Tablette active' : 'Tablette suspendue'}</span></div>${messageHtml()}<div class="tc-manager-list">${rows || '<div class="tc-empty">Aucun collaborateur actif dans cet établissement.</div>'}</div><div class="tc-dialog-actions"><button class="tc-btn" type="button" data-tc-action="show-device-list">Voir toutes les pointeuses</button>${canToggle ? `<button class="tc-btn danger" type="button" data-tc-action="toggle-device-status" data-tc-status="${isActive ? 'suspended' : 'active'}">${isActive ? 'Mettre en pause la tablette' : 'Réactiver la tablette'}</button>` : ''}<button class="tc-btn" type="button" data-tc-action="close-manager">Terminer</button></div></article></section>`);
  }

  function renderDeviceList() {
    const contexts = activeManagerContexts(state.manager?.contexts);
    const selectedId = state.setupOrganizationId || contexts[0]?.organization_id || '';
    const rows = state.managerDevices.map((device) => {
      const active = device.status === 'active';
      const canToggle = managerCan(active ? 'pointage.suspend_device' : 'pointage.reactivate_device', state.setupOrganizationId);
      return `<div class="tc-manager-row"><div><strong>${escapeHtml(device.name)}</strong><span>${escapeHtml(device.status)} · ${escapeHtml(device.establishment_name || 'Établissement')} · dernier contact ${device.last_seen_at ? new Date(device.last_seen_at).toLocaleString('fr-FR') : '—'}</span></div><div class="tc-row-actions">${canToggle ? `<button class="tc-btn tc-small ${active ? 'danger' : ''}" type="button" data-tc-action="manage-device-status" data-tc-device="${escapeHtml(device.id)}" data-tc-status="${active ? 'suspended' : 'active'}">${active ? 'Mettre en pause' : 'Réactiver'}</button>` : ''}</div></div>`;
    }).join('');
    const canPair = managerCan('pointage.edit_schedule', selectedId);
    setRoot(`${topbar()}<section class="tc-main"><article class="tc-card tc-section"><div class="tc-section-head"><div><p class="tc-overline">Configuration manager</p><h2>Pointeuses enregistrées</h2><p class="tc-sub">Suspendez immédiatement une tablette perdue ou non utilisée.</p></div><span class="tc-badge">${state.managerDevices.length} appareil${state.managerDevices.length > 1 ? 's' : ''}</span></div>${messageHtml()}<label class="tc-label">Entreprise<select class="tc-field" data-tc-change="device-list-organization">${contexts.map((context) => `<option value="${escapeHtml(context.organization_id)}" ${context.organization_id === selectedId ? 'selected' : ''}>${escapeHtml(context.organization_name)}</option>`).join('')}</select></label><div class="tc-manager-list">${rows || '<div class="tc-empty">Aucune pointeuse visible dans votre périmètre.</div>'}</div><div class="tc-dialog-actions">${canPair ? '<button class="tc-btn primary" type="button" data-tc-action="start-pair">Ajouter une tablette</button>' : ''}<button class="tc-btn" type="button" data-tc-action="close-manager">Terminer</button></div></article></section>`);
  }

  function renderSetPin() {
    const employee = state.managerEmployees.find((item) => item.employee_id === state.pinTargetId);
    if (!employee) { state.screen = 'manager-console'; return render(); }
    setRoot(`${topbar()}<section class="tc-main"><article class="tc-dialog" style="margin:clamp(16px,7vh,64px) auto"><p class="tc-overline">Code personnel</p><h2>${escapeHtml(employee.display_name || 'Collaborateur')}</h2><p>Choisissez un code individuel à six chiffres. Ne l’écrivez pas sur la tablette et ne le communiquez pas à un autre salarié.</p>${messageHtml()}<form class="tc-form" id="tc-set-pin"><input type="hidden" name="employee_id" value="${escapeHtml(employee.employee_id)}"><label class="tc-label">Nouveau code<input class="tc-field" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" name="pin" type="password" autocomplete="new-password" required></label><label class="tc-label">Confirmation du code<input class="tc-field" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" name="confirm_pin" type="password" autocomplete="new-password" required></label><div class="tc-dialog-actions"><button class="tc-btn" type="button" data-tc-action="back-manager">Annuler</button><button class="tc-btn primary" type="submit" ${state.busy ? 'disabled' : ''}>${state.busy ? 'Enregistrement…' : 'Enregistrer le code'}</button></div></form><div class="tc-note">Le code est protégé côté serveur. Une preuve temporaire est conservée dans la tablette uniquement pour le fonctionnement hors connexion.</div></article></section>`);
  }

  async function loadLocalState() {
    const storedDevice = await dbGet('kv', 'device');
    if (storedDevice?.secretCipher) {
      state.device = { ...storedDevice, secret: await decryptDeviceSecret(storedDevice.secretCipher) };
    } else if (storedDevice?.secret) {
      // Migration automatique d'une éventuelle configuration de préversion.
      state.device = storedDevice;
      await storeDevice(state.device);
    } else {
      state.device = null;
    }
    const cache = await dbGet('kv', 'cache');
    state.roster = asArray(cache?.employees);
    state.queue = asArray(await dbAll('queue')).sort((left, right) => String(left.occurredAt).localeCompare(String(right.occurredAt)));
    state.localFailures = Number(await dbGet('kv', 'localFailures') || 0);
    state.localLockedUntil = Number(await dbGet('kv', 'localLockedUntil') || 0);
  }

  async function storeDevice(device) {
    state.device = device;
    const secretCipher = await encryptDeviceSecret(device.secret);
    const persisted = { ...device, secretCipher };
    delete persisted.secret;
    await dbSet('kv', 'device', persisted);
  }

  async function refreshDeviceCache(options = {}) {
    if (!state.device || !navigator.onLine) return false;
    const data = await callRpc('get_time_clock_device_cache', {
      p_device_id: state.device.id,
      p_device_secret: state.device.secret
    });
    if (!data?.device) throw appError('Réponse de configuration invalide.');
    state.device = { ...state.device, ...data.device, secret: state.device.secret, lastCacheAt: nowIso() };
    state.roster = asArray(data.employees);
    await storeDevice(state.device);
    await dbSet('kv', 'cache', { ...data, savedAt: nowIso() });
    state.lastSyncError = null;
    if (options.render !== false) render();
    return true;
  }

  async function addQueue(event) {
    state.queue.push(event);
    state.queue.sort((left, right) => String(left.occurredAt).localeCompare(String(right.occurredAt)));
    await dbSet('queue', event.id, event);
  }

  async function updateQueue(event) {
    const index = state.queue.findIndex((candidate) => candidate.id === event.id);
    if (index >= 0) state.queue[index] = event;
    await dbSet('queue', event.id, event);
  }

  async function removeQueue(id) {
    state.queue = state.queue.filter((event) => event.id !== id);
    await dbDelete('queue', id);
  }

  async function validateLocalPin(employee, pin) {
    if (!employee?.offline_salt || !employee?.offline_hash || !window.crypto?.subtle) return false;
    const derived = await deriveOfflineHash(pin, employee.offline_salt, employee.offline_iterations);
    return sameValue(derived, employee.offline_hash);
  }

  async function verifyPinAndContinue() {
    const employee = employeeById(state.selectedEmployeeId);
    const pin = state.pin;
    if (!employee || pin.length !== 6) return;
    if (!deviceCanBadge()) {
      state.pin = '';
      state.verified = null;
      state.screen = 'kiosk';
      state.message = { kind: 'error', text: 'Cette tablette a été désactivée. Contactez un manager.' };
      render();
      return;
    }
    if (state.localLockedUntil > Date.now()) {
      state.message = { kind: 'error', text: 'Trop d’essais. Réessayez dans quelques minutes.' };
      state.pin = '';
      render();
      return;
    }
    state.busy = true;
    state.message = null;
    render();
    try {
      const localValid = await validateLocalPin(employee, pin);
      if (!localValid && !navigator.onLine) {
        state.localFailures += 1;
        if (state.localFailures >= MAX_LOCAL_ATTEMPTS) state.localLockedUntil = Date.now() + LOCAL_LOCK_MS;
        await dbSet('kv', 'localFailures', state.localFailures);
        await dbSet('kv', 'localLockedUntil', state.localLockedUntil);
        throw appError('Code incorrect ou actualisation nécessaire avant un pointage hors connexion.');
      }
      state.localFailures = 0;
      state.localLockedUntil = 0;
      await dbSet('kv', 'localFailures', 0);
      await dbSet('kv', 'localLockedUntil', 0);
      state.verified = { employeeId: employee.employee_id, pin, localValid, expiresAt: Date.now() + 2 * 60 * 1000 };
      state.pin = '';
      state.screen = 'choose-action';
    } catch (error) {
      state.pin = '';
      state.message = { kind: 'error', text: errorMessage(error) };
    } finally {
      state.busy = false;
      render();
    }
  }

  async function transmitEvent(event, pin) {
    return callRpc('time_clock_badge', {
      p_device_id: event.deviceId,
      p_device_secret: state.device.secret,
      p_employee_id: event.employeeId,
      p_event_type: event.eventType,
      p_occurred_at: event.occurredAt,
      p_client_event_id: event.id,
      p_offline_proof: event.offlineProof || null,
      p_pin: pin || null
    });
  }

  async function updateRosterAfterEvent(event) {
    state.roster = state.roster.map((employee) => employee.employee_id === event.employeeId
      ? { ...employee, last_event_type: event.eventType, last_event_at: event.occurredAt }
      : employee);
    await dbSet('kv', 'cache', { device: state.device ? { ...state.device, secret: undefined } : null, employees: state.roster, savedAt: nowIso() });
  }

  async function recordBadge(eventType) {
    const verified = state.verified;
    const employee = employeeById(verified?.employeeId);
    if (!verified || !employee || !state.device) return;
    if (!deviceCanBadge()) {
      state.message = { kind: 'error', text: 'Cette tablette a été désactivée. Contactez un manager.' };
      state.verified = null;
      state.pin = '';
      state.screen = 'kiosk';
      render();
      return;
    }
    if (verified.expiresAt < Date.now()) {
      state.message = { kind: 'error', text: 'Le code a expiré. Veuillez vous identifier à nouveau.' };
      state.verified = null; state.screen = 'pin-entry'; render(); return;
    }
    state.busy = true;
    state.message = null;
    render();
    const event = {
      id: newId(),
      deviceId: state.device.id,
      employeeId: employee.employee_id,
      eventType,
      occurredAt: nowIso(),
      offlineProof: null,
      status: 'pending',
      createdAt: nowIso()
    };
    try {
      if (verified.localValid) event.offlineProof = await proofForEvent(employee, event);
      if (!navigator.onLine && !event.offlineProof) throw appError('La tablette doit être actualisée avant de pouvoir pointer hors connexion.');
      await addQueue(event);
      if (navigator.onLine) {
        try {
          await transmitEvent(event, verified.pin);
          await removeQueue(event.id);
          await updateRosterAfterEvent(event);
          state.message = { kind: 'ok', text: `${eventLabel(eventType)} enregistrée à ${new Date(event.occurredAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}.` };
        } catch (error) {
          if (!isNetworkFailure(error)) {
            await removeQueue(event.id);
            if (/no longer active|not authorized/i.test(String(error?.message || ''))) {
              await storeDevice({ ...state.device, status: 'suspended' });
              state.lastSyncError = errorMessage(error);
              throw error;
            }
            if (/invalid time clock code/i.test(String(error?.message || ''))) {
              try { await refreshDeviceCache({ render: false }); } catch (_) { /* Keep the safe local screen. */ }
              throw error;
            }
            event.status = 'blocked';
            event.error = errorMessage(error);
            await addQueue(event);
          } else {
            await updateRosterAfterEvent(event);
            state.lastSyncError = errorMessage(error);
            state.message = { kind: '', text: 'Badge conservé localement. Il sera synchronisé automatiquement.' };
          }
        }
      } else {
        await updateRosterAfterEvent(event);
        state.message = { kind: '', text: 'Badge enregistré hors connexion. Il sera synchronisé dès le retour d’Internet.' };
      }
      state.verified = null;
      state.pin = '';
      state.screen = 'kiosk';
    } catch (error) {
      state.message = { kind: 'error', text: errorMessage(error) };
      state.verified = null;
      state.pin = '';
      state.screen = deviceCanBadge() ? 'pin-entry' : 'kiosk';
    } finally {
      state.busy = false;
      render();
    }
  }

  async function flushQueue() {
    if (!state.device || !navigator.onLine || state.busy) return;
    const pending = state.queue.filter((event) => event.status === 'pending');
    for (const event of pending) {
      if (!event.offlineProof) {
        event.status = 'blocked';
        event.error = 'Preuve hors connexion indisponible.';
        await updateQueue(event);
        continue;
      }
      try {
        await transmitEvent(event, null);
        await removeQueue(event.id);
      } catch (error) {
        if (isNetworkFailure(error)) { state.lastSyncError = errorMessage(error); break; }
        event.status = 'blocked';
        event.error = errorMessage(error);
        await updateQueue(event);
      }
    }
    render();
  }

  async function syncDevice() {
    if (!state.device || !navigator.onLine) return;
    try {
      await refreshDeviceCache({ render: false });
      await flushQueue();
      state.lastSyncError = null;
    } catch (error) {
      state.lastSyncError = errorMessage(error);
      if (/no longer active|not authorized/i.test(String(error?.message || ''))) {
        await storeDevice({ ...state.device, status: 'suspended' });
        state.message = { kind: 'error', text: 'Cette tablette a été désactivée. Contactez un manager.' };
      }
    }
    render();
  }

  async function managerLogin(form) {
    const fields = new FormData(form);
    state.busy = true;
    state.message = null;
    render();
    try {
      const email = String(fields.get('email') || '').trim().toLowerCase();
      const password = String(fields.get('password') || '');
      const { data, error } = await api.auth.signInWithPassword({ email, password });
      if (error) throw error;
      const required = state.managerPurpose === 'pair' ? ['pointage.edit_schedule', 'pointage.manage_settings'] : null;
      const contexts = activeManagerContexts(await callRpc('get_access_context', {}), required);
      if (!contexts.length) throw appError('Ce compte ne possède pas le droit de configurer une pointeuse.');
      state.manager = { user: data.user, contexts };
      if (state.managerPurpose === 'pair') {
        state.setupOrganizationId = contexts[0].organization_id;
        await loadSetupEstablishments(state.setupOrganizationId);
        state.screen = 'pair-device';
      } else {
        if (state.device) {
          const matching = contexts.find((context) => context.organization_id === state.device?.organization_id);
          if (!matching) throw appError('Ce compte ne peut pas gérer l’établissement de cette tablette.');
          await loadManagerEmployees(matching.organization_id, state.device.establishment_id);
          state.screen = 'manager-console';
        } else {
          state.setupOrganizationId = contexts[0].organization_id;
          await loadManagerDevices(state.setupOrganizationId);
          state.screen = 'device-list';
        }
      }
    } catch (error) {
      state.message = { kind: 'error', text: errorMessage(error) };
    } finally {
      state.busy = false;
      render();
    }
  }

  async function loadSetupEstablishments(organizationId) {
    state.setupOrganizationId = organizationId;
    const { data, error } = await api.from('establishments').select('id,name').eq('organization_id', organizationId).eq('is_active', true).order('name');
    if (error) throw error;
    state.setupEstablishments = asArray(data);
  }

  async function pairDevice(form) {
    const fields = new FormData(form);
    const organizationId = String(fields.get('organization_id') || '');
    const establishmentId = String(fields.get('establishment_id') || '');
    const name = String(fields.get('device_name') || '').trim();
    const timezone = String(fields.get('timezone') || 'Europe/Paris');
    if (!organizationId || !establishmentId || name.length < 2) throw appError('Renseignez l’entreprise, l’établissement et le nom de la tablette.');
    if (!managerCan('pointage.edit_schedule', organizationId)) throw appError('Le droit de modifier les horaires de la pointeuse est requis.');
    state.busy = true;
    state.message = null;
    render();
    try {
      const secret = bytesToBase64(randomBytes(32)).replace(/[+/=]/g, (character) => ({ '+': '-', '/': '_', '=': '' }[character]));
      const deviceSecretHash = await sha256Hex(secret);
      const response = await callRpc('register_time_clock_device', {
        p_organization_id: organizationId,
        p_establishment_id: establishmentId,
        p_name: name,
        p_device_secret_hash: deviceSecretHash,
        p_timezone: timezone
      });
      await storeDevice({
        id: response.id,
        organization_id: organizationId,
        establishment_id: establishmentId,
        name: response.name || name,
        status: response.status || 'active',
        timezone,
        secret,
        configuredAt: nowIso()
      });
      await refreshDeviceCache({ render: false });
      await loadManagerEmployees(organizationId, establishmentId);
      state.message = { kind: 'ok', text: 'Tablette associée. Créez maintenant les codes individuels.' };
      state.screen = 'manager-console';
    } catch (error) {
      state.message = { kind: 'error', text: errorMessage(error) };
    } finally {
      state.busy = false;
      render();
    }
  }

  async function loadManagerEmployees(organizationId, establishmentId) {
    state.managerEmployees = asArray(await callRpc('list_time_clock_employees', {
      p_organization_id: organizationId,
      p_establishment_id: establishmentId
    }));
  }

  async function loadManagerDevices(organizationId) {
    state.setupOrganizationId = organizationId;
    state.managerDevices = asArray(await callRpc('list_time_clock_devices', { p_organization_id: organizationId }));
  }

  async function setEmployeePin(form) {
    const fields = new FormData(form);
    const employeeId = String(fields.get('employee_id') || '');
    const pin = String(fields.get('pin') || '');
    const confirmation = String(fields.get('confirm_pin') || '');
    if (!managerCan('pointage.edit_schedule', state.device?.organization_id)) throw appError('Le droit de modifier les horaires de la pointeuse est requis.');
    if (!/^\d{6}$/.test(pin)) throw appError('Le code doit contenir exactement six chiffres.');
    if (pin !== confirmation) throw appError('Les deux codes ne correspondent pas.');
    const salt = bytesToBase64(randomBytes(16));
    state.busy = true;
    state.message = null;
    render();
    try {
      const offlineHash = await deriveOfflineHash(pin, salt, PBKDF2_ITERATIONS);
      await callRpc('set_employee_time_clock_pin', {
        p_organization_id: state.device.organization_id,
        p_employee_id: employeeId,
        p_pin: pin,
        p_offline_salt: salt,
        p_offline_hash: offlineHash,
        p_offline_iterations: PBKDF2_ITERATIONS
      });
      await refreshDeviceCache({ render: false });
      await loadManagerEmployees(state.device.organization_id, state.device.establishment_id);
      state.message = { kind: 'ok', text: 'Code personnel enregistré.' };
      state.pinTargetId = null;
      state.screen = 'manager-console';
    } catch (error) {
      state.message = { kind: 'error', text: errorMessage(error) };
    } finally {
      state.busy = false;
      render();
    }
  }

  async function changeDeviceStatus(status, deviceId) {
    const targetId = deviceId || state.device?.id;
    if (!targetId) return;
    const organizationId = state.device?.id === targetId ? state.device.organization_id : state.setupOrganizationId;
    const requiredPermission = status === 'active' ? 'pointage.reactivate_device' : 'pointage.suspend_device';
    if (!managerCan(requiredPermission, organizationId)) {
      state.message = { kind: 'error', text: 'Vous ne disposez pas du droit requis pour changer le statut de cette tablette.' };
      return render();
    }
    state.busy = true;
    state.message = null;
    render();
    try {
      const response = await callRpc('set_time_clock_device_status', { p_device_id: targetId, p_status: status });
      if (state.device?.id === targetId) await storeDevice({ ...state.device, status: response.status });
      if (state.screen === 'device-list') await loadManagerDevices(state.setupOrganizationId);
      state.message = { kind: 'ok', text: response.status === 'active' ? 'Tablette réactivée.' : 'Tablette mise en pause.' };
    } catch (error) {
      state.message = { kind: 'error', text: errorMessage(error) };
    } finally {
      state.busy = false;
      render();
    }
  }

  async function closeManager() {
    try { await api.auth.signOut({ scope: 'local' }); } catch (_) { /* Session memory only. */ }
    state.manager = null;
    state.managerEmployees = [];
    state.managerDevices = [];
    state.pinTargetId = null;
    state.verified = null;
    state.pin = '';
    state.screen = state.device ? 'kiosk' : 'loading';
    render();
  }

  function startManager(purpose) {
    state.managerPurpose = purpose;
    state.message = null;
    state.screen = 'manager-login';
    render();
  }

  async function handleClick(event) {
    const target = event.target instanceof Element ? event.target.closest('[data-tc-action]') : null;
    if (!target || state.busy) return;
    const action = target.dataset.tcAction;
    if (action === 'start-pair') {
      if (state.manager?.contexts?.length) {
        const pairContexts = activeManagerContexts(state.manager.contexts, ['pointage.edit_schedule', 'pointage.manage_settings']);
        if (!pairContexts.length) {
          state.message = { kind: 'error', text: 'Le droit de modifier les horaires de la pointeuse est requis.' };
          return render();
        }
        state.managerPurpose = 'pair';
        state.setupOrganizationId = pairContexts[0].organization_id;
        state.busy = true;
        render();
        try { await loadSetupEstablishments(state.setupOrganizationId); state.screen = 'pair-device'; }
        catch (error) { state.message = { kind: 'error', text: errorMessage(error) }; }
        finally { state.busy = false; render(); }
        return;
      }
      return startManager('pair');
    }
    if (action === 'start-device-management') return startManager('manage');
    if (action === 'open-manager') return startManager(state.device ? 'manage' : 'pair');
    if (action === 'back-kiosk') { state.message = null; state.pin = ''; state.verified = null; state.screen = state.device ? 'kiosk' : 'loading'; return render(); }
    if (action === 'close-manager') return closeManager();
    if (action === 'select-employee') {
      if (!deviceCanBadge()) {
        state.message = { kind: 'error', text: 'Cette tablette a été désactivée. Contactez un manager.' };
        return render();
      }
      state.selectedEmployeeId = target.dataset.tcEmployee || null;
      state.pin = ''; state.message = null; state.screen = 'pin-entry'; return render();
    }
    if (action === 'pin-key') {
      const key = target.dataset.tcKey;
      if (key === 'cancel') { state.pin = ''; state.message = null; state.screen = 'kiosk'; return render(); }
      if (key === 'back') { state.pin = state.pin.slice(0, -1); return render(); }
      if (/^\d$/.test(key) && state.pin.length < 6) {
        state.pin += key;
        render();
        if (state.pin.length === 6) await verifyPinAndContinue();
      }
      return;
    }
    if (action === 'cancel-verified') { state.verified = null; state.pin = ''; state.screen = 'kiosk'; return render(); }
    if (action === 'record-badge') return recordBadge(target.dataset.tcEvent);
    if (action === 'set-pin') {
      if (!managerCan('pointage.edit_schedule', state.device?.organization_id)) return;
      state.pinTargetId = target.dataset.tcEmployee || null; state.message = null; state.screen = 'set-pin'; return render();
    }
    if (action === 'back-manager') { state.pinTargetId = null; state.message = null; state.screen = 'manager-console'; return render(); }
    if (action === 'toggle-device-status') return changeDeviceStatus(target.dataset.tcStatus);
    if (action === 'manage-device-status') return changeDeviceStatus(target.dataset.tcStatus, target.dataset.tcDevice);
    if (action === 'show-device-list') {
      state.setupOrganizationId = state.device?.organization_id || state.manager?.contexts?.[0]?.organization_id || '';
      state.busy = true;
      render();
      try { await loadManagerDevices(state.setupOrganizationId); state.screen = 'device-list'; }
      catch (error) { state.message = { kind: 'error', text: errorMessage(error) }; }
      finally { state.busy = false; render(); }
      return;
    }
  }

  async function handleSubmit(event) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (!['tc-manager-login', 'tc-pair-device', 'tc-set-pin'].includes(form.id)) return;
    event.preventDefault();
    try {
      if (form.id === 'tc-manager-login') await managerLogin(form);
      if (form.id === 'tc-pair-device') await pairDevice(form);
      if (form.id === 'tc-set-pin') await setEmployeePin(form);
    } catch (error) {
      state.message = { kind: 'error', text: errorMessage(error) };
      state.busy = false;
      render();
    }
  }

  async function handleChange(event) {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement) || !['setup-organization', 'device-list-organization'].includes(target.dataset.tcChange)) return;
    state.busy = true;
    state.message = null;
    render();
    try {
      if (target.dataset.tcChange === 'setup-organization') await loadSetupEstablishments(target.value);
      else await loadManagerDevices(target.value);
    }
    catch (error) { state.message = { kind: 'error', text: errorMessage(error) }; }
    finally { state.busy = false; render(); }
  }

  function handleInput(event) {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.id !== 'tc-search') return;
    state.search = input.value;
    render();
    byId('tc-search')?.focus();
  }

  async function initialize() {
    try {
      if (!window.crypto?.subtle) throw appError('Cette tablette doit utiliser HTTPS ou localhost pour activer la sécurité cryptographique.');
      await loadLocalState();
      state.screen = state.device ? 'kiosk' : 'unconfigured';
      render();
      if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => undefined);
      if (state.device && navigator.onLine) void syncDevice();
    } catch (error) {
      root.className = '';
      root.innerHTML = `<section class="tc-main"><article class="tc-dialog" style="margin:12vh auto"><h2>Pointeuse indisponible</h2><p>${escapeHtml(errorMessage(error))}</p></article></section>`;
    }
  }

  document.addEventListener('click', (event) => { void handleClick(event); });
  document.addEventListener('submit', (event) => { void handleSubmit(event); });
  document.addEventListener('change', (event) => { void handleChange(event); });
  document.addEventListener('input', handleInput);
  window.addEventListener('online', () => { void syncDevice(); });
  window.addEventListener('offline', () => { state.lastSyncError = null; render(); });
  window.setInterval(updateClock, 1000);
  window.setInterval(() => { if (state.device && navigator.onLine) void syncDevice(); }, 90 * 1000);

  void initialize();
}());
