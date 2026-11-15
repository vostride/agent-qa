import language from './language'
import nav from './nav'
import time from './time'

export default { ...nav, ...language, ...time } as const
