# Pointeuse tablette PlanniPro

La pointeuse est une page distincte, `pointeuse.html`. Une connexion normale à PlanniPro ne crée jamais de terminal.

## Installation Supabase

Appliquer dans cet ordre :

1. `supabase/schema.sql`
2. `supabase/time-clock.sql`
3. `supabase/rbac-advanced.sql`
4. `supabase/time-clock-secure-activation.sql`

La dernière migration est transactionnelle et idempotente. Elle ne supprime aucun pointage. Elle révoque les anciennes RPC permettant l’enregistrement direct et la définition manuelle d’un PIN avec vérificateur hors ligne.

Pour l’envoi facultatif des liens de création de PIN, déployer `send-clock-pin-invitation` avec :

- `APP_URL` : URL HTTPS de PlanniPro ;
- `APP_ORIGINS` : origines autorisées séparées par des virgules ;
- `RESEND_API_KEY` : secret du fournisseur d’e-mail, uniquement dans les secrets Edge Functions ;
- `RESEND_FROM` : expéditeur vérifié.

Aucune clé `service_role` n’est placée dans le navigateur ou les fichiers publics.

## Activer une tablette

1. Dans PlanniPro, ouvrir **Paramètres → Pointeuses**.
2. Cliquer sur **Gérer les pointeuses** et se connecter avec un compte autorisé.
3. Choisir l’établissement et cliquer sur **Ajouter une pointeuse**.
4. Noter le code à huit caractères. Il expire après dix minutes et ne fonctionne qu’une fois.
5. Sur la tablette non configurée, ouvrir `pointeuse.html`, saisir le code, le nom et l’emplacement.

Le terminal génère son propre jeton aléatoire. Seule son empreinte SHA-256 est enregistrée dans Supabase ; le jeton reste chiffré dans IndexedDB sous la clé `plannipro_clock_device_token`.

## Codes salariés

Depuis la fiche de gestion d’un terminal :

- **Générer** produit côté serveur un PIN cryptographiquement aléatoire visible une seule fois ;
- **Créer un lien** produit un lien valable 24 heures et utilisable une seule fois ;
- **Envoyer par e-mail** utilise l’Edge Function si le fournisseur est configuré.

Les PIN sont stockés avec bcrypt, jamais en clair. Le terminal ne télécharge ni liste globale de salariés, ni PIN, ni hash, ni vérificateur dérivé.

## Hors connexion

Le shell de la page peut se charger hors ligne, mais tout nouveau pointage est refusé avec le message **Connexion indisponible — pointage momentanément impossible**. Cette décision remplace l’ancien cache de vérificateurs de PIN, qui ne répondait pas au niveau de sécurité requis.

## Révocation et conservation

- une pointeuse sans pointage peut être supprimée définitivement ;
- une pointeuse ayant servi est révoquée et archivée ;
- ses événements restent liés au terminal et consultables pour l’audit ;
- une révocation bloque immédiatement le cache et les nouveaux badges côté serveur.

## Vérifications locales

```text
node tests/verify-time-clock.mjs
node tests/verify-time-clock-secure-scenarios.mjs
node tests/verify-rbac-advanced.mjs
node --check pointeuse.js
node --check plannipro-cloud.js
node --check sw.js
```

Les tests statiques ne remplacent pas l’application de la migration et une recette avec de vrais comptes sur le projet Supabase.
