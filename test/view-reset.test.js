import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * BUG 回归：点「用量」/「余额」页签后切走再切回，应当回到对话界面。
 *
 * 根因在 harness：conversation.view 的选择是**按会话持久化**的
 * （localStorage \`dsh.conversation.<sessionId>\`，见 dsh-client-ui-conversation 的
 * readConversationViewPreference / restoreView），切回会话时会恢复上次的页签。
 * 插件侧的修法是：订阅会话切换，在离开旧会话时把自己写入的那两个 view id 复位为 chat。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.join(here, '..', 'lib', 'client.js')
let mounts = 0

function makeStorage(seed) {
  const data = Object.assign(Object.create(null), seed || {})
  return {
    _d: data,
    getItem(k) { return k in data ? data[k] : null },
    setItem(k, v) { data[k] = String(v) },
    removeItem(k) { delete data[k] }
  }
}

async function loadClient(storage) {
  globalThis.window = { __ModuleLoader__: null, localStorage: storage }
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'en-US' }, configurable: true, writable: true })
  let captured = null
  window.__ModuleLoader__ = { load(d) { captured = d } }
  const url = pathToFileURL(CLIENT).href + '?mount=' + (++mounts)
  await import(url)
  if (!captured) throw new Error('ModuleLoader.load was not called')
  return captured.factory((n) => {
    if (n === 'react') return { createElement: () => null }
    throw new Error('unexpected require: ' + n)
  })
}

/** 造一个最小可用的客户端 ctx：slots + sessions，并把 effect 立即执行。 */
function makeCtx() {
  const listeners = []
  const state = { current: 'session-A' }
  const disposers = []
  const registered = []
  const sessions = {
    list: {
      getSnapshot: () => ({ current: state.current }),
      subscribe(fn) { listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1) } }
    }
  }
  const slots = {
    inject() {},
    register(options, render) { registered.push(options); return () => {} },
    subscribe() { return () => {} },
    entries() { return [] }
  }
  const ctx = {
    get(name) {
      if (name === 'slots') return slots
      if (name === 'sessions') return sessions
      return undefined
    },
    effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); return () => {} },
    on() {},
    logger: { warn() {}, info() {} }
  }
  return {
    ctx, registered,
    /** 切换当前会话并触发订阅者，模拟用户在侧边栏点另一个对话。 */
    switchTo(id) { state.current = id; for (const fn of [...listeners]) fn() },
    listenerCount: () => listeners.length
  }
}

const KEY = 'dsh.conversation'

test('switching away from a session resets the plugin view preference to chat', async () => {
  const storage = makeStorage({
    // 用户在 session-A 里点过「用量」，harness 会把这个偏好持久化下来
    [KEY + '.session-A']: JSON.stringify({ draft: 'hello', view: 'usage-cost-view', viewRequest: null }),
    // 另一个会话停在「余额」
    [KEY + '.session-B']: JSON.stringify({ draft: '', view: 'balance-view', viewRequest: null })
  })
  const exports = await loadClient(storage)
  const h = makeCtx()
  exports.apply(h.ctx)

  assert.ok(h.listenerCount() > 0, '应当订阅了会话切换')

  // A -> B：离开 A 时把 A 的偏好复位
  h.switchTo('session-B')
  const a = JSON.parse(storage.getItem(KEY + '.session-A'))
  assert.equal(a.view, 'chat', '离开后 session-A 应落回对话界面')
  assert.equal(a.draft, 'hello', '同一存储里的草稿必须保留')
  assert.equal(a.viewRequest, null)

  // B 的偏好此刻不动，等离开 B 时才复位
  assert.equal(JSON.parse(storage.getItem(KEY + '.session-B')).view, 'balance-view')

  h.switchTo('session-A')
  assert.equal(JSON.parse(storage.getItem(KEY + '.session-B')).view, 'chat', '离开 B 后同样复位')
})

test('the built-in trajectory view and unrelated sessions are never touched', async () => {
  const storage = makeStorage({
    // 内置「轨迹」页签：不是本插件注册的 id，必须原样保留
    [KEY + '.session-A']: JSON.stringify({ draft: '', view: 'trajectory', viewRequest: { view: 'trajectory', focus: 'x' } })
  })
  const exports = await loadClient(storage)
  const h = makeCtx()
  exports.apply(h.ctx)
  h.switchTo('session-B')
  const a = JSON.parse(storage.getItem(KEY + '.session-A'))
  assert.equal(a.view, 'trajectory', '内置页签的选择不归插件管')
  assert.deepEqual(a.viewRequest, { view: 'trajectory', focus: 'x' })
})

test('a session with no stored preference is left alone', async () => {
  const storage = makeStorage({})
  const exports = await loadClient(storage)
  const h = makeCtx()
  exports.apply(h.ctx)
  h.switchTo('session-B')
  assert.equal(storage.getItem(KEY + '.session-A'), null, '没有偏好时不应凭空写入')
})

test('corrupt storage never throws out of the session subscriber', async () => {
  const storage = makeStorage({ [KEY + '.session-A']: '{not json' })
  const exports = await loadClient(storage)
  const h = makeCtx()
  exports.apply(h.ctx)
  h.switchTo('session-B')
  assert.equal(storage.getItem(KEY + '.session-A'), '{not json', '解析失败时保持原样')
})

test('missing sessions service degrades instead of failing activation', async () => {
  const storage = makeStorage({})
  const exports = await loadClient(storage)
  const ctx = {
    get(name) { return name === 'slots' ? { inject() {}, register: () => () => {}, subscribe: () => () => {}, entries: () => [] } : undefined },
    effect(fn) { fn(); return () => {} },
    on() {}
  }
  assert.doesNotThrow(() => exports.apply(ctx), '没有 sessions 服务时仍要能激活')
})
