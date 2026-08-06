import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = (file) => fs.readFileSync(new URL(file, root), 'utf8');
const sql = read('supabase/hr-vault.sql');
const vault = read('plannipro-vault.js');
const vaultCss = read('plannipro-vault.css');
const cloud = read('plannipro-cloud.js');
const index = read('index.html');
const shell = read('sw.js');

function includes(source, expected, label = expected) {
  assert.ok(source.includes(expected), `Missing: ${label}`);
}

includes(sql, 'begin;', 'transaction start');
assert.ok(sql.trimEnd().endsWith('commit;'), 'Migration must commit as one transaction');

[
  'document_categories', 'employee_document_folders', 'document_versions', 'document_audit_logs'
].forEach((table) => includes(sql, `public.${table}`, `vault table ${table}`));

[
  'Contrat de travail', 'Avenants', 'Pièce d’identité', 'Carte Vitale', 'RIB', 'Permis',
  'Diplômes', 'Visite médicale', 'Autorisations diverses', 'Attestations', 'Sanctions',
  'Entretiens annuels', 'Formations', 'Documents libres'
].forEach((category) => includes(sql, `'${category}'`, `default category ${category}`));

[
  'documents.upload', 'documents.download', 'documents.restore', 'documents.manage_categories',
  'documents.audit', 'documents.view_sensitive'
].forEach((permission) => includes(sql, `'${permission}'`, `granular permission ${permission}`));

[
  'has_hr_document_action', 'can_access_hr_document_values', 'can_access_hr_document',
  'can_access_hr_employee', 'create_hr_document_version', 'soft_delete_hr_document',
  'restore_hr_document', 'log_hr_document_access', 'save_hr_document_category',
  'search_hr_documents', 'can_upload_hr_vault_object', 'can_read_hr_vault_object'
].forEach((fn) => includes(sql, `function public.${fn}`, `vault function ${fn}`));

includes(sql, 'generated always as (', 'generated full-text search vector');
includes(sql, 'using gin(search_vector)', 'full-text GIN index');
includes(sql, "websearch_to_tsquery('french'", 'French web search');
includes(sql, 'create or replace view public.hr_document_alerts', 'expiration and missing-document alerts');
includes(sql, "'expired'", 'expired alert');
includes(sql, "'expiring'", 'expiring alert');
includes(sql, "'missing'", 'missing document alert');

includes(sql, 'create trigger document_versions_immutable before update or delete', 'immutable version trigger');
includes(sql, "raise exception 'Document versions are immutable'", 'immutable version enforcement');
includes(sql, 'deleted_at=now()', 'soft deletion');
includes(sql, 'deleted_at=null', 'restoration');
assert.ok(!/delete\s+from\s+public\.documents/i.test(sql), 'Vault RPC must not hard-delete documents');

[
  'alter table public.document_categories enable row level security',
  'alter table public.employee_document_folders enable row level security',
  'alter table public.documents enable row level security',
  'alter table public.document_versions enable row level security',
  'alter table public.document_audit_logs enable row level security',
  'create policy documents_select', 'create policy document_versions_select',
  'create policy document_audit_logs_select'
].forEach((rule) => includes(sql, rule, `RLS rule ${rule}`));

includes(sql, "'plannipro-documents','plannipro-documents',false", 'private Storage bucket');
includes(sql, 'create policy plannipro_documents_insert', 'Storage upload policy');
includes(sql, 'create policy plannipro_documents_select', 'Storage read policy');
includes(sql, 'create policy plannipro_documents_delete_orphan', 'orphan-only Storage cleanup');
includes(sql, 'drop policy if exists plannipro_documents_update', 'Storage overwrite policy removed');
assert.ok(!/create policy plannipro_documents_update/i.test(sql), 'Storage UPDATE policy must not exist');
includes(sql, 'revoke insert,update,delete on public.document_categories,public.employee_document_folders', 'direct writes revoked on vault control tables');
includes(sql, 'public.document_versions,public.document_audit_logs from authenticated', 'direct version and audit writes revoked');
includes(sql, "owner_id=(select auth.uid()::text)", 'only uploader can remove an orphan');
includes(sql, "p_path like '%..%'", 'path traversal rejection');
includes(sql, "raise exception 'Not authorized to upload this sensitive document category'", 'sensitive-category upload guard');
const auditPolicy = sql.match(/create policy document_audit_logs_select[\s\S]*?;\n/)?.[0] || '';
includes(auditPolicy, "can_access_hr_document(document_id,'audit')", 'audit permission enforced by RLS');
assert.ok(!auditPolicy.includes("can_access_hr_document(document_id,'view')"), 'Document viewers must not automatically see the audit log');

assert.ok(!/SUPABASE_SERVICE_ROLE_KEY|service_role\s*[:=]/i.test(`${vault}\n${cloud}\n${index}`), 'Browser code must not contain a service role key');
assert.ok(!/(?:localStorage|indexedDB)\s*\./i.test(vault), 'Vault must not persist documents in browser storage');
includes(vault, ".upload(path, file, { upsert: false", 'non-overwriting Storage upload');
includes(vault, "rpc('create_hr_document_version'", 'version creation RPC');
includes(vault, "rpc('log_hr_document_access'", 'view/download audit RPC');
includes(vault, "rpc('search_hr_documents'", 'search RPC');
includes(vault, 'p_organization_id: org', 'search RPC is pinned to the active organization');
includes(sql, 'where d.organization_id=p_organization_id', 'search SQL is pinned to the requested organization');
includes(vault, 'state.requestEpoch', 'stale organization requests are invalidated');
includes(vault, "table: 'documents'", 'document Realtime subscription');
includes(vault, "table: 'document_versions'", 'version Realtime subscription');
includes(vault, "crypto.subtle.digest('SHA-256'", 'client checksum');
includes(vault, 'URL.revokeObjectURL', 'preview URL cleanup');
includes(vault, 'Aucun document n’est conservé hors ligne', 'explicit cloud-only offline behavior');

assert.ok(!cloud.includes('getHRDocument'), 'Generic cloud sync must not read legacy document blobs');
assert.ok(!cloud.includes("from('documents').delete()"), 'Generic cloud sync must not hard-delete vault documents');
assert.ok(!cloud.includes("from('documents').upsert("), 'Generic cloud sync must not overwrite vault metadata');
includes(cloud, "employees.map(({ documents, ...employee }) => employee)", 'vault metadata excluded from generic cache');
includes(cloud, "key === 'documents'", 'vault metadata excluded from private employee payload');
includes(cloud, "vault: ['documents', 'view']", 'vault navigation RBAC');

includes(index, 'id="view-vault"', 'vault page');
includes(index, 'id="sb-vault"', 'vault navigation');
includes(index, './plannipro-vault.js', 'vault script');
includes(index, './plannipro-vault.css', 'vault stylesheet');
assert.ok(!index.includes('id="hrDocFile"'), 'legacy local document input must be removed');
assert.ok(!index.includes("const HR_DOC_DB="), 'legacy document IndexedDB writer must be removed');

[
  'vault-page', 'vault-hero', 'vault-toolbar', 'vault-workspace', 'vault-document',
  'vault-detail', 'vault-dialog', 'vault-dropzone', 'vault-preview', 'vault-compare',
  'vault-category-row', 'vault-alert-summary'
].forEach((className) => includes(vaultCss, `.${className}`, `vault style ${className}`));
assert.equal((vaultCss.match(/{/g) || []).length, (vaultCss.match(/}/g) || []).length, 'Vault CSS braces must be balanced');
includes(vaultCss, '@media(max-width:700px)', 'mobile vault layout');

includes(shell, 'plannipro-shell-v31', 'service worker cache increment');
includes(shell, './plannipro-vault.js', 'vault module cached');
includes(shell, './plannipro-vault.css', 'vault styles cached');

const inlineScripts = [...index.matchAll(/<script>([\s\S]*?)<\/script>/g)];
assert.equal(inlineScripts.length, 1, 'The application must retain one parseable inline script');
new vm.Script(inlineScripts[0][1], { filename: 'index-inline.js' });
new vm.Script(cloud, { filename: 'plannipro-cloud.js' });
new vm.Script(vault, { filename: 'plannipro-vault.js' });
new vm.Script(shell, { filename: 'sw.js' });

console.log('HR Vault Enterprise/static security checks: OK');
