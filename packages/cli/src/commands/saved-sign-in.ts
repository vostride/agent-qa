// The facts listSavedCredentials hands out for a saved sign-in.
interface SavedSignIn {
  renews: boolean
  expires?: number
  signedInAt?: number
}

export interface SignInClock {
  now: number
  timeZone?: string
}

interface SignInState {
  status: string
  expired?: string
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function moment(epoch: number, timeZone: string | undefined): { day: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).formatToParts(epoch)
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? ''
  return {
    day: `${Number(part('day'))} ${MONTHS[Number(part('month')) - 1]} ${part('year')}`,
    time: `${part('hour')}:${part('minute')}`,
  }
}

// A sign-in that holds a refresh token is never given an end: the store keeps none for the
// refresh token, and the provider ends it without telling the store.
export function readSignIn(signIn: SavedSignIn, clock: SignInClock): SignInState {
  const signedIn =
    signIn.signedInAt === undefined
      ? 'signed in'
      : `signed in ${moment(signIn.signedInAt, clock.timeZone).day}`
  if (signIn.expires === undefined) return { status: signedIn }
  const expired = signIn.expires < clock.now
  if (signIn.renews) {
    return { status: `${signedIn} · ${expired ? 'renews on next use' : 'valid, renews itself'}` }
  }
  const end = moment(signIn.expires, clock.timeZone)
  if (!expired) return { status: `${signedIn} · valid until ${end.day} ${end.time}` }
  return {
    status: `expired ${end.day} ${end.time} · sign in again after setup`,
    expired: `the sign-in expired ${end.day} ${end.time}`,
  }
}
