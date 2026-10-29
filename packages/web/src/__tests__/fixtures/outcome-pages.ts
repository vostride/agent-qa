// Pages are opened as `http://localhost:<port>/`, which is a secure context.

import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/** The bytes `/files/orders.csv` serves; the download cells hash them. */
export const ORDERS_CSV_BYTES = 'order,total\nORD-1001,42.50\nORD-1002,17.00\n'

export interface OutcomeState {
  saved: string[]
  archived: string[]
  counter: number
}

export interface OutcomePages {
  url(path: string): string
  /** The server's persisted state, read by the scripted verifiers. */
  readonly state: OutcomeState
  close(): Promise<void>
}

function page(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>${title}</title></head>
<body>
${body}
</body>
</html>
`
}

// "Export CSV" fetches the file through an attachment link and leaves the page as it was.
// "Prepare export" does nothing the browser or the page can observe.
const DOWNLOAD_PAGE = page('Exports', `
  <h1>Order exports</h1>
  <button id="prepare" onclick="window.prepared = true">Prepare export</button>
  <button id="export" onclick="exportCsv()">Export CSV</button>
  <script>
    function exportCsv() {
      const a = document.createElement('a')
      a.href = '/files/orders.csv'
      document.body.appendChild(a)
      a.click()
      a.remove()
    }
  </script>`)

// The app writes the order number to the clipboard; the page does not change.
const CLIPBOARD_PAGE = page('Order', `
  <h1>Order ORDER-4471</h1>
  <button type="button" onclick="navigator.clipboard.writeText('ORDER-4471')">Copy order number</button>`)

// "Save draft" posts the draft in the background; nothing on the page changes.
const SAVE_PAGE = page('Draft', `
  <h1>Draft</h1>
  <label>Draft <input id="draft" value="Quarterly report draft"></label>
  <button type="button" onclick="fetch('/api/save', { method: 'POST', body: document.getElementById('draft').value })">Save draft</button>`)

// A Save that does nothing, beside a clock whose text changes every 200 ms. Enter in the form
// submits nothing either.
const DEAD_SAVE_PAGE = page('Draft', `
  <h1>Draft</h1>
  <h2 id="clock">Local time 00:00:00.00</h2>
  <form onsubmit="event.preventDefault()">
    <label>Draft <input id="draft" value="Quarterly report draft"></label>
    <button type="button">Save</button>
  </form>
  <script>
    const clock = document.getElementById('clock')
    setInterval(() => { clock.textContent = 'Local time ' + new Date().toISOString().slice(11, 22) }, 200)
  </script>`)

// A button whose requested dialog never opens.
const DEAD_DIALOG_PAGE = page('Team', `
  <h1>Team</h1>
  <button type="button">Invite teammate</button>`)

// The dead dialog's twin: the same button opens the dialog.
const DIALOG_PAGE = page('Team', `
  <h1>Team</h1>
  <button type="button" onclick="document.getElementById('invite').showModal()">Invite teammate</button>
  <dialog id="invite"><h2>Invite a teammate</h2><button type="button">Send invite</button></dialog>`)

// Each press is counted by the server. The count is shown as plain text, which is not part of
// the observed elements, so the screen identity stays the same from press to press.
const COUNTER_PAGE = page('Counter', `
  <h1>Counter</h1>
  <p id="count">Count: 0</p>
  <button type="button" onclick="addOne()">Add one</button>
  <script>
    async function addOne() {
      const response = await fetch('/api/counter', { method: 'POST' })
      const { counter } = await response.json()
      document.getElementById('count').textContent = 'Count: ' + counter
    }
  </script>`)

function archiveScript(): string {
  return `<script>
    function archive(id) { fetch('/api/archive', { method: 'POST', body: id }) }
  </script>`
}

// Five rows with the same "Archive" label; archiving changes nothing on the page.
const ROWS_PAGE = page('Orders', `
  <h1>Orders</h1>
  <ul>
    ${[1001, 1002, 1003, 1004, 1005]
      .map((n) => `<li>Order ${String(n)} <button type="button" onclick="archive('order-${String(n)}')">Archive</button></li>`)
      .join('\n    ')}
  </ul>
  ${archiveScript()}`)

// Three rows, each with a "More actions" overflow menu holding Archive and Duplicate. A menu is
// hidden until its button opens it, and choosing an item closes it.
const OVERFLOW_PAGE = page('Orders', `
  <h1>Orders</h1>
  <ul>
    ${[2001, 2002, 2003]
      .map((n) => `<li>Order ${String(n)}
      <button type="button" aria-haspopup="menu" onclick="openMenu(this)">More actions</button>
      <div role="menu" hidden>
        <div role="menuitem" tabindex="-1" onclick="archive('order-${String(n)}'); closeMenus()">Archive</div>
        <div role="menuitem" tabindex="-1" onclick="closeMenus()">Duplicate</div>
      </div>
    </li>`)
      .join('\n    ')}
  </ul>
  ${archiveScript()}
  <script>
    function closeMenus() { document.querySelectorAll('[role=menu]').forEach((menu) => { menu.hidden = true }) }
    function openMenu(button) { closeMenus(); button.nextElementSibling.hidden = false }
  </script>`)

// A scrolling list whose rows are plain text, so they are not observed elements: scrolling it
// moves the container without changing the screen identity. "Item 80" is rendered only once the
// row it lives in has been scrolled into the container's view, seven page-height swipes down.
const LONG_LIST_PAGE = page('Order history', `
  <h1>Order history</h1>
  <div id="list" role="region" aria-label="Order history list"
       style="position: relative; height: 300px; overflow-y: auto; border: 1px solid #888">
    <div id="rows"></div>
  </div>
  <script>
    const list = document.getElementById('list')
    const rows = document.getElementById('rows')
    const slotTop = window.innerHeight * 7 + 100
    let filled = 0
    for (let i = 1; filled + 60 <= slotTop; i++, filled += 60) {
      const row = document.createElement('div')
      row.style.height = '60px'
      row.textContent = 'Row ' + i
      rows.append(row)
    }
    const spacer = document.createElement('div')
    spacer.style.height = String(slotTop - filled) + 'px'
    const slot = document.createElement('div')
    slot.style.height = '60px'
    const tail = document.createElement('div')
    tail.style.height = '400px'
    rows.append(spacer, slot, tail)
    list.addEventListener('scroll', () => {
      const inView = slot.offsetTop < list.scrollTop + list.clientHeight
        && slot.offsetTop + slot.offsetHeight > list.scrollTop
      if (inView && !slot.firstChild) slot.innerHTML = '<button type="button">Item 80</button>'
    })
  </script>`)

// A feed that cannot scroll, with a ticker inside it that changes every 200 ms.
const UNRELATED_UPDATE_PAGE = page('Activity', `
  <h1>Activity</h1>
  <div role="region" aria-label="Activity feed" style="height: 300px; overflow-y: auto">
    <h2 id="ticker">Updated 00:00:00.00</h2>
    <div>Order 1 shipped</div>
    <div>Order 2 packed</div>
  </div>
  <script>
    const ticker = document.getElementById('ticker')
    setInterval(() => { ticker.textContent = 'Updated ' + new Date().toISOString().slice(11, 22) }, 200)
  </script>`)

const PAGES: Record<string, string> = {
  '/download': DOWNLOAD_PAGE,
  '/clipboard': CLIPBOARD_PAGE,
  '/save': SAVE_PAGE,
  '/dead-save': DEAD_SAVE_PAGE,
  '/dead-dialog': DEAD_DIALOG_PAGE,
  '/dialog': DIALOG_PAGE,
  '/counter': COUNTER_PAGE,
  '/rows': ROWS_PAGE,
  '/overflow': OVERFLOW_PAGE,
  '/long-list': LONG_LIST_PAGE,
  '/unrelated-update': UNRELATED_UPDATE_PAGE,
}

function send(res: ServerResponse, status: number, type: string, body: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'Content-Length': String(Buffer.byteLength(body)),
    ...extra,
  })
  res.end(body)
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

export async function startOutcomePages(): Promise<OutcomePages> {
  const state: OutcomeState = { saved: [], archived: [], counter: 0 }

  const server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? '/').split('?')[0]
      if (path === '/files/orders.csv') {
        send(res, 200, 'text/csv', ORDERS_CSV_BYTES, {
          'Content-Disposition': 'attachment; filename="orders.csv"',
        })
        return
      }
      const html = PAGES[path]
      if (req.method === 'GET' && html !== undefined) {
        send(res, 200, 'text/html; charset=utf-8', html)
        return
      }
      const body = await readBody(req)
      if (req.method === 'POST' && path === '/api/save') {
        state.saved.push(body)
        send(res, 200, 'application/json', JSON.stringify({ saved: state.saved.length }))
        return
      }
      if (req.method === 'POST' && path === '/api/archive') {
        state.archived.push(body)
        send(res, 200, 'application/json', JSON.stringify({ archived: state.archived.length }))
        return
      }
      if (req.method === 'POST' && path === '/api/counter') {
        state.counter += 1
        send(res, 200, 'application/json', JSON.stringify({ counter: state.counter }))
        return
      }
      send(res, 404, 'text/plain', 'not found')
    })()
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as AddressInfo).port

  return {
    url: (path: string) => `http://localhost:${String(port)}${path}`,
    state,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => { resolve() })
    }),
  }
}
