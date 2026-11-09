import {
  AREAS, FIXED_BLOCKS, PICKUP, START, WORKERS, areaNames, atHandoverCell, cellKey, createWorld,
  deliveryPath, describeWorld, destinationName, destinationStatus, findPath, inGrid, normalizePackingDestination, sameDestination, workerIds,
} from './warehouse.js'
import { RuntimeMonitor } from './RuntimeMonitor.js'
import { decisionIssue, runtimeSituation } from './RuntimeDecision.js'
import { validDestinations, validateTask } from './validation.js'

export const STEP = 0.05
const MOTION = ['MOVING_TO_SHELF', 'PICKING_UP', 'MOVING_TO_DESTINATION']

export function eventLabel({ kind, area, workerId, cell, value }) {
  if (kind === 'area') return value ? `${area} reopened.` : `${area} closed.`
  if (kind === 'receiver') return `${AREAS[area].receiver} is ${value ? 'available' : 'busy'}.`
  if (kind === 'worker') return `${WORKERS[workerId].name} is ${value ? 'available' : 'unavailable'}.`
  return `Aisle (${cell.join(', ')}) ${value ? 'blocked' : 'reopened'}.`
}

export class WarehouseEngine {
  world = createWorld()
  monitor = new RuntimeMonitor()
  phase = 'IDLE'
  cell = START
  path = []
  fraction = 0
  heading = 0
  carrying = null
  delivered = null
  task = null
  originalTask = null
  paused = false
  hold = null
  steps = 0
  waitSteps = 0
  replans = 0
  rounds = 0
  schedule = []
  log = []
  runtimeSequence = 0
  action = 'Idle'

  constructor(notifyChat = () => {}) {
    this.notifyChat = notifyChat
    this.record('experiment_initialized', { world: describeWorld(this.world) })
  }

  get time() { return Number((this.steps * STEP).toFixed(2)) }
  get knowledge() { return this.monitor.knowledge }
  get visiblePhase() { return this.hold?.state ?? this.phase }
  get active() { return MOTION.includes(this.phase) }
  get clockEnabled() { return this.active && !this.paused && (!this.hold || this.hold.state === 'WAITING') }

  record(kind, data = {}) {
    this.log.push({ sequence: this.log.length + 1, sim_time_s: this.time, kind, data: structuredClone(data) })
  }

  note(text) {
    this.notifyChat(text)
  }

  transition(phase) {
    this.phase = phase
    this.record('phase_changed', { phase })
    this.processSchedules()
  }

  stage(task) {
    if (!['IDLE', 'CLARIFYING'].includes(this.phase)) return ['Reset the experiment before staging another task.']
    // Accept older packing-area task records at the engine boundary.
    const destination = normalizePackingDestination(task.destination)
    const normalized = { ...task, destination }
    const issues = validateTask(normalized, this.knowledge, this.cell)
    this.record('task_validation', { issues, task: normalized })
    if (!issues.length) {
      this.task = structuredClone(normalized)
      this.originalTask = structuredClone(normalized)
      this.transition('READY')
      this.action = 'Ready to start'
      this.record('task_finalized', { task: this.task })
    }
    return issues
  }

  start() {
    if (this.phase !== 'READY') return false
    const issues = validateTask(this.task, this.knowledge, this.cell)
    this.record('start_validation', { issues })
    if (issues.length) {
      this.note(issues.join(' '))
      return false
    }
    this.path = findPath(this.cell, PICKUP, this.knowledge.blocked).slice(1)
    this.action = 'Travel to Shelf A'
    this.record('simulation_started', { wall_time: new Date().toISOString(), task: this.task, path: this.path })
    this.transition('MOVING_TO_SHELF')
    this.inspect()
    return true
  }

  setPaused(paused) {
    if (!this.active || this.paused === paused) return
    this.paused = paused
    this.record(paused ? 'simulation_paused' : 'simulation_resumed')
  }

  scheduleEvent(event, trigger) {
    const error = this.checkEvent(event) ||
      (trigger.type === 'time' && Number.isFinite(trigger.time) && trigger.time >= this.time ? null :
        trigger.type === 'phase' && MOTION.includes(trigger.phase) ? null :
          'Use a future simulation time or a movement phase.')
    if (error) return error
    const item = { id: this.schedule.length + 1, event: structuredClone(event), trigger: { ...trigger }, status: 'pending' }
    this.schedule.push(item)
    this.record('event_scheduled', item)
    return null
  }

  removeSchedule(id) {
    const item = this.schedule.find(entry => entry.id === id && entry.status === 'pending')
    if (!item) return
    item.status = 'removed'
    this.record('schedule_removed', { id })
  }

  processSchedules() {
    if (!this.active) return
    for (const item of this.schedule) {
      if (item.status !== 'pending') continue
      const { trigger, event } = item
      if (trigger.type === 'time' ? this.time < trigger.time : this.phase !== trigger.phase) continue
      const error = this.applyEvent(event, 'scheduled')
      item.status = error ? 'skipped' : 'applied'
      this.record('schedule_triggered', { id: item.id, status: item.status, error })
    }
  }

  checkEvent(event) {
    if (typeof event.value !== 'boolean') return 'Choose a valid event state.'
    if (event.kind === 'aisle') {
      if (!inGrid(event.cell) || FIXED_BLOCKS.has(cellKey(event.cell))) return 'Choose a navigable grid cell.'
    } else if (event.kind === 'worker') {
      if (!workerIds.includes(event.workerId)) return 'Choose a valid worker.'
    } else if (!['area', 'receiver'].includes(event.kind) || !areaNames.includes(event.area)) {
      return 'Choose a valid packing area or receiver.'
    }
    return null
  }

  applyEvent(event, origin) {
    const error = this.checkEvent(event)
    if (error) return error
    const { kind, area, workerId, cell, value } = event
    if (kind === 'aisle') {
      const key = cellKey(cell)
      if (value && key === cellKey(this.cell)) return 'The robot occupies this cell.'
      if (value) this.world.blocked.add(key)
      else this.world.blocked.delete(key)
    } else if (kind === 'worker') {
      this.world.workers[workerId].available = value
    } else {
      this.world.areas[area][kind === 'area' ? 'open' : 'receiverAvailable'] = value
    }
    this.record('environment_event', { ...event, origin, source: 'deterministic' })
    return null
  }

  inject(event) {
    const error = this.applyEvent(event, 'manual')
    if (!error) this.inspect()
    return error
  }

  inspect() {
    const observations = this.monitor.observe(this.world, this.cell)
    for (const observation of observations) {
      this.record('robot_observation', { ...observation, source: 'deterministic' })
      this.note(eventLabel(observation))
    }
    if (!this.active) return
    const situation = runtimeSituation(this, observations)
    if (!situation) {
      if (this.hold) {
        const { id } = this.hold
        this.hold = null
        this.executed('CONTINUE', 'The current route and task are feasible again.', { id })
      } else if (observations.length) {
        this.record('runtime_assessment_skipped', { source: 'deterministic', reason: 'No change requires assessment on the active task.', observations })
      }
      return
    }
    if (this.hold?.operatorWait && this.hold.situation.kind === situation.kind) return
    const key = JSON.stringify(situation)
    if (this.hold?.key === key) return
    this.hold = { id: ++this.runtimeSequence, key, situation, state: 'AWAITING_ASSESSMENT' }
    this.action = 'Assessing observed change'
    const { id } = this.hold
    this.record('observed_environment_state', {
      id, source: 'deterministic', world: describeWorld(this.knowledge), robot: { cell: this.cell, path: this.path, phase: this.phase }, situation,
    })
    this.record('runtime_assessment_requested', { id, source: 'deterministic', situation, cell: this.cell })
  }

  routeTo(destination) {
    if (this.phase === 'MOVING_TO_DESTINATION') return deliveryPath(this.cell, destination, this.knowledge)
    return findPath(this.cell, PICKUP, this.knowledge.blocked)
  }

  installRoute(route, reason, execution) {
    this.path = route.slice(1)
    this.fraction = 0
    this.replans++
    this.record('route_replanned', { path: route, destination: this.task.destination, reason })
    this.executed('REPLAN', reason, execution)
  }

  executed(action, reason, { id, source = 'deterministic', proposer, authorization, announce = true } = {}) {
    this.action = reason
    this.record('runtime_decision_executed', { id, action, reason, source, proposer, authorization, destination: this.task.destination, cell: this.cell })
    if (announce) this.note(reason)
  }

  assess(id, decision, proposer = 'gemini') {
    const hold = this.hold
    if (hold?.id !== id || hold.state !== 'AWAITING_ASSESSMENT') return { stale: true }
    const { action, reason, proposed_alternative: alternative } = decision
    this.record('runtime_action_suggested', { id, source: proposer, action, alternative, event: decision.triggering_event })
    this.record('runtime_reasoning', {
      id, source: proposer, reason, uncertainty_category: decision.uncertainty_category,
      affects_active_task: decision.affects_active_task, original_intent_executable: decision.original_intent_executable,
      autonomous_adaptation_possible: decision.autonomous_adaptation_possible,
    })
    this.record('clarification_necessity', {
      id, source: proposer, needed: decision.clarification_needed, requires_authorization: decision.requires_authorization,
    })

    let issue = decisionIssue(hold.situation, decision)
    let route
    if (!issue && action === 'REPLAN') {
      route = alternative ? this.alternativeRoute(alternative) : this.routeTo(this.task.destination)
      if (!route) issue = 'No observed-safe route for the proposed replan.'
    }
    this.record('runtime_validation', { id, source: 'deterministic', action, accepted: !issue, overridden: Boolean(issue), issue })
    if (issue) {
      this.record('runtime_decision_overridden', { id, source: 'deterministic', proposer, proposed_action: action, action: 'HOLD', issue })
      this.executed('HOLD', 'Holding position after rejecting the runtime proposal.', { id, proposer, announce: false })
      return { issue }
    }

    const execution = { id, source: 'combined', proposer, announce: false }
    if (action === 'REPLAN') {
      if (alternative) this.redirect(alternative, route, reason, { ...execution, authorization: 'delegated' })
      else {
        this.hold = null
        this.installRoute(route, reason, execution)
      }
      return { ok: true }
    }
    if (action === 'CONTINUE') this.hold = null
    if (action === 'STOP') this.stop(reason)
    if (action === 'WAIT') hold.state = 'WAITING'
    if (action === 'ASK_USER') hold.state = 'AWAITING_USER'
    this.executed(action, reason, execution)
    return { ok: true }
  }

  authorize(id, authorization, proposer = 'gemini') {
    const hold = this.hold
    if (hold?.id !== id || hold.state !== 'AWAITING_USER') return { stale: true }
    const { choice, destination } = authorization
    const route = choice === 'REDIRECT' && hold.situation.alternatives.some(item => sameDestination(item, destination)) ? this.alternativeRoute(destination) : null
    const accepted = ['WAIT', 'STOP'].includes(choice) || Boolean(route)
    const issue = accepted ? null : 'Choose a currently available and reachable alternative, wait, or stop.'
    this.record('runtime_validation', { id, source: 'deterministic', stage: 'operator_authorization', action: choice, accepted, overridden: !accepted, issue })
    if (issue) return { issue }

    const execution = { id, source: 'combined', proposer, authorization: 'operator' }
    if (choice === 'WAIT') {
      hold.state = 'WAITING'
      hold.operatorWait = true
      this.executed('WAIT', `Waiting for ${destinationName(this.task.destination)} as requested.`, execution)
    } else if (choice === 'STOP') {
      this.stop('Delivery stopped by the operator.')
      this.executed('STOP', 'Delivery stopped by the operator.', execution)
    } else {
      this.redirect(destination, route, `Operator authorized delivery to ${destinationName(destination)}. Replanned route.`, execution)
    }
    return { ok: true }
  }

  alternativeRoute(destination) {
    const origin = this.phase === 'MOVING_TO_DESTINATION' ? this.cell : PICKUP
    return validDestinations(this.knowledge, origin, this.task.destination.type).some(item => sameDestination(item, destination)) ? this.routeTo(destination) : null
  }

  redirect(destination, route, reason, execution) {
    const previous = this.task.destination
    const { authorization } = execution
    // A specific user choice supersedes any earlier delegation for this task.
    this.task = { ...this.task, destination, destination_policy: authorization === 'operator' ? 'FIXED' : this.task.destination_policy }
    this.record('destination_changed', { previous, destination, authorization })
    this.hold = null
    if (this.phase === 'PICKING_UP') this.executed('REPLAN', reason, execution)
    else this.installRoute(route, reason, execution)
  }

  stop(reason) {
    this.hold = null
    this.path = []
    this.fraction = 0
    this.transition('STOPPED')
    this.record('simulation_stopped', { reason, cargo: this.carrying })
  }

  arrive() {
    if (this.phase === 'MOVING_TO_SHELF') {
      this.carrying = this.task.target
      this.pickupUntil = this.steps + Math.round(1.4 / STEP)
      this.record('cargo_picked_up', { cargo: this.carrying, cell: this.cell })
      this.action = 'Picking up cargo'
      this.transition('PICKING_UP')
      this.inspect()
      return
    }
    const { destination } = this.task
    const actual = destinationStatus(this.world, destination)
    if (!actual.open || !actual.available || this.hold || !atHandoverCell(this.cell, destination, this.world)) return
    this.delivered = this.carrying
    this.carrying = null
    this.action = 'Handover complete'
    this.transition('COMPLETED')
    this.record('delivery_completed', { cargo: this.delivered, destination, handover_cell: this.cell, stats: this.stats() })
    this.note(`${this.delivered} delivered to ${destinationName(destination)}.`)
  }

  step() {
    if (!this.clockEnabled) return false
    this.steps++
    const waiting = this.hold?.state === 'WAITING'
    if (waiting) this.waitSteps++
    this.processSchedules()
    this.inspect()
    if (this.hold || waiting) return true

    if (this.phase === 'PICKING_UP') {
      if (this.steps >= this.pickupUntil) {
        this.path = deliveryPath(this.cell, this.task.destination, this.knowledge)?.slice(1) ?? []
        this.action = 'Transport cargo'
        this.transition('MOVING_TO_DESTINATION')
        this.record('transport_started', { destination: this.task.destination, path: this.path })
        this.inspect()
      }
      return true
    }
    if (!this.path.length) {
      this.arrive()
      return true
    }
    const next = this.path[0]
    const [dr, dc] = [next[0] - this.cell[0], next[1] - this.cell[1]]
    this.heading = Math.atan2(dc, dr)
    this.fraction += (this.phase === 'MOVING_TO_SHELF' ? 0.82 : this.task.transport_speed_mps) * STEP
    if (this.fraction + 1e-9 >= 1) {
      // The sensor sees the adjacent cell. Ground truth also guards the physical commit.
      if (this.world.blocked.has(cellKey(next))) {
        this.fraction = 0
        this.inspect()
        return true
      }
      this.cell = next
      this.path = this.path.slice(1)
      this.fraction = this.path.length ? Math.max(0, this.fraction - 1) : 0
      this.record('robot_entered_cell', { cell: this.cell, carrying: this.carrying })
      this.inspect()
      if (!this.hold && !this.path.length) this.arrive()
    }
    return true
  }

  stats() {
    return {
      sim_time_s: this.time,
      waiting_time_s: Number((this.waitSteps * STEP).toFixed(2)),
      replans: this.replans,
      clarification_rounds: this.rounds,
      phase: this.visiblePhase,
      delivered_cargo: this.delivered,
    }
  }

  report() {
    return { version: 3, original_task: this.originalTask, task: this.task, stats: this.stats(), schedule: this.schedule, events: this.log }
  }
}
