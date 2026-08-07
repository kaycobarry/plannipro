# Exploitation et reprise PlanniPro

## Surveillance quotidienne

Contrôler dans Supabase les erreurs des services Auth, API, Edge Functions, Storage, Realtime et Postgres. Une hausse de réponses `401` peut indiquer des sessions expirées ; des `403` répétés peuvent signaler un défaut de périmètre ou une tentative interdite ; des `5xx` nécessitent une analyse immédiate.

Surveiller séparément les envois Resend : succès, rebonds, plaintes et domaine d'envoi. Une réponse HTTP positive de l'Edge Function n'est pas une preuve de remise dans la boîte du destinataire.

## Avant une migration

1. Créer un bundle Git complet hors du dépôt avec `git bundle create <fichier>.bundle --all`.
2. Relever les quantités des tables métier critiques.
3. Exécuter la migration dans une transaction terminée par `ROLLBACK`.
4. Relire le Security Advisor et le Performance Advisor.
5. Appliquer la migration transactionnelle.
6. Vérifier les quantités et rejouer les tests RLS.

La recette `supabase/rls-regression-rollback.sql` peut être exécutée après une modification RBAC. Elle crée des identités et lignes temporaires dans une transaction, teste Manager, Salarié et suspension, puis se termine obligatoirement par `ROLLBACK`.

Ne jamais utiliser une suppression récursive, `TRUNCATE`, une désactivation RLS ou une clé `service_role` dans le navigateur pour résoudre un incident.

## Incident de synchronisation

Lorsqu'une révision distante est plus récente que la base connue par l'appareil, PlanniPro bloque la poussée, conserve la file IndexedDB et crée une sauvegarde `conflict:*`. Ne pas vider le navigateur. Comparer les deux versions avant de rejouer ou d'abandonner la modification locale.

## Incident Service Worker

1. Vérifier la version `plannipro-shell-v*` dans `sw.js`.
2. Vérifier que les URL du tableau `APP_SHELL` correspondent exactement aux scripts de `index.html`.
3. Confirmer que les requêtes `*.supabase.co` sont exclues du cache.
4. Tester une actualisation en ligne puis une actualisation hors ligne.

## Retour arrière du code

Restaurer une version Git connue dans une branche dédiée, exécuter tous les tests, puis republier uniquement après validation. Ne jamais réécrire `main` avec `reset --hard`.

## Restauration des données

Utiliser les sauvegardes et fonctions de restauration proposées par l'offre Supabase. Tester périodiquement la restauration dans un environnement séparé. Une sauvegarde Git ne sauvegarde pas la base, les objets Storage ni les utilisateurs Auth.

## Limitations actuelles de l'offre gratuite

- la détection des mots de passe compromis n'est pas disponible ;
- les limites de durée et d'inactivité des sessions ne sont pas configurables ;
- la reprise point-in-time et les options avancées de sauvegarde dépendent de l'offre souscrite.

Ces limitations doivent être réévaluées avant l'ouverture à un grand nombre d'entreprises.
