import { atHandoverCell, cellKey, deliveryPath, destinationName, destinationStatus, distance, findPath, PICKUP, sameDestination } from './warehouse.js'
import { validDestinations } from './validation.js'

export function runtimeSituation(engine, observations = []) {
  const { task, phase, cell, path, knowledge } = engine
  const loaded = phase === 'MOVING_TO_DESTINATION'
  const { destination } = task
  const status = destinationStatus(knowledge, destination)
  const workerDelivery = destination.type === 'WORKER'
  const nearHandover = loaded && distance(cell, status.cell) <= 1
  const atGoal = loaded ? atHandoverCell(cell, destination, knowledge) : cellKey(cell) === cellKey(PICKUP)
  const blockedPathCells = path.filter(next => knowledge.blocked.has(cellKey(next)))
  const currentRouteUsable = !blockedPathCells.length &&
    (phase === 'PICKING_UP' || path.length > 0 || atGoal)
  const sameGoalRouteExists = currentRouteUsable || Boolean(loaded
    ? deliveryPath(cell, destination, knowledge) : findPath(cell, PICKUP, knowledge.blocked))
  const receiverChanged = !workerDelivery && observations.some(event =>
    event.kind === 'receiver' && event.area === destination.id && !event.value)
  const assessingReceiver = engine.hold?.situation.kind === 'RECEIVER_BUSY'

  let kind
  if (!status.open) kind = 'AREA_CLOSED'
  else if (workerDelivery && !status.available) kind = 'WORKER_UNAVAILABLE'
  else if (!currentRouteUsable) kind = 'AISLE_BLOCKED'
  else if (!status.available && (nearHandover || receiverChanged || assessingReceiver)) kind = 'RECEIVER_BUSY'
  else return null

  return {
    kind,
    destination,
    destinationName: destinationName(destination),
    destinationPolicy: task.destination_policy,
    destinationOpen: status.open,
    handoverAvailable: status.available,
    nearHandover,
    currentRouteUsable,
    sameGoalRouteExists,
    blockedPathCells,
    alternatives: (loaded || sameGoalRouteExists)
      ? validDestinations(knowledge, loaded ? cell : PICKUP, destination.type).filter(item => !sameDestination(item, destination))
      : [],
  }
}

export function canContinue(situation) {
  return situation.destinationOpen && situation.currentRouteUsable &&
    (situation.handoverAvailable || (situation.destination.type === 'PACKING_AREA' && !situation.nearHandover))
}

export function canConsiderAnotherDestination(situation) {
  return situation.alternatives.length > 0 && (!situation.destinationOpen || situation.kind === 'WORKER_UNAVAILABLE' || !situation.sameGoalRouteExists)
}

export function decisionIssue(situation, decision) {
  const { action, triggering_event: event, proposed_alternative: alternative } = decision
  if (event !== situation.kind) return 'The proposal refers to a different runtime event.'
  if (alternative && !situation.alternatives.some(item => sameDestination(item, alternative))) return 'The proposed destination is unavailable or unreachable.'
  if (decision.clarification_needed !== (action === 'ASK_USER') ||
      decision.requires_authorization !== (action === 'ASK_USER')) {
    return 'The proposed action conflicts with its clarification or authorization requirements.'
  }
  if (action === 'CONTINUE' && !canContinue(situation)) {
    return 'Continuing on the current route is unsafe or would serve a closed destination.'
  }
  if (action === 'REPLAN' && alternative) {
    if (situation.destinationPolicy !== 'DELEGATED') return 'Changing the fixed destination requires operator authorization.'
    if (!canConsiderAnotherDestination(situation)) return 'The current destination can still be served without changing it.'
  }
  if (action === 'REPLAN' && !alternative &&
      (!situation.destinationOpen || !situation.sameGoalRouteExists || (!situation.handoverAvailable && (situation.destination.type === 'WORKER' || situation.nearHandover)))) {
    return 'No safe replan to the current destination is available.'
  }
  if (action === 'ASK_USER') {
    if (situation.destinationPolicy === 'DELEGATED' || !canConsiderAnotherDestination(situation)) {
      return 'There is no destination change that requires new operator authorization.'
    }
    if (!decision.clarification_question?.trim()) return 'A clarification question is required.'
  }
  if (alternative && action !== 'REPLAN' && action !== 'ASK_USER') {
    return 'Only replanning or requesting authorization may name a different destination.'
  }
  return null
}
