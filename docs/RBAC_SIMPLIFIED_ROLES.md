# Profils et autorisations simplifiés

## Décision d'architecture

PlanniPro présente désormais quatre profils métier : Administrateur, Manager,
Superviseur et Employé. Les rôles `owner` et `time_clock` restent internes. Les
anciens rôles sont conservés en base pour l'historique et la compatibilité, mais
ils ne sont plus attribuables depuis l'interface courante.

Une autorisation est calculée pour le triplet utilisateur, établissement et
permission. La table `member_establishment_roles` porte le profil par
établissement. La table `member_establishment_permissions` ne contient que les
exceptions autorisées. Les opérations métier continuent d'être protégées côté
serveur par les fonctions de contrôle et les politiques RLS.

## Profils standards

| Profil | Usage | Limites par défaut |
| --- | --- | --- |
| Administrateur | Administration complète de l'établissement | Aucune élévation au-dessus de son propre niveau |
| Manager | Planning, équipe, temps, congés, rapports | Pas de sécurité globale ni de données RH/financières sensibles |
| Superviseur | Organisation quotidienne de l'équipe | Pas de suppression ni publication par défaut |
| Employé | Ses propres planning, pointages, congés et documents | Aucun accès aux données des collègues |

Les exceptions proposées sont volontairement limitées à la publication du
planning, la correction des pointages, la validation ou le refus des congés, la
lecture RH confidentielle et la lecture financière.

## Migration des rôles historiques

Le mapping est déterministe :

- `owner` reste technique et s'affiche Administrateur ;
- `administrator` devient Administrateur ;
- `hr_manager` et `store_manager` deviennent Manager ;
- `manager` reste Manager ;
- `readonly` devient Employé ;
- `employee` reste Employé ;
- un rôle personnalisé est classé par son rang vers Manager, Superviseur ou
  Employé ;
- `time_clock` reste technique.

Lorsqu'un ancien rôle est remappé, les différences entre sa matrice effective et
le profil cible sont copiées comme exceptions par établissement. La migration ne
supprime aucune donnée métier et peut être rejouée.

## Sécurité

- Un rôle ne peut être attribué qu'à une affectation de la même organisation.
- Un Administrateur ne peut attribuer qu'un profil de niveau égal ou inférieur.
- Le dernier Administrateur actif d'un établissement ne peut être rétrogradé,
  désactivé ou supprimé.
- Les changements passent par des RPC `SECURITY DEFINER` dont l'exécution est
  révoquée à `anon` et accordée uniquement aux utilisateurs authentifiés.
- Les tables d'affectations et d'exceptions utilisent RLS et Realtime.
- La modification du JavaScript, de `localStorage` ou d'un appel PostgREST ne
  contourne pas les contrôles PostgreSQL.

## Déploiement

Le fichier `supabase/rbac-simplified-roles.sql` doit être validé sur une base de
recette avec deux établissements et quatre comptes distincts avant toute
exécution en production. Cette livraison locale n'applique pas la migration au
projet Supabase et ne publie aucun fichier.
