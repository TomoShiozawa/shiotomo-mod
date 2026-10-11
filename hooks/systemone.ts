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
