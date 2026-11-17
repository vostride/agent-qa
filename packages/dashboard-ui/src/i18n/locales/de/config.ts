import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'config.tabs.models': 'Modelle',
  'config.tabs.targets': 'Ziele',
  'config.tabs.execution': 'Ausführung',
  'config.tabs.project': 'Projekt',
  'config.tabs.advanced': 'Erweitert',
  'config.sections.models': 'Modelle',
  'config.sections.screenshotSize': 'Screenshot-Größe',
  'config.sections.plannerLimits': 'Grenzen des Planers',
  'config.sections.targets': 'Ziele',
  'config.sections.remotes': 'Remotes',
  'config.sections.devices': 'Geräte',
  'config.sections.loginStates': 'Gespeicherte Anmeldestatus',
  'config.sections.mobileAppState': 'App-Zustand auf Mobilgeräten',
  'config.sections.browser': 'Browser',
  'config.sections.timeouts': 'Timeouts',
  'config.sections.runs': 'Parallele Läufe',
  'config.sections.cache': 'Cache',
  'config.sections.recording': 'Aufzeichnung',
  'config.sections.accessibility': 'Barrierefreiheit',
  'config.sections.logCapture': 'Protokollerfassung',
  'config.sections.testDiscovery': 'Testerkennung',
  'config.sections.files': 'Hook-, Umgebungs- und Secrets-Dateien',
  'config.sections.knowledge': 'Wissensspeicher',
  'config.sections.dashboard': 'Dashboard',
  'config.sections.logging': 'Protokollierung',
  'config.sections.passRateScope': 'Umfang der Erfolgsquote',
  'config.sections.mcp': 'MCP-Zugriff',
  'config.sections.configFile': 'Konfigurationsdatei',
  'config.saveStatus.saving': 'Wird gespeichert …',
  'config.saveStatus.saved': 'Gespeichert',
  'config.saveStatus.draft': 'Nicht gespeichert',
  'config.saveStatus.failed': 'Speichern fehlgeschlagen',
  'config.modelStatus.signedIn': 'Angemeldet',
  'config.modelStatus.keySaved': 'Schlüssel gespeichert',
  'config.modelStatus.notConnected': 'Nicht verbunden',
  'config.modelStatus.signInExpired': 'Anmeldung abgelaufen',
  'config.providerFallback.openaiCompatible': 'OpenAI-kompatibel',
  'config.providerFallback.anthropicCompatible': 'Anthropic-kompatibel',
  'config.providerFallback.openaiSubscription': 'ChatGPT-Abo',
  'config.providerFallback.anthropicSubscription': 'Claude-Abo',
  'config.fixedConnection.openaiSubscription': 'Ihr ChatGPT-Abo',
  'config.fixedConnection.anthropicSubscription': 'Ihr Claude-Abo',
  'config.fixedConnection.openaiCompatible': 'einen OpenAI-kompatiblen API-Schlüssel',
  'config.fixedConnection.anthropicCompatible':
    'einen Anthropic-kompatiblen Schlüssel oder Token',
  'config.fixedConnection.gemini': 'einen Gemini-API-Schlüssel',
  'config.modelSetting.vision': 'Bildverarbeitung',
  'config.modelSetting.contextWindow': 'Kontextfenster',
  'config.modelSettingHelp.vision':
    'Ob dieses Modell Screenshots lesen kann. Schalten Sie es bei reinen Textmodellen aus.',
  'config.modelSettingHelp.contextWindow':
    'Eine Größe wie 256k. Leer lassen, um sie automatisch zu erkennen.',
  'config.headerField.name': 'Name',
  'config.headerField.value': 'Wert',
  'config.testResult.testing': 'Verbindung wird getestet …',
  'config.testResult.connected': 'Verbunden',
  'config.testResult.connectedWithoutKey': 'Ohne Schlüssel verbunden',
  'config.connectionChoice.chatgptSignIn': 'Mit ChatGPT anmelden',
  'config.connectionChoice.claudeSignIn': 'Mit Claude anmelden',
  'config.connectionChoice.openaiCompatibleKey': 'OpenAI-kompatibler API-Schlüssel',
  'config.connectionChoice.anthropicCompatibleKey': 'Anthropic-kompatibler Schlüssel oder Token',
  'config.connectionChoice.geminiKey': 'Gemini-API-Schlüssel',
  'config.connectionChoiceHints.chatgptSignIn':
    'Verwendet Ihr ChatGPT-Abo. Kein Schlüssel erforderlich.',
  'config.connectionChoiceHints.claudeSignIn':
    'Verwendet Ihr Claude-Abo. Kein Schlüssel erforderlich.',
  'config.connectionChoiceHints.openaiCompatibleKey':
    'OpenAI oder ein beliebiger Endpunkt, der dessen API spricht.',
  'config.connectionChoiceHints.anthropicCompatibleKey':
    'Anthropic oder ein beliebiger Endpunkt, der dessen API spricht.',
  'config.connectionChoiceHints.geminiKey': 'Ein Schlüssel aus Google AI Studio.',
  'config.addFlowField.baseUrl': 'Basis-URL',
  'config.addFlowField.model': 'Modell',
  'config.addFlowField.apiKey': 'API-Schlüssel',
  'config.addFlowField.keyType': 'Art des Schlüssels',
  'config.addFlowField.key': 'Schlüssel',
  'config.addFlowField.token': 'Token',
  'config.addFlowField.headers': 'Header',
  'config.addFlowField.name': 'Name',
  'config.addFlowField.signInCode': 'Code von der Anmeldeseite',
  'config.keyType.apiKey': 'API-Schlüssel',
  'config.keyType.bearerToken': 'Bearer-Token',
  'config.connectRefusal.invalidSetupInput': 'Prüfen Sie das Modell und die Basis-URL.',
  'config.connectRefusal.nameTaken': 'Ein anderes Modell verwendet diesen Namen bereits.',
  'config.connectRefusal.credentialProviderConflict':
    'Unter diesem Namen ist ein Schlüssel für eine andere Verbindung gespeichert. Wählen Sie einen anderen Namen.',
  'config.connectRefusal.credentialNotAccepted':
    'Diese Verbindung akzeptiert diese Art von Schlüssel nicht.',
  'config.connectRefusal.credentialExists':
    'Ein anderer gespeicherter Schlüssel verwendet diesen Namen bereits.',
  'config.connectRefusal.validationFailed':
    'Die Konfigurationsdatei hat ein Problem, das zuerst behoben werden muss.',
  'config.connectRefusal.fileInvalid':
    'Die Konfigurationsdatei lässt sich nicht einlesen. Korrigieren Sie sie in Ihrem Editor und verbinden Sie dann erneut.',
  'config.connectRefusal.crossSiteRefused':
    'Diese Seite darf die Konfiguration nicht ändern.',
  'config.applyConsequences.knowledgeDir':
    'Neue Läufe und Agenten verwenden den neuen Ordner sofort; ein laufender agent-qa-Daemon wechselt beim nächsten Neustart. Im aktuellen Ordner wird nichts verschoben oder gelöscht.',
  'config.applyConsequences.dbPath':
    'Das Dashboard öffnet die neue Datenbank beim nächsten Neustart, und die Läufe der aktuellen Datenbank werden erst wieder angezeigt, wenn Sie zurückwechseln. Nichts wird verschoben oder gelöscht.',
  'config.applyConsequences.artifactsDir':
    'Neue Läufe schreiben ihre Arbeitsgedächtnis-Datei in den neuen Ordner. Frühere Läufe werden weiterhin angezeigt, und nichts wird verschoben oder gelöscht.',
  'config.knowledgeField.dir': 'Wissensordner',
  'config.knowledgeFieldHelp.dir': 'Ein Ordner in diesem Repository.',
  'config.dashboardField.port': 'Port',
  'config.dashboardField.host': 'Host',
  'config.dashboardField.dbPath': 'Datenbankdatei',
  'config.dashboardField.artifactsDir': 'Artefaktordner',
  'config.dashboardField.baseUrl': 'Adresse des Dashboards',
  'config.dashboardField.workspace': 'Name des Arbeitsbereichs',
  'config.dashboardFieldHelp.host':
    'Muss eine Adresse auf diesem Rechner sein. Wird nach einem Neustart des Dashboards wirksam.',
  'config.dashboardFieldHelp.baseUrl':
    'Links zu Tests und Läufen in Antworten von Agenten beginnen mit dieser Adresse. Sie brauchen außerdem einen Namen des Arbeitsbereichs.',
  'config.dashboardFieldHelp.workspace': 'Benennt dieses Projekt in diesen Links.',
  'config.testDiscoveryField.testMatch': 'Testdateien',
  'config.testDiscoveryField.suiteMatch': 'Suite-Dateien',
  'config.testDiscoveryField.testPathIgnore': 'Zu überspringende Pfade',
  'config.testDiscoveryFieldHelp.testMatch':
    'Ein Glob-Muster pro Zeile. Eine Datei, die zu einem davon passt, ist ein Test.',
  'config.testDiscoveryFieldHelp.suiteMatch':
    'Ein Glob-Muster pro Zeile. Eine Datei, die zu einem davon passt, ist eine Suite.',
  'config.testDiscoveryFieldHelp.testPathIgnore':
    'Ein Glob-Muster pro Zeile. Passende Dateien werden nie als Tests erkannt.',
  'config.filesField.hooksFile': 'Hook-Datei',
  'config.filesField.envFile': 'Umgebungsdatei',
  'config.filesField.secretsFile': 'Secrets-Datei',
  'config.filesFieldHelp.hooksFile': 'Das gemeinsame Hook-Modul für Tests und Suiten.',
  'config.filesFieldHelp.envFile': 'Eine dotenv-Datei, die vor dem Start von Läufen geladen wird.',
  'config.filesFieldHelp.secretsFile':
    'Eine Datei im dotenv-Format für Secrets, die nur laufende Tests lesen. Ihre Werte werden als [secret:<name>] angezeigt und nie wiederhergestellt; sonst wird nichts maskiert.',
  'config.loggingField.level': 'Protokollstufe',
  'config.loggingFieldHelp.level':
    'Wie viele Details ein Lauf ausgibt. Die eigene Option eines Befehls hat Vorrang.',
  'config.loggingLevel.silent': 'Still',
  'config.loggingLevel.error': 'Fehler',
  'config.loggingLevel.warn': 'Warnung',
  'config.loggingLevel.info': 'Info',
  'config.loggingLevel.debug': 'Debug',
  'config.attributeField.key': 'Attribut',
  'config.attributeField.value': 'Wert',
  'config.privacyField.privacy': 'Nutzungsdaten und Fehlerberichte ausschalten',
  'config.privacyFieldHelp.privacy':
    'Wenn eingeschaltet, sendet agent-qa aus diesem Projekt keine Nutzungsdaten und keine Fehlerberichte. Fehlerberichte enthalten dieselbe anonyme ID und dieselben Eigenschaften wie die Nutzungsdaten.',
  'config.browserField.name': 'Browser',
  'config.browserField.headless': 'Headless',
  'config.browserField.viewportWidth': 'Breite des Viewports',
  'config.browserField.viewportHeight': 'Höhe des Viewports',
  'config.visionField.screenshotSize': 'Größter Screenshot',
  'config.visionField.effectiveResolution': 'Längste Kante in Pixeln',
  'config.visionFieldHelp.screenshotSize':
    'Die maximale Größe eines Screenshots, der an ein Modell mit Bildverarbeitung gesendet wird, etwa 256k. Leer sendet ihn unkomprimiert.',
  'config.visionFieldHelp.effectiveResolution':
    'Screenshots werden so skaliert, dass ihre längste Kante in diese Anzahl Pixel passt.',
  'config.plannerField.maxActions': 'Höchstzahl an Aktionen pro Schritt',
  'config.plannerField.maxPlanningTurns': 'Höchstzahl an Planeraufrufen pro Schritt',
  'config.plannerField.previousStepCount': 'Frühere Schritte, die der Planer sieht',
  'config.plannerFieldHelp.maxActions':
    'Jeder Schritt darf so viele Aktionen ausführen; braucht er eine weitere, endet er mit der Begründung, dass die Grenze erreicht ist. Standard: 30.',
  'config.plannerFieldHelp.maxPlanningTurns':
    'Jeder Schritt darf das Planermodell so oft aufrufen; braucht er einen weiteren Aufruf, endet er mit der Begründung, dass die Grenze erreicht ist. Standard: 30.',
  'config.plannerFieldHelp.previousStepCount':
    'Wie viele frühere Schritte der Planer liest, bevor er den nächsten plant.',
  'config.timeoutField.step': 'Timeout pro Schritt',
  'config.timeoutField.test': 'Timeout pro Test',
  'config.timeoutField.navigation': 'Timeout für Navigation',
  'config.timeoutFieldHelp.navigation':
    'Wie lange das Laden einer Webseite oder das Warten auf eine URL dauern darf. Standard: 2m. Android- und iOS-Läufe verwenden es nicht.',
  'config.runsField.parallel': 'Tests parallel ausführen',
  'config.runsField.workers': 'Parallele Worker',
  'config.runsField.buildTag': 'Build-Tag',
  'config.runsFieldHelp.parallel': 'Die Tests eines Laufs gleichzeitig ausführen.',
  'config.runsFieldHelp.workers': 'Die höchste Zahl gleichzeitig laufender Tests.',
  'config.runsFieldHelp.buildTag': 'Benennt den getesteten Build der App.',
  'config.cacheField.enabled': 'Zwischengespeicherte Aktionen wiederverwenden',
  'config.cacheField.dir': 'Cache-Ordner',
  'config.recordingField.enabled': 'Video aufzeichnen',
  'config.recordingField.keepFailuresOnly': 'Nur Aufzeichnungen fehlgeschlagener Tests behalten',
  'config.recordingFieldHelp.enabled':
    'Zeichnet von jedem Test ein Video auf. Aufzeichnungen bleiben auf diesem Rechner.',
  'config.recordingFieldHelp.keepFailuresOnly':
    'Nützlich für CI und große Suiten. Bestandene Tests öffnen dann auf dem Tab „Einzelbilder“.',
  'config.accessibilityField.enabled': 'Barrierefreiheit prüfen',
  'config.accessibilityField.standard': 'Standard',
  'config.accessibilityField.runAfter': 'Zeitpunkt der Prüfungen',
  'config.accessibilityField.failOnViolation': 'Tests mit Verstößen fehlschlagen lassen',
  'config.accessibilityField.disableRules': 'Zu überspringende Regeln',
  'config.accessibilityField.exclude': 'Zu überspringende Elemente',
  'config.accessibilityFieldHelp.disableRules': 'Eine axe-Regel-ID pro Zeile.',
  'config.accessibilityFieldHelp.exclude': 'Ein CSS-Selektor pro Zeile.',
  'config.accessibilityRunAfter.everyStep': 'Nach jedem Schritt',
  'config.accessibilityRunAfter.testEnd': 'Am Testende',
  'config.logCaptureField.console': 'Konsolenprotokolle erfassen',
  'config.logCaptureField.network': 'Netzwerkprotokolle erfassen',
  'config.remotes.defaultLabel': 'Standard für Web-Tests',
  'config.remotes.inherit':
    'Tests und Suiten übernehmen diesen Standard aus agent-qa.config.yaml und können ihn in ihren Einstellungen überschreiben.',
  'config.remotes.thisMachine': 'Dieser Rechner',
  'config.remotes.runsOnLabel': 'Läuft auf',
  'config.remotes.suiteWinsHint':
    'Wenn eine Suite festlegt, wo sie läuft, hat die Wahl der Suite Vorrang.',
  'config.remotes.columns.name': 'Name',
  'config.remotes.columns.kind': 'Art',
  'config.remotes.columns.origin': 'Herkunft',
  'config.remotes.pluginNotDeclared': 'nicht unter plugins deklariert',
  'config.remotes.empty':
    'Es sind keine Remotes aufgeführt. Fügen Sie in <code>agent-qa.config.yaml</code> einen unter <code>registry.remotes</code> hinzu:',
  'config.remotes.pick':
    'Wählen Sie einen mit <code>use.browser.remote: <name></code> in <code>agent-qa.config.yaml</code>, einer Suite oder einem Test. Mit <code>local</code> läuft der Test auf diesem Rechner.',
  'config.remotes.listed':
    'Remotes werden in <code>agent-qa.config.yaml</code> unter <code>registry.remotes</code> definiert und mit <code>use.browser.remote</code> ausgewählt.',
  'config.remotes.pluginsTitle': 'Plugins',
  'config.remotes.pluginColumns.name': 'Name',
  'config.remotes.pluginColumns.source': 'Paket oder Pfad',
  'config.remotes.pluginsListed':
    'Plugins werden in <code>agent-qa.config.yaml</code> unter <code>plugins</code> deklariert; ihre Optionen bleiben in der Datei.',
  'config.loginStateColumn.target': 'Ziel',
  'config.loginStateColumn.name': 'Name',
  'config.loginStateColumn.captured': 'Erfasst',
  'config.loginStatesField.dir': 'Ordner für Anmeldestatus',
  'config.mobileField.appState': 'App-Zustand',
  'config.mobileAppState.preserve': 'App-Daten behalten',
  'config.mobileAppState.reset': 'App-Daten zurücksetzen',
  'config.targetPlatform.web': 'Web',
  'config.targetEnvironment.local': 'Lokal',
  'config.targetEnvironment.shared': 'Gemeinsam',
  'config.targetEnvironment.production': 'Produktion',
  'config.targetEnvironmentChoice.undeclared': 'Nicht angegeben',
  'config.targetField.name': 'Name',
  'config.targetField.platform': 'Plattform',
  'config.targetField.url': 'URL',
  'config.targetField.product': 'Produkt',
  'config.targetField.bundleId': 'Bundle-ID',
  'config.targetField.appPackage': 'App-Paket',
  'config.targetField.appActivity': 'App-Activity',
  'config.targetField.appPath': 'App-Datei',
  'config.targetField.appRef': 'App-Referenz',
  'config.targetField.device': 'Standardgerät',
  'config.targetField.environment': 'Umgebung',
  'config.deviceField.name': 'Name',
  'config.deviceField.platform': 'Plattform',
  'config.deviceField.model': 'Modell',
  'config.deviceField.os': 'Betriebssystemversion',
  'config.deviceField.id': 'Geräte-ID',
  'config.deviceField.capabilities': 'Capabilities',
  'config.mcpField.enabled': 'MCP-Server',
  'config.mcpField.port': 'Port',
  'config.mcpFieldHelp.enabled':
    'Wenn ausgeschaltet, stellt das Dashboard den MCP-Endpunkt nicht bereit.',
  'config.copyStatus.copied': 'Kopiert',
  'config.copyStatus.failed': 'Kopieren fehlgeschlagen',
  'config.sectionAliases.models':
    'modell, modelle, llm, llms, standardmodell, anbieter, api-schlüssel, schlüssel, anmelden, model, default model, providers, api key, sign in',
  'config.sectionAliases.screenshotSize':
    'bildverarbeitung, screenshot, auflösung, vision, resolution',
  'config.sectionAliases.plannerLimits':
    'planer, unteraktionen, verlauf, grenze, planner, sub actions, history limit',
  'config.sectionAliases.targets':
    'ziel, ziele, urls, bundle-id, app-paket, target, bundle id, app package',
  'config.sectionAliases.remotes':
    'remote, remote-browser, wo tests laufen, remote browser, where tests run',
  'config.sectionAliases.devices': 'gerät, geräte, geräteprofile, device, device profiles',
  'config.sectionAliases.loginStates':
    'anmeldestatus, anmeldung, gespeicherte anmeldung, login state, auth state, auth states, saved auth',
  'config.sectionAliases.mobileAppState':
    'mobil, app-zustand, app-daten, app-daten zurücksetzen, app-daten behalten, mobile, app state, app data',
  'config.sectionAliases.browser':
    'viewport, headless, browser, engine, browser headless',
  'config.sectionAliases.timeouts':
    'timeout, zeitüberschreitung, navigation, schritt, navigation timeout, step timeout',
  'config.sectionAliases.runs': 'parallel, worker, workers, build-tag, build tag',
  'config.sectionAliases.cache': 'cache, cache-ordner, cache dir, cache directory',
  'config.sectionAliases.recording': 'aufzeichnung, aufzeichnen, video, record',
  'config.sectionAliases.accessibility': 'barrierefreiheit, a11y, wcag',
  'config.sectionAliases.logCapture':
    'konsole, netzwerk, protokolle, console capture, network capture',
  'config.sectionAliases.testDiscovery':
    'tests, erkennung, testmatch, suitematch, ignorieren, muster, discovery, test match, suite match, ignore patterns',
  'config.sectionAliases.files':
    'hook-datei, umgebungsdatei, env-datei, secrets-datei, hooks file, env file, environment file, secrets file',
  'config.sectionAliases.knowledge': 'wissen, wissensordner, knowledge, knowledge dir',
  'config.sectionAliases.dashboard':
    'port, datenbank, datenbankpfad, artefakte, artefaktordner, db path, database, artifacts, artifacts dir, runs db',
  'config.sectionAliases.logging': 'protokollstufe, log level',
  'config.sectionAliases.passRateScope':
    'erfolgsquote, umfang, attribute, instabilität, pass rate, scope, attributes, flakiness',
  'config.sectionAliases.mcp': 'mcp, mcp-port, mcp port',
  'config.sectionAliases.configFile':
    'yaml, konfigurationsdatei, pfad, rohdaten, config file path, raw config',
  'config.commandLabel': 'Konfiguration: {{tab}} / {{section}}',
  'config.loadFailedBody':
    '{{reason}}. Laden Sie die Konfiguration neu oder korrigieren Sie die Datei in Ihrem Editor – diese Seite übernimmt die Änderung.',
  'config.fileIssuesBody':
    '{{reason}}. Korrigieren Sie die Datei in Ihrem Editor – diese Seite übernimmt die Änderung.',
  'config.undo.deleteModel': '{{name}} gelöscht',
  'config.undo.deleteTarget': 'Ziel {{name}} gelöscht',
  'config.undo.deleteDevice': 'Gerät {{name}} gelöscht',
  'config.undo.signOut': 'Von {{name}} abgemeldet',
  'config.undo.removeKey': 'Schlüssel für {{name}} entfernt',
  'config.undo.changeKnowledgeDir': 'Wissensordner geändert',
  'config.undo.changeDbPath': 'Datenbank geändert',
  'config.undo.changeArtifactsDir': 'Artefaktordner geändert',
  'config.deleteAction.model': 'Modell {{name}} löschen',
  'config.deleteAction.target': 'Ziel {{name}} löschen',
  'config.deleteAction.device': 'Gerät {{name}} löschen',
  'config.connection.signedIn': 'Mit Ihrem {{provider}}-Abo angemeldet.',
  'config.connection.keySaved': 'Schlüssel auf diesem Rechner gespeichert.',
  'config.connection.notSignedIn': 'Nicht angemeldet.',
  'config.connection.noKeyOptional':
    'Kein Schlüssel gespeichert. Dieser Endpunkt braucht möglicherweise keinen.',
  'config.connection.noKey': 'Kein Schlüssel gespeichert.',
  'config.connection.signInExpired':
    'Anmeldung abgelaufen. Melden Sie sich erneut an, um dieses Modell zu verwenden.',
  'config.fixedFacts':
    'Verbindet sich über {{connection}}. Name und Verbindung sind fest; um sie zu ändern, fügen Sie ein neues Modell hinzu.',
  'config.headerNameTaken': 'Ein Header namens {{name}} ist bereits vorhanden.',
  'config.headerNameFieldName': 'Name des Headers {{header}}',
  'config.modelHeader': 'Header {{header}}',
  'config.existingCredential.key':
    'Ein Schlüssel für {{name}} ist auf diesem Rechner bereits gespeichert.',
  'config.existingCredential.signIn': 'Auf diesem Rechner bereits als {{name}} angemeldet.',
  'config.nameTaken': 'Ein Modell namens {{name}} ist bereits vorhanden.',
  'config.nameCredentialConflict':
    'Für {{name}} ist bereits eine Anmeldung oder ein Schlüssel für {{provider}} gespeichert. Wählen Sie einen anderen Namen.',
  'config.connectRefusalIssue.validationFailed':
    'Die Konfigurationsdatei hat ein Problem, das zuerst behoben werden muss: {{issue}}',
  'config.connectRefusalIssue.invalidSetupInput':
    'Prüfen Sie das Modell und die Basis-URL: {{issue}}',
  'config.signInFailed.reason': 'Die Anmeldung wurde nicht abgeschlossen: {{reason}}',
  'config.signInFailed.noReason':
    'Die Anmeldung wurde nicht abgeschlossen: Sie konnte nicht zu Ende geführt werden.',
  'config.connectedSaved': 'Verbunden. Gespeichert als {{name}}.',
  'config.signInPluginMissing':
    '{{choice}} benötigt das Plugin @vostride/agent-qa-subscription-auth. Installieren Sie es und tragen Sie es in agent-qa.config.yaml unter plugins als name: subscription ein.',
  'config.applyAction': '{{path}} übernehmen',
  'config.keepPath': 'Aktuellen Pfad für {{path}} behalten',
  'config.attributeValue': 'Wert von {{key}}',
  'config.removeAttribute': 'Attribut {{key}} entfernen',
  'config.pluginRemote': 'Plugin {{entry}}',
  'config.remoteNotListed':
    '{{name}} ist nicht unter <code>registry.remotes</code> aufgeführt, daher können Web-Tests, die diesen Standard verwenden, nicht laufen. Führen Sie ihn dort auf oder ändern Sie <code>use.browser.remote</code>.',
  'config.remoteUnlistedChoice': '{{name}} (nicht aufgeführt)',
  'config.remotePickNotListed':
    '{{name}} ist nicht unter den Remotes der Konfiguration aufgeführt.',
  'config.remoteCredentials.file':
    'Schreiben Sie Zugangsdaten als <code>{{reference}}</code>-Verweise auf Namen, die in {{file}} deklariert sind.',
  'config.remoteCredentials.noFile':
    'Schreiben Sie Zugangsdaten als <code>{{reference}}</code>-Verweise auf Namen, die in Ihrer Secrets-Datei deklariert sind (<code>workspace.secretsFile</code> festlegen).',
  'config.targetDeviceUnlistedChoice': '{{name}} (für diese Plattform nicht aufgeführt)',
  'config.targetNameTaken': 'Ein Ziel namens {{name}} ist bereits vorhanden.',
  'config.deviceNameTaken': 'Ein Gerät namens {{name}} ist bereits vorhanden.',
  'config.deviceCapability': 'Capability {{key}} von {{device}}',
  'config.deviceRemote': 'Läuft auf dem Remote {{remote}}',
  'config.replaceValue': 'Wert für {{label}} ersetzen',
  'config.saveValue': 'Wert für {{label}} speichern',
  'config.keepValue': 'Aktuellen Wert für {{label}} behalten',
} satisfies Translation<typeof en>
