import type { Backend } from '../types'

// Jev（TypeSafe のホスト API）と Laya（ローカルの laya-serve）は同じ POST /v1/systemone を話す。
// state と型付きの質問を渡すと、choice / score / noul の答えが確率つきで返る
export type Question = {
  type: 'choice' | 'score' | 'noul'
  instructions: string
  criteria?: unknown
}
export type Questions = Record<string, Question>
export type Decision = { model?: string; answers: Record<string, Record<string, unknown>> }

export type Endpoint = { backend: Backend; url: string; apiKey: string; model: string }

const QUESTION_TYPES: readonly string[] = ['choice', 'score', 'noul']
// Laya の /batch と同じ上限
export const MAX_STATES = 64

export const trimSlash = (url: string) => url.replace(/\/+$/, '')

export const DECIDE_USAGE = `使い方:
/decide yesno <命題> :: <対象のテキスト>
/decide choice <選択肢をカンマ区切り> <質問> :: <対象のテキスト>
/decide score <段階数 2〜10> <質問> :: <対象のテキスト>
/decide {"state": ..., "questions": {...}}   （decide ツールの入力をそのまま渡す）`

// /decide の引数を decide ツールの入力に直す。読めないときは使い方つきのエラー文を返す
export function parseDecideArgs(args: string): Record<string, unknown> | string {
  const text = args.trim()
  if (text === '') return DECIDE_USAGE

  if (text.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch (error) {
      return `JSON を読めません: ${String(error)}`
    }
    return DECIDE_USAGE
  }

  const split = text.indexOf('::')
  const state = split < 0 ? '' : text.slice(split + 2).trim()
  if (state === '') return `「::」のあとに対象のテキストを書いてください。\n${DECIDE_USAGE}`

  const [kind = '', ...rest] = text.slice(0, split).trim().split(/\s+/)
  const spec = kind === 'choice' || kind === 'score' ? (rest.shift() ?? '') : ''
  const instructions = rest.join(' ')
  if (instructions === '') return `質問を書いてください。\n${DECIDE_USAGE}`

  let question: Question
  if (kind === 'yesno' || kind === 'noul') {
    question = { type: 'noul', instructions }
  } else if (kind === 'choice') {
    const options = spec.split(',').filter(one => one !== '')
    if (options.length < 2) return `choice の選択肢は 2 つ以上をカンマ区切りで書いてください。\n${DECIDE_USAGE}`
    question = { type: 'choice', instructions, criteria: Object.fromEntries(options.map(one => [one, one])) }
  } else if (kind === 'score') {
    const levels = Number(spec)
    if (!Number.isInteger(levels) || levels < 2 || levels > 10) return `score の段階数は 2〜10 で書いてください。\n${DECIDE_USAGE}`
    const criteria = Array.from({ length: levels }, (_, i) =>
      i === 0 ? '1 (lowest)' : i === levels - 1 ? `${levels} (highest)` : String(i + 1),
    )
    question = { type: 'score', instructions, criteria }
  } else {
    return DECIDE_USAGE
  }

  return { state, questions: { answer: question } }
}

// モデルから受け取った questions を最低限だけ確かめる。細かい検証はサーバの 422 に任せる
export function checkQuestions(value: unknown): Questions | string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'questions は質問 ID をキーにしたオブジェクトで渡してください'
  }
  const entries = Object.entries(value)
  if (entries.length === 0) return 'questions が空です'
  for (const [id, question] of entries) {
    const { type, instructions } = (question ?? {}) as Partial<Question>
    if (!QUESTION_TYPES.includes(String(type))) return `questions.${id}.type は choice / score / noul のどれかです`
    if (typeof instructions !== 'string' || instructions === '') return `questions.${id}.instructions がありません`
  }
  return value as Questions
}
