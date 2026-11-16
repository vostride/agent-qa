import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'feedback.place.thisTest': 'ce test',
  'feedback.place.test': '{{name}} {{handle}}',
  'feedback.place.step': 'l’étape {{number}}',
  'feedback.place.stepOfTest': 'l’étape {{number}} de {{test}}',
  'feedback.composer.pinnedTarget':
    'Vous consultez {{viewed}}, mais ce retour porte sur {{about}}.',
  'feedback.composer.switchTarget': 'Passer à {{place}}',
  'feedback.composer.unsentDraft': 'Brouillon non envoyé : {{place}}',
  'feedback.composer.headingStep': 'Retour sur l’étape {{number}} sur {{total}} · {{name}}',
  'feedback.composer.headingTest': 'Retour sur {{name}}',
  'feedback.composer.headingSuiteTest': 'Retour sur {{name}} {{handle}}',
  'feedback.choice.falseFail': 'Cela aurait dû réussir',
  'feedback.choice.falsePass': 'Cela aurait dû échouer',
  'feedback.choice.confirmedBug': 'C’est un vrai bug du produit',
  'feedback.choiceMeaning.failed.falseFail':
    'L’application s’est comportée correctement ; le test a eu tort d’échouer.',
  'feedback.choiceMeaning.failed.confirmedBug':
    'L’échec est réel : l’application ne fonctionne pas ici.',
  'feedback.choiceMeaning.failed.falsePass':
    'Le test a manqué un problème qu’il aurait dû détecter.',
  'feedback.choiceMeaning.passed.falseFail': 'La réussite est correcte ; cela confirme le test.',
  'feedback.choiceMeaning.passed.confirmedBug':
    'L’application a un vrai bug ici, même si le test a réussi.',
  'feedback.choiceMeaning.passed.falsePass':
    'L’application ne fonctionnait pas ici, mais le test a quand même réussi.',
  'feedback.scope.recorded.passed': 'enregistré : réussi',
  'feedback.scope.recorded.healed': 'enregistré : réparé, compte comme réussi',
  'feedback.scope.recorded.failed': 'enregistré : échoué',
  'feedback.scope.recorded.timeout': 'enregistré : expiré, compte comme échoué',
  'feedback.scope.recorded.cancelled': 'enregistré : annulé, compte comme échoué',
  'feedback.scope.recorded.skipped': 'enregistré : ignoré, compte comme échoué',
  'feedback.scope.noStepVerdict':
    'aucun verdict d’étape enregistré : le résultat du test est utilisé ({{recorded}})',
  'feedback.scope.wholeTest': 'Test entier · {{recorded}}',
  'feedback.scope.oneStep': 'Une étape · {{recorded}}',
  'feedback.scope.oneStepInTest': 'Une étape dans {{name}} {{handle}} · {{recorded}}',
  'feedback.entry.step': 'Donner un retour sur l’étape {{number}}',
  'feedback.entry.member': 'Donner un retour sur {{name}} {{handle}}',
  'feedback.entry.stepMarked': 'Donner un retour sur l’étape {{number}}. Déjà marquée : {{choice}}',
  'feedback.entry.testMarked': 'Donner un retour sur ce test. Déjà marqué : {{choice}}',
  'feedback.entry.memberMarked':
    'Donner un retour sur {{name}} {{handle}}. Déjà marqué : {{choice}}',
  'feedback.entry.stepMarkedTooltip': 'L’étape {{number}} est déjà marquée : vérifiez ou modifiez',
  'feedback.entry.markGlyph': 'Marqué : {{choice}}',
  'feedback.disposition.applied.fact': 'Enregistré, fait de connaissance ajouté',
  'feedback.disposition.applied.caution': 'Enregistré, mise en garde ajoutée',
  'feedback.disposition.applied.procedureHint': 'Enregistré, indication de procédure ajoutée',
  'feedback.disposition.applied.testEdit': 'Enregistré, fichier de test modifié',
  'feedback.disposition.drafted': 'Enregistré, correctif rédigé (ancien marquage)',
  'feedback.disposition.noDraftableFix': 'Enregistré, aucun correctif n’a pu être rédigé',
  'feedback.disposition.confirmedBug':
    'Enregistré, conservé comme vrai bug du produit ; rien n’a changé',
  'feedback.disposition.notApplied.targetNotFound':
    'Enregistré, correctif non appliqué car la connaissance qu’il remplace n’existe plus',
  'feedback.disposition.notApplied.policyMaterializeRefused':
    'Enregistré, correctif non appliqué car le texte de sa politique a été refusé',
  'feedback.disposition.notApplied.outsideWorkspace':
    'Enregistré, correctif non appliqué car le fichier de test est hors de l’espace de travail',
  'feedback.disposition.quarantined': 'Enregistré, mis en quarantaine ({{cause}})',
  'feedback.recorded.applied.fact': 'Retour enregistré : un fait de connaissance a été ajouté.',
  'feedback.recorded.applied.caution': 'Retour enregistré : une mise en garde a été ajoutée.',
  'feedback.recorded.applied.procedureHint':
    'Retour enregistré : une indication de procédure a été ajoutée.',
  'feedback.recorded.applied.testEdit': 'Retour enregistré : le fichier de test a été modifié.',
  'feedback.recorded.drafted': 'Retour enregistré : un correctif a été rédigé (ancien marquage).',
  'feedback.recorded.noDraftableFix': 'Retour enregistré : aucun correctif n’a pu être rédigé.',
  'feedback.recorded.confirmedBug':
    'Retour enregistré : conservé comme vrai bug du produit ; rien n’a changé.',
  'feedback.recorded.notApplied.targetNotFound':
    'Retour enregistré : le correctif n’a pas été appliqué, car la connaissance qu’il remplace n’existe plus.',
  'feedback.recorded.notApplied.policyMaterializeRefused':
    'Retour enregistré : le correctif n’a pas été appliqué, car le texte de sa politique a été refusé.',
  'feedback.recorded.notApplied.outsideWorkspace':
    'Retour enregistré : le correctif n’a pas été appliqué, car le fichier de test est hors de l’espace de travail.',
  'feedback.recorded.quarantined': 'Retour enregistré : mis en quarantaine ({{cause}}).',
  'feedback.preview.lineLabel.knowledge': 'Connaissances',
  'feedback.preview.lineLabel.change': 'Modification',
  'feedback.preview.noRecordsReached': 'Aucune fiche de connaissance n’est atteinte',
  'feedback.preview.confirmed_one': '{{count}} fiche confirmée',
  'feedback.preview.confirmed_other': '{{count}} fiches confirmées',
  'feedback.preview.countedAgainst_one': '{{count}} comptée contre',
  'feedback.preview.countedAgainst_other': '{{count}} comptées contre',
  'feedback.preview.confirmedAndCountedAgainst': '{{confirmed}} · {{countedAgainst}}',
  'feedback.preview.unreadableRecords_one': '{{count}} fiche atteinte : elle ne peut pas être lue',
  'feedback.preview.unreadableRecords_other':
    '{{count}} fiches atteintes : aucune ne peut être lue',
  'feedback.preview.showRecords': 'Afficher les fiches ({{number}})',
  'feedback.preview.effect.confirm': 'confirme',
  'feedback.preview.effect.overturn': 'compte contre',
  'feedback.preview.effect.overturnTimes': 'compte contre × {{times}}',
  'feedback.preview.effect.confirmAndOverturn': '{{confirm}} · {{overturn}}',
  'feedback.preview.contentAbsence.notFound': 'Contenu de la fiche introuvable',
  'feedback.preview.contentAbsence.scanIncomplete':
    'Le contenu de la fiche n’a pas pu être lu entièrement',
  'feedback.preview.contentAbsence.notBound':
    'Le contenu de la fiche n’est pas disponible sur cet hôte',
  'feedback.preview.fix.fact': 'Un fait de connaissance sera ajouté',
  'feedback.preview.fix.caution': 'Une mise en garde sera ajoutée',
  'feedback.preview.fix.procedureHint': 'Une indication de procédure sera ajoutée',
  'feedback.preview.fix.testEdit': 'Le fichier de test sera modifié',
  'feedback.preview.fix.noDraftableFix': 'Aucun correctif ne peut être tiré de cette exécution',
  'feedback.preview.fix.confirmedBug':
    'Rien ne change : un vrai bug du produit demande un correctif du produit, pas une modification du test ou des connaissances',
  'feedback.preview.replaces':
    'Remplace votre marquage précédent (nº {{mark}}) ; ce qu’il a modifié reste en place',
  'feedback.preview.replacesAt':
    'Remplace votre marquage précédent (nº {{mark}}, {{time}}) ; ce qu’il a modifié reste en place',
  'feedback.preview.resolvedStep.failingStep':
    'Ceci marque l’étape {{number}} sur {{total}} : la première étape en échec.',
  'feedback.preview.resolvedStep.lastStepFinished':
    'Ceci marque l’étape {{number}} sur {{total}} : la dernière étape, où le test s’est terminé.',
  'feedback.preview.resolvedStep.lastStepNoFailure':
    'Ceci marque l’étape {{number}} sur {{total}} : la dernière étape, car aucune étape n’a échoué.',
  'feedback.preview.showStep': 'Afficher l’étape {{number}}',
  'feedback.preview.quarantined.timeout':
    'Ce test a échoué à cause d’un délai dépassé : votre marquage est enregistré, mais mis en quarantaine. Aucune connaissance ni aucun test ne change.',
  'feedback.preview.quarantined.flake':
    'Ce test a échoué à cause d’une exécution instable : votre marquage est enregistré, mais mis en quarantaine. Aucune connaissance ni aucun test ne change.',
  'feedback.preview.quarantined.environment':
    'Ce test a échoué à cause d’un problème d’environnement : votre marquage est enregistré, mais mis en quarantaine. Aucune connaissance ni aucun test ne change.',
  'feedback.preview.alreadyMarked':
    'Vous l’avez déjà indiqué. Une nouvelle note seule n’est pas enregistrée.',
  'feedback.preview.alreadyMarkedAt':
    'Vous l’avez déjà indiqué ({{time}}). Une nouvelle note seule n’est pas enregistrée.',
  'feedback.preview.refusal.runNotFound':
    'Cette exécution ne figure plus dans le stockage des exécutions : le retour ne peut pas être enregistré.',
  'feedback.preview.refusal.memberNotFound':
    'Ce test est introuvable dans l’exécution : le retour ne peut pas être enregistré.',
  'feedback.preview.refusal.noSteps':
    'Ce test n’a enregistré aucune étape : il n’y a rien à marquer.',
  'feedback.preview.refusal.stepNotFound_one':
    'Ce test a enregistré {{count}} étape : il n’y a pas d’étape {{number}} à marquer.',
  'feedback.preview.refusal.stepNotFound_other':
    'Ce test a enregistré {{count}} étapes : il n’y a pas d’étape {{number}} à marquer.',
  'feedback.preview.refusal.ambiguousAddress_one':
    '{{count}} test de cette exécution partage cette adresse : le marquage ne peut pas être placé.',
  'feedback.preview.refusal.ambiguousAddress_other':
    '{{count}} tests de cette exécution partagent cette adresse : le marquage ne peut pas être placé.',
  'feedback.preview.readFailed': 'Impossible de vérifier ce que cela fera : {{reason}}.',
  'feedback.readFailure.network': 'le serveur du tableau de bord n’a pas répondu',
  'feedback.readFailure.ledgerCorrupt': 'le registre des retours de cette exécution est endommagé',
  'feedback.readFailure.ledgerUnavailable':
    'le registre des retours de cette exécution ne peut pas être lu pour le moment',
  'feedback.readFailure.refused': 'le serveur a refusé la requête',
  'feedback.readFailure.shape': 'la réponse du serveur n’avait pas la forme attendue',
  'feedback.details.row.kind': 'Type de marquage',
  'feedback.details.row.address': 'Adresse',
  'feedback.details.row.testId': 'ID du test',
  'feedback.details.row.records': 'Fiches atteintes',
  'feedback.details.row.basis': 'Base',
  'feedback.details.basis': 'ordinal du registre {{ledger}}',
  'feedback.details.basisWithPrior':
    'ordinal du registre {{ledger}} · marquage précédent nº {{prior}}',
  'feedback.history.title.step': 'Retours sur cette étape',
  'feedback.history.title.test': 'Retours sur ce test',
  'feedback.history.titleCount.step': 'Retours sur cette étape ({{number}})',
  'feedback.history.titleCount.test': 'Retours sur ce test ({{number}})',
  'feedback.history.runLabel': 'Tous les retours sur cette exécution ({{number}})',
  'feedback.history.replacedBy': 'Remplacé par votre marquage ultérieur',
  'feedback.history.replacedByAt': 'Remplacé par votre marquage ultérieur à {{time}}',
  'feedback.history.recordUnavailable': '{{recordId}} (contenu indisponible)',
  'feedback.history.quoted': '« {{content}} »',
  'feedback.history.appliedKnowledge': 'Connaissances modifiées : {{records}}',
  'feedback.history.appliedTestFile': 'Fichier de test {{file}} modifié',
  'feedback.history.change.records': '{{disposition}} : {{records}}',
  'feedback.history.change.file': '{{disposition}} : {{file}}',
  'feedback.history.change.draftedNotRecorded':
    '{{disposition}} ; ce qu’il a modifié n’a pas été enregistré.',
  'feedback.history.change.contentNotRecorded':
    '{{disposition}} ; son contenu n’a pas été enregistré.',
  'feedback.history.empty.step': 'Aucun retour sur cette étape pour l’instant.',
  'feedback.history.empty.test': 'Aucun retour sur ce test pour l’instant.',
  'feedback.history.empty.run': 'Aucun retour sur cette exécution pour l’instant.',
  'feedback.history.state.runNotFound':
    'L’historique des retours de cette exécution est introuvable.',
  'feedback.history.state.ledgerCorrupt':
    'L’historique des retours de cette exécution est endommagé à la ligne {{line}} : il ne peut pas être affiché.',
  'feedback.history.state.ledgerUnavailable':
    'L’historique des retours de cette exécution ne peut pas être lu pour le moment.',
  'feedback.history.readFailed':
    'Impossible de charger l’historique des retours de cette exécution : {{reason}}.',
  'feedback.history.targetStep': 'Étape {{number}} sur {{total}} · {{name}}',
  'feedback.history.targetTest': '{{name}} {{handle}} · test entier',
  'feedback.composer.noteLabel': 'Note (facultative)',
  'feedback.composer.choiceLegend': 'Qu’est-ce qui est vrai ?',
  'feedback.composer.testSwitcherLabel': 'Test',
  'feedback.composer.noUniqueAddress':
    'Ce test n’a pas d’adresse unique dans cette exécution : aucun retour ne peut être enregistré pour lui.',
  'feedback.composer.submitReason.noUniqueAddress':
    'Ce test ne peut pas être marqué depuis le tableau de bord.',
  'feedback.composer.submitReason.noChoice': 'Choisissez l’une des trois options.',
  'feedback.composer.submitReason.checking': 'Vérification de ce que cela fera…',
  'feedback.composer.submitReason.previewFailed':
    'Les conséquences n’ont pas pu être vérifiées : réessayez ci-dessus.',
  'feedback.composer.submitReason.refused':
    'Ce marquage ne peut pas être enregistré : voir ci-dessus.',
  'feedback.composer.submitReason.alreadyMarked':
    'Vous l’avez déjà indiqué : il n’y a rien de nouveau à enregistrer.',
  'feedback.composer.submitReason.sending': 'Envoi…',
  'feedback.composer.send': 'Envoyer le retour',
  'feedback.preview.title': 'Ce que cela fera',
  'feedback.composer.sendingStatus': 'Envoi du retour…',
  'feedback.entry.test': 'Donner un retour sur ce test',
  'feedback.composer.close': 'Fermer le retour',
  'feedback.composer.closeTooltip': 'Fermer (Esc)',
  'feedback.composer.draftKeptStatus':
    'Brouillon conservé. Vérifiez le message ci-dessus avant de renvoyer.',
  'feedback.entry.tooltip': 'Donner un retour',
  'feedback.entry.markedTooltip': 'Déjà marqué : vérifiez ou modifiez',
  'feedback.preview.updating': 'Mise à jour…',
  'feedback.preview.idle': 'Choisissez une option ci-dessus pour voir ce que cela fera.',
  'feedback.preview.unreadableRecord':
    'Cette fiche ne peut pas être lue : elle garde sa place, et rien ne lui est appliqué.',
  'feedback.preview.draftWordingNotShown':
    'La formulation exacte n’est pas affichée ici : elle est rédigée à l’envoi.',
  'feedback.retry': 'Réessayer',
  'feedback.details.label': 'Détails techniques',
  'feedback.history.active': 'Actif',
  'feedback.history.replacementExplanation':
    'Seul votre dernier marquage sur un test ou une étape compte.',
  'feedback.history.appliedUnavailable': 'Ce que ce marquage a modifié n’a pas été enregistré.',
  'feedback.preview.cliEscape':
    'Vous pouvez toujours enregistrer un retour depuis la CLI ({{name}}) ou via MCP.',
  'feedback.preview.retryName': 'Vérifier de nouveau ce que cela fera',
  'feedback.history.retryName': 'Recharger l’historique des retours',
  'feedback.history.appliedCorrection':
    'Un correctif reste en place quand vous marquez de nouveau : corrigez les connaissances avec un nouveau retour ou en les oubliant, et annulez une modification de test avec git.',
} satisfies Translation<typeof en>
