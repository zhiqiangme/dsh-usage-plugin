import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.join(here, '..', 'lib', 'client.js')
const SOURCE = fs.readFileSync(CLIENT, 'utf8')

test('the per-message token button is fully removed (dsh core ships the same feature)', () => {
  // 官方已自带消息 token 用量展示，插件这块整体删除。
  // 防止回归：槽位注册、组件定义、导出、后端路由都不应再出现。
  const code = SOURCE.replace(/\/\/[^\n]*/g, ' ')
  assert.equal(code.includes('MessageTokenAction'), false, '不应再有 MessageTokenAction')
  assert.equal(code.includes('usage-token'), false, '不应再注册 usage-token 槽位')
  assert.equal(/assistant-actions/.test(code), false, '不应再注入 assistant-actions 槽位')
  assert.equal(code.includes('tokenForMessage'), false, '不应再调用 tokenForMessage 接口')
  // 滚动条样式与 Portal 只为该弹窗服务，也应一并移除
  assert.equal(code.includes('dsh-usage-tok-style'), false, '不应再注入弹窗滚动条样式')
  assert.equal(code.includes('react-dom'), false, '不再需要 react-dom Portal')
})

test('the client bundle parses cleanly', () => {
  assert.doesNotThrow(
    () => new vm.Script('(function(){' + SOURCE + '\n})', { filename: 'client.js' }),
    'client.js 应可解析'
  )
})

test('reasoning tokens are never added to a total (already inside outputTokens)', () => {
  // dsh-token-meter 的 TokenUsageProjection：四桶互不相交，reasoning 已含在
  // outputTokens 内。多加一遍会让累计值比宿主状态栏偏大。
  const lines = SOURCE.split(/\r?\n/)
  const offenders = []
  lines.forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '')
    if (/\+\s*totalReason\b/.test(code)) offenders.push((i + 1) + ': ' + line.trim())
    if (/\+\s*(convo|agg2)\.reasoning\b/.test(code)) offenders.push((i + 1) + ': ' + line.trim())
  })
  assert.deepEqual(offenders, [], '不得把 reasoning 计入总量: ' + offenders.join(' | '))
})
