import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'status.passed': 'Bestanden',
  'status.failed': 'Fehlgeschlagen',
  'status.timedOut': 'Timeout',
  'status.cancelled': 'Abgebrochen',
  'status.healed': 'Repariert',
  'status.flaky': 'Instabil',
  'status.skipped': 'Übersprungen',
  'status.running': 'Läuft',
  'status.pending': 'Ausstehend',
  'status.queued': 'In Warteschlange',
  'status.unknown': 'Unbekannt',
  'status.name.idle': 'inaktiv',
  'status.name.pending': 'ausstehend',
  'status.name.running': 'läuft',
  'status.name.cancelling': 'wird abgebrochen',
  'status.name.passed': 'bestanden',
  'status.name.failed': 'fehlgeschlagen',
  'status.name.healed': 'repariert',
  'status.name.flaky': 'instabil',
  'status.name.skipped': 'übersprungen',
  'status.name.cancelled': 'abgebrochen',
  'status.name.timeout': 'Timeout',
} satisfies Translation<typeof en>
