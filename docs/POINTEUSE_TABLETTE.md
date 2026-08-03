# Pointeuse tablette PlanniPro

Cette extension ajoute une page distincte : `pointeuse.html`.

Elle est conçue pour une tablette installée dans le magasin : le salarié choisit son nom, saisit un code personnel de six chiffres, puis enregistre son entrée, sa pause, sa reprise ou sa sortie. La tablette n'affiche ni le planning complet, ni les dossiers RH, ni les rémunérations.

## Avant de l'activer

La base sécurité de PlanniPro doit déjà être en place et testée : `supabase/schema.sql`, le premier gérant, l'organisation et l'établissement. Ne publiez pas cette extension tant que les scénarios RBAC/RLS déjà prévus ne sont pas validés.

## 1. Ajouter les tables et règles de la pointeuse

Dans Supabase, ouvrir **SQL Editor**, créer une nouvelle requête, ouvrir `supabase/time-clock.sql`, puis copier tout son contenu et cliquer sur **Run**.

Ce fichier est une migration complémentaire : il ne faut pas réexécuter ou supprimer `schema.sql`.

Il crée notamment :

- les tablettes enregistrées ;
- les codes personnels protégés ;
- les événements de badge immuables ;
- les règles RLS ;
- la file de synchronisation contrôlée par la base ;
- les événements du journal d'activité.

## 2. Donner le droit de configuration si nécessaire

Le gérant possède déjà le droit complet. Un manager doit recevoir explicitement la permission suivante dans **Utilisateurs et droits d'accès** :

```text
Pointage · Gérer les paramètres
```

Ce droit permet uniquement de configurer des pointeuses dans son établissement ou son périmètre ; il ne donne pas accès aux paramètres de sécurité globaux.

## 3. Installer la tablette

Depuis un ordinateur ou la tablette, lancer PlanniPro localement :

```powershell
npx --yes serve@14 -l 4173
```

Puis ouvrir :

```text
http://localhost:4173/pointeuse.html
```

Sur la tablette :

1. Cliquer sur **Configurer la tablette**.
2. Se connecter temporairement avec le compte gérant ou manager habilité.
3. Choisir l'entreprise, l'établissement et le nom de l'appareil.
4. Créer un code personnel différent pour chaque collaborateur.
5. Cliquer sur **Terminer** : la session manager est supprimée de la tablette.

Après publication validée, l'adresse sera :

```text
https://kaycobarry.github.io/plannipro/pointeuse.html
```

La tablette peut être installée depuis le menu du navigateur grâce au manifeste PWA.

## Fonctionnement hors connexion

Les badges sont conservés dans IndexedDB, avec un identifiant unique. Au retour d'Internet, ils sont envoyés une seule fois à Supabase.

La tablette vérifie localement une preuve de code pour pouvoir fonctionner sans réseau ; elle ne conserve jamais le code en clair. À la resynchronisation, Supabase vérifie de nouveau que :

- la tablette est toujours active ;
- le salarié appartient toujours à l'établissement ;
- le badge n'existe pas déjà ;
- l'enchaînement entrée / pause / reprise / sortie est valide ;
- le pointage n'est pas trop ancien ou dans le futur.

Un badge hors ligne est accepté jusqu'à sept jours après son heure d'origine. Au-delà, il doit être corrigé par un manager depuis PlanniPro pour éviter une falsification de date.

## Sécurité opérationnelle

- Ne jamais laisser la tablette déverrouillée hors du magasin.
- Un appareil perdu doit être suspendu immédiatement depuis **Gérer les pointeuses** ; les badges en attente seront alors refusés à la prochaine connexion.
- Ne pas inscrire les codes des salariés sur la tablette ou près de celle-ci.
- Les corrections faites dans PlanniPro sont conservées comme corrections manager : les événements de badge bruts restent dans le journal d'activité.
- Cette première version ne collecte ni photo, ni signature, ni géolocalisation.

## Tests à faire avant publication

1. Configurer une tablette de test avec le gérant.
2. Créer le code d'un salarié de test et enregistrer entrée, pause, reprise, sortie.
3. Vérifier que le récapitulatif apparaît dans **Pointage** et que le badge est identifié comme provenant de la tablette.
4. Déconnecter le réseau, enregistrer un badge, reconnecter et vérifier qu'il n'apparaît qu'une fois.
5. Suspendre la tablette depuis la liste des appareils, puis vérifier qu'un nouveau badge est refusé.
6. Tester qu'un salarié ne peut lire que ses événements et qu'un manager n'accède pas à un autre établissement.

