import '@/i18n'

// The dashboard follows the browser's language, so every test file starts from US English
// whatever the machine is set to. A test that needs another list replaces these getters.
Object.defineProperty(navigator, 'languages', { configurable: true, get: () => ['en-US'] })
Object.defineProperty(navigator, 'language', { configurable: true, get: () => 'en-US' })
