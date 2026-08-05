# Recette distante — Publication hebdomadaire du planning

Date de la recette : 5 août 2026
Projet : PlanniPro
Décision : **REFUSÉ POUR LA PRODUCTION**

Le socle distant (base, RLS, bucket privé, Realtime et Edge Function) est déployé et les contrôles techniques réalisables sont conformes. La recette métier distante exigée n'est cependant pas complète : les secrets Resend ne sont pas configurés, aucun domaine d'envoi n'a pu être validé, aucun e-mail réel n'a été reçu et le projet ne contient qu'un seul compte Auth actif. Les essais réels multi-rôles, les PDF stockés et les URL signées ne peuvent donc pas être déclarés réussis.

## 1. Environnement ciblé

| Contrôle | Statut | Preuve |
|---|---|---|
| Projet Supabase identifié sans ambiguïté | RÉUSSI | Projet `plannipro`, région `eu-central-1`, PostgreSQL 17.6, état `ACTIVE_HEALTHY`. |
| Dossier local | RÉUSSI | `C:/Users/MKBarry2010/Documents/Codex/2026-08-02/reprends-le-projet-plannipro-ouvert-dans/work/PlanniPro-Publish`. |
| Dépôt Git | RÉUSSI AVEC RÉSERVE | Dépôt `https://github.com/kaycobarry/plannipro.git`, branche locale `main`, derrière `origin/main` de 2 commits et avec des changements antérieurs non validés. Aucun pull/reset n'a été effectué pour ne rien écraser. |
| Correspondance exacte avec la version Git distante | NON TESTÉ | Impossible de l'affirmer tant que les deux commits distants et l'arbre de travail existant ne sont pas rapprochés. |
| Point de restauration logique | RÉUSSI AVEC RÉSERVE | Inventaire avant migration, compteurs métier et essai transactionnel avec `ROLLBACK`. Il ne s'agit pas d'une sauvegarde physique complète. |

Compteurs de référence avant migration : 1 organisation, 1 établissement, 7 salariés, 18 enregistrements métier, 0 document et 2 136 entrées d'audit.

## 2. Project ref

`pkviymixsxwtwrarqomi`

Le `project_ref` correspond à la configuration locale `supabase/config.toml` et à l'URL utilisée par `supabase-config.js`.

## 3. Migrations appliquées

| Migration | Statut | Preuve |
|---|---|---|
| `planning_publications` | RÉUSSI | Version distante `20260805192437`. Exécution transactionnelle réussie. |
| `planning_publications_fk_indexes` | RÉUSSI | Version distante `20260805193123`. Ajout transactionnel de six index de clés étrangères. |
| Rejeu/idempotence | RÉUSSI | Rejeu intégral de `supabase/planning-publications.sql` dans une transaction terminée par `ROLLBACK`, sans erreur. |
| Absence d'altération métier | RÉUSSI | Après migration : 1 organisation, 1 établissement, 7 salariés, 18 enregistrements métier, 0 document et 2 136 audits, identiques à la référence. |

Objets créés :

- `planning_publications` ;
- `planning_publication_recipients` ;
- `planning_publication_events` ;
- colonnes `planning_notification_email` et `planning_email_enabled` sur `employee_self_service` ;
- fonctions RPC de prévisualisation, création, autorisation et contrôle Storage ;
- trigger d'immuabilité ;
- politiques RLS ;
- bucket Storage privé ;
- publication Realtime de `planning_publications`.

## 4. Fonctions déployées

| Fonction | Statut | Preuve |
|---|---|---|
| `publish-planning` | RÉUSSI | Fonction `ACTIVE`, version 1, identifiant `3d79c5c9-abae-4c18-8f77-90a2121ca18c`, SHA-256 de déploiement `5bbeec9a8693e20f35e773c899b1ec3886b5b6ca7f6e6a2cafc62646f8b10f98`. |
| Validation JWT | RÉUSSI | `verify_jwt=true`. Appel sans jeton : HTTP 401. Appel avec jeton invalide : HTTP 401. |
| Synchronisation source/déploiement | RÉUSSI | Les trois sources récupérées depuis Supabase sont identiques aux fichiers locaux après normalisation des fins de ligne ; seule une ligne vide terminale est ajoutée par le déploiement. |
| Compatibilité syntaxique | RÉUSSI | `index.ts`, `planning-pdf.ts` et `cors.ts` passent le contrôle Node avec suppression expérimentale des types. Le déploiement Deno est actif. |

Fichiers serveur déployés : `publish-planning/index.ts`, `_shared/cors.ts`, `_shared/planning-pdf.ts`.

## 5. Secrets configurés

Les noms ont été contrôlés dans le tableau de bord Supabase. Aucune valeur n'a été lue, copiée ou inscrite dans le rapport.

| Secret | État |
|---|---|
| `RESEND_API_KEY` | ABSENT |
| `PLANNING_EMAIL_FROM` | ABSENT |
| `PLANNING_EMAIL_REPLY_TO` | ABSENT |
| `SUPABASE_URL` | CONFIGURÉ par Supabase |
| `SUPABASE_ANON_KEY` | CONFIGURÉ par Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | CONFIGURÉ par Supabase, serveur uniquement |
| `APP_ORIGINS` | CONFIGURÉ |
| `APP_URL` | CONFIGURÉ |
| `APP_PUBLISHABLE_KEY` | CONFIGURÉ |

La recherche dans les fichiers navigateur n'a trouvé ni `SUPABASE_SERVICE_ROLE_KEY`, ni `RESEND_API_KEY`, ni clé `sb_secret_`. La clé serveur n'a été ni demandée ni exposée.

## 6. Tests RLS

| Scénario | Statut | Preuve |
|---|---|---|
| RLS activée sur les trois tables | RÉUSSI | `relrowsecurity=true` pour les trois tables. |
| Lecture anonyme | RÉUSSI | Aucun privilège `SELECT` pour `anon`; RPC du module non exécutables par `anon`. |
| Écriture directe authentifiée | RÉUSSI | `INSERT`, `UPDATE` et `DELETE` révoqués sur les trois tables. |
| Gérant réel simulé en SQL | RÉUSSI AVEC RÉSERVE | Avec l'UUID du membre actif et des claims locaux, `can_publish_planning=true` et la RPC de création fonctionne dans une transaction annulée. Ce n'est pas un parcours HTTP avec une session navigateur. |
| UUID authentifié inconnu | RÉUSSI | Aucune publication, aucun destinataire, aucun événement et aucun objet Storage visible ; aucune écriture directe possible. |
| Autre établissement / autre tenant avec comptes réels | BLOQUÉ | Aucun compte de recette distinct n'est disponible. |
| Manager sans permission / salarié réel | BLOQUÉ | Le projet contient 1 utilisateur Auth, 1 profil et 1 membre actif seulement. |

Les quatre avertissements Security Advisor propres au module signalent que quatre RPC `SECURITY DEFINER` sont appelables par `authenticated`. Ce choix est intentionnel : les droits sont révoqués à `public` et `anon`, les fonctions fixent leur `search_path`, utilisent `auth.uid()` et vérifient le périmètre/permission dans leur corps. Ces avertissements restent documentés comme points de surveillance ; aucune RPC métier n'a été ouverte anonymement.

## 7. Tests Storage

| Scénario | Statut | Preuve |
|---|---|---|
| Bucket privé | RÉUSSI | `planning-publications`, `public=false`. |
| Type et taille | RÉUSSI | `application/pdf` uniquement, limite 10 485 760 octets. |
| Politique de lecture | RÉUSSI | Politique `SELECT` réservée à `authenticated`, avec contrôle du chemin par fonction RLS. |
| Accès anonyme | RÉUSSI | Aucune politique publique et aucune lecture anonyme. |
| Isolation négative avec UUID inconnu | RÉUSSI | 0 objet visible. |
| Téléchargement autorisé d'un vrai PDF | BLOQUÉ | Aucun PDF distant n'a pu être généré sans publication réelle. |
| Autre salarié / établissement / tenant | BLOQUÉ | Comptes distincts et objets de recette absents. |
| URL signée, expiration et altération du chemin | BLOQUÉ | Aucun objet ni session destinataire réelle disponible. |

Après nettoyage : 0 objet dans le bucket.

## 8. Tests Realtime

| Scénario | Statut | Preuve |
|---|---|---|
| Table publiée | RÉUSSI | `planning_publications` appartient à `supabase_realtime`. |
| Fermeture du canal dans le code | RÉUSSI | Le module appelle `removeChannel` et `PlanniProCloud` appelle `PlanniProPublications.shutdown` à la déconnexion. |
| Mise à jour réelle entre deux sessions | BLOQUÉ | Une seule session/utilisateur disponible et aucune publication réelle. |
| Isolation inter-tenant Realtime | BLOQUÉ | Absence de deux comptes/tenants de recette. |
| Accumulation de canaux dans un navigateur | NON TESTÉ | Nécessite la recette interactive de l'interface non déployée. |

## 9. Tests Resend

| Scénario | Statut | Preuve |
|---|---|---|
| Présence de l'intégration serveur | RÉUSSI | Appel serveur `https://api.resend.com/emails` avec `Idempotency-Key`; aucun secret côté navigateur. |
| Domaine d'envoi validé | BLOQUÉ | `RESEND_API_KEY` et `PLANNING_EMAIL_FROM` absents. |
| Adresse From / Reply-To | BLOQUÉ | Secrets absents. |
| E-mail de test reçu | BLOQUÉ | Aucun envoi tenté, conformément à la consigne d'arrêter si le domaine n'est pas validé. |
| Pièce jointe reçue | BLOQUÉ | Aucun envoi réel. |

## 10. Tests PDF

| Scénario | Statut | Preuve |
|---|---|---|
| Générateur global et individuel | RÉUSSI (STATIQUE) | Fonctions présentes et contrôle automatisé réussi. |
| Format A4 paysage | RÉUSSI (STATIQUE) | `MediaBox [0 0 842 595]`. |
| Accents français | RÉUSSI (STATIQUE) | Encodage WinAnsi et conservation des caractères Latin-1 ajoutés. |
| Établissement, semaine, version, date | RÉUSSI (STATIQUE) | Champs imprimés par le générateur, y compris `publication_version` et `publication_date`. |
| Contrôle visuel complet | BLOQUÉ | Aucun PDF distant produit ; pagination, tableaux, shifts de nuit et confidentialité individuelle non validés visuellement. |

## 11. Tests d'idempotence

| Scénario | Statut | Preuve |
|---|---|---|
| Même clé, même publication | RÉUSSI | Deux appels transactionnels à `create_planning_publication` ont retourné le même UUID ; le second résultat indiquait `reused=true`. |
| Absence de résidu | RÉUSSI | Transaction annulée ; 0 publication, 0 destinataire, 0 événement. |
| Double e-mail réel | BLOQUÉ | Resend non configuré. |
| Deux appels Edge simultanés avec JWT valide | BLOQUÉ | Session de recette et Resend absents. |

## 12. Tests de republication

| Scénario | Statut | Preuve |
|---|---|---|
| Version publiée immuable | RÉUSSI | Tentative transactionnelle de modifier le snapshot refusée avec `A published planning snapshot is immutable`. |
| Création version 1 puis version 2 | BLOQUÉ | Publication réelle non réalisable. |
| Conservation et téléchargement des deux PDF | BLOQUÉ | Aucun PDF distant. |
| Objet d'e-mail « planning modifié » | RÉUSSI (STATIQUE) | Le code utilise un objet et un corps spécifiques pour les versions supérieures à 1. |
| Sélection du seul salarié modifié | NON TESTÉ | Nécessite le parcours UI et un jeu de recette. |

## 13. Tests de permissions

| Profil | Statut | Résultat |
|---|---|---|
| Gérant | RÉUSSI AVEC RÉSERVE | Autorisation SQL réelle du membre existant confirmée ; UI/Edge avec son JWT non rejoués. |
| Responsable sans `planning.publish` | BLOQUÉ | Aucun compte ou membre de recette distinct. |
| Salarié | BLOQUÉ | Aucun compte salarié Auth distinct. |
| Autre établissement | BLOQUÉ | Aucun compte de recette affecté à un autre établissement. |
| Autre tenant | BLOQUÉ | Aucun second tenant de recette autorisé. |
| JWT absent/invalide | RÉUSSI | HTTP 401 dans les deux cas. |

Aucun compte ou invitation n'a été créé, faute d'adresses de recette explicitement fournies.

## 14. Tests de non-régression

Toutes les suites locales existantes ont réussi :

| Suite | Statut | Résultat |
|---|---|---|
| `verify-time-clock.mjs` | RÉUSSI | OK |
| `verify-time-clock-secure-scenarios.mjs` | RÉUSSI | 30/30 (couverture statique) |
| `verify-rbac.mjs` | RÉUSSI | OK |
| `verify-rbac-advanced.mjs` | RÉUSSI | OK |
| `verify-planning-publications.mjs` | RÉUSSI | 25/25 |
| `verify-hr-vault.mjs` | RÉUSSI | OK |
| `verify-company-administration.mjs` | RÉUSSI | OK |
| `verify-clean-first-run.mjs` | RÉUSSI | OK |
| `verify-blocking-fixes.mjs` | RÉUSSI | OK |

Contrôles complémentaires :

- 6 fichiers JavaScript : syntaxe valide ;
- 7 fichiers TypeScript Edge : syntaxe valide ;
- `git diff --check` : réussi, avec avertissements CRLF/LF uniquement ;
- recherche de secrets serveur dans les fichiers navigateur : aucune occurrence ;
- Service Worker : cache `plannipro-shell-v25` présent dans les contrôles statiques.

Les parcours interactifs planning, mobile, cache d'une ancienne version et coupure réseau n'ont pas été rejoués dans cette recette distante.

## 15. Anomalies détectées

1. **BLOQUANT — Resend non configuré** : trois secrets requis absents ; domaine, envoi et réception impossibles à valider.
2. **BLOQUANT — Jeu de comptes insuffisant** : 1 utilisateur Auth seulement ; tests réels manager, salarié, autre établissement et autre tenant impossibles.
3. **MAJEUR POUR LA RECETTE — Aucun PDF distant** : Storage autorisé, URL signée, expiration et confidentialité non validés avec un vrai objet.
4. **MAJEUR POUR LA RECETTE — Aucun parcours UI distant complet** : publication, statut, historique, Realtime et cache non validés dans deux sessions.
5. **RÉSERVE GIT** : branche locale `main` derrière `origin/main` de 2 commits, arbre de travail déjà fortement modifié et aucun `.gitignore` trouvé à la racine.
6. **INFO SÉCURITÉ** : 4 avertissements Security Advisor propres au module sur des RPC `SECURITY DEFINER` authentifiées ; justifiés par le modèle RPC/RLS et protégés en interne.
7. **INFO PERFORMANCE** : les index neufs sont signalés « unused » parce que les tables sont vides. Ce n'est pas une erreur.

## 16. Corrections réalisées

- ajout de six index de couverture de clés étrangères dans la migration locale et distante ;
- conservation des accents français dans les PDF avec encodage WinAnsi ;
- ajout de la version et de la date de publication dans les PDF ;
- prise en charge explicite de `PLANNING_EMAIL_FROM` et `PLANNING_EMAIL_REPLY_TO` ;
- ajout de `reply_to` aux appels Resend ;
- objet et texte d'e-mail adaptés aux republications ;
- `verify_jwt=true` déclaré pour `publish-planning` ;
- tests statiques étendus pour les secrets d'e-mail, WinAnsi, version et date.

Fichiers modifiés ou créés pendant cette phase :

- `supabase/planning-publications.sql` ;
- `supabase/config.toml` ;
- `supabase/functions/_shared/planning-pdf.ts` ;
- `supabase/functions/publish-planning/index.ts` ;
- `docs/PLANNING_PUBLICATION.md` ;
- `tests/verify-planning-publications.mjs` ;
- `PHASE-PLANNING-PUBLICATION-REMOTE-REPORT.md`.

## 17. Éléments non testés

- domaine Resend, From et Reply-To réels ;
- réception d'un e-mail et de sa pièce jointe ;
- PDF global/individuel stocké et examiné visuellement ;
- URL signée autorisée, expirée et altérée ;
- deux appels Edge simultanés avec un JWT valide ;
- version 1/version 2 et renvoi des seuls échecs ;
- rôles réels manager et salarié ;
- isolation réelle autre établissement et autre tenant ;
- Realtime dans deux navigateurs et fermeture répétée des canaux ;
- mise à jour Service Worker depuis un ancien cache, ordinateur et smartphone ;
- parcours complet de l'interface de publication.

## 18. Décision finale de mise en production

**REFUSÉ POUR LA PRODUCTION**

Motif : les conditions obligatoires « e-mail Resend effectivement reçu », « PDF vérifié », « Storage privé réellement testé avec des utilisateurs distincts » et « isolation inter-tenant validée » ne sont pas remplies. Le backend distant est déployé proprement et sans altération métier, mais il ne suffit pas à autoriser la production.

Pour lever le refus, il faut d'abord configurer les trois secrets Resend avec un domaine vérifié et fournir des comptes/adresses de recette contrôlés pour un gérant, un responsable sans permission et un salarié. La recette pourra alors créer des données minimales identifiables, effectuer les envois/PDF/URL signées/Realtime, puis tout supprimer.

## 19. Commandes et contrôles exécutés

Principales commandes locales :

```text
git status --short --branch
git remote -v
git branch --show-current
git diff --check
node tests/verify-time-clock.mjs
node tests/verify-time-clock-secure-scenarios.mjs
node tests/verify-rbac.mjs
node tests/verify-rbac-advanced.mjs
node tests/verify-planning-publications.mjs
node tests/verify-hr-vault.mjs
node tests/verify-company-administration.mjs
node tests/verify-clean-first-run.mjs
node tests/verify-blocking-fixes.mjs
node --check <fichiers JavaScript>
node --experimental-strip-types --check <fichiers TypeScript Edge>
```

Contrôles distants : inventaire projet/migrations/tables/fonctions, application des deux migrations, déploiement Edge, appels HTTP 401, requêtes SQL transactionnelles RLS/idempotence/immuabilité, vérification des politiques/bucket/Realtime, Security Advisor, Performance Advisor et journaux des services.

## 20. Identifiant du commit éventuel

**Aucun commit créé. Aucun push effectué. Aucune publication de l'application ou de GitHub Pages effectuée.**

La branche `main` n'a pas été modifiée par une opération Git ; seuls les fichiers de l'arbre de travail déjà ouvert ont été adaptés localement.
