# Mise en service Supabase sécurisée

PlanniPro est construit en local-first : le navigateur enregistre le cache et les opérations en attente dans IndexedDB, puis Supabase ne reçoit que les données autorisées par les règles RLS. Les mots de passe, la clé `service_role` et les tokens ne sont jamais placés dans l’application web.

Pour une procédure pas à pas à réaliser sans modifier de code, consulter [`ETAPES_COPIER_COLLER.md`](./ETAPES_COPIER_COLLER.md).

## 1. Exécuter le schéma

Dans le projet Supabase, ouvrir **SQL Editor**, créer une nouvelle requête, copier intégralement [`supabase/schema.sql`](../supabase/schema.sql), puis cliquer sur **Run**. Le script crée les tables, rôles, permissions, déclencheurs, RLS, journal d’audit, bucket privé de documents et publication Realtime.

Après `schema.sql`, appliquer dans l’ordre les migrations complémentaires utilisées par l’installation : `time-clock.sql`, `rbac-advanced.sql`, `time-clock-secure-activation.sql`, `hr-vault.sql`, puis `company-administration.sql`. La migration de pointeuse remplace l’enregistrement direct par des codes d’activation temporaires et supprime la distribution de vérificateurs de PIN aux tablettes. `company-administration.sql` remplace l’inscription libre par la création d’entreprise autorisée côté serveur et l’activation des collaborateurs sur invitation.

Ne pas continuer au déploiement GitHub Pages tant que cette requête n’a pas terminé sans erreur.

Le script est prévu pour un projet neuf. Une erreur doit être conservée et corrigée avant de relancer ; ne pas supprimer de table ni désactiver RLS pour la contourner.

## 2. Configurer Auth

Dans **Authentication → Providers → Email** :

- laisser Email activé ;
- activer la confirmation d’e-mail en production ;
- activer la récupération de mot de passe ;
- dans **URL Configuration**, renseigner l’URL finale GitHub Pages comme `Site URL` et dans `Redirect URLs` ;
- ajouter aussi `http://localhost:4173` seulement pour les tests locaux si nécessaire.

La page publique ne propose aucune inscription libre. **Créer une entreprise** passe par la fonction serveur dédiée ; rejoindre une entreprise existante exige une invitation valide.

## 3. Déployer les Edge Functions

Installer la CLI Supabase, puis depuis la racine du dépôt :

```bash
npx --yes supabase@latest secrets set --project-ref pkviymixsxwtwrarqomi APP_ORIGINS=https://kaycobarry.github.io APP_URL=https://VOTRE-DOMAINE-GITHUB-PAGES/CHEMIN-APP
npx --yes supabase@latest functions deploy create-company --project-ref pkviymixsxwtwrarqomi --no-verify-jwt
npx --yes supabase@latest functions deploy invite-user --project-ref pkviymixsxwtwrarqomi --no-verify-jwt
npx --yes supabase@latest functions deploy revoke-user-sessions --project-ref pkviymixsxwtwrarqomi --no-verify-jwt
```

`APP_ORIGINS` ne contient jamais de chemin. Il accepte une liste stricte séparée par des virgules, par exemple `https://kaycobarry.github.io,http://localhost:4173` pendant les essais. `APP_URL` contient le chemin réel de l’application, par exemple `https://kaycobarry.github.io/plannipro`.

Supabase fournit déjà aux Edge Functions `SUPABASE_URL`, la clé publique et `SUPABASE_SERVICE_ROLE_KEY`. Cette dernière reste exclusivement dans l’environnement Edge Function : ne jamais la mettre dans `supabase-config.js`, GitHub, l’HTML ou le navigateur. La fonction `invite-user` gère aussi le renvoi d’une invitation, sans réutiliser de jeton.

Variables à vérifier :

- Côté navigateur : `supabase-config.js` contient seulement `url` et `publishableKey` ; elles sont publiques.
- Côté Edge Functions : `APP_ORIGINS` et `APP_URL` sont à définir avec les vraies URL prévues.
- Côté Supabase : `SUPABASE_URL`, clé publique et `SUPABASE_SERVICE_ROLE_KEY` sont fournis au runtime Edge ; ne les recopiez nulle part.

## 4. Créer le premier gérant et importer l’existant

1. Ouvrir l’application locale avec la nouvelle version.
2. Cliquer sur **Créer une entreprise** et renseigner l’entreprise, le premier établissement et l’administrateur.
3. Confirmer l’e-mail si cette protection Auth est activée.
4. Se connecter : l’organisation, l’établissement et le rôle Super Administrateur sont créés automatiquement.

Le compte devient `owner` (Gérant / Super administrateur), une sauvegarde de l’état local est placée dans IndexedDB, puis les salariés, planning, absences, pointages, registre, ERP et paramètres sont importés. Les identifiants locaux sont utilisés comme clés de migration afin que le même import ne crée pas de doublons.

Après une synchronisation réussie, la copie métier `ppv3` est archivée dans IndexedDB puis retirée de localStorage ; le cache hors ligne reste dans IndexedDB. Si une organisation existante ne contient encore aucune donnée cloud, l’application propose aussi l’import contrôlé du navigateur déjà utilisé.

## 5. Créer des comptes et vérifier les accès

Depuis **Administration → Utilisateurs**, le gérant peut inviter, renvoyer ou annuler une invitation, attribuer un rôle, définir un établissement et des services, ajouter des permissions complémentaires, suspendre un compte et consulter les invitations. L’invité choisit seulement son mot de passe ; l’organisation est imposée par le jeton. Les droits sont appliqués à la fois dans l’interface et par RLS dans PostgreSQL.

Exécuter ensuite chaque scénario de [`tests/rls-checklist.md`](../tests/rls-checklist.md). Les tests d’intégration ne peuvent être validés qu’après l’exécution du SQL dans le projet Supabase.
