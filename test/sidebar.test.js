import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.join(here, '..', 'lib', 'client.js')
let mounts = 0
let ELEMENTS = []

async function loadClient() {
  ELEMENTS = []
  const fakeReact = {
    createElement: (type, props, ...kids) => { const n = { type, props, kids }; ELEMENTS.push(n); return n },
    useEffect: () => {},
    useRef: () => ({ current: null }),
    useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
    Fragment: 'frag'
  }
  globalThis.window = { __ModuleLoader__: null, localStorage: { _d: Object.create(null), getItem(k) { return this._d[k] ?? null }, setItem(k, v) { this._d[k] = String(v) }, removeItem(k) { delete this._d[k] } } }
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'en-US' }, configurable: true, writable: true })
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

function makeCtx() {
  const registered = []
  const ctx = {
    get(name) {
      if (name === 'slots') return {
        inject(slot, fn) { fn() },
        register(reg, comp) { registered.push({ slot: reg.name, id: reg.id, order: reg.order, component: comp }); return () => {} },
        subscribe: () => () => {}, entries: () => []
      }
      if (name === 'timer') return { interval: () => () => {} }
      return undefined
    },
    effect(fn) { fn(); return () => {} },
    on() {},
    logger: { warn() {}, info() {} }
  }
  return { ctx, registered }
}

test('registers a sidebar.footer.action entry with its own id', async () => {
  const exports = await loadClient()
  const h = makeCtx()
  exports.apply(h.ctx)
  const side = h.registered.find((r) => r.slot === 'sidebar.footer.action')
  assert.ok(side, '应当注册 sidebar.footer.action')
  assert.equal(side.id, 'usage-cost-side', '必须用本插件自己的 id')
  assert.equal(typeof side.order, 'number')
  assert.equal(typeof side.component, 'function')
  assert.notEqual(side.id, 'cordis-panel', '不得复用内置 id（会替换该格）')
})

test('the registered slot component passes wide through to the entry', async () => {
  const exports = await loadClient()
  const h = makeCtx()
  exports.apply(h.ctx)
  const side = h.registered.find((r) => r.slot === 'sidebar.footer.action')
  const out = side.component({ wide: false })
  assert.equal(out.type, exports.SidebarUsageEntry, '包装层应渲染 SidebarUsageEntry')
  assert.equal(out.props.wide, false, 'wide 必须透传')
  assert.equal(side.component({ wide: true }).props.wide, true)
})

test('SidebarUsageEntry renders the wide layout', async () => {
  const exports = await loadClient()
  ELEMENTS.length = 0
  exports.SidebarUsageEntry({ wide: true })
  const classes = ELEMENTS.map((e) => e.props && e.props.className).filter(Boolean)
  assert.ok(classes.includes('dsh-usage-side'), '展开态类名，实际: ' + JSON.stringify(classes))
  assert.ok(classes.includes('dsh-usage-sideBtn'))
  assert.ok(classes.includes('dsh-usage-sideLabel'), '展开态应显示文字标签')
  assert.equal(classes.some((c) => c.includes('rail')), false, '展开态不应有 rail')
})

test('SidebarUsageEntry renders the collapsed rail layout', async () => {
  const exports = await loadClient()
  ELEMENTS.length = 0
  exports.SidebarUsageEntry({ wide: false })
  const classes = ELEMENTS.map((e) => e.props && e.props.className).filter(Boolean)
  assert.ok(classes.includes('dsh-usage-side rail'), '收起态类名，实际: ' + JSON.stringify(classes))
  assert.equal(classes.includes('dsh-usage-sideLabel'), false, '收起态不显示文字标签')
})

test('SidebarUsageEntry tolerates missing props', async () => {
  const exports = await loadClient()
  assert.doesNotThrow(() => exports.SidebarUsageEntry(undefined))
  assert.doesNotThrow(() => exports.SidebarUsageEntry({}))
})

test('monthSummary only counts the current Beijing month', async () => {
  const exports = await loadClient()
  const now = Date.now()
  // 记录里的消耗由后端算好（autoCost），前端只做汇总，因此测试要带上该字段。
  const records = [
    { time: now, autoCost: 1.5, provider: 'deepseek-official', model: 'deepseek-v4-pro' },
    { time: now - 40 * 24 * 3600 * 1000, autoCost: 9.9, provider: 'deepseek-official', model: 'deepseek-v4-pro' }
  ]
  const s = exports.monthSummary(records)
  assert.equal(s.calls, 1, '上月记录不应计入本月')
  assert.equal(s.cost, 1.5, '只累计本月消耗')
  assert.equal(exports.monthSummary([]).cost, 0, '空列表应返回 0')
})

test('the sidebar entry injects its stylesheet only once', async () => {
  const styleTags = []
  globalThis.document = {
    head: { appendChild: (n) => styleTags.push(n) },
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '' })
  }
  try {
    const exports = await loadClient()
    const h = makeCtx()
    exports.apply(h.ctx)
    assert.equal(styleTags.filter((s) => s.id === 'dsh-usage-sidebar-style').length, 1)
  } finally {
    delete globalThis.document
  }
})
