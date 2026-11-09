import { describe, expect, it } from 'vitest'
import { WarehouseEngine } from '../src/simulation/WarehouseEngine.js'
import { AREAS, CARGO, CONGESTION, FIXED_BLOCKS, PICKUP, START, cellKey, distance, findPath } from '../src/simulation/warehouse.js'
import { destinationIntent, runtimeAuthorization, speedIntentIssue, validateTask } from '../src/simulation/validation.js'

const P1 = 'Packing Area 1'
const P2 = 'Packing Area 2'
const packing = id => ({ type: 'PACKING_AREA', id })
const task = { target: 'A2', source: 'Shelf A', destination: packing(P2), transport_speed_mps: 0.8, destination_policy: 'FIXED' }
const change = (kind, value, area = P2) => ({ kind, area, value })
const aisle = (cell, value = true) => ({ kind: 'aisle', cell, value })

function runUntil(engine, predicate, limit = 1500) {
  for (let i = 0; i < limit && !predicate(); i++) {
    if (!engine.step()) break
  }
  expect(predicate()).toBe(true)
}

function ready(overrides = {}) {
  const engine = new WarehouseEngine()
  expect(engine.stage({ ...task, ...overrides })).toEqual([])
  return engine
}

function startTransport(engine) {
  expect(engine.start()).toBe(true)
  runUntil(engine, () => engine.phase === 'MOVING_TO_DESTINATION')
}

function assessment(engine, action, alternative = null) {
  const situation = engine.hold.situation
  return {
    action, reason: 'Fixture assessment', triggering_event: situation.kind,
    affects_active_task: true, original_intent_executable: action === 'REPLAN',
    autonomous_adaptation_possible: action === 'REPLAN', uncertainty_category: 'ROUTE_FEASIBILITY',
    clarification_needed: action === 'ASK_USER', requires_authorization: action === 'ASK_USER',
    proposed_alternative: alternative ? packing(alternative) : null, clarification_question: action === 'ASK_USER' ? 'Redirect or wait?' : '',
  }
}

describe('Python warehouse and deterministic motion', () => {
  it('uses the exact geometry, risk limit, and A* tie order', () => {
    expect(Object.values(CARGO).every(item => item.fragile)).toBe(true)
    expect(AREAS[P1].cell).toEqual([1, 8])
    expect(AREAS[P2].cell).toEqual([8, 8])
    expect(CONGESTION).toEqual([[3, 6], [4, 6], [7, 6]])
    expect(findPath(START, PICKUP)).toEqual([[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [6, 0], [6, 1], [6, 2]])
    const route = findPath(PICKUP, AREAS[P2].cell)
    expect(route.every((cell, index) => !FIXED_BLOCKS.has(cellKey(cell)) && (!index || distance(route[index - 1], cell) === 1))).toBe(true)
    expect(findPath(START, PICKUP, new Set(['0,1', '1,0']))).toBeNull()
    expect(findPath([-1, 0], PICKUP)).toBeNull()
    expect(findPath(PICKUP, PICKUP)).toEqual([PICKUP])
  })

  it('rejects invalid tasks and unsafe or invented speeds', () => {
    const engine = new WarehouseEngine()
    expect(validateTask(task, engine.knowledge, START)).toEqual([])
    for (const speed of [0.80001, 0, -1, NaN, Infinity, '0.8', null]) {
      expect(validateTask({ ...task, transport_speed_mps: speed }, engine.knowledge, START)).not.toEqual([])
    }
    expect(validateTask({ ...task, target: 'all', source: 'Shelf B', destination: 'Worker 2' }, engine.knowledge, START)).toHaveLength(3)
    expect(speedIntentIssue('Deliver A2 quickly.', [], 0.8)).toBeTruthy()
    expect(speedIntentIssue('Deliver A2 at .7 m/s.', [], 0.7)).toBeNull()
    expect(speedIntentIssue('Deliver A2 at maximum safe speed.', [], 0.8)).toBeNull()
  })

  it('delivers deterministically for the same schedule and freezes on pause', () => {
    const execute = () => {
      const engine = ready()
      engine.scheduleEvent(change('area', false, P1), { type: 'time', time: 7.03 })
      engine.start()
      for (let i = 0; i < 27; i++) engine.step()
      engine.setPaused(true)
      const before = engine.time
      expect(engine.step()).toBe(false)
      expect(engine.time).toBe(before)
      engine.setPaused(false)
      runUntil(engine, () => engine.phase === 'COMPLETED')
      expect(engine.delivered).toBe('A2')
      const event = engine.log.find(entry => entry.kind === 'environment_event')
      expect(event.sim_time_s).toBe(7.05)
      return engine.log.filter(entry => entry.kind !== 'simulation_started')
    }
    expect(execute()).toEqual(execute())
  })
})

describe('runtime monitoring and authorization', () => {
  it('pauses at a sensed obstruction and executes a validated replan to the same destination', () => {
    const engine = ready()
    startTransport(engine)
    const next = engine.path[0]
    expect(engine.inject(aisle(next))).toBeNull()
    const { id, situation } = engine.hold
    expect(situation).toMatchObject({ kind: 'AISLE_BLOCKED', currentRouteUsable: false, sameGoalRouteExists: true })
    expect(situation).not.toHaveProperty('allowed')
    expect(engine.step()).toBe(false)
    expect(engine.replans).toBe(0)
    expect(engine.assess(id, assessment(engine, 'REPLAN'))).toEqual({ ok: true })
    expect(engine.replans).toBe(1)
    expect(engine.hold).toBeNull()
    expect(engine.task.destination).toEqual(packing(P2))
    expect(engine.path.map(cellKey)).not.toContain(cellKey(next))
    runUntil(engine, () => engine.delivered === 'A2')
  })

  it('ignores an unrelated observed closure and does not reason from an unseen aisle block', () => {
    const engine = ready()
    engine.inject(aisle([7, 8]))
    expect(engine.knowledge.blocked.has('7,8')).toBe(false)
    startTransport(engine)
    engine.inject(change('area', false, P1))
    expect(engine.hold).toBeNull()
    expect(engine.log.some(entry => entry.kind === 'runtime_assessment_skipped')).toBe(true)
    expect(engine.log.some(entry => entry.kind === 'runtime_assessment_requested')).toBe(false)
  })

  it('waits when stranded and resumes after local recovery', () => {
    const engine = ready()
    engine.start()
    engine.inject(aisle([0, 1]))
    engine.inject(aisle([1, 0]))
    const { id } = engine.hold
    expect(engine.hold.situation).toMatchObject({ kind: 'AISLE_BLOCKED', sameGoalRouteExists: false })
    expect(engine.assess(id, assessment(engine, 'WAIT'))).toEqual({ ok: true })
    engine.step()
    expect(engine.stats().waiting_time_s).toBe(0.05)
    engine.inject(aisle([0, 1], false))
    expect(engine.hold.id).not.toBe(id)
    expect(engine.hold.situation.sameGoalRouteExists).toBe(true)
    expect(engine.assess(engine.hold.id, assessment(engine, 'REPLAN'))).toEqual({ ok: true })
    runUntil(engine, () => engine.delivered === 'A2')
  })

  it('pauses when the fixed destination closes and resumes only after valid authorization', () => {
    const engine = ready()
    engine.scheduleEvent(change('area', false), { type: 'phase', phase: 'MOVING_TO_DESTINATION' })
    startTransport(engine)
    const { id } = engine.hold
    expect(engine.carrying).toBe('A2')
    expect(engine.visiblePhase).toBe('AWAITING_ASSESSMENT')
    expect(engine.step()).toBe(false)
    expect(engine.authorize(id, { choice: 'REDIRECT', destination: packing(P1) })).toEqual({ stale: true })
    expect(engine.assess(id, assessment(engine, 'ASK_USER', P1))).toEqual({ ok: true })
    expect(engine.visiblePhase).toBe('AWAITING_USER')
    expect(engine.step()).toBe(false)
    expect(engine.authorize(id, { choice: 'REDIRECT', destination: packing(P2) }).issue).toBeTruthy()
    expect(engine.task.destination).toEqual(packing(P2))
    expect(engine.authorize(id, { choice: 'REDIRECT', destination: packing(P1) })).toEqual({ ok: true })
    runUntil(engine, () => engine.delivered === 'A2')
    expect(engine.cell).toEqual(AREAS[P1].cell)
  })

  it('automatically redirects only a delegated destination choice', () => {
    expect(destinationIntent('Deliver A2 to any available packing area.', []).policy).toBe('DELEGATED')
    expect(destinationIntent('Deliver A2 to Packing Area 2.', [])).toEqual({ policy: 'FIXED', type: 'PACKING_AREA', named: packing(P2) })
    expect(destinationIntent('Do not use any available packing area.', []).policy).toBe('FIXED')
    const engine = ready({ destination_policy: 'DELEGATED' })
    startTransport(engine)
    engine.inject(change('area', false))
    expect(engine.assess(engine.hold.id, assessment(engine, 'REPLAN', P1))).toEqual({ ok: true })
    runUntil(engine, () => engine.delivered === 'A2')
    expect(engine.task.destination).toEqual(packing(P1))
    expect(engine.log.some(entry => entry.kind === 'destination_changed' && entry.data.authorization === 'delegated')).toBe(true)
  })

  it('distinguishes a busy receiver from a closed site and waits for timed recovery', () => {
    const engine = ready()
    startTransport(engine)
    engine.inject(change('receiver', false))
    expect(engine.world.areas[P2].open).toBe(true)
    expect(engine.hold.situation.nearHandover).toBe(false)
    expect(engine.assess(engine.hold.id, assessment(engine, 'CONTINUE'))).toEqual({ ok: true })
    runUntil(engine, () => engine.hold?.situation.kind === 'RECEIVER_BUSY')
    expect(distance(engine.cell, AREAS[P2].cell)).toBe(1)
    expect(engine.assess(engine.hold.id, assessment(engine, 'CONTINUE')).issue).toMatch(/unsafe/)
    engine.scheduleEvent(change('receiver', true), { type: 'time', time: engine.time + 2 })
    expect(engine.assess(engine.hold.id, assessment(engine, 'WAIT'))).toEqual({ ok: true })
    expect(engine.delivered).toBeNull()
    runUntil(engine, () => engine.delivered === 'A2')
    expect(engine.stats().waiting_time_s).toBe(2)
  })

  it('rejects an invalid Gemini redirect and keeps the robot safely held', () => {
    const engine = ready()
    startTransport(engine)
    engine.inject(change('area', false))
    const { id } = engine.hold
    expect(engine.assess(id, assessment(engine, 'REPLAN', P1)).issue).toMatch(/requires operator authorization/)
    expect(engine.visiblePhase).toBe('AWAITING_ASSESSMENT')
    expect(engine.step()).toBe(false)
    expect(engine.task.destination).toEqual(packing(P2))
    expect(engine.delivered).toBeNull()
  })

  it('invalidates stale Gemini results when the original area reopens', () => {
    const engine = ready()
    startTransport(engine)
    engine.inject(change('area', false))
    const { id } = engine.hold
    const decision = assessment(engine, 'ASK_USER', P1)
    engine.inject(change('area', true))
    expect(engine.assess(id, decision)).toEqual({ stale: true })
    runUntil(engine, () => engine.delivered === 'A2')
    expect(engine.cell).toEqual(AREAS[P2].cell)
  })

  it('binds affirmative evidence to the current choice and rejects invented or unavailable destinations', () => {
    const choice = { choice: 'REDIRECT', destination: packing(P1) }
    const interpret = (answer, overrides = {}, pending = null) => runtimeAuthorization(answer, {
      classification: 'CLEAR_AUTHORIZATION', ...choice, evidence: answer, ...overrides,
    }, { alternatives: [packing(P1)], destination: packing(P2) }, pending)
    expect(interpret('Yes, use Packing Area 1 instead.')).toEqual({ authorization: choice })
    expect(interpret('Yes', {}, choice)).toEqual({ authorization: choice })
    expect(interpret('delivery to work 1')).toEqual({ confirmation: choice })
    expect(interpret('No', {}, choice)).toEqual({ rejected: true })
    expect(interpret('Yes').authorization).toBeUndefined()
    expect(interpret('Yes', { destination: packing(P2) }, choice).issue).toMatch(/unavailable/)
    expect(interpret('Maybe Packing Area 1.').authorization).toBeUndefined()
    expect(interpret('Use Packing Area 1', { evidence: 'invented' }).issue).toMatch(/did not cite/)
  })
})

it('keeps an explicit wait choice when alternatives change', () => {
  const engine = ready()
  startTransport(engine)
  engine.inject(change('area', false))
  const { id } = engine.hold
  engine.assess(id, assessment(engine, 'ASK_USER', P1))
  engine.authorize(id, { choice: 'WAIT' })
  engine.inject(change('area', false, P1))
  expect(engine.hold.id).toBe(id)
  expect(engine.visiblePhase).toBe('WAITING')
  engine.inject(change('area', true))
  runUntil(engine, () => engine.delivered === 'A2')
  expect(engine.task.destination).toEqual(packing(P2))
})
