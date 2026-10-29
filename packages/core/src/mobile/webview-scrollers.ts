import { scrollerSetSwipeSignal } from '@vostride/agent-qa-runner'
import type { Direction, DocumentScrollOffsets, SwipeSignal } from '@vostride/agent-qa-runner'

// the WebView swipe is judged over identified, on-screen scrollers, and a
// frame in view makes the read null (review WR-20, IN-32 · D-25).

/** One WebView scroller with a structural identity: `document`, or a flat-tree path plus tag, id and class. */
export interface IdentifiedScrollOffsets extends DocumentScrollOffsets {
  id: string
}

/**
 * A WebDriver `execute` function body. It answers `null` when a frame (`iframe`, `frame`, `embed`,
 * `object`, `fencedframe`) with positive area intersects the viewport, because a swipe over it
 * moves content the page cannot measure. Otherwise it answers the document scroller first (id
 * `document`), then every on-screen element scroller in the document and its open shadow roots,
 * in tree order. A body whose overflow propagates to the viewport is not a member. Nothing is
 * written to the page: ids derive from structure alone. Closed shadow roots are unreachable.
 */
export const WEBVIEW_SCROLLERS_SCRIPT: string =
  'var d = document, w = window, s = d.scrollingElement || d.documentElement;'
  + 'var vw = w.innerWidth, vh = w.innerHeight;'
  + 'var frames = { IFRAME: 1, FRAME: 1, EMBED: 1, OBJECT: 1, FENCEDFRAME: 1 };'
  + 'var sc = function (v) { return v === "auto" || v === "scroll" || v === "overlay"; };'
  + 'var inView = function (el) {'
  + ' var r = el.getBoundingClientRect();'
  + ' return Math.min(r.right, vw) > Math.max(r.left, 0) && Math.min(r.bottom, vh) > Math.max(r.top, 0);'
  + '};'
  + 'var rs = getComputedStyle(d.documentElement);'
  + 'var bodyPropagates = rs.overflowX === "visible" && rs.overflowY === "visible";'
  + 'var out = [{ id: "document", x: w.scrollX, y: w.scrollY,'
  + ' maxX: s.scrollWidth - s.clientWidth, maxY: s.scrollHeight - s.clientHeight }];'
  + 'var stack = [{ el: d.documentElement, path: "0" }];'
  + 'while (stack.length > 0) {'
  + ' var item = stack.pop(), el = item.el, path = item.path;'
  + ' var kids = [], i;'
  + ' if (el.shadowRoot) { for (i = 0; i < el.shadowRoot.children.length; i++) kids.push({ el: el.shadowRoot.children[i], path: path + "/s" + i }); }'
  + ' for (i = 0; i < el.children.length; i++) kids.push({ el: el.children[i], path: path + "/" + i });'
  + ' for (i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);'
  + ' if (frames[String(el.tagName).toUpperCase()] && inView(el)) return null;'
  + ' if (el === s || el === d.documentElement || (el === d.body && bodyPropagates)) continue;'
  + ' var mx = el.scrollWidth - el.clientWidth, my = el.scrollHeight - el.clientHeight;'
  + ' if (!(mx > 0 || my > 0)) continue;'
  + ' var st = getComputedStyle(el);'
  + ' var sx = mx > 0 && sc(st.overflowX), sy = my > 0 && sc(st.overflowY);'
  + ' if ((!sx && !sy) || !inView(el)) continue;'
  + ' out.push({ id: path + "|" + String(el.localName) + "#" + (el.getAttribute("id") || "") + "." + (el.getAttribute("class") || ""),'
  + ' x: el.scrollLeft, y: el.scrollTop, maxX: sx ? mx : 0, maxY: sy ? my : 0 });'
  + '}'
  + 'return out;'

function memberOf(value: unknown): IdentifiedScrollOffsets | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { id, x, y, maxX, maxY } = value as Record<string, unknown>
  if (typeof id !== 'string' || id.length === 0) return undefined
  const offsets = [x, y, maxX, maxY]
  if (!offsets.every((n) => typeof n === 'number' && Number.isFinite(n))) return undefined
  return { id, x, y, maxX, maxY } as IdentifiedScrollOffsets
}

function byId(members: readonly unknown[]): Map<string, IdentifiedScrollOffsets> | undefined {
  if (members.length === 0) return undefined
  const map = new Map<string, IdentifiedScrollOffsets>()
  for (const value of members) {
    const member = memberOf(value)
    if (!member || map.has(member.id)) return undefined
    map.set(member.id, member)
  }
  return map
}

/** A non-empty array of members with string ids, finite offsets and no duplicate id; else undefined. */
export function parseWebViewScrollers(raw: unknown): IdentifiedScrollOffsets[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const map = byId(raw)
  return map ? [...map.values()] : undefined
}

/**
 * Before and after are paired by id. The same membership is judged by the scroller-set rule; a
 * changed membership is `moved` only when a member present in both reads moved, else `unknown`.
 */
export function webViewSwipeSignal(
  direction: Direction,
  before: readonly IdentifiedScrollOffsets[] | undefined,
  after: readonly IdentifiedScrollOffsets[] | undefined,
): SwipeSignal {
  if (!before || !after) return 'unknown'
  const b = byId(before)
  const a = byId(after)
  if (!b || !a) return 'unknown'
  const common = [...b.keys()].filter((id) => a.has(id))
  const signal = scrollerSetSwipeSignal(
    direction,
    common.map((id) => b.get(id)!),
    common.map((id) => a.get(id)!),
  )
  const same = common.length === b.size && common.length === a.size
  if (same) return signal
  return signal === 'moved' ? 'moved' : 'unknown'
}
