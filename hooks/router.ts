import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Backend, Effort, Mode, Route, Weight } from '../types'
import { MAX_STATES, checkQuestions, parseDecideArgs, trimSlash } from './systemone'
import type { Decision, Endpoint, Questions } from './systemone'

const TIERS: readonly Weight[] = ['simple', 'standard', 'complex']
const MODE_KEY = 'mode'
// これより短いプロンプト（「続けて」「ok」など）は直前のルートを引き継ぐ
const MIN_CLASSIFY_LENGTH = 6
// 自動では、重いティアへは 1 段階でもすぐ切り替える。軽いティアへは、差がこの段階数以上か、
// 会話が小さい（直前のメインリクエストのメッセージ数が SMALL_CONVERSATION 未満）ときだけ切り替える。
// 会話途中のモデル切り替えはプロンプトキャッシュを作り直すので、節約の小さい下げは長い会話では見送る
const DOWNSHIFT_GAP = 2
const SMALL_CONVERSATION = 10
// effort は各モデルの既定に任せる。変えるのは次の 2 つのときだけ（会話途中の effort 変更ではキャッシュは失われない）
// - 下げを見送って重いモデルに留まるとき: タスクのティアに合わせて、モデルの既定より下がる場合だけ下げる
// - モデルを切り替えるとき: そのモデルの既定のままでは明らかに合わないと判定されたら、既定から 1 段階下げるか上げる
const LIGHT_EFFORT: Partial<Record<Weight, Effort>> = { simple: 'low', standard: 'medium' }
const EFFORT_VERDICTS = ['default', 'lower', 'higher'] as const

// モデルごとの既定の effort（https://platform.claude.com/docs/en/build-with-claude/effort）。
// Opus 5.5 と Haiku 5.5 は medium、effort に対応するそれ以外のモデルは high
const MEDIUM_DEFAULT = /claude-(opus-5-5|haiku-5-5)/
// xhigh を受け付けないモデル。ここでは high から上げられない
const NO_XHIGH = /claude-(sonnet-4-6|opus-4-6|opus-4-5)/

const EFFORT_HINT = (model: string, standard: Effort) => `The task below will run on ${model} with its default reasoning effort (${standard}).
default: the default effort is right. Choose this unless the mismatch is obvious.
lower: obviously trivial work that needs almost no reasoning even for its category.
higher: obviously hard work that needs deeper reasoning than usual for its category.

Task:
`

const CLASSIFIER_HINT = `Classify the coding-assistant task below by how much reasoning it needs.
simple: a factual question, explaining a snippet, a typo or one-line fix, renaming, formatting, running a known command.
standard: implementing a feature in a few files, writing tests, ordinary debugging, a focused code review.
complex: architecture or system design, large refactors across many files, subtle concurrency or performance bugs, security analysis, ambiguous open-ended planning.

Task:
`

// 分類を Jev / Laya に任せるときの質問。haiku の CLASSIFIER_HINT と同じ基準
const TIER_QUESTIONS: Questions = {
  tier: {
    type: 'choice',
    instructions: 'How much reasoning does this coding-assistant task need?',
    criteria: {
      simple: 'a factual question, explaining a snippet, a typo or one-line fix, renaming, formatting, running a known command',
      standard: 'implementing a feature in a few files, writing tests, ordinary debugging, a focused code review',
      complex:
        'architecture or system design, large refactors across many files, subtle concurrency or performance bugs, security analysis, ambiguous open-ended planning',
    },
  },
}

// effort の判定を Jev / Laya に任せるときの質問。haiku の EFFORT_HINT と同じ基準
const effortQuestions = (model: string, standard: Effort): Questions => ({
  effort: {
    type: 'choice',
    instructions: `Is the default reasoning effort (${standard} on ${model}) right for this coding-assistant task? Choose default unless the mismatch is obvious.`,
    criteria: {
      default: 'the default effort is right',
      lower: 'obviously trivial work that needs almost no reasoning even for its category',
      higher: 'obviously hard work that needs deeper reasoning than usual for its category',
    },
  },
})

const DECIDE_TOOL = 'mcp__shiotomo-mod__decide'
const DECIDE_DESCRIPTION = `Hands a bounded judgment to a System-1 decision model (Laya, run locally, or TypeSafe's hosted Jev) and returns typed answers with calibrated probabilities, in milliseconds and at a tiny fraction of your own cost.

Use it instead of judging yourself when the answer is one of a fixed set: classification, rating on a scale, or yes/no over text. It pays off most over many items: labeling or triaging log lines, issues, test failures, review comments or commit messages; sentiment, urgency, language or topic; checking whether each of many snippets meets a criterion. Pass the same questions over up to ${MAX_STATES} items with \`states\`.
Do not use it to generate text or code, for multi-step reasoning, or when the answer is not among the options you give. Check important or low-confidence answers yourself.

state: the text or JSON the judgment is about (questions can point at a field with a backticked path such as \`order.charges\`).
questions: an object keyed by ids you choose; the id is not sent to the model, so put the whole question in instructions.
- choice: criteria maps each option to a description, e.g. {"bug": "a defect in our code", "flaky": "nondeterministic failure", "other": "anything else"}. Answer: choice, probabilities, confidence.
- score: criteria is a list of 2-10 described levels, lowest first. Answer: score (the expected level index), probabilities, confidence.
- noul: a yes/no proposition; criteria {"true": ..., "false": ...} is optional. Answer: noul, the probability of yes.`

const DECIDE_SCHEMA = {
  type: 'object',
  properties: {
    state: { description: 'The text or JSON object the judgment is about.' },
    states: {
      type: 'array',
      maxItems: MAX_STATES,
      description: 'Several states to ask the same questions about, in place of state. Answers come back in the same order.',
    },
    questions: {
      type: 'object',
      description: 'Questions keyed by an id of your choosing.',
      additionalProperties: {
        type: 'object',
        properties: {
          type: { enum: ['choice', 'score', 'noul'] },
          instructions: { type: 'string', description: 'The whole question.' },
          criteria: { description: 'choice: {option: description}; score: [level descriptions, lowest first]; noul: optional {true, false}.' },
        },
        required: ['type', 'instructions'],
      },
    },
  },
  required: ['questions'],
}

const mode = atom({ plugin: 'shiotomo-mod', key: 'mode' } as const, 'auto')
const route = atom({ plugin: 'shiotomo-mod', key: 'route' } as const, null)
// いま会話で使っているモデルが、どのティアのものか
const modelTier = atom({ plugin: 'shiotomo-mod', key: 'modelTier' } as const, null as Weight | null)
// 直前のメインリクエストのメッセージ数。prompt.submit の時点では取れないので、これを会話の大きさとして使う
const messageCount = atom({ plugin: 'shiotomo-mod', key: 'messageCount' } as const, 0)

const isMode = (value: unknown): value is Mode =>
  value === 'auto' || value === 'off' || TIERS.includes(value as Weight)

type Models = Record<Weight, string>
type Classifier = 'haiku' | Backend
type Endpoints = Record<Backend, Endpoint>

const BACKENDS: readonly Backend[] = ['laya', 'jev']
// userConfig の真偽値は boolean でも文字列でも届きうる
const flag = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : value === 'true' ? true : value === 'false' ? false : fallback

const isBackend = (value: unknown): value is Backend => BACKENDS.includes(value as Backend)

// turn.step はエイリアスを解決しないので、ここでフル ID に直してから渡す
const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

const ALIASES: Record<string, string> = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
}

// モデルの既定の effort。effort に対応しないモデルは undefined
function defaultEffort(model: string): Effort | undefined {
  const id = ALIASES[model.toLowerCase()] ?? model
  if (NO_EFFORT.test(id)) return undefined
  return MEDIUM_DEFAULT.test(id) ? 'medium' : 'high'
}

// 既定から 1 段階ずらした effort。ずらせない（端、または対応しない段）ときは undefined
function shifted(model: string, direction: -1 | 1): Effort | undefined {
  const standard = defaultEffort(model)
  if (standard === undefined) return undefined
  const next = EFFORTS[EFFORTS.indexOf(standard) + direction]
  return direction === 1 && next === 'xhigh' && NO_XHIGH.test(ALIASES[model.toLowerCase()] ?? model) ? undefined : next
}

// ティアに合わせて下げる。モデルの既定より下がるときだけ
function lighter(model: string, target: Effort | undefined): Effort | undefined {
  const standard = defaultEffort(model)
  if (standard === undefined || target === undefined) return undefined
  return EFFORTS.indexOf(target) < EFFORTS.indexOf(standard) ? target : undefined
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

function show($: EngineInterface, routingEnabled: boolean, current: Mode, chosen: Route | null) {
  if (!routingEnabled || current === 'off') return $.ui.status(undefined)
  if (chosen === null) return $.ui.status(`router: ${current}`)
  const how = chosen.isForced ? 'fixed' : 'auto'
  $.ui.status(`router: ${chosen.model} (${chosen.tier}, ${how}${chosen.effort === undefined ? '' : `, effort ${chosen.effort}`})`)
}

const gap = (a: Weight, b: Weight) => Math.abs(TIERS.indexOf(a) - TIERS.indexOf(b))

async function decide(
  $: EngineInterface,
  endpoint: Endpoint,
  state: unknown,
  questions: Questions,
): Promise<Decision> {
  if (endpoint.backend === 'jev' && endpoint.apiKey === '') {
    throw new Error('jev: jevApiKey が設定されていません（/plugin configure shiotomo-mod で設定してください）')
  }

  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (endpoint.apiKey !== '') headers.authorization = `Bearer ${endpoint.apiKey}`
  // Laya の model はチェックポイント名なので、Jev のモデル名は送らない
  const body = endpoint.backend === 'jev' ? { model: endpoint.model, state, questions } : { state, questions }

  const url = `${trimSlash(endpoint.url)}/v1/systemone`
  let response
  try {
    response = await $.http.fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
  } catch (error) {
    const hint = endpoint.backend === 'laya' ? '（laya-serve が起動しているか確かめてください）' : ''
    throw new Error(`${endpoint.backend}: ${url} に接続できません${hint}: ${String(error)}`)
  }
  if (!response.ok) {
    throw new Error(`${endpoint.backend}: HTTP ${response.status}: ${response.text.slice(0, 500)}`)
  }

  const parsed: unknown = JSON.parse(response.text)
  const answers = (parsed as Decision | null)?.answers
  if (typeof answers !== 'object' || answers === null) {
    throw new Error(`${endpoint.backend}: answers のない応答です: ${response.text.slice(0, 200)}`)
  }
  return parsed as Decision
}

type DecideOutcome =
  | { payload: { backend: Backend; model: string | undefined; answers?: Decision['answers']; results?: Decision['answers'][] } }
  | { deny: string }

// decide ツールと /decide に共通の本体。入力 {state | states, questions} を確かめて backend に送る
async function runDecide(
  $: EngineInterface,
  backend: Backend | 'off',
  endpoints: Endpoints,
  input: Record<string, unknown>,
): Promise<DecideOutcome> {
  const questions = checkQuestions(input.questions)
  if (typeof questions === 'string') return { deny: questions }

  if (backend === 'off') {
    return { deny: 'Jev / Laya が無効です（/config で decideBackend か classifier を laya / jev にし、decisionEnabled を有効にしてください）' }
  }
  const endpoint = endpoints[backend]

  const states = input.states
  if (Array.isArray(states)) {
    if (states.length === 0 || states.length > MAX_STATES) return { deny: `states は 1〜${MAX_STATES} 件で渡してください` }
  } else if (input.state === undefined) {
    return { deny: 'state か states を渡してください' }
  }

  try {
    if (Array.isArray(states)) {
      const decisions = await Promise.all(states.map(state => decide($, endpoint, state, questions)))
      return { payload: { backend, model: decisions[0]?.model, results: decisions.map(one => one.answers) } }
    }
    const { model, answers } = await decide($, endpoint, input.state, questions)
    return { payload: { backend, model, answers } }
  } catch (error) {
    return { deny: error instanceof Error ? error.message : String(error) }
  }
}

// 何か HTTP で答えが返れば動いているとみなす（接続できないときだけ fetch が reject する）
async function isReachable($: EngineInterface, url: string): Promise<boolean> {
  try {
    await $.http.fetch(trimSlash(url))
    return true
  } catch {
    return false
  }
}

// 有効にした Jev / Laya がすぐ使えないとき、何をすればよいかを返す。使えるなら undefined
async function setupHint($: EngineInterface, backend: Backend, endpoints: Endpoints): Promise<string | undefined> {
  if (backend === 'jev') {
    return endpoints.jev.apiKey === ''
      ? 'shiotomo-mod: Jev を使うには /plugin configure shiotomo-mod で jevApiKey（TypeSafe の API キー）を入力してください。'
      : undefined
  }
  if (await isReachable($, endpoints.laya.url)) return undefined
  return `shiotomo-mod: Laya（${endpoints.laya.url}）に接続できません。pip install "laya[serve]" で入れて laya-serve を起動するか、/config で layaUrl を合わせてください。`
}

// Jev / Laya が使えないときは haiku に戻す
async function classify(
  $: EngineInterface,
  classifier: Classifier,
  endpoints: Endpoints,
  text: string,
): Promise<string | undefined> {
  const task = text.slice(0, 4000)
  if (classifier !== 'haiku') {
    try {
      const { answers } = await decide($, endpoints[classifier], { task }, TIER_QUESTIONS)
      return String(answers.tier?.choice)
    } catch (error) {
      $.ui.log(`${classifier} での分類に失敗したので haiku で分類します: ${String(error)}`, { to: 'debug' })
    }
  }
  return $.model.classify(CLASSIFIER_HINT + task, TIERS, { model: 'haiku' })
}

// モデルを切り替えるときだけ呼ぶ。そのモデルの既定でよければ undefined
// Jev / Laya を選んでいればそちらで判定し、失敗したときは haiku に戻す
async function judgeEffort(
  $: EngineInterface,
  classifier: Classifier,
  endpoints: Endpoints,
  model: string,
  text: string,
): Promise<Effort | undefined> {
  const standard = defaultEffort(model)
  // effort に対応しないモデルや、上にも下にもずらせないモデルは、判定しても変えようがない
  if (standard === undefined || (shifted(model, -1) === undefined && shifted(model, 1) === undefined)) return undefined
  const task = text.slice(0, 4000)
  let verdict: string | undefined
  try {
    if (classifier !== 'haiku') {
      try {
        const { answers } = await decide($, endpoints[classifier], { task }, effortQuestions(model, standard))
        verdict = String(answers.effort?.choice)
      } catch (error) {
        $.ui.log(`${classifier} での effort の判定に失敗したので haiku で判定します: ${String(error)}`, { to: 'debug' })
      }
    }
    verdict ??= await $.model.classify(EFFORT_HINT(model, standard) + task, EFFORT_VERDICTS, { model: 'haiku' })
  } catch {
    return undefined
  }
  return verdict === 'lower' ? shifted(model, -1) : verdict === 'higher' ? shifted(model, 1) : undefined
}

async function choose(
  $: EngineInterface,
  models: Models,
  classifier: Classifier,
  endpoints: Endpoints,
  text: string,
): Promise<Route | null> {
  const current = await read($, mode)
  if (current === 'off') return null
  if (current !== 'auto') {
    await update($, modelTier, () => current)
    return { tier: current, model: models[current], isForced: true }
  }
  if (text.trim().length < MIN_CLASSIFY_LENGTH) return read($, route)

  const label = await classify($, classifier, endpoints, text)
  const tier = TIERS.find(one => one === label) ?? 'standard'

  // 上げはすぐ切り替える。下げは大きく離れたときか会話が小さいときだけで、それ以外は同じモデルのまま effort で合わせる
  const anchor = await read($, modelTier)
  const up = anchor !== null && TIERS.indexOf(tier) > TIERS.indexOf(anchor)
  const size = await read($, messageCount)
  const applied =
    anchor === null || up || gap(tier, anchor) >= DOWNSHIFT_GAP || size < SMALL_CONVERSATION ? tier : anchor
  await update($, modelTier, () => applied)

  const previous = await read($, route)
  const model = models[applied]
  let effort: Effort | undefined
  if (applied !== tier) effort = lighter(model, LIGHT_EFFORT[tier])
  else if (anchor === null || applied !== anchor) effort = await judgeEffort($, classifier, endpoints, model, text)
  else if (previous?.model === model && previous.tier === tier) effort = previous.effort

  return { tier, model, isForced: false, effort }
}

export const register: Register = (on, options) => {
  const models: Models = {
    simple: String(options.simpleModel ?? 'haiku'),
    standard: String(options.standardModel ?? 'sonnet'),
    complex: String(options.complexModel ?? 'opus'),
  }
  const endpoints: Endpoints = {
    laya: {
      backend: 'laya',
      url: String(options.layaUrl ?? 'http://localhost:8000'),
      apiKey: String(options.layaApiKey ?? ''),
      model: '',
    },
    jev: {
      backend: 'jev',
      url: String(options.jevUrl ?? 'https://api.typesafe.ai'),
      apiKey: String(options.jevApiKey ?? ''),
      model: String(options.jevModel ?? 'jev-latest'),
    },
  }
  // モデルの切り替えと Jev / Laya の利用は、それぞれ独立に無効にできる
  const routingEnabled = flag(options.routingEnabled, true)
  const decisionEnabled = flag(options.decisionEnabled, true)
  // Jev / Laya を無効にすると、分類は haiku、decide ツールは出さない
  const classifier: Classifier = decisionEnabled && isBackend(options.classifier) ? options.classifier : 'haiku'
  const decideBackend: Backend | 'off' = decisionEnabled && isBackend(options.decideBackend) ? options.decideBackend : 'off'

  on('session.start', async ($, e, next) => {
    const saved = await $.store.get(MODE_KEY)
    if (isMode(saved)) await update($, mode, () => saved)

    await $.command.register({
      name: 'router',
      description: 'モデルルーターの状態表示・切替 (auto | off | simple | standard | complex)',
      argumentHint: '[auto|off|simple|standard|complex]',
    })
    await $.command.register({
      name: 'decide',
      description: 'Jev / Laya に分類・採点・yes/no の判断を任せる (yesno | choice | score | JSON)',
      argumentHint: '<yesno|choice|score> ... :: <text>',
    })
    if (decideBackend !== 'off') {
      await $.tool.register({ name: 'decide', description: DECIDE_DESCRIPTION, inputSchema: DECIDE_SCHEMA, isDeferred: false })
    }
    // 有効にした（設定を変えると mod が読み込み直され、ここを通る）ときに、キーの入力や Laya の用意を促す
    const enabled = BACKENDS.filter(one => one === classifier || one === decideBackend)
    for (const backend of enabled) {
      const hint = await setupHint($, backend, endpoints)
      if (hint !== undefined) $.ui.log(hint)
    }
    show($, routingEnabled, await read($, mode), null)

    return next(e)
  })

  on('command.run', { command: 'router' }, async ($, e) => {
    const arg = e.args.trim()

    if (arg === '') {
      const current = await read($, mode)
      const lines = [
        `mode: ${current}`,
        `models: simple=${models.simple}, standard=${models.standard}, complex=${models.complex}`,
        `Enable model switching: ${routingEnabled ? 'on' : 'off'}`,
        `Enable decision making (Jev / Laya): ${decisionEnabled ? 'on' : 'off'}`,
        `classifier: ${classifier}`,
        `decide tool: ${decideBackend === 'off' ? 'off' : `${decideBackend} (${endpoints[decideBackend].url})`}`,
      ]
      return { text: lines.join('\n') }
    }

    if (!isMode(arg)) return { text: `不明な引数: ${arg}（auto | off | simple | standard | complex）` }

    await update($, mode, () => arg)
    await $.store.set(MODE_KEY, arg)
    show($, routingEnabled, arg, null)

    return { text: `mode を ${arg} にしました。` }
  })

  // 人が打ったプロンプト（端末の Enter、claude -p / SDK）だけを分類する。
  // 通知やプラグインからの投入は直前のルートのまま
  on('prompt.submit', async ($, e, next) => {
    if (!routingEnabled || (e.origin.kind !== 'composer' && e.origin.kind !== 'sdk')) return next(e)

    const chosen = await choose($, models, classifier, endpoints, e.text)
    await update($, route, () => chosen)
    show($, routingEnabled, await read($, mode), chosen)

    return next(e)
  }).catch(($, e, next) => next(e))

  // メインループのリクエストだけモデルを差し替える。サブエージェントは各自の設定に任せる
  on('turn.step', async function* ($, e, next) {
    if (!routingEnabled || e.agentId !== undefined) return yield* next(e)
    await update($, messageCount, () => e.messageCount)
    if ((await read($, mode)) === 'off') return yield* next(e)

    const chosen = await read($, route)
    if (chosen === null) return yield* next(e)

    const model = resolveModel(chosen.model, e.model)
    const effort = NO_EFFORT.test(model) ? undefined : chosen.effort

    return yield* next({ ...e, model, effort })
  })

  // 人が /decide で直接判断を投げる。入力の検証と送信は decide ツールと同じ。
  // 自分で呼ぶので、ツールを出していなくても classifier に選んだ送り先があればそれを使う
  on('command.run', { command: 'decide' }, async ($, e) => {
    const input = parseDecideArgs(e.args)
    if (typeof input === 'string') return { text: input }

    const backend = decideBackend !== 'off' ? decideBackend : classifier === 'haiku' ? 'off' : classifier
    const outcome = await runDecide($, backend, endpoints, input)
    if ('deny' in outcome) return { text: `decide: ${outcome.deny}` }

    const { backend: used, model, ...rest } = outcome.payload
    return { text: `${used}${model === undefined ? '' : ` (${model})`}\n${JSON.stringify(rest, null, 2)}` }
  })

  // 判断を Jev / Laya に任せ、答えを JSON でモデルに返す。失敗はエラー結果としてモデルに伝える。
  // 送り先は設定で有効にしたものだけ。モデルが Jev（外部）へ切り替えることはできない
  on('tool.call', { tool: DECIDE_TOOL }, async ($, e) => {
    const outcome = await runDecide($, decideBackend, endpoints, e as unknown as Record<string, unknown>)
    return 'deny' in outcome ? outcome : { result: JSON.stringify(outcome.payload) }
  }).catch(() => ({ deny: 'decide に失敗しました' }))
}
