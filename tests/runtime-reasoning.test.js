import { expect, it, vi } from 'vitest'
import { ResearchSession } from '../src/ResearchSession.js'
import { fixtureRequest } from '../src/services.js'

const area1 = 'Packing Area 1'
const area2 = 'Packing Area 2'
const packing = id => ({ type: 'PACKING_AREA', id })
const close = area => ({ kind: 'area', area, value: false })

function transporting(request, policy = 'FIXED') {
  const session = new ResearchSession(request)
  session.instruction = policy === 'FIXED' ? `Deliver A2 to ${area2} at 0.8 m/s.` :
    'Deliver A2 to any available packing area at 0.8 m/s.'
  session.control(engine => {
    expect(engine.stage({ target: 'A2', source: 'Shelf A', destination: packing(area2), transport_speed_mps: 0.8, destination_policy: policy })).toEqual([])
    expect(engine.start()).toBe(true)
    for (let steps = 0; steps < 300 && engine.phase !== 'MOVING_TO_DESTINATION'; steps++) expect(engine.step()).toBe(true)
    expect(engine.phase).toBe('MOVING_TO_DESTINATION')
  })
  return session
}

async function settle(session) {
  await vi.waitFor(() => expect(session.running).toBeNull())
  expect(session.error).toBeNull()
}

function deliver(session, destination) {
  for (let steps = 0; steps < 700 && session.engine.phase !== 'COMPLETED'; steps++) {
    expect(session.control(engine => engine.step())).toBe(true)
  }
  expect(session.engine.delivered).toBe('A2')
  expect(session.engine.task.destination).toEqual(packing(destination))
}

it('A: assesses a fixed closure, then confirms a plausible free-text redirect before acting', async () => {
  const request = vi.fn(fixtureRequest)
  const session = transporting(request)
  session.control(engine => engine.inject(close(area2)))
  await settle(session)
  const holdId = session.engine.hold.id
  expect(session.question.question).toMatch(/Packing Area 1/)
  expect(session.engine.visiblePhase).toBe('AWAITING_USER')
  await session.send('delivery to work 1')
  expect(session.question.question).toBe('Do you mean Packing Area 1?')
  expect(session.question.runtimeId).toBe(holdId)
  expect(session.engine.task.destination).toEqual(packing(area2))
  expect(session.engine.step()).toBe(false)
  await session.send('Yes')
  expect(session.question).toBeNull()
  deliver(session, area1)
  expect(request.mock.calls.map(([operation]) => operation)).toEqual(['runtime', 'authorize', 'authorize'])
  expect(request.mock.calls[2][1].question.confirmation).toEqual({ choice: 'REDIRECT', destination: packing(area1) })
  const events = session.engine.log
  expect(events.find(e => e.kind === 'runtime_reply_interpreted').data.interpretation.classification).toBe('INCOMPLETE_OR_AMBIGUOUS')
  for (const kind of ['environment_event', 'observed_environment_state', 'runtime_action_suggested', 'runtime_reasoning',
    'clarification_necessity', 'runtime_validation', 'runtime_decision_executed', 'runtime_reply_interpreted', 'authorization_validation']) {
    expect(events.some(e => e.kind === kind && e.data.source)).toBe(true)
  }
  expect(events.findLast(e => e.kind === 'runtime_decision_executed').data).toMatchObject({
    action: 'REPLAN', source: 'combined', proposer: 'gemini', authorization: 'operator',
  })
})

it('B: replans to a viable alternative under verified delegation without asking', async () => {
  const request = vi.fn(fixtureRequest)
  const session = transporting(request, 'DELEGATED')
  session.control(engine => engine.inject(close(area2)))
  await settle(session)
  expect(session.question).toBeNull()
  deliver(session, area1)
  expect(request.mock.calls.map(([operation]) => operation)).toEqual(['runtime'])
  expect(session.engine.log.find(e => e.kind === 'clarification_necessity').data.needed).toBe(false)
})

it('C: calls the model once for a route obstruction and keeps the goal when replanning', async () => {
  const request = vi.fn(fixtureRequest)
  const session = transporting(request)
  const block = session.engine.path[0]
  session.control(engine => engine.inject({ kind: 'aisle', cell: block, value: true }))
  await settle(session)
  expect(session.question).toBeNull()
  expect(session.engine.replans).toBe(1)
  expect(session.engine.path).not.toContainEqual(block)
  deliver(session, area2)
  expect(request.mock.calls.map(([operation]) => operation)).toEqual(['runtime'])
  expect(request.mock.calls[0][1].situation).toMatchObject({
    kind: 'AISLE_BLOCKED', currentRouteUsable: false, sameGoalRouteExists: true,
  })
})

it('executes a safe alternative model judgment and records a safety override for an unauthorized redirect', async () => {
  const request = vi.fn(async (operation, context, signal) => {
    const fixture = await fixtureRequest(operation, context, signal)
    if (operation === 'runtime') fixture.response = {
      ...fixture.response, action: 'WAIT', reason: 'The operator preferred to wait.',
      proposed_alternative: null, clarification_needed: false, requires_authorization: false, clarification_question: '',
    }
    return fixture
  })
  const waiting = transporting(request)
  waiting.instruction += ' Wait if the area closes.'
  waiting.control(engine => engine.inject(close(area2)))
  await settle(waiting)
  expect(waiting.engine.visiblePhase).toBe('WAITING')
  expect(waiting.question).toBeNull()

  const unsafe = transporting(async (operation, context, signal) => {
    const fixture = await fixtureRequest(operation, context, signal)
    fixture.response = { ...fixture.response, action: 'REPLAN', clarification_needed: false, requires_authorization: false }
    return fixture
  })
  unsafe.control(engine => engine.inject(close(area2)))
  await vi.waitFor(() => expect(unsafe.error).toMatch(/requires operator authorization/))
  expect(unsafe.engine.step()).toBe(false)
  expect(unsafe.engine.task.destination).toEqual(packing(area2))
  expect(unsafe.engine.log.find(e => e.kind === 'runtime_validation').data).toMatchObject({ accepted: false, overridden: true })
  expect(unsafe.engine.log.find(e => e.kind === 'runtime_decision_executed').data).toMatchObject({ action: 'HOLD', source: 'deterministic' })
})

it('leaves a refused or invalid reply on hold and never carries over a stale confirmation', async () => {
  const session = transporting(async (operation, context, signal) => {
    const result = await fixtureRequest(operation, context, signal)
    if (operation === 'authorize' && context.answer === 'Deliver it to Worker 1') {
      result.response = { ...result.response, classification: 'INVALID_REQUEST', choice: 'NONE', destination: null,
        follow_up_question: 'Worker 1 is outside this packing-area task. Which packing area did you mean?' }
    }
    return result
  })
  session.control(engine => engine.inject(close(area2)))
  await settle(session)
  await session.send('Deliver it to Worker 1')
  expect(session.question.question).toMatch(/Worker 1 is outside/)
  await session.send('delivery to work 1')
  await session.send('No')
  expect(session.question.question).toMatch(/wait.*stop/i)
  expect(session.engine.task.destination).toEqual(packing(area2))
  await session.send('delivery to work 1')
  expect(session.question.confirmation.destination).toEqual(packing(area1))
  session.control(engine => engine.inject(close(area1)))
  await settle(session)
  expect(session.question).toBeNull()
  expect(session.engine.task.destination).toEqual(packing(area2))
  expect(session.engine.visiblePhase).toBe('WAITING')
  expect(session.engine.log.filter(e => e.kind === 'runtime_reply_interpreted').map(e => e.data.interpretation.classification))
    .toEqual(['INVALID_REQUEST', 'INCOMPLETE_OR_AMBIGUOUS', 'CLEAR_REJECTION', 'INCOMPLETE_OR_AMBIGUOUS'])
})
