import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, SessionRateLimit } from 'claude-code'

import type { AutoCompact, Category, Hold, Limit, PaceOf, Snapshot } from '../types'

const snapshot = atom({ plugin: 'hud', key: 'snapshot' } as const, null)
const isOn = atom({ plugin: 'hud', key: 'isOn' } as const, true)
const isExpanded = atom({ plugin: 'hud', key: 'isExpanded' } as const, false)
const autoCompact = atom({ plugin: 'hud', key: 'autoCompact' } as const, { isOn: false, at: null } as AutoCompact)
const fieldTick = atom({ plugin: 'hud', key: 'fieldTick' } as const, 0)
// the % field's text while typing is cleaned (digits only, 3 at most); null: the set %
const fieldText = atom({ plugin: 'hud', key: 'fieldText' } as const, null as string | null)
const theme = atom({ plugin: 'hud', key: 'theme' } as const, 'dark' as 'dark' | 'light')
const autoAsk = atom({ plugin: 'hud', key: 'autoAsk' } as const, null as { at: number; percent: number } | null)
// what holds auto compact back, and in which chat: kept in state so a reload (an
// update, /reload-plugins) keeps it, where a module variable would start over
const hold = atom({ plugin: 'hud', key: 'hold' } as const, { chat: '', waits: false, stuck: false } as Hold)

// two palettes, the desktop's dark and light themes; the band draws in the one the
// app shows (Theme), set at the start of every draw so all colours below follow it
type Palette = {
  muted: string; green: string; greenText: string; amber: string; red: string; free: string; buffer: string; track: string
  palette: string[]; named: Record<string, string>; switchOff: string; switchOn: string; switchLit: string; compactLit: string
}
const DARK: Palette = {
  muted: '#8b90a0', green: '#4ade80', greenText: '#4ade80', amber: '#fbbf24', red: '#f87171',
  free: '#2d3140', buffer: '#4b5163', track: '#2d3140',
  palette: ['#a78bfa', '#60a5fa', '#f472b6', '#34d399', '#fbbf24', '#fb923c', '#22d3ee', '#c084fc'],
  named: {
    Tools: '#a78bfa', Other: '#8b90a0', 'System prompt': '#a78bfa', 'System tools': '#60a5fa', 'MCP tools': '#f472b6',
    'Custom agents': '#34d399', 'Memory files': '#fbbf24', Skills: '#fb923c', Messages: '#22d3ee',
  },
  switchOff: '#4b5163', switchOn: '#4ade80', switchLit: '#8b919c', compactLit: '#5a606e',
}
// light: the same hues, deep enough to read on the pale band; the tracks pale
const LIGHT: Palette = {
  muted: '#5b6070', green: '#22b856', greenText: '#16a34a', amber: '#ea8a0c', red: '#ef4444',
  free: '#ffffff', buffer: '#b9bec9', track: '#ffffff',
  palette: ['#8b5cf6', '#3b82f6', '#ec4899', '#10b981', '#f59e0b', '#f97316', '#0ea5e9', '#a855f7'],
  named: {
    Tools: '#8b5cf6', Other: '#5b6070', 'System prompt': '#8b5cf6', 'System tools': '#3b82f6', 'MCP tools': '#ec4899',
    'Custom agents': '#10b981', 'Memory files': '#f59e0b', Skills: '#f97316', Messages: '#0ea5e9',
  },
  switchOff: '#b4b9c4', switchOn: '#22c55e', switchLit: '#c3c7cf', compactLit: '#d6d9df',
}
let MUTED = DARK.muted
let GREEN = DARK.green
let GREEN_TEXT = DARK.greenText
let AMBER = DARK.amber
let RED = DARK.red
let FREE = DARK.free
let BUFFER = DARK.buffer
let TRACK = DARK.track
let PALETTE = DARK.palette
let NAMED = DARK.named
let SWITCH_OFF = DARK.switchOff
let SWITCH_ON = DARK.switchOn
// the light behind the switch under the pointer: drawn beneath the pill, never over it
let SWITCH_LIT = DARK.switchLit
// Compact's hover: clearly lighter than its resting chrome, its label still reads
let COMPACT_LIT = DARK.compactLit
function usePalette(p: Palette): void {
  ;({ muted: MUTED, green: GREEN, greenText: GREEN_TEXT, amber: AMBER, red: RED, free: FREE, buffer: BUFFER, track: TRACK } = p)
  ;({ palette: PALETTE, named: NAMED, switchOff: SWITCH_OFF, switchOn: SWITCH_ON, switchLit: SWITCH_LIT, compactLit: COMPACT_LIT } = p)
}
const CELLS = 16
const HOUR = 3_600_000
const WINDOWS: Record<string, { label: string; ms: number }> = {
  five_hour: { label: '5 Hour', ms: 5 * HOUR },
  seven_day: { label: 'Weekly', ms: 7 * 24 * HOUR },
}

// 5 hour on the left, Weekly on the right
const order = (kind: string) => (kind === 'five_hour' ? 0 : 1)

type Forecast = {
  kind: string
  label: string
  percent: number
  resetsAt: number
  /** 'idle': no window running (unused, or reset): 0% until the next message starts one */
  status: 'hit' | 'ok' | 'out' | 'idle'
  projected: number
  runOutAt: number
  color: string
}

// The pace a window is forecast at: your usual one (the median of how far your past
// windows got) blended with this window's own, which takes over as the window runs: it
// counts for half a quarter of the way in. Early jumps barely move it. `skip`: the %
// the first reply of a reopened chat took re-reading its old context, a one-off left
// out of the pace (still in the % used).
const TYPICAL_DEFAULT = 50
const TRUST = 0.25
const FINALS_KEPT = 8
// one window's reset time as two readings give it: a few minutes apart at most
const SAME_WINDOW_MS = 10 * 60_000

function forecast(limit: Limit, now: number, pace?: PaceOf): Forecast | null {
  const win = WINDOWS[limit.kind]
  const resetsAt = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN
  if (!win) return null
  const p = limit.percentUsed
  // no reset time, or one already passed: the window is not running, so it is at 0
  if (!Number.isFinite(resetsAt) || resetsAt <= now) {
    return { kind: limit.kind, label: win.label, percent: 0, resetsAt: NaN, status: 'idle', projected: 0, runOutAt: Infinity, color: GREEN }
  }
  const remaining = Math.max(0, resetsAt - now)
  const elapsed = Math.max(1, win.ms - remaining)
  const base = { kind: limit.kind, label: win.label, percent: p, resetsAt }
  if (p >= 100) return { ...base, status: 'hit', projected: p, runOutAt: now, color: RED }
  const typical = pace?.typical ?? TYPICAL_DEFAULT
  const own = Math.max(0, p - (pace?.skip ?? 0)) / elapsed
  const weight = elapsed / (elapsed + win.ms * TRUST)
  const rate = weight * own + (1 - weight) * (typical / win.ms)
  const projected = p + rate * remaining
  if (projected < 100 || rate <= 0) {
    return { ...base, status: 'ok', projected, runOutAt: Infinity, color: worse(GREEN, usedColor(p)) }
  }
  return {
    ...base,
    status: 'out',
    projected,
    runOutAt: now + (100 - p) / rate,
    color: worse(projected > 130 ? RED : AMBER, usedColor(p)),
  }
}

// A limit's colour by what is used, as the band shows it (rounded): amber from 75%,
// red from 90%. The bar and its % take the worse of this and the forecast's.
const LIMIT_AMBER_AT = 75
const LIMIT_RED_AT = 90
function usedColor(p: number): string {
  const shown = Math.round(p)
  return shown >= LIMIT_RED_AT ? RED : shown >= LIMIT_AMBER_AT ? AMBER : GREEN
}
function worse(a: string, b: string): string {
  const rank = (c: string) => (c === RED ? 2 : c === AMBER ? 1 : 0)
  return rank(b) > rank(a) ? b : a
}

function duration(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  const d = Math.floor(m / 1440)
  const hours = Math.floor((m % 1440) / 60)
  const min = m % 60
  if (d > 0) return hours > 0 ? `${d}d ${hours}h` : `${d}d`
  if (hours > 0) return min > 0 ? `${hours}h ${min}m` : `${hours}h`
  return `${min}m`
}

const time = (t: number) =>
  new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
const weekday = (t: number) => new Date(t).toLocaleDateString('en-US', { weekday: 'long' })
const shortDay = (t: number) => new Date(t).toLocaleDateString('en-US', { weekday: 'short' })
const isSameDay = (a: number, b: number) =>
  new Date(a).toLocaleDateString('en-US') === new Date(b).toLocaleDateString('en-US')

// "the 8:40 PM reset" today, "Wednesday's reset" otherwise
// the reset by its time when it is under a day away (an after-midnight one included),
// else by its weekday: a time that far off would only lengthen the headline
function resetName(t: number, now: number): string {
  return t - now < 24 * 3_600_000 ? `the ${time(t)} reset` : `${weekday(t)}'s reset`
}

function headline(list: Forecast[], now: number): { text: string; color: string } | null {
  const hit = list.find(f => f.status === 'hit')
  if (hit) {
    const at = isSameDay(hit.resetsAt, now) ? time(hit.resetsAt) : `${weekday(hit.resetsAt)} ${time(hit.resetsAt)}`
    return { text: `Limit reached. Usage resumes at ${at}.`, color: RED }
  }
  const out = list.filter(f => f.status === 'out').sort((a, b) => a.runOutAt - b.runOutAt)[0]
  if (out) {
    return { text: `At this pace you'll run out before ${resetName(out.resetsAt, now)}.`, color: out.color }
  }
  const lead = list.find(f => f.kind === 'seven_day' && f.status !== 'idle') ?? list.find(f => f.status !== 'idle')
  if (!lead) return null
  return {
    text: `On track. You should reach ${resetName(lead.resetsAt, now)} with room to spare.`,
    color: GREEN,
  }
}

function tokens(n: number): string {
  // 1M, not 1.0M; 1.5M keeps its decimal
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return `${Math.round(n)}`
}

// Context by what it holds, as shown (rounded): amber from 50% (a long context costs
// more on every reply: compacting pays), red from 80%
const CONTEXT_AMBER_AT = 50
const CONTEXT_RED_AT = 80
function fillColor(percent: number): string {
  const shown = Math.round(percent)
  if (shown >= CONTEXT_RED_AT) return RED
  if (shown >= CONTEXT_AMBER_AT) return AMBER
  return GREEN
}

// text in green, which on the light band needs a deeper green than the bars to read
function ink(color: string): string {
  return color === GREEN ? GREEN_TEXT : color
}

function colorOf(category: Category, index: number): string {
  if (category.kind === 'free') return FREE
  if (category.kind === 'buffer') return BUFFER
  return NAMED[category.name] ?? PALETTE[index % PALETTE.length]!
}

type Segment = { color: string; share: number }

const BAR_PX = 5

// a space a wrap never breaks at
const NB = '\u00a0'

// a % as a small gauge with the figure inside. A limit's is a battery, the way the
// Mac's menu bar draws one (an outline with a nub); the context's a plain capsule, so
// the two read apart. The figure reads dark over the fill and in the band's text
// colour past it: drawn light, the fill laid over it, then drawn dark inside a nested
// svg as wide as the fill (a nested svg clips to itself on every renderer).
const GAUGE_W = 30
const GAUGE_H = 14
function gaugeSvg(percent: number, color: string, isLight: boolean, isBattery: boolean): string {
  const p = Math.max(0, Math.min(100, Math.round(percent)))
  // the outline's width, its corner, and the room inside it for the fill
  const body = isBattery ? 25.5 : 28.5
  const rx = isBattery ? 3.6 : 6.25
  const room = body - 3.5
  const fill = p === 0 ? 0 : Math.max(1.5, (room * p) / 100)
  const mid = 0.75 + body / 2
  const label = (ink: string) =>
    `<text x="${mid}" y="10.4" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,'SF Pro Text',system-ui,sans-serif" font-size="8.6" font-weight="700" fill="${ink}">${p}</text>`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${GAUGE_W}" height="${GAUGE_H}" viewBox="0 0 ${GAUGE_W} ${GAUGE_H}">` +
    `<rect x="0.75" y="0.75" width="${body}" height="12.5" rx="${rx}" fill="none" stroke="${MUTED}" stroke-opacity="0.75" stroke-width="1.2"/>` +
    (isBattery ? `<rect x="27.4" y="4.6" width="1.9" height="4.8" rx="0.9" fill="${MUTED}" fill-opacity="0.75"/>` : '') +
    label(isLight ? '#1f2329' : '#eceef3') +
    (fill > 0
      ? `<rect x="2.5" y="2.5" width="${fill.toFixed(2)}" height="9" rx="${isBattery ? 2 : 4.5}" fill="${color}"/>` +
        `<svg x="0" y="0" width="${(2.5 + fill).toFixed(2)}" height="${GAUGE_H}" overflow="hidden">${label('#111318')}</svg>`
      : '') +
    `</svg>`
  )
}

// a thin rounded bar for surfaces that draw Svg: segments laid out over 0..1000,
// with an optional grey tick, the bar's own height, at `marker` percent (the forecast at reset)
function barSvg(segments: Segment[], width: number, marker?: number, extra?: { at: number; color: string }): string {
  // drawn at its real size (no stretching), so every end stays round: a capsule
  // track, the used runs laid over it from the left, each its own capsule with a
  // hairline gap between, as the Mac's storage bar draws them. Free space and the
  // limits' track are left as the track.
  const h = BAR_PX
  const r = h / 2
  const isLight = MUTED === LIGHT.muted
  const track = isLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.10)'
  const total = segments.reduce((sum, s) => sum + s.share, 0) || 1
  const GAP = 1.5
  let x = 0
  const runs: string[] = []
  for (const s of segments) {
    const w = (s.share / total) * width
    const isEmpty = s.color === TRACK || s.color === FREE
    if (!isEmpty && w > 0.5) {
      const drawn = Math.max(h * 0.6, w - GAP)
      runs.push(`<rect x="${x.toFixed(2)}" y="0" width="${Math.min(drawn, width - x).toFixed(2)}" height="${h}" rx="${r}" fill="${s.color}"/>`)
    }
    x += w
  }
  // the forecast at reset: a slim rounded notch across the bar
  const TICK = 2
  const tick =
    marker === undefined
      ? ''
      : `<rect x="${Math.min(width - TICK, Math.max(0, (marker / 100) * width - TICK / 2)).toFixed(2)}" y="0" width="${TICK}" height="${h}" rx="1" fill="${MUTED}"/>`
  // a second notch in its own colour: where auto compact is set to run
  const mark =
    extra === undefined
      ? ''
      : `<rect x="${Math.min(width - TICK, Math.max(0, (extra.at / 100) * width - TICK / 2)).toFixed(2)}" y="0" width="${TICK}" height="${h}" rx="1" fill="${extra.color}"/>`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}">` +
    `<rect x="0" y="0" width="${width}" height="${h}" rx="${r}" fill="${track}"/>` +
    runs.join('') +
    tick +
    mark +
    `</svg>`
  )
}

// the forecast tick's percent, or none when there is nothing ahead to mark
function markerOf(f: Forecast): number | undefined {
  if (f.status === 'hit' || f.status === 'idle') return undefined
  const at = Math.min(100, f.projected)
  return at - f.percent >= 1 ? at : undefined
}

// the terminal's bar: one colour per cell, runs of a colour merged into one Box
function cellRuns(f: Forecast, cells: number): { color: string; width: number }[] {
  const filled = Math.max(0, Math.min(cells, Math.round((f.percent / 100) * cells)))
  const marker = markerOf(f)
  const tick = marker === undefined ? -1 : Math.max(filled, Math.min(cells - 1, Math.round((marker / 100) * cells) - 1))
  const runs: { color: string; width: number }[] = []
  for (let i = 0; i < cells; i++) {
    const color = i < filled ? f.color : i === tick ? MUTED : TRACK
    const last = runs[runs.length - 1]
    if (last && last.color === color) last.width += 1
    else runs.push({ color, width: 1 })
  }
  return runs
}

// No network: the limits come only from the figures each reply from Claude carries,
// which Claude Code already holds. 'due' and 'now' are kept for the callers and
// read the same as 'no'.
type Ask = 'no' | 'due' | 'now'
// how often the band re-reads what Claude Code already holds (no request)
const LOCAL_EVERY_MS = 3_000

type Saved = { at: number; limits: Limit[] }

// this chat's own reading from its replies, and when it last changed
let live: Saved | undefined

async function storeGet($: EngineInterface, key: string): Promise<unknown> {
  try {
    return await $.store.get(key)
  } catch {
    return undefined
  }
}

async function storeSet($: EngineInterface, key: string, value: unknown): Promise<void> {
  try {
    await $.store.set(key, value)
  } catch {
    // this chat still has it
  }
}

// One source: the figures each reply from Claude carries (this chat's, stamped when
// they last changed), shared with every chat through the store so a chat with no reply
// yet still shows the newest any chat saw. A window that has reset since stays, at 0.
async function limitsOf(
  $: EngineInterface,
  rateLimits: SessionRateLimit[],
  now: number,
  _ask: Ask,
): Promise<{ limits: Limit[]; at?: number; error?: string }> {
  if (rateLimits.length > 0) {
    const limits = rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt }))
    if (!live || JSON.stringify(live.limits) !== JSON.stringify(limits)) live = { at: now, limits }
  }
  const saved = (await storeGet($, 'limits')) as Saved | undefined
  const pick = [saved, live]
    .filter((r): r is Saved => r !== undefined)
    .sort((x, y) => y.at - x.at)[0]
  // newer reply figures go to the store too, so other chats get them
  if (pick && pick === live && (!saved || live.at > saved.at)) await storeSet($, 'limits', live)
  // a window that has reset since stays, at 0: the forecast reads it as not running
  const limits = (pick?.limits ?? []).map(l =>
    l.resetsAt !== undefined && Date.parse(l.resetsAt) <= now ? { kind: l.kind, percentUsed: 0 } : l,
  )
  return { limits, at: pick?.at }
}

// What the forecast learns, shared by every chat through the store: how far each past
// window got (its peak, the last few kept), and the running one's peak and skipped %.
type PaceWindow = { resetsAt: number; peak: number; skip: number }
type PaceStore = { finals: Record<string, number[]>; windows: Record<string, PaceWindow> }

// A chat reopened with a long history re-reads it all on its first reply: one big jump
// in usage. Its first turn notes the limits it started from; the first new reading
// that moved is that jump, and is left out of the pace. Only for a chat that opened
// with this much already in it (a new chat's first reply is real work).
const RESUME_MIN_TOKENS = 20_000
let isOpening = true
let openMessages = 0
let spikeFrom: { at: number; limits: Limit[] } | undefined

function median(list: number[] | undefined): number | undefined {
  if (!list || list.length === 0) return undefined
  const s = [...list].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

const sameWindow = (a: string | undefined, b: string | undefined) =>
  a !== undefined && b !== undefined && Math.abs(Date.parse(a) - Date.parse(b)) <= SAME_WINDOW_MS

// the jump the reopened chat's first reply made, once a reading after it has moved
function takeSpike(): Record<string, number> | undefined {
  if (!spikeFrom || !live || live.at <= spikeFrom.at) return undefined
  const jump: Record<string, number> = {}
  for (const l of live.limits) {
    const before = spikeFrom.limits.find(b => b.kind === l.kind)
    if (before && sameWindow(before.resetsAt, l.resetsAt) && l.percentUsed > before.percentUsed) {
      jump[l.kind] = l.percentUsed - before.percentUsed
    }
  }
  if (Object.keys(jump).length === 0) return undefined
  spikeFrom = undefined
  return jump
}

async function trackPace($: EngineInterface, limits: Limit[], now: number): Promise<Record<string, PaceOf>> {
  const spike = takeSpike()
  const saved = ((await storeGet($, 'pace')) as PaceStore | undefined) ?? { finals: {}, windows: {} }
  let isChanged = false
  const pace: Record<string, PaceOf> = {}
  for (const l of limits) {
    const resetsAt = l.resetsAt ? Date.parse(l.resetsAt) : NaN
    if (!WINDOWS[l.kind] || !Number.isFinite(resetsAt) || resetsAt <= now) continue
    let w = saved.windows[l.kind]
    if (!w || Math.abs(w.resetsAt - resetsAt) > SAME_WINDOW_MS) {
      // a new window: the last one's peak is how far it got
      if (w && w.peak > 0) saved.finals[l.kind] = [...(saved.finals[l.kind] ?? []), w.peak].slice(-FINALS_KEPT)
      w = { resetsAt, peak: l.percentUsed, skip: 0 }
      saved.windows[l.kind] = w
      isChanged = true
    } else if (l.percentUsed > w.peak) {
      w.peak = l.percentUsed
      isChanged = true
    }
    const jump = spike?.[l.kind]
    if (jump) {
      w.skip = Math.min(w.peak, w.skip + jump)
      isChanged = true
    }
    pace[l.kind] = { typical: median(saved.finals[l.kind]) ?? TYPICAL_DEFAULT, skip: w.skip }
  }
  if (isChanged) await storeSet($, 'pace', saved)
  return pace
}

// The window is shown as three groups: Messages, Tools (System + MCP tools) and Other
// (the system prompt, skills, memory files, agents, MCP server instructions).
const TOOL_NAMES = new Set(['System tools', 'MCP tools'])
type Group = 'Messages' | 'Tools' | 'Other'
const groupOf = (name: string): Group => (name === 'Messages' ? 'Messages' : TOOL_NAMES.has(name) ? 'Tools' : 'Other')

// The context breakdown comes from the free local estimate ('summary') alone: the
// exact count ('full') sends token-count requests, so it is left out. Messages is
// still the API's real input total less Tools and Other whenever a reply has one.
function sumGroups(categories: readonly { name: string; tokens: number; kind: string }[]): Record<Group, number> {
  const sums: Record<Group, number> = { Messages: 0, Tools: 0, Other: 0 }
  for (const c of categories) if (c.kind === 'used') sums[groupOf(c.name)] += c.tokens
  return sums
}

// Auto compact fires whenever the chat is idle (no turn running) and the context
// is at or past the %: at the end of a turn, on opening a chat, on any refresh between
// turns. Held back only by: `waits` (the band is asking, or the person chose
// "after my next compact", which is also what an unanswered ask means: cleared only by
// a real compaction, never by the % flickering below), `stuck` (a compaction already ran and
// the context is still past the %: it would only repeat; dropping below clears it).
// The % is compared as the band shows it, rounded.
// a reply has been seen since the chat opened or was last compacted
let hadReply = false
async function setHold($: EngineInterface, patch: Partial<Hold>): Promise<void> {
  await update($, hold, held => ({ ...held, ...patch }))
}
let isBusy = false
let isCompacting = false
let lastPercent = 0

function compactNow($: EngineInterface): void {
  if (isCompacting) return
  isCompacting = true
  // compacting takes longer than a press or a hook may run, so a timer starts it
  $.clock.after(0, async () => {
    try {
      await $.command.run({ command: 'compact' })
    } finally {
      isCompacting = false
    }
  })
}

// Auto compact compacts through the session itself, not by typing /compact: a
// command run from the end of a turn is refused while the turn winds down, which
// is why it toasted and then did nothing. The compaction also rejects while a turn
// runs, so it is tried again a few times, a couple of seconds apart.
const AUTO_TRIES = 6
let canCompactDirectly = true
const AUTO_RETRY_MS = 2_000

function autoCompactNow($: EngineInterface, attempt = 1): void {
  if (attempt === 1) {
    if (isCompacting) return
    isCompacting = true
  }
  $.clock.after(attempt === 1 ? 1_000 : AUTO_RETRY_MS, async () => {
    try {
      // the desktop app (an SDK session) has no direct compaction: there /compact runs
      // as a turn of its own, so it is typed, as the Compact button does
      const result = canCompactDirectly
        ? await $.session.compact()
        : (await $.command.run({ command: 'compact' }), undefined)
      // held as stuck while the figures are read again, so no tick fires a second one
      await setHold($, { stuck: true })
      isCompacting = false
      if (result && 'skip' in result && result.skip) $.ui.toast(`Auto compact was skipped: ${result.skip}`)
      lastSnapshot = ''
      const usage = await $.session.usage({ breakdown: 'summary' })
      const percent = usage.context.percent ?? 0
      // still past the % after compacting: say so once, and do not loop on it
      const auto = await read($, autoCompact)
      if (auto.at !== null && Math.round(percent) >= auto.at) {
        $.ui.toast(`Context is still at ${Math.round(percent)}% after compacting, past your ${auto.at}%: auto compact waits until it drops below`)
      } else await setHold($, { stuck: false })
      await refresh($)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      // any refusal of the direct way: type /compact from then on, as the button does
      if (canCompactDirectly) {
        canCompactDirectly = false
        return autoCompactNow($, attempt + 1)
      }
      if (attempt < AUTO_TRIES) return autoCompactNow($, attempt + 1)
      isCompacting = false
      $.ui.toast(`Auto compact could not start: ${reason}`)
      $.ui.log(`hud: auto compact failed: ${reason}`, { to: 'debug' })
    }
  })
}

// called with the context % whenever it is read
async function watchAuto($: EngineInterface, percent: number): Promise<void> {
  lastPercent = percent
  const auto = await read($, autoCompact)
  if (!auto.isOn || auto.at === null) return
  const held = await read($, hold)
  if (Math.round(percent) < auto.at) {
    if (held.stuck) await setHold($, { stuck: false })
    return
  }
  if (held.waits || held.stuck || isBusy || isCompacting) return
  $.ui.toast(`Context at ${Math.round(percent)}%: auto compacting (set at ${auto.at}%)`)
  autoCompactNow($)
}

async function saveAuto($: EngineInterface, next: AutoCompact): Promise<void> {
  await update($, autoCompact, () => next)
  await storeSet($, `autoCompact:${autoChat ?? (await chatId($))}`, next)
}

// auto compact is set per chat: a chat that never had it opens with it off (at the
// default %); a chat reopened, or the app restarted, gets back its own. Read again
// whenever the chat's id changes (a /clear goes on under a new one, unannounced)
let autoChat: string | undefined
async function chatId($: EngineInterface): Promise<string> {
  try {
    return await $.session.id()
  } catch {
    return 'chat'
  }
}
async function loadAuto($: EngineInterface): Promise<void> {
  const id = await chatId($)
  if (id === autoChat) return
  autoChat = id
  const saved = (await storeGet($, `autoCompact:${id}`)) as AutoCompact | undefined
  await update($, autoCompact, () => (saved ? { ...saved, at: saved.at ?? AT_DEFAULT } : { isOn: false, at: AT_DEFAULT }))
  // the same chat after a reload keeps its ask and what holds it back
  if ((await read($, hold)).chat === id) return
  await update($, hold, () => ({ chat: id, waits: false, stuck: false }))
  await update($, autoAsk, () => null)
}

// the % field sets on Enter, or when the focus leaves it with an unset draft (a
// click elsewhere in the band, or the next prompt sent); 15 to 99, outside is pulled
// in. After a set the field is drawn afresh (fieldTick), which also drops its focus
const AT_MIN = 15
// the % whenever there is none: a blank field, a first switch-on
const AT_DEFAULT = 30
const AT_MAX = 99
let draftAt: string | null = null

// no event says a click landed outside the band, so a draft also sets itself once
// typing has rested a while, as if the person had clicked away
const AT_REST_MS = 2_000
let restTimer: { cancel(): void } | null = null

// the field takes digits only, 3 at most: anything else typed or pasted is dropped
// as it arrives, by drawing the field's text again cleaned
const AT_DIGITS = 3
// a mark of no width, so a cleaned text equal to the one drawn still redraws (an
// unchanged value would leave the typing as it is) without a new field losing focus
const NO_WIDTH = '\u200b'

function cleanAt(value: string): string {
  return value.replace(/\D/g, '').slice(0, AT_DIGITS)
}

// what the field shows comes from state, not a module variable: a press or a typing
// runs apart from the draw, so a value the draw kept would not be seen here
async function redrawField($: EngineInterface, value: string): Promise<void> {
  const at = (await read($, autoCompact)).at ?? AT_DEFAULT
  await update($, fieldText, drawn => (value === (drawn ?? `${at}`) ? value + NO_WIDTH : value))
}

function typedAt($: EngineInterface, raw: string): void {
  const value = cleanAt(raw)
  if (value !== raw) void redrawField($, value)
  draftAt = value
  restTimer?.cancel()
  restTimer = $.clock.after(AT_REST_MS, () => {
    restTimer = null
    void commitDraft($)
  })
}

async function commitDraft($: EngineInterface): Promise<void> {
  if (draftAt === null) return
  await commitAt($, draftAt)
}

async function commitAt($: EngineInterface, value: string): Promise<void> {
  draftAt = null
  restTimer?.cancel()
  restTimer = null
  const text = cleanAt(value)
  // only digits reach here: blank is the default, out of range is pulled in, every time
  const typed = text === '' ? AT_DEFAULT : Number(text)
  const at = Math.min(AT_MAX, Math.max(AT_MIN, typed))
  if (typed !== at) $.ui.toast(`Auto compact: ${typed < at ? 'the least' : 'the most'} is ${at}% – set to ${at}%`)
  await setThreshold($, at)
  // a new field every time (its key changes), so it shows the set value whatever was typed
  await update($, fieldText, () => null)
  await update($, fieldTick, n => n + 1)
}

// a new threshold: armed when the context is below it, else the band asks, in its
// own buttons (never the chat's question dialog, which runs through the chat)
async function setThreshold($: EngineInterface, at: number): Promise<void> {
  await saveAuto($, { isOn: true, at })
  await askIfPast($, at)
}

// turning it on, or a new %, while the context is already past it: ask first
async function askIfPast($: EngineInterface, at: number | null): Promise<void> {
  const isPast = at !== null && Math.round(lastPercent) >= at
  await setHold($, { waits: isPast, stuck: false })
  await update($, autoAsk, () => (isPast ? { at: at!, percent: Math.round(lastPercent) } : null))
  if (!isPast && at !== null) $.ui.toast(`Auto compact at ${at}% context`)
}

type AskChoice = 'now' | 'next'

async function answerAsk($: EngineInterface, choice: AskChoice): Promise<void> {
  await update($, autoAsk, () => null)
  // 'next': goes on waiting until a compaction is seen (the reply total goes blank)
  if (choice === 'now') {
    await setHold($, { waits: false })
    autoCompactNow($)
  }
}

let isRefreshing = false
// an ask that arrived while a 3s tick was running: done right after it, not dropped
let pendingAsk: Ask = 'no'
let lastSnapshot = ''
let hadError = false

// details shown or not is one setting for every chat, kept in the shared store: each
// chat reads it twice a second (one small read, nothing else) and follows
const COLLAPSE_EVERY_MS = 500
async function syncExpanded($: EngineInterface): Promise<void> {
  const saved = ((await storeGet($, 'expanded')) as boolean | undefined) === true
  if (saved !== (await read($, isExpanded))) await update($, isExpanded, () => saved)
}

// The desktop app's theme is not told to plugins: it is read from the app's own
// settings (userThemeMode), and for "system" from the OS. Looked at every 2s so a
// switch shows at once, each look a single file-time check (the file is read only
// once it changed); the OS, for "system" alone, is asked at most every 15s
const THEME_EVERY_MS = 2_000
const SYSTEM_EVERY_MS = 15_000
let didLogTheme = false
let systemTheme: { at: number; value: 'dark' | 'light' } | undefined
async function desktopConfig($: EngineInterface): Promise<string | undefined> {
  const appData = await $.env.get('APPDATA')
  if (appData) return `${appData}/Claude/config.json`
  const home = await $.env.get('HOME')
  return home ? `${home}/Library/Application Support/Claude/config.json` : undefined
}
async function osTheme($: EngineInterface): Promise<'dark' | 'light'> {
  const now = await $.clock.now()
  if (systemTheme && now - systemTheme.at < SYSTEM_EVERY_MS) return systemTheme.value
  let value: 'dark' | 'light' = 'dark'
  try {
    if (await $.env.get('APPDATA')) {
      const { stdout } = await $.process.run(['reg', 'query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', '/v', 'AppsUseLightTheme'], { timeoutMs: 5_000 })
      if (/AppsUseLightTheme\s+REG_DWORD\s+0x1\b/.test(stdout)) value = 'light'
    } else {
      const { stdout } = await $.process.run(['defaults', 'read', '-g', 'AppleInterfaceStyle'], { timeoutMs: 5_000 })
      if (!/dark/i.test(stdout)) value = 'light'
    }
  } catch {
    // unknown: dark, as the band was built
  }
  systemTheme = { at: now, value }
  return value
}
// the settings file is read again only when it has changed since the last look: a
// look is otherwise one file-time check, no read, no parse
let themeFile: { mtimeMs: number; mode: string | undefined } | undefined
async function syncTheme($: EngineInterface): Promise<void> {
  let mode: string | undefined
  try {
    const path = await desktopConfig($)
    if (!path) return
    const { mtimeMs } = await $.fs.stat(path)
    if (themeFile?.mtimeMs === mtimeMs) mode = themeFile.mode
    else {
      mode = (JSON.parse(await $.fs.read(path)) as { userThemeMode?: string }).userThemeMode
      themeFile = { mtimeMs, mode }
    }
  } catch (error) {
    if (!didLogTheme) $.ui.log(`hud: the app's theme could not be read: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
    didLogTheme = true
    return
  }
  const next = mode === 'light' ? 'light' : mode === 'dark' ? 'dark' : await osTheme($)
  if (next !== (await read($, theme))) await update($, theme, () => next)
}

async function refresh($: EngineInterface, ask: Ask = 'no'): Promise<void> {
  await loadAuto($)
  if (isRefreshing) {
    if (ask === 'now' || (ask === 'due' && pendingAsk === 'no')) pendingAsk = ask
    return
  }
  isRefreshing = true
  try {
    const now = await $.clock.now()
    const usage = await $.session.usage({ breakdown: 'summary' })
    const { context } = usage
    const breakdown = context.breakdown
    const all = (breakdown?.categories ?? []).filter(c => c.kind !== 'deferred' && c.tokens > 0)
    const rough = sumGroups(all)
    // what the chat opened with, before its first turn here (a reopened chat may
    // already carry its last reply's total, so not only while that is blank)
    if (isOpening) openMessages = Math.max(rough.Messages, context.tokens ?? 0)
    // the reply total going blank after a reply: the chat was compacted (or cleared)
    if (context.tokens !== undefined) hadReply = true
    else if (hadReply) {
      hadReply = false
      // an ask left unanswered meant "after my next compact": done with now
      if ((await read($, hold)).waits) {
        await update($, autoAsk, () => null)
        await setHold($, { waits: false })
      }
    }
    const tools = rough.Tools
    const other = rough.Other
    // Messages is what the window holds beyond everything else, as /context counts it:
    // the API's real input total less the other groups, not the local estimate
    const messages = context.tokens !== undefined && context.tokens - tools - other > 0
      ? context.tokens - tools - other
      : rough.Messages
    const used = context.tokens ?? breakdown?.totalTokens ?? 0
    const categories: Category[] = [
      { name: 'Messages', tokens: messages, kind: 'used' as const },
      { name: 'Tools', tokens: tools, kind: 'used' as const },
      { name: 'Other', tokens: other, kind: 'used' as const },
      ...all
        .filter(c => c.kind === 'buffer' || c.kind === 'free')
        .map(c => ({ name: c.name, tokens: c.tokens, kind: c.kind as Category['kind'] })),
    ].filter(c => c.tokens > 0)
    const { limits, at: limitsAt, error: limitsError } = await limitsOf($, usage.rateLimits, now, ask)
    const pace = await trackPace($, limits, now)
    const next: Snapshot = {
      window: context.window,
      tokens: used,
      percent: context.percent ?? breakdown?.percentage ?? Math.round((used / context.window) * 100),
      total: categories.reduce((sum, c) => sum + c.tokens, 0) || context.window,
      categories,
      limits,
      ...(limitsAt !== undefined ? { limitsAt } : {}),
      ...(limitsError ? { limitsError } : {}),
      ...(Object.keys(pace).length > 0 ? { pace } : {}),
      // the minute, so countdowns and ages redraw even when nothing else moves
      minute: Math.floor(now / 60_000),
    }
    await watchAuto($, next.percent)
    // redraw only when something moved, not on every tick
    const json = JSON.stringify(next)
    if (json !== lastSnapshot) {
      lastSnapshot = json
      await update($, snapshot, () => next)
    }
    if (hadError) $.ui.status(undefined)
    hadError = false
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    $.ui.status(`hud: ${message.replace(/^hud: /, '')}`)
    hadError = true
  } finally {
    isRefreshing = false
  }
  if (pendingAsk !== 'no') {
    const queued = pendingAsk
    pendingAsk = 'no'
    await refresh($, queued)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'quota', description: 'Toggle the Claude Code Usage Quota band above the prompt' })
    const result = await next(e)
    await loadAuto($)
    await syncExpanded($)
    // a chat just opened: its limits now, unless another chat asked a moment ago
    await refresh($, 'due')
    // keep it live, mid-turn included: what Claude Code already holds (the context and
    // the limits each reply carries), every 3s; timers stop when the module reloads
    $.clock.every(LOCAL_EVERY_MS, () => void refresh($))
    $.clock.every(COLLAPSE_EVERY_MS, () => void syncExpanded($))
    // whatever surface the session started on (a desktop chat may say none)
    await syncTheme($)
    $.clock.every(THEME_EVERY_MS, () => void syncTheme($))
    return result
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    await refresh($)
    return result
  })

  // the focus leaving the % field sets what was typed in it
  on('ui.focus', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!e.element?.startsWith('autoAt')) await commitDraft($)
    return next(e)
  }).catch(($, e, next) => next(e)) // a draft that fails to set never holds the focus back

  on('ui.press', { component: 'AbovePrompt' }, async ($, e, next) => {
    await commitDraft($)
    return next(e)
  })

  on('prompt.edit', async ($, e, next) => {
    void commitDraft($)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    isBusy = true
    if (isOpening) {
      isOpening = false
      const snap = await read($, snapshot)
      if (snap && snap.limits.length > 0 && openMessages >= RESUME_MIN_TOKENS) {
        spikeFrom = { at: await $.clock.now(), limits: snap.limits }
      }
    }
    await commitDraft($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    // a reply has just come with the figures: they are fresh, even where unchanged
    if (live) live = { ...live, at: await $.clock.now() }
    await refresh($)
    // the first reply is done: whatever it used, the jump is behind it
    spikeFrom = undefined
    // the turn is over: auto compact may fire now, never mid-reply
    isBusy = false
    const snap = await read($, snapshot)
    if (snap) await watchAuto($, snap.percent)
    return result
  })

  on('command.run', { command: 'quota' }, async $ => {
    const now = !(await read($, isOn))
    await update($, isOn, () => now)
    if (now) await refresh($, 'now')
    return { text: now ? 'Claude Code Usage Quota on.' : 'Claude Code Usage Quota off.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, isOn))) return next(e)
    const snap = await read($, snapshot)
    if (!snap) return next(e)

    const table = $.ui.resolve(e)
    const { Box, Text, Button, Input } = table
    const Svg = e.surface === 'desktop' && 'Svg' in table ? table.Svg : undefined
    usePalette(e.surface === 'desktop' && (await read($, theme)) === 'light' ? LIGHT : DARK)
    const width = Math.max(20, e.props.bodyColumns)
    const now = await $.clock.now()
    // both windows always, once there is any reading: one the reading lacks is not running
    const known = snap.limits.length === 0 ? [] : Object.keys(WINDOWS).map(kind => snap.limits.find(l => l.kind === kind) ?? { kind, percentUsed: 0 })
    const list = known.map(l => forecast(l, now, snap.pace?.[l.kind])).filter((f): f is Forecast => f !== null)
    const head = headline(list, now)
    // free as /context has it: the window less what is used and the autocompact buffer
    const buffer = snap.categories.find(c => c.kind === 'buffer')?.tokens ?? 0
    const free = Math.max(0, snap.window - snap.tokens - buffer)
    // highest first, as /context lists them: used categories, then the buffer, then free space
    const rank = (c: Category) => (c.kind === 'used' ? 0 : c.kind === 'buffer' ? 1 : 2)
    const shown = snap.categories
      .map((c, i) => ({ ...c, color: colorOf(c, i) }))
      .sort((a, b) => rank(a) - rank(b) || b.tokens - a.tokens)

    const limits = [...list].sort((a, b) => order(a.kind) - order(b.kind))
    // say so when the figures are old: the service refused and no reply has come since
    const age = snap.limitsAt === undefined ? 0 : now - snap.limitsAt
    const stale =
      snap.limitsError && age >= 2 * 60_000 && limits.length > 0
        ? `usage check ${snap.limitsError} – figures from ${duration(age)} ago`
        : snap.limitsError && limits.length === 0
          ? `usage check ${snap.limitsError}`
          : undefined
    const expanded = await read($, isExpanded)
    const auto = await read($, autoCompact)
    const ask = await read($, autoAsk)
    const tick = await read($, fieldTick)
    const drawnAt = (await read($, fieldText)) ?? `${auto.at ?? AT_DEFAULT}`
    const submitAt = (value: string) => commitAt($, value)
    const toggleAuto = async () => {
      // from the state, not this draw's value: a quick second press flips it back
      const cur = await read($, autoCompact)
      const flipped = { isOn: !cur.isOn, at: cur.at ?? AT_DEFAULT }
      await update($, autoCompact, () => flipped)
      void saveAuto($, flipped).then(async () => {
        if (flipped.isOn) await askIfPast($, flipped.at)
        else await update($, autoAsk, () => null)
      })
    }
    // At rest the band is one line: each limit's % and its reset (5 hour first, then
    // Weekly), the context %, then the controls. The ▼ opens the details beneath it:
    // the forecast, each limit's bar and note, the context's bar and what fills it.
    // Nothing is painted behind any of it; every control lights its label under the
    // pointer.
    const ACCENT = PALETTE[1]!
    const LIT = { color: ACCENT, underline: true }
    const gap = Svg ? 0.5 : 1
    // the terminal draws its own hide control ([-]) over the band's top-right corner
    const HOST_HIDE = Svg ? 0 : 4

    // a reset by its clock time, with the weekday when it is not within the day
    const resetAt = (f: Forecast) =>
      !Number.isFinite(f.resetsAt) ? '–' : f.resetsAt - now < 24 * HOUR && f.kind === 'five_hour' ? time(f.resetsAt) : `${shortDay(f.resetsAt)} ${time(f.resetsAt)}`
    const isLight = MUTED === LIGHT.muted
    // a narrow chat keeps the figures and every control, and drops the words around
    // them: the reset times, Context's name, the ask's question
    const isNarrow = width < 80
    // the desktop: a battery, then the reset in small type; the terminal: the % in text
    const windowItem = (f: Forecast) => (
      <Box flexDirection="row" columnGap={Svg ? 0.5 : 1} flexShrink={0} alignItems="center">
        {Svg ? (
          <Svg alt={`${WINDOWS[f.kind]?.label ?? f.kind} battery: ${Math.round(f.percent)}% used`} source={gaugeSvg(f.percent, f.color, isLight, true)} width={GAUGE_W} height={GAUGE_H} />
        ) : (
          <Text bold color={ink(f.color)}>{`${Math.round(f.percent)}%`}</Text>
        )}
        {isNarrow ? null : <Text size="footnote" color={MUTED}>{f.status === 'idle' ? 'not started' : resetAt(f)}</Text>}
      </Box>
    )
    const figures = (
      <Box flexDirection="row" columnGap={2} flexShrink={1} flexWrap="wrap" alignItems="center">
        {limits.length === 0 ? (
          isNarrow ? null : <Text color={MUTED}>Usage limits show after the first reply.</Text>
        ) : (
          limits.map(windowItem)
        )}
        <Box flexDirection="row" columnGap={Svg ? 0.5 : 1} flexShrink={0} alignItems="center">
          {Svg ? (
            <Svg alt={`Gauge: context ${Math.round(snap.percent)}% used`} source={gaugeSvg(snap.percent, fillColor(snap.percent), isLight, false)} width={GAUGE_W} height={GAUGE_H} />
          ) : (
            <Text bold color={ink(fillColor(snap.percent))}>{`${Math.round(snap.percent)}%`}</Text>
          )}
          {/* the name in the line's small type (a Button draws its text at one size);
              the press is the icon beside it */}
          {isNarrow ? null : <Text size="footnote" color={MUTED}>Context</Text>}
          <Box key="compactBox">
            <Button key="compact" label="⇊" plain dimColor hover={LIT} onPress={() => compactNow($)} />
          </Box>
        </Box>
      </Box>
    )

    const controls = (
      <Box flexDirection="row" alignItems="center" columnGap={1} flexShrink={0}>
        {/* auto compact: one press, its state as a dot, the % field beside it when on */}
        <Box key="autoBox">
          <Button key="auto" label={auto.isOn ? '●' : '○'} plain dimColor={!auto.isOn} hover={LIT} onPress={toggleAuto} />
        </Box>
        {isNarrow ? null : <Text size="footnote" color={auto.isOn ? undefined : MUTED}>Auto compact</Text>}
        {auto.isOn ? (
          <Box flexDirection="row" alignItems="center">
            {/* the field's Enter chip can't be turned off: the field is drawn wider than
                its box and the box clips the chip away */}
            <Box width={6} overflow="hidden">
              <Box width={8} flexShrink={0}>
                <Input
                  key={`autoAt${tick}`}
                  value={drawnAt}
                  submitLabel={'​'}
                  onInput={value => typedAt($, value)}
                  onSubmit={value => submitAt(value)}
                />
              </Box>
            </Box>
            <Text color={MUTED}>%</Text>
          </Box>
        ) : null}
        {ask ? (
          <Box flexDirection="row" alignItems="center" columnGap={1}>
            {isNarrow ? null : <Text color={AMBER}>{`at ${ask.percent}%, compact`}</Text>}
            <Box key="askNowBox">
              <Button key="askNow" label="now" plain hover={LIT} onPress={() => void answerAsk($, 'now')} />
            </Box>
            <Text color={MUTED}>/</Text>
            <Box key="askNextBox">
              <Button key="askNext" label="after next compact" plain hover={LIT} onPress={() => void answerAsk($, 'next')} />
            </Box>
          </Box>
        ) : null}
        <Box key="expandBox">
          <Button
            key="expand"
            label={expanded ? '▲' : '▼'}
            plain
            dimColor
            hover={LIT}
            onPress={async () => {
              // from the state, not this closure's value (an older draw's); saved for
              // the other chats first, so the half-second read never undoes the press
              const open = !(await read($, isExpanded))
              await storeSet($, 'expanded', open)
              await update($, isExpanded, () => open)
            }}
          >
            <Text size="heading">{expanded ? '▲' : '▼'}</Text>
          </Button>
        </Box>
      </Box>
    )

    // one bar: a thin Svg on the desktop; on the terminal coloured glyphs, never a
    // painted background: █ for what is used, ░ for what is not, │ the forecast tick
    const glyphs = (runs: { color: string; width: number; char: string }[]) => (
      <Box flexDirection="row" flexShrink={0}>
        {runs.filter(run => run.width > 0).map(run => (
          <Text color={run.color}>{run.char.repeat(run.width)}</Text>
        ))}
      </Box>
    )
    const bar = (
      alt: string,
      segments: { color: string; share: number }[],
      barCells: number,
      marker?: number,
      f?: Forecast,
      extra?: { at: number; color: string },
    ) =>
      Svg ? (
        <Box width={barCells} flexShrink={0} alignItems="center">
          <Svg
            alt={alt}
            source={barSvg(segments, barCells * 8, marker, extra)}
            width={barCells * 8}
            height={BAR_PX}
          />
        </Box>
      ) : f ? (
        glyphs(cellRuns(f, barCells).map(run => ({ ...run, char: run.color === TRACK ? '░' : run.color === MUTED ? '│' : '█', color: run.color === TRACK ? MUTED : run.color })))
      ) : (
        (() => {
          // each segment's share of the cells, the remainders handed out largest first
          const total = segments.reduce((sum, s) => sum + s.share, 0) || 1
          const exact = segments.map(s => (s.share / total) * barCells)
          const whole = exact.map(Math.floor)
          let left = barCells - whole.reduce((a, b) => a + b, 0)
          exact
            .map((x, i) => ({ i, r: x - Math.floor(x) }))
            .sort((a, b) => b.r - a.r)
            .forEach(({ i }) => {
              if (left > 0) {
                whole[i] = whole[i]! + 1
                left -= 1
              }
            })
          return glyphs(
            segments.map((s, i) => ({
              width: whole[i]!,
              char: s.color === FREE || s.color === BUFFER ? '░' : '█',
              color: s.color === FREE || s.color === BUFFER ? MUTED : s.color,
            })),
          )
        })()
      )
    const limitSegments = (f: Forecast) => [
      { color: f.color, share: Math.min(100, f.percent) },
      { color: TRACK, share: Math.max(0, 100 - f.percent) },
    ]
    // the bar in three colours: Messages, Tools, and one light grey run for Other and
    // the autocompact buffer together (drawn as one, no seam between them); then free.
    const BAR_ORDER = ['Messages', 'Tools', 'Other']
    const barRank = (c: (typeof shown)[number]) => (c.kind === 'used' ? Math.max(0, BAR_ORDER.indexOf(c.name)) : c.kind === 'buffer' ? 3 : 4)
    const contextSegments = [...shown]
      .sort((a, b) => barRank(a) - barRank(b))
      .map(c => ({ color: c.name === 'Other' && c.kind === 'used' ? BUFFER : c.color, share: c.tokens }))
      .reduce<Segment[]>((runs, seg) => {
        const last = runs[runs.length - 1]
        if (last && last.color === seg.color) last.share += seg.share
        else runs.push({ ...seg })
        return runs
      }, [])

    // The details hold only what the line above lacks: where each limit is heading,
    // and what fills the context. One column, one line each: the name, the bar, then
    // one note in grey (narrow, the note goes under the bar). Colour is for the bars
    // and for a warning; the exact figures sit in each bar's tooltip.
    const LABEL = 7
    const isRowLine = !isNarrow
    const rowCells = isRowLine ? Math.max(12, Math.min(28, width - LABEL - 50)) : Math.max(8, width - LABEL)
    const cap = (text: string, color: string = MUTED) => (
      <Text size="caption" color={color} wrap="wrap">{text}</Text>
    )
    const row = (name: string, barEl: RenderElement, note: RenderElement[]) => (
      <Box flexDirection={isRowLine ? 'row' : 'column'} alignItems={isRowLine ? 'center' : undefined} columnGap={2}>
        <Box flexDirection="row" alignItems="center" flexShrink={0}>
          <Box width={LABEL} flexShrink={0}>
            <Text size="footnote" color={MUTED} wrap="truncate-end">{name}</Text>
          </Box>
          {barEl}
        </Box>
        <Box flexDirection="row" flexWrap="wrap" columnGap={2} flexShrink={1} marginLeft={isRowLine ? 0 : LABEL}>
          {note}
        </Box>
      </Box>
    )
    const when = (t: number) => (isSameDay(t, now) ? time(t) : `${shortDay(t)} ${time(t)}`)

    // how fast each limit is being used, averaged since its window began: per hour
    // for the 5 hour window, per day for the week. Under 15 minutes in, a few % over
    // so short a time would read as a rush: shown as a dash until then
    const RATE_W = 11
    const rateOf = (f: Forecast): string => {
      const span = WINDOWS[f.kind]?.ms ?? 5 * HOUR
      const elapsed = span - (f.resetsAt - now)
      const unit = span > 24 * HOUR ? 'day' : 'h'
      if (!Number.isFinite(elapsed) || elapsed < 15 * 60_000) return `~–%/${unit}`
      const per = f.percent / (elapsed / (unit === 'day' ? 24 * HOUR : HOUR))
      return `~${per >= 10 ? Math.round(per) : Math.round(per * 10) / 10}%/${unit}`
    }
    const limitRows = limits.map(f => {
      const pct = Math.round(f.percent)
      const isWarn = f.status === 'out' || f.status === 'hit'
      const first =
        f.status === 'idle' ? 'not started' : f.status === 'hit' ? 'limit reached' : rateOf(f)
      const second =
        f.status === 'idle'
          ? undefined
          : f.status === 'hit'
            ? `back ${when(f.resetsAt)}`
            : f.status === 'out'
              ? `runs out in ${duration(f.runOutAt - now)}`
              : `${duration(f.resetsAt - now)} left`
      return row(
        f.label,
        bar(`${f.label} ${pct}% used, on pace for about ${Math.round(Math.min(100, f.projected))}% by reset`, limitSegments(f), rowCells, markerOf(f), f),
        [
          <Box width={RATE_W} flexShrink={0}>{cap(first, isWarn ? ink(f.color) : MUTED)}</Box>,
          ...(second ? [cap(second.replace(/ /g, NB), isWarn ? ink(f.color) : MUTED)] : []),
        ],
      )
    })

    // the legend is the bar's own colours on the names: no dots
    const parts = (['Messages', 'Tools', 'Other'] as const)
      .map(name => shown.find(c => c.name === name))
      .filter((c): c is (typeof shown)[number] => c !== undefined)
    const autoMark = auto.isOn && auto.at !== null ? { at: auto.at, color: ACCENT } : undefined
    const contextRow = row(
      'Context',
      bar(`Context ${Math.round(snap.percent)}% used`, contextSegments, rowCells, undefined, undefined, autoMark),
      [
        ...parts.map(c => (
          <Box flexDirection="row" columnGap={0.5} flexShrink={0}>
            <Text size="caption" color={c.name === 'Other' ? MUTED : c.color}>{c.name}</Text>
            <Text size="caption" color={MUTED}>{tokens(c.tokens)}</Text>
          </Box>
        )),
        cap(`${tokens(free)} free`),
        // the blue mark on the bar, said in words
        ...(autoMark ? [cap(`auto ${autoMark.at}%`, ACCENT)] : []),
      ],
    )

    // a warning only: a limit reached or running out before its reset
    const warn = head && head.color !== GREEN ? head : null
    // the limits come with each reply: say so when the last ones are old
    const isOld = !stale && limits.length > 0 && snap.limitsAt !== undefined && age >= 10 * 60_000
    const details = (
      <Box flexDirection="column" rowGap={gap}>
        {stale ? cap(stale, AMBER) : null}
        {limitRows}
        {contextRow}
        {isOld ? cap(`Usage figures from ${duration(age)} ago: they update with each reply`) : null}
        {/* a warning, under everything it sums up */}
        {warn ? <Text size="footnote" weight="medium" color={ink(warn.color)} wrap="wrap">{warn.text}</Text> : null}
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={2} paddingRight={HOST_HIDE}>
          {figures}
          {controls}
        </Box>

        {expanded ? <Box marginTop={gap}>{details}</Box> : null}
      </Box>
    )
  })
}
