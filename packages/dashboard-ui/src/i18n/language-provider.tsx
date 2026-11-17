import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

import i18n, { applyLanguage } from '.'
import {
  LANGUAGE_STORAGE_KEY,
  browserLanguage,
  isLanguage,
  readLanguageChoice,
  storeLanguageChoice,
  type LanguageChoice,
} from './languages'

type LanguageState = {
  choice: LanguageChoice
  setChoice: (choice: LanguageChoice) => void
}

function savedChoice(): LanguageChoice {
  return readLanguageChoice() ?? 'browser'
}

// The saved choice, unless its language did not load: then the language the page is in.
function choiceInEffect(): LanguageChoice {
  const saved = savedChoice()
  const wanted = saved === 'browser' ? browserLanguage() : saved
  return wanted === i18n.language || !isLanguage(i18n.language) ? saved : i18n.language
}

function apply(choice: LanguageChoice): Promise<boolean> {
  return applyLanguage(choice === 'browser' ? browserLanguage() : choice)
}

async function choose(choice: LanguageChoice): Promise<boolean> {
  const applied = await apply(choice)
  if (applied) storeLanguageChoice(choice)
  return applied
}

const LanguageContext = createContext<LanguageState | undefined>(undefined)

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [choice, setChoiceState] = useState<LanguageChoice>(choiceInEffect)

  const follow = useCallback((next: LanguageChoice, applied: Promise<boolean>) => {
    void applied.then((done) => {
      if (done) setChoiceState(next)
    })
  }, [])

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== LANGUAGE_STORAGE_KEY) return
      const saved = savedChoice()
      follow(saved, apply(saved))
    }
    const onLanguageChange = () => {
      if (readLanguageChoice() === undefined) follow('browser', apply('browser'))
    }
    window.addEventListener('storage', onStorage)
    window.addEventListener('languagechange', onLanguageChange)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('languagechange', onLanguageChange)
    }
  }, [follow])

  const setChoice = useCallback((next: LanguageChoice) => follow(next, choose(next)), [follow])
  const value = useMemo(() => ({ choice, setChoice }), [choice, setChoice])

  return <LanguageContext value={value}>{children}</LanguageContext>
}

export function useLanguage(): LanguageState {
  return useContext(LanguageContext) ?? { choice: choiceInEffect(), setChoice: choose }
}
