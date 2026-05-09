import { useEffect } from 'react'

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1)
  }
  return s
}

export function usePageTitle(title: string) {
  useEffect(() => {
    document.title = `${stripQuotes(title)} | agent-qa`
    return () => { document.title = 'agent-qa' }
  }, [title])
}
