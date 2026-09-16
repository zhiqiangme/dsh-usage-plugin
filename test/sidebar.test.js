import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.join(here, '..', 'lib', 'client.js')
let mounts = 0
let ELEMENTS = []

async function loadClient(opts) {
  const o = opts || {}
  ELEMENTS = []
  const fakeReact = {
    createElement: (type, props, ...kids) => { const n = { type, props, kids }; ELEMENTS.push(n); return n },
    useEffect: (fn) => { if (o.runEffects) fn() },
    useRef: () => ({ current: null }),
    useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
    Fragment: 'frag'
  }
  globalThis.window = { __ModuleLoader__: null, localStorage: o.storage || { _d: Object.create(null), getItem(k) { return this._d[k] ?? null }, setItem(k, v) { this._d[k] = String(v) }, removeItem(k) { delete this._d[k] } } }
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'en-US' }, configurable: true, writable: true })
  globalThis.fetch = o.fetch || (() => Promise.resolve({ json: () => Promise.resolve({ ok: true, records: [] }) }))
  let captured = null
  window.__ModuleLoader__ = { load(d) { captured = d } }
  const url = pathToFileURL(CLIENT).href + '?mount=' + (++mounts) + '&t=' + Date.now()
  await import(url)
  return captured.factory((n) => {
    if (n === 'react') return fakeReact
    if (n === 'react-dom') throw new Error('no react-dom')
    throw new Error('unexpected require: ' + n)
  })
}

function makeCtx(opts) {
  const o = opts || {}
  const registered = []
  const state = { current: o.session === undefined ? 'session-A' : o.session }
  const ctx = {
    get(name) {
      if (name === 'slots') return {
        inject(slot, fn) { fn() },
        register(reg, comp) { registered.push({ slot: reg.name, id: reg.id, order: reg.order, component: comp }); return () => {} },
        subscribe: () => () => {}, entries: () => []
      }
      if (name === 'sessions') return { list: { getSnapshot: () => ({ current: state.current }) } }
      if (name === 'timer') return { interval: () => () => {} }
      return undefined
    },
    effect(fn) { fn(); return () => {} },
    on() {},
    logger: { warn() {}, info() {} }
  }
  return { ctx, registered }
}

test('registers the sidebar entry with its own id, labelled 余额', async () => {
  const exports = await loadClient()
  const h = makeCtx()
  exports.apply(h.ctx)
  const side = h.registered.find((r) => r.slot === 'sidebar.footer.action')
  assert.ok(side)
  assert.equal(side.id, 'usage-cost-side')
  assert.notEqual(side.id, 'cordis-panel', '不得复用内置 id')
})

test('balanceDisplayOf formats money for currency providers', async () => {
  const exports = await loadClient()
  // 后端 totalBalance 已是格式化字符串
  const v = exports.balanceDisplayOf('deepseek', { ok: true, provider: 'deepseek', providerName: 'DeepSeek', totalBalance: '288.73', currency: 'CNY' })
  assert.equal(v.amount, '¥288.73')
  assert.equal(v.provider.name, 'DeepSeek')
  const usd = exports.balanceDisplayOf('digitalocean', { ok: true, providerName: 'DigitalOcean', totalBalance: '12.50', currency: 'USD' })
  assert.equal(usd.amount, '$12.50')
  // 后端已带符号时不得重复加符号
  const signed = exports.balanceDisplayOf('deepseek', { ok: true, providerName: 'DeepSeek', totalBalance: '¥288.73', currency: 'CNY' })
  assert.equal(signed.amount, '¥288.73')
  // 缺 totalBalance 时回退到 balance
  const fallback = exports.balanceDisplayOf('deepseek', { ok: true, providerName: 'DeepSeek', balance: '5.00', currency: 'CNY' })
  assert.equal(fallback.amount, '¥5.00')
})

test('balanceDisplayOf shows the quota percent string for the token-plan provider', async () => {
  const exports = await loadClient()
  // balance.js 产出的 usedPercent 是形如 "39.7%" 的字符串
  const v = exports.balanceDisplayOf('qwen-token-plan', { ok: true, providerName: '百炼 Token Plan', usedPercent: '39.7%' })
  assert.equal(v.amount, '39.7%')
  // 数字也接受
  assert.equal(exports.balanceDisplayOf('qwen-token-plan', { ok: true, usedPercent: 37.4 }).amount, '37.4%')
  assert.equal(exports.balanceDisplayOf('qwen-token-plan', { ok: true }), null, '没有配额字段时应返回 null')
})

test('balanceDisplayOf returns null when no amount is available', async () => {
  const exports = await loadClient()
  assert.equal(exports.balanceDisplayOf('deepseek', { ok: true }), null)
  assert.equal(exports.balanceDisplayOf('deepseek', { ok: true, totalBalance: '' }), null)
})

test('probeFirstBalance picks the FIRST configured provider, skipping unconfigured ones', async () => {
  // siliconflow 未配置凭据 -> 跳过；digitalocean 已配置且查到余额 -> 命中它。
  const calls = []
  const fetchImpl = (url, init) => {
    const body = JSON.parse(init.body)
    calls.push(body.provider)
    if (body.action === 'balanceCredentialStatus') {
      const configured = body.provider === 'digitalocean'
      return Promise.resolve({ json: () => Promise.resolve({ ok: true, configured }) })
    }
    if (body.action === 'balance') {
      return Promise.resolve({ json: () => Promise.resolve({ ok: true, providerName: 'DigitalOcean', totalBalance: 7.5, currency: 'USD' }) })
    }
    return Promise.resolve({ json: () => Promise.resolve({ ok: true }) })
  }
  const exports = await loadClient({ fetch: fetchImpl })
  const hit = await exports.probeFirstBalance(['deepseek', 'siliconflow', 'digitalocean'])
  assert.equal(hit.provider.id, 'digitalocean')
  assert.equal(hit.amount, '$7.50')
  // deepseek 只问了凭据（未配置即跳过，不发 balance 请求）
  assert.equal(calls.filter((c) => c === 'deepseek').length, 1, 'deepseek 只应问一次凭据状态')
  assert.equal(calls.filter((c) => c === 'siliconflow').length, 1)
})

test('probeFirstBalance prefers the earliest configured provider when several qualify', async () => {
  const calls = []
  const fetchImpl = (url, init) => {
    const body = JSON.parse(init.body)
    calls.push(body.action + ':' + body.provider)
    if (body.action === 'balanceCredentialStatus') return Promise.resolve({ json: () => Promise.resolve({ ok: true, configured: true }) })
    return Promise.resolve({ json: () => Promise.resolve({ ok: true, providerName: body.provider, totalBalance: 1, currency: 'CNY' }) })
  }
  const exports = await loadClient({ fetch: fetchImpl })
  const hit = await exports.probeFirstBalance(['deepseek', 'siliconflow'])
  assert.equal(hit.provider.id, 'deepseek', '多个都可用时取靠前的')
  assert.equal(calls.filter((c) => c.startsWith('balance:')).length, 1, '命中后不应继续查询后面的')
})

test('probeFirstBalance returns null when nothing is configured', async () => {
  const fetchImpl = () => Promise.resolve({ json: () => Promise.resolve({ ok: true, configured: false }) })
  const exports = await loadClient({ fetch: fetchImpl })
  assert.equal(await exports.probeFirstBalance(['deepseek', 'siliconflow']), null)
})

test('openBalanceView uses the captured openView handle to switch the session', async () => {
  const storage = { _d: Object.create(null), getItem(k) { return this._d[k] ?? null }, setItem(k, v) { this._d[k] = String(v) }, removeItem(k) { delete this._d[k] } }
  const exports = await loadClient({ storage })
  const h = makeCtx()
  exports.apply(h.ctx)
  // 宿主渲染 conversation.view 时注入 openView —— 触发捕获
  const view = h.registered.find((r) => r.slot === 'conversation.view')
  const opened = []
  view.component({ openView: (v, focus) => opened.push([v, focus]) })
  // 现在点击侧边栏
  const ok = exports.openBalanceView('session-A')
  assert.equal(ok, true, '有句柄时应即时切换')
  assert.deepEqual(opened, [['balance-view', 'usage-plugin:open-balance']])
  // 同时要落持久化偏好，保证下次进入该会话直接在余额页
  assert.equal(JSON.parse(storage.getItem('dsh.conversation.session-A')).view, 'balance-view')
})

test('openBalanceView ignores a handle captured for another session', async () => {
  const storage = { _d: Object.create(null), getItem(k) { return this._d[k] ?? null }, setItem(k, v) { this._d[k] = String(v) }, removeItem(k) { delete this._d[k] } }
  const exports = await loadClient({ storage })
  const h = makeCtx({ session: 'session-A' })
  exports.apply(h.ctx)
  const view = h.registered.find((r) => r.slot === 'conversation.view')
  const opened = []
  view.component({ openView: (v) => opened.push(v) })   // 句柄属于 session-A
  const ok = exports.openBalanceView('session-B')      // 却想切 session-B
  assert.equal(ok, false, '不应把别的会话切走')
  assert.deepEqual(opened, [])
  // 但偏好仍要写入目标会话
  assert.equal(JSON.parse(storage.getItem('dsh.conversation.session-B')).view, 'balance-view')
})

test('openBalanceView falls back to persisting the preference when no handle exists', async () => {
  const storage = { _d: Object.create(null), getItem(k) { return this._d[k] ?? null }, setItem(k, v) { this._d[k] = String(v) }, removeItem(k) { delete this._d[k] } }
  const exports = await loadClient({ storage })
  const h = makeCtx()
  exports.apply(h.ctx)
  // 未渲染任何 conversation.view => 没有 openView 句柄，应退化为写偏好
  const ok = exports.openBalanceView('session-A')
  assert.equal(ok, false, '没有句柄时应返回 false')
  const stored = JSON.parse(storage.getItem('dsh.conversation.session-A'))
  assert.equal(stored.view, 'balance-view', '应把偏好写成余额视图')
})

test('the entry label is the fixed 余额 text, not the provider name', async () => {
  const exports = await loadClient()
  // 测试环境为英文，t("余额") 解析为 "Balance"；关键是"固定文案"而非服务商名。
  ELEMENTS.length = 0
  exports.SidebarUsageEntry({ wide: true })
  const texts = ELEMENTS.map((e) => (e.kids || []).filter((k) => typeof k === 'string')).flat()
  assert.deepEqual(texts, ['Balance'], '标签应固定为「余额」，实际: ' + JSON.stringify(texts))
  const btn = ELEMENTS.find((e) => e.props && e.props.className === 'dsh-usage-sideBtn')
  assert.ok(btn, '应有按钮')
  assert.ok(String(btn.props.title).includes('Balance'), '悬停提示应包含余额文案')
})

test('the entry switches views on double click, not on single click', async () => {
  const exports = await loadClient()
  const calls = []
  ELEMENTS.length = 0
  exports.SidebarUsageEntry({ wide: true, openBalanceView: () => calls.push('called') })
  const btn = ELEMENTS.find((e) => e.props && e.props.className === 'dsh-usage-sideBtn')
  assert.equal(btn.props.onClick, undefined, '不应再绑定单击（避免误触切走视图）')
  assert.equal(typeof btn.props.onDoubleClick, 'function', '应绑定双击')
  btn.props.onDoubleClick()
  assert.deepEqual(calls, ['called'])
})

test('double click is safe when the host provides no navigation callback', async () => {
  const exports = await loadClient()
  ELEMENTS.length = 0
  exports.SidebarUsageEntry({ wide: true })
  const btn = ELEMENTS.find((e) => e.props && e.props.className === 'dsh-usage-sideBtn')
  assert.doesNotThrow(() => btn.props.onDoubleClick())
})
