import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'feedback.place.thisTest': 'diesen Test',
  'feedback.place.test': '{{name}} {{handle}}',
  'feedback.place.step': 'Schritt {{number}}',
  'feedback.place.stepOfTest': 'Schritt {{number}} von {{test}}',
  'feedback.composer.pinnedTarget': 'Sie sehen {{viewed}} an – dieses Feedback betrifft {{about}}.',
  'feedback.composer.switchTarget': 'Auf {{place}} umschalten',
  'feedback.composer.unsentDraft': 'Nicht gesendeter Entwurf für {{place}}',
  'feedback.composer.headingStep': 'Feedback zu Schritt {{number}} von {{total}} · {{name}}',
  'feedback.composer.headingTest': 'Feedback zu {{name}}',
  'feedback.composer.headingSuiteTest': 'Feedback zu {{name}} {{handle}}',
  'feedback.choice.falseFail': 'Das hätte bestehen sollen',
  'feedback.choice.falsePass': 'Das hätte fehlschlagen sollen',
  'feedback.choice.confirmedBug': 'Das ist ein echter Produktfehler',
  'feedback.choiceMeaning.failed.falseFail':
    'Die App hat sich richtig verhalten; der Test ist zu Unrecht fehlgeschlagen.',
  'feedback.choiceMeaning.failed.confirmedBug':
    'Der Fehlschlag ist echt – die App ist an dieser Stelle defekt.',
  'feedback.choiceMeaning.failed.falsePass':
    'Der Test hat ein Problem übersehen, das er hätte finden sollen.',
  'feedback.choiceMeaning.passed.falseFail': 'Das Bestehen ist richtig; dies bestätigt den Test.',
  'feedback.choiceMeaning.passed.confirmedBug':
    'Die App hat hier einen echten Fehler, obwohl der Test bestanden hat.',
  'feedback.choiceMeaning.passed.falsePass':
    'Die App war hier defekt, aber der Test hat trotzdem bestanden.',
  'feedback.scope.recorded.passed': 'erfasst: bestanden',
  'feedback.scope.recorded.healed': 'erfasst: repariert – zählt als bestanden',
  'feedback.scope.recorded.failed': 'erfasst: fehlgeschlagen',
  'feedback.scope.recorded.timeout': 'erfasst: Zeitüberschreitung – zählt als fehlgeschlagen',
  'feedback.scope.recorded.cancelled': 'erfasst: abgebrochen – zählt als fehlgeschlagen',
  'feedback.scope.recorded.skipped': 'erfasst: übersprungen – zählt als fehlgeschlagen',
  'feedback.scope.noStepVerdict':
    'kein Urteil für den Schritt erfasst – es gilt das Ergebnis des Tests ({{recorded}})',
  'feedback.scope.wholeTest': 'Ganzer Test · {{recorded}}',
  'feedback.scope.oneStep': 'Ein Schritt · {{recorded}}',
  'feedback.scope.oneStepInTest': 'Ein Schritt in {{name}} {{handle}} · {{recorded}}',
  'feedback.entry.step': 'Feedback zu Schritt {{number}} geben',
  'feedback.entry.member': 'Feedback zu {{name}} {{handle}} geben',
  'feedback.entry.stepMarked':
    'Feedback zu Schritt {{number}} geben – bereits bewertet: {{choice}}',
  'feedback.entry.testMarked': 'Feedback zu diesem Test geben – bereits bewertet: {{choice}}',
  'feedback.entry.memberMarked':
    'Feedback zu {{name}} {{handle}} geben – bereits bewertet: {{choice}}',
  'feedback.entry.stepMarkedTooltip':
    'Schritt {{number}} ist bereits bewertet – ansehen oder ändern',
  'feedback.entry.markGlyph': 'Bewertet: {{choice}}',
  'feedback.disposition.applied.fact': 'Erfasst – ein Wissensfakt wurde hinzugefügt',
  'feedback.disposition.applied.caution': 'Erfasst – eine Warnung wurde hinzugefügt',
  'feedback.disposition.applied.procedureHint':
    'Erfasst – ein Hinweis aus einer Prozedur wurde hinzugefügt',
  'feedback.disposition.applied.testEdit': 'Erfasst – die Testdatei wurde bearbeitet',
  'feedback.disposition.drafted': 'Erfasst – eine Korrektur wurde entworfen (ältere Bewertung)',
  'feedback.disposition.noDraftableFix': 'Erfasst – es konnte keine Korrektur entworfen werden',
  'feedback.disposition.confirmedBug':
    'Erfasst – als echter Produktfehler behalten; nichts wurde geändert',
  'feedback.disposition.notApplied.targetNotFound':
    'Erfasst – die Korrektur wurde nicht angewendet: Das Wissen, das sie ersetzt, ist nicht mehr vorhanden',
  'feedback.disposition.notApplied.policyMaterializeRefused':
    'Erfasst – die Korrektur wurde nicht angewendet: Ihr Richtlinientext wurde abgelehnt',
  'feedback.disposition.notApplied.outsideWorkspace':
    'Erfasst – die Korrektur wurde nicht angewendet: Die Testdatei liegt außerhalb des Arbeitsbereichs',
  'feedback.disposition.quarantined': 'Erfasst – unter Quarantäne gestellt ({{cause}})',
  'feedback.recorded.applied.fact': 'Feedback erfasst – ein Wissensfakt wurde hinzugefügt.',
  'feedback.recorded.applied.caution': 'Feedback erfasst – eine Warnung wurde hinzugefügt.',
  'feedback.recorded.applied.procedureHint':
    'Feedback erfasst – ein Hinweis aus einer Prozedur wurde hinzugefügt.',
  'feedback.recorded.applied.testEdit': 'Feedback erfasst – die Testdatei wurde bearbeitet.',
  'feedback.recorded.drafted':
    'Feedback erfasst – eine Korrektur wurde entworfen (ältere Bewertung).',
  'feedback.recorded.noDraftableFix':
    'Feedback erfasst – es konnte keine Korrektur entworfen werden.',
  'feedback.recorded.confirmedBug':
    'Feedback erfasst – als echter Produktfehler behalten; nichts wurde geändert.',
  'feedback.recorded.notApplied.targetNotFound':
    'Feedback erfasst – die Korrektur wurde nicht angewendet: Das Wissen, das sie ersetzt, ist nicht mehr vorhanden.',
  'feedback.recorded.notApplied.policyMaterializeRefused':
    'Feedback erfasst – die Korrektur wurde nicht angewendet: Ihr Richtlinientext wurde abgelehnt.',
  'feedback.recorded.notApplied.outsideWorkspace':
    'Feedback erfasst – die Korrektur wurde nicht angewendet: Die Testdatei liegt außerhalb des Arbeitsbereichs.',
  'feedback.recorded.quarantined': 'Feedback erfasst – unter Quarantäne gestellt ({{cause}}).',
  'feedback.preview.lineLabel.knowledge': 'Wissen',
  'feedback.preview.lineLabel.change': 'Änderung',
  'feedback.preview.noRecordsReached': 'Es werden keine Wissenseinträge erreicht',
  'feedback.preview.confirmed_one': '{{count}} Eintrag bestätigt',
  'feedback.preview.confirmed_other': '{{count}} Einträge bestätigt',
  'feedback.preview.countedAgainst_one': '{{count}} dagegen gezählt',
  'feedback.preview.countedAgainst_other': '{{count}} dagegen gezählt',
  'feedback.preview.confirmedAndCountedAgainst': '{{confirmed}} · {{countedAgainst}}',
  'feedback.preview.unreadableRecords_one':
    '{{count}} Eintrag erreicht – er kann nicht gelesen werden',
  'feedback.preview.unreadableRecords_other':
    '{{count}} Einträge erreicht – keiner kann gelesen werden',
  'feedback.preview.showRecords': 'Einträge anzeigen ({{number}})',
  'feedback.preview.effect.confirm': 'bestätigt',
  'feedback.preview.effect.overturn': 'zählt dagegen',
  'feedback.preview.effect.overturnTimes': 'zählt dagegen × {{times}}',
  'feedback.preview.effect.confirmAndOverturn': '{{confirm}} · {{overturn}}',
  'feedback.preview.contentAbsence.notFound': 'Inhalt des Eintrags nicht gefunden',
  'feedback.preview.contentAbsence.scanIncomplete':
    'Der Inhalt des Eintrags konnte nicht vollständig gelesen werden',
  'feedback.preview.contentAbsence.notBound':
    'Der Inhalt des Eintrags ist auf diesem Host nicht verfügbar',
  'feedback.preview.fix.fact': 'Ein Wissensfakt wird hinzugefügt',
  'feedback.preview.fix.caution': 'Eine Warnung wird hinzugefügt',
  'feedback.preview.fix.procedureHint': 'Ein Hinweis aus einer Prozedur wird hinzugefügt',
  'feedback.preview.fix.testEdit': 'Die Testdatei wird bearbeitet',
  'feedback.preview.fix.noDraftableFix': 'Aus diesem Lauf lässt sich keine Korrektur ableiten',
  'feedback.preview.fix.confirmedBug':
    'Nichts ändert sich – ein echter Produktfehler braucht eine Korrektur im Produkt, keine Änderung am Test oder am Wissen',
  'feedback.preview.replaces':
    'Ersetzt Ihre frühere Bewertung (#{{mark}}); was sie geändert hat, bleibt bestehen',
  'feedback.preview.replacesAt':
    'Ersetzt Ihre frühere Bewertung (#{{mark}}, {{time}}); was sie geändert hat, bleibt bestehen',
  'feedback.preview.resolvedStep.failingStep':
    'Dies bewertet Schritt {{number}} von {{total}} – den ersten fehlgeschlagenen Schritt.',
  'feedback.preview.resolvedStep.lastStepFinished':
    'Dies bewertet Schritt {{number}} von {{total}} – den letzten Schritt, mit dem der Test endete.',
  'feedback.preview.resolvedStep.lastStepNoFailure':
    'Dies bewertet Schritt {{number}} von {{total}} – den letzten Schritt, weil kein Schritt fehlgeschlagen ist.',
  'feedback.preview.showStep': 'Schritt {{number}} anzeigen',
  'feedback.preview.quarantined.timeout':
    'Dieser Test ist wegen einer Zeitüberschreitung fehlgeschlagen. Ihre Bewertung wird daher erfasst, aber unter Quarantäne gestellt – weder Wissen noch Tests ändern sich.',
  'feedback.preview.quarantined.flake':
    'Dieser Test ist wegen eines instabilen Laufs fehlgeschlagen. Ihre Bewertung wird daher erfasst, aber unter Quarantäne gestellt – weder Wissen noch Tests ändern sich.',
  'feedback.preview.quarantined.environment':
    'Dieser Test ist wegen eines Problems mit der Umgebung fehlgeschlagen. Ihre Bewertung wird daher erfasst, aber unter Quarantäne gestellt – weder Wissen noch Tests ändern sich.',
  'feedback.preview.alreadyMarked':
    'Das haben Sie bereits angegeben. Eine neue Notiz allein wird nicht erfasst.',
  'feedback.preview.alreadyMarkedAt':
    'Das haben Sie bereits angegeben ({{time}}). Eine neue Notiz allein wird nicht erfasst.',
  'feedback.preview.refusal.runNotFound':
    'Dieser Lauf ist nicht mehr im Speicher der Läufe, daher kann kein Feedback erfasst werden.',
  'feedback.preview.refusal.memberNotFound':
    'Dieser Test wurde im Lauf nicht gefunden, daher kann kein Feedback erfasst werden.',
  'feedback.preview.refusal.noSteps':
    'Dieser Test hat keine Schritte aufgezeichnet, daher gibt es nichts zu bewerten.',
  'feedback.preview.refusal.stepNotFound_one':
    'Dieser Test hat {{count}} Schritt aufgezeichnet, daher gibt es keinen Schritt {{number}} zu bewerten.',
  'feedback.preview.refusal.stepNotFound_other':
    'Dieser Test hat {{count}} Schritte aufgezeichnet, daher gibt es keinen Schritt {{number}} zu bewerten.',
  'feedback.preview.refusal.ambiguousAddress_one':
    '{{count}} Test in diesem Lauf hat diese Adresse, daher kann die Bewertung nicht gesetzt werden.',
  'feedback.preview.refusal.ambiguousAddress_other':
    '{{count}} Tests in diesem Lauf teilen sich diese Adresse, daher kann die Bewertung nicht gesetzt werden.',
  'feedback.preview.readFailed': 'Die Wirkung konnte nicht geprüft werden – {{reason}}.',
  'feedback.readFailure.network': 'der Dashboard-Server hat nicht geantwortet',
  'feedback.readFailure.ledgerCorrupt': 'das Feedback-Journal dieses Laufs ist beschädigt',
  'feedback.readFailure.ledgerUnavailable':
    'das Feedback-Journal dieses Laufs kann gerade nicht gelesen werden',
  'feedback.readFailure.refused': 'der Server hat die Anfrage abgelehnt',
  'feedback.readFailure.shape': 'die Antwort des Servers hatte nicht das erwartete Format',
  'feedback.details.row.kind': 'Art der Bewertung',
  'feedback.details.row.address': 'Adresse',
  'feedback.details.row.testId': 'Test-ID',
  'feedback.details.row.records': 'Erreichte Einträge',
  'feedback.details.row.basis': 'Grundlage',
  'feedback.details.basis': 'Journalposition {{ledger}}',
  'feedback.details.basisWithPrior': 'Journalposition {{ledger}} · frühere Bewertung #{{prior}}',
  'feedback.history.title.step': 'Feedback zu diesem Schritt',
  'feedback.history.title.test': 'Feedback zu diesem Test',
  'feedback.history.titleCount.step': 'Feedback zu diesem Schritt ({{number}})',
  'feedback.history.titleCount.test': 'Feedback zu diesem Test ({{number}})',
  'feedback.history.runLabel': 'Gesamtes Feedback zu diesem Lauf ({{number}})',
  'feedback.history.replacedBy': 'Durch Ihre spätere Bewertung ersetzt',
  'feedback.history.replacedByAt': 'Durch Ihre spätere Bewertung vom {{time}} ersetzt',
  'feedback.history.recordUnavailable': '{{recordId}} (Inhalt nicht verfügbar)',
  'feedback.history.quoted': '„{{content}}“',
  'feedback.history.appliedKnowledge': 'Geändertes Wissen: {{records}}',
  'feedback.history.appliedTestFile': 'Testdatei {{file}} bearbeitet',
  'feedback.history.change.records': '{{disposition}}: {{records}}',
  'feedback.history.change.file': '{{disposition}}: {{file}}',
  'feedback.history.change.draftedNotRecorded':
    '{{disposition}}; die Änderungen wurden nicht erfasst.',
  'feedback.history.change.contentNotRecorded': '{{disposition}}; der Inhalt wurde nicht erfasst.',
  'feedback.history.empty.step': 'Noch kein Feedback zu diesem Schritt.',
  'feedback.history.empty.test': 'Noch kein Feedback zu diesem Test.',
  'feedback.history.empty.run': 'Noch kein Feedback zu diesem Lauf.',
  'feedback.history.state.runNotFound': 'Der Feedback-Verlauf dieses Laufs wurde nicht gefunden.',
  'feedback.history.state.ledgerCorrupt':
    'Der Feedback-Verlauf dieses Laufs ist in Zeile {{line}} beschädigt und kann daher nicht angezeigt werden.',
  'feedback.history.state.ledgerUnavailable':
    'Der Feedback-Verlauf dieses Laufs kann gerade nicht gelesen werden.',
  'feedback.history.readFailed':
    'Der Feedback-Verlauf dieses Laufs konnte nicht geladen werden – {{reason}}.',
  'feedback.history.targetStep': 'Schritt {{number}} von {{total}} · {{name}}',
  'feedback.history.targetTest': '{{name}} {{handle}} · ganzer Test',
  'feedback.composer.noteLabel': 'Notiz (optional)',
  'feedback.composer.choiceLegend': 'Was trifft zu?',
  'feedback.composer.testSwitcherLabel': 'Test',
  'feedback.composer.noUniqueAddress':
    'Dieser Test hat in diesem Lauf keine eindeutige Adresse, daher kann kein Feedback zu ihm erfasst werden.',
  'feedback.composer.submitReason.noUniqueAddress':
    'Dieser Test kann nicht im Dashboard bewertet werden.',
  'feedback.composer.submitReason.noChoice': 'Wählen Sie eine der drei Optionen.',
  'feedback.composer.submitReason.checking': 'Die Wirkung wird geprüft …',
  'feedback.composer.submitReason.previewFailed':
    'Die Folgen konnten nicht geprüft werden – versuchen Sie es oben erneut.',
  'feedback.composer.submitReason.refused':
    'Diese Bewertung kann nicht erfasst werden – siehe oben.',
  'feedback.composer.submitReason.alreadyMarked':
    'Das haben Sie bereits angegeben – es gibt nichts Neues zu erfassen.',
  'feedback.composer.submitReason.sending': 'Wird gesendet …',
  'feedback.composer.send': 'Feedback senden',
  'feedback.preview.title': 'Was dies bewirkt',
  'feedback.composer.sendingStatus': 'Feedback wird gesendet …',
  'feedback.entry.test': 'Feedback zu diesem Test geben',
  'feedback.composer.close': 'Feedback schließen',
  'feedback.composer.closeTooltip': 'Schließen (Esc)',
  'feedback.composer.draftKeptStatus':
    'Entwurf behalten. Prüfen Sie die Meldung oben, bevor Sie erneut senden.',
  'feedback.entry.tooltip': 'Feedback geben',
  'feedback.entry.markedTooltip': 'Bereits bewertet – ansehen oder ändern',
  'feedback.preview.updating': 'Wird aktualisiert …',
  'feedback.preview.idle': 'Wählen Sie oben eine Option, um zu sehen, was dies bewirkt.',
  'feedback.preview.unreadableRecord':
    'Dieser Eintrag kann nicht gelesen werden – er behält seinen Platz, und auf ihn wird nichts angewendet.',
  'feedback.preview.draftWordingNotShown':
    'Der genaue Wortlaut wird hier nicht angezeigt – er entsteht beim Senden.',
  'feedback.retry': 'Erneut versuchen',
  'feedback.details.label': 'Technische Details',
  'feedback.history.active': 'Aktiv',
  'feedback.history.replacementExplanation':
    'Nur Ihre neueste Bewertung eines Tests oder Schritts zählt.',
  'feedback.history.appliedUnavailable': 'Was diese Bewertung geändert hat, wurde nicht erfasst.',
  'feedback.preview.cliEscape':
    'Sie können Feedback weiterhin über die CLI ({{name}}) oder über MCP erfassen.',
  'feedback.preview.retryName': 'Die Wirkung erneut prüfen',
  'feedback.history.retryName': 'Feedback-Verlauf erneut laden',
  'feedback.history.appliedCorrection':
    'Eine Korrektur bleibt bestehen, wenn Sie erneut bewerten: Korrigieren Sie Wissen mit neuem Feedback oder indem Sie es vergessen, und machen Sie eine Änderung am Test mit git rückgängig.',
} satisfies Translation<typeof en>
