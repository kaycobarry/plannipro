# Référence de sécurité Supabase

Projet contrôlé : `pkviymixsxwtwrarqomi`.

## Contrôles validés

- les inscriptions publiques sont désactivées ;
- le mot de passe minimal contient 10 caractères ;
- toutes les tables métier exposées ont RLS activée ;
- les requêtes anonymes ne lisent aucune ligne métier et ne peuvent pas écrire ;
- les buckets `plannipro-documents` et `planning-publications` sont privés ;
- les cinq Edge Functions refusent une requête sans session et appliquent une liste CORS stricte ;
- leurs sources déployées correspondent aux sources locales ;
- aucune réponse Supabase n'est placée dans le cache du Service Worker.

## Security Advisor

Le relevé du 7 août 2026 contient 89 avis, sans erreur critique :

- 5 avis `RLS Enabled No Policy` : tables de secrets de Pointeuse et table privée des administrateurs de plateforme. L'absence de politique y constitue le refus total attendu ;
- 5 avis `Public Can Execute SECURITY DEFINER Function` : points d'entrée anonymes indispensables à l'activation et au badgeage d'une tablette. Chaque appel exige un code, secret, jeton à usage unique ou PIN et applique l'anti-bruteforce en base ;
- 78 avis `Signed-In Users Can Execute SECURITY DEFINER Function` : helpers RLS et RPC métier. Ils restent exécutables parce que leur corps impose l'organisation, le périmètre et les permissions. Les révoquer globalement casserait les politiques RLS ;
- 1 avis sur la détection des mots de passe compromis : fonction indisponible avec l'offre Supabase Free actuelle.

Ces avertissements ne doivent jamais être masqués sans revue. Toute nouvelle fonction `SECURITY DEFINER` doit fixer son `search_path`, valider l'identité et le périmètre dans son corps, puis recevoir uniquement les droits `EXECUTE` nécessaires.

Références :

- <https://supabase.com/docs/guides/database/postgres/row-level-security>
- <https://supabase.com/docs/guides/database/database-linter>
- <https://supabase.com/docs/guides/auth/password-security>

## Performance Advisor

La migration `security_performance_hardening` a supprimé les six avertissements `auth_rls_initplan` et ajouté les index des relations les plus sollicitées. Il reste :

- 34 relations peu utilisées sans index dédié ;
- 38 index déclarés inutilisés immédiatement après création ou sur des tables sans trafic.

Ces avis sont informatifs. Les index récemment créés doivent être observés sur une période représentative avant toute suppression.

## Limites à lever avant une forte montée en charge

- activer la protection contre les mots de passe compromis avec une offre compatible ;
- configurer durée maximale, inactivité et session unique si la politique de l'entreprise l'exige ;
- prévoir une restauration testée dans un projet séparé et une stratégie de sauvegarde adaptée ;
- exécuter la recette multi-rôles avec de vrais comptes temporaires puis les supprimer.
