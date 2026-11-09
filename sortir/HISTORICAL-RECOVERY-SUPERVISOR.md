# Superviseur local de reprise historique DATAtourisme

Implémentation seulement : aucune reprise réelle autorisée par ce document.
Le writer métier et son codeHash restent inchangés. Les plans ne sont ni réécrits,
ni prolongés. Aucun démarrage automatique, cron ou déploiement n'est ajouté.

## Fonctionnement

- Manifeste national et 12 plans vérifiés par SHA256, codeHash et identifiants.
- Préfixe minimum exigé : 74 lots / 7 051 promotions, soit les plans 001–005
  puis les 21 premiers lots du plan 006. Les checkpoints suivants sont également
  acceptés si valides et contigus : un redémarrage ne les retraite pas.
- Premier lot manquant attendu : 006/22 (indice SQL 21), puis 007–012.
- Journal PostgreSQL relu au démarrage et après chaque reconnexion, puis
  checkpoint du lot relu avant sa revalidation. Aucun fichier de progression local
  ne fait autorité. Le « journal » désigne la table transactionnelle
  `sortir_organizer_recovery_batches`, pas les logs serveur ou le WAL.
- Prévalidation en autocommit READ ONLY : 25 cibles par segment, candidats par
  pages de 100 avec curseur UUID, mêmes empreintes et éligibilité métier.
  Les lectures utilisent des snapshots par requête ; la décision autoritative
  reste la revalidation transactionnelle du writer sous ses verrous inchangés.
  Les contrôles n'ouvrent plus de transaction entre deux échanges réseau.
- Le writer d'origine effectue ensuite sa propre validation sous ses 10 verrous
  transactionnels. Aucun verrou n'est supprimé ni contourné.
- Coupure réseau : fermeture, nouvelle connexion TLS, relecture du journal,
  au plus 3 retries par opération (2, 5, 15 secondes), 6 sur toute l'exécution.
  Une réponse COMMIT perdue est réconciliée avant tout nouvel appel au writer.
- Erreur métier, SQL non réseau, verrou occupé, checkpoint divergent, plan modifié
  ou expiré : arrêt, sans retry. SIGINT/SIGTERM demandent un arrêt coopératif.
- Horloge locale et PostgreSQL vérifiées ; contrôle additionnel dans les hooks
  `validated` et `beforeCommit`. Échéance fixe : 5 novembre 2026, 21 h Réunion
  (`2026-11-05T17:00:00Z`). Après cette échéance, nouveau diagnostic/scellement
  nécessaire : ce superviseur n'accepte pas de substitution de manifeste.
- Logs JSON : checkpoints_verified, batch_validated, network_retry,
  commit_reconciled, batch_committed, supervision_finished/stopped.
  `activated` compte les réponses confirmées ; `reconciled` les promotions
  retrouvées après une réponse perdue. Les promotions anciennes sont ignorées.

## Vérifications locales sans connexion

```sh
node sortir/run-historical-recovery-supervisor.js --validate-files
node --test sortir/test-historical-recovery-supervisor.js
env -u SORTIR_WRITER_TEST_DATABASE_URL node sortir/test-organizer-review-writer.js
```

La suite utilise des connexions simulées et PostgreSQL embarqué PGlite,
sans réseau et sans base Supabase. Ne pas renseigner une base de production
pour ces tests.

## Conditions d'une future reprise réelle

1. Nouvelle autorisation utilisateur explicite, avant toute commande connectée.
2. Avant 21 h Réunion le 5 novembre 2026, avec marge suffisante ; fichiers
   inchangés et codeHash
   `1b1feff8f66eb18f10176c9ce15b753a331672dfcc2a17fc647c429608452a74`.
3. Connexion dédiée `SORTIR_RECOVERY_DATABASE_URL`, utilisateur
   `sortir_organizer_recovery_login…`, certificat `SORTIR_RECOVERY_CA_FILE`,
   validation TLS stricte, rôle `sortir_organizer_recovery_writer` disponible.
   Aucun repli sur service_role ni chargement implicite de secrets.
4. Vérification connectée en lecture seule autorisée puis réussie :
   `node sortir/run-historical-recovery-supervisor.js --check --max-batches 1`.
   Elle contrôle tout le journal mais ne prévalide qu'un lot restant.
5. Mutex scheduler completed, aucune ingestion/source running, scan national
   finalized. Aucune autre instance de reprise lancée. Les verrous du writer
   restent la protection autoritative contre les courses entre contrôle et écriture.
6. Les lots restants passent leurs contrôles juste avant écriture ; une divergence
   arrête la reprise et exige une analyse, jamais une régénération automatique.
7. Choisir explicitement la limite (1 par défaut pour premier lot surveillé,
   211 pour l'intégralité des lots restants si le journal est encore au préfixe).

Commande future seulement, NE PAS EXÉCUTER sans nouvelle autorisation :

```sh
SORTIR_RECOVERY_ALLOW_WRITE=I_AUTHORIZE_EXACT_PLAN \
node sortir/run-historical-recovery-supervisor.js --apply --max-batches 1 \
  --authorize-manifest-sha256 2dac946e00972458d61e8fb65b531a26a7308ec3bb0c5eabc86935f7fd60277d
```

## Limites conservées

Le writer inchangé charge toujours tous les candidats temporels de son lot et
calcule ses compteurs globaux. La prévalidation paginée ne supprime donc pas
son pic mémoire ni son coût SQL. Aucun essai en charge sur Render n'est réalisé.
La suite PGlite ne valide pas les coupures TCP ou la concurrence intersessions
d'un PostgreSQL distant. Les tests réseau sont des injections de pannes.
Un arrêt brutal après COMMIT reste récupérable par le journal au redémarrage.
Une échéance vérifiée juste avant COMMIT ne garantit pas que sa réponse arrive
avant l'échéance ; il faut conserver une marge opérationnelle.
