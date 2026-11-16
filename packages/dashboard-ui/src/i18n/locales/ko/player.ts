import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'player.frames': '프레임',
  'player.video': '동영상',
  'player.source': '재생 소스',
  'player.framesTooltip': '모델이 결정할 때 본 바로 그 스크린샷',
  'player.play': '녹화 재생',
  'player.pause': '녹화 일시 정지',
  'player.speed': '재생 속도',
  'player.substitution':
    '{{total}}개 중 #{{shown}} 표시 중 — 스크린샷이 있는 가장 최근 하위 동작',
  'player.lightboxTitle': '인용된 스크린샷',
  'player.lightboxClose': '스크린샷 닫기',
  'player.lightboxNote':
    '이 스크린샷은 분석에서 인용되었지만 기록된 하위 동작에 속하지 않으므로 타임라인에 위치가 없습니다.',
  'player.videoAbsent': '동영상 — {{title}}',
  'player.lastRecordedAction': '마지막으로 기록된 동작',
  'player.totalTimeUnavailable':
    '녹화 길이가 없거나 아직 불러오는 중이어서 전체 재생 시간을 알 수 없습니다.',
  'player.noAnnotationTiming':
    '이 녹화에는 동영상에 동작 강조 표시를 배치할 시간 정보가 저장되어 있지 않습니다. 저장된 동작 강조 표시를 보려면 프레임 탭을 여세요.',
  'player.hideAnnotations': '주석 숨기기',
  'player.showAnnotations': '주석 표시',
  'player.enableMagnifier': '돋보기 켜기',
  'player.disableMagnifier': '돋보기 끄기',
  'player.enterFullscreen': '전체 화면',
  'player.exitFullscreen': '전체 화면 종료',
  'player.fullscreenDialog': '증거 미디어 전체 화면',
  'player.videoUntimed':
    '이 녹화는 선택한 동작과 동기화할 수 없습니다. 스크린샷을 보려면 프레임 탭으로 전환하세요.',

  'player.timeline.slider': '테스트 타임라인',
  'player.timeline.signals': '단계 신호',
  'player.timeline.memberSlider': '테스트 타임라인: {{member}}',
  'player.timeline.noActions': '이 테스트에 기록된 동작이 없습니다',
  'player.timeline.memberNoActions': '{{member}}: 기록된 동작 없음',
  'player.timeline.step': '{{step}}단계',
  'player.timeline.memberStep': '{{member}}, {{step}}단계',
  'player.timeline.markerLabel': '{{place}}: {{action}}',
  'player.timeline.chooseNearby_other': '근처 동작 {{count}}개 중에서 선택',
  'player.timeline.nearbyActions': '근처 동작',
  'player.timeline.marker':
    '{{step}}단계, 하위 동작 {{total}}개 중 {{index}}번째: {{sentence}}, {{result}}',
  'player.timeline.markerAt':
    '{{step}}단계, 하위 동작 {{total}}개 중 {{index}}번째: {{sentence}}, {{result}}, {{time}}',
  'player.timeline.readout': '{{total}}개 중 #{{index}}',
  'player.timeline.readoutAt': '{{total}}개 중 #{{index}} · {{offset}} / {{extent}}',
} satisfies Translation<typeof en>
