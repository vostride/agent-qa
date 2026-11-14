// @vitest-environment jsdom
import { act, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest"

import {
  LanguageProvider,
  LOCALE_STORAGE_KEY,
  getLocale,
  setLocale,
  t,
  translate,
  useI18n,
  type Locale,
  type TParams,
} from "@/lib/i18n"

vi.mock("@/lib/locales/zh-CN", () => ({
  default: {
    Runs: "\u8fd0\u884c\u8bb0\u5f55",
    "nav.tests": "\u6d4b\u8bd5",
    "Showing {start} / {count}": "\u663e\u793a {start} / {count}",
    "Total {count} items": "\u5171 {count} \u6761",
    "Keeps {unknown} token": "\u4fdd\u7559 {unknown} \u5360\u4f4d\u7b26",
  },
}))

type StorageMock = {
  getItem: Mock<(key: string) => string | null>
  setItem: Mock<(key: string, value: string) => void>
  removeItem: Mock<(key: string) => void>
  clear: Mock<() => void>
  key: Mock<(index: number) => string | null>
  length: number
}

function installStorage(initial: Record<string, string> = {}): StorageMock {
  const map = new Map(Object.entries(initial))
  const storage: StorageMock = {
    getItem: vi.fn((key: string) => (map.has(key) ? (map.get(key) as string) : null)),
    setItem: vi.fn((key: string, value: string) => {
      map.set(key, String(value))
    }),
    removeItem: vi.fn((key: string) => {
      map.delete(key)
    }),
    clear: vi.fn(() => {
      map.clear()
    }),
    key: vi.fn(() => null),
    length: map.size,
  }
  vi.stubGlobal("localStorage", storage)
  return storage
}

function installNavigator(language: string) {
  vi.stubGlobal("navigator", { language, languages: [language] })
}

function LocaleProbe() {
  const { locale, setLocale: setLocaleValue, t } = useI18n()
  return (
    <div>
      <span data-testid="locale">{locale}</span>
      <span data-testid="runs">{t("Runs")}</span>
      <span data-testid="missing">{t("nope.missing")}</span>
      <button type="button" data-testid="set-zh" onClick={() => setLocaleValue("zh-CN")}>
        中文
      </button>
      <button type="button" data-testid="set-en" onClick={() => setLocaleValue("en")}>
        EN
      </button>
    </div>
  )
}

let container: HTMLDivElement | null = null
let root: Root | null = null

async function renderProvider(initialLocale?: Locale, children: ReactNode = <LocaleProbe />) {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)

  await act(async () => {
    root!.render(
      initialLocale ? (
        <LanguageProvider initialLocale={initialLocale}>{children}</LanguageProvider>
      ) : (
        <LanguageProvider>{children}</LanguageProvider>
      ),
    )
  })

  return container
}

function ParamsProbe() {
  const { t: translateKey } = useI18n()
  return (
    <div>
      <span data-testid="page">{translateKey("Showing {start} / {count}", { start: 1, count: 12 })}</span>
      <span data-testid="unknown">{translateKey("Keeps {unknown} token", { count: 3 })}</span>
      <span data-testid="plain">{translateKey("Runs")}</span>
    </div>
  )
}

function textOf(testId: string): string {
  return container!.querySelector(`[data-testid="${testId}"]`)!.textContent ?? ""
}

function clickOf(testId: string) {
  return act(async () => {
    ;(container!.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement).click()
  })
}

beforeEach(() => {
  document.documentElement.removeAttribute("lang")
})

afterEach(() => {
  if (root) {
    act(() => root!.unmount())
  }
  root = null
  if (container) container.remove()
  container = null
  document.documentElement.removeAttribute("lang")
  vi.unstubAllGlobals()
})

describe("getLocale", () => {
  it("prefers a valid localStorage value over the browser language", () => {
    installStorage({ [LOCALE_STORAGE_KEY]: "zh-CN" })
    installNavigator("en-US")
    expect(getLocale()).toBe("zh-CN")
  })

  it("falls back to navigator.language when storage is empty", () => {
    installStorage()
    installNavigator("zh-CN")
    expect(getLocale()).toBe("zh-CN")
    installNavigator("zh")
    expect(getLocale()).toBe("zh-CN")
    installNavigator("zh-TW")
    expect(getLocale()).toBe("zh-CN")
    installNavigator("en-US")
    expect(getLocale()).toBe("en")
    installNavigator("fr")
    expect(getLocale()).toBe("en")
  })

  it("ignores invalid localStorage values and defers to the browser", () => {
    installStorage({ [LOCALE_STORAGE_KEY]: "fr-FR" })
    installNavigator("zh-CN")
    expect(getLocale()).toBe("zh-CN")
    installNavigator("de")
    expect(getLocale()).toBe("en")
  })

  it("is safe in a non-DOM host with no localStorage or navigator", () => {
    vi.stubGlobal("localStorage", undefined)
    vi.stubGlobal("navigator", undefined)
    expect(getLocale()).toBe("en")
    expect(() => setLocale("zh-CN")).not.toThrow()
  })

  it("treats a throwing storage as no preference", () => {
    installStorage()
    ;(globalThis.localStorage as StorageMock).getItem = vi.fn(() => {
      throw new Error("SecurityError")
    })
    installNavigator("zh-CN")
    expect(getLocale()).toBe("zh-CN")
  })
})

describe("setLocale", () => {
  it("writes the locale under the agent-qa.locale key", () => {
    const storage = installStorage()
    installNavigator("en-US")
    setLocale("zh-CN")
    expect(storage.setItem).toHaveBeenCalledWith(LOCALE_STORAGE_KEY, "zh-CN")
    expect(storage.getItem(LOCALE_STORAGE_KEY)).toBe("zh-CN")
    setLocale("en")
    expect(storage.getItem(LOCALE_STORAGE_KEY)).toBe("en")
  })
})

describe("translate via useI18n().t", () => {
  it("returns the key itself for English", async () => {
    await renderProvider("en")
    expect(textOf("locale")).toBe("en")
    expect(textOf("runs")).toBe("Runs")
    expect(textOf("missing")).toBe("nope.missing")
  })

  it("returns dictionary entries for zh-CN and falls back to the key when missing", async () => {
    await renderProvider("zh-CN")
    expect(textOf("locale")).toBe("zh-CN")
    expect(textOf("runs")).toBe("运行记录")
    expect(textOf("missing")).toBe("nope.missing")
  })
})

describe("LanguageProvider", () => {
  it("detects the locale from storage when no initialLocale is given", async () => {
    installStorage({ [LOCALE_STORAGE_KEY]: "zh-CN" })
    installNavigator("en-US")
    await renderProvider(undefined)
    expect(textOf("locale")).toBe("zh-CN")
    expect(textOf("runs")).toBe("运行记录")
  })

  it("updates storage, re-renders, and syncs documentElement.lang on setLocale", async () => {
    const storage = installStorage()
    installNavigator("en-US")
    await renderProvider(undefined)

    expect(textOf("locale")).toBe("en")
    expect(document.documentElement.lang).toBe("en")

    await clickOf("set-zh")
    expect(storage.setItem).toHaveBeenCalledWith(LOCALE_STORAGE_KEY, "zh-CN")
    expect(textOf("locale")).toBe("zh-CN")
    expect(textOf("runs")).toBe("运行记录")
    expect(document.documentElement.lang).toBe("zh-CN")

    await clickOf("set-en")
    expect(textOf("locale")).toBe("en")
    expect(textOf("runs")).toBe("Runs")
    expect(document.documentElement.lang).toBe("en")
  })
})

describe("interpolation", () => {
  it("interpolates the key itself for English", () => {
    expect(translate("en", "Showing {start} / {count}", { start: 1, count: 12 })).toBe(
      "Showing 1 / 12",
    )
  })

  it("interpolates the zh-CN translation for zh-CN", () => {
    expect(translate("zh-CN", "Total {count} items", { count: 9 })).toBe("共 9 条")
  })

  it("interpolates the key when the zh-CN entry is missing", () => {
    expect(translate("zh-CN", "Total {count} items {nope}", { count: 9 })).toBe(
      "Total 9 items {nope}",
    )
  })

  it("keeps the template untouched when params are omitted", () => {
    expect(translate("en", "Total {count} items")).toBe("Total {count} items")
    expect(translate("zh-CN", "Runs", { count: 1 })).toBe("运行记录")
  })

  it("keeps placeholders that are not simple identifiers", () => {
    expect(translate("en", "100% { } {1} {a-b} {ok}", { ok: 5, a: 7, b: 2 })).toBe(
      "100% { } {1} {a-b} 5",
    )
  })

  it("replaces every occurrence of a known placeholder", () => {
    expect(translate("en", "{a}/{a}", { a: "x" })).toBe("x/x")
  })

  it("never renders unsupported values", () => {
    const objects = { start: { nested: true }, count: [1, 2] } as unknown as TParams
    expect(translate("en", "Showing {start} / {count}", objects)).toBe("Showing {start} / {count}")
    for (const value of [true, false, null, undefined, () => 1]) {
      const params = { count: value } as unknown as TParams
      expect(translate("en", "Total {count} items", params)).toBe("Total {count} items")
    }
  })

  it("treats replacement patterns inside values as literal text", () => {
    expect(translate("en", "Total {count} items", { count: "$&" })).toBe("Total $& items")
  })

  it("supports the module-level t for the detected locale", () => {
    installStorage({ [LOCALE_STORAGE_KEY]: "zh-CN" })
    installNavigator("en-US")
    expect(t("Total {count} items", { count: 4 })).toBe("共 4 条")

    installStorage({ [LOCALE_STORAGE_KEY]: "en" })
    expect(t("Showing {start} / {count}", { start: 2, count: 8 })).toBe("Showing 2 / 8")
    expect(t("Runs")).toBe("Runs")
  })

  it("supports useI18n().t for both locales", async () => {
    await renderProvider("zh-CN", <ParamsProbe />)
    expect(textOf("page")).toBe("显示 1 / 12")
    expect(textOf("unknown")).toBe("保留 {unknown} 占位符")
    expect(textOf("plain")).toBe("运行记录")
  })

  it("supports useI18n().t with an English provider", async () => {
    await renderProvider("en", <ParamsProbe />)
    expect(textOf("page")).toBe("Showing 1 / 12")
    expect(textOf("unknown")).toBe("Keeps {unknown} token")
    expect(textOf("plain")).toBe("Runs")
  })
})
// NOTE: catalog coverage of every statically translated key lives in
// ./i18n-coverage.test.ts, which scans the sources instead of asserting strings.
