# Vérification d’intégration RLS dans Supabase

État avant validation distante :

- `node tests/verify-rbac.mjs` : validé localement.
- Test PostgreSQL local (PGlite) : validé pour le gérant, un manager limité, un salarié, l’élévation de rôle et la suspension.
- Projet Supabase réel : à valider après exécution de `supabase/schema.sql` et déploiement des deux Edge Functions.

Exécuter les scénarios ci-dessous dans le projet Supabase réel. Conserver le résultat de chaque ligne (capture ou note), puis seulement publier GitHub Pages.

| Scénario | Étapes | Résultat attendu | Statut |
| --- | --- | --- | --- |
| Gérant | Créer le premier compte, l’organisation et importer les données locales. | Rôle `owner`, tous les modules, établissement créé et import sans doublons. | À faire |
| Manager limité | Inviter un manager avec l’établissement A, puis tenter de lire/modifier l’établissement B par l’interface et depuis la console. | Planning autorisé seulement dans A ; aucune ligne de B ni modification possible. | À faire |
| Salarié | Inviter un salarié lié à son `employee_id`. Exécuter `from('employees').select()` et consulter planning, pointages, absences, documents. | Uniquement sa fiche et ses propres données ; aucune donnée RH privée. | À faire |
| Élévation de privilège | Avec le manager ou salarié, tenter `organization_members.update({ role_id: ownerRoleId })` et une insertion directe dans `organization_members`. | Refus RLS ; seul `claim_invitation()` peut rattacher un compte. | À faire |
| Périmètre et droits | Donner à un manager `users.manage_users`, puis tenter une invitation ou des droits individuels sur un salarié hors périmètre. | Refus RLS ; le manager ne peut pas élargir les périmètres ni attribuer un rôle supérieur. | À faire |
| Suspension | Suspendre le manager depuis l’interface et rafraîchir l’autre appareil. | RLS refuse les données immédiatement ; le compte est banni pour les prochaines sessions/renouvellements. | À faire |
| Multi-entreprises | Avec un second compte, créer une organisation B et essayer de lire/modifier A via une requête directe. | Zéro donnée de A visible ou modifiable depuis B. | À faire |
| Audit | Modifier un planning, une absence, un salarié, un rôle et une permission ; exporter puis imprimer. | Entrées `audit_logs` correspondantes ; contrats/paie ne sont pas copiés en clair dans le journal. | À faire |
| Hors ligne | Couper Internet, modifier un shift autorisé, puis reconnecter. | File IndexedDB conservée, droits rechargés, synchronisation autorisée seulement si le compte est toujours actif. | À faire |
| Contournement local | Modifier `localStorage.ppv3`, IndexedDB, l’URL ou appeler une fonction depuis la console puis reconnecter. | L’interface peut être contournée visuellement, jamais RLS : les données interdites sont refusées par Supabase. | À faire |

Ces scénarios doivent tous être marqués « validé » avant de fusionner ou publier la branche GitHub Pages.
