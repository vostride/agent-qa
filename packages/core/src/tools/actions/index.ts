import { z } from 'zod'
import type { ToolRegistry } from '../registry.js'
import type { ToolDefinition } from '../types.js'
import { getPlatformFilter } from './platform-filters.js'

function action(name: string, description: string, schema: z.ZodObject<any>): ToolDefinition {
  return {
    name,
    description,
    category: 'action',
    platform: getPlatformFilter(name),
    schema,
  }
}

const ACTION_DEFINITIONS: ToolDefinition[] = [
  action('click', 'Click an element', z.object({
    ref: z.string().describe('Element reference from the screen state'),
    clickDelay: z.number().optional().describe('Omit when there is no requested delay. Only provide a positive value when the user explicitly asks for a delay.'),
  })),

  action('fill', 'Fill text into an input field', z.object({
    ref: z.string().describe('Element reference for the input field'),
    value: z.string().describe('Text value to fill into the input'),
  })),

  action('select', 'Select an option from a dropdown', z.object({
    ref: z.string().describe('Element reference for the select/dropdown'),
    value: z.string().describe('Option value to select'),
  })),

  action('nativeSelect', 'Select a value from a native mobile picker, picker wheel, spinner, or dropdown/list control', z.object({
    ref: z.string().describe('Element reference for the native picker/dropdown control'),
    value: z.string().describe('Visible text/value to select'),
  })),

  action('navigate', 'Navigate to a URL', z.object({
    url: z.string().describe('URL to navigate to'),
  })),

  action('scroll', 'Scroll the page or a specific element', z.object({
    scrollType: z.enum(['vertical', 'horizontal']).describe('Scroll axis: vertical (up/down) or horizontal (left/right)'),
    value: z.number().describe('Scroll distance in pixels. Positive = down/right, negative = up/left'),
    ref: z.string().optional().describe('Optional element to scroll within'),
    duration: z.number().optional().describe('Scroll duration in ms (mobile only — web ignores this)'),
  })),

  action('delay', 'Pause execution for a fixed duration — use when a specific duration is requested (e.g. "wait 3 seconds"). Do NOT use for waiting on conditions (use waitFor for that).', z.object({
    ms: z.number().describe('Duration in milliseconds'),
  })),

  action('waitFor', 'Wait for a condition to be met (text content match or selector)', z.object({
    condition: z.string().describe('Condition to wait for — either visible text content or a CSS selector'),
    timeout: z.number().optional().describe('Maximum wait time in ms (default: 5000)'),
  })),

  action('assert', 'Assert a condition on the current page state', z.object({
    condition: z.string().describe('Assertion condition to check'),
    expected: z.string().optional().describe('Expected value for comparison'),
    visual: z.boolean().optional().default(true)
      .describe('Whether this assertion requires screen evidence. Set false for non-visual checks (tautologies, hook/env results, runJS outputs, computed values). Default true for screen-visible assertions.'),
  })),

  action('keypress', 'Press one or more keyboard keys/combos in sequence', z.object({
    keys: z.array(z.string()).min(1).describe('Array of keys/combos to press in sequence. Each entry may be a single key (e.g. "Enter", "Tab", "Escape") or a combo with "+" separators (e.g. "Meta+k", "Control+Shift+T"). Use "Meta" for the Cmd/Win/Super key — on non-Mac platforms it is automatically converted to "Control" when convertPlatformKeys is true. On mobile, only single special keys from the KEY_MAP work meaningfully; combos are a no-op.'),
    convertPlatformKeys: z.boolean().optional().default(true).describe('When true (default), replaces "Meta" with "Control" in each key string on non-Mac platforms so that "Meta+k" works as Cmd+K on Mac and Ctrl+K on Windows/Linux. Set to false to pass keys through unchanged. No-op on mobile.'),
  })),

  action('hover', 'Hover over an element', z.object({
    ref: z.string().describe('Element reference to hover over'),
  })),

  action('paste', 'Paste text into an element via clipboard paste event', z.object({
    ref: z.string().describe('Element reference for the target element'),
    value: z.string().describe('Text value to paste'),
  })),

  action('keyDown', 'Hold down a key (for modifier combos like Shift+Click)', z.object({
    key: z.string().describe('Key to hold down (e.g., Shift, Control, Alt, Meta)'),
  })),

  action('keyUp', 'Release a held key', z.object({
    key: z.string().describe('Key to release (e.g., Shift, Control, Alt, Meta)'),
  })),

  action('refresh', 'Refresh the current page', z.object({})),

  action('navigateHistory', 'Navigate browser history (back or forward)', z.object({
    direction: z.enum(['back', 'forward']).describe('Navigation direction in browser history'),
  })),

  action('readConsoleLogs', 'Read console log entries from the browser', z.object({
    level: z.enum(['log', 'info', 'warn', 'error']).optional()
      .describe('Filter by log level. Omit to get all levels.'),
    tab: z.object({
      index: z.number().optional().describe('0-based tab index'),
      title: z.string().optional().describe('Substring match on page title'),
      url: z.string().optional().describe('Substring match on page URL'),
    }).optional()
      .describe('Target a specific tab. Omit to read logs from all tabs.'),
  })),

  action('readNetworkLogs', 'Read network request/response log entries', z.object({
    urlPattern: z.string().optional()
      .describe('Filter by URL substring match. Omit to get all requests.'),
    tab: z.object({
      index: z.number().optional().describe('0-based tab index'),
      title: z.string().optional().describe('Substring match on page title'),
      url: z.string().optional().describe('Substring match on page URL'),
    }).optional()
      .describe('Target a specific tab. Omit to read logs from all tabs.'),
  })),

  action('readCookies', 'Read browser cookies', z.object({
    name: z.string().optional()
      .describe('Cookie name to read. Omit to get all cookies.'),
  })),

  action('setCookies', 'Set browser cookies', z.object({
    cookies: z.array(z.object({
      name: z.string().describe('Cookie name'),
      value: z.string().describe('Cookie value'),
      domain: z.string().optional().describe('Cookie domain'),
      path: z.string().optional().describe('Cookie path'),
      httpOnly: z.boolean().optional().describe('HTTP only flag'),
      secure: z.boolean().optional().describe('Secure flag'),
      sameSite: z.enum(['Strict', 'Lax', 'None']).optional().describe('SameSite attribute'),
      expires: z.number().optional().describe('Expiry as Unix timestamp in seconds'),
    })).describe('Array of cookies to set'),
  })),

  action('readLocalStorage', 'Read local storage entries', z.object({
    key: z.string().optional()
      .describe('Storage key to read. Omit to get all entries.'),
  })),

  action('setLocalStorage', 'Set local storage entries', z.object({
    entries: z.array(z.object({
      key: z.string().describe('Storage key'),
      value: z.string().describe('Storage value'),
    })).describe('Array of key-value pairs to set'),
  })),

  action('tap', 'Tap an element on a mobile device', z.object({
    ref: z.string().describe('Element reference to tap'),
  })),

  action('swipe', 'Swipe gesture on a mobile device', z.object({
    direction: z.enum(['up', 'down', 'left', 'right']).describe('Swipe direction'),
    ref: z.string().optional().describe('Optional element to swipe within'),
    startX: z.number().optional().describe('Start X coordinate (overrides direction-based calculation)'),
    startY: z.number().optional().describe('Start Y coordinate (overrides direction-based calculation)'),
    endX: z.number().optional().describe('End X coordinate (overrides direction-based calculation)'),
    endY: z.number().optional().describe('End Y coordinate (overrides direction-based calculation)'),
    duration: z.number().optional().describe('Swipe duration in ms (default: 300)'),
  })),

  action('longpress', 'Long-press an element on a mobile device', z.object({
    ref: z.string().describe('Element reference to long-press'),
    duration: z.number().optional().describe('Long-press duration in ms'),
  })),

  action('hideKeyboard', 'Dismiss the on-screen keyboard (mobile only, no-op on web)', z.object({})),

  action('clearText', 'Clear all text from an input field without typing new text', z.object({
    ref: z.string().describe('Element reference for the input field to clear'),
  })),

  action('openLink', 'Open a deep link in a mobile app — use navigate for web URLs', z.object({
    url: z.string().describe('Deep link URL to open (e.g. myapp://screen, intent://...)'),
    appId: z.string().optional().describe('Generic mobile app identifier. Android uses package name; iOS uses bundle ID.'),
    bundleId: z.string().optional().describe('iOS bundle ID to open the link in'),
    appPackage: z.string().optional().describe('Android package name to open the link in'),
    waitForLaunch: z.boolean().optional().describe('Whether to wait for the app to launch after opening the link'),
  })),

  action('drag', 'Drag an element to another element (reorder lists, sliders)', z.object({
    fromRef: z.string().describe('Element reference to drag from'),
    toRef: z.string().describe('Element reference to drag to'),
  })),

  action('doubleTap', 'Double-tap an element (text selection, zoom)', z.object({
    ref: z.string().describe('Element reference to double-tap'),
  })),

  action('launchApp', 'Launch or bring an app to the foreground', z.object({
    bundleId: z.string().describe('App bundle ID (iOS) or package name (Android)'),
  })),

  action('stopApp', 'Terminate a running app', z.object({
    bundleId: z.string().describe('App bundle ID (iOS) or package name (Android)'),
  })),

  action('setOrientation', 'Set the device orientation (mobile only)', z.object({
    orientation: z.enum(['portrait', 'landscape']).describe('Device orientation'),
  })),

  action('pinch', 'Pinch zoom gesture on a mobile device (mobile only)', z.object({
    scale: z.number().describe('Scale factor: >1 to zoom in (spread fingers), <1 to zoom out (pinch fingers)'),
    x: z.number().optional().describe('Center X coordinate for pinch gesture'),
    y: z.number().optional().describe('Center Y coordinate for pinch gesture'),
    ref: z.string().optional().describe('Optional element to center the pinch on'),
  })),

  action('multiTap', 'Multi-finger tap gesture on a mobile device (mobile only)', z.object({
    fingers: z.number().describe('Number of fingers (2 or 3)'),
    x: z.number().optional().describe('Center X coordinate for multi-finger tap'),
    y: z.number().optional().describe('Center Y coordinate for multi-finger tap'),
    ref: z.string().optional().describe('Optional element to center the tap on'),
  })),

  action('tapCoordinate', 'Tap at specific pixel coordinates — use when target element has no ref in accessibility tree', z.object({
    x: z.number().describe('X coordinate in pixels'),
    y: z.number().describe('Y coordinate in pixels'),
  })),

  action('executeScript', 'Execute an Appium script command (mobile only)', z.object({
    command: z.string().describe('Appium command name (e.g., "mobile: enrollBiometric", "mobile: terminateApp")'),
    args: z.any().optional()
      .describe('Command arguments — object with key-value pairs, or array for some commands'),
  })),

  action('setVariable', 'Set a runtime environment variable for use in subsequent steps', z.object({
    name: z.string().describe('Variable name (will be accessible via {{env:varName}})'),
    value: z.string().describe('Variable value to store'),
  })),

  action('newTab', 'Open a URL in a new browser tab and switch to it', z.object({
    url: z.string().describe('URL to open in the new tab'),
  })),

  action('switchTab', 'Switch to an open browser tab', z.object({
    index: z.number().optional().describe('0-based tab index to switch to'),
    title: z.string().optional().describe('Substring match on page title'),
    url: z.string().optional().describe('Substring match on page URL'),
  })),

  action('doubleClick', 'Double-click an element (text selection, expand, web-only)', z.object({
    ref: z.string().describe('Element reference from the screen state'),
    relativePosition: z.object({
      x: z.number().describe('X offset in pixels from element top-left'),
      y: z.number().describe('Y offset in pixels from element top-left'),
    }).optional().describe('Omit for normal element-center interaction. Only provide when the user explicitly asks for an offset. Do not use { x: 0, y: 0 } for a normal button double-click/right-click; top-left is often intercepted.'),
    clickDelay: z.number().optional().describe('Omit when there is no requested delay. Only provide a positive value when the user explicitly asks for a delay.'),
  })),

  action('rightClick', 'Right-click an element to open context menu (web-only)', z.object({
    ref: z.string().describe('Element reference from the screen state'),
    relativePosition: z.object({
      x: z.number().describe('X offset in pixels from element top-left'),
      y: z.number().describe('Y offset in pixels from element top-left'),
    }).optional().describe('Omit for normal element-center interaction. Only provide when the user explicitly asks for an offset. Do not use { x: 0, y: 0 } for a normal button double-click/right-click; top-left is often intercepted.'),
    clickDelay: z.number().optional().describe('Omit when there is no requested delay. Only provide a positive value when the user explicitly asks for a delay.'),
  })),

  action('waitForUrl', 'Wait for the page URL to match a glob pattern (web only)', z.object({
    pattern: z.string().describe('URL glob pattern. Use "**" for substring matching (e.g., "**/dashboard**"). Plain strings WITHOUT wildcards require EXACT URL match, not substring.'),
  })),

  action('fileUpload', 'Upload one or more files to a file input element (web only)', z.object({
    ref: z.string().describe('Element reference for the file input'),
    files: z.array(z.string()).min(1).describe('Paths to files — relative to the test YAML file, or absolute paths. Missing files fail the action.'),
  })),

  action('copy', 'Copy the text content of an element to the system clipboard (web only, chromium only)', z.object({
    ref: z.string().describe('Element reference whose text content to copy'),
  })),
]

export function registerAllActions(registry: ToolRegistry): void {
  for (const def of ACTION_DEFINITIONS) {
    registry.register(def)
  }
}
