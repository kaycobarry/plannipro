# Coffre-fort RH Enterprise

## État de livraison

Le module est préparé localement. La migration `supabase/hr-vault.sql` n'est pas déployée par cette mission. Elle doit être validée puis exécutée dans le projet Supabase avant toute recette connectée.

## Architecture

- `document_categories` contient les catégories administrables et leurs règles de visibilité, de sensibilité, d'obligation et d'alerte.
- `employee_document_folders` crée automatiquement un dossier par salarié.
- `documents` porte les métadonnées courantes, l'expiration et la suppression logique.
- `document_versions` conserve chaque objet Storage de façon immuable. Une version possède un chemin et une empreinte SHA-256 distincts.
- `document_audit_logs` trace les créations, dépôts, consultations, téléchargements, versions, suppressions logiques et restaurations.
- `hr_document_alerts` expose les documents expirés, proches de l'expiration et obligatoires manquants.
- Le bucket privé `plannipro-documents` conserve les fichiers. Le client n'utilise ni `localStorage` ni IndexedDB pour les documents.

Le chemin d'un objet suit cette structure :

```text
{organization_id}/{establishment_id}/{employee_id}/{document_id}/{version_id}/{file_name}
```

Chaque segment de périmètre est validé côté PostgreSQL. Aucun `UPDATE` Storage n'est autorisé : une nouvelle version utilise toujours un nouvel identifiant et un nouvel objet.

## Catégories initiales

Contrat de travail, Avenants, Pièce d'identité, Carte Vitale, RIB, Permis, Diplômes, Visite médicale, Autorisations diverses, Attestations, Sanctions, Entretiens annuels, Formations et Documents libres.

Les catégories système peuvent être configurées et désactivées, mais leur désactivation ne supprime aucun document.

## Sécurité

Le même contrôle central est réutilisé par les RPC, RLS et règles Storage : appartenance active à l'organisation, permission RBAC, périmètre d'établissement/salarié et visibilité du document.

- Un salarié ne lit et ne télécharge que ses documents marqués visibles.
- Un manager ne voit que les documents marqués manager et compris dans son périmètre.
- RH, Administrateur et Super Administrateur reçoivent les permissions sensibles du coffre-fort.
- Les écritures de métadonnées directes sont révoquées. Elles passent par des RPC `security definer` à paramètres contrôlés.
- Les versions et le journal sont append-only pour les utilisateurs authentifiés.
- Realtime reste soumis aux politiques RLS.
- Aucune clé `service_role` n'est utilisée par le navigateur ou la migration.

## Cycle de dépôt

1. Le navigateur vérifie taille et type MIME, génère les identifiants et calcule SHA-256.
2. Storage accepte l'objet uniquement si le chemin et le périmètre sont autorisés.
3. `create_hr_document_version` vérifie l'objet, le salarié, la catégorie et le droit de dépôt.
4. La version immuable et les métadonnées sont créées dans une transaction RPC.
5. En cas d'échec RPC, le navigateur tente uniquement de supprimer l'objet orphelin qu'il vient de créer.

Le cache métier générique ignore entièrement `documents`. Une suppression locale de salarié ne peut donc ni écraser ni réinjecter des documents du coffre-fort.

## Hors ligne

Par choix de sécurité, les documents ne sont pas disponibles hors ligne et les dépôts ne sont pas mis en file locale. Les autres fonctions local-first de PlanniPro restent inchangées. Le module affiche un refus explicite lorsque le réseau est absent.

Les anciennes données IndexedDB ne sont pas supprimées par la migration applicative. Elles ne sont simplement plus lues ou modifiées par le chemin documentaire actif.

## Vérification

Exécuter localement :

```text
node tests/verify-hr-vault.mjs
node tests/verify-rbac.mjs
node tests/verify-rbac-advanced.mjs
node tests/verify-time-clock.mjs
node tests/verify-blocking-fixes.mjs
node tests/verify-clean-first-run.mjs
node --check plannipro-vault.js
node --check plannipro-cloud.js
node --check pointeuse.js
node --check sw.js
```

Après autorisation de déploiement, la recette connectée doit couvrir au minimum : dépôt, nouvelle version, aperçu, téléchargement, corbeille/restauration, alertes, recherche, comptes distincts, isolation inter-établissements, accès salarié, refus API direct et flux Realtime.
