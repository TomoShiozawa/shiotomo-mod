// 実際に動くもの。random は依頼ごとにこの中から選ぶ
export const ANIMATIONS = ['cat', 'rocket', 'shades', 'loading', 'think', 'sleep', 'wave', 'pacman'] as const
export type Playing = (typeof ANIMATIONS)[number]
export type Animation = 'off' | 'random' | Playing

// アニメーションの 1 コマの長さ。これより短くすると再描画が増えるだけ
export const FRAME_MS = 250
// 走る道の幅（セル数）。幅を固定にして、後ろに続く文が動かないようにする
export const LANE = 14

// 進捗バーが 10% から 99% まで進み、また 10% まで戻る。0% に戻して仕切り直すことはしない。
// 8 マスのバーと割合で、ちょうど道の幅になる
const loadingFrames = (): string[] => {
  const bar = (percent: number) =>
    `[${'#'.repeat(Math.floor((percent * 8) / 100))}${'.'.repeat(8 - Math.floor((percent * 8) / 100))}] ${`${percent}%`.padStart(3)}`
  const up = [10, 20, 30, 40, 50, 60, 70, 80, 90, 99]
  // 99 と 10 は 1 度ずつ。折り返しで同じ値を 2 コマ続けない
  return [...up, ...up.slice(1, -1).reverse()].map(bar)
}

// パックマンがドットを食べながら右へ進み、3 マス後ろをおばけが追う。おばけが道を抜けたら、ドットを並べ直して最初から
const pacmanFrames = (): string[] => {
  const GHOST_GAP = 3
  return Array.from({ length: LANE + GHOST_GAP }, (_, at) =>
    Array.from({ length: LANE }, (_, i) => {
      if (i === at) return at % 2 === 0 ? 'C' : 'c'
      if (i === at - GHOST_GAP) return 'M'
      return i > at && i % 2 === 0 ? '.' : ' '
    }).join(''),
  )
}

// run: frames を交互に切り替えながら、dir の向き（-1: 右から左、1: 左から右）へ 1 コマ speed セルずつ走る（1 未満なら数コマに 1 セル）。
// scene: 道の at セル目（既定 2）から、frames を順に 1 コマずつ見せる（動かない）。shades の `■` 以外は ASCII（1 文字 1 セル）。`■` は端末によって 2 セルで描かれ、後ろの文が 1〜2 セル右にずれる
type Sprite =
  | { kind: 'run'; frames: readonly string[]; dir: -1 | 1; speed: number }
  | { kind: 'scene'; frames: readonly string[]; at?: number }

const SPRITES: Record<Playing, Sprite> = {
  cat: { kind: 'run', frames: ['=^.^=', '=^-^='], dir: 1, speed: 1 },
  rocket: { kind: 'run', frames: ['~=>', '-=>', '*=>'], dir: 1, speed: 1 },
  // サングラスが飛んできて、かけて、決める
  shades: {
    kind: 'scene',
    frames: [
      '(o_o)',
      '(o_o)',
      '(o_o)  ⌐■-■',
      '(o_o) ⌐■-■',
      '(o_o)⌐■-■',
      '(⌐■_■)',
      '(⌐■_■)',
      '(⌐■_■)',
      '(⌐■_■)>',
      '(⌐■_■)b',
      '(⌐■_■)b',
      '(⌐■_■)b',
    ],
  },
  loading: { kind: 'scene', frames: loadingFrames(), at: 0 },
  pacman: { kind: 'scene', frames: pacmanFrames(), at: 0 },
  // 考え込んで、閃いて、解決する。最後のコマからまた考え込むので、繰り返しても途切れない
  think: {
    kind: 'scene',
    frames: [
      '(-_-)',
      '(-_-) .',
      '(-_-) .o',
      '(-_-) .oO',
      '(-_-) .oO(?)',
      '(-_-) .oO(?)',
      '(-_-) .oO(?)',
      '(o_o) .oO(!)',
      '(o_o) .oO(!)',
      '(^o^)/',
      '(^o^)/',
    ],
    at: 1,
  },
  // 寝息の Z が増えて、うなされて、また寝る
  sleep: {
    kind: 'scene',
    frames: ['(-_-)', '(-_-) z', '(-_-) zZ', '(-_-) zZZ', '(u_u) zZZ', '(u_u) zZZ', '(-_-) zZZ', '(-_-) zZ'],
    at: 1,
  },
  // キラキラを散らしながら、顔が左右に揺れる（1 → 2 → 3 → 2 マス目へ戻る）
  wave: {
    kind: 'scene',
    frames: ['*(^o^)+', ' +(^o^)*', '  *(^o^)+', ' *(^o^)+'],
    at: 1,
  },
}

const isAnimation = (value: unknown): value is Animation =>
  value === 'off' || value === 'random' || ANIMATIONS.includes(value as Playing)

export const animationOf = (value: unknown): Animation => (isAnimation(value) ? value : 'off')

/** 動くもののうちどれか 1 つ。`random` は 0 以上 1 未満の乱数を返す関数（テストで差し替える） */
export const pick = (random: () => number): Playing =>
  ANIMATIONS[Math.min(Math.floor(random() * ANIMATIONS.length), ANIMATIONS.length - 1)] ?? 'cat'

/** 時刻 `now`（ms）の 1 コマ。常に LANE + 2 文字（両端の `|` を含む）。`off` は空文字 */
export function lane(animation: Playing | 'off', now: number): string {
  if (animation === 'off') return ''
  const sprite = SPRITES[animation]
  const tick = Math.floor(now / FRAME_MS)
  const cells = Array.from({ length: LANE }, () => ' ')
  const put = (text: string, start: number) => {
    for (let i = 0; i < text.length; i++) {
      const at = start + i
      if (at >= 0 && at < LANE) cells[at] = text[i] ?? ' '
    }
  }

  if (sprite.kind === 'scene') {
    put(sprite.frames[tick % sprite.frames.length] ?? '', sprite.at ?? 2)
    return `|${cells.join('')}|`
  }

  const text = sprite.frames[tick % sprite.frames.length] ?? ''
  // 道の外から入って反対側の外へ抜ける。1 周は LANE + 絵の長さ
  // speed が割り切れなくても、周の頭では必ず道の外から入り直す
  const step = Math.floor((tick % Math.ceil((LANE + text.length) / sprite.speed)) * sprite.speed)
  put(text, sprite.dir === 1 ? step - text.length : LANE - step)
  return `|${cells.join('')}|`
}
