import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'player.frames': 'Images',
  'player.video': 'Vidéo',
  'player.source': 'Source de lecture',
  'player.framesTooltip': 'Les captures d’écran exactes que le modèle a vues au moment de décider',
  'player.play': 'Lire l’enregistrement',
  'player.pause': 'Mettre l’enregistrement en pause',
  'player.speed': 'Vitesse de lecture',
  'player.substitution':
    'Sous-action nº {{shown}} sur {{total}} affichée : la dernière qui a une capture d’écran',
  'player.lightboxTitle': 'Capture d’écran citée',
  'player.lightboxClose': 'Fermer la capture d’écran',
  'player.lightboxNote':
    'Cette capture d’écran est citée par l’analyse, mais n’appartient à aucune sous-action enregistrée : elle n’a donc pas de place sur la chronologie.',
  'player.videoAbsent': 'Vidéo : {{title}}',
  'player.lastRecordedAction': 'Dernière action enregistrée',
  'player.totalTimeUnavailable':
    'La durée totale de lecture est indisponible, car la durée d’un enregistrement manque ou est encore en cours de chargement.',
  'player.noAnnotationTiming':
    'Cet enregistrement n’a pas de minutage sauvegardé pour placer les mises en évidence des actions sur la vidéo. Ouvrez l’onglet Images pour voir les mises en évidence sauvegardées.',
  'player.hideAnnotations': 'Masquer les annotations',
  'player.showAnnotations': 'Afficher les annotations',
  'player.enableMagnifier': 'Activer la loupe',
  'player.disableMagnifier': 'Désactiver la loupe',
  'player.enterFullscreen': 'Passer en plein écran',
  'player.exitFullscreen': 'Quitter le plein écran',
  'player.fullscreenDialog': 'Média des preuves en plein écran',
  'player.videoUntimed':
    'Cet enregistrement ne peut pas être synchronisé avec l’action sélectionnée. Passez à l’onglet Images pour voir sa capture d’écran.',

  'player.timeline.slider': 'Chronologie du test',
  'player.timeline.signals': 'Signaux des étapes',
  'player.timeline.memberSlider': 'Chronologie du test : {{member}}',
  'player.timeline.noActions': 'Aucune action enregistrée pour ce test',
  'player.timeline.memberNoActions': '{{member}} : aucune action enregistrée',
  'player.timeline.step': 'Étape {{step}}',
  'player.timeline.memberStep': '{{member}}, étape {{step}}',
  'player.timeline.markerLabel': '{{place}} : {{action}}',
  'player.timeline.chooseNearby_one': 'Choisir parmi {{count}} action proche',
  'player.timeline.chooseNearby_other': 'Choisir parmi {{count}} actions proches',
  'player.timeline.nearbyActions': 'Actions proches',
  'player.timeline.marker':
    'Étape {{step}}, sous-action {{index}} sur {{total}} : {{sentence}}, {{result}}',
  'player.timeline.markerAt':
    'Étape {{step}}, sous-action {{index}} sur {{total}} : {{sentence}}, {{result}}, {{time}}',
  'player.timeline.readout': 'nº {{index}} sur {{total}}',
  'player.timeline.readoutAt': 'nº {{index}} sur {{total}} · {{offset}} / {{extent}}',
} satisfies Translation<typeof en>
