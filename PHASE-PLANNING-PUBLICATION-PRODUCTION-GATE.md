# Passage en production — Publication hebdomadaire du planning

Date du contrôle : 5 août 2026
Projet Supabase : `pkviymixsxwtwrarqomi`

## Domaine Resend

**BLOQUÉ**

Le domaine d'envoi ne peut pas être vérifié sans configuration Resend. Aucun domaine fictif ou adresse trompeuse n'a été utilisé.

## Secrets configurés

Les noms ont été vérifiés dans le tableau de bord Supabase. Aucune valeur n'a été affichée ou copiée.

| Secret | État |
|---|---|
| `RESEND_API_KEY` | ABSENT |
| `PLANNING_EMAIL_FROM` | ABSENT |
| `PLANNING_EMAIL_REPLY_TO` | ABSENT |
| Secrets Supabase serveur | CONFIGURÉS PAR LA PLATEFORME |

## Comptes utilisés

**BLOQUÉ**

État actuel : 1 utilisateur Auth, 1 profil et 1 membre actif. Aucun compte temporaire n'a été créé sans adresse explicitement autorisée.

Comptes encore nécessaires :

- gérant autorisé avec `planning.publish` ;
- salarié du même établissement ;
- utilisateur d'un autre établissement ou tenant.

## Réception réelle de l'e-mail

**NON TESTÉ — BLOQUÉ PAR RESEND**

Aucun envoi n'a été tenté. Une réponse HTTP sans réception effective ne sera pas considérée comme une réussite.

## Contrôle des PDF

**NON TESTÉ — BLOQUÉ**

Aucune publication réelle ni aucun PDF distant n'a été créé. Le générateur et ses tests statiques restent validés, mais le contrôle visuel global/individuel doit encore être effectué.

## Contrôle des URL signées

**NON TESTÉ — BLOQUÉ**

Aucun objet de recette n'existe dans le bucket. Les essais autorisé, anonyme, autre salarié, autre établissement, autre tenant, expiration et chemin modifié restent à réaliser.

## Isolation par compte

**NON TESTÉ — BLOQUÉ**

Des JWT Auth distincts sont nécessaires. Les simulations SQL précédentes ne remplacent pas ce contrôle réel.

## Isolation par établissement

**NON TESTÉ — BLOQUÉ**

Aucun compte de recette dans un second établissement n'est disponible.

## Isolation par tenant

**NON TESTÉ — BLOQUÉ**

Aucun compte de recette dans un second tenant n'est disponible.

## Republication

**NON TESTÉ — BLOQUÉ**

La création réelle des versions 1 et 2, la conservation du premier PDF et la réception du message de modification restent à tester.

## Idempotence

**RÉUSSI AU NIVEAU SQL, NON TESTÉ DE BOUT EN BOUT**

La même clé transactionnelle retourne la même publication sans doublon. Le double clic, les requêtes Edge rapprochées et l'unicité effective de l'e-mail/PDF doivent encore être prouvés avec une vraie session.

## Échec partiel

**NON TESTÉ — BLOQUÉ**

Le statut `partially_sent`, la conservation des succès et le renvoi du seul échec nécessitent Resend et des destinataires contrôlés.

## Nettoyage

**RÉUSSI**

État vérifié après le contrôle :

- 0 publication ;
- 0 destinataire ;
- 0 événement de publication ;
- 0 objet dans le bucket `planning-publications`.

Les compteurs métier restent identiques à la recette précédente : 1 organisation, 1 établissement, 7 salariés, 18 enregistrements métier, 0 document et 2 136 audits. Aucune donnée métier n'a été modifiée.

## Anomalies restantes

1. Les trois secrets Resend obligatoires sont absents.
2. Aucun domaine et aucune adresse `From` ne peuvent être validés.
3. Il manque au moins deux comptes Auth distincts de recette.
4. Aucun e-mail réel, PDF distant ou accès Storage signé n'a été testé.
5. L'isolation réelle entre JWT, établissements et tenants reste à prouver.

## Actions nécessaires pour reprendre

1. Ajouter directement dans les secrets Edge Functions Supabase, sans les transmettre dans la conversation :
   - `RESEND_API_KEY` ;
   - `PLANNING_EMAIL_FROM` ;
   - `PLANNING_EMAIL_REPLY_TO`.
2. Vérifier le domaine dans Resend et s'assurer que `PLANNING_EMAIL_FROM` lui appartient.
3. Communiquer uniquement les adresses de recette contrôlées autorisées pour les comptes gérant, salarié et isolé, ou créer ces comptes dans le Dashboard et confirmer qu'ils sont prêts.

## Déploiement

Aucun commit, push, déploiement GitHub Pages ou publication publique n'a été effectué pendant ce contrôle.

## Verdict final

**REFUSÉ POUR LA PRODUCTION**

Le verdict ne pourra être réévalué qu'après configuration Resend et exécution de la recette réelle avec plusieurs comptes JWT distincts.
