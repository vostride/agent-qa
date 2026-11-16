import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'player.frames': '影格',
  'player.video': '影片',
  'player.source': '播放來源',
  'player.framesTooltip': '模型做出決策時實際看到的螢幕截圖',
  'player.play': '播放錄影',
  'player.pause': '暫停錄影',
  'player.speed': '播放速度',
  'player.substitution': '顯示第 {{shown}} 個，共 {{total}} 個：最近一個有螢幕截圖的子動作',
  'player.lightboxTitle': '引用的螢幕截圖',
  'player.lightboxClose': '關閉螢幕截圖',
  'player.lightboxNote':
    '分析引用了這張螢幕截圖，但它不屬於任何已記錄的子動作，因此在時間軸上沒有位置。',
  'player.videoAbsent': '影片：{{title}}',
  'player.lastRecordedAction': '最後記錄的動作',
  'player.totalTimeUnavailable': '缺少錄影長度或仍在載入中，因此無法顯示完整的播放時間。',
  'player.noAnnotationTiming':
    '此錄影沒有儲存時間資訊，無法在影片上標示動作。請開啟「影格」查看已儲存的動作標示。',
  'player.hideAnnotations': '隱藏標註',
  'player.showAnnotations': '顯示標註',
  'player.enableMagnifier': '開啟放大鏡',
  'player.disableMagnifier': '關閉放大鏡',
  'player.enterFullscreen': '進入全螢幕',
  'player.exitFullscreen': '結束全螢幕',
  'player.fullscreenDialog': '全螢幕證據媒體',
  'player.videoUntimed': '此錄影無法與選取的動作同步。請切換到「影格」查看它的螢幕截圖。',

  'player.timeline.slider': '測試時間軸',
  'player.timeline.signals': '步驟訊號',
  'player.timeline.memberSlider': '測試時間軸：{{member}}',
  'player.timeline.noActions': '此測試沒有記錄任何動作',
  'player.timeline.memberNoActions': '{{member}}：沒有記錄任何動作',
  'player.timeline.step': '步驟 {{step}}',
  'player.timeline.memberStep': '{{member}}，步驟 {{step}}',
  'player.timeline.markerLabel': '{{place}}：{{action}}',
  'player.timeline.chooseNearby_other': '從附近的 {{count}} 個動作中選擇',
  'player.timeline.nearbyActions': '附近的動作',
  'player.timeline.marker':
    '步驟 {{step}}，第 {{index}} 個子動作，共 {{total}} 個：{{sentence}}，{{result}}',
  'player.timeline.markerAt':
    '步驟 {{step}}，第 {{index}} 個子動作，共 {{total}} 個：{{sentence}}，{{result}}，{{time}}',
  'player.timeline.readout': '第 {{index}} 個，共 {{total}} 個',
  'player.timeline.readoutAt': '第 {{index}} 個，共 {{total}} 個 · {{offset}} / {{extent}}',
} satisfies Translation<typeof en>
