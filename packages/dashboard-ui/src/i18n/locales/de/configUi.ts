import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'configUi.configPageTitle': 'Konfiguration',
  'configUi.versionUnavailableText': 'Version von agent-qa nicht verfügbar',
  'configUi.configTabsAriaLabel': 'Bereiche der Konfiguration',
  'configUi.tabDraftSrSuffix': ', hat nicht gespeicherte Änderungen',
  'configUi.legacyLinkNotFoundText':
    'Dieser Link zu einer Einstellung ist veraltet, daher wird stattdessen „Modelle“ angezeigt.',
  'configUi.configLoadFailedTitle': 'Die Konfiguration konnte nicht geladen werden',
  'configUi.reloadConfigLabel': 'Konfiguration neu laden',
  'configUi.configFileIssuesTitle': 'Die Konfigurationsdatei hat ein Problem',
  'configUi.retryLabel': 'Erneut versuchen',
  'configUi.notSavedActionName': 'Nicht gespeichert. Zum ersten nicht gespeicherten Feld gehen.',
  'configUi.undoLabel': 'Rückgängig',
  'configUi.fieldChangedText':
    'Dieser Wert wurde in der Datei geändert. Die Seite zeigt jetzt den Wert aus der Datei.',
  'configUi.addModelLabel': 'Modell hinzufügen',
  'configUi.newModelRowTitle': 'Neues Modell',
  'configUi.discardDraftLabel': 'Entwurf verwerfen',
  'configUi.defaultBadge': 'Standard',
  'configUi.testConnectionLabel': 'Verbindung testen',
  'configUi.makeDefaultLabel': 'Als Standard festlegen',
  'configUi.replaceKeyLabel': 'Schlüssel ersetzen',
  'configUi.removeKeyLabel': 'Schlüssel entfernen',
  'configUi.signInAgainLabel': 'Erneut anmelden',
  'configUi.signOutLabel': 'Abmelden',
  'configUi.deleteModelLabel': 'Modell löschen',
  'configUi.saveKeyAndTestLabel': 'Schlüssel speichern und testen',
  'configUi.keepCurrentKeyLabel': 'Aktuellen Schlüssel behalten',
  'configUi.newKeyLabel': 'Neuer Schlüssel',
  'configUi.saveHeaderLabel': 'Header speichern',
  'configUi.discardHeaderLabel': 'Header verwerfen',
  'configUi.headerNameRequiredError': 'Ein Header braucht einen Namen.',
  'configUi.defaultCannotDeleteLine':
    'Dies ist das Standardmodell. Legen Sie zuerst ein anderes Modell als Standard fest.',
  'configUi.noModelsText': 'Läufe brauchen ein Modell. Fügen Sie eines hinzu, um zu beginnen.',
  'configUi.noDefaultText':
    'Kein Standardmodell. Läufe brauchen eines – legen Sie eines dieser Modelle als Standard fest.',
  'configUi.connectLabel': 'Verbinden',
  'configUi.connectingLabel': 'Wird verbunden …',
  'configUi.connectFormLegend': 'Wie möchten Sie sich verbinden?',
  'configUi.addHeaderLabel': 'Header hinzufügen',
  'configUi.keyOptionalHelp': 'Leer lassen, wenn Ihr Endpunkt keinen Schlüssel braucht.',
  'configUi.baseUrlHelp': 'Die genaue Basis-URL. agent-qa hängt keine Pfade an.',
  'configUi.nameRuleError':
    'Verwenden Sie Kleinbuchstaben, Ziffern, Bindestriche und Punkte, beginnend mit einem Buchstaben oder einer Ziffer.',
  'configUi.modelRequiredError': 'Ein Modell ist erforderlich.',
  'configUi.keyRequiredError': 'Ein API-Schlüssel ist erforderlich.',
  'configUi.baseUrlRequiredError': 'Für kompatible Anbieter ist eine Basis-URL erforderlich.',
  'configUi.couldNotSaveModel':
    'Das Modell konnte nicht gespeichert werden. Versuchen Sie es erneut.',
  'configUi.signInWaitingText': 'Schließen Sie die Anmeldung auf der geöffneten Seite ab.',
  'configUi.cancelSignInLabel': 'Anmeldung abbrechen',
  'configUi.signInWaitingLabel': 'Warten auf Anmeldung …',
  'configUi.signInTimedOutText':
    'Zeitüberschreitung bei der Anmeldung. Versuchen Sie es erneut.',
  'configUi.savedBecameDefault': '{{saved}} Es ist jetzt das Standardmodell.',
  'configUi.saveWithoutTestingLabel': 'Ohne Test speichern',
  'configUi.savedWithoutTestText': 'Ohne Verbindungstest gespeichert.',
  'configUi.applyLabel': 'Übernehmen',
  'configUi.keepCurrentPathLabel': 'Aktuellen Pfad behalten',
  'configUi.portRestartHelp': 'Wird nach einem Neustart des Dashboards wirksam.',
  'configUi.testMatchRequiredError': 'Fügen Sie mindestens ein Muster für Testdateien hinzu.',
  'configUi.suiteMatchRequiredError': 'Fügen Sie mindestens ein Muster für Suite-Dateien hinzu.',
  'configUi.hooksFileRequiredError': 'Eine Hook-Datei ist erforderlich.',
  'configUi.envFileRequiredError': 'Eine Umgebungsdatei ist erforderlich.',
  'configUi.passRateScopeHelp':
    'Eingegrenzte Erfolgsquoten zählen nur Läufe, deren Attribute jedem dieser Einträge entsprechen.',
  'configUi.noAttributesText': 'Noch keine Attribute.',
  'configUi.addAttributeLabel': 'Attribut hinzufügen',
  'configUi.matchAsPatternLabel': 'Als Muster vergleichen',
  'configUi.attributePatternTag': 'Muster',
  'configUi.invalidAttributePatternError': 'Kein gültiges Muster.',
  'configUi.durationInputError': 'Verwenden Sie eine Dauer wie 30s, 5m oder 1h.',
  'configUi.headlessHelp': 'Webbrowser ohne sichtbares Fenster ausführen.',
  'configUi.accessibilityAllRulesText': 'Alle Regeln',
  'configUi.noTargetsText': 'Noch keine Ziele.',
  'configUi.noDevicesText': 'Noch keine Geräte.',
  'configUi.noLoginStatesText':
    'Noch keine gespeicherten Anmeldestatus. Speichern Sie einen aus einer Web-Sitzung im Live-Modus.',
  'configUi.loginStatesLoadingText': 'Gespeicherte Anmeldestatus werden geladen …',
  'configUi.loginStatesLoadFailedText':
    'Die gespeicherten Anmeldestatus konnten nicht geladen werden.',
  'configUi.reloadLoginStatesLabel': 'Anmeldestatus neu laden',
  'configUi.loginStatesDirPlaceholder': '.agent-qa/auth-states',
  'configUi.loginStatesDirRequiredError':
    'Fügen Sie einen Ordner für gespeicherte Anmeldestatus hinzu.',
  'configUi.mobileAppStateHelp': 'Läufe auf Mobilgeräten brauchen diese Angabe.',
  'configUi.addTargetLabel': 'Ziel hinzufügen',
  'configUi.discardTargetLabel': 'Ziel verwerfen',
  'configUi.addDeviceLabel': 'Gerät hinzufügen',
  'configUi.discardDeviceLabel': 'Gerät verwerfen',
  'configUi.targetEnvironmentPlaceholder': 'Nicht angegeben',
  'configUi.targetDeviceNone': 'Keins',
  'configUi.targetDeviceHelp':
    'Tests auf diesem Ziel laufen auf diesem Gerät, sofern eine Suite oder ein Test kein anderes wählt.',
  'configUi.targetAppRefNote':
    'Die App, die ein entferntes Gerät installiert. Legen Sie sie in agent-qa.config.yaml fest; diese Seite zeigt sie nur an.',
  'configUi.targetAppSummary': 'App: {{path}}',
  'configUi.targetAppRefLabel': 'App-Referenz von {{name}}',
  'configUi.targetNameRequiredError': 'Geben Sie einen Namen für das Ziel ein.',
  'configUi.targetNameFormatError':
    'Verwenden Sie Kleinbuchstaben, Ziffern und Bindestriche, beginnend mit einem Buchstaben und endend mit einem Buchstaben oder einer Ziffer.',
  'configUi.targetUrlRequiredError': 'Geben Sie die URL für ein Web-Ziel ein.',
  'configUi.targetWebNeedsUrlError':
    'Geben Sie eine URL ein, bevor Sie dies zu einem Web-Ziel machen.',
  'configUi.targetProductError':
    'Ein Produktname darf keine zwei aufeinanderfolgenden Punkte, Schrägstriche oder umgekehrten Schrägstriche enthalten.',
  'configUi.targetAppPathError':
    'Verwenden Sie einen Pfad innerhalb des Projekts, keinen vollständigen Pfad.',
  'configUi.deviceNameRequiredError': 'Geben Sie einen Namen für das Gerät ein.',
  'configUi.deviceIdHelp':
    'Nur nötig, wenn zwei gleiche Geräte gleichzeitig angeschlossen sind: eine Android-Seriennummer oder eine udid eines iOS-Simulators.',
  'configUi.deviceCapabilitiesNote':
    'Legen Sie Capabilities in agent-qa.config.yaml fest; diese Seite zeigt sie nur an.',
  'configUi.configFileNote':
    'Schreibgeschützt. Bearbeiten Sie die Datei in Ihrem Editor; Änderungen erscheinen hier von selbst.',
  'configUi.copyPathLabel': 'Pfad der Konfigurationsdatei kopieren',
  'configUi.replaceValueLabel': 'Wert ersetzen',
  'configUi.saveValueLabel': 'Wert speichern',
  'configUi.keepCurrentValueLabel': 'Aktuellen Wert behalten',
  'configUi.saveSettingLabel': 'Einstellung speichern',
  'configUi.discardSettingLabel': 'Einstellung verwerfen',
  'configUi.tourLlmSetupBody':
    'Ein Lauf braucht ein Modell. Fügen Sie eines hinzu: Wählen Sie, wie Sie sich verbinden, und es wird getestet und gespeichert, sobald es funktioniert.',
  'configUi.number.integerRange': '{{label}} muss eine ganze Zahl zwischen {{min}} und {{max}} sein',
  'configUi.number.integerMin':
    '{{label}} muss eine ganze Zahl größer oder gleich {{min}} sein',
  'configUi.number.integerMax': '{{label}} muss eine ganze Zahl kleiner oder gleich {{max}} sein',
  'configUi.number.integer': '{{label}} muss eine ganze Zahl sein',
  'configUi.number.numberRange': '{{label}} muss eine Zahl zwischen {{min}} und {{max}} sein',
  'configUi.number.numberMin': '{{label}} muss eine Zahl größer oder gleich {{min}} sein',
  'configUi.number.numberMax': '{{label}} muss eine Zahl kleiner oder gleich {{max}} sein',
  'configUi.number.number': '{{label}} muss eine Zahl sein',
} satisfies Translation<typeof en>
