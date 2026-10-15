import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, TurnStepInput } from 'claude-code'

const STEP: TurnStepInput = { turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'xhigh', messageCount: 1 }

// classify の答えを順に返し、turn.step の底で実際に送られたモデルと effort を記録する
function bottom(on: On, labels: string | string[], effortVerdict = 'default') {
  const sent: string[] = []
  const efforts: unknown[] = []
  const queue = [labels].flat()
  mock.store(on)
  // effort の判定（labels に higher を含む問い合わせ）は、既定のままと答える
  on('model.classify', ($, e) => {
    if (JSON.stringify(e).includes('higher')) return { value: effortVerdict } as never
    return { value: queue.length > 1 ? queue.shift() : queue[0] } as never
  })
  on('ui.status', () => ({ value: undefined }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('tool.register', () => ({ value: { tool: 'mcp__shiotomo-mod__decide' } }) as never)
  on('session.start', ($, e) => e)
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('turn.step', async function* ($, e) {
    sent.push(e.model)
    efforts.push(e.effort)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  return Object.assign(sent, { efforts })
}

async function submit($: Engine, text: string) {
  await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
}

async function step($: Engine, e: TurnStepInput = STEP) {
  for await (const _ of $.turn.step(e)) {
    // チャンクは使わない
  }
}

test('複雑なタスクは complex のモデルへ回す', async ($, on) => {
  const sent = bottom(on, 'complex')
  await submit($, 'この認証まわりの設計を全面的に見直して、移行計画も立てて')
  await step($)
  expect(sent).toEqual(['claude-opus-5-5'])
})

test('簡単なタスクは simple のモデルへ回す', async ($, on) => {
  const sent = bottom(on, 'simple')
  await submit($, 'この関数名のタイポを直して')
  await step($)
  expect(sent).toEqual(['claude-haiku-5-5'])
})

test('短いプロンプトは直前のルートを引き継ぐ', async ($, on) => {
  const sent = bottom(on, 'complex')
  await submit($, 'アーキテクチャを再設計してほしい、まずは現状調査から')
  await submit($, '続けて')
  await step($)
  expect(sent).toEqual(['claude-opus-5-5'])
})

test('サブエージェントのリクエストには触れない', async ($, on) => {
  const sent = bottom(on, 'simple')
  await submit($, 'この関数名のタイポを直して')
  await step($, { ...STEP, agentId: 'a1' })
  expect(sent).toEqual(['claude-opus-5-5'])
})

test('通常は effort を指定せずモデルの既定に任せる', async ($, on) => {
  const sent = bottom(on, 'standard')
  await submit($, 'このモジュールにテストを書いて')
  await step($)
  expect(sent).toEqual(['claude-sonnet-5-5'])
  expect(sent.efforts).toEqual([undefined])
})

test('上げは1段階の差でもすぐモデルを切り替える', async ($, on) => {
  const sent = bottom(on, ['standard', 'complex'])
  await submit($, 'このモジュールにテストを書いて')
  await step($, { ...STEP, messageCount: 50 })
  await submit($, 'アーキテクチャを再設計して、移行計画も立てて')
  await step($, { ...STEP, messageCount: 50 })
  expect(sent).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5'])
  expect(sent.efforts).toEqual([undefined, undefined])
})

test('大きい会話では1段階の下げでモデルは粘り、effort をティアに合わせて下げる', async ($, on) => {
  const sent = bottom(on, ['complex', 'standard'])
  await submit($, 'アーキテクチャを再設計して、移行計画も立てて')
  await step($, { ...STEP, messageCount: 50 })
  await submit($, 'このモジュールにテストを書いて')
  await step($, { ...STEP, messageCount: 50 })
  expect(sent).toEqual(['claude-opus-5-5', 'claude-opus-5-5'])
  // Opus 5.5 の既定は medium なので、standard に合わせても下がらず、そのまま既定に任せる
  expect(sent.efforts).toEqual([undefined, undefined])
})

test('小さい会話なら1段階の下げでもモデルを切り替える', async ($, on) => {
  const sent = bottom(on, ['complex', 'standard'])
  await submit($, 'アーキテクチャを再設計して、移行計画も立てて')
  await step($, { ...STEP, messageCount: 3 })
  await submit($, 'このモジュールにテストを書いて')
  await step($, { ...STEP, messageCount: 3 })
  expect(sent).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5'])
  expect(sent.efforts).toEqual([undefined, undefined])
})

test('大きく離れたティアへの変化ではモデルを切り替える', async ($, on) => {
  const sent = bottom(on, ['complex', 'simple'])
  await submit($, 'アーキテクチャを再設計して、移行計画も立てて')
  await step($, { ...STEP, messageCount: 50 })
  await submit($, 'この関数名のタイポを直して')
  await step($, { ...STEP, messageCount: 50 })
  expect(sent).toEqual(['claude-opus-5-5', 'claude-haiku-5-5'])
  expect(sent.efforts).toEqual([undefined, undefined])
})

test('固定モードは切り替えを待たずに即座にそのモデルを使う', async ($, on) => {
  const sent = bottom(on, 'complex')
  await submit($, 'アーキテクチャを再設計して、移行計画も立てて')
  await step($)
  await $.command.run({ command: 'router', args: 'simple', origin: { kind: 'composer' } } as never)
  await submit($, 'アーキテクチャを再設計して、移行計画も立てて')
  await step($)
  expect(sent).toEqual(['claude-opus-5-5', 'claude-haiku-5-5'])
})

test('/router で固定・off にできる', async ($, on) => {
  const sent = bottom(on, 'simple')
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'router', args: 'complex', origin: { kind: 'composer' } } as never)
  await submit($, 'この関数名のタイポを直して')
  await step($)
  await $.command.run({ command: 'router', args: 'off', origin: { kind: 'composer' } } as never)
  await submit($, 'この関数名のタイポを直して')
  await step($)
  expect(sent).toEqual(['claude-opus-5-5', 'claude-opus-5-5'])
})

test('userConfig でモデルを差し替えられる', { options: { simpleModel: 'claude-haiku-5-5' } }, async ($, on) => {
  const sent = bottom(on, 'simple')
  await submit($, 'この関数名のタイポを直して')
  await step($)
  expect(sent).toEqual(['claude-haiku-5-5'])
})

test('エイリアスはフル ID にして送る', async ($, on) => {
  const sent = bottom(on, 'simple')
  await submit($, 'この関数名のタイポを直して')
  await step($)
  expect(sent).toEqual(['claude-haiku-5-5'])
})

test('Bedrock の接頭辞を引き継ぐ', async ($, on) => {
  const sent = bottom(on, 'standard')
  await submit($, 'このモジュールにテストを書いて')
  await step($, { ...STEP, model: 'us.anthropic.claude-opus-5-5' })
  expect(sent).toEqual(['us.anthropic.claude-sonnet-5-5'])
})

test('effort 非対応のモデルには effort を送らない', { options: { simpleModel: 'claude-haiku-4-5' } }, async ($, on) => {
  const sent = bottom(on, 'simple')
  await submit($, 'この関数名のタイポを直して')
  await step($)
  expect(sent).toEqual(['claude-haiku-4-5'])
  expect(sent.efforts).toEqual([undefined])
})

test('モデルを切り替えるとき、明らかに合わなければ effort を変える', async ($, on) => {
  const sent = bottom(on, 'complex', 'higher')
  await submit($, 'この認証まわりの設計を全面的に見直して、移行計画も立てて')
  await step($)
  expect(sent).toEqual(['claude-opus-5-5'])
  expect(sent.efforts).toEqual(['high'])
})

test('モデルが同じなら、次のプロンプトでも切り替え時の effort を引き継ぐ', async ($, on) => {
  const sent = bottom(on, 'simple', 'lower')
  await submit($, 'この関数名のタイポを直して')
  await step($)
  await submit($, 'こっちの関数名のタイポも直して')
  await step($)
  expect(sent.efforts).toEqual(['low', 'low'])
})

test('既定が high のモデル（Sonnet 5.5）に留まるときは、ティアに合わせて effort を下げる', async ($, on) => {
  const sent = bottom(on, ['standard', 'simple'])
  await submit($, 'このモジュールにテストを書いて')
  await step($, { ...STEP, messageCount: 50 })
  await submit($, 'この関数名のタイポを直して')
  await step($, { ...STEP, messageCount: 50 })
  expect(sent).toEqual(['claude-sonnet-5-5', 'claude-sonnet-5-5'])
  expect(sent.efforts).toEqual([undefined, 'low'])
})

test('effort の変更はモデルの既定から 1 段階ずらす（Sonnet 5.5 は high から xhigh へ）', { options: { standardModel: 'claude-sonnet-5-5' } }, async ($, on) => {
  const sent = bottom(on, 'standard', 'higher')
  await submit($, 'このモジュールにテストを書いて')
  await step($)
  expect(sent.efforts).toEqual(['xhigh'])
})

test('xhigh に対応しないモデルは、既定の high から上げない', { options: { standardModel: 'claude-sonnet-4-6' } }, async ($, on) => {
  const sent = bottom(on, 'standard', 'higher')
  await submit($, 'このモジュールにテストを書いて')
  await step($)
  expect(sent.efforts).toEqual([undefined])
})
