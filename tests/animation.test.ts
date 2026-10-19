import { expect, test } from 'claude-code/testing'

import { ANIMATIONS, FRAME_MS, LANE, animationOf, lane, pick } from '../hooks/animation'

test('アニメーションは幅が常に一定で、フレームごとに動く', () => {
  for (const animation of ANIMATIONS) {
    const seen = new Set<string>()
    for (let i = 0; i < 80; i++) {
      const frame = lane(animation, i * FRAME_MS)
      expect(frame.length).toBe(LANE + 2)
      seen.add(frame)
    }
    expect(seen.size).toBeGreaterThan(3)
  }
})

test('アニメーションは道を抜けて繰り返し、off は何も出さない', () => {
  const frames = Array.from({ length: 80 }, (_, i) => lane('cat', i * FRAME_MS))
  expect(frames.some(frame => frame.includes('='))).toBe(true)
  expect(frames.some(frame => frame === `|${' '.repeat(LANE)}|`)).toBe(true)
  expect(lane('off', 0)).toBe('')
})

test('不明なアニメーションは off にする', () => {
  expect(animationOf('cat')).toBe('cat')
  expect(animationOf('unknown')).toBe('off')
})

test('random は乱数で動くもののどれかを選ぶ', () => {
  expect(pick(() => 0)).toBe(ANIMATIONS[0])
  expect(pick(() => 0.999)).toBe(ANIMATIONS[ANIMATIONS.length - 1])
  expect(new Set(ANIMATIONS.map((_, i) => pick(() => i / ANIMATIONS.length))).size).toBe(ANIMATIONS.length)
  expect(animationOf('random')).toBe('random')
})

test('shades は顔にサングラスをかける（その場で動かない）', () => {
  const frames = Array.from({ length: 11 }, (_, i) => lane('shades', i * FRAME_MS))
  expect(frames[0]).toContain('(o_o)')
  expect(frames.some(frame => frame.includes('(⌐■_■)'))).toBe(true)
  expect(frames.every(frame => frame.indexOf('(') === 3)).toBe(true)
})

test('think は考え込んで閃き、解決する（その場で動かない）', () => {
  const frames = Array.from({ length: 11 }, (_, i) => lane('think', i * FRAME_MS))
  expect(frames[0]).toContain('(-_-)')
  expect(frames.some(frame => frame.includes('.oO(?)'))).toBe(true)
  expect(frames.some(frame => frame.includes('.oO(!)'))).toBe(true)
  expect(frames.some(frame => frame.includes('(^o^)/'))).toBe(true)
  expect(frames.every(frame => frame.indexOf('(') === 2)).toBe(true)
  // 1 周したら考え込むところへ戻る
  expect(lane('think', 11 * FRAME_MS)).toBe(frames[0])
})

test('sleep は寝息の Z が増えて、うなされ、また寝る（その場で動かない）', () => {
  const frames = Array.from({ length: 8 }, (_, i) => lane('sleep', i * FRAME_MS))
  expect(frames[0]).toContain('(-_-)')
  expect(frames.some(frame => frame.includes('zZZ'))).toBe(true)
  expect(frames.some(frame => frame.includes('(u_u)'))).toBe(true)
  expect(frames.every(frame => frame.indexOf('(') === 2)).toBe(true)
  expect(lane('sleep', 8 * FRAME_MS)).toBe(frames[0])
})

test('wave はキラキラしながら顔が左右に揺れ、1 周で最初に戻る', () => {
  const frames = Array.from({ length: 4 }, (_, i) => lane('wave', i * FRAME_MS))
  expect(frames.every(frame => frame.includes('(^o^)'))).toBe(true)
  expect(frames.every(frame => frame.includes('*') && frame.includes('+'))).toBe(true)
  expect(new Set(frames.map(frame => frame.indexOf('(')))).toEqual(new Set([3, 4, 5]))
  expect(new Set(frames).size).toBe(4)
  expect(lane('wave', 4 * FRAME_MS)).toBe(frames[0])
})

test('pacman はドットを食べながら進み、後ろからおばけが追う', () => {
  const frames = Array.from({ length: LANE + 3 }, (_, i) => lane('pacman', i * FRAME_MS))
  for (const frame of frames) {
    const at = frame.search(/[Cc]/)
    if (at === -1) continue
    // 前にはドットが残り、後ろは食べ尽くしている
    expect(frame.slice(1, at).includes('.')).toBe(false)
    if (at < LANE - 1) expect(frame.slice(at + 1).includes('.')).toBe(true)
  }
  // 口を開け閉めしながら右へ進む
  expect(frames.map(frame => frame.search(/[Cc]/)).slice(0, LANE)).toEqual(Array.from({ length: LANE }, (_, i) => i + 1))
  expect(frames.some(frame => frame.includes('C')) && frames.some(frame => frame.includes('c'))).toBe(true)
  // おばけは 3 マス後ろ
  expect(frames[5]?.indexOf('M')).toBe(frames[5]!.search(/[Cc]/) - 3)
  // おばけが抜けたら、ドットを並べ直して最初から
  expect(lane('pacman', (LANE + 3) * FRAME_MS)).toBe(frames[0])
})

test('loading は 10〜99% を行き来し、0% にも 100% にもならない', () => {
  const percents = Array.from({ length: 36 }, (_, i) => Number(/(\d+)%/.exec(lane('loading', i * FRAME_MS))?.[1]))
  expect(Math.max(...percents)).toBe(99)
  expect(Math.min(...percents)).toBe(10)
  // 周期は 18 コマで、次の周も途切れずに続く
  expect(percents.slice(18)).toEqual(percents.slice(0, 18))
  // 折り返しで同じ値が続かない
  expect(percents.every((value, i) => value !== percents[i + 1])).toBe(true)
})
