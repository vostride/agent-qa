import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'status.passed': 'Aprobado',
  'status.failed': 'Fallido',
  'status.timedOut': 'Tiempo agotado',
  'status.cancelled': 'Cancelado',
  'status.healed': 'Reparado',
  'status.flaky': 'Inestable',
  'status.skipped': 'Omitido',
  'status.running': 'En curso',
  'status.pending': 'Pendiente',
  'status.queued': 'En cola',
  'status.unknown': 'Desconocido',
  'status.name.idle': 'inactivo',
  'status.name.pending': 'pendiente',
  'status.name.running': 'en curso',
  'status.name.cancelling': 'cancelando',
  'status.name.passed': 'aprobado',
  'status.name.failed': 'fallido',
  'status.name.healed': 'reparado',
  'status.name.flaky': 'inestable',
  'status.name.skipped': 'omitido',
  'status.name.cancelled': 'cancelado',
  'status.name.timeout': 'tiempo agotado',
} satisfies Translation<typeof en>
