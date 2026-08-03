# Déploiement GitHub Pages — après validation sécurité

Ne publier qu’après avoir exécuté `supabase/schema.sql`, puis `supabase/time-clock.sql`, déployé les Edge Functions et validé les scénarios de `tests/rls-checklist.md`, `tests/time-clock-rls-checklist.md` ainsi que ceux de `docs/POINTEUSE_TABLETTE.md`.

1. Vérifier localement :

```bash
node tests/verify-rbac.mjs
node tests/verify-time-clock.mjs
node --check plannipro-cloud.js
node --check pointeuse.js
```

Puis valider chaque ligne de [`tests/rls-checklist.md`](../tests/rls-checklist.md) avec le projet Supabase réel. Une validation statique ne remplace pas les tests avec les tokens Auth et les règles RLS du projet.

2. Dans GitHub, vérifier que **Settings → Pages** publie la branche `main` depuis `/ (root)`. Le fichier `index.html` à la racine est le point d’entrée ; il corrige l’écran vide qui affichait précédemment seulement le README.

3. Définir les valeurs Edge Function `APP_ORIGIN` et `APP_URL` avec l’URL réellement affichée par GitHub Pages, puis ajouter cette URL aux Redirect URLs Supabase.

4. Fusionner la branche validée dans `main`. Attendre la fin du déploiement Pages, ouvrir l’URL publique en HTTPS et vérifier : connexion, création du premier gérant, import, invitation/renvoi, suspension, mode hors connexion et retour en ligne, puis la pointeuse sur `pointeuse.html`.

5. Conserver la branche comme point de restauration jusqu’à la validation métier définitive.
