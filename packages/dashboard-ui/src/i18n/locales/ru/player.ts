import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'player.frames': 'Кадры',
  'player.video': 'Видео',
  'player.source': 'Источник воспроизведения',
  'player.framesTooltip': 'Те самые снимки экрана, которые видела модель, принимая решение',
  'player.play': 'Воспроизвести запись',
  'player.pause': 'Приостановить запись',
  'player.speed': 'Скорость воспроизведения',
  'player.substitution':
    'Показано: №{{shown}} из {{total}} — последнее вложенное действие со снимком экрана',
  'player.lightboxTitle': 'Цитируемый снимок экрана',
  'player.lightboxClose': 'Закрыть снимок экрана',
  'player.lightboxNote':
    'На этот снимок экрана ссылается анализ, но он не относится ни к одному записанному вложенному действию, поэтому его нет на временной шкале.',
  'player.videoAbsent': 'Видео — {{title}}',
  'player.lastRecordedAction': 'Последнее записанное действие',
  'player.totalTimeUnavailable':
    'Полное время воспроизведения недоступно: длительность записи отсутствует или ещё загружается.',
  'player.noAnnotationTiming':
    'В этой записи нет сохранённых данных о времени, чтобы показать действия на видео. Откройте вкладку «Кадры», чтобы увидеть сохранённые пометки действий.',
  'player.hideAnnotations': 'Скрыть пометки',
  'player.showAnnotations': 'Показать пометки',
  'player.enableMagnifier': 'Включить лупу',
  'player.disableMagnifier': 'Выключить лупу',
  'player.enterFullscreen': 'Во весь экран',
  'player.exitFullscreen': 'Выйти из полноэкранного режима',
  'player.fullscreenDialog': 'Доказательства во весь экран',
  'player.videoUntimed':
    'Эту запись нельзя синхронизировать с выбранным действием. Перейдите на вкладку «Кадры», чтобы увидеть его снимок экрана.',

  'player.timeline.slider': 'Временная шкала теста',
  'player.timeline.signals': 'Сигналы шагов',
  'player.timeline.memberSlider': 'Временная шкала теста: {{member}}',
  'player.timeline.noActions': 'Для этого теста не записано ни одного действия',
  'player.timeline.memberNoActions': '{{member}}: действия не записаны',
  'player.timeline.step': 'Шаг {{step}}',
  'player.timeline.memberStep': '{{member}}, шаг {{step}}',
  'player.timeline.markerLabel': '{{place}}: {{action}}',
  'player.timeline.chooseNearby_one': 'Выбрать из {{count}} ближайшего действия',
  'player.timeline.chooseNearby_few': 'Выбрать из {{count}} ближайших действий',
  'player.timeline.chooseNearby_many': 'Выбрать из {{count}} ближайших действий',
  'player.timeline.chooseNearby_other': 'Выбрать из {{count}} ближайшего действия',
  'player.timeline.nearbyActions': 'Ближайшие действия',
  'player.timeline.marker':
    'Шаг {{step}}, вложенное действие {{index}} из {{total}}: {{sentence}}, {{result}}',
  'player.timeline.markerAt':
    'Шаг {{step}}, вложенное действие {{index}} из {{total}}: {{sentence}}, {{result}}, {{time}}',
  'player.timeline.readout': '№{{index}} из {{total}}',
  'player.timeline.readoutAt': '№{{index}} из {{total}} · {{offset}} / {{extent}}',
} satisfies Translation<typeof en>
