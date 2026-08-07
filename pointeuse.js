/* PlanniPro Pointeuse - activation volontaire, PIN vérifié uniquement par Supabase. */
(function () {
  'use strict';

  const root = document.getElementById('time-clock-root');
  const config = window.PLANNIPRO_SUPABASE_CONFIG;
  const DB_NAME = 'plannipro-time-clock';
  const DB_VERSION = 1;
  const DEVICE_STORAGE_KEY = 'plannipro_clock_device_token';
  const APP_VERSION = '3.0.0';
  const params = new URLSearchParams(window.location.search);

  if (!root || !config?.url || !config?.publishableKey || !window.supabase?.createClient) {
    if (root) root.innerHTML = '<div class="tc-empty">La configuration sécurisée de la pointeuse est indisponible.</div>';
    return;
  }

  const api = window.supabase.createClient(config.url, config.publishableKey, {
    // La session d'administration reste uniquement en mémoire, mais son jeton
    // doit être rafraîchi tant que l'écran de gestion est ouvert.
    auth: { persistSession: false, autoRefreshToken: true, detectSessionInUrl: false }
  });

  const state = {
    screen: 'loading', device: null, deviceToken: null, pin: '', verified: null,
    message: null, busy: false, manager: null, contexts: [], organizationId: '',
    establishments: [], devices: [], employees: [], selectedDevice: null,
    activation: null, oneTimeSecret: null, resultTimer: null,
    invitationToken: params.get('clock-pin') || ''
  };

  const byId = (id) => document.getElementById(id);
  const asArray = (value) => Array.isArray(value) ? value : [];
  const escapeHtml = (value) => String(value == null ? '' : value).replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[char]));
  const newId = () => window.crypto.randomUUID();
  const nowIso = () => new Date().toISOString();

  function appError(message) {
    const error = new Error(message || 'Une erreur est survenue.');
    error.userMessage = message;
    return error;
  }

  function errorMessage(error) {
    const message = String(error?.message || error?.userMessage || 'Opération impossible pour le moment.');
    if (/authentication required|invalid or expired session|session de gestion.*expir/i.test(message)) return 'Votre session de gestion a expiré. Reconnectez-vous.';
    if (/invalid, expired or already used|activation code/i.test(message)) return 'Le code d’activation est invalide, expiré ou déjà utilisé.';
    if (/not authorized|permission|JWT|row-level|rls/i.test(message)) return 'Cette action n’est pas autorisée pour ce profil.';
    if (/no longer active|time clock unavailable/i.test(message)) return 'Cette pointeuse a été désactivée par un responsable.';
    if (/incorrect ou indisponible|invalid time clock code/i.test(message)) return 'Code incorrect ou indisponible.';
    if (/temporarily locked/i.test(message)) return 'Trop d’essais. Réessayez dans quelques minutes.';
    if (/failed to fetch|network|fetch failed|load failed/i.test(message)) return 'Connexion indisponible — pointage momentanément impossible.';
    if (/attendance state/i.test(message)) return 'Cette action ne correspond pas au dernier badge enregistré.';
    return message.length > 180 ? 'Opération impossible pour le moment.' : message;
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('queue')) db.createObjectStore('queue', { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || appError('Stockage local indisponible.'));
    });
  }

  async function dbGet(key) {
    const db = await openDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const request = db.transaction('kv', 'readonly').objectStore('kv').get(key);
        request.onsuccess = () => resolve(request.result?.value || null);
        request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
  }

  async function dbSet(key, value) {
    const db = await openDatabase();
    try {
      await new Promise((resolve, reject) => {
        const transaction = db.transaction('kv', 'readwrite');
        transaction.objectStore('kv').put({ key, value });
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
      });
    } finally { db.close(); }
  }

  async function dbDelete(key) {
    const db = await openDatabase();
    try {
      await new Promise((resolve, reject) => {
        const transaction = db.transaction('kv', 'readwrite');
        transaction.objectStore('kv').delete(key);
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
      });
    } finally { db.close(); }
  }

  async function cryptoKey() {
    let key = await dbGet('device-crypto-key');
    if (key) return key;
    key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await dbSet('device-crypto-key', key);
    return key;
  }

  function bytesToBase64(bytes) {
    let binary = '';
    bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
    return btoa(binary);
  }

  function base64ToBytes(value) {
    const binary = atob(value);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  }

  async function encryptToken(token) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await cryptoKey(), new TextEncoder().encode(token));
    return { iv: bytesToBase64(iv), data: bytesToBase64(new Uint8Array(data)) };
  }

  async function decryptToken(cipher) {
    const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(cipher.iv) }, await cryptoKey(), base64ToBytes(cipher.data));
    return new TextDecoder().decode(data);
  }

  async function callRpc(name, args) {
    const { data, error } = await api.rpc(name, args || {});
    if (error) throw error;
    const parsed = data && typeof data === 'string' ? JSON.parse(data) : data;
    if (parsed && typeof parsed === 'object' && parsed.error) throw appError(parsed.error);
    return parsed;
  }

  async function managerAccessToken(forceRefresh) {
    let response = forceRefresh ? await api.auth.refreshSession() : await api.auth.getSession();
    if (response.error) throw response.error;
    let session = response.data?.session;
    const expiresSoon = Number(session?.expires_at || 0) * 1000 <= Date.now() + 60_000;
    if (session && !forceRefresh && expiresSoon) {
      response = await api.auth.refreshSession();
      if (response.error) throw response.error;
      session = response.data?.session;
    }
    if (!session?.access_token) throw appError('Votre session de gestion a expiré. Reconnectez-vous.');
    return session.access_token;
  }

  async function invokeManagerFunction(name, body) {
    const invoke = async (forceRefresh) => api.functions.invoke(name, {
      body,
      headers: { Authorization: `Bearer ${await managerAccessToken(forceRefresh)}` }
    });
    let result = await invoke(false);
    if (result.error && Number(result.error?.context?.status) === 401) result = await invoke(true);
    if (result.error) {
      if (Number(result.error?.context?.status) === 401) throw appError('Votre session de gestion a expiré. Reconnectez-vous.');
      throw result.error;
    }
    return result.data;
  }

  function hasPermission(context, key) {
    return asArray(context?.permissions).some((permission) => permission?.key === key && permission?.allowed);
  }

  function activeManagerContexts(contexts, required) {
    const keys = required || ['clock_devices.view', 'clock_devices.create', 'clock_devices.update', 'clock_devices.disable'];
    return asArray(contexts).filter((context) => keys.some((key) => hasPermission(context, key)));
  }

  function managerCan(key, organizationId) {
    return state.contexts.some((context) => context.organization_id === organizationId && hasPermission(context, key));
  }

  async function storeDevice(device, token) {
    state.device = device;
    state.deviceToken = token;
    await dbSet(DEVICE_STORAGE_KEY, { device, tokenCipher: await encryptToken(token) });
  }

  async function loadDevice() {
    let stored = await dbGet(DEVICE_STORAGE_KEY);
    let migratedLegacyDevice = false;
    if (!stored) {
      const legacy = await dbGet('device');
      if (legacy?.secretCipher) { stored = { device: legacy, tokenCipher: legacy.secretCipher }; migratedLegacyDevice = true; }
      else if (legacy?.secret) {
        await storeDevice(legacy, legacy.secret);
        await dbDelete('device');
        await dbSet('cache', { securityMigrationAt: nowIso() });
        return;
      }
    }
    // Previous releases cached a verifier derived from every employee PIN.
    // It is deliberately overwritten and is never used by the secure flow.
    await dbSet('cache', { securityMigrationAt: nowIso() });
    if (!stored?.device || !stored?.tokenCipher) return;
    state.device = stored.device;
    state.deviceToken = await decryptToken(stored.tokenCipher);
    if (migratedLegacyDevice || !(await dbGet(DEVICE_STORAGE_KEY))) {
      await storeDevice(state.device, state.deviceToken);
      await dbDelete('device');
    }
  }

  async function refreshDevice() {
    if (!state.device || !state.deviceToken || !navigator.onLine) return;
    const data = await callRpc('get_time_clock_device_cache', {
      p_device_id: state.device.id, p_device_secret: state.deviceToken
    });
    await storeDevice({ ...state.device, ...data.device }, state.deviceToken);
  }

  function topbar() {
    const online = navigator.onLine;
    return `<header class="tc-top"><div class="tc-brand"><span class="tc-brand-mark">P</span><span>Planni<b>Pro</b></span></div><div class="tc-device"><span class="tc-status ${online ? 'online' : 'error'}">${online ? 'En ligne' : 'Hors connexion'}</span><span>${escapeHtml(state.device?.name || 'Terminal non activé')}</span><button class="tc-icon-btn" data-action="manage" aria-label="Gérer les pointeuses" title="Gérer les pointeuses">⚙</button></div></header>`;
  }

  function messageHtml() {
    return state.message ? `<div class="tc-message ${state.message.kind || ''}" role="status">${escapeHtml(state.message.text)}</div>` : '';
  }

  function setRoot(html) {
    root.className = '';
    root.innerHTML = html;
    updateClock();
  }

  function updateClock() {
    const date = new Date();
    if (byId('clock-time')) byId('clock-time').textContent = date.toLocaleTimeString('fr-FR');
    if (byId('clock-date')) byId('clock-date').textContent = date.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }

  function render() {
    if (state.screen === 'pin-invitation') return renderPinInvitation();
    if (state.screen === 'manager-login') return renderManagerLogin();
    if (state.screen === 'manager') return renderManager();
    if (state.screen === 'employees') return renderEmployees();
    if (state.screen === 'activation') return renderActivation();
    if (state.screen === 'actions') return renderActions();
    if (state.screen === 'success') return renderSuccess();
    if (!state.device) return renderActivation();
    return renderKiosk();
  }

  function renderActivation() {
    state.screen = 'activation';
    setRoot(`${topbar()}<main class="tc-main"><section class="tc-dialog tc-activation"><p class="tc-overline">Activation sécurisée</p><h1>Activer cette pointeuse</h1><p>Ce navigateur n’est pas encore enregistré comme terminal de pointage. L’activation doit être autorisée par un responsable.</p>${messageHtml()}<form id="activation-form" class="tc-form"><label class="tc-label">Code temporaire<input class="tc-field tc-code" name="code" autocomplete="one-time-code" maxlength="9" placeholder="AB12-CD34" required></label><label class="tc-label">Nom de la pointeuse<input class="tc-field" name="name" maxlength="80" placeholder="Pointeuse entrée principale" required></label><label class="tc-label">Emplacement (facultatif)<input class="tc-field" name="location" maxlength="160" placeholder="Accueil"></label><label class="tc-label">Description (facultative)<textarea class="tc-field" name="description" maxlength="500" rows="3"></textarea></label><div class="tc-dialog-actions"><button class="tc-btn" type="button" data-action="manage">Se connecter comme responsable</button><button class="tc-btn primary" type="submit" ${state.busy || !navigator.onLine ? 'disabled' : ''}>${state.busy ? 'Activation…' : 'Activer le terminal'}</button></div></form>${!navigator.onLine ? '<div class="tc-note error">Une connexion Internet est nécessaire pour activer ce terminal.</div>' : ''}</section></main>`);
  }

  function renderKiosk() {
    const dots = Array.from({ length: 6 }, (_, index) => `<span class="tc-pin-dot ${index < state.pin.length ? 'filled' : ''}"></span>`).join('');
    const keys = ['1','2','3','4','5','6','7','8','9','clear','0','validate'].map((key) => {
      const label = key === 'clear' ? 'Effacer' : key === 'validate' ? 'Valider' : key;
      return `<button class="tc-key ${key === 'validate' ? 'primary' : key === 'clear' ? 'subtle' : ''}" type="button" data-action="pin-key" data-key="${key}">${label}</button>`;
    }).join('');
    setRoot(`${topbar()}<main class="tc-main tc-kiosk"><section class="tc-clock-hero"><p class="tc-establishment">${escapeHtml(state.device.establishment_name || 'Établissement')}</p><h1>${escapeHtml(state.device.name)}</h1><div id="clock-date" class="tc-clock-date"></div><div id="clock-time" class="tc-clock-time"></div></section><section class="tc-pin-panel"><h2>Entrez votre code personnel</h2><p>Votre code contient six chiffres.</p>${messageHtml()}<div class="tc-pin-dots" aria-label="${state.pin.length} chiffre(s) saisi(s)">${dots}</div><div class="tc-keypad">${keys}</div>${!navigator.onLine ? '<div class="tc-note error">Connexion indisponible — pointage momentanément impossible.</div>' : ''}</section></main>`);
  }

  function actionLabel(type) {
    return ({ clock_in: ['Entrée', 'Je commence mon service'], break_start: ['Pause', 'Je pars en pause'], break_end: ['Reprise', 'Je reprends mon service'], clock_out: ['Sortie', 'Je termine mon service'] })[type];
  }

  function renderActions() {
    if (!state.verified || state.verified.expiresAt < Date.now()) { state.verified = null; state.screen = 'kiosk'; return render(); }
    const buttons = asArray(state.verified.allowed_actions).map((type) => {
      const copy = actionLabel(type);
      return `<button class="tc-action ${type}" data-action="badge" data-event="${type}"><strong>${copy[0]}</strong><span>${copy[1]}</span></button>`;
    }).join('');
    setRoot(`${topbar()}<main class="tc-main"><section class="tc-dialog tc-action-dialog"><p class="tc-overline">Identification confirmée</p><h1>Bonjour ${escapeHtml(state.verified.first_name || '')}</h1><p>Quelle action souhaitez-vous enregistrer ?</p>${messageHtml()}<div class="tc-actions-grid">${buttons}</div><button class="tc-btn tc-wide" data-action="cancel">Annuler</button></section></main>`);
  }

  function renderSuccess() {
    const result = state.oneTimeSecret || {};
    setRoot(`${topbar()}<main class="tc-main"><section class="tc-success"><div class="tc-success-mark">✓</div><h1>${escapeHtml(result.greeting || 'Pointage enregistré')}</h1><p>${escapeHtml(result.message || '')}</p><span>${escapeHtml(result.detail || 'Bonne journée')}</span></section></main>`);
  }

  function renderManagerLogin() {
    setRoot(`${topbar()}<main class="tc-main"><section class="tc-dialog"><p class="tc-overline">Administration</p><h1>Gérer les pointeuses</h1><p>Cette session reste uniquement en mémoire et sera fermée en quittant l’écran.</p>${messageHtml()}<form id="manager-login" class="tc-form"><label class="tc-label">Adresse e-mail<input class="tc-field" type="email" name="email" autocomplete="username" required></label><label class="tc-label">Mot de passe<input class="tc-field" type="password" name="password" autocomplete="current-password" required></label><div class="tc-dialog-actions"><button class="tc-btn" type="button" data-action="cancel-manager">Annuler</button><button class="tc-btn primary" type="submit" ${state.busy ? 'disabled' : ''}>Se connecter</button></div></form></section></main>`);
  }

  function renderManager() {
    const context = state.contexts.find((item) => item.organization_id === state.organizationId) || state.contexts[0];
    const orgOptions = state.contexts.map((item) => `<option value="${item.organization_id}" ${item.organization_id === state.organizationId ? 'selected' : ''}>${escapeHtml(item.organization_name)}</option>`).join('');
    const establishmentOptions = state.establishments.map((item) => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join('');
    const cards = state.devices.map((device) => {
      const status = device.status === 'active' ? 'Active' : device.status === 'archived' ? 'Archivée' : device.status === 'revoked' ? 'Révoquée' : 'Désactivée';
      const active = device.status === 'active';
      return `<article class="tc-device-card"><div><span class="tc-badge ${active ? 'ok' : 'pending'}">${status}</span><h3>${escapeHtml(device.name)}</h3><p>${escapeHtml(device.establishment_name)}${device.location ? ` · ${escapeHtml(device.location)}` : ''}</p><dl><div><dt>Dernière activité</dt><dd>${device.last_seen_at ? new Date(device.last_seen_at).toLocaleString('fr-FR') : 'Jamais'}</dd></div><div><dt>Pointages</dt><dd>${Number(device.event_count || 0)}</dd></div><div><dt>Version</dt><dd>${escapeHtml(device.app_version || '—')}</dd></div></dl></div><div class="tc-card-actions"><button class="tc-btn tc-small" data-action="device-history" data-device="${device.id}">Historique</button>${managerCan('clock_devices.update', state.organizationId) ? `<button class="tc-btn tc-small" data-action="rename-device" data-device="${device.id}">Modifier</button>` : ''}${active && managerCan('clock_devices.disable', state.organizationId) ? `<button class="tc-btn tc-small" data-action="status-device" data-status="suspended" data-device="${device.id}">Désactiver</button><button class="tc-btn tc-small danger" data-action="revoke-device" data-device="${device.id}">Révoquer</button>` : ''}${!active && device.status !== 'archived' && managerCan('clock_devices.update', state.organizationId) ? `<button class="tc-btn tc-small" data-action="status-device" data-status="active" data-device="${device.id}">Réactiver</button>` : ''}${managerCan('clock_devices.delete', state.organizationId) ? `<button class="tc-btn tc-small danger" data-action="remove-device" data-device="${device.id}">Supprimer / archiver</button>` : ''}${managerCan('clock_pin.generate', state.organizationId) ? `<button class="tc-btn tc-small" data-action="employees" data-device="${device.id}">Codes salariés</button>` : ''}</div></article>`;
    }).join('');
    const activation = state.activation ? `<div class="tc-one-time"><span>Code valable 10 minutes</span><strong>${escapeHtml(state.activation.code)}</strong><button class="tc-btn" data-action="copy" data-copy="${escapeHtml(state.activation.code)}">Copier</button><small>Ce code ne sera plus affiché après avoir quitté cet écran.</small></div>` : '';
    setRoot(`${topbar()}<main class="tc-main"><section class="tc-card tc-admin"><div class="tc-section-head"><div><p class="tc-overline">Paramètres → Pointeuses</p><h1>Terminaux enregistrés</h1></div><button class="tc-btn" data-action="close-manager">Déconnexion manager</button></div>${messageHtml()}<div class="tc-admin-filters"><label class="tc-label">Entreprise<select class="tc-field" id="manager-org">${orgOptions}</select></label>${managerCan('clock_devices.create', state.organizationId) ? `<form id="activation-code" class="tc-inline-form"><label class="tc-label">Établissement<select class="tc-field" name="establishment_id">${establishmentOptions}</select></label><button class="tc-btn primary" ${!establishmentOptions ? 'disabled' : ''}>Ajouter une pointeuse</button></form>` : ''}</div>${activation}<div class="tc-device-list">${cards || '<div class="tc-empty">Aucune pointeuse enregistrée dans ce périmètre.</div>'}</div></section></main>`);
  }

  function renderEmployees() {
    const device = state.selectedDevice;
    const rows = state.employees.map((employee) => `<div class="tc-manager-row"><div><strong>${escapeHtml(employee.display_name)}</strong><span>${employee.has_pin ? `Code actif · version ${employee.credential_version}` : 'Aucun code actif'}</span></div><div class="tc-row-actions"><button class="tc-btn tc-small" data-action="generate-pin" data-employee="${employee.employee_id}">${employee.has_pin ? 'Réinitialiser' : 'Générer'}</button><button class="tc-btn tc-small" data-action="invite-pin" data-employee="${employee.employee_id}">Créer un lien</button><button class="tc-btn tc-small" data-action="send-pin-invite" data-employee="${employee.employee_id}">Envoyer par e-mail</button></div></div>`).join('');
    const secret = state.oneTimeSecret ? `<div class="tc-one-time"><span>${escapeHtml(state.oneTimeSecret.label)}</span><strong>${escapeHtml(state.oneTimeSecret.value)}</strong><div><button class="tc-btn" data-action="copy" data-copy="${escapeHtml(state.oneTimeSecret.value)}">Copier</button>${state.oneTimeSecret.kind === 'pin' ? '<button class="tc-btn" data-action="print-secret">Imprimer</button>' : ''}<button class="tc-btn" data-action="hide-secret">Fermer définitivement</button></div><small>Cette valeur ne pourra plus être affichée ensuite.</small></div>` : '';
    setRoot(`${topbar()}<main class="tc-main"><section class="tc-card tc-admin"><div class="tc-section-head"><div><p class="tc-overline">Codes de pointage</p><h1>${escapeHtml(device?.name || '')}</h1></div><button class="tc-btn" data-action="back-manager">Retour</button></div>${messageHtml()}${secret}<div class="tc-manager-list">${rows || '<div class="tc-empty">Aucun salarié actif pour cet établissement.</div>'}</div></section></main>`);
  }

  function renderPinInvitation() {
    setRoot(`${topbar()}<main class="tc-main"><section class="tc-dialog"><p class="tc-overline">Lien personnel sécurisé</p><h1>Définir mon code de pointage</h1><p>Choisissez six chiffres difficiles à deviner. Les suites simples et chiffres répétés sont refusés.</p>${messageHtml()}<form id="pin-invitation-form" class="tc-form"><label class="tc-label">Nouveau code<input class="tc-field" name="pin" type="password" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required></label><label class="tc-label">Confirmation<input class="tc-field" name="confirmation" type="password" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required></label><button class="tc-btn primary">Enregistrer définitivement</button></form></section></main>`);
  }

  async function activate(form) {
    if (!navigator.onLine) throw appError('Connexion indisponible — activation momentanément impossible.');
    const fields = new FormData(form);
    const token = bytesToBase64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    const device = await callRpc('activate_time_clock_device', {
      p_activation_code: String(fields.get('code') || ''), p_device_token: token,
      p_name: String(fields.get('name') || ''), p_location: String(fields.get('location') || ''),
      p_description: String(fields.get('description') || ''), p_user_agent: navigator.userAgent,
      p_app_version: APP_VERSION
    });
    await storeDevice(device, token);
    await refreshDevice();
    state.screen = 'kiosk';
    state.message = { kind: 'ok', text: 'Pointeuse activée avec succès.' };
  }

  async function verifyPin() {
    if (state.pin.length !== 6 || state.busy) return;
    if (!navigator.onLine) throw appError('Connexion indisponible — pointage momentanément impossible.');
    state.verified = await callRpc('verify_time_clock_pin', {
      p_device_id: state.device.id, p_device_token: state.deviceToken, p_pin: state.pin
    });
    state.verified.pin = state.pin;
    state.verified.expiresAt = Date.now() + 2 * 60 * 1000;
    state.pin = '';
    state.screen = 'actions';
  }

  async function recordBadge(type) {
    if (!navigator.onLine) throw appError('Connexion indisponible — pointage momentanément impossible.');
    const verified = state.verified;
    const occurredAt = nowIso();
    const response = await callRpc('time_clock_badge', {
      p_device_id: state.device.id, p_device_secret: state.deviceToken,
      p_employee_id: verified.employee_id, p_event_type: type, p_occurred_at: occurredAt,
      p_client_event_id: newId(), p_offline_proof: null, p_pin: verified.pin
    });
    const time = new Date(response.occurred_at || occurredAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    state.oneTimeSecret = {
      greeting: type === 'clock_out' ? `Au revoir ${verified.first_name}` : `Bonjour ${verified.first_name}`,
      message: `${actionLabel(type)[0]} enregistrée à ${time}`,
      detail: type === 'clock_out' && response.summary?.dur ? `Temps de présence aujourd’hui : ${response.summary.dur} h` : 'Bonne journée'
    };
    state.verified = null;
    state.screen = 'success';
    clearTimeout(state.resultTimer);
    state.resultTimer = setTimeout(() => { state.oneTimeSecret = null; state.screen = 'kiosk'; render(); }, 4500);
  }

  async function managerLogin(form) {
    const fields = new FormData(form);
    const { error } = await api.auth.signInWithPassword({ email: String(fields.get('email') || '').trim().toLowerCase(), password: String(fields.get('password') || '') });
    if (error) throw error;
    state.contexts = activeManagerContexts(await callRpc('get_access_context', {}));
    if (!state.contexts.length) throw appError('Ce compte ne peut pas gérer les pointeuses.');
    state.organizationId = state.contexts[0].organization_id;
    await loadManagerData();
    state.screen = 'manager';
  }

  async function loadManagerData() {
    const { data, error } = await api.from('establishments').select('id,name').eq('organization_id', state.organizationId).eq('is_active', true).order('name');
    if (error) throw error;
    state.establishments = asArray(data);
    state.devices = asArray(await callRpc('list_time_clock_devices', { p_organization_id: state.organizationId }));
  }

  async function closeManager() {
    try { await api.auth.signOut({ scope: 'local' }); } catch (_) { /* Session en mémoire uniquement. */ }
    state.contexts = []; state.manager = null; state.activation = null; state.devices = [];
    state.screen = state.device ? 'kiosk' : 'activation';
  }

  async function withBusy(work) {
    if (state.busy) return;
    state.busy = true; state.message = null; render();
    try { await work(); }
    catch (error) { state.message = { kind: 'error', text: errorMessage(error) }; }
    finally { state.busy = false; render(); }
  }

  async function handleSubmit(event) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (!['activation-form','manager-login','activation-code','pin-invitation-form'].includes(form.id)) return;
    event.preventDefault();
    await withBusy(async () => {
      if (form.id === 'activation-form') await activate(form);
      if (form.id === 'manager-login') await managerLogin(form);
      if (form.id === 'activation-code') {
        const fields = new FormData(form);
        state.activation = await callRpc('create_time_clock_activation_code', {
          p_organization_id: state.organizationId, p_establishment_id: String(fields.get('establishment_id')), p_ttl_minutes: 10
        });
      }
      if (form.id === 'pin-invitation-form') {
        const fields = new FormData(form);
        const pin = String(fields.get('pin') || '');
        if (pin !== String(fields.get('confirmation') || '')) throw appError('Les deux codes ne correspondent pas.');
        await callRpc('consume_employee_time_clock_pin_invitation', { p_token: state.invitationToken, p_pin: pin });
        state.message = { kind: 'ok', text: 'Votre code a été enregistré. Ce lien est maintenant invalidé.' };
        form.reset();
      }
    });
  }

  async function handleClick(event) {
    const target = event.target instanceof Element ? event.target.closest('[data-action]') : null;
    if (!target || state.busy) return;
    const action = target.dataset.action;
    if (action === 'manage') { state.screen = 'manager-login'; state.message = null; return render(); }
    if (action === 'cancel-manager') { state.screen = state.device ? 'kiosk' : 'activation'; return render(); }
    if (action === 'close-manager') return withBusy(closeManager);
    if (action === 'cancel') { state.verified = null; state.pin = ''; state.screen = 'kiosk'; return render(); }
    if (action === 'pin-key') {
      const key = target.dataset.key;
      if (key === 'clear') state.pin = '';
      else if (key === 'validate') return withBusy(verifyPin);
      else if (/^\d$/.test(key) && state.pin.length < 6) state.pin += key;
      return render();
    }
    if (action === 'badge') return withBusy(() => recordBadge(target.dataset.event));
    if (action === 'copy') { await navigator.clipboard.writeText(target.dataset.copy || ''); state.message = { kind: 'ok', text: 'Copié.' }; return render(); }
    if (action === 'hide-secret') { state.oneTimeSecret = null; return render(); }
    if (action === 'print-secret') return window.print();
    if (action === 'back-manager') { state.oneTimeSecret = null; state.screen = 'manager'; return render(); }
    if (action === 'employees') return withBusy(async () => {
      state.selectedDevice = state.devices.find((device) => device.id === target.dataset.device);
      state.employees = asArray(await callRpc('list_time_clock_employees', {
        p_organization_id: state.organizationId, p_establishment_id: state.selectedDevice.establishment_id
      }));
      state.screen = 'employees';
    });
    if (action === 'generate-pin') return withBusy(async () => {
      const result = await callRpc('generate_employee_time_clock_pin', { p_organization_id: state.organizationId, p_employee_id: target.dataset.employee });
      state.oneTimeSecret = { kind: 'pin', label: 'Code visible une seule fois', value: result.pin };
      state.employees = asArray(await callRpc('list_time_clock_employees', { p_organization_id: state.organizationId, p_establishment_id: state.selectedDevice.establishment_id }));
    });
    if (action === 'invite-pin') return withBusy(async () => {
      const result = await callRpc('create_employee_time_clock_pin_invitation', { p_organization_id: state.organizationId, p_employee_id: target.dataset.employee });
      const url = new URL('./pointeuse.html', window.location.href); url.search = ''; url.searchParams.set('clock-pin', result.token);
      state.oneTimeSecret = { kind: 'link', label: 'Lien sécurisé valable 24 heures', value: url.href };
    });
    if (action === 'send-pin-invite') return withBusy(async () => {
      const data = await invokeManagerFunction('send-clock-pin-invitation', {
        organization_id: state.organizationId, employee_id: target.dataset.employee
      });
      if (data?.accept_url) state.oneTimeSecret = { kind: 'link', label: data.warning || 'Lien sécurisé valable 24 heures', value: data.accept_url };
      state.message = { kind: data?.emailed ? 'ok' : '', text: data?.emailed ? 'Invitation envoyée par e-mail.' : (data?.warning || 'Lien créé pour remise manuelle.') };
    });
    if (action === 'device-history') return withBusy(async () => {
      const history = asArray(await callRpc('list_time_clock_device_history', { p_device_id: target.dataset.device }));
      const lines = history.slice(0, 30).map((item) => `${new Date(item.created_at).toLocaleString('fr-FR')} · ${item.action}`).join('\n');
      alert(lines || 'Aucun événement d’audit pour cette pointeuse.');
    });
    if (action === 'status-device') return withBusy(async () => {
      await callRpc('set_time_clock_device_status', { p_device_id: target.dataset.device, p_status: target.dataset.status, p_reason: null });
      await loadManagerData();
    });
    if (action === 'revoke-device') {
      const reason = prompt('Motif de la révocation (facultatif) :') || '';
      return withBusy(async () => { await callRpc('set_time_clock_device_status', { p_device_id: target.dataset.device, p_status: 'revoked', p_reason: reason }); await loadManagerData(); });
    }
    if (action === 'rename-device') {
      const device = state.devices.find((item) => item.id === target.dataset.device);
      const name = prompt('Nom de la pointeuse :', device?.name || '');
      if (!name) return;
      const location = prompt('Emplacement (facultatif) :', device?.location || '') || '';
      return withBusy(async () => { await callRpc('update_time_clock_device', { p_device_id: device.id, p_name: name, p_location: location, p_description: device.description || null }); await loadManagerData(); });
    }
    if (action === 'remove-device') {
      const device = state.devices.find((item) => item.id === target.dataset.device);
      const count = Number(device?.event_count || 0);
      const text = count ? `Cette pointeuse a enregistré ${count} pointage(s). Elle sera désactivée et archivée, mais son historique sera conservé.` : 'Cette pointeuse n’a enregistré aucun pointage. Elle peut être supprimée définitivement.';
      if (!confirm(text)) return;
      return withBusy(async () => { const result = await callRpc('delete_or_archive_time_clock_device', { p_device_id: device.id }); await loadManagerData(); state.message = { kind: 'ok', text: result.result === 'archived' ? 'Pointeuse archivée, historique conservé.' : 'Pointeuse supprimée.' }; });
    }
  }

  async function initialize() {
    try {
      if (!crypto?.subtle || !crypto?.randomUUID) throw appError('HTTPS ou localhost est requis pour sécuriser ce terminal.');
      if (state.invitationToken) { state.screen = 'pin-invitation'; return render(); }
      await loadDevice();
      state.screen = params.get('mode') === 'manage' ? 'manager-login' : state.device ? 'kiosk' : 'activation';
      render();
      if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => undefined);
      if (state.device && navigator.onLine) {
        try { await refreshDevice(); }
        catch (error) {
          state.device.status = 'revoked';
          state.message = { kind: 'error', text: errorMessage(error) };
        }
        render();
      }
    } catch (error) {
      setRoot(`<main class="tc-main"><section class="tc-dialog"><h1>Pointeuse indisponible</h1><p>${escapeHtml(errorMessage(error))}</p></section></main>`);
    }
  }

  document.addEventListener('submit', (event) => { void handleSubmit(event); });
  document.addEventListener('click', (event) => { void handleClick(event); });
  document.addEventListener('change', (event) => {
    if (event.target?.id === 'manager-org') void withBusy(async () => { state.organizationId = event.target.value; state.activation = null; await loadManagerData(); });
  });
  window.addEventListener('online', () => { state.message = null; if (state.device) void withBusy(refreshDevice); else render(); });
  window.addEventListener('offline', render);
  window.setInterval(updateClock, 1000);
  window.setInterval(() => { if (state.device && navigator.onLine && state.screen === 'kiosk') void refreshDevice().catch(() => undefined); }, 90000);

  void initialize();
}());
