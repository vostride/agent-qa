import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'tour.intro.title': 'Willkommen bei agent-qa',
  'tour.intro.body':
    'Mit agent-qa schreiben Sie Tests für Web und Mobile in natürlicher Sprache. agent-qa führt sie in einer strengen QA-Umgebung aus, lernt aus früheren Läufen, passt sich an, wenn sich die Oberfläche ändert, und zeigt Ihnen genau, was passiert ist.',
  'tour.llmSetup.title': 'Zuerst das LLM einrichten',
  'tour.runs.title': 'Läufe zeigen Ergebnisse',
  'tour.runs.body':
    'Läufe zeigen die Ergebnisse, Artefakte und Begründungen jeder Ausführung von agent-qa.',
  'tour.tests.title': 'Tests enthalten Prüfungen in natürlicher Sprache',
  'tour.tests.body':
    'Tests sind Prüfungen in natürlicher Sprache, die agent-qa gegen Ihr konfiguriertes Web- oder Mobile-Ziel ausführen kann.',
  'tour.suites.title': 'Suiten bündeln wiederholbare Abläufe',
  'tour.suites.body':
    'Suiten fassen zusammengehörige Prüfungen zu wiederholbaren Abläufen zusammen, wenn ein einzelner Test nicht reicht.',
  'tour.hooks.title': 'Hooks laufen um Schritte herum und zwischen ihnen',
  'tour.hooks.body':
    'Hooks können die Vorbereitung übernehmen, inline zwischen Schritten laufen und rund um einen Test oder eine Suite aufräumen.',
  'tour.config.title': 'Die Konfiguration steuert die lokale Einrichtung',
  'tour.config.body':
    'Die Konfiguration legt Modell, Ziel, Laufzeit und Dashboard fest, die agent-qa lokal verwendet.',
  'tour.exampleTest.title': 'Den Beispieltest ausführen, der bestehen sollte',
  'tour.exampleTest.body':
    'Dieser erzeugte Test ist der sicherste erste Lauf, denn init legt ihn an, um Ihre Einrichtung zu prüfen.',
  'tour.exampleMissing.title': 'Den Beispieltest finden, der bestehen sollte',
  'tour.exampleMissing.body':
    'agent-qa init legt normalerweise den Test „Example passing test“ an. Wählen Sie ihn unter Tests aus, sobald er verfügbar ist, oder legen Sie später einen an.',
  'tour.runAction.title': 'Auf „Ausführen“ klicken, wenn Sie bereit sind',
  'tour.runAction.body':
    'Klicken Sie auf „Ausführen“, wenn Sie bereit sind. Die Tour geht in der Laufansicht oder auf der Seite Läufe weiter.',
  'tour.liveRun.title': 'Den Lauf live verfolgen',
  'tour.liveRun.body':
    'Der Live-Modus zeigt den laufenden Test: auf der einen Seite seine Schritte, daneben den Browser.',
  'tour.runDetail.title': 'Die Laufdetails ansehen',
  'tour.runDetail.body':
    'Hier zeigt sich der Nutzen: Sehen Sie sich an, was agent-qa beobachtet, geplant, ausgeführt und geprüft hat.',
  'tour.githubNudge.title': 'Wenn agent-qa Ihnen geholfen hat',
  'tour.githubNudge.body':
    'Wenn agent-qa Ihnen geholfen hat, geben Sie dem Projekt doch einen Stern auf GitHub.',
  'tour.githubNudge.actionLabel': 'Auf GitHub ansehen',
  'tour.runsFallback.title': 'Den neuesten Lauf öffnen',
  'tour.runsFallback.body':
    'Wenn hier noch kein Lauf geöffnet ist, öffnen Sie über Läufe die neueste Ausführung und sehen Sie sich die Detailansicht an.',
  'tour.ui.progress': 'Fortschritt der Tour: {{current}} von {{total}}',
  'tour.ui.skip': 'Überspringen',
  'tour.ui.restart': 'Neu starten',
  'tour.ui.back': 'Zurück',
  'tour.ui.done': 'Fertig',
  'tour.ui.startTour': 'Tour starten',
} satisfies Translation<typeof en>
