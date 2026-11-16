import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'live.preview.loading': 'Verbindung zur Vorschau wird hergestellt …',
  'live.preview.delayed': 'Vorschau verzögert',
  'live.preview.reconnecting': 'Verbindung wird wiederhergestellt …',
  'live.preview.disconnected': 'Getrennt',
  'live.preview.expired': 'Link abgelaufen',
  'live.preview.sessionEnded': 'Sitzung beendet',
  'live.preview.runEnded': 'Lauf beendet',
  'live.preview.memberEnded': 'Dieser Test ist beendet, der Lauf geht weiter',
  'live.preview.unavailable': 'Die Live-Vorschau ist hier nicht verfügbar',
  'live.preview.noStream': 'keine Live-Vorschau für dieses Ziel – die Schrittliste läuft weiter',
  'live.preview.waitingGaveUp':
    'auf die Live-Ansicht gewartet, aber nichts kam an – die Schrittliste läuft weiter',
  'live.preview.waitingGaveUpLabel': 'aufgegeben',
  'live.preview.action.reconnect': 'Erneut verbinden',
  'live.preview.action.refresh': 'Aktualisieren',
  'live.preview.action.startFresh': 'Neu beginnen',
  'live.preview.dotName.green': 'Live-Vorschau in Ordnung',
  'live.preview.dotName.amber': 'Live-Vorschau verzögert',
  'live.preview.dotName.red': 'Live-Vorschau gestoppt',
  'live.preview.dotMeaning.green': 'Vom Browser kommen Bilder an.',
  'live.preview.dotMeaning.amber':
    'Das neueste Bild ist verspätet, oder die Vorschau verbindet sich neu.',
  'live.preview.dotMeaning.red': 'Die Vorschau empfängt keine Bilder mehr.',
  'live.preview.frameTitle': 'Live-Vorschau',
  'live.config.targetNotFound':
    'Das ausgewählte Ziel „{{name}}“ wurde in der Konfiguration des Arbeitsbereichs nicht gefunden',
  'live.config.webTargetMissingUrl': 'Dem ausgewählten Web-Ziel „{{name}}“ fehlt eine URL',
  'live.session.stepFailed': 'Schritt {{number}} fehlgeschlagen: {{error}}',
  'live.session.stepBusy': 'Schritt läuft bereits: {{step}}',
  'live.session.notReady': 'Die Live-Sitzung ist nicht bereit',
  'live.session.busyOrNotReady': 'Die Live-Sitzung ist beschäftigt oder nicht bereit',
  'live.pane.fallbackTitle': 'Live-Sitzung',
  'live.pane.draft.invalid': 'Entwurf ungültig',
  'live.pane.draft.saved': 'Gespeicherter Entwurf',
  'live.pane.draft.unsaved': 'Nicht gespeicherter Entwurf wird verwendet',
  'live.pane.runAll': 'Alle Schritte ausführen',
  'live.pane.stopAll': 'Alle Schritte stoppen',
  'live.pane.stopping': 'Wird gestoppt …',
  'live.pane.endSession': 'Live-Sitzung beenden',
  'live.pane.restartSession': 'Live-Sitzung neu starten',
  'live.pane.closeLiveMode': 'Live-Modus schließen',
  'live.pane.startFreshSession': 'Neue Sitzung starten',
  'live.pane.hooksStale':
    'Reihenfolge oder Namen der Hooks haben sich nach dem Start dieser Live-Sitzung geändert. Verwenden Sie die aktuelle Sitzung zum einmaligen Gebrauch weiter, oder starten Sie neu, um die neuesten Setup- und Teardown-Hooks anzuwenden.',
  'live.pane.signedOut':
    'Der Anmeldestatus „{{name}}“ für Ziel „{{target}}“ wurde nicht gefunden oder konnte nicht gelesen werden, daher startete diese Sitzung abgemeldet. Melden Sie sich hier an und verwenden Sie dann „Anmeldestatus speichern“, um ihn zu erfassen.',
  'live.pane.idleTitle': 'Der Live-Modus gilt für ein Ziel',
  'live.pane.idleDescription':
    'Diese Ansicht führt den aktuellen Entwurf des Baukastens auf dem ausgewählten Ziel aus. Sitzungen sind zum einmaligen Gebrauch, und Änderungen am Entwurf bleiben nur erhalten, wenn Sie den Test speichern.',
  'live.pane.connecting': 'Verbindung zum Browser wird hergestellt …',
  'live.pane.address.startUrl': 'Konfigurierte Start-URL',
  'live.pane.address.androidDevice': 'Android-Gerät',
  'live.pane.address.iosDevice': 'iOS-Gerät',
  'live.pane.address.back': 'Zurück',
  'live.pane.address.forward': 'Vorwärts',
  'live.pane.address.refresh': 'Seite neu laden',
  'live.pane.address.copy': 'URL kopieren',
  'live.pane.address.copied': 'URL kopiert',
  'live.pane.tab.reasoning': 'Begründung',
  'live.pane.tab.env': 'Umgebung',
  'live.pane.tab.network': 'Netzwerk',
  'live.pane.tab.console': 'Konsole',
  'live.pane.tab.aria': 'ARIA-Baum',
  'live.pane.hook.noVariables': 'Dieser Hook hat keine Variablen ausgegeben',
  'live.pane.hook.emittedVariables': 'Ausgegebene Variablen',
  'live.pane.hook.noOutputTitle': 'Noch keine Ausgabe von Hooks',
  'live.pane.hook.noOutputDescription':
    'Verbinden Sie eine Live-Sitzung, führen Sie einen Teardown-Hook aus oder beenden Sie die aktuelle Sitzung, um die Ausgabe der Hooks zu erfassen.',
  'live.pane.hook.withStatus': '{{name}} ({{status}})',
  'live.pane.test.setupHooks': 'Setup-Hooks',
  'live.pane.test.teardownHooks': 'Teardown-Hooks',
  'live.pane.test.noSetupHooks': 'Keine testeigenen Setup-Hooks',
  'live.pane.test.noTeardownHooks': 'Keine testeigenen Teardown-Hooks',
  'live.pane.test.steps': 'Schritte',
  'live.pane.test.stepNumber': 'Schritt #{{number}}',
  'live.pane.test.noStepDetail':
    'Dieser Test hat noch keine Details zu Live-Schritten erzeugt. Führen Sie ihn aus der Warteschlange aus, um Begründung, Konsole, Netzwerk und Ausgabe der Hooks zu untersuchen.',
  'live.pane.reasoning.selectTestDescription':
    'Wählen Sie einen Test in der Live-Warteschlange aus, um seine Begründung, Protokolle, Hooks und Netzwerkaktivität zu sehen.',
  'live.pane.reasoning.selectionGone': 'Die Auswahl ist nicht mehr verfügbar',
  'live.pane.reasoning.selectionGoneDescription':
    'Wählen Sie im Baukasten einen anderen Schritt aus, um seine Begründung zu untersuchen.',
  'live.pane.reasoning.empty': 'Noch keine Begründung',
  'live.pane.reasoning.emptyDescription':
    'Führen Sie einen Schritt aus dem Baukasten aus oder verwenden Sie „Alle Schritte ausführen“, um die Live-Begründung zu füllen.',
  'live.pane.selectTest': 'Wählen Sie einen Test aus, um ihn zu untersuchen',
  'live.pane.env.selectTestHook':
    'Wählen Sie einen testeigenen Hook aus oder führen Sie einen Schritt aus, um Variablen und die Ausgabe von runJS zu untersuchen',
  'live.pane.env.selectStep':
    'Wählen Sie einen Schritt aus, um Variablen und die Ausgabe von runJS zu untersuchen',
  'live.pane.network.hookInTest':
    'Hooks erfassen keine Netzwerkaktivität des Browsers. Wählen Sie einen Testschritt aus, um Anfragen zu untersuchen.',
  'live.pane.network.hook':
    'Hooks erfassen keine Netzwerkaktivität des Browsers. Wählen Sie einen Schritt aus, um Anfragen zu untersuchen.',
  'live.pane.network.runTest':
    'Führen Sie diesen Test aus, um seine Netzwerkaktivität zu untersuchen',
  'live.pane.network.selectStep':
    'Wählen Sie einen Schritt aus, um die Netzwerkaktivität zu untersuchen',
  'live.pane.console.runTest': 'Führen Sie diesen Test aus, um die Konsolenausgabe zu untersuchen',
  'live.pane.console.selectStep':
    'Wählen Sie einen Schritt aus, um die Konsolenausgabe zu untersuchen',
  'live.authState.save': 'Anmeldestatus speichern',
  'live.authState.replace': 'Anmeldestatus ersetzen',
  'live.authState.openForm': 'Formular zum Speichern des Anmeldestatus öffnen',
  'live.authState.description':
    'Erfasst die aktuelle Browsersitzung für dieses Ziel: Cookies, localStorage, IndexedDB und den sessionStorage der offenen Tabs.',
  'live.authState.target': 'Ziel',
  'live.authState.name': 'Name des Anmeldestatus',
  'live.authState.nameHint': 'Verwenden Sie Kleinbuchstaben, Ziffern und Bindestriche.',
  'live.authState.nameInvalid': 'Der Name des Anmeldestatus muss ein Slug in Kleinbuchstaben sein.',
  'live.authState.savedForTarget': 'Für dieses Ziel gespeichert',
  'live.authState.noneSaved': 'Für dieses Ziel sind keine Anmeldestatus gespeichert.',
  'live.authState.willReplace': 'Der vorhandene Anmeldestatus wird ersetzt.',
  'live.authState.saveFailed':
    'Anmeldestatus „{{name}}“ für Ziel „{{target}}“ konnte nicht gespeichert werden.',
  'live.run.title': 'Live-Lauf',
  'live.run.noRun': 'Kein Lauf ausgewählt',
  'live.run.noRunDescription': 'Wählen Sie einen Testlauf aus, um die Ausführung live zu verfolgen',
  'live.run.cancel': 'Abbrechen',
  'live.run.cancelling': 'Wird abgebrochen …',
  'live.run.cancelFailed': 'Lauf konnte nicht abgebrochen werden',
  'live.run.viewRunDetail': 'Details des Laufs ansehen',
  'live.run.ended': 'Lauf beendet',
  'live.run.over': 'Dieser Lauf ist vorbei – Details des Laufs ansehen',
  'live.run.metaUnavailable':
    'Details des Laufs nicht verfügbar – der Live-Stream ist davon nicht betroffen',
  'live.run.gapMarker_one':
    '{{count}} Ereignis verpasst (Sequenz {{from}}–{{to}}) – siehe Details des Laufs',
  'live.run.gapMarker_other':
    '{{count}} Ereignisse verpasst (Sequenz {{from}}–{{to}}) – siehe Details des Laufs',
  'live.run.remoteProgress': 'Remote {{remote}}: {{message}}',
  'live.run.remoteProgressPercent': 'Remote {{remote}}: {{message}} {{percent}}',
  'live.run.testFallback': 'Test {{number}}',
  'live.steps.empty': 'Warten auf den ersten Schritt',
  'live.steps.memberFallback': 'Mitglied {{number}}',
} satisfies Translation<typeof en>
