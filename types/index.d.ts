export type Weight = 'simple' | 'standard' | 'complex'

/** auto: 毎回分類する / off: 何もしない / Weight: そのティアに固定 */
export type Mode = 'auto' | 'off' | Weight

export type Route = { tier: Weight; model: string; isForced: boolean }

/** 判断を任せる System-1 決定モデル。laya: ローカルの laya-serve / jev: TypeSafe のホスト API */
export type Backend = 'laya' | 'jev'

declare module 'claude-code' {
  interface PluginState {
    'shiotomo-mod': { mode: Mode; route: Route | null; modelTier: Weight | null; messageCount: number }
  }
}
