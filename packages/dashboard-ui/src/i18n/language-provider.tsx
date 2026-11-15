import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

import { applyLanguage } from '.'
import {
  LANGUAGE_STORAGE_KEY,
  browserLanguage,
  readLanguageChoice,
  resolveLanguage,
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

function choose(choice: LanguageChoice): void {
  storeLanguageChoice(choice)
  void applyLanguage(choice === 'browser' ? browserLanguage() : choice)
}

const LanguageContext = createContext<LanguageState | undefined>(undefined)

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [choice, setChoiceState] = useState<LanguageChoice>(savedChoice)

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== LANGUAGE_STORAGE_KEY) return
      setChoiceState(savedChoice())
      void applyLanguage(resolveLanguage())
    }
    const onLanguageChange = () => {
      if (readLanguageChoice() === undefined) void applyLanguage(browserLanguage())
    }
    window.addEventListener('storage', onStorage)
    window.addEventListener('languagechange', onLanguageChange)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('languagechange', onLanguageChange)
    }
  }, [])

  const setChoice = useCallback((next: LanguageChoice) => {
    choose(next)
    setChoiceState(next)
  }, [])
  const value = useMemo(() => ({ choice, setChoice }), [choice, setChoice])

  return <LanguageContext value={value}>{children}</LanguageContext>
}

export function useLanguage(): LanguageState {
  return useContext(LanguageContext) ?? { choice: savedChoice(), setChoice: choose }
}
