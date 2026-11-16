import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'player.frames': 'Einzelbilder',
  'player.video': 'Video',
  'player.source': 'Wiedergabequelle',
  'player.framesTooltip':
    'Genau die Screenshots, die das Modell bei seiner Entscheidung gesehen hat',
  'player.play': 'Aufzeichnung abspielen',
  'player.pause': 'Aufzeichnung anhalten',
  'player.speed': 'Wiedergabegeschwindigkeit',
  'player.substitution':
    '#{{shown}} von {{total}} wird angezeigt – die letzte Unteraktion mit einem Screenshot',
  'player.lightboxTitle': 'Zitierter Screenshot',
  'player.lightboxClose': 'Screenshot schließen',
  'player.lightboxNote':
    'Die Analyse zitiert diesen Screenshot, er gehört aber zu keiner aufgezeichneten Unteraktion und hat daher keinen Platz auf der Zeitleiste.',
  'player.videoAbsent': 'Video – {{title}}',
  'player.lastRecordedAction': 'Zuletzt aufgezeichnete Aktion',
  'player.totalTimeUnavailable':
    'Die gesamte Wiedergabezeit ist nicht verfügbar, weil die Dauer einer Aufzeichnung fehlt oder noch geladen wird.',
  'player.noAnnotationTiming':
    'Für diese Aufzeichnung wurden keine Zeitangaben gespeichert, um Aktionen im Video hervorzuheben. Öffnen Sie die Einzelbilder, um gespeicherte Hervorhebungen zu sehen.',
  'player.hideAnnotations': 'Markierungen ausblenden',
  'player.showAnnotations': 'Markierungen einblenden',
  'player.enableMagnifier': 'Lupe einschalten',
  'player.disableMagnifier': 'Lupe ausschalten',
  'player.enterFullscreen': 'Vollbild öffnen',
  'player.exitFullscreen': 'Vollbild beenden',
  'player.fullscreenDialog': 'Belege im Vollbild',
  'player.videoUntimed':
    'Diese Aufzeichnung lässt sich nicht mit der ausgewählten Aktion abgleichen. Wechseln Sie zu den Einzelbildern, um ihren Screenshot zu sehen.',

  'player.timeline.slider': 'Zeitleiste des Tests',
  'player.timeline.signals': 'Signale der Schritte',
  'player.timeline.memberSlider': 'Zeitleiste des Tests: {{member}}',
  'player.timeline.noActions': 'Für diesen Test wurden keine Aktionen aufgezeichnet',
  'player.timeline.memberNoActions': '{{member}}: Keine Aktionen aufgezeichnet',
  'player.timeline.step': 'Schritt {{step}}',
  'player.timeline.memberStep': '{{member}}, Schritt {{step}}',
  'player.timeline.markerLabel': '{{place}}: {{action}}',
  'player.timeline.chooseNearby_one': 'Aus {{count}} Aktion in der Nähe wählen',
  'player.timeline.chooseNearby_other': 'Aus {{count}} Aktionen in der Nähe wählen',
  'player.timeline.nearbyActions': 'Aktionen in der Nähe',
  'player.timeline.marker':
    'Schritt {{step}}, Unteraktion {{index}} von {{total}}: {{sentence}}, {{result}}',
  'player.timeline.markerAt':
    'Schritt {{step}}, Unteraktion {{index}} von {{total}}: {{sentence}}, {{result}}, {{time}}',
  'player.timeline.readout': '#{{index}} von {{total}}',
  'player.timeline.readoutAt': '#{{index}} von {{total}} · {{offset}} / {{extent}}',
} satisfies Translation<typeof en>
