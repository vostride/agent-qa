// @vitest-environment jsdom

import { act, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

import { LanguageBlock } from '@/components/language-block'
import i18n, { applyLanguage } from '@/i18n'
import { LanguageProvider } from '@/i18n/language-provider'
import de from '@/i18n/locales/de'
import en from '@/i18n/locales/en'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const handed = vi.hoisted(() => ({
  onValueChange: undefined as ((value: string) => void) | undefined,
  loaders: new Map<string, () => Promise<{ default: Record<string, string> }>>(),
}))

vi.mock('@/i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/i18n')>()
  return {
    ...actual,
    applyLanguage: (language: Parameters<typeof actual.applyLanguage>[0]) =>
      actual.applyLanguage(language, handed.loaders.get(language)),
  }
})

vi.mock('@/components/ui/select', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/select')>()
  return {
    ...actual,
    Select: (props: ComponentProps<typeof actual.Select>) => {
      handed.onValueChange = props.onValueChange
      return <actual.Select {...props} />
    },
  }
})

const STORAGE_KEY = 'agent-qa.language'
const NAMES = [
  'English',
  '简体中文',
  '繁體中文',
  '日本語',
  '한국어',
  'Español',
  'Português (Brasil)',
  'Deutsch',
  'Français',
  'Русский',
]

let container: HTMLDivElement | null = null
let root: Root | null = null
let languages: MockInstance<() => readonly string[]> | undefined

async function mount(withProvider: boolean) {
  let tree: ReactNode = <LanguageBlock />
  if (withProvider) tree = <LanguageProvider>{tree}</LanguageProvider>
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(tree)
  })
  return container
}

function block() {
  return container!.querySelector<HTMLElement>('[data-language-block]')!
}

function trigger() {
  return container!.querySelector<HTMLElement>('[data-language-select]')!
}

function label() {
  return block().querySelector('label')!
}

function openOptions() {
  act(() => {
    trigger().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  return [...document.querySelectorAll<HTMLElement>('[role="option"]')]
}

function closeOptions() {
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
}

function choose(text: string) {
  const option = openOptions().find((node) => node.textContent === text)
  expect(option, `an option reading ${text}`).toBeDefined()
  act(() => {
    option!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
}

function chooseFirst() {
  const [first] = openOptions()
  act(() => {
    first!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
}

async function settledOn(language: string) {
  await act(() =>
    vi.waitFor(() => expect(document.documentElement.lang).toBe(language), { timeout: 15_000 }),
  )
}

async function idle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
}

beforeEach(() => {
  localStorage.clear()
  HTMLElement.prototype.scrollIntoView = vi.fn()
})

afterEach(async () => {
  if (root) act(() => root!.unmount())
  root = null
  container?.remove()
  container = null
  languages?.mockRestore()
  languages = undefined
  handed.loaders.clear()
  localStorage.clear()
  await act(async () => {
    await applyLanguage('en')
  })
})

describe('the language block', () => {
  it('renders a label, a select and one help line with no provider above it', async () => {
    await mount(false)

    expect(block()).not.toBeNull()
    expect(label().textContent).toBe(en['language.label'])
    expect(trigger()).not.toBeNull()
    expect(label().getAttribute('for')).toBe(trigger().id)
    expect(block().querySelectorAll('p')).toHaveLength(1)
    expect(block().querySelector('p')?.textContent).toBe(en['language.help'])
  })

  it('lists the browser entry first and then the ten languages by their own names', async () => {
    await mount(true)

    const options = openOptions()
    expect(options.map((node) => node.textContent)).toEqual([
      'Browser language (English)',
      ...NAMES,
    ])
    expect(options.slice(1).map((node) => node.getAttribute('lang'))).toEqual([
      'en',
      'zh-Hans',
      'zh-Hant',
      'ja',
      'ko',
      'es',
      'pt-BR',
      'de',
      'fr',
      'ru',
    ])
  })

  it('names the language a German browser resolves to in the first entry', async () => {
    languages = vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['de-CH'])
    await mount(true)

    expect(openOptions()[0]?.textContent).toBe('Browser language (Deutsch)')
  })

  it('switches the dashboard to German at once and saves the choice in this browser', async () => {
    await mount(true)

    choose('Deutsch')
    await settledOn('de')

    expect(localStorage.getItem(STORAGE_KEY)).toBe('de')
    expect(label().textContent).toBe(de['language.label'])
    expect(label().textContent).not.toBe(en['language.label'])
    expect(trigger().textContent).toBe('Deutsch')
    expect(openOptions().slice(1).map((node) => node.textContent)).toEqual(NAMES)
  })

  it('saves and applies a choice with no provider above it', async () => {
    await mount(false)

    choose('Deutsch')
    await settledOn('de')

    expect(localStorage.getItem(STORAGE_KEY)).toBe('de')
    expect(label().textContent).toBe(de['language.label'])
  })

  it('removes the saved choice and follows the browser when the first entry is chosen', async () => {
    await mount(true)
    choose('日本語')
    await settledOn('ja')
    expect(localStorage.getItem(STORAGE_KEY)).toBe('ja')

    chooseFirst()
    await settledOn('en')

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(trigger().textContent).toBe('Browser language (English)')
  })

  it('follows a German browser list when the first entry is chosen', async () => {
    languages = vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['de-CH'])
    await mount(true)
    choose('日本語')
    await settledOn('ja')

    chooseFirst()
    await settledOn('de')

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(label().textContent).toBe(de['language.label'])
  })

  it('ends on the later of two choices when the first finishes loading last', async () => {
    i18n.removeResourceBundle('de', 'translation')
    i18n.removeResourceBundle('ja', 'translation')
    let finishGerman = () => {}
    handed.loaders.set(
      'de',
      () => new Promise((resolve) => (finishGerman = () => resolve({ default: de }))),
    )
    await mount(true)

    choose('Deutsch')
    choose('日本語')
    await settledOn('ja')
    finishGerman()
    await idle()

    expect(localStorage.getItem(STORAGE_KEY)).toBe('ja')
    expect(document.documentElement.lang).toBe('ja')
    expect(trigger().textContent).toBe('日本語')
  })

  it('saves nothing and stays where it was when a language fails to load, then loads it on the same choice', async () => {
    i18n.removeResourceBundle('de', 'translation')
    handed.loaders.set('de', () => Promise.reject(new Error('offline')))
    await mount(true)

    choose('Deutsch')
    await idle()

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(document.documentElement.lang).toBe('en')
    expect(label().textContent).toBe(en['language.label'])
    expect(trigger().textContent).toBe('Browser language (English)')

    handed.loaders.delete('de')
    choose('Deutsch')
    await settledOn('de')

    expect(localStorage.getItem(STORAGE_KEY)).toBe('de')
    expect(trigger().textContent).toBe('Deutsch')
  })

  it('keeps the earlier saved choice when a later one fails to load', async () => {
    i18n.removeResourceBundle('de', 'translation')
    handed.loaders.set('de', () => Promise.reject(new Error('offline')))
    await mount(true)
    choose('日本語')
    await settledOn('ja')

    choose('Deutsch')
    await idle()

    expect(localStorage.getItem(STORAGE_KEY)).toBe('ja')
    expect(document.documentElement.lang).toBe('ja')
    expect(trigger().textContent).toBe('日本語')
  })

  it('shows the language the page is in when the saved one did not load, and loads it when chosen', async () => {
    localStorage.setItem(STORAGE_KEY, 'de')
    await mount(true)

    expect(document.documentElement.lang).toBe('en')
    expect(trigger().textContent).toBe('English')

    choose('Deutsch')
    await settledOn('de')

    expect(trigger().textContent).toBe('Deutsch')
  })

  it('does not follow a choice another tab saved when its language fails to load here', async () => {
    i18n.removeResourceBundle('de', 'translation')
    handed.loaders.set('de', () => Promise.reject(new Error('offline')))
    await mount(true)

    localStorage.setItem(STORAGE_KEY, 'de')
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY, newValue: 'de' }))
    })
    await idle()

    expect(document.documentElement.lang).toBe('en')
    expect(trigger().textContent).toBe('Browser language (English)')
  })

  it('follows a choice another tab saved', async () => {
    await mount(true)

    localStorage.setItem(STORAGE_KEY, 'ja')
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY, newValue: 'ja' }))
    })
    await settledOn('ja')

    expect(trigger().textContent).toBe('日本語')
  })

  it('treats a value another tab saved outside the ten codes as no saved choice', async () => {
    await mount(true)
    choose('Deutsch')
    await settledOn('de')

    localStorage.setItem(STORAGE_KEY, 'xx')
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY, newValue: 'xx' }))
    })
    await settledOn('en')

    expect(trigger().textContent).toBe('Browser language (English)')
  })

  it('goes back to the browser language when another tab removes the saved choice', async () => {
    await mount(true)
    choose('Deutsch')
    await settledOn('de')

    localStorage.removeItem(STORAGE_KEY)
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY, newValue: null }))
    })
    await settledOn('en')

    expect(trigger().textContent).toBe('Browser language (English)')
  })

  it('ignores a storage event for another key', async () => {
    await mount(true)
    choose('Deutsch')
    await settledOn('de')

    localStorage.removeItem(STORAGE_KEY)
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'vite-ui-theme', newValue: 'light' }))
    })
    await idle()

    expect(document.documentElement.lang).toBe('de')
    expect(trigger().textContent).toBe('Deutsch')
  })

  it('re-resolves the language when the browser list changes and no choice is saved', async () => {
    await mount(true)
    languages = vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['de-CH'])

    act(() => {
      window.dispatchEvent(new Event('languagechange'))
    })
    await settledOn('de')

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('keeps a saved choice when the browser list changes', async () => {
    await mount(true)
    choose('日本語')
    await settledOn('ja')
    languages = vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['de-CH'])

    act(() => {
      window.dispatchEvent(new Event('languagechange'))
    })
    await idle()

    expect(document.documentElement.lang).toBe('ja')
    expect(localStorage.getItem(STORAGE_KEY)).toBe('ja')
  })

  it('changes nothing for a value outside the browser entry and the ten codes', async () => {
    await mount(true)
    closeOptions()
    expect(handed.onValueChange).toBeTypeOf('function')

    act(() => handed.onValueChange!('xx'))
    act(() => handed.onValueChange!('../de'))
    await idle()

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(document.documentElement.lang).toBe('en')
    expect(trigger().textContent).toBe('Browser language (English)')
  })
})
