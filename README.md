# PlanniPro

PlanniPro regroupe le planning, les dossiers RH, le registre du personnel, les congés, les pointages, la Pointeuse tablette, les publications PDF et le coffre-fort documentaire.

## Accès

- Application : <https://plannipro.eu/>
- Pointeuse : <https://plannipro.eu/pointeuse.html>
- Projet Supabase : `pkviymixsxwtwrarqomi`

## Principes de sécurité

- La clé présente dans `supabase-config.js` est une clé publique destinée au navigateur.
- Une clé `service_role` ne doit jamais être ajoutée au dépôt, au navigateur ou à GitHub.
- Les autorisations effectives sont appliquées par RLS et par les RPC Supabase ; masquer un bouton ne constitue jamais une autorisation.
- Les documents RH sont stockés exclusivement dans un bucket Supabase Storage privé.
- Les réponses Supabase ne sont jamais mises en cache par le Service Worker.
- Les inscriptions publiques sont désactivées. Les collaborateurs rejoignent une organisation par invitation.

## Vérifications locales

Node.js 22 ou plus récent est requis.

```bash
npm run test:static
```

Cette commande contrôle la syntaxe, le RBAC, les migrations SQL, la Pointeuse, les publications, le coffre-fort, le Service Worker, la CSP, les dépendances et la protection contre les conflits de synchronisation.

Les tests anonymes contre le projet distant sont séparés afin d'éviter qu'une CI de fork contacte la production :

```bash
npm run test:remote:anon
```

Le contrôle de disponibilité du site public est indépendant de la version locale non publiée :

```bash
npm run test:remote:public
```

La recette multi-rôles nécessite uniquement des comptes de recette non privilégiés et des variables d'environnement documentées dans `tests/remote-rbac.mjs` :

```bash
npm run test:remote:rbac
```

## Développement local

Servir le dossier avec un serveur HTTP, par exemple :

```bash
python -m http.server 4173 --bind 127.0.0.1
```

Puis ouvrir `http://127.0.0.1:4173/`. L'ouverture directe de `index.html` avec une URL `file://` n'est pas supportée par le Service Worker.

## Ordre des migrations Supabase

Pour une installation neuve :

1. `supabase/schema.sql`
2. `supabase/time-clock.sql`
3. `supabase/time-clock-secure-activation.sql`
4. `supabase/rbac-advanced.sql`
5. `supabase/company-administration.sql`
6. `supabase/hr-vault.sql`
7. `supabase/planning-publications.sql`
8. `supabase/security-performance-hardening.sql`
9. `supabase/fix-membership-update-recursion.sql`

Toutes les nouvelles tables exposées à la Data API doivent disposer de `GRANT` explicites et de RLS avant leur utilisation dans le navigateur.

## Edge Functions

- `create-company`
- `invite-user`
- `revoke-user-sessions`
- `publish-planning`
- `send-clock-pin-invitation`

Les origines sont filtrées par `supabase/functions/_shared/cors.ts`. `APP_URL` contient l'URL complète utilisée dans les e-mails ; `APP_ORIGINS` contient uniquement les origines HTTPS autorisées.

## Mise en production

Une publication doit respecter `docs/RELEASE_GATE.md`. Le workflow `.github/workflows/quality.yml` doit réussir avant toute fusion ou publication.

Les procédures d'incident, de sauvegarde et de restauration sont décrites dans `docs/OPERATIONS.md`.

La classification des avertissements et les limites de l'offre Supabase sont suivies dans `docs/SECURITY_BASELINE.md`.

Le dernier état de validation est consigné dans `docs/HARDENING_REPORT_2026-08-07.md`.
