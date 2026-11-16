import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'player.frames': 'Quadros',
  'player.video': 'Vídeo',
  'player.source': 'Fonte da reprodução',
  'player.framesTooltip': 'As capturas de tela exatas que o modelo viu quando decidiu',
  'player.play': 'Reproduzir gravação',
  'player.pause': 'Pausar gravação',
  'player.speed': 'Velocidade de reprodução',
  'player.substitution':
    'Mostrando nº {{shown}} de {{total}}: a subação mais recente com captura de tela',
  'player.lightboxTitle': 'Captura de tela citada',
  'player.lightboxClose': 'Fechar captura de tela',
  'player.lightboxNote':
    'Esta captura de tela é citada pela análise, mas não pertence a uma subação registrada, então não tem lugar na linha do tempo.',
  'player.videoAbsent': 'Vídeo: {{title}}',
  'player.lastRecordedAction': 'Última ação registrada',
  'player.totalTimeUnavailable':
    'O tempo total de reprodução não está disponível porque a duração de uma gravação está faltando ou ainda está carregando.',
  'player.noAnnotationTiming':
    'Esta gravação não tem tempos salvos para posicionar os destaques das ações no vídeo. Abra a aba Quadros para ver os destaques de ação salvos.',
  'player.hideAnnotations': 'Ocultar anotações',
  'player.showAnnotations': 'Mostrar anotações',
  'player.enableMagnifier': 'Ativar lupa',
  'player.disableMagnifier': 'Desativar lupa',
  'player.enterFullscreen': 'Entrar em tela cheia',
  'player.exitFullscreen': 'Sair da tela cheia',
  'player.fullscreenDialog': 'Mídia das evidências em tela cheia',
  'player.videoUntimed':
    'Esta gravação não pode ser sincronizada com a ação selecionada. Mude para a aba Quadros para ver a captura de tela dela.',

  'player.timeline.slider': 'Linha do tempo do teste',
  'player.timeline.signals': 'Sinais das etapas',
  'player.timeline.memberSlider': 'Linha do tempo do teste: {{member}}',
  'player.timeline.noActions': 'Nenhuma ação registrada para este teste',
  'player.timeline.memberNoActions': '{{member}}: nenhuma ação registrada',
  'player.timeline.step': 'Etapa {{step}}',
  'player.timeline.memberStep': '{{member}}, etapa {{step}}',
  'player.timeline.markerLabel': '{{place}}: {{action}}',
  'player.timeline.chooseNearby_one': 'Escolher entre {{count}} ação próxima',
  'player.timeline.chooseNearby_other': 'Escolher entre {{count}} ações próximas',
  'player.timeline.nearbyActions': 'Ações próximas',
  'player.timeline.marker':
    'Etapa {{step}}, subação {{index}} de {{total}}: {{sentence}}, {{result}}',
  'player.timeline.markerAt':
    'Etapa {{step}}, subação {{index}} de {{total}}: {{sentence}}, {{result}}, {{time}}',
  'player.timeline.readout': 'nº {{index}} de {{total}}',
  'player.timeline.readoutAt': 'nº {{index}} de {{total}} · {{offset}} / {{extent}}',
} satisfies Translation<typeof en>
