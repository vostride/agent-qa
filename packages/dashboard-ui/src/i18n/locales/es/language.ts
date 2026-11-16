import type en from '../en'
import type { Translation } from '../../translation'

export default {
  'language.label': 'Idioma',
  'language.followBrowser': 'Idioma del navegador ({{language}})',
  'language.help': 'Se guarda solo en este navegador. No se escribe nada en agent-qa.config.yaml.',
} satisfies Translation<typeof en>
