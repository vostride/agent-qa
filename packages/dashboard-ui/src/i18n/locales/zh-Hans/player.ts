import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'player.frames': '帧',
  'player.video': '视频',
  'player.source': '播放来源',
  'player.framesTooltip': '模型做出决策时看到的原始截图',
  'player.play': '播放录制',
  'player.pause': '暂停录制',
  'player.speed': '播放速度',
  'player.substitution': '正在显示第 {{shown}} 个，共 {{total}} 个。这是最近一个有截图的子操作',
  'player.lightboxTitle': '引用的截图',
  'player.lightboxClose': '关闭截图',
  'player.lightboxNote':
    '此截图被分析引用，但不属于任何已记录的子操作，因此在时间线上没有位置。',
  'player.videoAbsent': '视频：{{title}}',
  'player.lastRecordedAction': '最后记录的操作',
  'player.totalTimeUnavailable': '无法显示完整播放时长，因为缺少录制时长或仍在加载中。',
  'player.noAnnotationTiming':
    '此录制没有保存用于在视频上放置操作高亮的时间信息。打开“帧”可查看已保存的操作高亮。',
  'player.hideAnnotations': '隐藏标注',
  'player.showAnnotations': '显示标注',
  'player.enableMagnifier': '开启放大镜',
  'player.disableMagnifier': '关闭放大镜',
  'player.enterFullscreen': '进入全屏',
  'player.exitFullscreen': '退出全屏',
  'player.fullscreenDialog': '证据媒体全屏',
  'player.videoUntimed': '此录制无法与所选操作同步。切换到“帧”可查看其截图。',

  'player.timeline.slider': '测试时间线',
  'player.timeline.signals': '步骤信号',
  'player.timeline.memberSlider': '测试时间线：{{member}}',
  'player.timeline.noActions': '此测试没有记录任何操作',
  'player.timeline.memberNoActions': '{{member}}：没有记录任何操作',
  'player.timeline.step': '第 {{step}} 步',
  'player.timeline.memberStep': '{{member}}，第 {{step}} 步',
  'player.timeline.markerLabel': '{{place}}：{{action}}',
  'player.timeline.chooseNearby_other': '从附近的 {{count}} 个操作中选择',
  'player.timeline.nearbyActions': '附近的操作',
  'player.timeline.marker':
    '第 {{step}} 步，第 {{index}} 个子操作，共 {{total}} 个：{{sentence}}，{{result}}',
  'player.timeline.markerAt':
    '第 {{step}} 步，第 {{index}} 个子操作，共 {{total}} 个：{{sentence}}，{{result}}，{{time}}',
  'player.timeline.readout': '第 {{index}} 个，共 {{total}} 个',
  'player.timeline.readoutAt': '第 {{index}} 个，共 {{total}} 个 · {{offset}} / {{extent}}',
} satisfies Translation<typeof en>
