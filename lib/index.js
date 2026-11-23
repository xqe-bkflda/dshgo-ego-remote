// 浏览器远程：在 dsh-go 的面板里显示 ego-remote 的访问地址，一键复制 / 换端口。
//
// 转发服务在 server/ 目录里（随插件一起发布）：它把 ego 浏览器里
// 正在跑的页面转成一张网页，能看也能点。这里只做「地址面板」——
// 改端口会真的重启那个服务（node server.mjs --port N），不是只改显示。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

export const name = 'dshgo-ego-remote'

// 插件自带的转发服务在 server/ 下；也允许用 EGO_REMOTE_DIR 指到别处
const HERE = path.dirname(fileURLToPath(import.meta.url))
const DIR = process.env.EGO_REMOTE_DIR || path.join(HERE, '..', 'server')
const PORT_FILE = path.join(DIR, '.port')
const TOKEN_FILE = path.join(DIR, '.token')
const PID_FILE = path.join(DIR, '.pid')
const SERVER = path.join(DIR, 'server.mjs')

function readText(f) {
  try { return fs.readFileSync(f, 'utf8').trim() } catch { return '' }
}

function lanIPv4() {
  const out = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address)
    }
  }
  return out
}

function alive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

async function probe(port, token, ms = 1200) {
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), ms)
    const r = await fetch(`http://127.0.0.1:${port}/api/status?t=${token}`, { signal: ctl.signal })
    clearTimeout(t)
    if (!r.ok) return null
    return await r.json()
  } catch { return null }
}

function startServer(port) {
  // 已经有一个在跑就先停掉：换端口要靠重启
  const old = Number(readText(PID_FILE)) || 0
  if (alive(old)) { try { process.kill(old) } catch {} }
  const child = spawn(process.execPath, [SERVER, '--port', String(port)], {
    cwd: DIR,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, PORT: String(port) },
  })
  child.unref()
  try { fs.writeFileSync(PID_FILE, String(child.pid) + '\n') } catch {}
  return child.pid
}

// 端口被占时往后挪，最多试 20 个
async function startOnFreePort(from, token) {
  let port = from
  for (let i = 0; i < 20; i++) {
    const pid = startServer(port)
    for (let w = 0; w < 12; w++) {
      await new Promise((r) => setTimeout(r, 250))
      const st = await probe(port, token, 800)
      if (st?.ok) return { port, pid, status: st }
      if (!alive(pid)) break
    }
    const old = Number(readText(PID_FILE)) || 0
    if (alive(old)) { try { process.kill(old) } catch {} }
    port = port >= 7999 ? 7788 : port + 1
  }
  return { port, pid: 0, status: null }
}

export function apply(ctx) {
  ctx.inject(['dshGo'], (ctx) => {
    const zh = (event) => !String(event?.locale || '').startsWith('en')
    let pushData = () => {}

    const state = {
      port: Number(readText(PORT_FILE)) || 7788,
      token: readText(TOKEN_FILE),
      status: null,
      busy: false,
      note: '',
    }

    function urls(port, token) {
      const q = token ? `/?t=${token}` : '/'
      return {
        local: `http://127.0.0.1:${port}${q}`,
        lan: lanIPv4().map((ip) => `http://${ip}:${port}${q}`),
      }
    }

    function payload() {
      const u = urls(state.port, state.token)
      const st = state.status
      const running = !!st
      return {
        headline: running ? `运行中 · 端口 ${state.port}` : `未运行 · 端口 ${state.port}`,
        tone: running ? 'good' : 'warn',
        local: u.local,
        lan: u.lan.length ? u.lan[0] : '—',
        port: String(state.port),
        clients: st ? String(st.clients) : '—',
        attached: st ? (st.attached ? '已接管' : '未接管') : '—',
        pages: st ? String(st.pages) : '—',
        castW: st && st.castW ? `${st.castW} px` : '—',
        token: state.token || '—',
        note: state.note,
        lanList: u.lan.map((x) => ({ title: x, icon: 'link' })),
      }
    }

    async function refresh() {
      state.port = Number(readText(PORT_FILE)) || state.port || 7788
      state.token = readText(TOKEN_FILE) || state.token
      state.status = await probe(state.port, state.token)
      pushData()
      return state.status
    }

    async function ensureRunning() {
      if (state.busy) return
      state.busy = true
      try {
        state.token = readText(TOKEN_FILE) || state.token
        let st = await probe(state.port, state.token)
        if (!st) {
          const r = await startOnFreePort(state.port, state.token)
          state.port = Number(readText(PORT_FILE)) || r.port
          state.token = readText(TOKEN_FILE) || state.token
          st = r.status || await probe(state.port, state.token)
          state.note = st ? `已在 ${state.port} 启动` : '启动失败，看 run.log'
        }
        state.status = st
      } finally {
        state.busy = false
        pushData()
      }
    }

    ctx.dshGo.panel('remote', {
      view: (scope, caps) => {
        const en = String(caps?.locale || '').startsWith('en')
        const t = (a, b) => (en ? b : a)
        return {
          v: 2,
          type: 'stack',
          title: t('浏览器远程', 'Browser remote'),
          accent: 'teal',
          children: [
            { type: 'text', text: { $: 'data.headline' }, style: { size: 'title', weight: 'bold' } },
            { type: 'keyValue', items: [
              [t('本机打开（这台手机）', 'On this phone'), { $: 'data.local' }],
              [t('局域网打开（电脑/平板）', 'On your LAN'), { $: 'data.lan' }],
              [t('端口', 'Port'), { $: 'data.port' }],
              [t('正在看的人数', 'Viewers'), { $: 'data.clients' }],
              [t('页面', 'Page'), { $: 'data.attached' }],
              [t('可选页面数', 'Pages'), { $: 'data.pages' }],
              [t('转发宽度', 'Stream width'), { $: 'data.castW' }],
              [t('口令', 'Token'), { $: 'data.token' }],
            ] },
            { type: 'actions', items: [
              { label: t('复制本机地址', 'Copy local'), action: 'copy-local', icon: 'copy' },
              { label: t('复制局域网地址', 'Copy LAN'), action: 'copy-lan', icon: 'link' },
              { label: t('换端口', 'Change port'), action: 'port', icon: 'refresh' },
            ] },
            { type: 'actions', items: [
              { label: t('启动/修复', 'Start / fix'), action: 'start', icon: 'play' },
              { label: t('停止', 'Stop'), action: 'stop', icon: 'stop' },
              { label: t('刷新', 'Refresh'), action: 'refresh', icon: 'refresh' },
            ] },
            { type: 'text', text: t('局域网地址', 'LAN addresses'), tone: 'muted' },
            { type: 'list', items: { $: 'data.lanList' } },
            { type: 'callout', tone: 'info', text: t(
              '地址里的 t= 是口令，别外传。在浏览器里打开就能看到浏览器画面，点画面等于点那边的页面。',
              'The t= value is the token - keep it private. Open the URL to watch and click the live page.',
            ) },
          ],
        }
      },
      data: (scope, emit) => {
        const push = () => emit(payload())
        pushData = push
        push()
        refresh()
        const timer = setInterval(refresh, 8000)
        return () => {
          clearInterval(timer)
          if (pushData === push) pushData = () => {}
        }
      },
      actions: {
        'copy-local': () => ({ copy: urls(state.port, state.token).local, toast: '本机地址已复制' }),
        'copy-lan': () => {
          const l = urls(state.port, state.token).lan
          if (!l.length) return { toast: '没有局域网地址' }
          return { copy: l[0], toast: '局域网地址已复制' }
        },
        port: async () => {
          const next = state.port >= 7999 ? 7788 : state.port + 1
          state.note = `正在换到 ${next}…`
          pushData()
          const old = Number(readText(PID_FILE)) || 0
          if (alive(old)) { try { process.kill(old) } catch {} }
          const r = await startOnFreePort(next, state.token)
          state.port = Number(readText(PORT_FILE)) || r.port
          state.token = readText(TOKEN_FILE) || state.token
          state.status = r.status || await probe(state.port, state.token)
          state.note = state.status ? `已换到 ${state.port}` : '换端口失败'
          pushData()
          return { toast: `端口 ${state.port}`, refresh: true }
        },
        start: async () => {
          state.note = '正在启动…'
          pushData()
          await ensureRunning()
          return { toast: state.status ? `已启动 ${state.port}` : '启动失败', refresh: true }
        },
        stop: async () => {
          const pid = Number(readText(PID_FILE)) || 0
          if (alive(pid)) { try { process.kill(pid) } catch {} }
          // 兜底：按命令行精确匹配（不碰自己）
          for (const d of fs.existsSync('/proc') ? fs.readdirSync('/proc') : []) {
            if (!/^\d+$/.test(d)) continue
            let cmd = ''
            try { cmd = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').replace(/\0/g, ' ').trim() } catch { continue }
            if (cmd.startsWith('node ') && cmd.includes('server.mjs')) {
              try { process.kill(Number(d)) } catch {}
            }
          }
          await new Promise((r) => setTimeout(r, 500))
          state.status = await probe(state.port, state.token)
          state.note = '已停止'
          pushData()
          return { toast: '已停止', refresh: true }
        },
        refresh: async () => { await refresh(); return { refresh: true } },
      },
    })

    // 引擎启动时顺手把服务拉起来：面板一打开就能用
    ensureRunning()
    ctx.logger?.info?.(`ego-remote panel ready: ${DIR}`)
  })
}
