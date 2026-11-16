# Translating the dashboard

This file is for whoever writes or updates a language of the dashboard UI. It holds the rules for
writing a catalog, what stays in English, the plural forms, how an action sentence is written, the
notes for each area of the catalog, and for each of the nine languages a tone note and one agreed
word for every product noun, status word, shared button word and action verb.

English is the source. A change that adds or rewords English text updates the nine languages in the
same change, with the words of this file. A key a language does not have shows its English text,
and so does an empty value: a translation is never written as an empty string.

The languages, with their codes and their own names: `zh-Hans` 简体中文, `zh-Hant` 繁體中文, `ja`
日本語, `ko` 한국어, `es` Español, `pt-BR` Português (Brasil), `de` Deutsch, `fr` Français, `ru`
Русский. This file is not shipped: the package publishes `dist` only.

## How a translation is written

### Files and keys

- A language's files sit in `locales/<code>/`, one file per English area file, with the same name:
  `locales/de/runDetail.ts` translates `locales/en/runDetail.ts`. Each is registered in
  `locales/<code>/index.ts`, which spreads them, as the English `index.ts` does.
- A file holds the same keys as its English file, in the same order, and ends with
  `satisfies Translation<typeof en>`. It imports only types:

  ```ts
  import type en from '../en'
  import type { Translation } from '../../translation'

  export default {
    'nav.runs': 'Läufe',
  } satisfies Translation<typeof en>
  ```

- A key name is the English key name exactly. The type checker refuses a key English does not have.
  No key name holds the text `gateRun` or `excludedFromOutcomes`: a test elsewhere in the tree scans
  every source line for those two words and expects a fixed list of files.
- A value is a single-quoted string, or a double-quoted one when it holds an apostrophe, formatted
  like the English files (no semicolons, trailing commas, lines up to 100 characters).

### Rules for every language

- **Slots.** Every `{{slot}}` of the English text is kept exactly, with the same name, as often as
  the English writes it (once in every English string), wherever the language puts it. A slot name
  is never translated: `{{name}}`, `{{count}}`, `{{target}}`, `{{reason}}`, `{{reference}}`,
  `{{issue}}`, `{{sentence}}`, `{{steps}}` and every other. A slot is filled in by the code, so the
  text around it must read with any value: a name, a number, a sentence.
- **Tags.** A tag of the English text (`<link>…</link>`) is kept as a bare tag, with no attribute,
  around the words of the language that do the same job. A tag never carries an attribute such as
  `href` or `class`: an attribute written in a catalog string replaces the one the code sets, so it
  could send a link somewhere else. The code sets every link's address.
- **Plural forms.** A key that ends in `_one` or `_other` is a plural key: write the forms the
  language has, as § Plural forms says, and always `_other`.
- **Spaces.** A value never begins or ends with a space. Where a sentence is joined to another piece,
  the code or a template carries the space.
- **Whole sentences.** A sentence is translated as a whole, in the language's own word order. Slots
  may move. Punctuation, quotation marks, particles, articles and prepositions belong in the
  template; the code adds none.
- **Sentences the code splits at a slot.** Some sentences are split at a slot so that the value can
  be a link, a control or a highlighted name. Each keeps that slot exactly once:
  - the action templates of `action.*` (§ Action sentences);
  - `editor.settings.inherited` (`{{value}}`);
  - `config.remoteNotListed`, `config.remoteUnlistedChoice` and `config.remotePickNotListed`
    (`{{name}}`);
  - every `knowledge.stepRefs.*` sentence and every `knowledge.effect.*` sentence (`{{steps}}`);
  - `feedback.composer.headingStep`, `.headingTest` and `.headingSuiteTest`,
    `feedback.scope.oneStepInTest`, `feedback.history.targetStep` and `.targetTest`, and
    `feedback.preview.cliEscape` (`{{name}}`); `feedback.history.quoted` (`{{content}}`); the four
    `feedback.history.change.*` sentences (`{{disposition}}`, `{{records}}`, `{{file}}`).
- **Words that stand alone.** Some values are shown by themselves, as a badge, a column value or the
  accessible name a screen reader speaks. Each must read as a complete word or short phrase on its
  own, and stay short, because a badge has little room: every `status.*` and `status.name.*` value,
  `action.result.*`, `nav.palette.kind.*`, `knowledge.changes.bucket.*`,
  `live.preview.waitingGaveUpLabel`. Some short values are put inside other sentences and must read
  as a noun phrase there: `runDetail.postProcessing.verdictClass.*` and
  `evidence.drawer.deviceType.*`.
- **Plain text only.** English writes `...` for an ellipsis and ` — ` for a dash; use the
  language's own marks. Title Case in English buttons and titles (`Go Back`, `Command Palette`) is
  English style: use the language's own capitalisation.
- **Names in quotation marks.** English quotes a name with `"{{name}}"`. Use the language's own
  quotation marks, from its tone note.

### Keys that are not sentences

- `nav.palette.*` holds what the command palette shows and the words a person types to find a
  command (`nav.palette.newTestSearch` and the other `…Search` keys). Translate the search words, and
  include the words of the command's own label in that language, so typing the label finds it.
- `config.sectionAliases.*` holds one list of search words per Config section, separated by commas.
  Keep the commas and translate the words.
- A list of search words may keep the English word beside the translated one where people commonly
  type the English term (`yaml`, `auth`, `hook`), because this is a tool for developers.

### The check

`src/i18n/__tests__/translations-keep-placeholders-and-tags.test.ts` runs under `pnpm test`. For
every key a language has, it reports by key a slot that is missing, misspelled or added, a tag that
carries anything after its name, a tag the English text does not have and a tag the translation
drops. A plural form English does not write is compared with the English `_other` form; a `_one`
form may leave `{{count}}` out, and any plural form may add it. A key a language leaves out is not
looked at. Run it with
`pnpm --filter @vostride/agent-qa-dashboard-ui exec vitest run src/i18n/__tests__/translations-keep-placeholders-and-tags.test.ts`.

## What stays in English

These are written exactly as in English, in every language, also inside a translated sentence:

- `agent-qa`, always lowercase and with its hyphen.
- Product, company, browser and platform names: Claude, ChatGPT, Gemini, OpenAI, Anthropic, GitHub,
  Playwright, Appium, Chromium, Firefox, WebKit, Android, iOS, Web, and the names of the WCAG rules.
  Provider and model names.
- YAML keys, YAML values and config syntax, inside a sentence too: `use.authState`,
  `use.browser.remote`, `registry.remotes`, `testMatch`, `suiteMatch`, `runHook`, `setup:`,
  `teardown:`, `local`, `h_`, `suite-id`. In `config.filesFieldHelp.secretsFile` and
  `config.remotes.pick`, `[secret:<name>]` and `<name>` are config syntax, not tags: keep them as
  written. Syntax that i18next would read as a slot, such as `{{secret:NAME}}` or `{{env:NAME}}`,
  never appears in a catalog: the code passes it in as a value (`{{reference}}`, `{{syntax}}`).
- Commands and code samples; file and folder names such as `agent-qa.config.yaml`, `.env` and
  `.agent-qa/`; `stdout`, `stderr`, `runJS`.
- Abbreviations and technical terms used as names: MCP, CLI, YAML, JSON, URL, API, HTTP, LLM, ID.
- Durations written in the config's own syntax (`5s`, `10m`, `250ms` in
  `hooks.editor.timeoutExamples`), and the `key = value` notation.
- Keys on a keyboard, as they are printed (Enter, Esc, Tab, Shift).
- Codes the dashboard shows as they were recorded: an ARIA role (`button`, `link`), an exit code, a
  verdict or reason code when the dashboard has no word for it.

What the dashboard shows as produced never appears in a catalog and is never translated: the names
of tests, suites, hooks, targets and runs, step text, the server's messages, the model's reasoning,
hook output and config values.

## Plural forms

i18next picks a plural form with `Intl.PluralRules` for the language. A form the language leaves out
falls back to the language's own `_other`; a language with no `_other` for a key falls back to
English. So every plural key has `_other` in every language.

| Codes | Forms written | What `_one` covers |
|---|---|---|
| es, de | `_one`, `_other` | the number 1 only |
| pt-BR, fr | `_one`, `_other` | 0, 1 and the fractions below 2 |
| ru | `_one`, `_few`, `_many`, `_other` | 1, 21, 31, 101 and every number ending in 1 but not 11 |
| ja, ko, zh-Hans, zh-Hant | `_other` only | — |

Spanish, French and Brazilian Portuguese also have a `many` form for numbers such as 1,000,000. Do not
write `_many` in those languages: it falls back to `_other`, which reads correctly. Russian `_few`
covers 2–4, 22–24 and so on; `_many` covers 0, 5–20, 25–30 and so on; `_other` covers fractions.

Where the English `_other` form shows `{{count}}`, write `{{count}}` in every form of the key, even
where English spells the number out in `_one` (`knowledge.status.times_one` is `once`,
`knowledge.effect.replayedAll_one` is `Replayed its only step in {{steps}}`): in French, Portuguese
and Russian `_one` is shown for other numbers too. Only German and Spanish, whose `_one` is the
number 1 alone, may write the word for one there (`einmal`, `una vez`). A plural key whose English
shows no `{{count}}` at all (`knowledge.stepRefs.lead_*`) needs none.

Examples:

- `common.selection.selected_one` / `_other`: `{{count}} ausgewählt` (de, both forms).
- `knowledge.status.times_*` in Russian: `_one` `{{count}} раз`, `_few` `{{count}} раза`, `_many`
  `{{count}} раз`, `_other` `{{count}} раза`.
- `knowledge.status.times_other` in Japanese: `{{count}}回`; nothing else.

Some English `_one` forms keep wording that does not change for one (`1 runs queued`). That is
English only; write the language's correct form.

## Action sentences

`locales/en/action.ts` holds the sentence a step's action is shown with: `action.<verb>.done`,
`.tried` and `.skipped`, with the slots `{{target}}`, `{{value}}` and `{{keys}}`. The code reads the
raw template, splits it at its slots and puts the recorded text in, so recorded text is never read
for slots.

- **Variants.** A verb with slots also has variants for the sentences with fewer slots filled:
  `_bare` is the sentence with no slot filled, `_target` has only `{{target}}`, `_value` has only
  `{{value}}`. The base key is used when every slot is filled.
- **Write every variant of a verb you write.** When a variant is missing, i18next falls back to the
  language's own base template, not to English, and that template would show with empty slots. Only
  a verb a language leaves out entirely shows English.
- **`_bare` stands alone.** Write it as a complete sentence with no target: no particle,
  preposition or article left over (Japanese `クリックしました`, not `をクリックしました`).
- **Slots may move.** Put `{{target}}`, `{{value}}` and `{{keys}}` where the language needs them.
- **The target.** `{{target}}` is filled from one of two templates. `action.target.name` is a
  recorded name in the language's own quotation marks (English `'{{name}}'`). `action.target.role`
  is a recorded ARIA role, which stays an English code in every language (English `a {{role}}`).
  Write the role template as a short noun phrase that needs no agreement with the code, such as the
  word for "element" beside it; each language's tone note gives its form.
- **`action.target.role_an`** exists because English writes `an` before a role that starts with a
  vowel. Every other language gives it the same text as `action.target.role`.
- **Outcome.** `action.outcome.failed` and `action.outcome.noInput` wrap a whole sentence as
  `{{sentence}}` and add the result; `{{state}}` in `noInput` is a recorded state.
  `action.result.*` are the result words shown alone.
- **Style.** Each language's tone note says how a done, tried and skipped sentence is shaped, and the
  action verb rows of its table give an example. Keep the same shape for every verb.

## Notes by area

### common

- `common.next` is the tour's button to its next step. `common.nextPage` is the button to the next
  page of a list and stands beside that list's own `previous` key (`runs.table.previous`,
  `hooks.list.previous`, `tests.list.previous`, `suites.list.previous`), so the two read as a pair.
  A language with one word for both writes it in both keys.

### status

- `status.*` (capitalised) is the label of a run, test or step status; `status.name.*` (lowercase in
  English) is the status word shown in a step list, a log and the command palette, as a badge and as
  an accessible name. Both read alone. Each table below gives both.

### nav and config

- `nav.config` and `language.label` are named by a test in German (`Konfiguration`, `Sprache`).
  `nav.config` is `設定` in Traditional Chinese.
- The search-word keys: § Keys that are not sentences.
- `config.remoteNotListed`, `config.remoteUnlistedChoice`, `config.remotePickNotListed`: split at
  `{{name}}`. `config.connectRefusalIssue.*` keeps `{{issue}}`, `config.signInFailed.*` keeps
  `{{reason}}`, `config.remoteCredentials.*` keeps `{{reference}}`.

### action

- § Action sentences.

### knowledge

- The step-reference sentences of `knowledge.stepRefs.*` are split at their slots and each slot is
  filled with step links: keep each slot exactly once. `knowledge.stepRefs.lead_*` is a plural key
  with no `{{count}}` in English; it still keeps `{{steps}}` in every form.
- An effect sentence in `knowledge.effect.*` is split at `{{steps}}` and writes whatever spacing the
  language uses around it; the code adds none.
- `knowledge.learned.was` keeps `{{record}}`. `knowledge.stepDetail.cutLine` keeps all four of its
  slots (`{{recordId}}`, `{{leg}}`, `{{rank}}`, `{{score}}`).
- The bucket words use the same word in `knowledge.changes.bucket.*` (`Added`) and in
  `runDetail.postProcessing.bucket.*` (`{{count}} added`).

### runDetail

- A key that ends in `Clause` under `runDetail.postProcessing.*` is what a screen reader hears after
  the stage and its state (`runDetail.postProcessing.accessibleNameClause` is
  `{{stage}}: {{state}}, {{clause}}`); the sentence key beside it is what the card shows. Keep the
  two in step. Neither is cut from the other, so the sentence may use any punctuation and word order.
- `runDetail.usage.coverage`, `runDetail.usage.cachedInputPartial` and every
  `runDetail.postProcessing.bucket.*` are plural keys with `{{count}}`: write every form the
  language has.
- `runDetail.postProcessing.verdictClass.*` appears inside other sentences: write each as a noun
  phrase.

### evidence

- `evidence.explanationWithStep` keeps `{{explanation}}` and `{{step}}` and joins two whole
  sentences the way the language does: a space, or nothing in Chinese and Japanese.
- `evidence.drawer.deviceType.*` appears inside other sentences: write each as a noun phrase.

### feedback

- The sentences split at a slot: § Rules for every language.
- `feedback.disposition.*` and `feedback.recorded.*` say the same thing in two forms; keep them in
  step.
- `feedback.history.quoted` holds the quotation marks around a note: use the language's own.

### editor and tests

- In `editor.yaml.*` the YAML keys, values and code samples inside a sentence stay as written; only
  the sentence around them is translated. `editor.yaml.variables` keeps `{{syntax}}`.
- `editor.monaco.hint` keeps `{{suggestion}}`; `tests.viewer.flaky` keeps `{{score}}`;
  `tests.navbar.session` keeps `{{number}}`.
- `editor.settings.inherited` keeps `{{value}}` exactly once (the code splits there).
  `editor.forms.noTargets` keeps its bare `<link>` tag. `editor.page.title.live` keeps `{{number}}`
  and `{{name}}`; the auth-state sentences keep `{{name}}` and `{{target}}`.
- The busy labels are keys of their own beside the idle ones (`tests.navbar.running` beside
  `tests.navbar.run`): translate both.

### suites

- The suite pages use the same wording as the test pages for the same thing.
- `suites.viewer.flaky` keeps `{{score}}`; `suites.navbar.session` keeps `{{number}}`;
  `suites.editor.title.live` keeps `{{number}}` and `{{name}}`; the `suites.editor.authState.*`
  sentences keep `{{name}}` and `{{target}}`; `suites.editor.missingTests` keeps `{{tests}}`.
- `suites.form.noTargets` and `suites.picker.noTests` keep their bare `<link>` tag.
- `suites.builder.row.setupHook` and `.teardownHook` begin with the YAML words `setup:` and
  `teardown:`, which stay as written.

### hooks

- `hooks.list.warning.fileNotFound` and `hooks.list.warning.loadFailedFrom` keep `{{file}}`;
  `hooks.run.variablesAvailable` keeps `{{count}}` and `{{file}}` (a plural key);
  `hooks.list.showing` keeps `{{start}}`, `{{end}}` and `{{shown}}`.
- The durations in `hooks.editor.timeoutExamples` stay as written, and so do `.env`, `stdout` and
  `stderr` inside the `hooks.run.*` sentences.

### live

- `live.config.*` keeps `{{name}}`; `live.session.stepFailed` keeps `{{number}}` and `{{error}}`;
  `live.session.stepBusy` keeps `{{step}}`.
- `live.preview.noStream` and `live.preview.waitingGaveUp` describe the step list by its role, never
  by its position on the page: no "left", "right", "above" or "below" (a test checks the English).
  `live.preview.waitingGaveUpLabel` is a badge shown beside the gave-up sentence, never part of it.
- `live.pane.signedOut` and `live.authState.saveFailed` keep `{{name}}` and `{{target}}`; the
  `live.run.gapMarker` plural key keeps `{{count}}`, `{{from}}` and `{{to}}`; the
  `live.run.remoteProgress` sentences keep `{{remote}}` and `{{message}}` (and `{{percent}}` where
  the English has it); `live.pane.hook.withStatus` keeps `{{name}}` and `{{status}}`;
  `live.pane.test.stepNumber`, `live.run.testFallback` and `live.steps.memberFallback` keep
  `{{number}}`.

### time

- `time.*AgoCompact_*` are short relative times shown in narrow columns: use the language's shortest
  usual form. The number in them is formatted by the code.

## Español (es)

### Tone

Neutral Spanish for Spain and Latin America: no voseo, and no word used in only one region
(`computadora` or `ordenador`: say `este equipo` or rephrase). Plain and concise, like the English.
Address the reader as `tú` only where a pronoun is needed, and prefer an impersonal phrasing; never
`usted`. Buttons and menu items are infinitives (`Guardar`, `Eliminar`); titles and buttons use
sentence case (`Paleta de comandos`, not `Paleta De Comandos`). Questions and exclamations open with
`¿` and `¡`. Names in quotation marks use “ ” (`“{{name}}”`). Status labels are shared by runs, tests
and steps, so they use the masculine form as a neutral label. Action sentences are in the preterite
with the agent as the unstated subject: `Hizo clic en {{target}}`, `Intentó hacer clic en
{{target}}`, `No hizo clic en {{target}}`; `action.target.name` is `“{{name}}”` and
`action.target.role` is `un elemento {{role}}`.

### Terms

| English | Español | Note |
|---|---|---|
| Run | ejecución, ejecuciones | Noun. The verb is `ejecutar`. |
| Test | prueba, pruebas | |
| Suite | suite, suites | Feminine: `la suite`; `suite de pruebas` where the sentence needs it. |
| Hook | hook, hooks | Kept in English: the config's own word. Masculine: `el hook`. |
| Target | destino, destinos | The app or site a test runs against. |
| Config | Configuración | `archivo de configuración` for the file. |
| Step | paso, pasos | |
| Insights | Estadísticas | The page of pass rates, durations and tokens. Not `Análisis`, which is a run's post-run analysis. |
| Knowledge | conocimiento | `almacén de conocimiento` for the store. |
| Evidence | evidencias | Plural, as in QA: screenshots, video and logs a run kept. |
| Recording | grabación, grabaciones | Video recording. Verb `grabar`. |
| Live mode | modo en vivo | |
| Model | modelo, modelos | |
| Auth state | estado de autenticación | A saved signed-in browser state. |
| Dashboard | panel | |
| Language | Idioma | |
| Passed | Aprobado | `status.passed` |
| Failed | Fallido | |
| Timed out | Tiempo agotado | |
| Cancelled | Cancelado | |
| Healed | Reparado | The test repaired itself (self-healing). |
| Flaky | Inestable | |
| Skipped | Omitido | |
| Running | En curso | |
| Pending | Pendiente | |
| Queued | En cola | |
| Unknown | Desconocido | |
| idle | inactivo | `status.name.idle` |
| pending | pendiente | |
| running | en curso | |
| cancelling | cancelando | |
| passed | aprobado | |
| failed | fallido | |
| healed | reparado | |
| flaky | inestable | |
| skipped | omitido | |
| cancelled | cancelado | |
| timed out | tiempo agotado | |
| Cancel | Cancelar | |
| Save | Guardar | |
| Delete | Eliminar | |
| Close | Cerrar | |
| Edit | Editar | |
| Next | Siguiente | |
| Run (button) | Ejecutar | `common.run` and the verb in every sentence. |
| Copied to the clipboard | Copiado al portapapeles | |
| Something went wrong | Algo salió mal | |
| Go Back | Volver | |
| Try Again | Reintentar | |
| Command Palette | Paleta de comandos | |
| {{count}} selected | {{count}} seleccionado, {{count}} seleccionados | `_one`, `_other` |
| Select row | Seleccionar fila | |
| Untitled step | Paso sin nombre | |
| Screenshot | captura de pantalla | |
| click | hacer clic | `Hizo clic en {{target}}` |
| tap | tocar | `Tocó {{target}}` |
| fill | rellenar | `Rellenó {{target}} con {{value}}` |
| select | seleccionar | `Seleccionó {{value}} en {{target}}` |
| paste | pegar | `Pegó {{value}} en {{target}}` |
| press | presionar | `Presionó {{keys}}` |
| scroll | desplazar | `Se desplazó por {{target}}` |
| swipe | deslizar | `Deslizó {{target}}` |
| drag | arrastrar | `Arrastró {{target}}` |
| navigate | navegar | `Navegó a {{target}}` |
| verify | verificar | `Verificó {{target}}` |
| extract | extraer | `Extrajo información {{target}}` |
| wait | esperar | `Esperó a {{target}}` |
| open | abrir | `Abrió {{target}}` |
| set | establecer | `Estableció {{target}} en {{value}}` |

## Português (Brasil) (pt-BR)

### Tone

Brazilian Portuguese as Brazilian developer tools write it. Plain and concise. Address the reader as
`você` where a pronoun is needed, and prefer an impersonal phrasing. Buttons and menu items are
infinitives (`Salvar`, `Excluir`); titles and buttons use sentence case. Names in quotation marks
use “ ” (`“{{name}}”`). Status labels use the masculine form as a neutral label, or a phrase with no
gender (`Com falha`, `Em execução`). Action sentences are in the past tense with the agent as the
unstated subject: `Clicou em {{target}}`, `Tentou clicar em {{target}}`, `Não clicou em
{{target}}`; `action.target.name` is `“{{name}}”` and `action.target.role` is
`um elemento {{role}}`. Use Brazilian words: `arquivo`, `tela`, `excluir`, `salvar`, `área de
transferência`.

### Terms

| English | Português (Brasil) | Note |
|---|---|---|
| Run | execução, execuções | Noun. The verb is `executar`. |
| Test | teste, testes | |
| Suite | suíte, suítes | `suíte de testes` where the sentence needs it. |
| Hook | hook, hooks | Kept in English: the config's own word. Masculine: `o hook`. |
| Target | destino, destinos | The app or site a test runs against. |
| Config | Configuração | `arquivo de configuração` for the file. |
| Step | etapa, etapas | |
| Insights | Estatísticas | The page of pass rates, durations and tokens. Not `Análise`, which is a run's post-run analysis. |
| Knowledge | conhecimento | `base de conhecimento` for the store. |
| Evidence | evidências | Plural: screenshots, video and logs a run kept. |
| Recording | gravação, gravações | Video recording. Verb `gravar`. |
| Live mode | modo ao vivo | |
| Model | modelo, modelos | |
| Auth state | estado de autenticação | A saved signed-in browser state. |
| Dashboard | painel | |
| Language | Idioma | |
| Passed | Aprovado | `status.passed` |
| Failed | Com falha | |
| Timed out | Tempo esgotado | |
| Cancelled | Cancelado | |
| Healed | Reparado | The test repaired itself (self-healing). |
| Flaky | Instável | |
| Skipped | Ignorado | |
| Running | Em execução | |
| Pending | Pendente | |
| Queued | Na fila | |
| Unknown | Desconhecido | |
| idle | inativo | `status.name.idle` |
| pending | pendente | |
| running | em execução | |
| cancelling | cancelando | |
| passed | aprovado | |
| failed | com falha | |
| healed | reparado | |
| flaky | instável | |
| skipped | ignorado | |
| cancelled | cancelado | |
| timed out | tempo esgotado | |
| Cancel | Cancelar | |
| Save | Salvar | |
| Delete | Excluir | |
| Close | Fechar | |
| Edit | Editar | |
| Next | Próximo | |
| Run (button) | Executar | `common.run` and the verb in every sentence. |
| Copied to the clipboard | Copiado para a área de transferência | |
| Something went wrong | Algo deu errado | |
| Go Back | Voltar | |
| Try Again | Tentar novamente | |
| Command Palette | Paleta de comandos | |
| {{count}} selected | {{count}} selecionado, {{count}} selecionados | `_one` (also 0), `_other` |
| Select row | Selecionar linha | |
| Untitled step | Etapa sem nome | |
| Screenshot | captura de tela | |
| click | clicar | `Clicou em {{target}}` |
| tap | tocar | `Tocou em {{target}}` |
| fill | preencher | `Preencheu {{target}} com {{value}}` |
| select | selecionar | `Selecionou {{value}} em {{target}}` |
| paste | colar | `Colou {{value}} em {{target}}` |
| press | pressionar | `Pressionou {{keys}}` |
| scroll | rolar | `Rolou {{target}}` |
| swipe | deslizar | `Deslizou {{target}}` |
| drag | arrastar | `Arrastou {{target}}` |
| navigate | navegar | `Navegou até {{target}}` |
| verify | verificar | `Verificou {{target}}` |
| extract | extrair | `Extraiu informações de {{target}}` |
| wait | aguardar | `Aguardou {{target}}` |
| open | abrir | `Abriu um aplicativo em {{target}}` |
| set | definir | `Definiu {{target}} como {{value}}` |

## Deutsch (de)

### Tone

Plain and concise, like the English. Prefer an impersonal phrasing; where the reader must be
addressed, use `Sie`. Buttons and menu items are infinitives (`Speichern`, `Abbrechen`). Titles use
sentence case; nouns are capitalised as German requires. A compound with an English word, a code or a
product noun takes a hyphen (`YAML-Datei`, `Live-Modus`, `agent-qa-Dashboard`). Quotation marks are
„ “ (`„{{name}}“`). No space before `:`, `?` or `!`. Action sentences are a participle phrase with
no subject: `Auf {{target}} geklickt`, `Versucht, auf {{target}} zu klicken`, `Nicht auf {{target}}
geklickt`; `action.target.name` is `„{{name}}“` and `action.target.role` is `Element {{role}}`, with
no article, so no case ending depends on the code. Two words are named by tests: `Konfiguration` for
`nav.config` and `Sprache` for `language.label`. The German words already in `locales/de/nav.ts` and
`locales/de/language.ts` agree with this table.

### Terms

| English | Deutsch | Note |
|---|---|---|
| Run | Lauf, Läufe | Noun (`nav.runs` is `Läufe`). The verb is `ausführen`. |
| Test | Test, Tests | |
| Suite | Suite, Suiten | `Testsuite` where the sentence needs it (`nav.suites` is `Suiten`). |
| Hook | Hook, Hooks | Kept in English: the config's own word. Masculine: `der Hook`. |
| Target | Ziel, Ziele | The app or site a test runs against. |
| Config | Konfiguration | Named by a test (`nav.config`). `Konfigurationsdatei` for the file. |
| Step | Schritt, Schritte | |
| Insights | Einblicke | The page of pass rates, durations and tokens. |
| Knowledge | Wissen | `Wissensspeicher` for the store, `Wissensordner` for the folder. |
| Evidence | Belege | Plural: screenshots, video and logs a run kept. |
| Recording | Aufzeichnung, Aufzeichnungen | Video recording. Verb `aufzeichnen`. |
| Live mode | Live-Modus | |
| Model | Modell, Modelle | |
| Auth state | Anmeldestatus | A saved signed-in browser state. |
| Dashboard | Dashboard | |
| Language | Sprache | Named by a test (`language.label`). |
| Passed | Bestanden | `status.passed` |
| Failed | Fehlgeschlagen | |
| Timed out | Timeout | Short for a badge; `Zeitüberschreitung` in a sentence. |
| Cancelled | Abgebrochen | |
| Healed | Repariert | The test repaired itself (self-healing). |
| Flaky | Instabil | |
| Skipped | Übersprungen | |
| Running | Läuft | |
| Pending | Ausstehend | |
| Queued | In Warteschlange | |
| Unknown | Unbekannt | |
| idle | inaktiv | `status.name.idle` |
| pending | ausstehend | |
| running | läuft | |
| cancelling | wird abgebrochen | |
| passed | bestanden | |
| failed | fehlgeschlagen | |
| healed | repariert | |
| flaky | instabil | |
| skipped | übersprungen | |
| cancelled | abgebrochen | |
| timed out | Timeout | A noun, so capitalised. |
| Cancel | Abbrechen | |
| Save | Speichern | |
| Delete | Löschen | |
| Close | Schließen | |
| Edit | Bearbeiten | |
| Next | Weiter | |
| Run (button) | Ausführen | `common.run` and the verb in every sentence. |
| Copied to the clipboard | In die Zwischenablage kopiert | |
| Something went wrong | Etwas ist schiefgelaufen | |
| Go Back | Zurück | |
| Try Again | Erneut versuchen | |
| Command Palette | Befehlspalette | |
| {{count}} selected | {{count}} ausgewählt | `_one` and `_other` alike. |
| Select row | Zeile auswählen | |
| Untitled step | Unbenannter Schritt | |
| Screenshot | Screenshot | |
| click | klicken | `Auf {{target}} geklickt` |
| tap | tippen | `Auf {{target}} getippt` |
| fill | ausfüllen | `{{target}} mit {{value}} ausgefüllt` |
| select | auswählen | `{{value}} in {{target}} ausgewählt` |
| paste | einfügen | `{{value}} in {{target}} eingefügt` |
| press | drücken | `{{keys}} gedrückt` |
| scroll | scrollen | `{{target}} gescrollt` |
| swipe | wischen | `Über {{target}} gewischt` |
| drag | ziehen | `{{target}} gezogen` |
| navigate | navigieren | `Zu {{target}} navigiert` |
| verify | prüfen | `{{target}} geprüft` |
| extract | extrahieren | `Informationen {{target}} extrahiert` |
| wait | warten | `Auf {{target}} gewartet` |
| open | öffnen | `{{target}} geöffnet` |
| set | setzen | `{{target}} auf {{value}} gesetzt` |

## Français (fr)

### Tone

Plain and concise, like the English. Address the reader as `vous`. Buttons and menu items are
infinitives (`Enregistrer`, `Annuler`); titles and buttons use sentence case. French spacing: a
no-break space (U+00A0) before `:` and a narrow no-break space (U+202F) before `;`, `?` and `!`, so
that a line never breaks before the mark; never a plain space there. Quotation marks are « » with a
narrow no-break space inside each (`« {{name}} »`). Use the French ellipsis `…` and apostrophe `’`.
Status labels use the masculine form as a neutral label. Action sentences are noun phrases, which
French logs use and which need no subject: `Clic sur {{target}}`, `Tentative de clic sur
{{target}}`, `Pas de clic sur {{target}}`; `_bare` is `Clic`, `Tentative de clic`, `Pas de clic`.
`action.target.name` is `« {{name}} »` and `action.target.role` is `l’élément {{role}}`: several
action sentences put `de` before the target, and `de un élément` is not French.

### Terms

| English | Français | Note |
|---|---|---|
| Run | exécution, exécutions | Noun. The verb is `exécuter`. |
| Test | test, tests | |
| Suite | suite, suites | `suite de tests` where the sentence needs it. |
| Hook | hook, hooks | Kept in English: the config's own word. Masculine: `le hook`. |
| Target | cible, cibles | The app or site a test runs against. Feminine. |
| Config | Configuration | `fichier de configuration` for the file. |
| Step | étape, étapes | |
| Insights | Statistiques | The page of pass rates, durations and tokens. Not `Analyse`, which is a run's post-run analysis. |
| Knowledge | connaissances | Plural, as in `base de connaissances`, the store. |
| Evidence | preuves | Plural: screenshots, video and logs a run kept. |
| Recording | enregistrement, enregistrements | Video recording. Verb `enregistrer`. |
| Live mode | mode en direct | |
| Model | modèle, modèles | |
| Auth state | état d’authentification | A saved signed-in browser state. |
| Dashboard | tableau de bord | |
| Language | Langue | |
| Passed | Réussi | `status.passed` |
| Failed | Échoué | |
| Timed out | Expiré | Short for a badge; `délai dépassé` in a sentence. |
| Cancelled | Annulé | |
| Healed | Réparé | The test repaired itself (self-healing). |
| Flaky | Instable | |
| Skipped | Ignoré | |
| Running | En cours | |
| Pending | En attente | |
| Queued | En file d’attente | |
| Unknown | Inconnu | |
| idle | inactif | `status.name.idle` |
| pending | en attente | |
| running | en cours | |
| cancelling | annulation en cours | |
| passed | réussi | |
| failed | échoué | |
| healed | réparé | |
| flaky | instable | |
| skipped | ignoré | |
| cancelled | annulé | |
| timed out | expiré | |
| Cancel | Annuler | |
| Save | Enregistrer | |
| Delete | Supprimer | |
| Close | Fermer | |
| Edit | Modifier | |
| Next | Suivant | |
| Run (button) | Exécuter | `common.run` and the verb in every sentence. |
| Copied to the clipboard | Copié dans le presse-papiers | |
| Something went wrong | Une erreur s’est produite | |
| Go Back | Retour | |
| Try Again | Réessayer | |
| Command Palette | Palette de commandes | |
| {{count}} selected | {{count}} sélectionné, {{count}} sélectionnés | `_one` (also 0), `_other` |
| Select row | Sélectionner la ligne | |
| Untitled step | Étape sans nom | |
| Screenshot | capture d’écran | |
| click | cliquer | `Clic sur {{target}}` |
| tap | toucher | `Appui sur {{target}}` |
| fill | remplir | `Saisie de {{value}} dans {{target}}` |
| select | sélectionner | `Sélection de {{value}} dans {{target}}` |
| paste | coller | `Collage de {{value}} dans {{target}}` |
| press | appuyer | `Appui sur {{keys}}` |
| scroll | faire défiler | `Défilement de {{target}}` |
| swipe | balayer | `Balayage sur {{target}}` |
| drag | faire glisser | `Glissement de {{target}}` |
| navigate | naviguer | `Navigation vers {{target}}` |
| verify | vérifier | `Vérification de {{target}}` |
| extract | extraire | `Extraction d’informations {{target}}` |
| wait | attendre | `Attente de {{target}}` |
| open | ouvrir | `Ouverture de {{target}}` |
| set | définir | `Définition de {{target}} sur {{value}}` |

## Русский (ru)

### Tone

Plain and concise, like the English. Address the reader as `вы`, lowercase, and prefer an
impersonal phrasing. Buttons and menu items are infinitives (`Сохранить`, `Удалить`), except the
established `Отмена` for Cancel. Titles and buttons use sentence case. Quotation marks are « »
(`«{{name}}»`), with „ “ inside them. A dash between words is ` — ` with spaces. Status labels are
shared by runs, tests and steps (`запуск`, `тест`, `шаг`, all masculine), so they use the masculine
short form. A slot's value cannot be declined, so a sentence puts a slot where its case does not
matter: after a colon, or after a noun that names it (`в поле {{target}}`, `значение {{value}}`).
Action sentences are a neuter short participle and a colon, which needs no subject and no case:
`Нажато: {{target}}`, `Попытка нажать: {{target}}`, `Не нажато: {{target}}`; `_bare` is `Нажато`,
`Попытка нажать`, `Не нажато`. `action.target.name` is `«{{name}}»` and `action.target.role` is
`элемент {{role}}`. A plural key writes `_one`, `_few`, `_many` and `_other`, each with `{{count}}`.

### Terms

| English | Русский | Note |
|---|---|---|
| Run | запуск, запуски | Noun. The verb is `запустить`. |
| Test | тест, тесты | |
| Suite | набор, наборы | `набор тестов` where the sentence needs it. |
| Hook | хук, хуки | The word Russian developers use. |
| Target | цель, цели | The app or site a test runs against. Feminine. |
| Config | Конфигурация | `файл конфигурации` for the file. |
| Step | шаг, шаги | |
| Insights | Аналитика | The page of pass rates, durations and tokens. A run's post-run analysis is `анализ`. |
| Knowledge | знания | Plural; `база знаний` for the store. |
| Evidence | доказательства | Plural: screenshots, video and logs a run kept. |
| Recording | запись, записи | Video recording. Verb `записывать`. |
| Live mode | интерактивный режим | |
| Model | модель, модели | |
| Auth state | состояние авторизации | A saved signed-in browser state. |
| Dashboard | панель | |
| Language | Язык | |
| Passed | Пройден | `status.passed` |
| Failed | Провален | |
| Timed out | Тайм-аут | |
| Cancelled | Отменён | |
| Healed | Исправлен | The test repaired itself (self-healing). |
| Flaky | Нестабилен | |
| Skipped | Пропущен | |
| Running | Выполняется | |
| Pending | Ожидает | |
| Queued | В очереди | |
| Unknown | Неизвестно | |
| idle | неактивен | `status.name.idle` |
| pending | ожидает | |
| running | выполняется | |
| cancelling | отменяется | |
| passed | пройден | |
| failed | провален | |
| healed | исправлен | |
| flaky | нестабилен | |
| skipped | пропущен | |
| cancelled | отменён | |
| timed out | тайм-аут | |
| Cancel | Отмена | |
| Save | Сохранить | |
| Delete | Удалить | |
| Close | Закрыть | |
| Edit | Изменить | |
| Next | Далее | |
| Run (button) | Запустить | `common.run` and the verb in every sentence. |
| Copied to the clipboard | Скопировано в буфер обмена | |
| Something went wrong | Что-то пошло не так | |
| Go Back | Назад | |
| Try Again | Повторить | |
| Command Palette | Палитра команд | |
| {{count}} selected | Выбрано: {{count}} | The same text in every form; the colon avoids agreement. |
| Select row | Выбрать строку | |
| Untitled step | Шаг без названия | |
| Screenshot | снимок экрана | |
| click | нажать | `Нажато: {{target}}` |
| tap | коснуться | `Касание: {{target}}` |
| fill | заполнить | `Заполнено: {{target}}, значение {{value}}` |
| select | выбрать | `Выбрано: {{value}}, поле: {{target}}`; the colon keeps `элемент {{role}}` in the nominative |
| paste | вставить | `Вставлено: {{value}}, поле: {{target}}` |
| press | нажать | `Нажато: {{keys}}` |
| scroll | прокрутить | `Прокручено: {{target}}` |
| swipe | провести | `Свайп: {{target}}` |
| drag | перетащить | `Перетащено: {{target}}` |
| navigate | перейти | `Переход: {{target}}` |
| verify | проверить | `Проверено: {{target}}` |
| extract | извлечь | `Извлечены данные: {{target}}` |
| wait | ожидать | `Ожидание: {{target}}` |
| open | открыть | `Открыто: {{target}}` |
| set | задать | `Задано: {{target}} = {{value}}` |

## 日本語 (ja)

### Tone

Plain and concise, like the English. Sentences use です／ます; labels, buttons and menu items are
nouns or short verb forms (`保存`, `実行`, `閉じる`, `次へ`). A label or button has no `。`; a sentence
ends with `。`. Use full-width `、` `。` `？` `！` `（）` and 「」 for quotation (`「{{name}}」`); keep a
Latin word, number or slot without a space next to Japanese text (`{{count}}件`). Katakana loanwords
take the long-vowel mark (`ユーザー`, `サーバー`, `フォルダー`). Address the reader without a pronoun.
Action sentences are polite past: `{{target}}をクリックしました`, `{{target}}のクリックを試みました`,
`{{target}}をクリックしませんでした`; `_bare` is `クリックしました` with no particle left over.
`action.target.name` is `「{{name}}」` and `action.target.role` is `{{role}}要素`. A plural key writes
`_other` only.

### Terms

| English | 日本語 | Note |
|---|---|---|
| Run | 実行 | Noun and verb (`実行する`). Japanese marks no plural. |
| Test | テスト | |
| Suite | スイート | `テストスイート` where the sentence needs it. |
| Hook | フック | |
| Target | ターゲット | The app or site a test runs against. |
| Config | 設定 | `設定ファイル` for the file. |
| Step | ステップ | |
| Insights | インサイト | The page of pass rates, durations and tokens. A run's post-run analysis is `分析`. |
| Knowledge | ナレッジ | `ナレッジストア` for the store. |
| Evidence | エビデンス | The usual QA word for screenshots, video and logs a run kept. |
| Recording | 録画 | Video recording. |
| Live mode | ライブモード | |
| Model | モデル | |
| Auth state | 認証状態 | A saved signed-in browser state. |
| Dashboard | ダッシュボード | |
| Language | 言語 | |
| Passed | 成功 | `status.passed` |
| Failed | 失敗 | |
| Timed out | タイムアウト | |
| Cancelled | キャンセル済み | |
| Healed | 修復済み | The test repaired itself (self-healing). |
| Flaky | 不安定 | |
| Skipped | スキップ | |
| Running | 実行中 | |
| Pending | 保留中 | |
| Queued | キュー待ち | |
| Unknown | 不明 | |
| idle | アイドル | `status.name.idle` |
| pending | 保留中 | |
| running | 実行中 | |
| cancelling | キャンセル中 | |
| passed | 成功 | |
| failed | 失敗 | |
| healed | 修復済み | |
| flaky | 不安定 | |
| skipped | スキップ | |
| cancelled | キャンセル済み | |
| timed out | タイムアウト | |
| Cancel | キャンセル | |
| Save | 保存 | |
| Delete | 削除 | |
| Close | 閉じる | |
| Edit | 編集 | |
| Next | 次へ | |
| Run (button) | 実行 | `common.run` and the verb in every sentence. |
| Copied to the clipboard | クリップボードにコピーしました | |
| Something went wrong | 問題が発生しました | |
| Go Back | 戻る | |
| Try Again | 再試行 | |
| Command Palette | コマンドパレット | |
| {{count}} selected | {{count}}件選択 | `_other` only. |
| Select row | 行を選択 | |
| Untitled step | 名前のないステップ | |
| Screenshot | スクリーンショット | |
| click | クリック | `{{target}}をクリックしました` |
| tap | タップ | `{{target}}をタップしました` |
| fill | 入力 | `{{target}}に{{value}}を入力しました` |
| select | 選択 | `{{target}}で{{value}}を選択しました` |
| paste | 貼り付け | `{{target}}に{{value}}を貼り付けました` |
| press | 押す | `{{keys}}を押しました` |
| scroll | スクロール | `{{target}}をスクロールしました` |
| swipe | スワイプ | `{{target}}をスワイプしました` |
| drag | ドラッグ | `{{target}}をドラッグしました` |
| navigate | 移動 | `{{target}}に移動しました` |
| verify | 検証 | `{{target}}を検証しました` |
| extract | 抽出 | `{{target}}の情報を抽出しました` |
| wait | 待機 | `{{target}}を待機しました` |
| open | 開く | `{{target}}を開きました` |
| set | 設定 | `{{target}}を{{value}}に設定しました` |

## 한국어 (ko)

### Tone

Plain and concise, like the English. Sentences use the formal polite `합니다` style; labels, buttons
and menu items are nouns (`저장`, `취소`, `실행`, `닫기`). Address the reader without a pronoun. Korean
spaces words as usual and uses Latin punctuation. Quotation marks are “ ” (`“{{name}}”`). A slot's
value is unknown, so a particle after a slot is written in both forms: `을(를)`, `이(가)`, `은(는)`,
`(으)로`, `와(과)`; or a fixed noun is put between the slot and the particle. Action sentences are
polite past: `{{target}}을(를) 클릭했습니다`, `{{target}}을(를) 클릭하려고 했습니다`,
`{{target}}을(를) 클릭하지 않았습니다`; `_bare` is `클릭했습니다`. `action.target.name` is
`“{{name}}”` and `action.target.role` is `{{role}} 요소`. A plural key writes `_other` only.

### Terms

| English | 한국어 | Note |
|---|---|---|
| Run | 실행 | Noun and verb (`실행하다`). Korean marks no plural here. |
| Test | 테스트 | |
| Suite | 스위트 | `테스트 스위트` where the sentence needs it. |
| Hook | 훅 | |
| Target | 대상 | The app or site a test runs against. |
| Config | 설정 | `설정 파일` for the file. |
| Step | 단계 | |
| Insights | 인사이트 | The page of pass rates, durations and tokens. A run's post-run analysis is `분석`. |
| Knowledge | 지식 | `지식 저장소` for the store. |
| Evidence | 증거 | Screenshots, video and logs a run kept. |
| Recording | 녹화 | Video recording. |
| Live mode | 라이브 모드 | |
| Model | 모델 | |
| Auth state | 인증 상태 | A saved signed-in browser state. |
| Dashboard | 대시보드 | |
| Language | 언어 | |
| Passed | 통과 | `status.passed` |
| Failed | 실패 | |
| Timed out | 시간 초과 | |
| Cancelled | 취소됨 | |
| Healed | 복구됨 | The test repaired itself (self-healing). |
| Flaky | 불안정 | |
| Skipped | 건너뜀 | |
| Running | 실행 중 | |
| Pending | 대기 중 | |
| Queued | 대기열 | |
| Unknown | 알 수 없음 | |
| idle | 유휴 | `status.name.idle` |
| pending | 대기 중 | |
| running | 실행 중 | |
| cancelling | 취소 중 | |
| passed | 통과 | |
| failed | 실패 | |
| healed | 복구됨 | |
| flaky | 불안정 | |
| skipped | 건너뜀 | |
| cancelled | 취소됨 | |
| timed out | 시간 초과 | |
| Cancel | 취소 | |
| Save | 저장 | |
| Delete | 삭제 | |
| Close | 닫기 | |
| Edit | 편집 | |
| Next | 다음 | |
| Run (button) | 실행 | `common.run` and the verb in every sentence. |
| Copied to the clipboard | 클립보드에 복사했습니다 | |
| Something went wrong | 문제가 발생했습니다 | |
| Go Back | 돌아가기 | |
| Try Again | 다시 시도 | |
| Command Palette | 명령 팔레트 | |
| {{count}} selected | {{count}}개 선택됨 | `_other` only. |
| Select row | 행 선택 | |
| Untitled step | 이름 없는 단계 | |
| Screenshot | 스크린샷 | |
| click | 클릭 | `{{target}}을(를) 클릭했습니다` |
| tap | 탭 | `{{target}}을(를) 탭했습니다` |
| fill | 입력 | `{{target}}에 {{value}} 텍스트를 입력했습니다` |
| select | 선택 | `{{target}}에서 {{value}} 옵션을 선택했습니다` |
| paste | 붙여넣기 | `{{target}}에 {{value}} 텍스트를 붙여넣었습니다` |
| press | 누르기 | `{{keys}} 키를 눌렀습니다` |
| scroll | 스크롤 | `{{target}}을(를) 스크롤했습니다` |
| swipe | 스와이프 | `{{target}}을(를) 스와이프했습니다` |
| drag | 드래그 | `{{target}}을(를) 드래그했습니다` |
| navigate | 이동 | `{{target}} 페이지로 이동했습니다` |
| verify | 검증 | `{{target}}을(를) 검증했습니다` |
| extract | 추출 | `{{target}}에서 정보를 추출했습니다` |
| wait | 대기 | `{{target}}을(를) 기다렸습니다` |
| open | 열기 | `{{target}}에서 앱을 열었습니다` |
| set | 설정 | `변수 {{target}}에 {{value}} 값을 설정했습니다` |

## 简体中文 (zh-Hans)

### Tone

Plain and concise, like the English. Prefer phrasing with no pronoun; where one is needed, use `你`.
Buttons and menu items are short verbs (`保存`, `运行`, `删除`). Use full-width punctuation
(`，` `。` `：` `；` `？` `！` `（）`) and “ ” for quotation (`“{{name}}”`). Put a space between Chinese
text and a Latin word, a number or a slot (`运行 {{count}} 个测试`), and none next to full-width
punctuation. Use mainland vocabulary: `文件`, `默认`, `数据`, `服务器`, `视频`, `截图`. Action sentences
are short, with `已` for done: `已点击 {{target}}`, `尝试点击 {{target}}`, `未点击 {{target}}`;
`_bare` is `已点击`, `尝试点击`, `未点击`. `action.target.name` is `“{{name}}”` and
`action.target.role` is `{{role}} 元素`. A plural key writes `_other` only.

### Terms

| English | 简体中文 | Note |
|---|---|---|
| Run | 运行 | Noun and verb. Chinese marks no plural. |
| Test | 测试 | |
| Suite | 套件 | `测试套件` where the sentence needs it. |
| Hook | 钩子 | |
| Target | 目标 | The app or site a test runs against. |
| Config | 配置 | `配置文件` for the file. |
| Step | 步骤 | |
| Insights | 洞察 | The page of pass rates, durations and tokens. A run's post-run analysis is `分析`. |
| Knowledge | 知识 | `知识库` for the store. |
| Evidence | 证据 | Screenshots, video and logs a run kept. |
| Recording | 录制 | Video recording. |
| Live mode | 实时模式 | |
| Model | 模型 | |
| Auth state | 认证状态 | A saved signed-in browser state. |
| Dashboard | 仪表板 | |
| Language | 语言 | |
| Passed | 通过 | `status.passed` |
| Failed | 失败 | |
| Timed out | 超时 | |
| Cancelled | 已取消 | |
| Healed | 已修复 | The test repaired itself (self-healing). |
| Flaky | 不稳定 | |
| Skipped | 已跳过 | |
| Running | 运行中 | |
| Pending | 待处理 | |
| Queued | 排队中 | |
| Unknown | 未知 | |
| idle | 空闲 | `status.name.idle` |
| pending | 待处理 | |
| running | 运行中 | |
| cancelling | 正在取消 | |
| passed | 通过 | |
| failed | 失败 | |
| healed | 已修复 | |
| flaky | 不稳定 | |
| skipped | 已跳过 | |
| cancelled | 已取消 | |
| timed out | 超时 | |
| Cancel | 取消 | |
| Save | 保存 | |
| Delete | 删除 | |
| Close | 关闭 | |
| Edit | 编辑 | |
| Next | 下一步 | |
| Run (button) | 运行 | `common.run` and the verb in every sentence. |
| Copied to the clipboard | 已复制到剪贴板 | |
| Something went wrong | 出错了 | |
| Go Back | 返回 | |
| Try Again | 重试 | |
| Command Palette | 命令面板 | |
| {{count}} selected | 已选择 {{count}} 项 | `_other` only. |
| Select row | 选择行 | |
| Untitled step | 未命名步骤 | |
| Screenshot | 截图 | |
| click | 点击 | `已点击 {{target}}` |
| tap | 轻触 | `已轻触 {{target}}` |
| fill | 填写 | `已在 {{target}} 中填写 {{value}}` |
| select | 选择 | `已在 {{target}} 中选择 {{value}}` |
| paste | 粘贴 | `已将 {{value}} 粘贴到 {{target}}` |
| press | 按下 | `已按下 {{keys}}` |
| scroll | 滚动 | `已滚动 {{target}}` |
| swipe | 滑动 | `已滑动 {{target}}` |
| drag | 拖动 | `已拖动 {{target}}` |
| navigate | 导航 | `已导航到 {{target}}` |
| verify | 验证 | `已验证 {{target}}` |
| extract | 提取 | `已提取信息 {{target}}` |
| wait | 等待 | `已等待 {{target}}` |
| open | 打开 | `已打开 {{target}}` |
| set | 设置 | `已将 {{target}} 设置为 {{value}}` |

## 繁體中文 (zh-Hant)

### Tone

Traditional Chinese as software in Taiwan writes it, chosen directly and never converted from the
Simplified Chinese column: the two use different words. Plain and concise, like the English. Prefer
phrasing with no pronoun; where one is needed, use `您`. Buttons and menu items are short verbs
(`儲存`, `執行`, `刪除`). Use full-width punctuation (`，` `。` `：` `；` `？` `！` `（）`) and 「」 for
quotation, with 『』 inside it (`「{{name}}」`). Put a space between Chinese text and a Latin word, a
number or a slot (`執行 {{count}} 個測試`), and none next to full-width punctuation. Use Taiwan's
vocabulary: `檔案`, `預設`, `資料`, `伺服器`, `程式`, `影片`, `螢幕截圖`, `視窗`, `網路`. Action sentences
are short, with `已` for done: `已點擊 {{target}}`, `嘗試點擊 {{target}}`, `未點擊 {{target}}`;
`_bare` is `已點擊`, `嘗試點擊`, `未點擊`. `action.target.name` is `「{{name}}」` and
`action.target.role` is `{{role}} 元素`. A plural key writes `_other` only.

### Terms

| English | 繁體中文 | Note |
|---|---|---|
| Run | 執行 | Noun and verb. Chinese marks no plural. |
| Test | 測試 | |
| Suite | 套件 | `測試套件` where the sentence needs it. |
| Hook | 掛鉤 | |
| Target | 目標 | The app or site a test runs against. |
| Config | 設定 | The word Taiwan's software uses; keep it for `nav.config`. `設定檔` for the file. |
| Step | 步驟 | |
| Insights | 深入解析 | The page of pass rates, durations and tokens. A run's post-run analysis is `分析`. |
| Knowledge | 知識 | `知識庫` for the store. |
| Evidence | 證據 | Screenshots, video and logs a run kept. |
| Recording | 錄影 | Video recording. |
| Live mode | 即時模式 | |
| Model | 模型 | |
| Auth state | 驗證狀態 | A saved signed-in browser state. |
| Dashboard | 儀表板 | |
| Language | 語言 | |
| Passed | 通過 | `status.passed` |
| Failed | 失敗 | |
| Timed out | 逾時 | |
| Cancelled | 已取消 | |
| Healed | 已修復 | The test repaired itself (self-healing). |
| Flaky | 不穩定 | |
| Skipped | 已略過 | |
| Running | 執行中 | |
| Pending | 擱置中 | |
| Queued | 佇列中 | |
| Unknown | 未知 | |
| idle | 閒置 | `status.name.idle` |
| pending | 擱置中 | |
| running | 執行中 | |
| cancelling | 正在取消 | |
| passed | 通過 | |
| failed | 失敗 | |
| healed | 已修復 | |
| flaky | 不穩定 | |
| skipped | 已略過 | |
| cancelled | 已取消 | |
| timed out | 逾時 | |
| Cancel | 取消 | |
| Save | 儲存 | |
| Delete | 刪除 | |
| Close | 關閉 | |
| Edit | 編輯 | |
| Next | 下一步 | |
| Run (button) | 執行 | `common.run` and the verb in every sentence. |
| Copied to the clipboard | 已複製到剪貼簿 | |
| Something went wrong | 發生錯誤 | |
| Go Back | 返回 | |
| Try Again | 重試 | |
| Command Palette | 命令選擇區 | |
| {{count}} selected | 已選取 {{count}} 項 | `_other` only. |
| Select row | 選取列 | |
| Untitled step | 未命名的步驟 | |
| Screenshot | 螢幕截圖 | |
| click | 點擊 | `已點擊 {{target}}` |
| tap | 點一下 | `已點一下 {{target}}` |
| fill | 填入 | `已在 {{target}} 填入 {{value}}` |
| select | 選取 | `已在 {{target}} 選取 {{value}}` |
| paste | 貼上 | `已將 {{value}} 貼上到 {{target}}` |
| press | 按下 | `已按下 {{keys}}` |
| scroll | 捲動 | `已捲動 {{target}}` |
| swipe | 滑動 | `已滑動 {{target}}` |
| drag | 拖曳 | `已拖曳 {{target}}` |
| navigate | 前往 | `已前往 {{target}}` |
| verify | 驗證 | `已驗證 {{target}}` |
| extract | 擷取 | `已擷取資訊 {{target}}` |
| wait | 等待 | `已等待 {{target}}` |
| open | 開啟 | `已開啟 {{target}}` |
| set | 設定 | `已將 {{target}} 設定為 {{value}}` |
