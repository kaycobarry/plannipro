# Validation réelle — Pointeuse et RLS

À exécuter avec de vrais comptes Supabase avant toute publication. Les tests `node` vérifient la structure, pas les droits du projet distant.

| Scénario | Action | Résultat attendu |
|---|---|---|
| Gérant | Configure une tablette pour Nantes Charcot, crée deux codes | Tablette active, deux noms visibles sur la tablette, aucun code affiché. |
| Manager non habilité | Ouvre `pointeuse.html` et tente la configuration | Refus après connexion : pas de droit de configuration. |
| Manager habilité, périmètre Nantes | Crée/modifie un code pour un salarié de Nantes | Autorisé. |
| Manager Nantes | Tente de gérer une tablette ou un code d'un autre établissement | Refusé par la RPC et par RLS. |
| Salarié | Se connecte à PlanniPro et consulte ses pointages | Ne voit que ses propres événements/récapitulatifs. |
| Salarié | Modifie l'URL, la console ou appelle les tables `time_clock_devices` / `employee_time_clock_credentials` | Aucune donnée ni écriture directe autorisée. |
| Tablette en ligne | Entrée → pause → reprise → sortie | Quatre événements, un seul récapitulatif journalier dans Pointage. |
| Doublon réseau | Rejoue exactement le même `client_event_id` | Réponse `duplicate: true`, aucun second événement. |
| Hors connexion | Coupe le réseau, badge, rouvre la page, puis reconnecte | Badge présent dans la file IndexedDB puis synchronisé une seule fois. |
| Code modifié | Change le code, puis tente de synchroniser un badge ancien | Le serveur accepte la période de grâce de sept jours ou bloque le badge pour revue manager. |
| Appareil suspendu | Suspend la tablette depuis Gérer les pointeuses, puis badge | Nouveau badge refusé ; les badges en attente ne sont plus synchronisés. |
| Multi-entreprises | Utilisateur de l'entreprise B tente le cache ou les événements de l'entreprise A | Aucune lecture ni modification possible. |

Pour chaque échec, conserver une capture de l'écran et le message Supabase, sans transmettre de mot de passe ni de clé serveur.
