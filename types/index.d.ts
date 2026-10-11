export type Weight = 'simple' | 'standard' | 'complex'

/** auto: 毎回分類する / off: 何もしない / Weight: そのティアに固定 */
export type Mode = 'auto' | 'off' | Weight

export type Route = { tier: Weight; model: string; isForced: boolean }

declare module 'claude-code' {
  interface PluginState {
    'model-router': { mode: Mode; route: Route | null; modelTier: Weight | null }
  }
}
