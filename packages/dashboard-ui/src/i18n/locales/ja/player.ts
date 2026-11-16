import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'player.frames': 'フレーム',
  'player.video': '動画',
  'player.source': '再生ソース',
  'player.framesTooltip': 'モデルが判断した時点で見ていたスクリーンショットそのもの',
  'player.play': '録画を再生',
  'player.pause': '録画を一時停止',
  'player.speed': '再生速度',
  'player.substitution':
    '#{{shown}}／{{total}}を表示中。スクリーンショットのある最新のサブアクションです',
  'player.lightboxTitle': '引用されたスクリーンショット',
  'player.lightboxClose': 'スクリーンショットを閉じる',
  'player.lightboxNote':
    'このスクリーンショットは分析で引用されていますが、記録されたサブアクションに属していないため、タイムライン上に位置がありません。',
  'player.videoAbsent': '動画：{{title}}',
  'player.lastRecordedAction': '最後に記録されたアクション',
  'player.totalTimeUnavailable':
    '録画の長さが不明か読み込み中のため、全体の再生時間を表示できません。',
  'player.noAnnotationTiming':
    'この録画には、動画上にアクションのハイライトを配置するためのタイミングが保存されていません。保存されたアクションのハイライトは「フレーム」タブで確認できます。',
  'player.hideAnnotations': '注釈を非表示',
  'player.showAnnotations': '注釈を表示',
  'player.enableMagnifier': '拡大鏡をオン',
  'player.disableMagnifier': '拡大鏡をオフ',
  'player.enterFullscreen': '全画面表示',
  'player.exitFullscreen': '全画面表示を終了',
  'player.fullscreenDialog': 'エビデンスのメディア（全画面表示）',
  'player.videoUntimed':
    'この録画は選択したアクションと同期できません。スクリーンショットを見るには「フレーム」タブに切り替えてください。',

  'player.timeline.slider': 'テストのタイムライン',
  'player.timeline.signals': 'ステップのシグナル',
  'player.timeline.memberSlider': 'テストのタイムライン：{{member}}',
  'player.timeline.noActions': 'このテストで記録されたアクションはありません',
  'player.timeline.memberNoActions': '{{member}}：記録されたアクションはありません',
  'player.timeline.step': 'ステップ{{step}}',
  'player.timeline.memberStep': '{{member}}、ステップ{{step}}',
  'player.timeline.markerLabel': '{{place}}：{{action}}',
  'player.timeline.chooseNearby_other': '近くの{{count}}件のアクションから選択',
  'player.timeline.nearbyActions': '近くのアクション',
  'player.timeline.marker':
    'ステップ{{step}}、サブアクション{{index}}／{{total}}：{{sentence}}、{{result}}',
  'player.timeline.markerAt':
    'ステップ{{step}}、サブアクション{{index}}／{{total}}：{{sentence}}、{{result}}、{{time}}',
  'player.timeline.readout': '#{{index}}／{{total}}',
  'player.timeline.readoutAt': '#{{index}}／{{total}}・{{offset}}／{{extent}}',
} satisfies Translation<typeof en>
