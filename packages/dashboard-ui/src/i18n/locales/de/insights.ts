import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'insights.title': 'Einblicke',
  'insights.description':
    'Zuverlässigkeit, Kosten und Kuratierungssignale für den ganzen Zeitraum, mit einem eigenen Vergleichsbereich für Tests, Suiten und Plattformen.',
  'insights.scope.label': 'Umfang der Läufe',
  'insights.scope.scoped': 'Eingegrenzt',
  'insights.scope.all': 'Alle Läufe',
  'insights.window.label': 'Zeitraum',
  'insights.window.oneDay': '1 Tag',
  'insights.window.sevenDays': '7 Tage',
  'insights.window.thirtyDays': '30 Tage',
  'insights.window.all': 'Gesamt',
  'insights.refreshing': 'Ausgewählter Bereich wird aktualisiert',
  'insights.unavailable.title': 'Einblicke nicht verfügbar',
  'insights.unavailable.description':
    'Laden Sie die Seite neu. Wenn das Problem bleibt, ändern Sie den Zeitraum und prüfen Sie, ob Analysedaten vorhanden sind.',
  'insights.empty.title': 'Keine Läufe in diesem Zeitraum',
  'insights.empty.description':
    'Führen Sie Tests aus oder erneut aus, um die Einblicke zu füllen. Wenn Sie ältere Daten erwarten, wechseln Sie zu „30 Tage“ oder „Gesamt“.',
  'insights.empty.action': 'Läufe öffnen',
  'insights.refreshFailed.window':
    'Die letzte Aktualisierung ist fehlgeschlagen. Stattdessen wird der zuvor ausgewählte Zeitraum angezeigt.',
  'insights.refreshFailed.range':
    'Die letzte Aktualisierung ist fehlgeschlagen. Stattdessen wird der zuvor ausgewählte Bereich angezeigt.',
  'insights.metric.totalRuns': 'Läufe gesamt',
  'insights.metric.runsPerDay.window_one': '{{count}} Lauf pro aktivem Tag in diesem Zeitraum.',
  'insights.metric.runsPerDay.window_other': '{{count}} Läufe pro aktivem Tag in diesem Zeitraum.',
  'insights.metric.runsPerDay.range_one': '{{count}} Lauf pro aktivem Tag in diesem Bereich.',
  'insights.metric.runsPerDay.range_other': '{{count}} Läufe pro aktivem Tag in diesem Bereich.',
  'insights.metric.scopedRunsPerDay.window_one':
    '{{count}} eingegrenzter Lauf pro aktivem Tag in diesem Zeitraum.',
  'insights.metric.scopedRunsPerDay.window_other':
    '{{count}} eingegrenzte Läufe pro aktivem Tag in diesem Zeitraum.',
  'insights.metric.scopedRunsPerDay.range_one':
    '{{count}} eingegrenzter Lauf pro aktivem Tag in diesem Bereich.',
  'insights.metric.scopedRunsPerDay.range_other':
    '{{count}} eingegrenzte Läufe pro aktivem Tag in diesem Bereich.',
  'insights.metric.passRate': 'Erfolgsquote',
  'insights.metric.passedOutOf_one':
    '{{count}} erfolgreicher Lauf von {{decided}}, die bestanden haben oder fehlgeschlagen sind.',
  'insights.metric.passedOutOf_other':
    '{{count}} erfolgreiche Läufe von {{decided}}, die bestanden haben oder fehlgeschlagen sind.',
  'insights.metric.scopedPassedOutOf_one':
    '{{count}} erfolgreicher eingegrenzter Lauf von {{decided}}, die bestanden haben oder fehlgeschlagen sind.',
  'insights.metric.scopedPassedOutOf_other':
    '{{count}} erfolgreiche eingegrenzte Läufe von {{decided}}, die bestanden haben oder fehlgeschlagen sind.',
  'insights.metric.avgDuration': 'Mittlere Dauer',
  'insights.metric.avgDurationDescription':
    'Durchschnittliche Laufzeit der abgeschlossenen Läufe im ausgewählten Bereich.',
  'insights.metric.flakeRate': 'Instabilitätsrate',
  'insights.metric.flakeRateDescription_one':
    '{{count}} fehlgeschlagener Lauf; reparierte und instabile Läufe werden getrennt erfasst.',
  'insights.metric.flakeRateDescription_other':
    '{{count}} fehlgeschlagene Läufe; reparierte und instabile Läufe werden getrennt erfasst.',
  'insights.passRate.title': 'Erfolgsquote',
  'insights.passRate.description': 'Verlauf der erfolgreichen Ergebnisse im ausgewählten Zeitraum.',
  'insights.duration.title': 'Dauer',
  'insights.duration.description': 'Durchschnittliche Laufdauer pro Tag im ausgewählten Zeitraum.',
  'insights.chart.passRate': 'Erfolgsquote',
  'insights.chart.duration': 'Dauer',
  'insights.breakdown.test': 'Test',
  'insights.breakdown.suite': 'Suite',
  'insights.breakdown.platform': 'Plattform',
  'insights.breakdown.testTitle': 'Aufschlüsselung nach Test',
  'insights.breakdown.suiteTitle': 'Aufschlüsselung nach Suite',
  'insights.breakdown.platformTitle': 'Aufschlüsselung nach Plattform',
  'insights.breakdown.description':
    'Vergleichen Sie die Zuverlässigkeit in einem eigenen Bereich weiter unten, damit die Übersicht des Zeitraums unverändert bleibt.',
  'insights.breakdown.refreshFailed':
    'Der Vergleich konnte nicht aktualisiert werden. Die vorherigen Ergebnisse werden angezeigt.',
  'insights.breakdown.updating': 'Vergleich wird aktualisiert',
  'insights.breakdown.comparison': 'Vergleich: {{label}}',
  'insights.breakdown.breakDownBy': 'Aufschlüsseln nach',
  'insights.breakdown.unavailable.title': 'Aufschlüsselung nicht verfügbar',
  'insights.breakdown.unavailable.description':
    'Laden Sie die Seite neu oder wählen Sie einen anderen Zeitraum, um den ausgewählten Vergleich neu zu laden.',
  'insights.breakdown.empty.test': 'Keine Testdaten in diesem Zeitraum',
  'insights.breakdown.empty.suite': 'Keine Suite-Daten in diesem Zeitraum',
  'insights.breakdown.empty.platform': 'Keine Plattformdaten in diesem Zeitraum',
  'insights.breakdown.empty.description':
    'Wählen Sie eine andere Aufschlüsselung oder einen größeren Zeitraum.',
  'insights.breakdown.column.runs': 'Läufe',
  'insights.breakdown.column.passed': 'Bestanden',
  'insights.breakdown.column.failed': 'Fehlgeschlagen',
  'insights.breakdown.column.passRate': 'Erfolgsquote',
  'insights.breakdown.column.flakeRate': 'Instabilitätsrate',
  'insights.breakdown.column.avgDuration': 'Mittlere Dauer',
  'insights.tokens.title': 'Token-Verbrauch',
  'insights.tokens.description':
    'Modellaktivität im ganzen Zeitraum, unabhängig von der gewählten Aufschlüsselung.',
  'insights.tokens.total': 'Tokens gesamt',
  'insights.tokens.input': 'Eingabe',
  'insights.tokens.output': 'Ausgabe',
  'insights.tokens.tooltipTotal': 'Gesamt',
  'insights.tokens.byModel': 'Nach Modell',
  'insights.tokens.activeModels_one': 'Eingabe und Ausgabe über {{count}} aktives Modell',
  'insights.tokens.activeModels_other': 'Eingabe und Ausgabe über {{count}} aktive Modelle',
  'insights.tokens.testRuns': 'Testläufe',
  'insights.tokens.liveEditor': 'Live-Editor',
  'insights.tokens.notRecorded': 'Nicht erfasst',
  'insights.tokens.unmeasuredSteps_one':
    '{{count}} Schritt eines Testlaufs hat keinen Token-Verbrauch erfasst und wird nicht mitgezählt.',
  'insights.tokens.unmeasuredSteps_other':
    '{{count}} Schritte von Testläufen haben keinen Token-Verbrauch erfasst und werden nicht mitgezählt.',
  'insights.tokens.empty.title': 'Kein Token-Verbrauch in diesem Zeitraum',
  'insights.tokens.empty.description':
    'Token-Kennzahlen erscheinen, sobald Läufe oder Live-Sitzungen das Modell aufrufen.',
  'insights.memory.title': 'Wissenskurator',
  'insights.memory.description':
    'Änderungen am Wissen, die die Kuratierung für die Läufe im ausgewählten Zeitraum erfasst hat.',
  'insights.memory.reading': 'Änderungen der Kuratierung für diesen Zeitraum werden gelesen.',
  'insights.memory.noAgentHost':
    'Die Änderungen der Kuratierung konnten nicht gelesen werden: Dieses Dashboard wurde ohne Agent-Host gestartet.',
  'insights.memory.unreadable':
    'Die Änderungen der Kuratierung für diesen Zeitraum konnten nicht gelesen werden. Laden Sie die Seite neu, um es erneut zu versuchen.',
  'insights.memory.empty.title': 'Keine Aktivität des Wissenskurators in diesem Zeitraum',
  'insights.memory.empty.description':
    'Wissenskennzahlen erscheinen, sobald Läufe Beobachtungen anlegen oder bestätigen.',
  'insights.memory.truncated_one':
    'Gezählt wurden die neuesten {{read}} von {{count}} Lauf in diesem Zeitraum; ältere Läufe wurden nicht gelesen.',
  'insights.memory.truncated_other':
    'Gezählt wurden die neuesten {{read}} von {{count}} Läufen in diesem Zeitraum; ältere Läufe wurden nicht gelesen.',
  'insights.memory.runsUnreadable_one':
    'Die Kuratierung von {{affected}} von {{count}} Lauf konnte nicht gelesen werden; seine Änderungen werden nicht mitgezählt.',
  'insights.memory.runsUnreadable_other':
    'Die Kuratierung von {{affected}} von {{count}} Läufen konnte nicht gelesen werden; ihre Änderungen werden nicht mitgezählt.',
  'insights.memory.curationFailed_one':
    'Die Kuratierung ist bei {{affected}} von {{count}} Lauf fehlgeschlagen; seine Änderungen werden nicht mitgezählt.',
  'insights.memory.curationFailed_other':
    'Die Kuratierung ist bei {{affected}} von {{count}} Läufen fehlgeschlagen; ihre Änderungen werden nicht mitgezählt.',
  'insights.memory.curationUnfinished_one':
    'Die Kuratierung von {{affected}} von {{count}} Lauf ist noch nicht abgeschlossen; seine Änderungen werden noch nicht mitgezählt.',
  'insights.memory.curationUnfinished_other':
    'Die Kuratierung von {{affected}} von {{count}} Läufen ist noch nicht abgeschlossen; ihre Änderungen werden noch nicht mitgezählt.',
  'insights.memory.inFlight_one':
    '{{count}} Lauf in diesem Zeitraum ist noch nicht abgeschlossen und wird nicht mitgezählt.',
  'insights.memory.inFlight_other':
    '{{count}} Läufe in diesem Zeitraum sind noch nicht abgeschlossen und werden nicht mitgezählt.',
  'insights.memory.changes': 'Änderungen',
  'insights.memory.runsRead': 'Gelesene Läufe',
  'insights.memory.runsReadValue': '{{read}} von {{total}}',
  'insights.memory.changeMix': 'Art der Änderungen',
  'insights.memory.kind.added': 'Hinzugefügt',
  'insights.memory.kind.confirmed': 'Bestätigt',
  'insights.memory.kind.promoted': 'Hochgestuft',
  'insights.memory.kind.superseded': 'Ersetzt',
  'insights.memory.kind.deprecated': 'Veraltet',
  'insights.memory.noChanges_one':
    'Keine Änderungen in dem {{count}} Lauf gefunden, dessen Kuratierung abgeschlossen ist.',
  'insights.memory.noChanges_other':
    'Keine Änderungen in den {{count}} Läufen gefunden, deren Kuratierung abgeschlossen ist.',
  'insights.memory.noFinishedCuration':
    'Kein Lauf in diesem Zeitraum hat eine abgeschlossene Kuratierung, die gezählt werden kann.',
} satisfies Translation<typeof en>
