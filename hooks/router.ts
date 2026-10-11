import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Mode, Route, Weight } from '../types'

type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

const TIERS: readonly Weight[] = ['simple', 'standard', 'complex']
const MODE_KEY = 'mode'
// これより短いプロンプト（「続けて」「ok」など）は直前のルートを引き継ぐ
const MIN_CLASSIFY_LENGTH = 6
// 自動では、いま使っているモデルのティアとの差がこの段階数以上になったときだけモデルを切り替える。
// 会話途中のモデル切り替えはプロンプトキャッシュを作り直すので、小さな揺れでは切り替えない
const SWITCH_GAP = 2
// モデルは変えず effort で重さを合わせる（会話途中の effort 変更ではキャッシュは失われない）
const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const DEFAULT_EFFORT: Record<Weight, Effort> = {
  simple: 'low',
  standard: 'medium',
  complex: 'high',
}

const CLASSIFIER_HINT = `Classify the coding-assistant task below by how much reasoning it needs.
simple: a factual question, explaining a snippet, a typo or one-line fix, renaming, formatting, running a known command.
standard: implementing a feature in a few files, writing tests, ordinary debugging, a focused code review.
complex: architecture or system design, large refactors across many files, subtle concurrency or performance bugs, security analysis, ambiguous open-ended planning.

Task:
`

const mode = atom({ plugin: 'model-router', key: 'mode' } as const, 'auto')
const route = atom({ plugin: 'model-router', key: 'route' } as const, null)
// いま会話で使っているモデルが、どのティアのものか
const modelTier = atom({ plugin: 'model-router', key: 'modelTier' } as const, null as Weight | null)

const isMode = (value: unknown): value is Mode =>
  value === 'auto' || value === 'off' || TIERS.includes(value as Weight)

type Models = Record<Weight, string>
type Efforts = Record<Weight, Effort>

// turn.step はエイリアスを解決しないので、ここでフル ID に直してから渡す
const ALIASES: Record<string, string> = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
}

// effort を受け付けないモデル（Haiku 4.5 / Sonnet 4.5 以前、Claude 3 系）
const NO_EFFORT = /claude-(haiku-4|sonnet-4-5|sonnet-4-0|sonnet-4(?!-)|opus-4-0|opus-4-1|opus-4(?!-)|3)/

// エイリアスをフル ID にし、セッションのモデルが持つ接頭辞（Bedrock の `us.anthropic.` など）を引き継ぐ
function resolveModel(target: string, current: string): string {
  const id = ALIASES[target.toLowerCase()] ?? target
  const at = current.indexOf('claude-')
  const prefix = at > 0 ? current.slice(0, at) : ''

  return prefix !== '' && id.startsWith('claude-') ? prefix + id : id
}

function show($: EngineInterface, efforts: Efforts, current: Mode, chosen: Route | null) {
  if (current === 'off') return $.ui.status(undefined)
  if (chosen === null) return $.ui.status(`router: ${current}`)
  const how = chosen.isForced ? 'fixed' : 'auto'
  $.ui.status(`router: ${chosen.model} (${chosen.tier}, ${how}, effort ${efforts[chosen.tier]})`)
}

const gap = (a: Weight, b: Weight) => Math.abs(TIERS.indexOf(a) - TIERS.indexOf(b))

async function choose($: EngineInterface, models: Models, text: string): Promise<Route | null> {
  const current = await read($, mode)
  if (current === 'off') return null
  if (current !== 'auto') {
    await update($, modelTier, () => current)
    return { tier: current, model: models[current], isForced: true }
  }
  if (text.trim().length < MIN_CLASSIFY_LENGTH) return read($, route)

  const label = await $.model.classify(CLASSIFIER_HINT + text.slice(0, 4000), TIERS, {
    model: 'haiku',
  })
  const tier = TIERS.find(one => one === label) ?? 'standard'

  // 切り替えるのは、いまのモデルから大きく離れたときだけ。近いティアは同じモデルのまま effort で合わせる
  const anchor = await read($, modelTier)
  const applied = anchor === null || gap(tier, anchor) >= SWITCH_GAP ? tier : anchor
  await update($, modelTier, () => applied)

  return { tier, model: models[applied], isForced: false }
}

export const register: Register = (on, options) => {
  const pick = (value: unknown, tier: Weight): Effort =>
    EFFORTS.find(one => one === value) ?? DEFAULT_EFFORT[tier]
  const efforts: Efforts = {
    simple: pick(options.simpleEffort, 'simple'),
    standard: pick(options.standardEffort, 'standard'),
    complex: pick(options.complexEffort, 'complex'),
  }
  const models: Models = {
    simple: String(options.simpleModel ?? 'haiku'),
    standard: String(options.standardModel ?? 'sonnet'),
    complex: String(options.complexModel ?? 'opus'),
  }

  on('session.start', async ($, e, next) => {
    const saved = await $.store.get(MODE_KEY)
    if (isMode(saved)) await update($, mode, () => saved)

    await $.command.register({
      name: 'router',
      description: 'モデルルーターの状態表示・切替 (auto | off | simple | standard | complex)',
      argumentHint: '[auto|off|simple|standard|complex]',
    })
    show($, efforts, await read($, mode), null)

    return next(e)
  })

  on('command.run', { command: 'router' }, async ($, e) => {
    const arg = e.args.trim()

    if (arg === '') {
      const current = await read($, mode)
      const last = await read($, route)
      const lines = [
        `mode: ${current}`,
        `last route: ${last === null ? '-' : `${last.model} (${last.tier})`}`,
        `models: simple=${models.simple}, standard=${models.standard}, complex=${models.complex}`,
        `effort: simple=${efforts.simple}, standard=${efforts.standard}, complex=${efforts.complex}`,
      ]
      return { text: lines.join('\n') }
    }

    if (!isMode(arg)) return { text: `不明な引数: ${arg}（auto | off | simple | standard | complex）` }

    await update($, mode, () => arg)
    await $.store.set(MODE_KEY, arg)
    show($, efforts, arg, null)

    return { text: `mode を ${arg} にしました。` }
  })

  // 人が打ったプロンプト（端末の Enter、claude -p / SDK）だけを分類する。
  // 通知やプラグインからの投入は直前のルートのまま
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind !== 'composer' && e.origin.kind !== 'sdk') return next(e)

    const chosen = await choose($, models, e.text)
    await update($, route, () => chosen)
    show($, efforts, await read($, mode), chosen)

    return next(e)
  }).catch(($, e, next) => next(e))

  // メインループのリクエストだけモデルを差し替える。サブエージェントは各自の設定に任せる
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined || (await read($, mode)) === 'off') return yield* next(e)

    const chosen = await read($, route)
    if (chosen === null) return yield* next(e)

    const model = resolveModel(chosen.model, e.model)
    const effort = NO_EFFORT.test(model) ? undefined : efforts[chosen.tier]

    return yield* next({ ...e, model, effort })
  })
}
