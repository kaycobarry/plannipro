# Rapport de durcissement — 7 août 2026

## Périmètre

Le chantier couvre la reproductibilité des tests, la chaîne de dépendances, le navigateur, la synchronisation multi-appareils, Supabase Auth/RLS/Edge Functions, le Service Worker, l'intégrité relationnelle et les procédures d'exploitation.

Aucun commit, push ou déploiement GitHub Pages n'a été réalisé. La version locale durcie n'est donc pas encore celle servie par `https://plannipro.eu/`.

## Corrections locales

- dépendance `@supabase/supabase-js` figée en `2.112.2` dans le navigateur et les Edge Functions, avec SRI dans les pages ;
- CSP et politique Referrer ajoutées à PlanniPro et à la Pointeuse ;
- cache Service Worker `v33`, navigation réseau d'abord et exclusion de Supabase ;
- pagination des lectures Supabase par lots de 500 ;
- file IndexedDB protégée contre une modification locale survenue pendant un envoi ;
- conflit de révision distante détecté avant toute écriture et sauvegardé localement ;
- création distante sans collision locale exclue des faux conflits ;
- CI GitHub en lecture seule et lanceur unique des tests statiques ;
- diagnostics, barrière de publication, procédures d'incident et référence sécurité documentés.

## Opérations Supabase réalisées

- migration `security_performance_hardening` : six politiques optimisées avec un init plan pour `auth.uid()` et index critiques ajoutés ;
- migration `fix_membership_update_recursion` : la politique d'actualisation d'un membre ne relit plus `roles` sous RLS, ce qui supprimait une récursion infinie ;
- longueur minimale du mot de passe portée à 10 caractères ;
- sources distantes alignées sur les sources locales :
  - `create-company` version 5 ;
  - `invite-user` version 9 ;
  - `revoke-user-sessions` version 9 ;
  - `publish-planning` version 5 ;
  - `send-clock-pin-invitation` version 3.

Les secrets sont restés exclusivement dans Supabase. Aucune clé `service_role` n'a été lue, copiée ou placée dans le projet.

## Résultats

- 16 suites statiques réussies ;
- syntaxe valide pour les cinq scripts JavaScript principaux ;
- `git diff --check` réussi ;
- 6 tables métier invisibles anonymement et écriture anonyme refusée ;
- 5 Edge Functions : CORS de `https://plannipro.eu` accepté, origine tierce non reflétée, appel sans session refusé ;
- 7 ressources du site public disponibles en HTTPS ;
- PlanniPro et Pointeuse chargés localement sans erreur ni avertissement navigateur ;
- rechargement hors ligne du shell PlanniPro et Pointeuse réussi sans erreur ;
- recette RLS transactionnelle réussie pour Manager, Salarié et Manager suspendu ;
- rollback vérifié : 0 compte, 0 établissement, 0 salarié et 0 enregistrement temporaire restant ;
- intégrité : 0 relation orpheline et 0 doublon de clé métier.

Quantités inchangées après les migrations :

- 1 organisation ;
- 1 établissement ;
- 7 salariés ;
- 1 membre d'organisation ;
- 10 enregistrements métier actifs ;
- 1 terminal de Pointeuse et 0 badge ;
- 0 document RH et 0 version ;
- 1 publication de planning.

## Avis et limites

Le Security Advisor contient 89 avis sans erreur critique, classés dans `SECURITY_BASELINE.md`. La protection contre les mots de passe compromis et les limites avancées de session nécessitent une offre Supabase compatible.

La publication de planning existante est en statut `send_failed` avec 0 destinataire et aucun identifiant fournisseur. Un envoi réel ne pourra être déclaré validé qu'avec un salarié de recette possédant une adresse autorisée, puis vérification du message reçu.

La recette RLS en rollback valide les décisions de la base, mais elle ne remplace pas la dernière recette interface avec trois sessions réellement connectées sur des appareils séparés. Cette recette, l'envoi d'e-mail réel et la publication explicite de la version locale restent les trois portes finales.
