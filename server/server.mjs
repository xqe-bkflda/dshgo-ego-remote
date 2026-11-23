// ego-remote：把 ego 浏览器里正在跑的页面转发成一张本地网页，可看也可操作。
//
// 传输层是自建的 WebSocket（零依赖）：
//   · 画面走二进制帧，JPEG 原样发，不走 base64 / SSE，省 33% 体积
//   · 操作走同一条连接的文本帧，不再每动一次鼠标发一个 HTTP POST
//   · 客户端跟不上就丢旧帧（bufferedAmount 背压），不会越拖越卡
//
// 分辨率跟着客户端的实际显示尺寸走：手机上只编 400 多像素宽的 JPEG，
// 解码量降到 1/9，比在服务器端死磕 1280 更有效。
//
// 启动：./start.sh --bg          默认 7788
//       ./start.sh --bg --port 9000
//       PORT=9000 node server.mjs

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const STATE_DIR = process.env.EGO_STATE || '/root/.local/state/ego-lite-linux'
const QUALITY = Number(process.env.QUALITY || 72)
const MAX_W = Number(process.env.MAX_WIDTH || 1280)

// ── 端口：命令行 > 环境变量 > .port 文件 > 7788 ──────────────────
const PORT_FILE = path.join(HERE, '.port')
const TOKEN_FILE = path.join(HERE, '.token')

function argPort() {
  const argv = process.argv.slice(2)
  const i = argv.findIndex((a) => a === '--port' || a === '-p')
  if (i >= 0 && argv[i + 1]) return Number(argv[i + 1])
  for (const a of argv) {
    const m = /^--port=(\d+)$/.exec(a)
    if (m) return Number(m[1])
  }
  return 0
}

function initialPort() {
  const fromArg = argPort()
  if (fromArg > 0) return fromArg
  if (process.env.PORT) return Number(process.env.PORT)
  try {
    const p = Number(fs.readFileSync(PORT_FILE, 'utf8').trim())
    if (p > 0) return p
  } catch {}
  return 7788
}

const HOST = process.env.HOST || '0.0.0.0'
const PORT = initialPort()

// token 落盘，重启后地址不变；删掉 .token 就换一把
let TOKEN = process.env.TOKEN || ''
if (!TOKEN) {
  try { TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim() } catch {}
}
if (!TOKEN) {
  TOKEN = crypto.randomBytes(4).toString('hex')
  try { fs.writeFileSync(TOKEN_FILE, TOKEN + '\n', { mode: 0o600 }) } catch {}
}

const browserJson = () => {
  const candidates = [
    path.join(STATE_DIR, 'browser.json'),
    path.join(STATE_DIR, 'ego-lite-linux', 'browser.json'),
    path.join(os.homedir(), '.ego', 'browser.json'),
  ]
  for (const f of candidates) {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch {}
  }
  return null
}

function lanIPs() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address)
}

// ── 极简 CDP 客户端 ───────────────────────────────────────────────
class Cdp {
  constructor(url) {
    this.url = url
    this.ws = null
    this.seq = 0
    this.pending = new Map()
    this.listeners = new Set()
    this.queue = []
  }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url)
      this.ws = ws
      const timer = setTimeout(() => reject(new Error('cdp connect timeout')), 5000)
      ws.addEventListener('open', () => {
        clearTimeout(timer)
        for (const p of this.queue.splice(0)) this.call(p.method, p.params, p.sessionId).then(p.resolve, p.reject)
        resolve()
      })
      ws.addEventListener('message', (ev) => {
        let msg
        try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')) } catch { return }
        if (msg.id && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)
          this.pending.delete(msg.id)
          msg.error ? p.reject(new Error(msg.error.message || JSON.stringify(msg.error))) : p.resolve(msg.result)
          return
        }
        if (msg.method) for (const fn of this.listeners) { try { fn(msg) } catch {} }
      })
      const fail = (e) => {
        clearTimeout(timer)
        this.ws = null
        for (const [, p] of this.pending) p.reject(new Error('cdp closed'))
        this.pending.clear()
        reject(e instanceof Error ? e : new Error('cdp closed'))
      }
      ws.addEventListener('close', () => fail(new Error('cdp closed')))
      ws.addEventListener('error', () => { if (ws.readyState !== 1) fail(new Error('cdp error')) })
    })
  }
  // 需要回结果的调用
  call(method, params = {}, sessionId) {
    if (!this.ws || this.ws.readyState !== 1) {
      return new Promise((resolve, reject) => this.queue.push({ method, params, sessionId, resolve, reject }))
    }
    const id = ++this.seq
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try { this.ws.send(JSON.stringify(payload)) } catch (e) { this.pending.delete(id); reject(e) }
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); resolve({}) } // 静默超时：输入类调用不要卡死 UI
      }, 6000)
    })
  }
  // 不需要回结果的调用：只发不等。每帧的 screencastFrameAck 用它，
  // 否则 30fps 就是每秒 30 个定时器。
  post(method, params = {}, sessionId) {
    if (!this.ws || this.ws.readyState !== 1) return
    const payload = { id: ++this.seq, method, params }
    if (sessionId) payload.sessionId = sessionId
    try { this.ws.send(JSON.stringify(payload)) } catch {}
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn) }
  close() { try { this.ws?.close() } catch {} }
}

// ── WebSocket 服务端（手搓，不引依赖）─────────────────────────────
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

function wsAccept(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64')
}

function wsEncode(opcode, payload) {
  const len = payload.length
  let header
  if (len < 126) {
    header = Buffer.allocUnsafe(2)
    header[1] = len
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4)
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.allocUnsafe(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  header[0] = 0x80 | opcode
  return Buffer.concat([header, payload])
}

class WsConn {
  constructor(socket) {
    this.socket = socket
    this.buf = Buffer.alloc(0)
    this.closed = false
    this.onmessage = () => {}
    this.onclose = () => {}
    this.frags = []
    this.fragOp = 0
    socket.on('data', (d) => this._data(d))
    socket.on('close', () => this._close())
    socket.on('error', () => this._close())
  }
  get bufferedAmount() {
    return this.socket.writableLength || 0
  }
  sendText(str) {
    if (this.closed) return
    try { this.socket.write(wsEncode(0x1, Buffer.from(str, 'utf8'))) } catch { this._close() }
  }
  sendBinary(buf) {
    if (this.closed) return false
    try { this.socket.write(wsEncode(0x2, buf)); return true } catch { this._close(); return false }
  }
  _close() {
    if (this.closed) return
    this.closed = true
    try { this.socket.destroy() } catch {}
    this.onclose()
  }
  _data(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    // 一个 TCP 包可能塞了好几帧，循环取干净
    for (;;) {
      const b = this.buf
      if (b.length < 2) return
      const fin = (b[0] & 0x80) !== 0
      const opcode = b[0] & 0x0f
      const masked = (b[1] & 0x80) !== 0
      let len = b[1] & 0x7f
      let off = 2
      if (len === 126) {
        if (b.length < 4) return
        len = b.readUInt16BE(2); off = 4
      } else if (len === 127) {
        if (b.length < 10) return
        const big = b.readBigUInt64BE(2)
        if (big > 1n << 24n) { this._close(); return }  // 客户端不该发这么大的东西
        len = Number(big); off = 10
      }
      const maskKey = masked ? b.subarray(off, off + 4) : null
      if (masked) off += 4
      if (b.length < off + len) return
      let payload = b.subarray(off, off + len)
      this.buf = b.subarray(off + len)
      if (masked) {
        payload = Buffer.from(payload)
        for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3]
      }
      if (opcode === 0x8) { this._close(); return }
      if (opcode === 0x9) { try { this.socket.write(wsEncode(0xa, payload)) } catch {}; continue }
      if (opcode === 0xa) continue
      if (opcode === 0x0) {
        this.frags.push(payload)
      } else {
        this.frags = [payload]
        this.fragOp = opcode
      }
      if (!fin) continue
      const body = this.frags.length === 1 ? this.frags[0] : Buffer.concat(this.frags)
      this.frags = []
      const op = this.fragOp
      this.fragOp = 0
      try { this.onmessage(op, body) } catch {}
    }
  }
}

// ── 会话：一个页面 target 一条 screencast ───────────────────────────
class Session {
  constructor(targetId) {
    this.targetId = targetId
    this.cdpSession = null
    this.meta = { w: 0, h: 0, scale: 1 }
    this.frames = 0
    this.lastFrame = null      // 最近一帧 JPEG，新连进来的客户端先补这一张
    this.lastFrameAt = 0
    this.castW = 0             // 当前 screencast 用的最大宽度
    this.castH = 0
  }
}

const clients = new Set()   // WsConn + wanted size
let cdp = null
let session = null
let info = { title: '', url: '' }

function broadcastBinary(buf) {
  for (const c of clients) {
    // 客户端跟不上就丢掉这一帧：宁可跳帧也不要越攒越多的延迟
    if (c.bufferedAmount > 400 * 1024) continue
    c.sendBinary(buf)
  }
}

function broadcastText(kind, data) {
  const line = JSON.stringify({ k: kind, ...data })
  for (const c of clients) c.sendText(line)
}

// 帧包格式：[0x01][4字节 metaLen][meta JSON][JPEG]
// metaLen === 0 表示沿用上一帧的 meta，省掉重复的 JSON
let lastMetaJson = ''
let lastMetaLen = 0

function packFrame(jpegB64, meta) {
  const jpeg = Buffer.from(jpegB64, 'base64')
  const mj = JSON.stringify(meta)
  const needMeta = mj !== lastMetaJson
  const metaBuf = needMeta ? Buffer.from(mj, 'utf8') : Buffer.alloc(0)
  lastMetaJson = mj
  lastMetaLen = metaBuf.length
  const head = Buffer.allocUnsafe(5)
  head[0] = 0x01
  head.writeUInt32BE(metaBuf.length, 1)
  return Buffer.concat([head, metaBuf, jpeg])
}

// screencast 只在画面变化时出帧：静止时补一张，保证「实时」不是假象，
// 也顺手确认 target 还活着（抓图报错 = 页面没了）。
setInterval(async () => {
  if (!session || !cdp || clients.size === 0) return
  if (Date.now() - session.lastFrameAt < 1500) return
  const s = session.cdpSession
  try {
    const shot = await cdp.call('Page.captureScreenshot', {
      format: 'jpeg', quality: QUALITY,
    }, s)
    if (shot?.data && session) {
      session.lastFrame = shot.data
      session.lastFrameAt = Date.now()
      broadcastBinary(packFrame(shot.data, session.meta))
    }
  } catch {
    const gone = session?.targetId
    session = null
    broadcastText('detached', { targetId: gone, reason: 'target closed' })
  }
}, 1500).unref?.()

async function ensureCdp() {
  if (cdp && cdp.ws && cdp.ws.readyState === 1) return cdp
  const st = browserJson()
  if (!st?.wsUrl) throw new Error('找不到 ego browser.json（浏览器没启动）')
  cdp = new Cdp(st.wsUrl)
  cdp.on(onCdpEvent)
  await cdp.connect()
  return cdp
}

function onCdpEvent(msg) {
  if (msg.method === 'Page.screencastFrame') {
    const p = msg.params
    // 立即 ack，不放 await、不建定时器：ack 慢了 Chrome 就不出帧了
    cdp?.post('Page.screencastFrameAck', { sessionId: p.sessionId }, msg.sessionId)
    if (!session || msg.sessionId !== session.cdpSession) return
    const m = session.meta
    m.w = p.metadata.deviceWidth || m.w
    m.h = p.metadata.deviceHeight || m.h
    m.scale = p.metadata.pageScaleFactor || 1
    m.sy = p.metadata.scrollOffsetY || 0
    session.frames++
    session.lastFrame = p.data
    session.lastFrameAt = Date.now()
    broadcastBinary(packFrame(p.data, m))
    return
  }
  if (msg.method === 'Page.frameNavigated' && msg.params?.frame?.parentId === undefined) {
    info.url = msg.params.frame.url
    broadcastText('nav', { url: info.url, title: msg.params.frame.name || '' })
    return
  }
  if (msg.method === 'Inspector.detached' || msg.method === 'Page.frameDetached') {
    if (msg.method === 'Inspector.detached' && session) {
      const gone = session.targetId
      session = null
      broadcastText('detached', { targetId: gone, reason: 'inspector detached' })
    }
  }
}

// 自己这页不能镜像：镜像自己会无限递归（画面里套画面，帧率掉到个位数）
function isSelfUrl(u) {
  const s = String(u || '')
  if (!s) return false
  if (s.includes(`:${PORT}/`) || s.includes(`:${PORT}`)) return true
  return /ego 远程视图/.test(s)
}

async function listPages() {
  const c = await ensureCdp()
  const { targetInfos = [] } = await c.call('Target.getTargets')
  const isSelf = isSelfUrl
  return targetInfos
    .filter((t) => t.type === 'page' && !String(t.url).startsWith('devtools://'))
    .filter((t) => !isSelf(t.url) && t.title !== 'ego 远程视图')
    .map((t) => ({ id: t.targetId, url: t.url, title: t.title, attached: t.attached }))
}

// 按客户端的显示尺寸重开 screencast：手机上只编需要的像素
async function applyCastSize(maxW, maxH) {
  if (!session || !cdp) return
  if (session.castW && Math.abs(session.castW - maxW) / session.castW < 0.15) return
  session.castW = maxW
  session.castH = maxH
  await cdp.call('Page.startScreencast', {
    format: 'jpeg',
    quality: QUALITY,
    maxWidth: Math.max(240, Math.min(MAX_W, Math.round(maxW))),
    maxHeight: Math.max(320, Math.min(4000, Math.round(maxH))),
    everyNthFrame: 1,
  }, session.cdpSession).catch(() => {})
}

function wantedSize() {
  // 有多个客户端时取最大的，别让大屏看着糊
  let w = 0, h = 0
  for (const c of clients) {
    if (c.wantW > w) { w = c.wantW; h = c.wantH }
  }
  return w ? { w, h } : null
}

async function attach(targetId) {
  const c = await ensureCdp()
  // 挡住镜像自己：否则一路递归，几秒内就把帧率拖死
  const pre = await c.call('Target.getTargetInfo', { targetId }).catch(() => null)
  if (pre?.targetInfo && isSelfUrl(pre.targetInfo.url)) {
    throw new Error('不能镜像 ego-remote 自己这页，换一个页面')
  }
  if (session) await detach()
  const { sessionId } = await c.call('Target.attachToTarget', { targetId, flatten: true })
  session = new Session(targetId)
  session.cdpSession = sessionId
  const s = sessionId
  await c.call('Page.enable', {}, s).catch(() => {})
  await c.call('Page.bringToFront', {}, s).catch(() => {})
  const metrics = await c.call('Page.getLayoutMetrics', {}, s).catch(() => null)
  const vp = metrics?.cssLayoutViewport || {}
  session.meta = { w: vp.clientWidth || 0, h: vp.clientHeight || 0, scale: 1 }
  info = { title: '', url: '' }
  const want = wantedSize()
  const ratio = (vp.clientHeight || 1) / (vp.clientWidth || 1)
  const w = want ? want.w : Math.min(MAX_W, vp.clientWidth || 1280)
  const h = want ? want.h : Math.min(4000, Math.round(w * ratio))
  session.castW = 0
  await applyCastSize(w, h)
  const { targetInfo } = await c.call('Target.getTargetInfo', { targetId }).catch(() => ({}))
  if (targetInfo) info = { title: targetInfo.title, url: targetInfo.url }
  const shot = await c.call('Page.captureScreenshot', { format: 'jpeg', quality: QUALITY }, s).catch(() => null)
  if (shot?.data && session) { session.lastFrame = shot.data; session.lastFrameAt = Date.now() }
  broadcastText('attached', { targetId, meta: session.meta, info })
  if (session?.lastFrame) broadcastBinary(packFrame(session.lastFrame, session.meta))
  return { targetId, meta: session.meta, info }
}

async function detach() {
  if (!session) return
  const s = session.cdpSession
  const id = session.targetId
  session = null
  try {
    await cdp?.call('Page.stopScreencast', {}, s)
    await cdp?.call('Target.detachFromTarget', { sessionId: s })
  } catch {}
  broadcastText('detached', { targetId: id })
}

// ── 输入转发 ────────────────────────────────────────────────────
const KEYMAP = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
}

function input(body) {
  if (!session || !cdp) return { ok: false, error: 'not attached' }
  const s = session.cdpSession
  const t = body.type
  const x = Number(body.x) || 0
  const y = Number(body.y) || 0
  const mods = Number(body.modifiers) || 0
  // 输入走 post：不等回包，鼠标滑动才跟手
  if (t === 'mouseMoved') {
    cdp.post('Input.dispatchMouseEvent', { type: t, x, y, buttons: Number(body.buttons) || 0 }, s)
  } else if (t === 'mousePressed' || t === 'mouseReleased') {
    cdp.post('Input.dispatchMouseEvent', {
      type: t, x, y,
      button: body.button || 'left',
      buttons: Number(body.buttons) || 0,
      clickCount: Number(body.clickCount) || 1,
      modifiers: mods,
    }, s)
  } else if (t === 'mouseWheel') {
    cdp.post('Input.dispatchMouseEvent', {
      type: t, x, y,
      deltaX: Number(body.deltaX) || 0,
      deltaY: Number(body.deltaY) || 0,
      modifiers: mods,
    }, s)
  } else if (t === 'touchStart' || t === 'touchMove' || t === 'touchEnd' || t === 'touchCancel') {
    const points = Array.isArray(body.points) ? body.points.slice(0, 5) : []
    cdp.post('Input.dispatchTouchEvent', {
      type: t,
      touchPoints: points.map((p, i) => ({
        x: Number(p.x) || 0, y: Number(p.y) || 0, id: Number(p.id ?? i),
        radiusX: 1, radiusY: 1, force: 1,
      })),
      modifiers: mods,
    }, s)
  } else if (t === 'insertText') {
    const text = String(body.text ?? '')
    if (!text || text.length > 10000) return { ok: false, error: 'text length' }
    cdp.post('Input.insertText', { text }, s)
  } else if (t === 'keyDown' || t === 'keyUp') {
    const m = KEYMAP[body.key] || { key: body.key, code: body.code || body.key, vk: 0 }
    const payload = {
      type: t, key: m.key, code: m.code, modifiers: mods,
      windowsVirtualKeyCode: m.vk, nativeVirtualKeyCode: m.vk,
      autoRepeat: !!body.autoRepeat,
    }
    if (t === 'keyDown' && m.text) { payload.text = m.text; payload.unmodifiedText = m.text }
    cdp.post('Input.dispatchKeyEvent', payload, s)
  } else {
    return { ok: false, error: `unsupported ${t}` }
  }
  return { ok: true }
}

async function command(cmd, arg) {
  if (!session || !cdp) return { ok: false, error: 'not attached' }
  const s = session.cdpSession
  try {
    if (cmd === 'reload') await cdp.call('Page.reload', { ignoreCache: !!(arg?.hard) }, s)
    else if (cmd === 'back') await cdp.call('Runtime.evaluate', { expression: 'history.back()' }, s)
    else if (cmd === 'forward') await cdp.call('Runtime.evaluate', { expression: 'history.forward()' }, s)
    else if (cmd === 'navigate') {
      const target = String(arg?.url || '')
      // 导航到镜像页 = 让自己镜像自己，画面里套画面无限递归，直接拒
      if (isSelfUrl(target)) return { ok: false, error: '不能把远程页导航到 ego-remote 自己（会无限递归）' }
      await cdp.call('Page.navigate', { url: target }, s)
    }
    else if (cmd === 'scrollBy') {
      await cdp.call('Runtime.evaluate', {
        expression: `window.scrollBy(${Number(arg?.dx) || 0}, ${Number(arg?.dy) || 1000})`,
      }, s)
    } else if (cmd === 'clickText') {
      const q = JSON.stringify(String(arg?.text || ''))
      await cdp.call('Runtime.evaluate', {
        expression: `(()=>{const el=[...document.querySelectorAll('a,button,[role=button],input')].find(e=>((e.innerText||e.value||'').trim()).includes(${q}));if(!el)return 'no';el.click();return 'ok'})()`,
        returnByValue: true,
      }, s)
    } else if (cmd === 'eval') {
      const r = await cdp.call('Runtime.evaluate', {
        expression: String(arg?.expression || ''),
        returnByValue: true,
        awaitPromise: true,
      }, s)
      return { ok: true, value: r?.result?.value, error: r?.exceptionDetails ? String(r.exceptionDetails.text) : undefined }
    } else return { ok: false, error: `unsupported ${cmd}` }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
}

// ── HTTP ───────────────────────────────────────────────────────
function json(res, code, body) {
  const p = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(p)
}

async function readBody(req) {
  const chunks = []
  let n = 0
  for await (const c of req) { n += c.length; if (n > 1 << 20) throw new Error('body too large'); chunks.push(c) }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

const PAGE = fs.readFileSync(path.join(HERE, 'client.html'), 'utf8')

function urls() {
  const out = [`http://127.0.0.1:${PORT}/?t=${TOKEN}`]
  for (const ip of lanIPs()) out.push(`http://${ip}:${PORT}/?t=${TOKEN}`)
  return out
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url || '/', 'http://local')
  if (!['/', '/client.html'].includes(u.pathname) && u.searchParams.get('t') !== TOKEN) {
    return json(res, 401, { ok: false, error: 'unauthorized' })
  }
  try {
    if (u.pathname === '/' || u.pathname === '/client.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(PAGE.replace('%TOKEN%', TOKEN))
    }
    if (u.pathname === '/api/status') {
      let pageCount = 0
      try { pageCount = (await listPages()).length } catch {}
      return json(res, 200, {
        ok: true, port: PORT, token: TOKEN, urls: urls(),
        attached: !!session, targetId: session?.targetId || null,
        clients: clients.size, pages: pageCount, fps: Math.round(QUALITY ? session?.frames / Math.max(1, (Date.now() - startedAt) / 1000) : 0),
        castW: session?.castW || 0,
      })
    }
    if (u.pathname === '/api/pages') {
      const pages = await listPages().catch(() => [])
      return json(res, 200, { ok: true, pages, current: session?.targetId || null, token: TOKEN })
    }
    if (u.pathname === '/api/attach') {
      const targetId = u.searchParams.get('id')
      if (!targetId) return json(res, 400, { ok: false, error: 'id required' })
      try {
        return json(res, 200, { ok: true, ...(await attach(targetId)) })
      } catch (e) {
        return json(res, 500, { ok: false, error: String(e?.message || e) })
      }
    }
    if (u.pathname === '/api/command' && req.method === 'POST') {
      const b = await readBody(req)
      return json(res, 200, await command(b.cmd, b))
    }
    if (u.pathname === '/api/detach') {
      await detach()
      return json(res, 200, { ok: true })
    }
    return json(res, 404, { ok: false, error: 'not found' })
  } catch (e) {
    return json(res, 500, { ok: false, error: String(e?.message || e) })
  }
})

// ── WebSocket 升级：画面 + 操作都走这条连接 ────────────────────────
server.on('upgrade', (req, socket) => {
  const u = new URL(req.url || '/', 'http://local')
  if (u.pathname !== '/ws' || u.searchParams.get('t') !== TOKEN) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    socket.destroy()
    return
  }
  const key = req.headers['sec-websocket-key']
  if (!key) { socket.destroy(); return }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`
  )
  socket.setNoDelay(true)

  const conn = new WsConn(socket)
  conn.wantW = 0
  conn.wantH = 0
  clients.add(conn)

  conn.onmessage = (op, body) => {
    if (op !== 0x1) return
    let m
    try { m = JSON.parse(body.toString('utf8')) } catch { return }
    if (m.t === 'resize') {
      const w = Math.max(240, Math.min(MAX_W, Math.round(Number(m.w) || 0)))
      const h = Math.max(320, Math.min(4000, Math.round(Number(m.h) || 0)))
      if (!w) return
      conn.wantW = w
      conn.wantH = h
      const want = wantedSize()
      if (want) applyCastSize(want.w, want.h)
      return
    }
    if (m.t === 'input') { input(m.body || m); return }
    if (m.t === 'command') { command(m.cmd, m).then((r) => conn.sendText(JSON.stringify({ k: 'result', id: m.id, ...r }))) ; return }
    if (m.t === 'attach') { attach(m.id).catch(() => {}) ; return }
  }
  conn.onclose = () => clients.delete(conn)

  conn.sendText(JSON.stringify({
    k: 'hello',
    targetId: session?.targetId || null,
    info,
    meta: session?.meta || null,
    token: TOKEN,
  }))
  // 补一张底图：静态页面新连进来否则一片黑
  if (session?.lastFrame) conn.sendBinary(packFrame(session.lastFrame, session.meta))
})

const startedAt = Date.now()

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 被占用。换一个：./start.sh --bg --port 7799`)
    process.exit(1)
  }
  throw e
})

server.listen(PORT, HOST, () => {
  try { fs.writeFileSync(PORT_FILE, String(PORT) + '\n', { mode: 0o600 }) } catch {}
  try { fs.writeFileSync(path.join(HERE, '.pid'), String(process.pid) + '\n') } catch {}
  console.log(`ego-remote: 端口 ${PORT}`)
  for (const u of urls()) console.log(`  ${u}`)
})

process.on('SIGINT', async () => { await detach(); cdp?.close(); server.close(); process.exit(0) })
