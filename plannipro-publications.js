(function () {
  'use strict';

  const state = { snapshot: null, hash: '', latest: null, history: [], channel: null, timer: null, loading: false };
  const labels = {
    draft: 'Brouillon', publishing: 'Publication en cours', published: 'Publié',
    modified_after_publication: 'Modifié après publication', partially_sent: 'Envoi partiel', send_failed: 'Échec d’envoi'
  };
  const api = { refresh, openPublishDialog, openHistory, shutdown, canonicalize, stableHash, changedEmployeeIds };
  window.PlanniProPublications = api;

  function cloud() { return window.PlanniProCloud; }
  function client() { return cloud()?.client; }
  function context() { return cloud()?.context || {}; }
  function toast(message, type) { if (typeof window.toast === 'function') window.toast(message, type || 'info'); }
  function esc(value) { return String(value ?? '').replace(/[&<>'"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' })[c]); }

  function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') {
      return Object.keys(value).sort().reduce((output, key) => { output[key] = canonicalize(value[key]); return output; }, {});
    }
    return value;
  }

  async function stableHash(value) {
    const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(value)));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  async function changedEmployeeIds(previous, current) {
    const oldEmployees = new Map((previous?.employees || []).map((employee) => [employee.employee_id, employee]));
    const changed = [];
    for (const employee of current?.employees || []) {
      if (await stableHash(oldEmployees.get(employee.employee_id) || null) !== await stableHash(employee)) changed.push(employee.employee_id);
    }
    return changed;
  }

  function slot() { return document.getElementById('planningPublicationSlot'); }
  function historySlot() { return document.getElementById('planningPublicationHistorySlot'); }
  function renderSlot() {
    const root = slot(); if (!root) return;
    const historyRoot = historySlot();
    const canPublish = Boolean(cloud()?.can?.('planning', 'publish'));
    let status = state.latest?.status || 'draft';
    if (state.latest && state.hash && state.latest.content_hash !== state.hash && ['published','partially_sent','send_failed'].includes(status)) status = 'modified_after_publication';
    root.innerHTML = `<span class="pp-publication-status" data-status="${esc(status)}" title="Version ${esc(state.latest?.version || '—')}">${esc(labels[status] || status)}</span>`+
      (canPublish ? `<button type="button" class="pp-publish-button" aria-label="Publier le planning" title="Publier le planning" ${!navigator.onLine || state.loading ? 'disabled' : ''}>Publier le planning</button>` : '');
    if (historyRoot) {
      historyRoot.innerHTML = canPublish ? '<button type="button" class="topbar-tool-item" data-pp-publication-history title="Historique des publications"><span class="topbar-tool-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 16 14"/></svg></span><span class="topbar-tool-copy"><strong>Historique des publications</strong><small>Versions et envois précédents</small></span></button>' : '';
      historyRoot.querySelector('[data-pp-publication-history]')?.addEventListener('click', openHistory);
    }
    root.querySelector('.pp-publish-button')?.addEventListener('click', openPublishDialog);
  }

  async function refresh(snapshot) {
    state.snapshot = snapshot || null;
    clearTimeout(state.timer);
    if (!snapshot || !client() || !context().organization_id || !context().primary_establishment_id) { state.latest = null; renderSlot(); return; }
    state.timer = setTimeout(async () => {
      state.hash = await stableHash(snapshot);
      const result = await client().from('planning_publications').select('id,version,status,content_hash,snapshot,global_pdf_path,published_at,created_at')
        .eq('organization_id', context().organization_id)
        .eq('establishment_id', context().primary_establishment_id)
        .eq('week_start', snapshot.week_start).order('version', { ascending: false }).limit(20);
      if (!result.error) { cloud().planningPublicationsAvailable = true; state.history = result.data || []; state.latest = state.history[0] || null; }
      renderSlot(); subscribe();
    }, 80);
  }

  async function preview() {
    const result = await client().rpc('preview_planning_publication_recipients', {
      p_organization_id: context().organization_id,
      p_establishment_id: context().primary_establishment_id,
      p_employee_ids: (state.snapshot?.employees || []).map((employee) => employee.employee_id)
    });
    if (result.error) throw result.error;
    return result.data || { total: 0, ready: 0, missing_email: 0, invalid_email: 0, disabled: 0 };
  }

  async function openPublishDialog() {
    if (!cloud()?.require?.('planning', 'publish')) return;
    if (!navigator.onLine) return toast('La publication nécessite une connexion sécurisée.', 'err');
    if (!state.snapshot?.employees?.length) return toast('Aucun salarié planifié pour cet établissement.', 'err');
    state.loading = true; renderSlot();
    try {
      const counts = await preview();
      const changed = state.latest ? await changedEmployeeIds(state.latest.snapshot, state.snapshot) : state.snapshot.employees.map((e) => e.employee_id);
      const dialog = document.createElement('div'); dialog.className = 'pp-publication-dialog';
      dialog.innerHTML = `<section class="pp-publication-card" role="dialog" aria-modal="true" aria-labelledby="pp-publish-title">
        <h2 id="pp-publish-title">Publier le planning</h2><p>Semaine du ${esc(state.snapshot.week_start)} · un instantané immuable et une nouvelle version seront conservés.</p>
        <div class="pp-publication-summary"><div><strong>${counts.total || 0}</strong><span>salariés concernés</span></div><div><strong>${counts.ready || 0}</strong><span>e-mails valides et activés</span></div><div><strong>${(counts.missing_email || 0)+(counts.invalid_email || 0)+(counts.disabled || 0)}</strong><span>non envoyables</span></div></div>
        ${counts.missing_email || counts.invalid_email || counts.disabled ? `<div class="pp-publication-warning">${counts.missing_email || 0} sans e-mail, ${counts.invalid_email || 0} invalide(s), ${counts.disabled || 0} préférence(s) désactivée(s). Ils seront tracés, jamais déclarés envoyés.</div>` : ''}
        <div class="pp-publication-options">
          <label><input type="checkbox" name="global_pdf" checked disabled> Générer et conserver le PDF global A4 paysage</label>
          <label><input type="checkbox" name="individual_pdf" checked disabled> Générer un PDF individuel confidentiel par destinataire</label>
          ${state.latest ? `<label><input type="radio" name="scope" value="changed" checked> Republier uniquement les ${changed.length} salarié(s) dont le contenu a changé</label><label><input type="radio" name="scope" value="all"> Republier tous les salariés</label>` : ''}
        </div>
        <div class="pp-publication-actions"><button type="button" data-cancel>Annuler</button><button type="button" class="primary" data-confirm>Créer la version et envoyer</button></div>
      </section>`;
      document.body.appendChild(dialog);
      dialog.querySelector('[data-cancel]').onclick = () => dialog.remove();
      dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.remove(); });
      dialog.querySelector('[data-confirm]').onclick = async () => {
        const scope = dialog.querySelector('input[name="scope"]:checked')?.value || 'all';
        const recipients = scope === 'changed' ? changed : state.snapshot.employees.map((employee) => employee.employee_id);
        if (!recipients.length) return toast('Aucun planning modifié à republier.', 'info');
        dialog.querySelector('[data-confirm]').disabled = true;
        try { await publish(recipients); dialog.remove(); }
        catch (error) { console.error('[PlanniPro Publications]', error); toast(error.message || 'Publication impossible.', 'err'); dialog.querySelector('[data-confirm]').disabled = false; }
      };
    } catch (error) { console.error('[PlanniPro Publications]', error); toast(error.message || 'Destinataires impossibles à vérifier.', 'err'); }
    finally { state.loading = false; renderSlot(); }
  }

  async function publish(recipientIds) {
    state.loading = true; renderSlot();
    try {
      const idempotencyKey = await stableHash({ organization_id: context().organization_id,
        establishment_id: context().primary_establishment_id, week_start: state.snapshot.week_start,
        content_hash: state.hash, recipient_ids: recipientIds.slice().sort() });
      const response = await client().functions.invoke('publish-planning', { body: {
        action: 'publish', organization_id: context().organization_id,
        establishment_id: context().primary_establishment_id, week_start: state.snapshot.week_start,
        content_hash: state.hash, snapshot: state.snapshot,
        options: { global_pdf: true, individual_pdf: true }, idempotency_key: idempotencyKey,
        recipient_ids: recipientIds
      }});
      if (response.error) throw response.error;
      if (response.data?.error) throw new Error(response.data.error);
      toast(response.data?.status === 'published' ? 'Planning publié et e-mails acceptés par le fournisseur.' : 'Publication terminée avec des envois à vérifier.', response.data?.status === 'published' ? 'ok' : 'info');
      await refresh(state.snapshot);
    } finally { state.loading = false; renderSlot(); }
  }

  async function retry(publicationId) {
    const response = await client().functions.invoke('publish-planning', { body: { action: 'retry', publication_id: publicationId } });
    if (response.error || response.data?.error) throw response.error || new Error(response.data.error);
    toast('Nouvelle tentative terminée.', response.data.status === 'published' ? 'ok' : 'info');
    await refresh(state.snapshot);
  }

  async function downloadPdf(path) {
    if (!path) return;
    const result = await client().storage.from('planning-publications').createSignedUrl(path, 60);
    if (result.error) throw result.error;
    window.open(result.data.signedUrl, '_blank', 'noopener,noreferrer');
  }

  async function openHistory() {
    const dialog = document.createElement('div'); dialog.className = 'pp-publication-dialog';
    const rows = state.history.map((publication) => `<tr><td>v${publication.version}</td><td>${esc(labels[publication.status] || publication.status)}</td><td>${esc(new Date(publication.published_at || publication.created_at).toLocaleString('fr-FR'))}</td><td>${publication.global_pdf_path ? `<button data-download="${esc(publication.global_pdf_path)}">PDF global</button>` : ''} ${['partially_sent','send_failed'].includes(publication.status) ? `<button data-retry="${publication.id}">Réessayer</button>` : ''}</td></tr>`).join('');
    dialog.innerHTML = `<section class="pp-publication-card" role="dialog" aria-modal="true"><h2>Historique des publications</h2><p>Chaque version conserve son instantané, son hash et son journal de livraison.</p><table class="pp-publication-history"><thead><tr><th>Version</th><th>Statut</th><th>Date</th><th>Actions</th></tr></thead><tbody>${rows || '<tr><td colspan="4">Aucune publication.</td></tr>'}</tbody></table><div class="pp-publication-actions"><button data-close>Fermer</button></div></section>`;
    document.body.appendChild(dialog);
    dialog.querySelector('[data-close]').onclick = () => dialog.remove();
    dialog.querySelectorAll('[data-download]').forEach((button) => button.onclick = () => downloadPdf(button.dataset.download).catch((error) => toast(error.message, 'err')));
    dialog.querySelectorAll('[data-retry]').forEach((button) => button.onclick = async () => { button.disabled = true; try { await retry(button.dataset.retry); dialog.remove(); } catch (error) { toast(error.message, 'err'); button.disabled = false; } });
  }

  function subscribe() {
    if (!client() || !context().organization_id || state.channel) return;
    state.channel = client().channel(`planning-publications:${context().organization_id}:${crypto.randomUUID()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'planning_publications', filter: `organization_id=eq.${context().organization_id}` }, () => refresh(state.snapshot))
      .subscribe();
  }

  async function shutdown() {
    clearTimeout(state.timer);
    if (state.channel && client()) { try { await client().removeChannel(state.channel); } catch (_) {} }
    state.channel = null; state.snapshot = null; state.latest = null; state.history = []; state.hash = '';
    document.querySelectorAll('.pp-publication-dialog').forEach((node) => node.remove());
    renderSlot();
  }
})();
