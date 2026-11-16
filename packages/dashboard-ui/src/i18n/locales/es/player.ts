import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'player.frames': 'Fotogramas',
  'player.video': 'Video',
  'player.source': 'Origen de la reproducción',
  'player.framesTooltip': 'Las capturas de pantalla exactas que vio el modelo al decidir',
  'player.play': 'Reproducir la grabación',
  'player.pause': 'Pausar la grabación',
  'player.speed': 'Velocidad de reproducción',
  'player.substitution':
    'Se muestra el n.º {{shown}} de {{total}}: la última subacción con captura de pantalla',
  'player.lightboxTitle': 'Captura de pantalla citada',
  'player.lightboxClose': 'Cerrar la captura de pantalla',
  'player.lightboxNote':
    'El análisis cita esta captura de pantalla, pero no pertenece a ninguna subacción grabada, así que no tiene lugar en la línea de tiempo.',
  'player.videoAbsent': 'Video: {{title}}',
  'player.lastRecordedAction': 'Última acción grabada',
  'player.totalTimeUnavailable':
    'El tiempo total de reproducción no está disponible porque falta la duración de una grabación o aún se está cargando.',
  'player.noAnnotationTiming':
    'Esta grabación no tiene tiempos guardados para situar los resaltados de las acciones en el video. Abre Fotogramas para ver los resaltados guardados.',
  'player.hideAnnotations': 'Ocultar anotaciones',
  'player.showAnnotations': 'Mostrar anotaciones',
  'player.enableMagnifier': 'Activar la lupa',
  'player.disableMagnifier': 'Desactivar la lupa',
  'player.enterFullscreen': 'Pantalla completa',
  'player.exitFullscreen': 'Salir de la pantalla completa',
  'player.fullscreenDialog': 'Evidencias a pantalla completa',
  'player.videoUntimed':
    'Esta grabación no se puede sincronizar con la acción seleccionada. Cambia a Fotogramas para ver su captura de pantalla.',

  'player.timeline.slider': 'Línea de tiempo de la prueba',
  'player.timeline.signals': 'Señales de los pasos',
  'player.timeline.memberSlider': 'Línea de tiempo de la prueba: {{member}}',
  'player.timeline.noActions': 'No se grabaron acciones en esta prueba',
  'player.timeline.memberNoActions': '{{member}}: no se grabaron acciones',
  'player.timeline.step': 'Paso {{step}}',
  'player.timeline.memberStep': '{{member}}, paso {{step}}',
  'player.timeline.markerLabel': '{{place}}: {{action}}',
  'player.timeline.chooseNearby_one': 'Elegir {{count}} acción cercana',
  'player.timeline.chooseNearby_other': 'Elegir entre {{count}} acciones cercanas',
  'player.timeline.nearbyActions': 'Acciones cercanas',
  'player.timeline.marker':
    'Paso {{step}}, subacción {{index}} de {{total}}: {{sentence}}, {{result}}',
  'player.timeline.markerAt':
    'Paso {{step}}, subacción {{index}} de {{total}}: {{sentence}}, {{result}}, {{time}}',
  'player.timeline.readout': 'N.º {{index}} de {{total}}',
  'player.timeline.readoutAt': 'N.º {{index}} de {{total}} · {{offset}} / {{extent}}',
} satisfies Translation<typeof en>
