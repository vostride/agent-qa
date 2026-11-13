export interface PlaygroundAppFile {
  readonly file: string
  readonly sha256: string
  readonly bytes: number
  // The oldest OS the build installs on, as the build states it.
  readonly minOs: string
}

export interface PlaygroundAppPin {
  readonly repository: string
  readonly tag: string
  readonly android: PlaygroundAppFile
  readonly ios: PlaygroundAppFile
}

// The one Playground release this agent-qa release downloads. It moves only with an agent-qa
// release, after the example tests pass on the new build.
export const PLAYGROUND_APP_PIN: PlaygroundAppPin = {
  repository: 'vostride/playground',
  tag: 'mobile-26.11.02-1ba82a3',
  android: {
    file: 'playground-android-26.11.02-1ba82a3.apk',
    sha256: 'd2d0863603342fd9e4052e916582b7af7dceda017f87af908d4898397b35e124',
    bytes: 55357571,
    // The APK's minSdkVersion is 24.
    minOs: '7.0',
  },
  ios: {
    file: 'playground-ios-simulator-26.11.02-1ba82a3.zip',
    sha256: '268430d2a9a5c07a6b4f840d0b6a658df6fb3adbd3811d8f059f344a2a5baa90',
    bytes: 10151499,
    // The app's MinimumOSVersion.
    minOs: '15.1',
  },
}

// Relative to the project folder.
export const PLAYGROUND_APP_PATHS: { readonly android: string; readonly ios: string } = {
  android: `app-bundles/${PLAYGROUND_APP_PIN.android.file}`,
  ios: 'app-bundles/Playground.app',
}

export const PLAYGROUND_APP_ID = 'dev.vostride.playground'
export const PLAYGROUND_ANDROID_ACTIVITY = '.MainActivity'

export function playgroundAppUrl(pin: PlaygroundAppPin, runtime: 'android' | 'ios'): string {
  return `https://github.com/${pin.repository}/releases/download/${pin.tag}/${pin[runtime].file}`
}
