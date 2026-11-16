import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'status.passed': '通过',
  'status.failed': '失败',
  'status.timedOut': '超时',
  'status.cancelled': '已取消',
  'status.healed': '已修复',
  'status.flaky': '不稳定',
  'status.skipped': '已跳过',
  'status.running': '运行中',
  'status.pending': '待处理',
  'status.queued': '排队中',
  'status.unknown': '未知',
  'status.name.idle': '空闲',
  'status.name.pending': '待处理',
  'status.name.running': '运行中',
  'status.name.cancelling': '正在取消',
  'status.name.passed': '通过',
  'status.name.failed': '失败',
  'status.name.healed': '已修复',
  'status.name.flaky': '不稳定',
  'status.name.skipped': '已跳过',
  'status.name.cancelled': '已取消',
  'status.name.timeout': '超时',
} satisfies Translation<typeof en>
