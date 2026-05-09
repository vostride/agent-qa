import { useEffect, useLayoutEffect, useRef } from "react"

type ShortcutMap = Record<string, (e: KeyboardEvent) => void>

export function useKeyboardShortcuts(shortcuts: ShortcutMap): void {
  const shortcutsRef = useRef(shortcuts)

  useLayoutEffect(() => {
    shortcutsRef.current = shortcuts
  }, [shortcuts])

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const target = e.target as HTMLElement
      const tag = target.tagName

      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) {
        // Allow shortcuts through when focused on a read-only Monaco editor
        const isReadOnlyMonaco =
          tag === "TEXTAREA" &&
          target.getAttribute("aria-readonly") === "true" &&
          target.closest(".monaco-editor")
        if (!isReadOnlyMonaco) {
          if (e.key === "Escape") {
            target.blur()
          }
          return
        }
      }

      const key = e.key.toLowerCase()

      // Support shift+key compound shortcuts (e.g., shift+arrowdown)
      if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const compoundKey = `shift+${key}`
        const fn = shortcutsRef.current[compoundKey]
        if (fn) {
          e.preventDefault()
          fn(e)
          return
        }
      }

      if (e.key !== "Escape" && (e.ctrlKey || e.metaKey || e.altKey)) {
        if (!((e.metaKey || e.ctrlKey) && key === "enter")) {
          return
        }
      }

      // Block shift+key from triggering non-compound shortcuts
      if (e.shiftKey && e.key !== "Escape") {
        return
      }

      const fn = shortcutsRef.current[key]
      if (fn) {
        e.preventDefault()
        fn(e)
      }
    }

    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [])
}
