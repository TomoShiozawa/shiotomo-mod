// アニメーションをコンソールで確かめる。claude を起動しなくても見た目と速さが分かる。
//
//   node scripts/preview-animation.ts            # すべての種類を同時に動かす（Ctrl+C で終了）
//   node scripts/preview-animation.ts cat        # 1 種類だけ
//   node scripts/preview-animation.ts all --frames 40   # 動かさず、40 コマぶん順に印字する（端末でなくても使える）
import { ANIMATIONS, FRAME_MS, animationOf, lane } from '../hooks/animation.ts'
import type { Playing } from '../hooks/animation.ts'

const args = process.argv.slice(2)
const framesAt = args.indexOf('--frames')
const frames = framesAt === -1 ? undefined : Number(args[framesAt + 1])
const target = args.find(arg => !arg.startsWith('--') && arg !== String(frames)) ?? 'all'

if (frames !== undefined && !(Number.isInteger(frames) && frames > 0)) {
  console.error('--frames には 1 以上の整数を渡してください')
  process.exit(1)
}
if (target !== 'all' && animationOf(target) !== target) {
  console.error(`不明な種類: ${target}（all / ${['random', ...ANIMATIONS].join(' / ')}）`)
  process.exit(1)
}

// random は種類を 1 つ選んで見せる（claude では依頼ごとに選び直す）
const pickOne = (): Playing => ANIMATIONS[Math.floor(Math.random() * ANIMATIONS.length)] ?? 'cat'
const styles: readonly Playing[] =
  target === 'all' ? ANIMATIONS : target === 'random' ? [pickOne()] : [target as Playing]
const width = Math.max(...styles.map(style => style.length))

// スピナーに付く文は固定。claude では `Sauteing… (12s, 300 tokens)` のように続く
const line = (style: Playing, tick: number) => `${style.padEnd(width)}  ${lane(style, tick * FRAME_MS)} Sauteing… (12s, 300 tokens)`

if (frames !== undefined) {
  for (let tick = 0; tick < frames; tick++) {
    console.log(`#${String(tick).padStart(3)}`)
    for (const style of styles) console.log(line(style, tick))
  }
  process.exit(0)
}

if (!process.stdout.isTTY) {
  console.error('端末ではないので動かせません。--frames N を付けると、コマを順に印字します。')
  process.exit(1)
}

process.stdout.write('\x1b[?25l') // カーソルを隠す
const restore = () => process.stdout.write('\x1b[?25h\n')
process.on('SIGINT', () => {
  restore()
  process.exit(0)
})

console.log(`${styles.length} 種類を ${FRAME_MS}ms ごとに動かしています。Ctrl+C で終了。\n`)
for (const _ of styles) console.log()
let tick = 0
setInterval(() => {
  // 描画した行数ぶん戻って上書きする
  process.stdout.write(`\x1b[${styles.length}A`)
  for (const style of styles) process.stdout.write(`\x1b[2K${line(style, tick)}\n`)
  tick += 1
}, FRAME_MS)
