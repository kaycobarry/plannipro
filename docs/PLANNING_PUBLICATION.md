# Publication hebdomadaire des plannings

## Architecture

- `supabase/planning-publications.sql` crée les instantanés immuables, les destinataires, les événements, les index, les politiques RLS et le bucket privé `planning-publications`.
- `supabase/functions/publish-planning/index.ts` génère les PDF, les stocke et envoie les PDF individuels via Resend.
- `plannipro-publications.js` gère la confirmation, le statut, l'historique, la republication ciblée et Realtime.
- `index.html` fournit le calcul partagé des durées et volumes contractuels de la semaine.

Les PDF ne sont jamais publics. Le navigateur ne contient aucun secret et ne peut pas écrire directement dans les tables de publication ni dans le bucket.

## Déploiement contrôlé

1. Exécuter `supabase/planning-publications.sql` dans le projet Supabase visé.
2. Configurer les secrets de l'Edge Function : `RESEND_API_KEY`, `PLANNING_EMAIL_FROM`, `PLANNING_EMAIL_REPLY_TO`, `APP_ORIGINS`. Les variables Supabase internes restent gérées par la plateforme.
3. Déployer la fonction `publish-planning` avec vérification JWT active.
4. Exécuter `node tests/verify-planning-publications.mjs` et les autres scripts `tests/verify-*.mjs`.
5. Tester avec des comptes distincts et des adresses de recette autorisées avant toute utilisation réelle.

Une réponse Resend sans statut HTTP réussi et sans identifiant fournisseur ne produit jamais le statut `sent`. Les échecs restent visibles et peuvent être retentés avec la même clé d'idempotence.

## Données et confidentialité

- Le PDF global est réservé aux utilisateurs possédant `planning.publish` dans le périmètre concerné.
- Le PDF individuel est lisible par le salarié concerné ou un publieur autorisé dans le même périmètre.
- Les e-mails manquants, invalides ou désactivés sont tracés comme tels.
- Les versions précédentes ne sont ni écrasées ni supprimées lors d'une republication.
- Aucun PDF et aucun secret de messagerie n'est placé dans `localStorage` ou IndexedDB.
