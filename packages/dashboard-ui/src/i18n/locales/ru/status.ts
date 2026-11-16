import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'status.passed': 'Пройден',
  'status.failed': 'Провален',
  'status.timedOut': 'Тайм-аут',
  'status.cancelled': 'Отменён',
  'status.healed': 'Исправлен',
  'status.flaky': 'Нестабилен',
  'status.skipped': 'Пропущен',
  'status.running': 'Выполняется',
  'status.pending': 'Ожидает',
  'status.queued': 'В очереди',
  'status.unknown': 'Неизвестно',
  'status.name.idle': 'неактивен',
  'status.name.pending': 'ожидает',
  'status.name.running': 'выполняется',
  'status.name.cancelling': 'отменяется',
  'status.name.passed': 'пройден',
  'status.name.failed': 'провален',
  'status.name.healed': 'исправлен',
  'status.name.flaky': 'нестабилен',
  'status.name.skipped': 'пропущен',
  'status.name.cancelled': 'отменён',
  'status.name.timeout': 'тайм-аут',
} satisfies Translation<typeof en>
