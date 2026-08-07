# Barrière de mise en production

Une version ne peut être publiée que si tous les points suivants sont documentés.

## Code

- [ ] `npm run test:static` réussit.
- [ ] `git diff --check` réussit.
- [ ] aucune clé secrète ou `service_role` n'est présente dans le diff.
- [ ] la version du cache Service Worker a été incrémentée lorsque le shell change.
- [ ] les imports distants utilisent une version exacte et, dans le navigateur, une intégrité SRI.

## Supabase

- [ ] chaque migration a été testée avec rollback puis appliquée une seule fois.
- [ ] le Security Advisor ne contient aucune erreur critique nouvelle.
- [ ] les nouvelles tables ont des `GRANT` explicites et RLS.
- [ ] les fonctions `SECURITY DEFINER` ont une justification, un `search_path` fixé et des droits `EXECUTE` minimaux.
- [ ] les Edge Functions actives correspondent aux sources du dépôt.
- [ ] les origines CORS incluent `https://plannipro.eu` et refusent les origines tierces.

## Recette

- [ ] `npm run test:remote:anon` réussit.
- [ ] `npm run test:remote:rbac` réussit avec des comptes temporaires manager et salarié.
- [ ] gérant, manager, salarié et compte suspendu sont testés dans des sessions distinctes.
- [ ] la lecture, l'écriture, la suppression et Realtime sont refusés hors périmètre.
- [ ] une modification hors ligne se resynchronise une seule fois.
- [ ] un conflit entre deux appareils est bloqué et sauvegardé localement.
- [ ] connexion, déconnexion et actualisation après déconnexion sont validées.
- [ ] PlanniPro et la Pointeuse sont testés sur ordinateur et téléphone.

## Exploitation

- [ ] les erreurs Auth, API, Edge Functions, Storage, Realtime et Postgres des dernières 24 heures ont été examinées.
- [ ] l'envoi d'e-mail réel, les rebonds et l'adresse de réponse ont été contrôlés.
- [ ] une sauvegarde Git et une procédure de retour arrière sont disponibles.
- [ ] toutes les données de recette ont été supprimées et les quantités métier vérifiées.

La publication reste une action distincte de la validation. Elle doit être explicitement décidée après le rapport de recette.
