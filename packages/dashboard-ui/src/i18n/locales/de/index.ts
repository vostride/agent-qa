import type en from '../en'
import type { Translation } from '../../translation'
import nav from './nav'

export default { ...nav } satisfies Translation<typeof en>
