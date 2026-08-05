# Recette réelle — Pointeuse sécurisée

Les tests Node contrôlent les chemins de code. Cette liste doit être exécutée après application de `supabase/time-clock-secure-activation.sql` sur une base de recette.

| # | Scénario | Résultat attendu |
|---:|---|---|
| 1 | Première ouverture sans stockage local | Écran « Activer cette pointeuse », aucune ligne créée. |
| 2 | Connexion manager puis annulation | Aucune pointeuse créée. |
| 3 | Activation avec code valide | Un appareil actif, code consommé, token hashé. |
| 4 | Code expiré | Refus générique, aucun appareil. |
| 5 | Code réutilisé | Refus, aucun doublon. |
| 6 | Actualisation | Même identifiant de terminal. |
| 7 | Fermeture/réouverture | Même terminal reconnu. |
| 8 | Suppression du stockage du site | Retour activation, aucune création automatique. |
| 9 | Suspension | Cache et badge refusés. |
| 10 | Révocation | Badge immédiatement refusé, motif audité. |
| 11 | Terminal sans badge | Suppression physique autorisée. |
| 12 | Terminal avec badges | Archivage, événements conservés. |
| 13 | Génération PIN | Six chiffres aléatoires, visibles une fois. |
| 14 | Lecture directe des identifiants | Aucun PIN/hash accessible. |
| 15 | PIN correct | Identité minimale et actions autorisées. |
| 16 | PIN incorrect | Message non énumérant. |
| 17 | Cinq échecs | Blocage temporaire. |
| 18 | Fin du blocage | Nouvelle tentative autorisée. |
| 19 | Réinitialisation | Ancien PIN refusé, nouveau accepté. |
| 20 | Invitation expirée | Refus. |
| 21 | Invitation consommée deux fois | Second usage refusé. |
| 22 | Salarié désactivé | PIN refusé. |
| 23 | Salarié d’un autre établissement | PIN refusé. |
| 24 | Manager sans permission | Activation/gestion refusée. |
| 25 | Autre tenant | Aucune lecture, gestion ou activation. |
| 26 | Entrée | Événement unique et résumé Pointage. |
| 27 | Sortie | Événement unique et résumé Pointage. |
| 28 | Rejeu du même `client_event_id` | `duplicate: true`, aucun doublon. |
| 29 | Correction manager | Valeur d’origine et motif conservés par le module Pointage. |
| 30 | Ordinateur, tablette et mobile | Aucun débordement, pavé tactile lisible. |

Le test hors ligne attendu est désormais un refus explicite de nouveau badge. Aucun vérificateur de PIN et aucune file de nouveaux pointages ne doivent être présents dans IndexedDB.
