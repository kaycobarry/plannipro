# Rapport — Coffre-fort RH Enterprise

Date : 2 août 2026

## Résultat

La préparation locale du Coffre-fort RH Enterprise est terminée. Aucun commit, push ou déploiement n'a été effectué. La migration `supabase/hr-vault.sql` n'a donc pas encore été appliquée au projet Supabase.

## Architecture livrée

- catégories documentaires administrables, avec les 14 catégories demandées ;
- dossier documentaire créé automatiquement pour chaque salarié ;
- documents à suppression logique et restauration ;
- versions immuables, chemins Storage uniques, empreinte SHA-256 et absence d'upsert ;
- journal append-only pour dépôt, consultation, téléchargement, version, suppression et restauration ;
- alertes d'expiration, expiration prochaine et document obligatoire manquant ;
- recherche plein texte française avec index GIN et filtres catégorie, salarié, établissement et état ;
- interface dédiée avec glisser-déposer, aperçu PDF/image, téléchargement, versions, comparaison de métadonnées, historique et administration des catégories ;
- canal Realtime dédié, fermé lors d'une déconnexion ou d'un changement d'organisation ;
- exclusion complète des documents du cache métier local et du Service Worker Supabase.

## Tables et vue

- `document_categories`
- `employee_document_folders`
- `documents` étendue sans suppression de table
- `document_versions`
- `document_audit_logs`
- `hr_document_alerts`

Bucket privé : `plannipro-documents`, limite de 50 Mo, types MIME contrôlés.

## Sécurité

- permissions avancées ajoutées : `documents.upload`, `download`, `restore`, `manage_categories`, `audit`, `view_sensitive` ;
- décisions centralisées dans les fonctions d'autorisation utilisées par RPC, RLS et Storage ;
- salarié limité à ses documents visibles ;
- manager limité à son périmètre et aux documents marqués manager ;
- catégorie sensible interdite sans permission dédiée ;
- métadonnées non modifiables directement par le navigateur ;
- aucune politique Storage `UPDATE` ;
- suppression physique limitée à l'objet orphelin que l'utilisateur vient de déposer ;
- audit non accessible par le seul droit de lecture ;
- Realtime protégé par RLS ;
- aucune clé `service_role` utilisée ou demandée.

## Tests réalisés

Tous réussis :

- `tests/verify-rbac.mjs`
- `tests/verify-rbac-advanced.mjs`
- `tests/verify-time-clock.mjs`
- `tests/verify-blocking-fixes.mjs`
- `tests/verify-clean-first-run.mjs`
- `tests/verify-hr-vault.mjs`
- syntaxe de `plannipro-vault.js`, `plannipro-cloud.js`, `pointeuse.js` et `sw.js`
- chargement HTTP local de `index.html`, du lien de navigation et de la vue Coffre-fort ; aucune erreur console observée sur l'écran de connexion.

Le test dédié couvre statiquement RBAC, RLS, Storage, dépôt sans écrasement, versionnage, alertes, expiration, recherche, audit, cache et responsive mobile.

## Limites avant production

Les essais réels de dépôt, téléchargement, version, alerte, Realtime et refus RLS avec des comptes distincts exigent l'application de la migration. Ils n'ont volontairement pas été exécutés, puisque la mission interdit tout déploiement.

La comparaison présente côte à côte les métadonnées, empreintes et accès aux aperçus de chaque version ; elle ne calcule pas de différence textuelle entre PDF ou images.

## Verdict

Le code local est prêt pour une migration et une recette Supabase contrôlées. Le Coffre-fort RH ne peut pas encore être déclaré prêt pour la production tant que la migration et les tests RLS/Storage connectés n'ont pas été validés sur le projet cible.
