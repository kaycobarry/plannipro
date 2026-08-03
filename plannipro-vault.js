(function () {
  'use strict';

  const BUCKET = 'plannipro-documents';
  const MAX_FILE_BYTES = 50 * 1024 * 1024;
  const ALLOWED_TYPES = new Set([
    'application/pdf', 'image/jpeg', 'image/png', 'image/webp',
    'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain'
  ]);
  const state = {
    categories: [], employees: [], establishments: [], documents: [], alerts: [],
    selected: null, versions: [], audit: [], channel: null, previewUrls: new Set(),
    loading: false, ready: false, employeeFilter: '', refreshTimer: null, requestEpoch: 0
  };

  const Vault = {
    render, refresh: load, openForEmployee, shutdown,
    get state() { return state; }
  };
  window.PlanniProVault = Vault;

  function cloud() { return window.PlanniProCloud; }
  function client() { return cloud()?.client; }
  function context() { return cloud()?.context || {}; }
  function permitted(action) {
    const app = cloud();
    if (!app?.can) return false;
    return app.can('documents', action) || app.can('documents', 'manage');
  }
  function esc(value) {
    return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
  }
  function toast(message, type) {
    if (typeof window.toast === 'function') window.toast(message, type || 'info');
    else console.info('[PlanniPro Vault]', message);
  }
  function fail(error, fallback) {
    console.error('[PlanniPro Vault]', error);
    toast(error?.message || fallback || 'Une erreur est survenue.', 'err');
  }
  function formatBytes(value) {
    const bytes = Number(value) || 0;
    if (bytes < 1024) return `${bytes} o`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} Ko`;
    return `${(bytes / 1048576).toFixed(1)} Mo`;
  }
  function formatDate(value) {
    if (!value) return '—';
    return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium' }).format(new Date(`${String(value).slice(0, 10)}T12:00:00`));
  }
  function employeeName(id) {
    return state.employees.find((row) => row.id === id)?.display_name || 'Salarié supprimé';
  }
  function categoryName(id) {
    return state.categories.find((row) => row.id === id)?.label || 'Sans catégorie';
  }
  function establishmentName(id) {
    return state.establishments.find((row) => row.id === id)?.name || 'Établissement';
  }
  function root() { return document.getElementById('vaultRoot'); }
  function requireOnline() {
    if (!navigator.onLine) {
      toast('Le coffre-fort requiert une connexion sécurisée. Aucun document n’est conservé hors ligne.', 'err');
      return false;
    }
    return true;
  }

  function render() {
    const node = root();
    if (!node) return;
    if (!client() || !context().organization_id) {
      node.innerHTML = '<div class="vault-empty"><strong>Connexion au coffre-fort en cours…</strong><span>La session Supabase doit être active.</span></div>';
      return;
    }
    node.innerHTML = `
      <section class="vault-shell">
        <header class="vault-hero">
          <div><span class="vault-eyebrow">Coffre-fort RH Enterprise</span><h2>Documents salariés</h2><p>Fichiers privés, versionnés et contrôlés par les permissions PlanniPro.</p></div>
          <div class="vault-hero-actions">
            ${permitted('manage_categories') ? '<button class="btn btn-outline" data-vault-action="categories">Catégories</button>' : ''}
            ${permitted('upload') || permitted('create') ? '<button class="btn btn-primary" data-vault-action="upload">Déposer un document</button>' : ''}
          </div>
        </header>
        <div class="vault-kpis" id="vaultKpis"></div>
        <form class="vault-toolbar" id="vaultFilters">
          <label class="vault-search"><span>Rechercher</span><input name="search" type="search" placeholder="Nom, description…"></label>
          <label><span>Catégorie</span><select name="category"><option value="">Toutes</option>${categoryOptions()}</select></label>
          <label><span>Salarié</span><select name="employee"><option value="">Tous</option>${employeeOptions(state.employeeFilter)}</select></label>
          <label><span>Établissement</span><select name="establishment"><option value="">Tous</option>${establishmentOptions()}</select></label>
          <label><span>État</span><select name="status"><option value="active">Actifs</option><option value="expired">Expirés</option><option value="missing">Manquants</option><option value="deleted">Corbeille</option></select></label>
          <button class="btn btn-outline" type="submit">Filtrer</button>
        </form>
        <div class="vault-workspace">
          <div class="vault-list" id="vaultList"></div>
          <aside class="vault-detail" id="vaultDetail"><div class="vault-empty"><strong>Sélectionnez un document</strong><span>Versions, aperçu et journal d’audit apparaîtront ici.</span></div></aside>
        </div>
      </section>`;
    bindRoot();
    renderKpis();
    renderList();
  }

  function categoryOptions(selected = '') {
    return state.categories.filter((row) => row.is_active !== false).map((row) => `<option value="${row.id}" ${row.id === selected ? 'selected' : ''}>${esc(row.label)}</option>`).join('');
  }
  function employeeOptions(selected = '') {
    return state.employees.map((row) => `<option value="${row.id}" ${row.id === selected ? 'selected' : ''}>${esc(row.display_name)}</option>`).join('');
  }
  function establishmentOptions(selected = '') {
    return state.establishments.map((row) => `<option value="${row.id}" ${row.id === selected ? 'selected' : ''}>${esc(row.name)}</option>`).join('');
  }
  function bindRoot() {
    const node = root();
    node?.addEventListener('click', handleClick);
    node?.querySelector('#vaultFilters')?.addEventListener('submit', (event) => { event.preventDefault(); loadDocuments(); });
  }

  async function load() {
    if (state.loading || !client() || !context().organization_id) return;
    const org = context().organization_id;
    const epoch = state.requestEpoch;
    state.loading = true;
    try {
      const [categories, employees, establishments, alerts] = await Promise.all([
        client().from('document_categories').select('*').eq('organization_id', org).order('sort_order'),
        client().from('employees').select('id,display_name,establishment_id,employment_status').eq('organization_id', org).order('display_name'),
        client().from('establishments').select('id,name').eq('organization_id', org).order('name'),
        client().from('hr_document_alerts').select('*').eq('organization_id', org).order('severity', { ascending: false })
      ]);
      [categories, employees, establishments, alerts].forEach((result) => { if (result.error) throw result.error; });
      if (state.requestEpoch !== epoch || context().organization_id !== org) return;
      state.categories = categories.data || [];
      state.employees = employees.data || [];
      state.establishments = establishments.data || [];
      state.alerts = alerts.data || [];
      state.ready = true;
      render();
      await loadDocuments();
      renderHrAlerts();
      subscribe();
    } catch (error) {
      const node = root();
      if (node) node.innerHTML = `<div class="vault-empty vault-error"><strong>Coffre-fort indisponible</strong><span>${esc(error.message)}</span><small>La migration supabase/hr-vault.sql doit être appliquée avant l’utilisation.</small></div>`;
      fail(error, 'Impossible de charger le coffre-fort.');
    } finally { if (state.requestEpoch === epoch) state.loading = false; }
  }

  function filterValues() {
    const form = root()?.querySelector('#vaultFilters');
    const data = form ? new FormData(form) : new FormData();
    return {
      search: String(data.get('search') || '').trim(), category: String(data.get('category') || ''),
      employee: String(data.get('employee') || state.employeeFilter || ''), establishment: String(data.get('establishment') || ''),
      status: String(data.get('status') || 'active')
    };
  }
  async function loadDocuments() {
    if (!client() || !state.ready) return;
    const org = context().organization_id;
    const epoch = state.requestEpoch;
    const filters = filterValues();
    if (filters.status === 'missing') {
      state.documents = state.alerts.filter((row) => row.alert_type === 'missing' && (!filters.employee || row.employee_id === filters.employee) && (!filters.category || row.category_id === filters.category) && (!filters.establishment || row.establishment_id === filters.establishment));
      renderList(true); renderKpis(); return;
    }
    const result = await client().rpc('search_hr_documents', {
      p_organization_id: org, p_search: filters.search || null, p_category_id: filters.category || null,
      p_employee_id: filters.employee || null, p_establishment_id: filters.establishment || null,
      p_expired: filters.status === 'expired' ? true : null, p_include_deleted: filters.status === 'deleted'
    });
    if (result.error) return fail(result.error, 'Recherche impossible.');
    if (state.requestEpoch !== epoch || context().organization_id !== org) return;
    state.documents = (result.data || []).filter((row) => filters.status === 'deleted' ? Boolean(row.deleted_at) : !row.deleted_at);
    state.selected = state.documents.some((row) => (row.document_id || row.id) === state.selected?.document_id) ? state.selected : null;
    renderList(); renderKpis();
    if (!state.selected) renderDetail();
  }

  function renderKpis() {
    const node = document.getElementById('vaultKpis');
    if (!node) return;
    const expired = state.alerts.filter((row) => row.alert_type === 'expired').length;
    const expiring = state.alerts.filter((row) => row.alert_type === 'expiring').length;
    const missing = state.alerts.filter((row) => row.alert_type === 'missing').length;
    node.innerHTML = `<div><strong>${state.documents.length}</strong><span>documents filtrés</span></div><div class="vault-kpi-danger"><strong>${expired}</strong><span>expirés</span></div><div class="vault-kpi-warn"><strong>${expiring}</strong><span>à renouveler</span></div><div><strong>${missing}</strong><span>documents manquants</span></div>`;
  }
  function renderList(missing = false) {
    const node = document.getElementById('vaultList');
    if (!node) return;
    if (!state.documents.length) {
      node.innerHTML = '<div class="vault-empty"><strong>Aucun résultat</strong><span>Aucun document ne correspond aux filtres.</span></div>';
      return;
    }
    node.innerHTML = state.documents.map((row) => {
      const id = row.document_id || row.id;
      const selected = state.selected?.document_id === id ? ' is-selected' : '';
      if (missing) return `<button class="vault-document${selected}" type="button" data-vault-missing="${esc(row.alert_id)}"><span class="vault-file-icon">!</span><span><strong>${esc(row.category_name)}</strong><small>${esc(employeeName(row.employee_id))} · document manquant</small></span></button>`;
      const expired = row.expires_on && String(row.expires_on).slice(0, 10) < new Date().toISOString().slice(0, 10);
      return `<button class="vault-document${selected}" type="button" data-vault-document="${id}"><span class="vault-file-icon">${esc((row.file_name || 'D').split('.').pop().slice(0, 3).toUpperCase())}</span><span><strong>${esc(row.file_name)}</strong><small>${esc(employeeName(row.employee_id))} · ${esc(categoryName(row.category_id))}</small></span><span class="vault-document-meta">v${row.current_version || 1}${expired ? '<em>Expiré</em>' : ''}${row.deleted_at ? '<em>Corbeille</em>' : ''}</span></button>`;
    }).join('');
  }

  async function selectDocument(id) {
    state.selected = state.documents.find((row) => (row.document_id || row.id) === id) || null;
    renderList();
    if (!state.selected) return renderDetail();
    const viewed = await client().rpc('log_hr_document_access', { p_document_id: id, p_version_id: null, p_action: 'document.viewed' });
    if (viewed.error) return fail(viewed.error, 'Consultation non autorisée.');
    const [versions, audit] = await Promise.all([
      client().from('document_versions').select('*').eq('document_id', id).order('version_number', { ascending: false }),
      permitted('audit')
        ? client().from('document_audit_logs').select('*').eq('document_id', id).order('created_at', { ascending: false }).limit(100)
        : Promise.resolve({ data: [], error: null })
    ]);
    if (versions.error) fail(versions.error); else state.versions = versions.data || [];
    if (audit.error) fail(audit.error); else state.audit = audit.data || [];
    renderDetail();
  }
  function renderDetail() {
    const node = document.getElementById('vaultDetail');
    if (!node) return;
    const doc = state.selected;
    if (!doc) {
      node.innerHTML = '<div class="vault-empty"><strong>Sélectionnez un document</strong><span>Versions, aperçu et journal d’audit apparaîtront ici.</span></div>';
      return;
    }
    const buttons = [];
    const currentVersion = state.versions[0];
    if (permitted('download')) buttons.push('<button class="btn btn-primary" data-vault-action="preview">Aperçu</button>', '<button class="btn btn-outline" data-vault-action="download">Télécharger</button>');
    if (!doc.deleted_at && (permitted('upload') || permitted('update'))) buttons.push('<button class="btn btn-outline" data-vault-action="new-version">Nouvelle version</button>');
    if (!doc.deleted_at && permitted('delete')) buttons.push('<button class="btn btn-danger" data-vault-action="delete">Supprimer</button>');
    if (doc.deleted_at && permitted('restore')) buttons.push('<button class="btn btn-primary" data-vault-action="restore">Restaurer</button>');
    node.innerHTML = `<div class="vault-detail-head"><span class="vault-file-icon">DOC</span><div><h3>${esc(doc.file_name)}</h3><p>${esc(employeeName(doc.employee_id))}</p></div></div>
      <div class="vault-actions">${buttons.join('')}</div>
      <dl class="vault-metadata"><div><dt>Catégorie</dt><dd>${esc(categoryName(doc.category_id))}</dd></div><div><dt>Version</dt><dd>${doc.current_version || 1}</dd></div><div><dt>Date de dépôt</dt><dd>${formatDate(currentVersion?.created_at || doc.created_at)}</dd></div><div><dt>Auteur du dépôt</dt><dd>${esc(currentVersion?.uploaded_by === cloud()?.user?.id ? 'Moi' : currentVersion?.uploaded_by || '—')}</dd></div><div><dt>Taille</dt><dd>${formatBytes(doc.size_bytes)}</dd></div><div><dt>Type MIME</dt><dd>${esc(doc.content_type || '—')}</dd></div><div><dt>Expiration</dt><dd>${formatDate(doc.expires_on)}</dd></div><div><dt>Établissement</dt><dd>${esc(establishmentName(doc.establishment_id))}</dd></div><div><dt>Description</dt><dd>${esc(doc.description || '—')}</dd></div></dl>
      <section class="vault-section"><div class="vault-section-title"><h4>Versions</h4>${state.versions.length > 1 ? '<button class="vault-link" data-vault-action="compare">Comparer</button>' : ''}</div>${state.versions.map((v) => `<button class="vault-version" data-vault-version="${v.id}"><span>Version ${v.version_number}</span><small>${formatDate(v.created_at)} · ${formatBytes(v.size_bytes)}</small></button>`).join('') || '<p>Aucune version visible.</p>'}</section>
      ${permitted('audit') ? `<section class="vault-section"><h4>Historique</h4><div class="vault-audit">${state.audit.map((a) => `<div><strong>${esc(a.action.replace('document.', ''))}</strong><small>${new Date(a.created_at).toLocaleString('fr-FR')}</small></div>`).join('') || '<p>Aucune action enregistrée.</p>'}</div></section>` : ''}`;
  }

  async function handleClick(event) {
    const documentButton = event.target.closest('[data-vault-document]');
    if (documentButton) return selectDocument(documentButton.dataset.vaultDocument);
    const versionButton = event.target.closest('[data-vault-version]');
    if (versionButton) return previewVersion(versionButton.dataset.vaultVersion, false);
    const button = event.target.closest('[data-vault-action]');
    if (!button) return;
    const actions = {
      upload: () => openUpload(), 'new-version': () => openUpload(state.selected),
      preview: () => previewVersion(state.versions[0]?.id, false),
      download: () => previewVersion(state.versions[0]?.id, true),
      compare: openCompare, delete: softDelete, restore, categories: openCategories
    };
    await actions[button.dataset.vaultAction]?.();
  }

  function dialog(content, className = '') {
    const box = document.createElement('dialog');
    box.className = `vault-dialog ${className}`;
    box.innerHTML = `<button class="vault-dialog-close" type="button" aria-label="Fermer">×</button>${content}`;
    document.body.appendChild(box);
    box.querySelector('.vault-dialog-close').addEventListener('click', () => box.close());
    box.addEventListener('close', () => box.remove());
    box.showModal();
    return box;
  }
  function openUpload(existing = null) {
    if (!requireOnline()) return;
    const canUpload = permitted('upload') || permitted(existing ? 'update' : 'create');
    if (!canUpload) return toast('Dépôt non autorisé.', 'err');
    const box = dialog(`<h2>${existing ? 'Ajouter une version' : 'Déposer un document'}</h2><p>Le fichier est envoyé directement vers Supabase Storage. Il n’est jamais stocké dans le navigateur.</p>
      <form id="vaultUploadForm" class="vault-form">
        ${existing ? `<div class="vault-current-file">${esc(existing.file_name)} · version ${existing.current_version}</div>` : `<label>Salarié<select name="employee" required><option value="">Choisir…</option>${employeeOptions(state.employeeFilter)}</select></label><label>Catégorie<select name="category" required><option value="">Choisir…</option>${categoryOptions()}</select></label>`}
        <label>Description<textarea name="description" rows="2">${esc(existing?.description || '')}</textarea></label>
        <div class="vault-form-grid"><label>Date d’expiration<input type="date" name="expires" value="${esc(existing?.expires_on || '')}"></label><label>Note de version<input name="note" maxlength="500" placeholder="Motif du changement"></label></div>
        <div class="vault-form-grid"><label class="vault-check"><input type="checkbox" name="employee_visible" ${existing?.employee_visible === false ? '' : 'checked'}>Visible par le salarié</label><label class="vault-check"><input type="checkbox" name="manager_visible" ${existing?.manager_visible ? 'checked' : ''}>Visible par le manager</label></div>
        <label class="vault-dropzone" id="vaultDropzone"><input name="file" type="file" required accept=".pdf,.jpg,.jpeg,.png,.webp,.doc,.docx,.xls,.xlsx,.txt"><strong>Glissez un fichier ici</strong><span>ou cliquez pour parcourir · 50 Mo maximum</span><small id="vaultFileName"></small></label>
        <div class="vault-dialog-actions"><button class="btn btn-outline" type="button" data-vault-cancel>Annuler</button><button class="btn btn-primary" type="submit">Envoyer sans écraser</button></div>
      </form>`);
    const form = box.querySelector('#vaultUploadForm');
    const input = form.elements.file;
    const drop = box.querySelector('#vaultDropzone');
    const showFile = () => { box.querySelector('#vaultFileName').textContent = input.files?.[0]?.name || ''; };
    input.addEventListener('change', showFile);
    ['dragenter', 'dragover'].forEach((name) => drop.addEventListener(name, (event) => { event.preventDefault(); drop.classList.add('is-dragging'); }));
    ['dragleave', 'drop'].forEach((name) => drop.addEventListener(name, (event) => { event.preventDefault(); drop.classList.remove('is-dragging'); }));
    drop.addEventListener('drop', (event) => { if (event.dataTransfer.files.length) { input.files = event.dataTransfer.files; showFile(); } });
    box.querySelector('[data-vault-cancel]').addEventListener('click', () => box.close());
    form.addEventListener('submit', (event) => { event.preventDefault(); upload(form, existing, box); });
  }

  async function sha256(file) {
    if (!crypto.subtle) return null;
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  function safeFileName(name) {
    return String(name || 'document').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(-180);
  }
  async function upload(form, existing, box) {
    if (!requireOnline()) return;
    const data = new FormData(form); const file = data.get('file');
    if (!(file instanceof File) || !file.size) return toast('Sélectionnez un fichier.', 'err');
    if (file.size > MAX_FILE_BYTES) return toast('Le fichier dépasse 50 Mo.', 'err');
    if (!ALLOWED_TYPES.has(file.type)) return toast('Type de fichier non autorisé.', 'err');
    const employeeId = existing?.employee_id || String(data.get('employee') || '');
    const employee = state.employees.find((row) => row.id === employeeId);
    const categoryId = existing?.category_id || String(data.get('category') || '');
    if (!employee || !categoryId) return toast('Salarié ou catégorie invalide.', 'err');
    const documentId = existing?.document_id || crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const organizationId = context().organization_id;
    const path = `${organizationId}/${employee.establishment_id}/${employeeId}/${documentId}/${versionId}/${safeFileName(file.name)}`;
    const submit = form.querySelector('[type="submit"]'); submit.disabled = true; submit.textContent = 'Chiffrement et envoi…';
    let uploaded = false;
    try {
      const checksum = await sha256(file);
      const storage = await client().storage.from(BUCKET).upload(path, file, { upsert: false, contentType: file.type, cacheControl: 'private, max-age=0' });
      if (storage.error) throw storage.error;
      uploaded = true;
      const result = await client().rpc('create_hr_document_version', {
        p_organization_id: organizationId, p_employee_id: employeeId, p_category_id: categoryId,
        p_document_id: documentId, p_version_id: versionId, p_storage_path: path,
        p_file_name: file.name, p_content_type: file.type, p_size_bytes: file.size,
        p_checksum_sha256: checksum, p_description: String(data.get('description') || '').trim(),
        p_expires_on: data.get('expires') || null, p_employee_visible: data.has('employee_visible'),
        p_manager_visible: data.has('manager_visible'), p_change_note: String(data.get('note') || '').trim()
      });
      if (result.error) throw result.error;
      box.close(); toast(existing ? 'Nouvelle version enregistrée.' : 'Document déposé.', 'ok');
      await load();
    } catch (error) {
      if (uploaded) await client().storage.from(BUCKET).remove([path]);
      fail(error, 'Le dépôt a échoué. Aucun document incomplet n’a été conservé.');
    } finally { submit.disabled = false; submit.textContent = 'Envoyer sans écraser'; }
  }

  async function previewVersion(versionId, download) {
    if (!requireOnline() || !versionId) return;
    const version = state.versions.find((row) => row.id === versionId);
    if (!version) return;
    try {
      const audit = await client().rpc('log_hr_document_access', { p_document_id: version.document_id, p_version_id: version.id, p_action: download ? 'document.downloaded' : 'document.viewed' });
      if (audit.error) throw audit.error;
      const result = await client().storage.from(BUCKET).download(version.storage_path);
      if (result.error) throw result.error;
      const url = URL.createObjectURL(result.data); state.previewUrls.add(url);
      if (download) {
        const link = document.createElement('a'); link.href = url; link.download = version.file_name; link.click();
        setTimeout(() => revokeUrl(url), 1000); return;
      }
      const viewable = version.content_type === 'application/pdf' || version.content_type?.startsWith('image/');
      const body = viewable ? (version.content_type === 'application/pdf' ? `<iframe class="vault-preview" src="${url}" title="Aperçu PDF"></iframe>` : `<img class="vault-preview-image" src="${url}" alt="Aperçu de ${esc(version.file_name)}">`) : '<div class="vault-empty"><strong>Aperçu indisponible</strong><span>Téléchargez ce format pour le consulter.</span></div>';
      const box = dialog(`<h2>${esc(version.file_name)}</h2>${body}<div class="vault-dialog-actions"><button class="btn btn-primary" data-preview-download>Télécharger</button></div>`, 'vault-preview-dialog');
      box.addEventListener('close', () => revokeUrl(url), { once: true });
      box.querySelector('[data-preview-download]').addEventListener('click', () => previewVersion(versionId, true));
    } catch (error) { fail(error, 'Accès au document refusé.'); }
  }
  function revokeUrl(url) { URL.revokeObjectURL(url); state.previewUrls.delete(url); }

  function openCompare() {
    if (state.versions.length < 2) return;
    const options = state.versions.map((v) => `<option value="${v.id}">Version ${v.version_number} · ${formatDate(v.created_at)}</option>`).join('');
    const box = dialog(`<h2>Comparer les versions</h2><div class="vault-compare-select"><label>À gauche<select data-compare-left>${options}</select></label><label>À droite<select data-compare-right>${options}</select></label></div><div class="vault-compare" data-compare-output></div>`, 'vault-compare-dialog');
    const left = box.querySelector('[data-compare-left]'); const right = box.querySelector('[data-compare-right]'); right.selectedIndex = 1;
    const update = () => {
      const a = state.versions.find((v) => v.id === left.value); const b = state.versions.find((v) => v.id === right.value);
      box.querySelector('[data-compare-output]').innerHTML = [a, b].map((v) => `<article><h3>Version ${v.version_number}</h3><dl class="vault-metadata"><div><dt>Nom</dt><dd>${esc(v.file_name)}</dd></div><div><dt>Taille</dt><dd>${formatBytes(v.size_bytes)}</dd></div><div><dt>Type</dt><dd>${esc(v.content_type)}</dd></div><div><dt>Déposée</dt><dd>${formatDate(v.created_at)}</dd></div><div><dt>Note</dt><dd>${esc(v.change_note || '—')}</dd></div><div><dt>Empreinte</dt><dd class="vault-hash">${esc(v.checksum_sha256 || '—')}</dd></div></dl><button class="btn btn-outline" data-compare-preview="${v.id}">Aperçu</button></article>`).join('');
    };
    left.addEventListener('change', update); right.addEventListener('change', update);
    box.addEventListener('click', (event) => { const target = event.target.closest('[data-compare-preview]'); if (target) previewVersion(target.dataset.comparePreview, false); });
    update();
  }

  async function softDelete() {
    if (!state.selected || !confirm(`Placer « ${state.selected.file_name} » dans la corbeille ? Les fichiers et versions seront conservés.`)) return;
    const result = await client().rpc('soft_delete_hr_document', { p_document_id: state.selected.document_id });
    if (result.error) return fail(result.error); toast('Document placé dans la corbeille.', 'ok'); await loadDocuments();
  }
  async function restore() {
    if (!state.selected) return;
    const result = await client().rpc('restore_hr_document', { p_document_id: state.selected.document_id });
    if (result.error) return fail(result.error); toast('Document restauré.', 'ok'); await loadDocuments();
  }

  function openCategories() {
    if (!permitted('manage_categories')) return;
    const rows = state.categories.map((row) => `<button class="vault-category-row" type="button" data-category-id="${row.id}"><span><strong>${esc(row.label)}</strong><small>${esc(row.key)}${row.is_required ? ' · obligatoire' : ''}${row.is_sensitive ? ' · sensible' : ''}</small></span><em>${row.is_active ? 'Active' : 'Inactive'}</em></button>`).join('');
    const box = dialog(`<h2>Catégories documentaires</h2><p>La désactivation conserve tous les documents existants.</p><div class="vault-category-list">${rows}</div><button class="btn btn-primary" data-category-id="">Nouvelle catégorie</button>`);
    box.addEventListener('click', (event) => { const target = event.target.closest('[data-category-id]'); if (target) openCategoryForm(target.dataset.categoryId, box); });
  }
  function openCategoryForm(id, parent) {
    const row = state.categories.find((item) => item.id === id);
    const box = dialog(`<h2>${row ? 'Modifier la catégorie' : 'Nouvelle catégorie'}</h2><form class="vault-form" id="vaultCategoryForm"><label>Clé technique<input name="key" value="${esc(row?.key || '')}" pattern="[a-z0-9][a-z0-9_-]{1,63}" ${row ? 'readonly' : 'required'}></label><label>Libellé<input name="label" value="${esc(row?.label || '')}" required maxlength="100"></label><label>Description<textarea name="description">${esc(row?.description || '')}</textarea></label><div class="vault-form-grid"><label>Délai d’alerte (jours)<input type="number" name="alert_days" min="0" max="3650" value="${Number(row?.alert_days ?? 30)}"></label><label>Ordre<input type="number" name="sort_order" value="${Number(row?.sort_order ?? 100)}"></label></div><label class="vault-check"><input type="checkbox" name="sensitive" ${row?.is_sensitive ? 'checked' : ''}>Donnée sensible</label><label class="vault-check"><input type="checkbox" name="employee_visible" ${row?.employee_visible_default ? 'checked' : ''}>Visible par défaut au salarié</label><label class="vault-check"><input type="checkbox" name="manager_visible" ${row?.manager_visible_default ? 'checked' : ''}>Visible par défaut au manager</label><label class="vault-check"><input type="checkbox" name="required" ${row?.is_required ? 'checked' : ''}>Document obligatoire</label><label class="vault-check"><input type="checkbox" name="active" ${row?.is_active !== false ? 'checked' : ''}>Catégorie active</label><div class="vault-dialog-actions"><button class="btn btn-primary" type="submit">Enregistrer</button></div></form>`);
    box.querySelector('form').addEventListener('submit', async (event) => {
      event.preventDefault(); const data = new FormData(event.target);
      const result = await client().rpc('save_hr_document_category', { p_organization_id: context().organization_id, p_category_id: id || null, p_key: String(data.get('key')), p_label: String(data.get('label')), p_description: String(data.get('description') || ''), p_is_sensitive: data.has('sensitive'), p_employee_visible: data.has('employee_visible'), p_manager_visible: data.has('manager_visible'), p_is_required: data.has('required'), p_alert_days: Number(data.get('alert_days')), p_sort_order: Number(data.get('sort_order')), p_is_active: data.has('active') });
      if (result.error) return fail(result.error); box.close(); parent.close(); toast('Catégorie enregistrée.', 'ok'); await load();
    });
  }

  function renderHrAlerts() {
    const node = document.getElementById('hrVaultAlerts');
    if (!node) return;
    const important = state.alerts.filter((row) => row.severity >= 2).slice(0, 6);
    node.innerHTML = `<div class="vault-alert-summary"><div><span class="vault-eyebrow">Coffre-fort RH</span><h3>${state.alerts.length} alerte${state.alerts.length > 1 ? 's' : ''} documentaire${state.alerts.length > 1 ? 's' : ''}</h3></div><button class="btn btn-outline" type="button" data-open-vault>Ouvrir le coffre-fort</button></div>${important.length ? `<div class="vault-alert-chips">${important.map((row) => `<span class="vault-alert-chip severity-${row.severity}">${esc(row.category_name)} · ${esc(employeeName(row.employee_id))}</span>`).join('')}</div>` : ''}`;
    node.querySelector('[data-open-vault]')?.addEventListener('click', () => window.goView?.('vault'));
  }

  function openForEmployee(legacyOrCloudId) {
    const legacy = window.S?.employees?.find((employee) => employee.id === legacyOrCloudId || employee.cloudEmployeeId === legacyOrCloudId);
    state.employeeFilter = legacy?.cloudEmployeeId || legacyOrCloudId || '';
    window.goView?.('vault');
    if (state.ready) { render(); loadDocuments(); } else load();
  }
  function subscribe() {
    if (state.channel || !client() || !context().organization_id) return;
    const refreshSoon = () => {
      clearTimeout(state.refreshTimer);
      state.refreshTimer = setTimeout(() => load(), 400);
    };
    state.channel = client().channel(`hr-vault-${context().organization_id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'documents', filter: `organization_id=eq.${context().organization_id}` }, refreshSoon)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'document_versions', filter: `organization_id=eq.${context().organization_id}` }, refreshSoon)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'document_categories', filter: `organization_id=eq.${context().organization_id}` }, refreshSoon)
      .subscribe();
  }
  async function shutdown() {
    clearTimeout(state.refreshTimer);
    state.requestEpoch += 1;
    state.loading = false;
    const channel = state.channel;
    state.channel = null; state.ready = false; state.selected = null; state.employeeFilter = '';
    state.categories = []; state.employees = []; state.establishments = [];
    state.documents = []; state.alerts = []; state.versions = []; state.audit = [];
    state.previewUrls.forEach((url) => URL.revokeObjectURL(url)); state.previewUrls.clear();
    if (channel && client()) await client().removeChannel(channel);
  }

  window.addEventListener('plannipro:cloud-ready', load);
  window.addEventListener('online', () => { if (document.getElementById('view-vault')?.classList.contains('act')) load(); });
  window.addEventListener('load', () => setTimeout(load, 600));
})();
