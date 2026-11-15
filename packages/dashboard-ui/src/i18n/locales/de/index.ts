import type en from '../en'
import type { Translation } from '../../translation'
import language from './language'
import nav from './nav'

export default { ...nav, ...language } satisfies Translation<typeof en>
