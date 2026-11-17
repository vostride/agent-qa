// @vitest-environment jsdom

import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SuiteMetadataForm } from '@/components/suite-metadata-form'
import { SuiteTestPicker } from '@/components/suite-test-picker'
import { TestMetadataForm } from '@/components/test-metadata-form'
import i18n, { applyLanguage } from '@/i18n'
import de from '@/i18n/locales/de'
import en from '@/i18n/locales/en'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/hooks/use-targets', () => ({
  useTargets: () => ({ targets: [], isLoading: false }),
}))

vi.mock('@/hooks/use-target-details', () => ({
  useTargetDetails: () => ({ targets: {}, globalUse: null, isLoading: false }),
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactElement }) => children,
  TooltipTrigger: ({ children }: { children: ReactElement }) => children,
  TooltipContent: ({ children }: { children: ReactElement }) => children,
}))

vi.mock('@/components/step-autocomplete', () => ({
  useStepAutocomplete: () => ({
    visible: false,
    setVisible: () => {},
    handleKeyDown: () => false,
    dropdown: null,
  }),
}))

type Key = 'suites.picker.noTests' | 'suites.form.noTargets' | 'editor.forms.noTargets'

const CASES: { name: string; key: Key; href: string; element: ReactElement }[] = [
  {
    name: 'the suite test picker with no test files',
    key: 'suites.picker.noTests',
    href: '/tests/new',
    element: <SuiteTestPicker availableTests={[]} onAdd={() => {}} />,
  },
  {
    name: 'the suite form with no targets',
    key: 'suites.form.noTargets',
    href: '/config',
    element: (
      <SuiteMetadataForm
        name=""
        suiteId="s_able-acre"
        target=""
        context=""
        isCreateMode
        suggestions={[]}
        onChange={() => {}}
      />
    ),
  },
  {
    name: 'the test form with no targets',
    key: 'editor.forms.noTargets',
    href: '/config',
    element: (
      <TestMetadataForm
        name=""
        testId="t_able-acre"
        target=""
        context=""
        isCreateMode
        onChange={() => {}}
      />
    ),
  },
]

let container: HTMLDivElement | undefined
let root: Root | undefined

afterEach(async () => {
  if (root) act(() => root!.unmount())
  container?.remove()
  root = undefined
  container = undefined
  await act(async () => {
    await applyLanguage('en')
  })
  i18n.removeResourceBundle('de', 'translation')
})

function linkWords(sentence: string): string {
  const words = /<(\w+)>(.+)<\/\1>/.exec(sentence)?.[2]
  if (!words) throw new Error(`no tagged words in: ${sentence}`)
  return words
}

function withoutTags(sentence: string): string {
  return sentence.replace(/<\/?\w+>/g, '')
}

async function mount(element: ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<MemoryRouter>{element}</MemoryRouter>)
  })
  return container
}

describe('the link inside an empty-state sentence', () => {
  it.each(CASES)('$name holds its words in English and in German', async ({ key, href, element }) => {
    expect(linkWords(de[key])).not.toBe(linkWords(en[key]))
    const view = await mount(element)
    const link = () => view.querySelector(`a[href="${href}"]`)

    expect(link()?.textContent).toBe(linkWords(en[key]))
    expect(link()?.parentElement?.textContent).toBe(withoutTags(en[key]))

    await act(async () => {
      await applyLanguage('de')
    })

    expect(link()?.textContent).toBe(linkWords(de[key]))
    expect(link()?.parentElement?.textContent).toBe(withoutTags(de[key]))
  })
})
