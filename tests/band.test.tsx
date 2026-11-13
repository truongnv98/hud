import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionRateLimit, SessionUsage } from 'claude-code'

const NOW = Date.parse('2026-10-04T06:00:00Z')
const MIN = 60_000
const HOUR = 60 * MIN
const SURFACES = ['terminal', 'desktop'] as const

const PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 20,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
}

const CATEGORIES = [
  { name: 'System prompt', tokens: 4_000, kind: 'used' },
  { name: 'System tools', tokens: 34_000, kind: 'used' },
  { name: 'MCP tools', tokens: 17_000, kind: 'used' },
  { name: 'Skills', tokens: 6_000, kind: 'used' },
  { name: 'Messages', tokens: 97_000, kind: 'used' },
  { name: 'Memory files', tokens: 1_000, kind: 'used' }, // 0.1%: hidden from the legend
  { name: 'Deferred tools', tokens: 50_000, kind: 'deferred', isDeferred: true },
  { name: 'Autocompact buffer', tokens: 33_000, kind: 'buffer' },
  { name: 'Free space', tokens: 808_000, kind: 'free' },
].map(c => ({ color: 'text', isDeferred: false, ...c }))

function usage(rateLimits: SessionRateLimit[]): SessionUsage {
  return {
    startedAt: NOW - HOUR,
    context: {
      window: 1_000_000,
      tokens: 158_000,
      percent: 16,
      breakdown: {
        categories: CATEGORIES,
        totalTokens: 159_000,
        maxTokens: 1_000_000,
        rawMaxTokens: 1_000_000,
        percentage: 16,
      } as never,
    },
    rateLimits,
  }
}

const iso = (ms: number) => new Date(NOW + ms).toISOString()

function world(on: On, rateLimits: SessionRateLimit[], status: (string | undefined)[] = []) {
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('session.usage', () => ({ value: usage(rateLimits) }))
  answerRest(on, status)
}

// what the engine answers beneath the plugin, the plan's own hooks left to the test
function answerRestNoPlan(on: On) {
  on('session.measure', () => ({ changed: [] }))
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }) as never)
  on('ui.status', () => ({ value: undefined }))
}

// no first-party login: the plan's usage endpoint is not asked
function noPlan(on: On) {
  on('session.authorize', () => ({ value: null }))
}

// what the engine answers beneath the plugin: its own (empty) band, the status line
function answerRest(on: On, status: (string | undefined)[]) {
  noPlan(on)
  on('session.measure', () => ({ changed: [] }))
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }) as never)
  on('ui.status', (_$, e) => {
    status.push(e.text)
    return { value: undefined }
  })
}

const MEASURE = { context: { window: 1_000_000, tokens: 158_000, percent: 16 }, rateLimits: [] }

// the ▼/▲ by its exact label: the kit's label match can't tell the two glyphs apart
type Finder = { find: (q: { type: 'Button'; key: string }) => Promise<{ props: { label?: unknown } } | undefined> }
async function arrow(ui: Finder): Promise<string | undefined> {
  return (await ui.find({ type: 'Button', key: 'expand' }))?.props.label as string | undefined
}
// the details under the line, opened with the ▼ as a person would (the setting is
// shared, so they may already be open)
async function opened<U extends Finder & { press: (q: { key: string }) => Promise<unknown> }>(ui: U): Promise<U> {
  if ((await arrow(ui)) === '▼') await ui.press({ key: 'expand' })
  return ui
}

// the % field is drawn afresh after every set, under a new key
async function fieldKey(ui: { find: (q: { type: 'Input' }) => Promise<{ props: { key?: string } } | undefined> }): Promise<string> {
  return String((await ui.find({ type: 'Input' }))?.props.key)
}

test('draws the band on track', async ($, on) => {
  world(on, [
    { kind: 'five_hour', percentUsed: 8, resetsAt: iso(3 * HOUR + 24 * MIN) },
    { kind: 'seven_day', percentUsed: 46, resetsAt: iso(3 * 24 * HOUR + 7 * HOUR) },
  ])
  await $.session.measure(MEASURE)

  for (const surface of SURFACES) {
    const ui = await opened(await $.ui.mount({ plugin: 'hud', surface, component: 'AbovePrompt', props: PROPS }))
    expect(await ui.find({ text: /^At this pace|^Limit reached/ })).toBeUndefined()
    expect(surface === 'desktop' ? (await ui.findAll({ type: 'Svg' })).find(svg => svg.props.alt === 'Gauge: context 16% used') : await ui.find({ text: '16%' })).toBeDefined()
    expect(await ui.find({ text: '809k free' })).toBeDefined()
    expect(await ui.find({ text: 'Messages' })).toBeDefined()
    expect(await ui.find({ text: '96k' })).toBeDefined()
    // three groups: Messages, Tools (34k + 17k), Other (4k + 6k + 1k), Other in grey
    expect(await ui.find({ type: 'Text', text: 'Tools' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '51k' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: 'Other' }))?.props.color).toBe('#8b90a0')
    expect(await ui.find({ type: 'Text', text: '11k' })).toBeDefined()
    expect(await ui.find({ text: 'Memory files' })).toBeUndefined()
    // only the top three categories are listed
    expect(await ui.find({ text: 'Skills' })).toBeUndefined()
    expect(await ui.find({ text: 'System prompt' })).toBeUndefined()
    expect(await ui.find({ text: 'Deferred tools' })).toBeUndefined()
    expect(await ui.find({ text: '5 Hour' })).toBeDefined()
    expect(await ui.find({ text: 'Weekly' })).toBeDefined()
    // the forecast is the bar's mark, said in its alt (the terminal's bars are glyphs)
    if (surface === 'desktop') expect((await ui.findAll({ type: 'Svg' })).some(svg => String(svg.props.alt).endsWith('on pace for about 81% by reset'))).toBe(true)
    expect(await ui.find({ text: /^3d.7h.left$/ })).toBeDefined()
    // the forecast is the bar's mark, said in its alt (the terminal's bars are glyphs)
    if (surface === 'desktop') expect((await ui.findAll({ type: 'Svg' })).some(svg => String(svg.props.alt).endsWith('on pace for about 32% by reset'))).toBe(true)
    expect(await ui.find({ text: /^3h.24m.left$/ })).toBeDefined()
    // legend runs highest first
    const names = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    const order = ['Messages', 'Tools', 'Other'].map(n => names.indexOf(n))
    expect(order).toEqual([...order].sort((a, b) => a - b))

    // every flexGrow is finite, within the engine's limit, and never a raw token count
    const boxes = await ui.findAll({ type: 'Box' })
    for (const box of boxes) {
      const grow = box.props.flexGrow
      if (grow === undefined) continue
      expect(Number.isFinite(grow)).toBe(true)
      expect(grow as number).toBeLessThanOrEqual(10000)
      expect(grow as number).toBeGreaterThanOrEqual(1)
    }
    if (surface === 'desktop') {
      // thin Svg bars: the context bar and the two rate bars, no flexGrow segments
      // (the limits' batteries on the band's line are Svgs too: left out here)
      const svgs = (await ui.findAll({ type: 'Svg' })).filter(svg => !/ battery: |^Gauge: /.test(String(svg.props.alt)))
      // each limit as a battery on the band's line
      expect((await ui.findAll({ type: 'Svg' })).filter(svg => / battery: /.test(String(svg.props.alt)))).toHaveLength(2)
      // the two rate bars (left, each with a forecast tick), then the context bar (right)
      expect(svgs).toHaveLength(3)
      expect(svgs[0]?.props.alt).toMatch(/^5 Hour/)
      expect(svgs[1]?.props.alt).toMatch(/^Weekly/)
      expect(svgs[2]?.props.alt).toMatch(/^Context/)
      expect(svgs[2]?.props.height).toBe(5)
      expect(String(svgs[0]?.props.source)).toContain('fill="#8b90a0"')
      expect(String(svgs[1]?.props.source)).toContain('fill="#8b90a0"')
      expect(boxes.filter(b => typeof b.props.flexGrow === 'number')).toHaveLength(0)
    } else {
      // nothing painted behind the band: the bars are coloured glyphs
      expect(boxes.filter(b => b.props.backgroundColor !== undefined)).toHaveLength(0)
      const texts = (await ui.findAll({ type: 'Text' })).filter(t => /^[█░│]+$/.test(String(t.text)))
      // 5 hour at 8%: a used run in its colour and the forecast tick in grey
      expect(texts.some(t => /█/.test(String(t.text)) && t.props.color === '#4ade80')).toBe(true)
      expect(texts.some(t => t.text === '│' && t.props.color === '#8b90a0')).toBe(true)
    }
    await ui.unmount()
  }
})

test('leads with a window that will run out', async ($, on) => {
  world(on, [
    { kind: 'five_hour', percentUsed: 60, resetsAt: iso(4 * HOUR) },
    { kind: 'seven_day', percentUsed: 10, resetsAt: iso(5 * 24 * HOUR) },
  ])
  await $.session.measure(MEASURE)

  for (const surface of SURFACES) {
    const ui = await opened(await $.ui.mount({ plugin: 'hud', surface, component: 'AbovePrompt', props: PROPS }))
    const head = await ui.find({ type: 'Text', text: /^At this pace you'll run out before the .* reset\.$/ })
    expect(head?.props.color).toBe('#f87171')
    // 60% in 1h, blended with the usual pace (50% a window): 40% more takes 74m,
    // 2h 46m before the reset
    expect(await ui.find({ text: /^runs.out.in.1h.14m$/ })).toBeDefined()
    // running out: how soon takes the place of the time left
    await ui.unmount()
  }
})

test('says when a limit is reached', async ($, on) => {
  world(on, [{ kind: 'seven_day', percentUsed: 100, resetsAt: iso(2 * 24 * HOUR) }])
  await $.session.measure(MEASURE)

  for (const surface of SURFACES) {
    const ui = await opened(await $.ui.mount({ plugin: 'hud', surface, component: 'AbovePrompt', props: PROPS }))
    expect(await ui.find({ text: /^Limit reached\. Usage resumes at Tuesday \d\d:\d\d\.$/ })).toBeDefined()
    await ui.unmount()
  }
})

test('treats the first 3% of a window as on track', async ($, on) => {
  world(on, [{ kind: 'five_hour', percentUsed: 5, resetsAt: iso(5 * HOUR - 5 * MIN) }])
  await $.session.measure(MEASURE)

  for (const surface of SURFACES) {
    const ui = await opened(await $.ui.mount({ plugin: 'hud', surface, component: 'AbovePrompt', props: PROPS }))
    expect(await ui.find({ text: /^At this pace|^Limit reached/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('shows a refresh failure in the status line', async ($, on) => {
  const status: (string | undefined)[] = []
  mock.clock(on, { now: NOW })
  on('session.usage', () => ({ deny: 'no session' }))
  answerRest(on, status)
  await $.session.measure(MEASURE)
  expect(status).toContainEqual(expect.stringMatching(/^hud: (?!hud).*no session/))
})

test('the Compact button runs /compact', async ($, on) => {
  const ran: string[] = []
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  on('session.usage', () => ({ value: usage([{ kind: 'seven_day', percentUsed: 10, resetsAt: iso(5 * 24 * HOUR) }]) }))
  answerRest(on, [])
  on('command.run', (_$, e) => {
    ran.push(e.command)
    return { text: '' }
  })
  await $.session.measure(MEASURE)

  for (const surface of SURFACES) {
    const ui = await opened(await $.ui.mount({ plugin: 'hud', surface, component: 'AbovePrompt', props: PROPS }))
    await ui.press({ key: 'compact' })
    await clock.advance(1)
    await ui.unmount()
  }
  expect(ran).toEqual(['compact', 'compact'])
})

test('makes no network request: no login handle, no usage service, no exact count', async ($, on) => {
  const asked: string[] = []
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  on('session.usage', (_$, e) => {
    if (e.breakdown === 'full') asked.push('exact count')
    return {
      value: usage([
        { kind: 'five_hour', percentUsed: 16, resetsAt: iso(2 * HOUR) },
        { kind: 'seven_day', percentUsed: 7, resetsAt: iso(3 * 24 * HOUR) },
      ]),
    }
  })
  on('session.authorize', () => {
    asked.push('authorize')
    return { value: null }
  })
  on('http.fetch', (_$, e) => {
    asked.push(`fetch ${e.url}`)
    return { value: { status: 500, ok: false, headers: {}, text: '' } } as never
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'quota' } }))
  on('session.measure', () => ({ changed: [] }))
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }) as never)
  on('ui.status', () => ({ value: undefined }))
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  await $.session.measure(MEASURE)
  // well past every timer the original ran its requests on
  await clock.advance(10 * MIN)

  expect(asked).toEqual([])
  const ui = await opened(await $.ui.mount({ plugin: 'hud', surface: 'desktop', component: 'AbovePrompt', props: PROPS }))
  const alts = (await ui.findAll({ type: 'Svg' })).map(svg => String(svg.props.alt))
  expect(alts).toContain('Gauge: context 16% used')
  expect(alts.some(alt => /battery: 7% used$/.test(alt))).toBe(true)
  await ui.unmount()
})

test('a fresh session shows the last saved limits until its first reply', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on, {
    limits: {
      at: NOW - HOUR,
      limits: [
        { kind: 'five_hour', percentUsed: 13, resetsAt: iso(-MIN) }, // already reset: back to 0
        { kind: 'seven_day', percentUsed: 6, resetsAt: iso(3 * 24 * HOUR) },
      ],
    },
  })
  on('session.usage', () => ({ value: usage([]) }))
  answerRest(on, [])
  await $.session.measure(MEASURE)

  for (const surface of SURFACES) {
    const ui = await opened(await $.ui.mount({ plugin: 'hud', surface, component: 'AbovePrompt', props: PROPS }))
    expect(await ui.find({ text: 'Weekly' })).toBeDefined()
    // a window that has reset still shows, at 0%, never vanishes
    expect(await ui.find({ text: '5 Hour' })).toBeDefined()
    expect(surface === 'desktop' ? (await ui.findAll({ type: 'Svg' })).find(svg => svg.props.alt === '5 Hour battery: 0% used') : await ui.find({ type: 'Text', text: '0%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'not started' })).toBeDefined()
    expect(await ui.find({ text: /^At this pace|^Limit reached/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('with no reading anywhere, the left side says so', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('session.usage', () => ({ value: usage([]) }))
  answerRest(on, [])
  await $.session.measure(MEASURE)

  for (const surface of SURFACES) {
    const ui = await opened(await $.ui.mount({ plugin: 'hud', surface, component: 'AbovePrompt', props: PROPS }))
    expect(await ui.find({ text: 'Usage limits show after the first reply.' })).toBeDefined()
    await ui.unmount()
  }
})

const TURN = { answer: 'done', durationMs: 1_000, isAborted: false, turnId: 't1', reason: 'answer' } as never

function startWorld(on: On, percentRef: { value: number; isCompacted?: boolean }, ran: string[], asked: string[] = [], answer = 'Compact now', seed: Record<string, unknown> = {}) {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, seed)
  on('session.usage', () => {
    const u = usage([{ kind: 'seven_day', percentUsed: 10, resetsAt: iso(3 * 24 * HOUR) }])
    // just compacted: no reply yet, so no real total
    const tokens = percentRef.isCompacted ? undefined : percentRef.value * 10_000
    return { value: { ...u, context: { ...u.context, tokens, percent: percentRef.value } } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'quota' } }))
  on('command.run', (_$, e) => {
    ran.push(e.command)
    return { text: '' }
  })
  // auto compact compacts through the session, not by typing /compact
  on('session.compact', () => {
    ran.push('compact')
    return { skip: 'answered by the test' } as never
  })
  // $.ui.ask is a call of the AskUserQuestion tool: answered here as the dialog would
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    const question = (e as unknown as { questions: { question: string }[] }).questions[0]!.question
    asked.push(question)
    return { result: { questions: [], answers: { [question]: answer } } } as never
  })
  on('ui.toast', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.start', () => ({ turnId: 't1' }))
  answerRest(on, [])
  return clock
}

test('at rest the band is one line: each limit by its % and reset, no names; the ▼ opens the details', async ($, on) => {
  const percent = { value: 16 }
  startWorld(on, percent, [])
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'hud', surface, component: 'AbovePrompt', props: PROPS })
    expect(await arrow(ui)).toBe('▼')
    // no window names on the line: 5 hour first, then Weekly, then Context
    expect(await ui.find({ text: '5 Hour' })).toBeUndefined()
    expect(await ui.find({ text: 'Weekly' })).toBeUndefined()
    expect(await ui.find({ text: 'not started' })).toBeDefined()
    expect(await ui.find({ text: /^[A-Z][a-z]{2} \d\d:\d\d$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Context' })).toBeDefined()
    // the context's %: a capsule on the desktop, the figure in text on the terminal
    if (surface === 'desktop') expect(await ui.find({ type: 'Svg', alt: 'Gauge: context 16% used' })).toBeDefined()
    else expect(await ui.find({ type: 'Text', text: '16%' })).toBeDefined()
    // every control is there, chromeless, and lights under the pointer
    for (const key of ['compact', 'expand']) {
      const button = await ui.find({ type: 'Button', key })
      expect(button?.props.plain).toBe(true)
    }
    // the details are closed: no headline, notes, bars or categories
    expect(await ui.find({ text: /^On track\./ })).toBeUndefined()
    expect(await ui.find({ text: /by reset/ })).toBeUndefined()
    expect(await ui.find({ text: 'Messages' })).toBeUndefined()
    expect((await ui.findAll({ type: 'Svg' })).filter(svg => /^Context/.test(String(svg.props.alt)))).toHaveLength(0)
    // nothing is painted behind it
    expect((await ui.findAll({ type: 'Box' })).filter(b => b.props.backgroundColor !== undefined)).toHaveLength(0)

    await ui.press({ key: 'expand' })
    expect(await arrow(ui)).toBe('▲')
    expect(await ui.find({ text: /^At this pace|^Limit reached/ })).toBeUndefined()
    expect(await ui.find({ text: 'Weekly' })).toBeDefined()
    expect(await ui.find({ text: 'Messages' })).toBeDefined()
    await ui.press({ key: 'expand' })
    expect(await ui.find({ text: 'Messages' })).toBeUndefined()
    await ui.unmount()
  }
})
test('the details are one setting for every chat: a chat opens with them as another left them', async ($, on) => {
  startWorld(on, { value: 16 }, [], [], 'Compact now', { expanded: true })
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'hud', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  expect(await arrow(ui)).toBe('▲')
  expect(await ui.find({ text: 'Messages' })).toBeDefined()
  await ui.unmount()
})
test('auto compact: the switch shows the field, and it compacts between turns once the context reaches the %', async ($, on) => {
  const percent = { value: 16 }
  const ran: string[] = []
  const clock = startWorld(on, percent, ran)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })

  const ui = await opened(await $.ui.mount({ plugin: 'hud', surface: 'desktop', component: 'AbovePrompt', props: PROPS }))
  expect(await ui.find({ type: 'Input' })).toBeUndefined()
  await ui.press({ key: 'auto' })
  expect((await ui.find({ type: 'Button', key: 'auto' }))?.props.label).toBe('●')
  // the field takes digits; the % sits beside it
  expect((await ui.find({ type: 'Input' }))?.props.submitLabel).not.toBe('set')
  // 100 becomes 99 with a note
  await ui.input({ key: await fieldKey(ui), text: '100' })
  expect(ran).toEqual([])
  expect((await ui.find({ type: 'Input' }))?.props.value).toBe('99')
  // below 15 becomes 15, each time; over 99 is 99 each time; blank is 30
  for (const [typed, shown] of [['5', '15'], ['0', '15'], ['14', '15'], ['100', '99'], ['250', '99'], ['', '30'], ['20', '20']]) {
    await ui.input({ key: await fieldKey(ui), text: typed })
    expect((await ui.find({ type: 'Input' }))?.props.value).toBe(shown)
  }
  // digits only, 3 at most: letters, signs and pasted text are dropped as they arrive
  await ui.input({ key: await fieldKey(ui), text: '2a', kind: 'change' })
  expect(String((await ui.find({ type: 'Input' }))?.props.value).replace(/​/g, '')).toBe('2')
  await ui.input({ key: await fieldKey(ui), text: '2', kind: 'change' })
  await ui.input({ key: await fieldKey(ui), text: '2+', kind: 'change' })
  expect(String((await ui.find({ type: 'Input' }))?.props.value).replace(/​/g, '')).toBe('2')
  await ui.input({ key: await fieldKey(ui), text: 'fix the bug -25 now', kind: 'change' })
  expect((await ui.find({ type: 'Input' }))?.props.value).toBe('25')
  await ui.input({ key: await fieldKey(ui), text: '123456', kind: 'change' })
  expect((await ui.find({ type: 'Input' }))?.props.value).toBe('123')
  await ui.input({ key: await fieldKey(ui), text: '-25' })
  expect((await ui.find({ type: 'Input' }))?.props.value).toBe('25')
  await ui.input({ key: await fieldKey(ui), text: '20' })
  // typing sets nothing while it goes on; resting 2s counts as clicking away, once
  await ui.input({ key: await fieldKey(ui), text: '4', kind: 'change' })
  await clock.advance(1_500)
  await ui.input({ key: await fieldKey(ui), text: '45', kind: 'change' })
  await clock.advance(1_500)
  expect((await ui.find({ type: 'Input' }))?.props.value).toBe('20')
  await clock.advance(600)
  expect((await ui.find({ type: 'Input' }))?.props.value).toBe('45')
  // a press elsewhere in the band sets a draft at once
  await ui.input({ key: await fieldKey(ui), text: '7', kind: 'change' })
  await ui.press({ key: 'expand' })
  await ui.press({ key: 'expand' })
  expect((await ui.find({ type: 'Input' }))?.props.value).toBe('15')
  await ui.input({ key: await fieldKey(ui), text: '40' })
  expect((await ui.find({ type: 'Input' }))?.props.value).toBe('40')

  // past it mid-turn: nothing until the turn ends, then at once
  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  percent.value = 45
  await clock.advance(3_000)
  expect(ran).toEqual([])
  await $.turn.complete(TURN)
  await clock.advance(1_100)
  expect(ran).toEqual(['compact'])

  // the compaction left it still past the %: it does not loop on it
  await $.turn.complete(TURN)
  await clock.advance(3_600)
  expect(ran).toEqual(['compact'])

  // once under the % and past it again, it fires again
  percent.value = 20
  await clock.advance(3_000)
  percent.value = 41
  await $.turn.complete(TURN)
  await clock.advance(1_100)
  expect(ran).toEqual(['compact', 'compact'])
  await ui.unmount()
})

test('auto compact set below the context asks in the band, and "Now" compacts', async ($, on) => {
  const percent = { value: 50 }
  const ran: string[] = []
  const asked: string[] = []
  const clock = startWorld(on, percent, ran, asked, 'Compact now')
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })

  const ui = await opened(await $.ui.mount({ plugin: 'hud', surface: 'terminal', component: 'AbovePrompt', props: PROPS }))
  await ui.press({ key: 'auto' })
  await ui.input({ key: await fieldKey(ui), text: '40' })
  await clock.advance(1_100)
  // asked in the band, never through the chat's question dialog
  expect(asked).toEqual([])
  expect(await ui.find({ type: 'Text', text: 'at 50%, compact' })).toBeDefined()
  expect(ran).toEqual([])
  await ui.press({ key: 'askNow' })
  await clock.advance(1_100)
  expect(ran).toEqual(['compact'])
  expect(await ui.find({ type: 'Text', text: /^at \d+%, compact$/ })).toBeUndefined()
  await ui.unmount()
})

test('"After my next compact" holds through a % flickering below, until a real compaction', async ($, on) => {
  const percent: { value: number; isCompacted?: boolean } = { value: 17 }
  const ran: string[] = []
  const clock = startWorld(on, percent, ran)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })

  const ui = await opened(await $.ui.mount({ plugin: 'hud', surface: 'desktop', component: 'AbovePrompt', props: PROPS }))
  await ui.press({ key: 'auto' })
  await ui.input({ key: await fieldKey(ui), text: '19' })
  expect(await ui.find({ type: 'Text', text: /^at \d+%, compact$/ })).toBeUndefined()
  await ui.input({ key: await fieldKey(ui), text: '17' })
  expect(await ui.find({ type: 'Text', text: 'at 17%, compact' })).toBeDefined()
  // still asking: a dip below and back, then a turn's end, compacts nothing
  percent.value = 16.4
  await clock.advance(3_000)
  percent.value = 18
  await $.turn.complete(TURN)
  await clock.advance(1_100)
  expect(ran).toEqual([])
  await ui.press({ key: 'askNext' })
  percent.value = 16.4
  await clock.advance(3_000)
  percent.value = 18
  await $.turn.complete(TURN)
  await clock.advance(1_100)
  expect(ran).toEqual([])
  // the person's own compact: from then on it watches again
  percent.value = 5
  percent.isCompacted = true
  await clock.advance(3_000)
  percent.isCompacted = false
  percent.value = 18
  await $.turn.complete(TURN)
  await clock.advance(1_100)
  expect(ran).toEqual(['compact'])
  await ui.unmount()
})

test('auto compact is per chat: another chat opens with it off, at 30%; turned on past it, it asks and waits', async ($, on) => {
  const percent: { value: number; isCompacted?: boolean } = { value: 35 }
  const ran: string[] = []
  // another chat has it on at 20%
  const clock = startWorld(on, percent, ran, [], 'Compact now', { 'autoCompact:other': { isOn: true, at: 20 } })
  on('session.id', () => ({ value: 'this' }) as never)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  await clock.advance(3_000)
  expect(ran).toEqual([])

  const ui = await opened(await $.ui.mount({ plugin: 'hud', surface: 'desktop', component: 'AbovePrompt', props: PROPS }))
  expect((await ui.find({ type: 'Button', key: 'auto' }))?.props.label).toBe('○')
  await ui.press({ key: 'auto' })
  expect((await ui.find({ type: 'Input' }))?.props.value).toBe('30')
  expect(await ui.find({ type: 'Text', text: 'at 35%, compact' })).toBeDefined()
  // left unanswered: as "after my next compact"
  await $.turn.complete(TURN)
  await clock.advance(3_000)
  expect(ran).toEqual([])
  percent.value = 5
  percent.isCompacted = true
  await clock.advance(3_000)
  expect(await ui.find({ type: 'Text', text: /^at \d+%, compact$/ })).toBeUndefined()
  percent.isCompacted = false
  percent.value = 31
  await $.turn.complete(TURN)
  await clock.advance(1_100)
  expect(ran).toEqual(['compact'])
  await ui.unmount()
})

test('auto compact tries again while the turn is still winding down', async ($, on) => {
  const percent = { value: 16 }
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, { 'autoCompact:chat': { isOn: true, at: 40 } })
  let tries = 0
  on('session.usage', () => {
    const u = usage([{ kind: 'seven_day', percentUsed: 10, resetsAt: iso(3 * 24 * HOUR) }])
    return { value: { ...u, context: { ...u.context, tokens: percent.value * 10_000, percent: percent.value } } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'quota' } }))
  // the direct way refused once: /compact from then on, refused while the turn winds down, then run
  on('session.compact', () => {
    throw new Error('a turn is running')
  })
  on('command.run', () => {
    tries += 1
    if (tries < 3) throw new Error('a turn is running')
    return { text: '' }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: '' }))
  answerRest(on, [])
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  percent.value = 45
  await $.turn.complete(TURN)
  await clock.advance(1_100)
  await clock.advance(2_000)
  await clock.advance(2_000)
  await clock.advance(2_000)
  expect(tries).toBe(3)
})

test('a chat opened past the auto compact % compacts at once, as after an app restart', async ($, on) => {
  const percent = { value: 32 }
  const ran: string[] = []
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, { 'autoCompact:chat': { isOn: true, at: 30 } })
  on('session.usage', () => {
    const u = usage([{ kind: 'seven_day', percentUsed: 10, resetsAt: iso(3 * 24 * HOUR) }])
    return { value: { ...u, context: { ...u.context, tokens: percent.value * 10_000, percent: percent.value } } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'quota' } }))
  on('session.compact', () => {
    ran.push('compact')
    percent.value = 8
    return { skip: 'answered by the test' } as never
  })
  on('ui.toast', () => ({ value: undefined }))
  answerRest(on, [])
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  await clock.advance(1_100)
  expect(ran).toEqual(['compact'])
})

test('where the session cannot compact directly (the desktop app), auto compact types /compact', async ($, on) => {
  const percent = { value: 32 }
  const ran: string[] = []
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, { 'autoCompact:chat': { isOn: true, at: 30 } })
  on('session.usage', () => {
    const u = usage([{ kind: 'seven_day', percentUsed: 10, resetsAt: iso(3 * 24 * HOUR) }])
    return { value: { ...u, context: { ...u.context, tokens: percent.value * 10_000, percent: percent.value } } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'quota' } }))
  on('session.compact', () => {
    throw new Error('$.session.compact: not available in a headless (-p / SDK) session yet')
  })
  on('command.run', (_$, e) => {
    ran.push(e.command)
    percent.value = 8
    return { text: '' }
  })
  on('ui.toast', () => ({ value: undefined }))
  answerRest(on, [])
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  await clock.advance(1_100)
  await clock.advance(2_000)
  expect(ran).toEqual(['compact'])
})

test('a narrow chat wraps the details\' text; folded, its line drops the words and keeps figures and controls', async ($, on) => {
  startWorld(on, { value: 16 }, [])
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  for (const surface of SURFACES) {
    const ui = await opened(await $.ui.mount({ plugin: 'hud', surface, component: 'AbovePrompt', props: { ...PROPS, bodyColumns: 38 } }))
    for (const text of ['5 Hour', 'Weekly', 'Context', 'Messages', 'Tools', 'Other']) expect(await ui.find({ text })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'compact' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /left$/ }))?.props.wrap).toBe('wrap')
    await ui.press({ key: 'expand' })
    // folded, the narrow line keeps the figures and the controls, not the words
    expect((await ui.findAll({ type: 'Text' })).filter(t => t.text === 'Context')).toHaveLength(0)
    expect(await ui.find({ type: 'Button', key: 'compact' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\d\d:\d\d$/ })).toBeUndefined()
    if (surface === 'desktop') expect(await ui.find({ type: 'Svg', alt: 'Gauge: context 16% used' })).toBeDefined()
    else expect(await ui.find({ type: 'Text', text: '16%' })).toBeDefined()
    for (const key of ['auto', 'compact', 'expand']) expect(await ui.find({ type: 'Button', key })).toBeDefined()
    await ui.unmount()
  }
})

test('the desktop in light mode draws in the light palette', async ($, on) => {
  const clock = startWorld(on, { value: 16 }, [])
  on('env.get', (_$, e) => ({ value: (e as unknown as { name: string }).name === 'APPDATA' ? 'C:/AppData' : undefined }) as never)
  // the settings file is read only when its time changes
  let reads = 0
  let mtimeMs = 1
  on('fs.stat', () => ({ value: { kind: 'file', size: 100, mtimeMs, isLink: false } }) as never)
  on('fs.read', () => (reads++, { value: JSON.stringify({ userThemeMode: 'light' }) }) as never)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  await clock.advance(2_000)
  const ui = await opened(await $.ui.mount({ plugin: 'hud', surface: 'desktop', component: 'AbovePrompt', props: PROPS }))
  const weeklyBar = (await ui.findAll({ type: 'Svg' })).find(svg => /^Weekly/.test(String(svg.props.alt)))
  expect(String(weeklyBar?.props.source)).toContain('fill="#22b856"')
  const before = reads
  await clock.advance(10_000)
  expect(reads).toBe(before)
  mtimeMs = 2
  await clock.advance(2_000)
  expect(reads).toBe(before + 1)
  await ui.unmount()
})

test('early in a window the forecast starts from the usual pace: a quick 4% does not turn it red', async ($, on) => {
  // 4% in the first 10 minutes: alone that runs to 120%; with the usual pace, 60%
  world(on, [{ kind: 'five_hour', percentUsed: 4, resetsAt: iso(5 * HOUR - 10 * MIN) }])
  await $.session.measure(MEASURE)
  const ui = await opened(await $.ui.mount({ plugin: 'hud', surface: 'desktop', component: 'AbovePrompt', props: PROPS }))
  expect(await ui.find({ text: /^At this pace|^Limit reached/ })).toBeUndefined()
  expect((await ui.findAll({ type: 'Svg' })).some(svg => String(svg.props.alt).endsWith('on pace for about 60% by reset'))).toBe(true)
  expect(await ui.find({ text: /^4h.50m.left$/ })).toBeDefined()
  await ui.unmount()
})

test('the usual pace is learned from how far past windows got', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  // the last window peaked at 20%, and two before it did too
  mock.store(on, { pace: { finals: { five_hour: [20, 20] }, windows: { five_hour: { resetsAt: NOW - HOUR, peak: 20, skip: 0 } } } })
  on('session.usage', () => ({ value: usage([{ kind: 'five_hour', percentUsed: 4, resetsAt: iso(5 * HOUR - 10 * MIN) }]) }))
  answerRest(on, [])
  await clock.advance(1)
  await $.session.measure(MEASURE)
  const ui = await opened(await $.ui.mount({ plugin: 'hud', surface: 'desktop', component: 'AbovePrompt', props: PROPS }))
  // usual 20%: 4% + about 31% more
  expect((await ui.findAll({ type: 'Svg' })).some(svg => String(svg.props.alt).endsWith('on pace for about 35% by reset'))).toBe(true)
  expect(await ui.find({ text: /^4h.50m.left$/ })).toBeDefined()
  await ui.unmount()
})

test("a reopened chat's first reply, re-reading its history, is left out of the pace", async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  // opened with 97k of history and no reply yet; an hour into the 5 hour window, at 10%
  const state = { tokens: undefined as number | undefined, percent: 10 }
  on('session.usage', () => {
    const u = usage([{ kind: 'five_hour', percentUsed: state.percent, resetsAt: iso(4 * HOUR) }])
    return { value: { ...u, context: { ...u.context, tokens: state.tokens } } }
  })
  answerRest(on, [])
  on('turn.start', () => ({ turnId: 't1' }))
  on('turn.complete', () => ({ text: '' }))
  await $.session.measure(MEASURE)
  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  await clock.advance(1_000)
  // the first reply re-reads it all: 10% to 30% at once
  state.tokens = 158_000
  state.percent = 30
  await $.session.measure(MEASURE)
  await $.turn.complete(TURN)
  const ui = await opened(await $.ui.mount({ plugin: 'hud', surface: 'desktop', component: 'AbovePrompt', props: PROPS }))
  // paced on the 10% of real use, not 30%: on track at about 70%, not running out
  expect(await ui.find({ text: /^At this pace|^Limit reached/ })).toBeUndefined()
  expect((await ui.findAll({ type: 'Svg' })).some(svg => /battery: 30% used$/.test(String(svg.props.alt)))).toBe(true)
  expect((await ui.findAll({ type: 'Svg' })).some(svg => String(svg.props.alt).endsWith('on pace for about 70% by reset'))).toBe(true)
  expect(await ui.find({ text: /^4h.left$/ })).toBeDefined()

  // later replies count in full
  await $.turn.start({ text: 'more', turnId: 't2' } as never)
  await clock.advance(1_000)
  state.percent = 50
  await $.session.measure(MEASURE)
  expect(await ui.find({ text: /^At this pace you'll run out/ })).toBeDefined()
  await ui.unmount()
})

test('a limit bar and its % turn amber from 75% used and red from 90%, even on track', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const state = { percent: 74 }
  // 2 hours before Weekly resets: on track at any of these
  on('session.usage', () => ({ value: usage([{ kind: 'seven_day', percentUsed: state.percent, resetsAt: iso(2 * HOUR) }]) }))
  answerRest(on, [])
  for (const [percent, color] of [[74, '#4ade80'], [75, '#fbbf24'], [89, '#fbbf24'], [90, '#f87171']] as const) {
    state.percent = percent
    await clock.advance(1_000)
    await $.session.measure(MEASURE)
    const ui = await opened(await $.ui.mount({ plugin: 'hud', surface: 'desktop', component: 'AbovePrompt', props: PROPS }))
    expect(await ui.find({ text: /^At this pace|^Limit reached/ })).toBeUndefined()
    const battery = (await ui.findAll({ type: 'Svg' })).find(svg => svg.props.alt === `Weekly battery: ${percent}% used`)
    expect(String(battery?.props.source)).toContain(`fill="${color}"`)
    await ui.unmount()
  }
})

test('Context turns amber from 50% and red from 80%', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const state = { percent: 49 }
  on('session.usage', () => {
    const u = usage([])
    return { value: { ...u, context: { ...u.context, percent: state.percent } } }
  })
  answerRest(on, [])
  for (const [percent, color] of [[49, '#4ade80'], [50, '#fbbf24'], [79, '#fbbf24'], [80, '#f87171']] as const) {
    state.percent = percent
    await clock.advance(1_000)
    await $.session.measure(MEASURE)
    const ui = await opened(await $.ui.mount({ plugin: 'hud', surface: 'desktop', component: 'AbovePrompt', props: PROPS }))
    const gauge = (await ui.findAll({ type: 'Svg' })).find(svg => svg.props.alt === `Gauge: context ${percent}% used`)
    expect(String(gauge?.props.source)).toContain(`fill="${color}"`)
    await ui.unmount()
  }
})





test('the details: a rate per hour and per day, auto compact marked on the context bar, no tooltips, old figures said so', async ($, on) => {
  const percent = { value: 16 }
  const clock = startWorld(on, percent, [])
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true })
  await $.session.measure(MEASURE)
  const ui = await opened(await $.ui.mount({ plugin: 'hud', surface: 'desktop', component: 'AbovePrompt', props: PROPS }))
  const bars = async () => (await ui.findAll({ type: 'Svg' })).filter(svg => !/ battery: |^Gauge: /.test(String(svg.props.alt)))
  // nothing under the pointer: no tooltips, plain images
  for (const svg of await bars()) {
    expect(svg.props.isInteractive).toBeUndefined()
    expect(String(svg.props.source)).not.toContain('<title>')
  }
  // Weekly at 10%, 4 days into its 7: 2.5% a day
  expect(await ui.find({ text: '~2.5%/day' })).toBeDefined()
  const context = async () => (await bars()).find(svg => /^Context/.test(String(svg.props.alt)))
  expect(await ui.find({ text: /^auto \d+%$/ })).toBeUndefined()
  // auto compact on: its % marked on the context bar in the accent colour, and said
  await ui.press({ key: 'auto' })
  await ui.input({ key: await fieldKey(ui), text: '40' })
  await clock.advance(1_100)
  expect(String((await context())?.props.source)).toContain('fill="#60a5fa"')
  expect(await ui.find({ text: 'auto 40%' })).toBeDefined()
  // fresh figures say nothing of their age; after 10 minutes with no reply they do
  expect(await ui.find({ text: /^Usage figures from/ })).toBeUndefined()
  await clock.advance(11 * MIN)
  expect(await ui.find({ text: /^Usage figures from 1\dm ago/ })).toBeDefined()
  // a reply brings the same figures again: fresh once more
  await $.turn.complete(TURN)
  await clock.advance(1_100)
  expect(await ui.find({ text: /^Usage figures from/ })).toBeUndefined()
  await ui.unmount()
})

test('a 5 hour window shows its rate per hour, and a dash in its first 15 minutes', async ($, on) => {
  world(on, [{ kind: 'five_hour', percentUsed: 12, resetsAt: iso(3 * HOUR) }])
  await $.session.measure(MEASURE)
  const ui = await opened(await $.ui.mount({ plugin: 'hud', surface: 'desktop', component: 'AbovePrompt', props: PROPS }))
  // 12% over its first 2 hours
  expect(await ui.find({ text: '~6%/h' })).toBeDefined()
  await ui.unmount()
})

test('a window under 15 minutes old shows a dash for its rate', async ($, on) => {
  world(on, [{ kind: 'five_hour', percentUsed: 3, resetsAt: iso(5 * HOUR - 10 * MIN) }])
  await $.session.measure(MEASURE)
  const ui = await opened(await $.ui.mount({ plugin: 'hud', surface: 'desktop', component: 'AbovePrompt', props: PROPS }))
  expect(await ui.find({ text: '~–%/h' })).toBeDefined()
  await ui.unmount()
})
