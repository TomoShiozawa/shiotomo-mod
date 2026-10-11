import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, TurnStepInput } from 'claude-code'

const STEP: TurnStepInput = { turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'xhigh', messageCount: 1 }

// classify の答えを順に返し、turn.step の底で実際に送られたモデルと effort を記録する
function bottom(on: On, labels: string | string[]) {
  const sent: string[] = []
  const efforts: unknown[] = []
  const queue = [labels].flat()
  mock.store(on)
  on('model.classify', () => ({ value: queue.length > 1 ? queue.shift() : queue[0] }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('tool.register', () => ({ value: { tool: 'mcp__model-router__decide' } }) as never)
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

test('タスクの重さに応じて effort を変える（モデルは変えない）', async ($, on) => {
  const sent = bottom(on, 'standard')
  await submit($, 'このモジュールにテストを書いて')
  await step($)
  expect(sent).toEqual(['claude-sonnet-5-5'])
  expect(sent.efforts).toEqual(['high'])
})

test('近いティアへの変化ではモデルを切り替えない（ヒステリシス）', async ($, on) => {
  const sent = bottom(on, ['complex', 'standard', 'standard'])
  await submit($, 'アーキテクチャを再設計して、移行計画も立てて')
  await step($)
  await submit($, 'このモジュールにテストを書いて')
  await step($)
  await submit($, 'このモジュールにテストを書いて')
  await step($)
  expect(sent).toEqual(['claude-opus-5-5', 'claude-opus-5-5', 'claude-opus-5-5'])
  expect(sent.efforts).toEqual(['medium', 'high', 'high'])
})

test('大きく離れたティアへの変化ではモデルを切り替える', { options: { simpleEffort: 'low' } }, async ($, on) => {
  const sent = bottom(on, ['complex', 'simple'])
  await submit($, 'アーキテクチャを再設計して、移行計画も立てて')
  await step($)
  await submit($, 'この関数名のタイポを直して')
  await step($)
  expect(sent).toEqual(['claude-opus-5-5', 'claude-haiku-5-5'])
  expect(sent.efforts).toEqual(['medium', 'low'])
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

test('エイリアスはフル ID にし、Haiku 5.5 にはティアの effort を渡す', async ($, on) => {
  const sent = bottom(on, 'simple')
  await submit($, 'この関数名のタイポを直して')
  await step($)
  expect(sent).toEqual(['claude-haiku-5-5'])
  expect(sent.efforts).toEqual(['medium'])
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

test('userConfig で effort を変えられる', { options: { standardEffort: 'xhigh' } }, async ($, on) => {
  const sent = bottom(on, 'standard')
  await submit($, 'このモジュールにテストを書いて')
  await step($)
  expect(sent.efforts).toEqual(['xhigh'])
})

test('不正な effort は既定に戻す', { options: { simpleEffort: 'ultra' } }, async ($, on) => {
  const sent = bottom(on, 'simple')
  await submit($, 'この関数名のタイポを直して')
  await step($)
  expect(sent.efforts).toEqual(['medium'])
})
