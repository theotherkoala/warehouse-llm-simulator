import { expect, it, vi } from 'vitest'
import { ResearchSession } from '../src/ResearchSession.js'
import { fixtureRequest } from '../src/services.js'
import { AREAS, WORKERS, atHandoverCell } from '../src/simulation/warehouse.js'

const worker1 = { type: 'WORKER', id: 'worker-1' }
const worker2 = { type: 'WORKER', id: 'worker-2' }
const area2 = { type: 'PACKING_AREA', id: 'Packing Area 2' }
const speed = 'at 0.8 m/s.'
const packingQuestion = {
  text: 'destination', category: 'destination', reason: 'Select a destination',
  missing_information: 'Destination', question: 'Which packing area?', options: ['Packing Area 1', 'Packing Area 2'],
}
const speedQuestion = {
  text: 'speed', category: 'speed', reason: 'No speed specified',
  missing_information: 'Speed', question: 'What speed?', options: ['0.8 m/s'],
}

async function request(operation, context, signal) {
  const result = response => ({ response, model: 'test' })
  if (operation === 'analyze') {
    return result({ ambiguities: [
      packingQuestion,
      ...(/m\/s/.test(context.instruction) || context.history.some(turn => turn.category === 'speed' && turn.sufficient) ? [] : [speedQuestion]),
    ] })
  }
  if (operation === 'evaluate') {
    return result({ sufficient: context.answer === '0.8 m/s', reason: 'Test interpretation', follow_up_question: '' })
  }
  if (operation === 'task') {
    return result({
      target: 'A1', source: 'Shelf A', destination: area2, transport_speed_mps: 0.8,
      destination_policy: 'FIXED', delegation_evidence: '',
    })
  }
  return fixtureRequest(operation, context, signal)
}

function advanceTo(engine, phase) {
  for (let steps = 0; steps < 1000 && engine.phase !== phase; steps++) expect(engine.step()).toBe(true)
  expect(engine.phase).toBe(phase)
}

function expectDelivery(engine, destination) {
  advanceTo(engine, 'COMPLETED')
  expect(engine.delivered).toBe('A1')
  expect(atHandoverCell(engine.cell, destination, engine.world)).toBe(true)
  expect(engine.log.find(entry => entry.kind === 'delivery_completed').data).toMatchObject({
    cargo: 'A1', destination, handover_cell: engine.cell,
  })
}

it.each(['Worker 1', 'the first worker'])('A: delivers to %s with only the missing speed question', async name => {
  const session = new ResearchSession(request)
  await session.send(`Transport A1 to ${name}.`)
  expect(session.question.category).toBe('speed')
  await session.send('0.8 m/s')
  expect(session.engine.task.destination).toEqual(worker1)
  expect(session.engine.start()).toBe(true)
  expectDelivery(session.engine, worker1)
  expect(session.engine.log.filter(entry => entry.kind === 'robot_entered_cell').map(entry => entry.data.cell))
    .not.toContainEqual(WORKERS['worker-1'].cell)
})

it('B and F: offers only workers, then retains the cargo when the user says I mean Worker 1', async () => {
  const session = new ResearchSession(request)
  await session.send(`Transport A1 to a worker ${speed}`)
  expect(session.question.question).toMatch(/which worker/i)
  expect(session.question.options).toEqual(['Worker 1', 'Worker 2'])
  await session.send('I mean Worker 1.')
  expect(session.question).toBeNull()
  expect(session.engine.task).toMatchObject({ target: 'A1', destination: worker1, transport_speed_mps: 0.8 })
})

it('keeps a worker correction given while asking for speed', async () => {
  const session = new ResearchSession(request)
  await session.send('Deliver A1 to Packing Area 2.')
  expect(session.question.category).toBe('speed')
  await session.send('Can you deliver it to Worker 1?')
  expect(session.question.category).toBe('speed')
  await session.send('0.8 m/s')
  expect(session.engine.task.destination).toEqual(worker1)
})

it.each([[true, worker1], [false, worker2]])('C: resolves the nearest reachable worker (Worker 1 available: %s)', async (available, expected) => {
  const session = new ResearchSession(request)
  session.engine.inject({ kind: 'worker', workerId: worker1.id, value: available })
  await session.send(`Transport A1 to the nearest available worker ${speed}`)
  expect(session.question).toBeNull()
  expect(session.engine.task.destination).toEqual(expected)
})

it('D: completes a packing-area task at its packing cell', async () => {
  const session = new ResearchSession(request)
  await session.send(`Deliver A1 to Packing Area 2 ${speed}`)
  expect(session.engine.start()).toBe(true)
  expectDelivery(session.engine, area2)
  expect(session.engine.cell).toEqual(AREAS[area2.id].cell)
})

it('E: holds when Worker 1 becomes unavailable and requires authorization before changing workers', async () => {
  const model = vi.fn(request)
  const session = new ResearchSession(model)
  await session.send(`Transport A1 to Worker 1 ${speed}`)
  expect(session.engine.start()).toBe(true)
  advanceTo(session.engine, 'MOVING_TO_DESTINATION')
  session.control(engine => engine.inject({ kind: 'worker', workerId: worker1.id, value: false }))
  expect(session.engine.step()).toBe(false)
  await vi.waitFor(() => expect(session.question?.options).toContain('Use Worker 2'))
  expect(session.question.options).not.toContain('Use Packing Area 2')
  const runtime = model.mock.calls.find(([operation]) => operation === 'runtime')[1]
  expect(runtime.situation).toMatchObject({ kind: 'WORKER_UNAVAILABLE', alternatives: [worker2] })
  expect(session.engine.world.areas['Packing Area 1'].receiverAvailable).toBe(true)
  expect(session.engine.delivered).toBeNull()
  await session.send('Use Worker 2')
  expectDelivery(session.engine, worker2)
})

it('keeps a fixed worker after the operator chooses to wait and the worker becomes available', async () => {
  const session = new ResearchSession(request)
  await session.send(`Transport A1 to Worker 1 ${speed}`)
  expect(session.engine.start()).toBe(true)
  advanceTo(session.engine, 'MOVING_TO_DESTINATION')
  session.control(engine => engine.inject({ kind: 'worker', workerId: worker1.id, value: false }))
  await vi.waitFor(() => expect(session.question?.options).toContain('Wait'))
  await session.send('Wait')
  expect(session.engine.visiblePhase).toBe('WAITING')
  expect(session.engine.delivered).toBeNull()
  session.control(engine => engine.inject({ kind: 'worker', workerId: worker1.id, value: true }))
  expectDelivery(session.engine, worker1)
})

it('keeps delegated worker selection within workers when the first worker becomes unavailable', async () => {
  const session = new ResearchSession(async (operation, context, signal) => {
    if (operation === 'task') {
      const result = await request(operation, context, signal)
      result.response.destination = worker1
      return result
    }
    return request(operation, context, signal)
  })
  await session.send(`Transport A1 to an available worker ${speed}`)
  expect(session.engine.task.destination_policy).toBe('DELEGATED')
  expect(session.engine.start()).toBe(true)
  advanceTo(session.engine, 'MOVING_TO_DESTINATION')
  session.control(engine => engine.inject({ kind: 'worker', workerId: worker1.id, value: false }))
  await vi.waitFor(() => expect(session.engine.task.destination).toEqual(worker2))
  expect(session.question).toBeNull()
  expectDelivery(session.engine, worker2)
})
