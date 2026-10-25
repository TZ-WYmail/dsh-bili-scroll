#!/usr/bin/env node
/**
 * B站值班台 — a small standalone local app for the dsh-bili-scroll duty bot.
 *
 * The app owns its own UI and port (127.0.0.1:3099) and talks to the plugin's
 * host routes (`/api/bili-duty/*` on the Harness web server) for anything that
 * touches B站: status, config, run, login. Report history, the dedupe table and
 * the duty log are read straight from the plugin home. Nothing is duplicated.
 */
import { createServer } from 'node:http'
import { readFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const PUBLIC = join(HERE, 'public')
const HOME = process.env.BILI_DUTY_HOME || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'bili-duty')
const UPSTREAM = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080'
const PORT = Number(process.env.BILI_DUTY_PORT || 3099)
const HOST = '127.0.0.1'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
}

/** Loopback-only, same-origin-only, mirroring the plugin's own guard. */
function sameOriginOk(req) {
  const host = String(req.headers.host || '')
  if (host && !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) return false
  const pick = String(req.headers.origin || req.headers.referer || '')
  if (!pick) return true
  try {
    return /^(127\.0\.0\.1|localhost|\[::1\])$/i.test(new URL(pick).hostname)
  } catch {
    return false
  }
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function sendJson(res, status, value) {
  send(res, status, JSON.stringify(value))
}

async function readBody(req) {
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > 2 * 1024 * 1024) throw new Error('request body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Forward one call to the plugin's host route and return its parsed JSON. */
async function upstream(path, { method = 'GET', body } = {}) {
  const response = await fetch(UPSTREAM + '/api/bili-duty' + path, {
    method,
    headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(30_000),
  })
  const text = await response.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = { ok: false, error: `upstream returned ${response.status}: ${text.slice(0, 200)}` }
  }
  return { status: response.status, json }
}

/** List report days newest-first. */
async function listReports() {
  const dir = join(HOME, 'out')
  if (!existsSync(dir)) return []
  const names = (await readdir(dir)).filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
  const rows = await Promise.all(names.map(async (name) => {
    const info = await stat(join(dir, name))
    return { day: name.slice(0, 10), bytes: info.size, mtime: info.mtimeMs }
  }))
  return rows.sort((a, b) => (a.day < b.day ? 1 : -1))
}

/** Parse the dedupe table's "看过的视频" bullets. */
async function readSeen() {
  const file = join(HOME, 'seen.md')
  if (!existsSync(file)) return []
  const text = await readFile(file, 'utf8')
  const rows = []
  for (const line of text.split('\n')) {
    const m = /^-\s+(\d{4}-\d{2}-\d{2})\s+·\s+(BV[0-9A-Za-z]+)\s+·\s+(.*)$/.exec(line.trim())
    if (!m) continue
    const tail = m[3]
    const picked = /（挑中/.test(tail)
    const note = (tail.match(/（([^）]*)）/) || [])[1] || ''
    const title = tail.replace(/（[^）]*）\s*$/, '').trim()
    rows.push({ day: m[1], bvid: m[2], title, picked, note })
  }
  return rows.reverse()
}

async function tailLog(lines = 200) {
  const file = join(HOME, 'duty.log')
  if (!existsSync(file)) return ''
  const info = await stat(file)
  const start = Math.max(0, info.size - 256 * 1024)
  const handle = await readFile(file)
  const text = handle.subarray(start).toString('utf8')
  return text.split('\n').slice(-lines).join('\n')
}

function serveStatic(res, relPath) {
  const path = resolve(PUBLIC, '.' + relPath)
  if (!path.startsWith(PUBLIC + sep)) return sendJson(res, 403, { ok: false, error: 'forbidden' })
  return readFile(path).then(
    (buf) => send(res, 200, buf, MIME[extname(path)] || 'application/octet-stream'),
    () => sendJson(res, 404, { ok: false, error: 'not found' }),
  )
}

const server = createServer(async (req, res) => {
  try {
    if (!sameOriginOk(req)) return sendJson(res, 403, { ok: false, error: '只接受本机同源请求' })
    const url = new URL(req.url, `http://${req.headers.host || HOST}`)
    const path = url.pathname
    if (process.env.BILI_DUTY_DEBUG) console.log(new Date().toISOString(), req.method, path)

    if (req.method === 'GET' && (path === '/' || path === '/index.html')) return serveStatic(res, '/index.html')
    if (req.method === 'GET' && (path === '/app.js' || path === '/style.css' || path === '/favicon.svg')) return serveStatic(res, path)

    if (path === '/api/health') {
      try {
        const { status } = await upstream('/status')
        return sendJson(res, 200, { ok: status === 200, upstream: UPSTREAM })
      } catch (error) {
        return sendJson(res, 200, { ok: false, upstream: UPSTREAM, error: String(error?.message ?? error) })
      }
    }

    if (path === '/api/me' && req.method === 'GET') {
      const file = join(HOME, 'bili_credential.json')
      if (!existsSync(file)) return sendJson(res, 200, { ok: false, error: '还没登录' })
      try {
        const cred = JSON.parse(await readFile(file, 'utf8'))
        const cookie = `SESSDATA=${cred.sessdata || ''}; bili_jct=${cred.bili_jct || ''}; buvid3=${cred.buvid3 || ''}; DedeUserID=${cred.dedeuserid || ''}`
        const response = await fetch('https://api.bilibili.com/x/web-interface/nav', {
          headers: {
            Cookie: cookie,
            'User-Agent': 'Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 Chrome/140 Safari/537.36',
            Referer: 'https://www.bilibili.com/',
          },
          signal: AbortSignal.timeout(8000),
        })
        const json = await response.json()
        if (json?.code !== 0) return sendJson(res, 200, { ok: false, error: json?.message || '凭证失效' })
        return sendJson(res, 200, {
          ok: true,
          uname: json.data?.uname || '',
          mid: json.data?.mid || 0,
          avatar: json.data?.face || '',
        })
      } catch (error) {
        return sendJson(res, 200, { ok: false, error: String(error?.message ?? error) })
      }
    }

    if (path === '/api/status' && req.method === 'GET') {
      const { status, json } = await upstream('/status')
      if (json && json.ok) {
        try {
          const text = await tailLog(400)
          const ends = text.split('\n')
            .map((line) => /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z).*刷B站结束/.exec(line))
            .filter(Boolean)
          if (ends.length > 0) json.lastEndAt = Date.parse(ends[ends.length - 1][1])
        } catch { /* the log is optional */ }
      }
      return sendJson(res, status, json)
    }

    if (path === '/api/report' && req.method === 'GET') {
      const { status, json } = await upstream('/report')
      return sendJson(res, status, json)
    }

    if (path === '/api/reports' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, reports: await listReports() })
    }

    if (path === '/api/report-file' && req.method === 'GET') {
      const day = String(url.searchParams.get('day') || '')
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return sendJson(res, 400, { ok: false, error: 'bad day' })
      const file = join(HOME, 'out', `${day}.md`)
      if (!existsSync(file)) return sendJson(res, 404, { ok: false, error: '还没有这一天的日报' })
      return sendJson(res, 200, { ok: true, day, text: await readFile(file, 'utf8') })
    }

    if (path === '/api/seen' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, seen: await readSeen() })
    }

    if (path === '/api/log' && req.method === 'GET') {
      const lines = Math.min(2000, Math.max(20, Number(url.searchParams.get('lines') || 200)))
      return sendJson(res, 200, { ok: true, text: await tailLog(lines) })
    }

    if (path === '/api/qr' && req.method === 'GET') {
      const file = join(HOME, 'qrcode_login.png')
      if (!existsSync(file)) return sendJson(res, 404, { ok: false, error: '还没有二维码' })
      const buf = await readFile(file)
      const type = buf[0] === 0xff && buf[1] === 0xd8 ? 'image/jpeg' : 'image/png'
      return send(res, 200, buf, type)
    }

    // Everything that touches B站 is proxied to the plugin's own host route.
    const proxyRoutes = new Set([
      '/api/run', '/api/config', '/api/login/start', '/api/login/poll',
      '/api/verify', '/api/install', '/api/install-asr', '/api/fav-today',
      '/api/open', '/api/check', '/api/selfcheck', '/api/diagnose',
    ])
    if (proxyRoutes.has(path)) {
      if (req.method !== 'GET' && req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      const body = req.method === 'POST' ? await readBody(req) : undefined
      const { status, json } = await upstream(path.slice(4), { method: req.method, body })
      return sendJson(res, status === 200 ? 200 : 200, json)
    }

    return sendJson(res, 404, { ok: false, error: 'not found' })
  } catch (error) {
    return sendJson(res, 502, { ok: false, error: String(error?.message ?? error) })
  }
})

server.listen(PORT, HOST, () => {
  console.log(`[bili-duty] 值班台已启动: http://${HOST}:${PORT}`)
  console.log(`[bili-duty] 插件家目录: ${HOME}`)
  console.log(`[bili-duty] Harness: ${UPSTREAM}`)
})
