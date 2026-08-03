# PlanniPro — étapes à copier-coller

Cette procédure prépare Supabase et teste l’accès sécurisé **avant toute publication GitHub Pages**. Elle ne demande ni mot de passe Supabase, ni clé `service_role`.

Valeurs déjà définies :

```text
Projet Supabase : pkviymixsxwtwrarqomi
URL Supabase : https://pkviymixsxwtwrarqomi.supabase.co
Future URL PlanniPro : https://kaycobarry.github.io/plannipro/
```

## 1. Exécuter le script SQL

À faire de préférence sur ordinateur : le fichier SQL est long.

1. Ouvrir le tableau de bord : <https://supabase.com/dashboard/project/pkviymixsxwtwrarqomi>.
2. Dans la barre latérale, ouvrir **SQL Editor** puis cliquer sur **New query**.
3. Sur l’ordinateur, ouvrir le fichier `supabase/schema.sql` du dossier PlanniPro téléchargé.
4. Faire `Ctrl+A`, puis `Ctrl+C` dans ce fichier.
5. Revenir à Supabase, cliquer dans la grande zone blanche, puis faire `Ctrl+V`.
6. Cliquer sur **Run**.
7. Attendre la fin. En cas d’erreur, copier tout le message d’erreur sans modifier ni supprimer de table.

Ne pas relancer le script plusieurs fois au hasard et ne jamais désactiver RLS pour contourner une erreur.

## 2. Configurer les liens de connexion et de mot de passe

Dans Supabase, ouvrir **Authentication → URL Configuration**.

Dans **Site URL**, saisir exactement :

```text
https://kaycobarry.github.io/plannipro/
```

Dans **Redirect URLs**, ajouter ces quatre lignes, une par une :

```text
https://kaycobarry.github.io/plannipro
https://kaycobarry.github.io/plannipro/
http://localhost:4173
http://localhost:4173/
```

Ensuite ouvrir **Authentication → Providers → Email** :

1. Laisser le fournisseur e-mail activé.
2. Activer la confirmation d’adresse e-mail.
3. Laisser la récupération de mot de passe active.
4. Enregistrer.

## 3. Déployer les deux fonctions sécurisées

Ces fonctions servent uniquement à inviter un collaborateur et à suspendre/réactiver son accès. Elles gardent la clé serveur uniquement chez Supabase.

1. Vérifier que Node.js 20 ou plus récent est installé. Dans **PowerShell**, copier-coller :

```powershell
node --version
```

Le résultat doit commencer par `v20`, `v22` ou supérieur. Si la commande n’est pas reconnue, installer la version LTS depuis <https://nodejs.org/>, puis fermer et rouvrir PowerShell.

2. Ouvrir le dossier PlanniPro téléchargé sur l’ordinateur, faire un clic droit dans une zone vide du dossier puis choisir **Ouvrir dans le Terminal**.

3. Copier-coller cette commande. Elle ouvre une page de connexion Supabase ; se connecter au même compte que celui qui possède le projet, puis revenir dans le Terminal :

```powershell
npx --yes supabase@latest login
```

4. Copier-coller cette commande pour autoriser seulement GitHub Pages et le test local :

```powershell
npx --yes supabase@latest secrets set --project-ref pkviymixsxwtwrarqomi APP_ORIGINS=https://kaycobarry.github.io,http://localhost:4173 APP_URL=http://localhost:4173
```

5. Copier-coller ces deux commandes, l’une après l’autre :

```powershell
npx --yes supabase@latest functions deploy invite-user --project-ref pkviymixsxwtwrarqomi --no-verify-jwt
npx --yes supabase@latest functions deploy revoke-user-sessions --project-ref pkviymixsxwtwrarqomi --no-verify-jwt
```

6. Vérifier que les deux fonctions existent :

```powershell
npx --yes supabase@latest functions list --project-ref pkviymixsxwtwrarqomi
```

Le résultat doit contenir `invite-user` et `revoke-user-sessions`.

## 4. Tester localement avant de publier

Toujours depuis le même dossier dans PowerShell, lancer l’application :

```powershell
npx --yes serve@14 -l 4173
```

Ouvrir ensuite dans Chrome ou Edge :

```text
http://localhost:4173
```

Faire les essais suivants dans cet ordre :

1. Créer le premier compte gérant avec votre adresse e-mail et confirmer le mail reçu.
2. Créer l’organisation et l’établissement, puis importer les données déjà présentes dans PlanniPro.
3. Créer un manager limité à l’établissement de Nantes Charcot.
4. Créer un salarié rattaché à sa fiche salarié.
5. Vérifier que le manager ne voit pas un autre établissement et que le salarié ne voit que son planning et ses pointages.
6. Suspendre le manager, actualiser sa page puis vérifier qu’il ne peut plus accéder aux données.

Ne publiez pas encore la nouvelle version. Envoyez simplement le résultat de chaque étape ou une capture lisible de l’erreur.

## 5. Après validation locale seulement

Quand tous les tests ci-dessus sont validés, remplacer l’adresse locale de la fonction par l’adresse publique avec cette commande :

```powershell
npx --yes supabase@latest secrets set --project-ref pkviymixsxwtwrarqomi APP_ORIGINS=https://kaycobarry.github.io APP_URL=https://kaycobarry.github.io/plannipro/
```

À ce stade seulement, on valide les derniers scénarios RLS et on publie `index.html` sur la branche `main` de `kaycobarry/plannipro`.
