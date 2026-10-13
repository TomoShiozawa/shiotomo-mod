import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

type Sent = { url: string; headers: Record<string, string>; body: Record<string, unknown> | undefined }

const QUESTIONS = {
  kind: {
    type: 'choice',
    instructions: 'What kind of failure is this?',
    criteria: { bug: 'a defect in our code', flaky: 'nondeterministic failure' },
  },
}
const ANSWERS = { kind: { type: 'choice', choice: 'flaky', probabilities: { bug: 0.2, flaky: 0.8 }, confidence: 0.6 } }

// /v1/systemone への POST を記録し、answer の返す本文で答える。answer が undefined なら接続できなかったことにする
function server(on: On, answer: (body: Record<string, unknown> | undefined) => unknown = () => ({ answers: ANSWERS })) {
  const sent: Sent[] = []
  const registered: string[] = []
  const logs: string[] = []
  mock.store(on)
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.log', ($, e) => {
    logs.push(e.text)
    return { value: undefined } as never
  })
  on('command.register', () => ({ value: undefined }) as never)
  on('tool.register', ($, e) => {
    registered.push(e.name)
    return { value: { tool: `mcp__shiotomo-mod__${e.name}` } } as never
  })
  on('model.classify', () => ({ value: 'standard' }) as never)
  on('session.start', ($, e) => e)
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('http.fetch', ($, e) => {
    const body = e.init?.body === undefined ? undefined : (JSON.parse(e.init.body) as Record<string, unknown>)
    if (e.init?.method === 'POST') sent.push({ url: e.url, headers: e.init.headers ?? {}, body })
    const reply = answer(body)
    if (reply === undefined) throw new Error('connect ECONNREFUSED 127.0.0.1:8000')
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(reply) } } as never
  })
  return Object.assign(sent, { registered, logs })
}

const start = ($: Engine) => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
const LAYA = { options: { decideBackend: 'laya' } }
const JEV = { options: { decideBackend: 'jev', jevApiKey: 'sk-test' } }

async function decide($: Engine, input: Record<string, unknown>) {
  const called = await $.tool.call({ tool: 'mcp__shiotomo-mod__decide', ...input } as never)
  return called as { result?: string; deny?: string }
}

test('既定では Jev / Laya を使わない', async ($, on) => {
  const sent = server(on)
  await start($)
  await $.prompt.submit({ text: 'このモジュールにテストを書いて', wait: false, origin: { kind: 'composer' } })
  expect(sent.registered).toEqual([])
  expect(sent).toEqual([])
  expect(sent.logs).toEqual([])
})

test('Laya を有効にすると decide ツールを登録する', LAYA, async ($, on) => {
  const sent = server(on)
  await start($)
  expect(sent.registered).toEqual(['decide'])
  expect(sent.logs).toEqual([])
})

test('Laya を有効にして接続できなければ、用意を促す', LAYA, async ($, on) => {
  const sent = server(on, () => undefined)
  await start($)
  expect(sent.logs.length).toEqual(1)
  expect(sent.logs[0]).toContain('laya-serve')
})

test('Jev を有効にしてキーがなければ、入力を促す', { options: { decideBackend: 'jev' } }, async ($, on) => {
  const sent = server(on)
  await start($)
  expect(sent.logs.length).toEqual(1)
  expect(sent.logs[0]).toContain('jevApiKey')
})

test('分類だけ Jev にしたときも、キーの入力を促す', { options: { classifier: 'jev' } }, async ($, on) => {
  const sent = server(on)
  await start($)
  expect(sent.registered).toEqual([])
  expect(sent.logs[0]).toContain('jevApiKey')
})

test('Laya に判断を任せ、答えを返す', LAYA, async ($, on) => {
  const sent = server(on)
  const called = await decide($, { state: 'test timed out once, passed on retry', questions: QUESTIONS })
  expect(sent.map(one => one.url)).toEqual(['http://localhost:8000/v1/systemone'])
  expect(sent[0]?.body).toEqual({ state: 'test timed out once, passed on retry', questions: QUESTIONS })
  expect(JSON.parse(called.result ?? '{}')).toEqual({ backend: 'laya', answers: ANSWERS })
})

test('Laya を有効にしても、モデルが Jev へ送り先を変えることはできない', { options: { decideBackend: 'laya', jevApiKey: 'sk-test' } }, async ($, on) => {
  const sent = server(on)
  await decide($, { state: 'x', questions: QUESTIONS, backend: 'jev' })
  expect(sent.map(one => one.url)).toEqual(['http://localhost:8000/v1/systemone'])
})

test('Jev にはモデル名とキーを付けて送る', JEV, async ($, on) => {
  const sent = server(on, () => ({ model: 'jev-1.13.0', answers: ANSWERS }))
  const called = await decide($, { state: 'x', questions: QUESTIONS })
  expect(sent[0]?.url).toEqual('https://api.typesafe.ai/v1/systemone')
  expect(sent[0]?.headers.authorization).toEqual('Bearer sk-test')
  expect(sent[0]?.body?.model).toEqual('jev-latest')
  expect(JSON.parse(called.result ?? '{}').model).toEqual('jev-1.13.0')
})

test('Jev のキーがなければ送らずにエラーを返す', { options: { decideBackend: 'jev' } }, async ($, on) => {
  const sent = server(on)
  const called = await decide($, { state: 'x', questions: QUESTIONS })
  expect(sent).toEqual([])
  expect(called.deny).toContain('jevApiKey')
})

test('states で複数の項目にまとめて答える', LAYA, async ($, on) => {
  const sent = server(on, body => ({
    answers: { kind: { type: 'choice', choice: body?.state === 'a' ? 'bug' : 'flaky' } },
  }))
  const called = await decide($, { states: ['a', 'b'], questions: QUESTIONS })
  expect(sent.length).toEqual(2)
  const { results } = JSON.parse(called.result ?? '{}')
  expect(results.map((one: { kind: { choice: string } }) => one.kind.choice)).toEqual(['bug', 'flaky'])
})

test('不正な questions は送らずにエラーを返す', LAYA, async ($, on) => {
  const sent = server(on)
  const called = await decide($, { state: 'x', questions: { kind: { type: 'summary', instructions: 'Summarize' } } })
  expect(sent).toEqual([])
  expect(called.deny).toContain('choice / score / noul')
})

test('Laya に接続できなければエラーを返す', LAYA, async ($, on) => {
  server(on, () => undefined)
  const called = await decide($, { state: 'x', questions: QUESTIONS })
  expect(called.deny).toContain('laya-serve')
})

async function slash($: Engine, args: string) {
  const shown = await $.command.run({ command: 'decide', args, origin: { kind: 'composer' } } as never)
  return JSON.stringify(shown)
}

test('/decide yesno で noul の質問を Laya に送る', LAYA, async ($, on) => {
  const sent = server(on, () => ({ answers: { answer: { type: 'noul', noul: 0.9 } } }))
  const shown = await slash($, 'yesno これは不安定なテストか :: retry で通った')
  expect(sent[0]?.body).toEqual({
    state: 'retry で通った',
    questions: { answer: { type: 'noul', instructions: 'これは不安定なテストか' } },
  })
  expect(shown).toContain('laya')
  expect(shown).toContain('0.9')
})

test('/decide choice は選択肢を criteria にする', LAYA, async ($, on) => {
  const sent = server(on)
  await slash($, 'choice bug,flaky,other 失敗の種類は？ :: timed out')
  expect(sent[0]?.body?.questions).toEqual({
    answer: { type: 'choice', instructions: '失敗の種類は？', criteria: { bug: 'bug', flaky: 'flaky', other: 'other' } },
  })
})

test('/decide score は段階数から尺度を作る', LAYA, async ($, on) => {
  const sent = server(on)
  await slash($, 'score 3 緊急度は？ :: 本番が落ちている')
  const question = (sent[0]?.body?.questions as Record<string, { criteria: string[] }>).answer
  expect(question?.criteria).toEqual(['1 (lowest)', '2', '3 (highest)'])
})

test('/decide は JSON の入力もそのまま受け付ける', LAYA, async ($, on) => {
  const sent = server(on)
  await slash($, JSON.stringify({ states: ['a', 'b'], questions: QUESTIONS }))
  expect(sent.length).toEqual(2)
})

test('/decide は引数が読めなければ送らずに使い方を返す', LAYA, async ($, on) => {
  const sent = server(on)
  expect(await slash($, '')).toContain('使い方')
  expect(await slash($, 'yesno 質問だけ')).toContain('::')
  expect(await slash($, 'choice a 質問 :: x')).toContain('2 つ以上')
  expect(await slash($, 'score 11 質問 :: x')).toContain('2〜10')
  expect(sent).toEqual([])
})

test('/decide は decide ツールが off でも classifier の送り先を使う', { options: { classifier: 'laya' } }, async ($, on) => {
  const sent = server(on)
  await slash($, 'yesno 正しいか :: x')
  expect(sent.map(one => one.url)).toEqual(['http://localhost:8000/v1/systemone'])
})

test('/decide は Jev / Laya がどちらも無効なら送らずに案内する', async ($, on) => {
  const sent = server(on)
  expect(await slash($, 'yesno 正しいか :: x')).toContain('decideBackend')
  expect(sent).toEqual([])
})

test('classifier が laya ならティアの分類を Laya に任せる', { options: { classifier: 'laya' } }, async ($, on) => {
  const sent = server(on, () => ({ answers: { tier: { type: 'choice', choice: 'complex' } } }))
  await $.prompt.submit({ text: 'アーキテクチャを再設計して、移行計画も立てて', wait: false, origin: { kind: 'composer' } })
  expect(sent[0]?.body?.questions).toBeDefined()
})

test('Laya での分類に失敗したら haiku で分類する', { options: { classifier: 'laya' } }, async ($, on) => {
  const sent = server(on, () => undefined)
  await $.prompt.submit({ text: 'このモジュールにテストを書いて', wait: false, origin: { kind: 'composer' } })
  expect(sent.length).toEqual(1)
})
