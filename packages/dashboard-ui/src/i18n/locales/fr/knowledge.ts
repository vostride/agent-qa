import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'knowledge.page.readFailedBody':
    '{{error}}. Essayez de recharger la page ; si le problème persiste, exécutez `agent-qa doctor`.',
  'knowledge.used.briefLines_one': '{{count}} ligne de brief',
  'knowledge.used.briefLines_other': '{{count}} lignes de brief',
  'knowledge.used.canary_one': '{{count}} canari',
  'knowledge.used.canary_other': '{{count}} canaris',
  'knowledge.used.stepRowTitle': 'Étape {{step}} : {{text}}',
  'knowledge.used.summary.stepsBriefed_one': '{{count}} étape avec brief',
  'knowledge.used.summary.stepsBriefed_other': '{{count}} étapes avec brief',
  'knowledge.used.summary.canaryLines_one': '{{count}} ligne canari fournie',
  'knowledge.used.summary.canaryLines_other': '{{count}} lignes canari fournies',
  'knowledge.used.summary.replays_one': '{{count}} rejeu de procédure',
  'knowledge.used.summary.replays_other': '{{count}} rejeux de procédure',
  'knowledge.used.summary.hints_one': '{{count}} indication',
  'knowledge.used.summary.hints_other': '{{count}} indications',
  'knowledge.used.summary.replaysAndHints': '{{replays}}, {{hints}}',
  'knowledge.used.verb.given.lead': 'Fournie dans',
  'knowledge.used.verb.given.follow': 'fournie dans',
  'knowledge.used.verb.opened.lead': 'Ouverte par l’agent dans',
  'knowledge.used.verb.opened.follow': 'ouverte dans',
  'knowledge.used.verb.caution.lead': 'Fournie comme mise en garde dans',
  'knowledge.used.verb.caution.follow': 'fournie comme mise en garde dans',
  'knowledge.used.verb.replayed.lead': 'Rejouée dans',
  'knowledge.used.verb.replayed.follow': 'rejouée dans',
  'knowledge.used.verb.hint.lead': 'Utilisée comme indication dans',
  'knowledge.used.verb.hint.follow': 'utilisée comme indication dans',
  'knowledge.used.records_one': '{{count}} fiche',
  'knowledge.used.records_other': '{{count}} fiches',
  'knowledge.stepRefs.goTo': 'Aller à l’étape {{step}} · {{text}}',
  'knowledge.stepRefs.goToInTest': 'Aller à {{test}} · étape {{step}} · {{text}}',
  'knowledge.stepRefs.test': 'Test {{number}}',
  'knowledge.stepRefs.member': '{{test}} · {{steps}}',
  'knowledge.stepRefs.members': '{{list}} ; {{item}}',
  'knowledge.stepRefs.lead_one': 'l’étape {{steps}}',
  'knowledge.stepRefs.lead_other': 'les étapes {{steps}}',
  'knowledge.stepRefs.next': '{{list}}, {{item}}',
  'knowledge.stepRefs.last': '{{list}} et {{item}}',
  'knowledge.stepRefs.range': '{{from}}–{{to}}',
  'knowledge.record.kind.fact': 'Fait',
  'knowledge.record.kind.caution': 'Mise en garde',
  'knowledge.record.kind.procedure': 'Procédure',
  'knowledge.record.kind.policy': 'Politique',
  'knowledge.record.kind.unknown': 'Question ouverte',
  'knowledge.record.absence.notFound': 'Elle ne figure plus dans la base de connaissances.',
  'knowledge.record.absence.scanIncomplete':
    'La base de connaissances n’a pas pu être lue entièrement.',
  'knowledge.record.absence.notBound':
    'Ce tableau de bord n’a pas de lecteur de fiches pour ce projet.',
  'knowledge.record.showAll_one': 'Afficher les {{count}} fiches',
  'knowledge.record.showAll_other': 'Afficher les {{count}} fiches',
  'knowledge.record.appliesTo': 'S’applique à {{place}}',
  'knowledge.record.anchor.page': 'page {{route}}',
  'knowledge.record.anchor.flow': 'parcours {{name}}',
  'knowledge.record.anchor.element': 'élément {{role}} « {{name}} »',
  'knowledge.record.anchor.elementNumbered': 'élément {{role}} « {{name}} » nº {{position}}',
  'knowledge.record.anchor.selector': 'sélecteur',
  'knowledge.record.anchor.error': 'erreur « {{message}} »',
  'knowledge.status.since.active': 'prouvée depuis',
  'knowledge.status.since.candidate': 'remise à l’essai depuis',
  'knowledge.status.since.superseded': 'remplacée depuis',
  'knowledge.status.since.deprecated': 'retirée depuis',
  'knowledge.status.word.active': 'en usage',
  'knowledge.status.word.candidate': 'à l’essai',
  'knowledge.status.word.superseded': 'remplacée',
  'knowledge.status.word.deprecated': 'retirée',
  'knowledge.status.current.active': 'Statut actuel : en usage',
  'knowledge.status.current.candidate': 'Statut actuel : à l’essai',
  'knowledge.status.current.superseded': 'Statut actuel : remplacée',
  'knowledge.status.current.deprecated': 'Statut actuel : retirée',
  'knowledge.status.times_one': '{{count}} fois',
  'knowledge.status.times_other': '{{count}} fois',
  'knowledge.status.trustCounts': 'Confirmée {{confirmed}} · contredite {{contradicted}}',
  'knowledge.effect.contradicted':
    'Ne s’est pas vérifiée dans {{steps}} : l’exécution a observé autre chose',
  'knowledge.effect.harmful': 'A induit l’agent en erreur dans {{steps}}',
  'knowledge.effect.confirmed':
    'S’est vérifiée dans {{steps}} : l’exécution a observé la même chose',
  'knowledge.effect.helpful': 'A aidé dans {{steps}}',
  'knowledge.effect.pending': 'À l’essai dans {{steps}} : en attente du post-traitement',
  'knowledge.effect.unknown':
    'N’a pas pu être vérifiée dans {{steps}} : une partie de la base de connaissances n’a pas pu être lue',
  'knowledge.effect.stopCause.descriptorAmbiguous': 'plusieurs éléments correspondaient',
  'knowledge.effect.stopCause.descriptorMissing': 'l’élément est introuvable',
  'knowledge.effect.stopCause.pageAnchorMismatch': 'la page ne correspondait pas',
  'knowledge.effect.stopCause.gateRefused': 'une vérification de sécurité a refusé l’action',
  'knowledge.effect.stopCause.parameterUnbound': 'une valeur nécessaire n’a pas été fournie',
  'knowledge.effect.stopCause.nonReplayableAction': 'cette action ne peut pas être rejouée',
  'knowledge.effect.stopCause.executionFailure': 'l’action n’a pas pu s’exécuter',
  'knowledge.effect.stopCause.verifierRejection': 'le résultat n’a pas passé la vérification',
  'knowledge.effect.replayed': 'Rejouée dans {{steps}} : chaque action rejouée a été acceptée',
  'knowledge.effect.replayedAll_one':
    'A rejoué toute la procédure ({{count}} étape) dans {{steps}}',
  'knowledge.effect.replayedAll_other':
    'A rejoué toute la procédure ({{count}} étapes) dans {{steps}}',
  'knowledge.effect.replayedSome_one':
    'A rejoué {{replayed}} des {{count}} étapes de la procédure dans {{steps}}',
  'knowledge.effect.replayedSome_other':
    'A rejoué {{replayed}} des {{count}} étapes de la procédure dans {{steps}}',
  'knowledge.effect.stoppedAtOnly':
    'Le rejeu s’est arrêté à la seule étape de la procédure dans {{steps}} : {{cause}}',
  'knowledge.effect.stoppedAtOf':
    'Le rejeu s’est arrêté à l’étape {{step}} sur {{length}} de la procédure dans {{steps}} : {{cause}}',
  'knowledge.effect.stoppedAt':
    'Le rejeu s’est arrêté à l’étape {{step}} de la procédure dans {{steps}} : {{cause}}',
  'knowledge.effect.uncounted_one':
    '{{count}} fiche à l’essai n’a été comptée ni pour ni contre par cette exécution',
  'knowledge.effect.uncounted_other':
    '{{count}} fiches à l’essai n’ont été comptées ni pour ni contre par cette exécution',
  'knowledge.effect.unmeasured_one': '{{count}} autre fiche n’a pas d’effet mesuré.',
  'knowledge.effect.unmeasured_other': '{{count}} autres fiches n’ont pas d’effet mesuré.',
  'knowledge.trace.channel1': 'CANAL 1 · BRIEF',
  'knowledge.trace.channel2': 'CANAL 2 · TRACES DE LECTURE',
  'knowledge.trace.channel3': 'CANAL 3 · MISES EN GARDE',
  'knowledge.trace.line': 'voie {{leg}} · rang {{rank}} · score {{score}}',
  'knowledge.trace.cutCandidates': 'Candidats écartés ({{cut}} sur les {{top}} premiers)',
  'knowledge.stepDetail.cutEyebrow': 'CANDIDATS ÉCARTÉS',
  'knowledge.stepDetail.cutLine': '{{recordId}} · voie {{leg}} · rang {{rank}} · score {{score}}',
  'knowledge.trace.attribution.confirmed': 'attribution : confirmée',
  'knowledge.trace.attribution.contradicted': 'attribution : contredite',
  'knowledge.trace.attribution.helpful': 'attribution : utile',
  'knowledge.trace.attribution.harmful': 'attribution : nuisible',
  'knowledge.trace.trustMeta': 'confiance {{trust}} · niveau {{tier}} · statut {{status}}',
  'knowledge.trace.copyRecordId': 'Copier l’ID de fiche {{id}}',
  'knowledge.trace.copyRecordIdFailed':
    'Impossible de copier. Sélectionnez l’ID pour le copier : {{id}}',
  'knowledge.trace.rungLine': 'Niveau de récupération : {{level}}',
  'knowledge.trace.rungLineWithCause': 'Niveau de récupération : {{level}} ({{cause}})',
  'knowledge.trace.replayed': 'rejouée {{passed}}/{{total}}',
  'knowledge.trace.brokeCause.miss': 'aucune correspondance',
  'knowledge.trace.brokeCause.executionFailure': 'échec de l’adaptateur',
  'knowledge.trace.brokeCause.verifierRejection': 'rejet par le vérificateur',
  'knowledge.trace.brokeAt': 'interrompue à l’étape {{step}} : {{cause}}',
  'knowledge.trace.showAllLines_one': 'Afficher les {{count}} lignes',
  'knowledge.trace.showAllLines_other': 'Afficher les {{count}} lignes',
  'knowledge.changes.reconciliation_one': '{{count}} modification comptée · affichées : {{shown}}',
  'knowledge.changes.reconciliation_other':
    '{{count}} modifications comptées · affichées : {{shown}}',
  'knowledge.changes.bucket.added': 'Ajouté',
  'knowledge.changes.bucket.confirmed': 'Confirmé',
  'knowledge.changes.bucket.superseded': 'Remplacé',
  'knowledge.changes.bucket.deprecated': 'Obsolète',
  'knowledge.changes.bucket.proposed': 'Proposé',
  'knowledge.changes.bucketMeaning.added':
    'Nouvelles connaissances enregistrées à partir de cette exécution.',
  'knowledge.changes.bucketMeaning.confirmed':
    'Connaissances existantes que cette exécution a confirmées, y compris celles promues au statut fiable.',
  'knowledge.changes.bucketMeaning.superseded':
    'Remplacées par une version plus récente ; les agents reçoivent la nouvelle.',
  'knowledge.changes.bucketMeaning.deprecated': 'Retirées ; les agents ne les reçoivent plus.',
  'knowledge.changes.bucketMeaning.proposed':
    'Enregistrées, mais non appliquées : les agents ne les reçoivent pas.',
  'knowledge.changes.ledgerRow.bucket': 'Catégorie',
  'knowledge.changes.ledgerRow.record': 'Fiche',
  'knowledge.changes.ledgerRow.events': 'Événements',
  'knowledge.changes.ledgerRow.promotion': 'Parcours de promotion',
  'knowledge.changes.ledgerRow.receipt': 'Empreinte du reçu',
  'knowledge.changes.ledgerRow.evidence': 'Preuves',
  'knowledge.changes.ledgerRow.observation': 'Observation',
  'knowledge.changes.ledgerRow.sourceRun': 'Exécution source',
  'knowledge.changes.ledgerRow.validity': 'Validité',
  'knowledge.changes.ledgerRow.link': 'Référence',
  'knowledge.changes.validityOpen': 'ouverte @ {{opened}}',
  'knowledge.changes.validityClosed': 'ouverte @ {{opened}} · fermée @ {{closed}}',
  'knowledge.learned.sinceThisRun_one': 'Depuis cette exécution · {{count}} modification',
  'knowledge.learned.sinceThisRun_other': 'Depuis cette exécution · {{count}} modifications',
  'knowledge.learned.sinceThen.added': 'ajoutée plus tard',
  'knowledge.learned.sinceThen.confirmed': 'confirmée de nouveau, plus tard',
  'knowledge.learned.sinceThen.promoted': 'promue au statut fiable, plus tard',
  'knowledge.learned.sinceThen.superseded': 'remplacée plus tard',
  'knowledge.learned.sinceThen.deprecated': 'retirée plus tard',
  'knowledge.retrieval.rung.bundleScan': 'l’analyse des paquets',
  'knowledge.retrieval.rung.staticFloor': 'les embeddings de la base statique',
  'knowledge.retrieval.rung.lexicalOnly': 'la récupération lexicale seule',
  'knowledge.retrieval.statement.freshIndex':
    'L’index des connaissances n’était pas encore construit : cette exécution a donc lu les connaissances directement dans les paquets. Rien n’a été manqué. L’index est construit à la fin de l’exécution, et les exécutions suivantes l’utilisent.',
  'knowledge.retrieval.statement.causeNotRecorded':
    'Cette exécution a utilisé {{level}} au lieu de la récupération complète des connaissances. La raison n’a pas été enregistrée pour cette exécution.',
  'knowledge.retrieval.statement.indexProblem':
    'Cette exécution n’a pas pu utiliser l’index des connaissances et a donc lu les connaissances directement dans les paquets : {{cause}}.',
  'knowledge.retrieval.statement.staticFloor':
    'La récupération des connaissances de cette exécution a utilisé les embeddings légers de la base statique au lieu du modèle complet : {{cause}}.',
  'knowledge.retrieval.statement.noSemanticSearch':
    'La récupération des connaissances de cette exécution s’est faite sans recherche sémantique, uniquement par correspondance de mots-clés et d’ancres : {{cause}}.',
  'knowledge.retrieval.statement.configuredStaticFloor':
    'La récupération des connaissances de cette exécution a utilisé les embeddings de la base statique, comme ce projet est configuré pour le faire.',
  'knowledge.retrieval.statement.configuredLexical':
    'La récupération des connaissances de cette exécution a utilisé uniquement la correspondance de mots-clés et d’ancres, comme ce projet est configuré pour le faire.',
  'knowledge.retrieval.banner': '{{statement}} {{pointer}}',
  'knowledge.page.noStoreHeading': 'Aucune base de connaissances configurée pour ce projet',
  'knowledge.page.noStoreBody':
    'Les exécutions de ce projet se font sans brief. Ajoutez un dossier racine des connaissances à votre configuration pour commencer à en fournir un.',
  'knowledge.page.readFailedHeading': 'Impossible de lire les connaissances',
  'knowledge.used.noBriefServed':
    'Cette exécution n’a utilisé aucune connaissance enregistrée : aucune étape n’a demandé de brief.',
  'knowledge.used.heading': 'Connaissances utilisées',
  'knowledge.used.noBriefLines':
    'Cette exécution n’a utilisé aucune connaissance enregistrée : la récupération a eu lieu et n’a rien trouvé d’applicable.',
  'knowledge.used.stepNoBrief': 'aucun brief fourni',
  'knowledge.used.replayFact': 'rejeu',
  'knowledge.used.hintFact': 'indication',
  'knowledge.used.recordUnreadable': 'Une fiche qui ne peut plus être lue',
  'knowledge.used.procedureContentNotRecorded':
    'Une procédure dont le contenu ne fait pas partie des données de cette exécution',
  'knowledge.used.onTrialTag': 'à l’essai',
  'knowledge.used.onTrialTooltip':
    'Les nouvelles connaissances qui ne sont pas encore prouvées sont fournies à l’agent à l’essai, pour qu’une exécution montre si elles se vérifient. Le résultat de cette exécution compte pour ou contre elles.',
  'knowledge.record.showFull': 'Afficher la fiche complète',
  'knowledge.record.evidenceNote': 'Note du curateur : rédigée par le curateur, non vérifiée',
  'knowledge.effect.heading': 'Effet sur cette exécution',
  'knowledge.effect.nothingMeasured':
    'Rien n’a été mesuré lors de cette exécution. Seuls les rejeux de procédure et les connaissances à l’essai sont mesurés.',
  'knowledge.effect.nothingUsed':
    'Rien à mesurer : cette exécution n’a utilisé aucune connaissance enregistrée.',
  'knowledge.effect.uncountedTrialsTooltip':
    'Le post-traitement s’est terminé sans compter le résultat de cette exécution pour cette fiche.',
  'knowledge.trace.preTrace': 'aucune trace n’a été capturée pour cette exécution',
  'knowledge.trace.stepNotFound': 'aucune preuve enregistrée pour cette étape',
  'knowledge.trace.ledgerOnTrial': 'à l’essai (canari)',
  'knowledge.trace.recordIdCopied': 'ID de fiche copié dans le presse-papiers',
  'knowledge.trace.attributionPending': 'attribution en attente',
  'knowledge.trace.attributionSkipped': 'attribution ignorée',
  'knowledge.trace.notAttributed': 'non attribuée',
  'knowledge.trace.attributionUnknown': 'attribution inconnue',
  'knowledge.trace.procedureHint': 'indication de procédure',
  'knowledge.trace.procedureHintDemoted': 'indication de procédure (rétrogradée depuis un rejeu)',
  'knowledge.changes.heading': 'Modifications de la mémoire',
  'knowledge.changes.pending':
    'Les modifications de la mémoire apparaissent une fois le post-traitement terminé.',
  'knowledge.changes.curationFailed':
    'Échec de la curation : rien n’a été appris de cette exécution.',
  'knowledge.changes.curationFailedPartial':
    'Échec de la curation : ces fiches avaient été validées avant son arrêt.',
  'knowledge.changes.countsNotRecorded': 'Nombres non enregistrés pour cette exécution.',
  'knowledge.changes.notAvailable':
    'Les fiches de modification de cette exécution ne sont pas encore disponibles.',
  'knowledge.changes.unreadable':
    'Les fiches de modification n’ont pas pu être lues dans la base de connaissances. Exécutez `agent-qa doctor`.',
  'knowledge.changes.storeReadIncomplete':
    'La base de connaissances n’a pas pu être lue entièrement. Exécutez `agent-qa doctor`.',
  'knowledge.changes.noMemoryChanges':
    'Le post-traitement s’est terminé sans rien modifier dans la mémoire.',
  'knowledge.changes.reconciliationUnattributed':
    'L’écart n’a pas pu être attribué aux lignes de cette exécution.',
  'knowledge.learned.proposedNote': 'enregistrée, non appliquée',
  'knowledge.learned.openQuestionNote': 'question ouverte enregistrée',
  'knowledge.learned.recordContentNotRecorded':
    'Une fiche dont le contenu ne fait pas partie des données de cette exécution',
  'knowledge.learned.was': 'Avant : {{record}}',
  'knowledge.retrieval.detailsLabel': 'Détails de la récupération',
  'knowledge.retrieval.doctorPointer':
    'Pour vérifier l’état de la base maintenant, exécutez agent-qa doctor. Cette commande indique l’état actuel et ne modifie pas ce que cette exécution a enregistré.',
  'knowledge.rungCause.native-runtime-unavailable':
    'environnement d’exécution ONNX natif indisponible',
  'knowledge.rungCause.profile-unresolved': 'profil du modèle d’embedding non résolu (différé)',
  'knowledge.rungCause.model-not-downloaded': 'modèle d’embedding non téléchargé',
  'knowledge.rungCause.embedder-load-failed': 'échec du chargement du modèle d’embedding',
  'knowledge.rungCause.index-unavailable':
    'index des connaissances indisponible (cause non enregistrée), analyse des paquets',
  'knowledge.rungCause.floor-disabled': 'base statique désactivée',
  'knowledge.rungCause.profile-static-configured': 'profil statique configuré',
  'knowledge.rungCause.index-not-built':
    'index des connaissances pas encore construit, analyse des paquets',
  'knowledge.rungCause.index-locked':
    'index des connaissances verrouillé par un autre processus, analyse des paquets',
  'knowledge.rungCause.index-corrupt':
    'index des connaissances corrompu, reconstruction demandée, analyse des paquets',
} satisfies Translation<typeof en>
