import { expect, it, vi } from 'vitest'
import { ResearchSession } from '../src/ResearchSession.js'
import { DEMO_INSTRUCTION, fixtureRequest } from '../src/services.js'

const packing = id => ({ type: 'PACKING_AREA', id })

it('clarifies ambiguous cargo, destination and speed, including insufficient answers', async () => {
  const session = new ResearchSession()
  session.setMode('replay')
  await session.send(DEMO_INSTRUCTION)
  expect(session.question.category).toBe('cargo')
  await session.send('All of them')
  expect(session.question.category).toBe('cargo')
  expect(session.history[0].sufficient).toBe(false)
  await session.send('A2 (blue)')
  expect(session.question.category).toBe('destination')
  await session.send('Packing Area 2')
  expect(session.question.category).toBe('speed')
  await session.send('Maximum safe speed')
  expect(session.engine.phase).toBe('READY')
  expect(session.engine.task).toMatchObject({ target: 'A2', destination: packing('Packing Area 2'), transport_speed_mps: 0.8 })
  expect(session.engine.stats().clarification_rounds).toBe(4)
})

it('stages an unambiguous task with no unnecessary questions or readiness request', async () => {
  const request = vi.fn(async operation => ({
    response: operation === 'analyze' ? { ambiguities: [] } : {
      target: 'A2', source: 'Shelf A', destination: packing('Packing Area 2'), transport_speed_mps: 0.8,
      destination_policy: 'FIXED', delegation_evidence: '',
    },
    model: 'test', prompt_version: 'test', latency_ms: 0,
  }))
  const session = new ResearchSession(request)
  await session.send('Deliver A2 to Packing Area 2 at the maximum safe speed.')
  expect(session.engine.phase).toBe('READY')
  expect(session.engine.stats().clarification_rounds).toBe(0)
  expect(request.mock.calls.map(call => call[0])).toEqual(['analyze', 'task'])
})

it('retries an initial API failure without duplicating the instruction', async () => {
  const request = vi.fn(fixtureRequest).mockRejectedValueOnce(new Error('Temporary failure'))
  const session = new ResearchSession(request)
  await session.send(DEMO_INSTRUCTION)
  expect(session.error).toBe('Temporary failure')
  expect(session.engine.start()).toBe(false)
  expect(session.engine.time).toBe(0)
  await session.retry()
  expect(session.question.category).toBe('cargo')
  expect(session.messages.filter(message => message.role === 'user')).toHaveLength(1)
  expect(session.engine.log.some(entry => entry.kind === 'gemini_error')).toBe(true)
})

it('holds on runtime API failure, retries the same event, and accepts a typed redirect', async () => {
  let runtimeCalls = 0
  const request = vi.fn(async (operation, context, signal) => {
    if (operation === 'runtime' && runtimeCalls++ === 0) throw new Error('Runtime request failed')
    return fixtureRequest(operation, context, signal)
  })
  const session = new ResearchSession(request)
  await session.send(DEMO_INSTRUCTION)
  for (const answer of ['A2 (blue)', 'Packing Area 2', 'Maximum safe speed']) await session.send(answer)
  session.control(engine => {
    engine.scheduleEvent({ kind: 'area', area: 'Packing Area 2', value: false }, { type: 'phase', phase: 'MOVING_TO_DESTINATION' })
    engine.start()
    while (engine.phase !== 'MOVING_TO_DESTINATION') engine.step()
  })
  await vi.waitFor(() => expect(session.error).toBe('Runtime request failed'))
  expect(session.engine.step()).toBe(false)
  expect(session.engine.carrying).toBe('A2')
  await session.retry()
  expect(session.engine.visiblePhase).toBe('AWAITING_USER')
  await session.send('Yes, use Packing Area 1 instead.')
  expect(session.engine.task.destination).toEqual(packing('Packing Area 1'))
  expect(session.engine.step()).toBe(true)
})

it('ignores a response from a reset experiment', async () => {
  let finish
  const request = () => new Promise(resolve => { finish = resolve })
  const session = new ResearchSession(request)
  const pending = session.send(DEMO_INSTRUCTION)
  session.reset()
  finish({ response: { ambiguities: [] } })
  await pending
  expect(session.engine.phase).toBe('IDLE')
  expect(session.messages).toEqual([])
})

it('rechecks unresolved parameters when a free-form answer provides multiple fields', async () => {
  const request = vi.fn(async (operation, context, signal) => {
    if (operation === 'evaluate') return { response: { sufficient: true, reason: 'Complete answer', follow_up_question: '' } }
    if (operation === 'analyze' && context.history.length) return { response: { ambiguities: [] } }
    if (operation === 'task') return { response: {
      target: 'A2', source: 'Shelf A', destination: packing('Packing Area 2'), transport_speed_mps: 0.6,
      destination_policy: 'FIXED', delegation_evidence: '',
    } }
    return fixtureRequest(operation, context, signal)
  })
  const session = new ResearchSession(request)
  await session.send(DEMO_INSTRUCTION)
  await session.send('Use A2 for Packing Area 2 at 0.6 m/s.')
  expect(session.engine.phase).toBe('READY')
  expect(session.engine.stats().clarification_rounds).toBe(1)
})

it('exposes labeled one-shot replay faults and returns to the normal fixture after retry', async () => {
  const session = new ResearchSession()
  session.setMode('replay')
  session.setFixtureFault('api')
  await session.send(DEMO_INSTRUCTION)
  expect(session.error).toMatch(/Simulated Gemini API failure/)
  await session.retry()
  for (const answer of ['A2 (blue)', 'Packing Area 2', 'Maximum safe speed']) await session.send(answer)
  session.setFixtureFault('decision')
  session.control(engine => {
    engine.start()
    engine.inject({ kind: 'area', area: 'Packing Area 2', value: false })
  })
  await vi.waitFor(() => expect(session.error).toMatch(/Runtime proposal rejected/))
  expect(session.engine.step()).toBe(false)
  await session.retry()
  expect(session.engine.visiblePhase).toBe('AWAITING_USER')
  expect(session.engine.log.filter(event => event.kind === 'fixture_fault_applied')).toHaveLength(2)
})

it('suppresses a spurious destination question when the operator delegated the choice', async () => {
  const request = vi.fn(async operation => ({
    response: operation === 'analyze' ? { ambiguities: [{
      category: 'destination', text: 'any available packing area', reason: 'Two areas are open',
      missing_information: 'destination', question: 'Which area?', options: ['Packing Area 1', 'Packing Area 2'],
    }] } : {
      target: 'A2', source: 'Shelf A', destination: packing('Packing Area 1'), transport_speed_mps: 0.8,
      destination_policy: 'FIXED', delegation_evidence: '',
    },
  }))
  const session = new ResearchSession(request)
  await session.send('Deliver A2 to any available packing area at the maximum safe speed.')
  expect(session.engine.task.destination_policy).toBe('DELEGATED')
  expect(session.question).toBeNull()
  expect(session.engine.log.some(event => event.kind === 'destination_policy_corrected')).toBe(true)
})

it('delivers the screenshot instruction with a legacy packing-area response', async () => {
  const instruction = 'transport A2 to packaging area 2 at 0.6'
  const request = vi.fn(async operation => {
    if (operation === 'analyze') {
      const questions = ['destination', 'speed'].map(category => ({
        category, text: category, reason: 'Test ambiguity', missing_information: category,
        question: `What is the ${category}?`, options: [],
      }))
      return { response: { ambiguities: questions } }
    }
    return {
      response: {
        target: 'A2', source: 'Shelf A', destination: 'Packing Area 2',
        transport_speed_mps: null, destination_policy: 'FIXED', delegation_evidence: '',
      },
      prompt_version: 'warehouse-1.1.0',
    }
  })
  const session = new ResearchSession(request)
  await session.send(instruction)
  expect(session.error).toBeNull()
  expect(session.question).toBeNull()
  expect(session.engine.task).toMatchObject({
    target: 'A2', destination: packing('Packing Area 2'), transport_speed_mps: 0.6,
  })
  expect(request.mock.calls.map(([operation]) => operation)).toEqual(['analyze', 'task'])
  expect(session.engine.start()).toBe(true)
  for (let i = 0; i < 1000 && session.engine.active; i++) expect(session.engine.step()).toBe(true)
  expect(session.engine.delivered).toBe('A2')
  expect(session.engine.cell).toEqual([8, 8])
})
