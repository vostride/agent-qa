import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'evidence.loading': 'Aufzeichnungen werden geladen',
  'evidence.incompleteExplanation':
    'Belege unvollständig – sie wurden aufgezeichnet, aber die gespeicherte Datei ist nicht mehr auf dem Datenträger.',
  'evidence.recordedOnStep': 'In Schritt {{step}} aufgezeichnet',
  'evidence.explanationWithStep': '{{explanation}} {{step}}',
  'evidence.goToStep': 'Zu Schritt {{step}} wechseln',

  'evidence.retry.variables': 'Variablen erneut laden',
  'evidence.retry.network': 'Netzwerkaufzeichnungen erneut laden',
  'evidence.retry.console': 'Konsolenaufzeichnungen erneut laden',
  'evidence.retry.aria': 'ARIA-Baum erneut laden',
  'evidence.retry.a11y': 'Ergebnisse zur Barrierefreiheit erneut laden',
  'evidence.retry.video': 'Aufzeichnung erneut laden',
  'evidence.retry.frame': 'Screenshot erneut laden',

  'evidence.variables.empty.title': 'Keine Variablen in diesem Schritt',
  'evidence.variables.empty.explanation':
    'Bei der Ausführung dieses Schritts waren keine Variablen gesetzt.',
  'evidence.variables.notCaptured.title': 'Variablen für diesen Schritt nicht aufgezeichnet',
  'evidence.variables.notCaptured.explanation':
    'Für diesen Schritt wurde keine Momentaufnahme der Variablen gespeichert.',
  'evidence.variables.unsupported.title':
    'Variablen werden auf dieser Plattform nicht aufgezeichnet',
  'evidence.variables.unsupported.explanation':
    'Die Plattform dieses Laufs kann keine Momentaufnahme der Variablen speichern.',
  'evidence.variables.unavailable.title': 'Variablen für diesen Lauf nicht verfügbar',
  'evidence.variables.unavailable.explanation':
    'Bei diesem Lauf wurden keine Variablen aufgezeichnet, daher gibt es nichts anzuzeigen.',
  'evidence.variables.failed.capture.title': 'Erfassung der Variablen fehlgeschlagen',
  'evidence.variables.failed.capture.explanation':
    'Die Momentaufnahme der Variablen konnte während des Laufs nicht gespeichert werden. Es gibt nichts, das erneut versucht werden kann.',
  'evidence.variables.failed.load.title': 'Variablen konnten nicht geladen werden',
  'evidence.variables.failed.load.explanation':
    'Die Variablen wurden aufgezeichnet, aber nicht geladen.',
  'evidence.variables.noSelection.title': 'Kein Schritt ausgewählt',
  'evidence.variables.noSelection.explanation':
    'Variablen werden pro Schritt angezeigt. Wählen Sie einen Schritt im Baum oder auf der Zeitleiste aus, um sie zu sehen.',

  'evidence.network.empty.title': 'Keine Netzwerkanfragen',
  'evidence.network.empty.explanation': 'Die Seite hat in diesem Schritt keine Anfragen gestellt.',
  'evidence.network.notCaptured.title': 'Netzwerk für diesen Schritt nicht aufgezeichnet',
  'evidence.network.notCaptured.explanation':
    'Für diesen Schritt wurde keine Netzwerkaktivität gespeichert.',
  'evidence.network.unsupported.title': 'Netzwerk wird auf dieser Plattform nicht aufgezeichnet',
  'evidence.network.unsupported.explanation':
    'Die Plattform dieses Laufs kann keine Netzwerkanfragen erfassen.',
  'evidence.network.unavailable.title': 'Netzwerk für diesen Lauf nicht verfügbar',
  'evidence.network.unavailable.explanation':
    'Bei diesem Lauf wurde keine Netzwerkaktivität aufgezeichnet. Das heißt nicht, dass der Lauf keine Anfragen gestellt hat.',
  'evidence.network.failed.capture.title': 'Erfassung des Netzwerks fehlgeschlagen',
  'evidence.network.failed.capture.explanation':
    'Die Netzwerkaktivität konnte während des Laufs nicht erfasst werden. Es gibt nichts, das erneut versucht werden kann.',
  'evidence.network.failed.load.title': 'Netzwerkaufzeichnungen konnten nicht geladen werden',
  'evidence.network.failed.load.explanation':
    'Die Aufzeichnungen sind vorhanden, wurden aber nicht geladen.',
  'evidence.network.noSelection.title': 'Kein Schritt ausgewählt',
  'evidence.network.noSelection.explanation':
    'Netzwerkanfragen werden pro Schritt angezeigt. Wählen Sie einen Schritt im Baum oder auf der Zeitleiste aus, um sie zu sehen.',

  'evidence.console.empty.title': 'Keine Konsolenausgabe',
  'evidence.console.empty.explanation': 'Die Seite hat in diesem Schritt nichts protokolliert.',
  'evidence.console.notCaptured.title': 'Konsole für diesen Schritt nicht aufgezeichnet',
  'evidence.console.notCaptured.explanation':
    'Für diesen Schritt wurde keine Konsolenausgabe gespeichert.',
  'evidence.console.unsupported.title': 'Konsole wird auf dieser Plattform nicht aufgezeichnet',
  'evidence.console.unsupported.explanation':
    'Die Plattform dieses Laufs kann keine Konsolenausgabe erfassen.',
  'evidence.console.unavailable.title': 'Konsole für diesen Lauf nicht verfügbar',
  'evidence.console.unavailable.explanation':
    'Bei diesem Lauf wurde keine Konsolenausgabe aufgezeichnet. Das heißt nicht, dass die Seite nichts protokolliert hat.',
  'evidence.console.failed.capture.title': 'Erfassung der Konsole fehlgeschlagen',
  'evidence.console.failed.capture.explanation':
    'Die Konsolenausgabe konnte während des Laufs nicht erfasst werden. Es gibt nichts, das erneut versucht werden kann.',
  'evidence.console.failed.load.title': 'Konsolenaufzeichnungen konnten nicht geladen werden',
  'evidence.console.failed.load.explanation':
    'Die Aufzeichnungen sind vorhanden, wurden aber nicht geladen.',
  'evidence.console.noSelection.title': 'Kein Schritt ausgewählt',
  'evidence.console.noSelection.explanation':
    'Die Konsolenausgabe wird pro Schritt angezeigt. Wählen Sie einen Schritt im Baum oder auf der Zeitleiste aus, um sie zu sehen.',

  'evidence.aria.empty.title': 'Leerer Barrierefreiheitsbaum',
  'evidence.aria.empty.explanation':
    'Der Bildschirm bot keine zugänglichen Elemente, als über diese Aktion entschieden wurde.',
  'evidence.aria.notCaptured.title': 'ARIA-Baum für diese Aktion nicht aufgezeichnet',
  'evidence.aria.notCaptured.explanation':
    'Für diese Unteraktion wurde kein Barrierefreiheitsbaum gespeichert.',
  'evidence.aria.unsupported.title': 'ARIA-Baum wird auf dieser Plattform nicht aufgezeichnet',
  'evidence.aria.unsupported.explanation':
    'Die Plattform dieses Laufs kann keinen Barrierefreiheitsbaum erfassen.',
  'evidence.aria.unavailable.title': 'ARIA-Baum für diesen Lauf nicht verfügbar',
  'evidence.aria.unavailable.explanation':
    'Bei diesem Lauf wurde kein Barrierefreiheitsbaum aufgezeichnet.',
  'evidence.aria.failed.capture.title': 'Erfassung des ARIA-Baums fehlgeschlagen',
  'evidence.aria.failed.capture.explanation':
    'Der Barrierefreiheitsbaum konnte während des Laufs nicht erfasst werden. Es gibt nichts, das erneut versucht werden kann.',
  'evidence.aria.failed.load.title': 'ARIA-Baum konnte nicht geladen werden',
  'evidence.aria.failed.load.explanation': 'Der Baum wurde aufgezeichnet, aber nicht geladen.',
  'evidence.aria.noSelection.title': 'Keine Unteraktion ausgewählt',
  'evidence.aria.noSelection.explanation':
    'Der Barrierefreiheitsbaum wird pro Unteraktion angezeigt. Wählen Sie eine Unteraktion im Baum oder auf der Zeitleiste aus, um zu sehen, was das Modell gesehen hat.',

  'evidence.a11y.empty.title': 'Keine Verstöße gegen die Barrierefreiheit gefunden',
  'evidence.a11y.empty.explanation':
    'Die Prüfungen liefen in diesem Schritt und fanden nichts, was zu beheben ist.',
  'evidence.a11y.notCaptured.title':
    'Prüfungen der Barrierefreiheit für diesen Schritt nicht aufgezeichnet',
  'evidence.a11y.notCaptured.explanation':
    'Für diesen Schritt wurden keine Ergebnisse zur Barrierefreiheit gespeichert.',
  'evidence.a11y.unsupported.title':
    'Prüfungen der Barrierefreiheit werden auf dieser Plattform nicht unterstützt',
  'evidence.a11y.unsupported.explanation':
    'Die Plattform dieses Laufs kann keine Prüfungen der Barrierefreiheit ausführen.',
  'evidence.a11y.unavailable.title':
    'Ergebnisse zur Barrierefreiheit für diesen Lauf nicht verfügbar',
  'evidence.a11y.unavailable.explanation':
    'Bei diesem Lauf wurden keine Prüfungen der Barrierefreiheit aufgezeichnet. Das heißt nicht, dass der Lauf keine Verstöße hatte.',
  'evidence.a11y.failed.capture.title':
    'Prüfungen der Barrierefreiheit konnten nicht ausgeführt werden',
  'evidence.a11y.failed.capture.explanation':
    'Bei den Prüfungen trat während des Laufs ein Fehler auf, daher gibt es keine Ergebnisse. Es gibt nichts, das erneut versucht werden kann.',
  'evidence.a11y.failed.load.title': 'Ergebnisse zur Barrierefreiheit konnten nicht geladen werden',
  'evidence.a11y.failed.load.explanation':
    'Die Ergebnisse sind vorhanden, wurden aber nicht geladen.',
  'evidence.a11y.noSelection.title': 'Kein Schritt ausgewählt',
  'evidence.a11y.noSelection.explanation':
    'Ergebnisse zur Barrierefreiheit werden pro Schritt angezeigt. Wählen Sie einen Schritt im Baum oder auf der Zeitleiste aus, um sie zu sehen.',

  'evidence.video.empty.title': 'Aufzeichnung enthält kein Video',
  'evidence.video.empty.explanation':
    'Für diesen Test wurde eine Aufzeichnung gespeichert, aber sie enthält nichts zum Abspielen.',
  'evidence.video.notCaptured.title': 'Keine Aufzeichnung für diesen Test',
  'evidence.video.notCaptured.explanation':
    'Für diesen Test wurde kein Video gespeichert. Die Einzelbilder zeigen weiterhin, was das Modell bei jeder Entscheidung gesehen hat.',
  'evidence.video.unsupported.title': 'Aufzeichnung wird auf dieser Plattform nicht unterstützt',
  'evidence.video.unsupported.explanation':
    'Die Plattform dieses Laufs zeichnet kein Video auf. Die Einzelbilder zeigen weiterhin, was das Modell bei jeder Entscheidung gesehen hat.',
  'evidence.video.unavailable.title': 'Aufzeichnung für diesen Lauf nicht verfügbar',
  'evidence.video.unavailable.explanation':
    'Bei diesem Lauf wurde kein Video aufgezeichnet. Die Einzelbilder zeigen weiterhin, was das Modell bei jeder Entscheidung gesehen hat.',
  'evidence.video.failed.capture.title': 'Aufzeichnung fehlgeschlagen',
  'evidence.video.failed.capture.explanation':
    'Das Video konnte am Ende dieses Tests nicht gespeichert werden. Es gibt nichts, das erneut versucht werden kann. Die Einzelbilder zeigen weiterhin, was das Modell bei jeder Entscheidung gesehen hat.',
  'evidence.video.failed.load.title': 'Aufzeichnung konnte nicht geladen werden',
  'evidence.video.failed.load.explanation':
    'Die Aufzeichnung ist vorhanden, wurde aber nicht geladen. Versuchen Sie es erneut oder wechseln Sie zu den Einzelbildern.',
  'evidence.video.noSelection.title': 'Kein Schritt ausgewählt',
  'evidence.video.noSelection.explanation':
    'Die Aufzeichnung folgt der Zeitleiste. Wählen Sie einen Schritt im Baum oder auf der Zeitleiste aus, um zu ihm zu springen.',

  'evidence.frame.notCaptured.subAction.title': 'Kein Screenshot für diese Aktion',
  'evidence.frame.notCaptured.subAction.explanation':
    'Für diese Unteraktion wurde kein Screenshot gespeichert.',
  'evidence.frame.notCaptured.step.title': 'Keine Screenshots für diesen Schritt',
  'evidence.frame.notCaptured.step.explanation':
    'Keine Unteraktion dieses Schritts hat einen Screenshot gespeichert.',
  'evidence.frame.unavailable.title': 'Screenshot nicht verfügbar',
  'evidence.frame.failed.load.title': 'Screenshot konnte nicht geladen werden',
  'evidence.frame.failed.load.explanation':
    'Der Screenshot ist vorhanden, wurde aber nicht geladen.',

  'evidence.tab.variables': 'Variablen',
  'evidence.tab.network': 'Netzwerk',
  'evidence.tab.console': 'Konsole',
  'evidence.tab.aria': 'ARIA-Baum',
  'evidence.tab.a11y': 'A11y',
  'evidence.trigger.variables': 'Variablen, {{number}}',
  'evidence.trigger.aria': 'ARIA-Baum, {{number}}',
  'evidence.trigger.consoleErrors_one': 'Konsole, {{count}} Fehler',
  'evidence.trigger.consoleErrors_other': 'Konsole, {{count}} Fehler',
  'evidence.trigger.consoleMessages_one': 'Konsole, {{count}} Meldung',
  'evidence.trigger.consoleMessages_other': 'Konsole, {{count}} Meldungen',
  'evidence.trigger.networkFailed_one': 'Netzwerk, {{count}} fehlgeschlagene Anfrage',
  'evidence.trigger.networkFailed_other': 'Netzwerk, {{count}} fehlgeschlagene Anfragen',
  'evidence.trigger.networkRequests_one': 'Netzwerk, {{count}} Anfrage',
  'evidence.trigger.networkRequests_other': 'Netzwerk, {{count}} Anfragen',
  'evidence.trigger.a11yViolations_one': 'A11y, {{count}} Verstoß',
  'evidence.trigger.a11yViolations_other': 'A11y, {{count}} Verstöße',
  'evidence.trigger.absent': '{{tab}} – {{title}}',
  'evidence.signal.console_one': '{{count}} Konsolenfehler in Schritt {{step}} – Konsole öffnen',
  'evidence.signal.console_other': '{{count}} Konsolenfehler in Schritt {{step}} – Konsole öffnen',
  'evidence.signal.network_one':
    '{{count}} fehlgeschlagene Anfrage in Schritt {{step}} – Netzwerk öffnen',
  'evidence.signal.network_other':
    '{{count}} fehlgeschlagene Anfragen in Schritt {{step}} – Netzwerk öffnen',
  'evidence.signal.a11y_one':
    '{{count}} Verstoß gegen die Barrierefreiheit in Schritt {{step}} – A11y öffnen',
  'evidence.signal.a11y_other':
    '{{count}} Verstöße gegen die Barrierefreiheit in Schritt {{step}} – A11y öffnen',

  'evidence.drawer.test': 'Test',
  'evidence.drawer.config': 'Konfiguration',
  'evidence.drawer.testAsWritten': 'Test wie geschrieben',
  'evidence.drawer.resolvedDefinition': 'Aufgelöste Definition',
  'evidence.drawer.suiteMembers': 'Mitglieder der Suite',
  'evidence.drawer.runTests': 'Tests in diesem Lauf',
  'evidence.drawer.runAttributes': 'Attribute des Laufs',
  'evidence.drawer.effectiveConfig': 'Wirksame Konfiguration',
  'evidence.drawer.globalConfigAsWritten': 'Globale Konfiguration wie geschrieben',
  'evidence.drawer.model': 'Modell',
  'evidence.drawer.runtime': 'Laufzeit',
  'evidence.drawer.errors': 'Fehler',
  'evidence.drawer.notCaptured': 'Nicht erfasst',
  'evidence.drawer.configNotCaptured': 'Konfiguration nicht erfasst',
  'evidence.drawer.unsealedCapture':
    'Die Erfassung der Einrichtung dieses Laufs wurde nicht abgeschlossen, daher können der hier gezeigte Test und die Konfiguration unvollständig sein.',
  'evidence.drawer.technicalDetails': 'Technische Details',
  'evidence.drawer.runId': 'Lauf-ID',
  'evidence.drawer.artifactKind': 'Art des Artefakts',
  'evidence.drawer.schemaVersion': 'Schemaversion',
  'evidence.drawer.captureSealedAt': 'Erfassung abgeschlossen am',
  'evidence.drawer.copyRunId': 'Lauf-ID kopieren',
  'evidence.drawer.retry': 'Details des Laufs erneut laden',
  'evidence.drawer.ranHere': 'Auf diesem Rechner ausgeführt',
  'evidence.drawer.ranHereOn': 'Auf diesem Rechner ausgeführt, {{deviceType}}',
  'evidence.drawer.deviceType.simulator': 'Simulator',
  'evidence.drawer.deviceType.realDevice': 'echtes Gerät',
  'evidence.drawer.opensInNewTab': '(öffnet sich in einem neuen Tab)',
  'evidence.drawer.remote': '{{name}} ({{where}})',
  'evidence.drawer.ranOn': 'Auf {{remote}} ausgeführt',
  'evidence.drawer.ranOnVersion': 'Auf {{remote}} ausgeführt, {{version}}',
  'evidence.drawer.lostOn': 'Auf {{remote}} ausgeführt, bis die Verbindung abbrach',
  'evidence.drawer.lostOnVersion':
    'Auf {{remote}} ausgeführt, {{version}}, bis die Verbindung abbrach',
  'evidence.drawer.endedOn': 'Auf {{remote}} ausgeführt, bis der Remote die Sitzung beendete',
  'evidence.drawer.endedOnVersion':
    'Auf {{remote}} ausgeführt, {{version}}, bis der Remote die Sitzung beendete',
  'evidence.drawer.couldNotRun': 'Ausführung auf {{remote}} nicht möglich: {{reason}}',
  'evidence.drawer.sessionRefused': 'Sitzung abgelehnt',
  'evidence.drawer.plugin': 'Plugin {{entry}}',
  'evidence.drawer.pluginSource': 'Plugin {{entry}} ({{source}})',
  'evidence.drawer.sessionPage': 'Sitzungsseite',
  'evidence.drawer.kind.test': 'Test',
  'evidence.drawer.kind.unknown': 'Nicht aufgezeichnet',
  'evidence.drawer.titleFallback': 'Lauf {{id}}',

  'evidence.scope.step': 'Schritt {{step}} von {{total}} · ganzer Schritt',
  'evidence.scope.subAction': 'Unteraktion #{{number}} von {{total}} · Schritt {{step}}',

  'evidence.artifact.loadingLabel': 'Artefaktdaten werden geladen',
  'evidence.artifact.loading': 'Artefaktdaten werden geladen …',
  'evidence.artifact.loadFailed': 'Artefaktdaten konnten nicht geladen werden',
  'evidence.artifact.loadFailedHelp':
    'Wiederholen Sie die Anfrage. Wenn der Fehler bleibt, prüfen Sie, ob der Dashboard-Server die Artefakte der Läufe lesen kann.',
  'evidence.artifact.missing': 'Für diesen Lauf sind keine Artefaktdaten verfügbar',
  'evidence.artifact.missingHelp': 'Für diesen Lauf wurde kein Artefakteintrag gespeichert.',
  'evidence.artifact.none': 'Keine',
  'evidence.artifact.items_one': '{{count}} Eintrag',
  'evidence.artifact.items_other': '{{count}} Einträge',
  'evidence.artifact.fields_one': '{{count}} Feld',
  'evidence.artifact.fields_other': '{{count}} Felder',
  'evidence.artifact.sectionNotCaptured': '{{section}} wurde für diesen Lauf nicht erfasst.',
  'evidence.artifact.unnamedMember': 'Unbenanntes Mitglied',
  'evidence.artifact.testId': 'Test-ID',
  'evidence.artifact.ref': 'Referenz',
  'evidence.artifact.refId': 'Referenz-ID',
  'evidence.artifact.path': 'Pfad',
  'evidence.artifact.target': 'Ziel',
  'evidence.artifact.childRun': 'Unterlauf',
  'evidence.artifact.error': 'Fehler',
  'evidence.artifact.ranAgainst': 'Ausgeführt auf',
  'evidence.artifact.memberSnapshots': 'Momentaufnahmen der Mitglieder',
  'evidence.artifact.rawTestYaml': 'Rohes Test-YAML',
  'evidence.artifact.rawMemberYaml': 'Rohes YAML des Mitglieds',
  'evidence.artifact.rawSuiteYaml': 'Rohes Suite-YAML',
  'evidence.artifact.rawGlobalConfig': 'Rohe globale Konfiguration',
  'evidence.artifact.noAttributes': 'Keine Attribute des Laufs',
  'evidence.artifact.noAttributesHelp': 'Dieser Lauf hat keine Attribute aufgezeichnet.',
  'evidence.artifact.copyJson': 'JSON kopieren',
  'evidence.artifact.copyNamedValue': 'Wert von {{key}} kopieren',
  'evidence.artifact.copyValue': 'Wert kopieren',
} satisfies Translation<typeof en>
