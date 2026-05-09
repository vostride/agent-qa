import type { ScreenState, Action } from '../types/platform.js'
import type { StepContext, AssertionInput, ExtractorInput } from './types.js'
import type { ScopedLogger } from '../logging/types.js'
import { truncateScreenState } from './observation.js'
import { estimateTokens } from './token-budget.js'
import { defaultRegistry } from '../tools/index.js'

// ---------------------------------------------------------------------------
// Rule group functions — each returns numbered rules for its concern.
// Numbering is continuous across groups (the LLM sees Rules: 1-20).
// To add a rule: append to the relevant group, increment subsequent numbers.
// ---------------------------------------------------------------------------

function actionSelectionRules(): string {
  return `1. Pick the most specific action type for the task. Use "click" for buttons/links, "fill" for inputs. Use "select" for HTML/WebView dropdowns; use "nativeSelect" for native iOS picker wheels and Android native picker/dropdown/list controls.
2. Always use element refs from the CURRENT screen state below. Never guess or fabricate element refs. After a newTab or switchTab action, all previous refs are invalid — the screen state now shows the new tab's content with fresh refs. Ignore refs from earlier sub-actions and only use refs you can see in the current screen state.`
}

function scrollRules(): string {
  return `3. If the target element is not visible in the screen state, use a "scroll" action with scrollType "vertical" and a positive value (e.g., 500) to scroll down, or negative value to scroll up. Use scrollType "horizontal" for left/right scrolling. When scrolling within a specific container (a list, card, panel, or any element that has its own scrollbar), always include the "ref" field pointing to that container element — without ref, the scroll targets the page viewport and will miss the container. When no container ref is available, use any child element's ref — the adapter automatically walks up to the nearest scrollable container. Prefer a ref near the target content over scrolling the page viewport. If you have already scrolled and the screen did not change (you reached the boundary), the element is not on this page — set stepFailed with an explanation of what you searched. For ref-based container scrolls, check the scroll action's Returned data: if it shows "scrolled": false, the container has reached its scroll boundary in that direction — the content you are looking for is not in this container. Do not retry with smaller scroll values, different refs targeting the same container, or tapCoordinate-based approaches. Set stepFailed explaining that you scrolled the container to its boundary and the target content was not found. EXCEPTION: When the step goal IS to reach the scroll boundary (e.g., 'scroll to the end', 'scroll to the bottom', 'scroll all the way down', 'scroll to the top'), receiving scrolled: false confirms you have reached that boundary — set stepComplete: true because reaching the boundary IS the goal.`
}

function generalRules(): string {
  return `4. Provide clear reasoning explaining why you chose this action and element.
5. Set confidence based on how certain you are: 1.0 = exact match found, 0.5 = best guess, 0.0 = very uncertain.
6. Use only evidence from the current screen state, previous step outcomes, runtime memory, and explicit user-provided rules. Do not assume hidden source-code context or invent selectors that are not visible in the observation.
7. Prefer user-visible roles, labels, text, and coordinates from the current observation. Use stable attributes only when they appear in the screen state.`
}

function stepLifecycleRules(): string {
  return `8. You may be called multiple times within the same test step. You have three signals to control the step lifecycle:
   - stepComplete: false — more actions needed, continue working
   - stepComplete: true  — step goal is fully accomplished
   - stepFailed: true    — step goal cannot be achieved
   stepComplete and stepFailed are mutually exclusive. Never set both to true.
   You will receive your previous actions and their outcomes in the sub-action history. Use this to avoid repeating failed approaches — if an action produced no screen change or was rejected, try a fundamentally different strategy (different element, different action type, different navigation path).
   Set stepFailed when you have evidence the goal is impossible, not merely difficult:
   - Verification contradicted: step says "verify the button is blue" but it is visibly red — fail immediately
   - Target confirmed absent: step says "click checkout" but you have scrolled the full page and it does not exist
   - Precondition unmet: step says "fill the email field" but the form is disabled or not present
   - Wrong application state: step says "click Place Order on checkout" but screen shows the homepage with no path to checkout visible
   Do NOT set stepFailed when the goal might still be achievable:
   - Target element might be below the fold — scroll first
   - Page is still loading — wait first
   - Element exists but with a different label — try clicking it
   - An overlay, modal, or popup is blocking the target — dismiss it first
   When stepFailed is true, do not provide an action. The step ends immediately with your reasoning as the failure message.`
}

function elementTargetingRules(): string {
  return `9. When an element is visible on screen but has no [ref=eN] tag, use tapCoordinate instead of inventing a ref. Read coordinates from the @(x,y WxH) bounding box annotations in the screen state. These coordinates are in the same space as the [Viewport: WxH] header — output your tapCoordinate/swipe/pinch coords in THIS space. Do NOT estimate coordinates visually from screenshots. To tap the center of an element at @(100,200 80x40), use tapCoordinate with x=140, y=220.
10. NEVER hallucinate a ref. If an element appears in the observation without [ref=eN] (e.g. \`- menuitemradio "Chinese"\` with no ref), do NOT guess a ref number. Either use tapCoordinate with coordinates from the screenshot, or interact with a nearby ref'd element. Common cases: dropdown options, shadow DOM content, canvas elements, dynamically inserted items.
11. RECOVERY RECIPE — when you need to interact with an element that has NO [ref=eN]:
   Step 1: Check if the element has @(x,y WxH) bounds annotation → use tapCoordinate at the center (x + width/2, y + height/2)
   Step 2: If no bounds, find a parent or sibling element that DOES have a [ref=eN] → interact with that ref instead
   Step 3: Last resort — use tapCoordinate with coordinates estimated from the screenshot layout
   Step 4: NEVER fabricate a ref like e481 — fabricated refs always fail with "element not found"`
}

function assertionRules(): string {
  return `12. The "assert" action is a SIGNAL — it tells the system what condition you are verifying, but the adapter does NOT evaluate it. Assert is a no-op: it always succeeds, and the screen does not change. YOU must read the current screen observation BEFORE outputting assert, and include your verdict in the SAME tool call:
   - Condition IS satisfied AND this completes the step goal → output assert with stepComplete: true
   - Condition is NOT satisfied → do NOT assert. Instead, take an action to make the information visible (scroll, navigate), or set stepFailed if the screen contradicts the expected condition
   - Condition IS satisfied BUT more sub-goals remain (e.g., "verify X then click Y") → do NOT assert yet. Proceed to the next sub-goal action per Rule 13. Only set stepComplete after ALL sub-goals are done.
   NEVER output assert with stepComplete: false — assert does not change the screen, so repeating it produces an infinite loop with no new information.
   ASSERTION FAILURE FOR NON-VISUAL CONDITIONS: When a step says "verify X equals Y" or "check that A matches B" and the condition is NOT met (X ≠ Y, A ≠ B), you MUST set stepFailed: true with a reason explaining the mismatch. Do NOT use setVariable, scroll, navigate, or any other action — stepFailed is the ONLY correct response to a failed assertion.
   STRICT LITERAL ASSERTION: Assert the EXACT condition from the step text. If the step says "verify 42 equals 30", you assert whether 42 equals 30 — it does not, so stepFailed. You do NOT rewrite it as "42 does not equal 30" and pass. You do NOT store "42 ≠ 30" via setVariable and pass. The step text is the test spec. If reality contradicts the spec, the test FAILS. This is QA — your job is to report truth, not make tests pass.
   When asserting about something NOT visible on screen — tautologies ("42 equals 42"),
   hook/env variable checks ("hook set env MY_VAR to abc"), runJS output comparisons
   ("runJS returned 42"), or computed value checks — set visual: false on the assert action.
   The system will trust your judgment without requiring screen evidence.
   When asserting about something visible on screen ("button says Submit", "title is Dashboard",
   "error message appears") — leave visual as default (true) or set visual: true.
   The system will verify your claim against the screenshot.`
}

function qaMindsetRules(): string {
  return `13. QA MINDSET — ALWAYS MOVE FORWARD: Break the step instruction into sub-goals. Execute each sub-goal in order. After executing an action, MOVE to the next sub-goal — do not retry the same action, do not assert about what you just did, do not wait for visual confirmation of intermediate actions. An assert is NOT forward progress — if your reasoning identifies a next action, your output MUST be that action, not an assert about the current state. Review your previous actions in the sub-action history below — if you have already completed all parts of the step instruction, set stepComplete: true immediately instead of re-verifying or re-asserting. Example: step says "select Satellite and dismiss the panel" → sub-goal 1: tap Satellite, sub-goal 2: tap X to close. After tapping Satellite, immediately tap X — do not assert that Satellite is selected. After all sub-goals are done, set stepComplete: true.
14. TRUST THE ARIA TREE, VERIFY WITH SCREENSHOTS: The ARIA tree is your trusted source for finding elements and understanding page structure. Use it to navigate, plan actions, and locate targets. But for ASSERTIONS — any step that says "verify", "check", "confirm", or uses the assert action — you must confirm the claim is true by what is visible in the screenshot:
   - Before asserting, ensure the target content is visible in the current viewport. If the target is above or below the visible area, SCROLL to bring it into view first, then assert. This applies in both directions — scroll up for content at the top, scroll down for content at the bottom.
   - For quantity assertions ("verify there are 30 items"), you MUST scroll through the entire content to visually confirm. The ARIA tree shows the full page including off-screen elements — you cannot verify quantity from the ARIA tree alone.
   - The ARIA tree tells you WHERE things are. The screenshot tells you what the user ACTUALLY SEES. Assertions are about what the user sees.
   - Visual issues invisible to the ARIA tree: overlapping elements, occlusion by modals, z-index problems, rendering failures, items hidden behind other content.`
}

function recoveryRules(): string {
  return `15. VERIFICATION FAILURE RECOVERY: When the verifier rejects your stepComplete (you see "step NOT complete" in your sub-action history), do NOT retry the same assert. Escalate progressively:
   1st rejection — DIFFERENT APPROACH: Re-read the screen. Try a different action, element, or strategy to achieve the goal
   2nd rejection — MAKE IT VISIBLE: The content may be off-screen or hidden. Scroll to bring it into view, dismiss overlays, or wait for loading
   3rd+ rejection — set stepFailed with clear reasoning about what approaches you tried and why the goal appears unachievable from the current state
16. CROSS-STEP CONTEXT: Use previous step outcomes to narrow your current step's scope. When a previous step found a specific element, row, or area, your current step's references to "this", "that", "the same", or "its" refer to what was found. Don't start fresh — build on prior work. The "Previous steps in this test" section above tells you what was already accomplished and where.
17. AMBIGUITY DETECTION: If you cannot uniquely identify the target element from the step instruction + previous step context + current screen state, set stepFailed with a message listing the ambiguous candidates. Do NOT guess when multiple elements match a generic description ("the button", "the link", "the icon"). A QA engineer asks for clarification rather than guessing — you fail the step. Single match = proceed. Multiple matches with disambiguating context from previous steps = use that context to select. Multiple matches with no context = fail.
   ASSERTION PRECISION: Read quantity qualifiers carefully before asserting:
   - "exists" / "is present" / "is mentioned" = at least one match. Multiple matches = pass.
   - "only once" / "exactly one" / "single" = count must be exactly 1. Multiple = fail.
   - "should not exist" / "is not shown" = zero matches. Any match = fail.
18. For web doubleClick/rightClick, do not use relativePosition { x: 0, y: 0 } unless the step explicitly asks for top-left or zero-offset, and omit no-op optional fields such as clickDelay: 0. If a doubleClick/rightClick fails because top-left is intercepted, retry the same semantic action at the center/interior of the same ref; do not switch to tapCoordinate or single click.`
}

function completionRules(): string {
  return `19. ACTION STEP COMPLETION: When the step instruction is a pure action — a single verb like "click", "tap", "press", "select", "scroll to", or "fill" targeting a specific element — and you found the target element and executed the action successfully, set stepComplete: true immediately. Do NOT retry expecting a visible screen change. Many successful actions produce no visible change on the current page: file downloads save to disk silently, external links open in new tabs, buttons trigger background processes, PDF links open in the browser's PDF viewer. This rule applies to SINGLE-ACTION steps only. If the step has multiple sub-goals ("click X and then verify Y"), complete the action sub-goal and move to the next per Rule 13 — do not set stepComplete until ALL sub-goals are done.
20. TRUST LOG READ RESULTS: When readConsoleLogs or readNetworkLogs returns data, that data is the complete set of logs captured since the last step. Do NOT re-trigger user actions (clicks, taps, navigation) to "regenerate" logs — the logs from prior steps are already captured. If readConsoleLogs returns an empty array, it means no matching console output was captured during this step's execution. If the step requires verifying log content and readConsoleLogs returns empty, either the expected log was not emitted or it was captured in a prior step — check the step instruction and set stepFailed if the expected log output is absent after one read attempt.
21. The setVariable action stores a runtime variable accessible via {{env:varName}} in later steps. ONLY use setVariable when the step instruction explicitly asks to set, store, save, or remember a variable (e.g., "Set env X to Y", "Store the value as env.token"). NEVER use setVariable as a substitute for page interactions, assertions, or any other action. If the step does not explicitly mention setting a variable, do not call setVariable.`
}

// ---------------------------------------------------------------------------
// Rule composer — joins groups into the Rules: block
// ---------------------------------------------------------------------------

function buildRules(agentRules?: string): string {
  const groups = [
    actionSelectionRules(),
    scrollRules(),
    generalRules(),
    stepLifecycleRules(),
    elementTargetingRules(),
    assertionRules(),
    qaMindsetRules(),
    recoveryRules(),
    completionRules(),
  ]
  let rules = 'Rules:\n' + groups.join('\n')
  if (agentRules) {
    rules += `\n\nCustom rules:\n${agentRules}`
  }
  return rules
}

// ---------------------------------------------------------------------------
// Step prompt section helpers
// ---------------------------------------------------------------------------

function appendContextSection(parts: string[], context: StepContext): void {
  if (context.suiteContext && context.testContext) {
    parts.push(`Suite context: ${context.suiteContext}\nTest context: ${context.testContext}`)
  } else if (context.suiteContext) {
    parts.push(`Suite context: ${context.suiteContext}`)
  } else if (context.testContext) {
    parts.push(`Test context: ${context.testContext}`)
  }
}

function appendPreviousSteps(parts: string[], context: StepContext): void {
  if (context.previousSteps.length > 0) {
    parts.push('Previous steps in this test:')
    for (const prev of context.previousSteps) {
      parts.push(`- "${prev.instruction}" -> ${prev.outcome}`)
      if (prev.reasoning) parts.push(`  Reasoning: ${prev.reasoning}`)
      if (prev.plannedAction) parts.push(`  Action: ${prev.plannedAction}`)
      if (prev.verifierResponse) parts.push(`  Verification: ${prev.verifierResponse}`)
    }
  }
}

function appendMemoryContext(parts: string[], context: StepContext): void {
  if (!context.memoryContext) return
  parts.push('')
  parts.push(context.memoryContext)
}

function appendSubActionHistory(parts: string[], context: StepContext): void {
  if (!context.subActionHistory || context.subActionHistory.length === 0) return

  const history = context.subActionHistory
  const subHistoryParts: string[] = []
  subHistoryParts.push('Actions already taken for this step:')

  for (const sub of history) {
    let suffix = ''
    if (sub.result === 'failure') suffix = ` — FAILED: ${sub.error?.slice(0, 120)}`
    else if (sub.verifierRejection) suffix = ` — step NOT complete: ${sub.verifierRejection?.slice(0, 120)}`
    else if (sub.screenChanged === false) suffix = ` — screen did NOT change (action had no visible effect)`
    const reason = sub.reasoning ? ` (${sub.reasoning})` : ''
    subHistoryParts.push(`  ${sub.result === 'success' ? '✓' : '✗'} ${sub.action}${reason}${suffix}`)
    if (sub.data) subHistoryParts.push(`    Returned data: ${sub.data}`)
  }

  if (history.length >= 2) {
    const last = history[history.length - 1]
    const prev = history[history.length - 2]
    if (last.action === prev.action && last.screenChanged === false) {
      subHistoryParts.push('')
      subHistoryParts.push('WARNING: Your previous action produced no visible change on screen. The element may be non-interactive or your action had no effect. You MUST try a completely different approach — a different element, a different action type, or a different strategy entirely. Do NOT repeat the same action again.')
    }
  }

  parts.push('')
  parts.push(subHistoryParts.join('\n'))
}

function appendFailureContext(parts: string[], context: StepContext): void {
  if (!context.failureContext) return
  parts.push('')
  parts.push('PREVIOUS ATTEMPT FAILED — avoid repeating the same approach:')
  parts.push(context.failureContext)
  parts.push('')
  parts.push('Adapt your strategy based on the failure above. Try a different element, selector, or approach.')
}

function appendDomContext(parts: string[], screenState: ScreenState): void {
  if (screenState.metadata?.domContext) {
    parts.push('')
    parts.push('DOM structure (supplementary context — use ARIA element refs above for all action targeting):')
    parts.push(screenState.metadata.domContext as string)
  }
}

// ---------------------------------------------------------------------------
// Exported prompt composers
// ---------------------------------------------------------------------------

export function buildSystemPrompt(platform?: 'web' | 'android' | 'ios', agentRules?: string): string {
  const rulesBlock = buildRules(agentRules)

  return `You are the agent-qa test automation agent. Your job is to determine the correct action to execute for a given test step based on the current screen state.

Available action types:
${defaultRegistry.generateDocs(platform)}

${rulesBlock}

Call the tool matching the action you want to execute. Include reasoning, confidence, stepComplete, and stepFailed in the tool call.`
}

export function buildStepPrompt(
  step: string,
  screenState: ScreenState,
  context: StepContext,
  logger?: ScopedLogger,
  systemPromptContext?: { platform?: 'web' | 'android' | 'ios'; agentRules?: string },
): string {
  const parts: string[] = []

  appendContextSection(parts, context)
  appendPreviousSteps(parts, context)
  appendMemoryContext(parts, context)
  appendSubActionHistory(parts, context)
  appendFailureContext(parts, context)

  parts.push('')
  parts.push(`Current step: "${step}"`)
  parts.push('')
  parts.push('Current screen state:')
  parts.push(truncateScreenState(screenState))

  appendDomContext(parts, screenState)

  const fullPrompt = parts.join('\n')

  if (context.contextWindow) {
    const systemTokens = estimateTokens(buildSystemPrompt(
      systemPromptContext?.platform,
      systemPromptContext?.agentRules ?? context.agentRules,
    ))
    const promptTokens = estimateTokens(fullPrompt)
    const totalTokens = systemTokens + promptTokens

    logger?.debug('Context composition', {
      systemTokens,
      screenStateTokens: estimateTokens(screenState.tree),
      stepTokens: estimateTokens(step),
      previousStepTokens: estimateTokens(context.previousSteps.map(p => p.instruction).join('\n')),
      subActionTokens: estimateTokens(context.subActionHistory?.map(s => s.action).join('\n') ?? ''),
      totalTokens,
    })

    if (totalTokens > context.contextWindow) {
      logger?.warn(`Estimated ${totalTokens} tokens exceeds contextWindow of ${context.contextWindow}. Reduce previousStepCount (currently ${context.plannerConfig?.previousStepCount}) or increase contextWindow on this LLM config.`)
    }
  }

  return fullPrompt
}

export function formatAction(action: Action): string {
  switch (action.type) {
    case 'click':
    case 'hover':
    case 'tap':
    case 'longpress':
    case 'doubleTap':
    case 'clearText':
    case 'doubleClick':
    case 'rightClick':
      return `${action.type} on ref="${action.ref}"`
    case 'fill':
      return `fill ref="${action.ref}" with value="${action.value}"`
    case 'select':
      return `select ref="${action.ref}" value="${action.value}"`
    case 'nativeSelect':
      return `nativeSelect ref="${action.ref}" value="${action.value}"`
    case 'navigate':
    case 'openLink':
      return `${action.type} to "${action.url}"`
    case 'scroll':
      return `scroll ${action.scrollType} ${action.value}px${action.ref ? ` on ref="${action.ref}"` : ''}`
    case 'swipe':
      if (action.startX !== undefined && action.startY !== undefined && action.endX !== undefined && action.endY !== undefined) {
        return `swipe from (${action.startX},${action.startY}) to (${action.endX},${action.endY})${action.ref ? ` on ref="${action.ref}"` : ''}`
      }
      return `swipe ${action.direction}${action.ref ? ` on ref="${action.ref}"` : ''}`
    case 'pinch':
      return `pinch scale=${action.scale}${action.ref ? ` on ref="${action.ref}"` : ''}`
    case 'multiTap':
      return `${action.fingers}-finger tap${action.ref ? ` on ref="${action.ref}"` : ''}`
    case 'waitFor':
      return `waitFor "${action.condition}"`
    case 'delay':
      return `delay ${action.ms}ms`
    case 'waitForUrl':
      return `waitForUrl pattern="${action.pattern}"`
    case 'fileUpload':
      return `fileUpload ref="${action.ref}" files=[${action.files.join(', ')}]`
    case 'copy':
      return `copy ref="${action.ref}"`
    case 'assert':
      return `assert "${action.condition}"${action.expected ? ` equals "${action.expected}"` : ''}${action.visual === false ? ' [non-visual]' : ''}`
    case 'keypress':
      return `keypress [${action.keys.join(', ')}]`
    case 'paste':
      return `paste ref="${action.ref}" value="${action.value}"`
    case 'keyDown':
      return `keyDown "${action.key}"`
    case 'keyUp':
      return `keyUp "${action.key}"`
    case 'refresh':
      return 'refresh page'
    case 'navigateHistory':
      return `navigate ${action.direction}`
    case 'hideKeyboard':
      return 'hide keyboard'
    case 'drag':
      return `drag from ref="${action.fromRef}" to ref="${action.toRef}"`
    case 'launchApp':
    case 'stopApp':
      return `${action.type} "${action.bundleId}"`
    case 'setOrientation':
      return `set orientation to ${action.orientation}`
    case 'tapCoordinate':
      return `tap at coordinates (${action.x}, ${action.y})`
    case 'readConsoleLogs': {
      const parts: string[] = []
      if (action.level) parts.push(`level: ${action.level}`)
      if (action.tab) parts.push(`tab: ${JSON.stringify(action.tab)}`)
      return `read console logs${parts.length ? ` (${parts.join(', ')})` : ''}`
    }
    case 'readNetworkLogs': {
      const parts: string[] = []
      if (action.urlPattern) parts.push(`filter: ${action.urlPattern}`)
      if (action.tab) parts.push(`tab: ${JSON.stringify(action.tab)}`)
      return `read network logs${parts.length ? ` (${parts.join(', ')})` : ''}`
    }
    case 'readCookies':
      return `read cookies${action.name ? ` (name: ${action.name})` : ''}`
    case 'setCookies':
      return `set ${action.cookies.length} cookie(s)`
    case 'readLocalStorage':
      return `read local storage${action.key ? ` (key: ${action.key})` : ''}`
    case 'setLocalStorage':
      return `set ${action.entries.length} local storage entry(ies)`
    case 'executeScript':
      return `executeScript "${action.command}"${action.args ? ` with ${JSON.stringify(action.args)}` : ''}`
    case 'setVariable': {
      const sv = action as Extract<Action, { type: 'setVariable' }>
      return `setVariable "${sv.name}" = "${sv.value}"`
    }
    case 'newTab':
      return `open new tab "${action.url}"`
    case 'switchTab': {
      if (action.index !== undefined) return `switch to tab index ${action.index}`
      if (action.title) return `switch to tab with title "${action.title}"`
      if (action.url) return `switch to tab with URL "${action.url}"`
      return 'switch tab'
    }
  }
}

export function buildVerificationPrompt(
  step: string,
  beforeState: ScreenState,
  afterState: ScreenState,
  action: Action,
  hasScreenshot = false,
): string {
  const parts: string[] = []

  let actionDesc = formatAction(action)
  if ('ref' in action && action.ref && beforeState.elements.length > 0) {
    const el = beforeState.elements.find(e => e.ref === action.ref)
    if (el) actionDesc += ` (${el.role} "${el.name}")`
  }

  parts.push('You are verifying whether a test step was successfully completed.')
  parts.push('')
  parts.push(`Step goal: "${step}"`)
  parts.push(`Action taken: ${actionDesc}`)
  parts.push('')
  parts.push('Screen BEFORE action:')
  parts.push(truncateScreenState(beforeState))
  parts.push('')
  parts.push('Screen AFTER action:')
  parts.push(truncateScreenState(afterState))
  parts.push('')
  parts.push('Verification approach:')
  parts.push('Evaluate whether the step goal was accomplished. Look for NEGATIVE evidence — signs the action FAILED or the goal was NOT met:')
  parts.push('- Application errors (HTTP errors, error toasts, crashes, "not found" messages)')
  parts.push('- Contradicting state (wrong page, target element missing, unexpected content)')
  parts.push('- Clear evidence the action did not execute (element still in pre-action state when it should have changed)')
  parts.push('')
  parts.push('IMPORTANT: Absence of visible screen change is NOT evidence of failure. Many interactions produce results outside the current page (navigating to new tabs, triggering background processes, initiating file operations, updating server state). If the action targeted a valid element and no error or contradicting state is visible, the goal is likely accomplished.')
  parts.push('')
  parts.push('For verification/assertion steps (step says "verify", "check", "confirm"): require POSITIVE evidence — the claimed condition must be visible on screen or in the ARIA tree.')
  parts.push('For action steps (step says "click", "tap", "fill", "select", "press"): if the target element existed and no error appeared, return success unless there is clear evidence of failure.')
  if (hasScreenshot) {
    parts.push('')
    parts.push('Analyze the attached screenshot for visual cues the ARIA tree cannot capture: colors, layout, images, visual indicators, error states. When the screenshot and ARIA tree conflict, visual evidence takes precedence. For quantity claims, only confirm what you can count in the screenshot.')
  }
  parts.push('')
  parts.push('Return a JSON object with:')
  parts.push('- success (boolean): whether the step goal was accomplished')
  parts.push('- reasoning (string): explanation of your judgment')
  parts.push('- isAppError (boolean): whether the page shows an application error')

  return parts.join('\n')
}

export function buildAssertionPrompt(
  assertion: AssertionInput,
  screenState: ScreenState,
): string {
  const parts: string[] = []

  parts.push('You are verifying a test assertion against the current screen state.')
  parts.push('')
  parts.push(`Assertion: "${assertion.value}"`)
  if (assertion.expected) {
    parts.push(`Expected: "${assertion.expected}"`)
  }
  parts.push('')
  parts.push('Current screen state:')
  parts.push(truncateScreenState(screenState))
  parts.push('')
  parts.push('Evaluate whether the assertion is satisfied based on what you see on screen.')
  parts.push('Return a JSON object with:')
  parts.push('- passed (boolean): whether the assertion holds true')
  parts.push('- reasoning (string): explanation of your judgment')
  parts.push('- evidence (string): specific text or elements from the screen that support your judgment')

  return parts.join('\n')
}

export function buildExtractionPrompt(
  input: ExtractorInput,
  screenState: ScreenState,
): string {
  const parts: string[] = []

  parts.push('You are extracting a dynamic value from the current screen state.')
  parts.push('')
  parts.push(`Variable to capture: "${input.variableName}"`)

  if (input.description) {
    parts.push(`Description: ${input.description}`)
  }
  if (input.pattern) {
    parts.push(`Pattern hint: ${input.pattern}`)
  }
  if (input.selector) {
    parts.push(`Selector hint: ${input.selector}`)
  }

  parts.push('')
  parts.push('Current screen state:')
  parts.push(truncateScreenState(screenState))
  parts.push('')
  parts.push('Return a JSON object with:')
  parts.push('- value (string): the extracted value')
  parts.push('- reasoning (string): why this is the correct value')

  return parts.join('\n')
}
