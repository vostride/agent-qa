// `?animate=1` keeps the compositor busy; without it the page is static, the negative arm.

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

const PAGE = (animate: boolean): string => `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>live stream fixture</title>
<style>
  html, body { margin: 0; height: 100%; background: #101418; }
  #box { width: 200px; height: 200px; background: #4ade80; position: absolute; top: 80px; left: 0; }
  ${animate ? '@keyframes slide { from { transform: translateX(0) } to { transform: translateX(600px) } }\n  #box { animation: slide 1.2s linear infinite alternate; }' : ''}
</style>
</head>
<body><div id="box" data-fixture-box></div></body>
</html>
`

export interface LiveStreamFixturePage {
  /** The base URL. Append `?animate=1` for the moving arm. */
  readonly url: string
  close(): Promise<void>
}

export async function startLiveStreamFixturePage(): Promise<LiveStreamFixturePage> {
  const server = createServer((req, res) => {
    const animate = (req.url ?? '').includes('animate=1')
    const body = PAGE(animate)
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body),
    })
    res.end(body)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${String(address.port)}/`,
    close: () => new Promise<void>((resolve) => { server.close(() => { resolve() }) }),
  }
}
