import {
  AREAS, CARGO, DESTINATIONS, PICKUP, RISK_SPEED, deliveryPath, destinationName,
  destinationStatus, findPath, sameDestination,
} from './warehouse.js'

export function validDestinations(knowledge, origin = PICKUP, type) {
  return DESTINATIONS.filter(destination => {
    if (type && destination.type !== type) return false
    const status = destinationStatus(knowledge, destination)
    return status.open && status.available && deliveryPath(origin, destination, knowledge)
  })
}

export function validateTask(task, knowledge, start) {
  const issues = []
  if (!Object.hasOwn(CARGO, task.target)) issues.push('Select exactly one cargo, A1, A2, or A3.')
  if (task.source !== 'Shelf A') issues.push('The source must be Shelf A.')
  const speed = task.transport_speed_mps
  if (!Number.isFinite(speed) || speed <= 0) issues.push('Enter a finite transport speed greater than 0 m/s.')
  else if (CARGO[task.target]?.fragile && speed > RISK_SPEED) {
    issues.push(`${task.target} is fragile. ${speed} m/s exceeds the 0.8 m/s limit.`)
  }
  const destination = task.destination
  const status = destinationStatus(knowledge, destination)
  if (!status) issues.push('Select a valid worker or packing area.')
  else {
    const name = destinationName(destination)
    if (!status.open) issues.push(`${name} is closed.`)
    else if (!status.available) {
      issues.push(destination.type === 'WORKER' ? `${name} is unavailable.` : `${AREAS[destination.id].receiver} is busy.`)
    }
    if (!deliveryPath(PICKUP, destination, knowledge)) issues.push('No observed-safe route to the destination.')
  }
  if (!findPath(start, PICKUP, knowledge.blocked)) issues.push('No observed-safe route to Shelf A.')
  return issues
}

const delegation = /\b(?:(?:any (?:one )?(?:(?:currently )?available |valid |open |reachable )?|either )(?:pack(?:ing|aging) area|worker|destination|one)(?: is fine)?|an available worker|(?:pack(?:ing|aging) area|worker|destination)[^.!?;]{0,18}\byou choose)\b/i
const shortDelegation = /^(?:either(?: is fine)?|any(?: one)?(?: is fine)?|you (?:can )?(?:choose|decide)(?: one)?)[.!]?$/i
const negative = /\b(?:not|never|don't|do not|cannot|can't|if|unless|maybe|might|could|perhaps|except|avoid|only if|or|instead of)\b/i

export function isDestinationCategory(category) {
  return /\b(?:destination|recipient|worker|pack(?:ing|aging) area)\b/i.test(category.replaceAll('_', ' '))
}

function destinationType(text) {
  const worker = /\bworkers?\b/i.test(text)
  const packingArea = /\bpack(?:ing|aging) areas?\b|\barea\s*[12]\b/i.test(text)
  if (worker === packingArea) return undefined
  return worker ? 'WORKER' : 'PACKING_AREA'
}

function namedDestinations(text) {
  const mentions = [
    ...[...text.matchAll(/\b(?:pack(?:ing|aging)\s+)?area\s*([12])\b/gi)]
      .map(match => ({ type: 'PACKING_AREA', id: `Packing Area ${match[1]}` })),
    ...[...text.matchAll(/\b(?:worker[ -]*(1|2|one|two)|(first|second) worker)\b/gi)]
      .map(match => ({ type: 'WORKER', id: /^(?:1|one|first)$/i.test(match[1] ?? match[2]) ? 'worker-1' : 'worker-2' })),
  ]
  return mentions.filter((item, index) => mentions.findIndex(candidate => sameDestination(candidate, item)) === index)
}

export function destinationIntent(instruction, history) {
  const sources = [
    { text: instruction, destinationAnswer: false },
    ...history.filter(turn => turn.sufficient || turn.destinationConfirmed).map(turn => ({
      text: turn.answer, destinationAnswer: Boolean(turn.destinationConfirmed) || isDestinationCategory(turn.category),
    })),
  ]
  const latest = sources.findLast(entry => entry.destinationAnswer || destinationType(entry.text) ||
    namedDestinations(entry.text).length || delegation.test(entry.text))
  if (!latest) return { policy: 'FIXED' }
  const names = namedDestinations(latest.text)
  const scope = sources.map(entry => destinationType(entry.text)).findLast(Boolean)
  const scoped = scope ? { type: scope } : {}
  const politeRequest = /^(?:can|could|would|will) you (?:please )?(?:deliver|transport|bring|take|send|use)\b/i
  const directiveText = latest.text.replace(politeRequest, '')
  const clear = !negative.test(directiveText) && (!latest.text.includes('?') || politeRequest.test(latest.text)) &&
    !/\b(?:whether|example|hypothetical)\b/i.test(directiveText)
  const nearest = /\b(?:closest|nearest)\b/i.test(latest.text)
  if (clear && nearest && scope) return { policy: 'FIXED', ...scoped, nearest: true }
  if (clear && names.length === 1 && !/\b(?:other|farther|same)\b/i.test(latest.text)) {
    return { policy: 'FIXED', type: names[0].type, named: names[0] }
  }
  if (clear && !names.length) {
    if (latest.destinationAnswer && shortDelegation.test(latest.text.trim())) {
      return { policy: 'DELEGATED', ...scoped, evidence: latest.text }
    }
    const delegated = delegation.exec(latest.text)
    if (delegated) {
      const prefix = latest.text.slice(0, delegated.index)
      if (latest.destinationAnswer || /\b(?:to|at|use|choose|select)\s+$/i.test(prefix) || /\bis fine\b/i.test(delegated[0])) {
        return { policy: 'DELEGATED', ...scoped, evidence: delegated[0] }
      }
    }
  }
  const genericWorker = scope === 'WORKER' &&
    /\b(?:a|the|one) worker(?=\s*(?:[.!?]|$|at\s+(?:[+-]?(?:\d|\.\d)|the\s+(?:maximum|fastest|highest))|quickly\b|please\b))/i.test(latest.text)
  const unknownWorker = /\bworker[ -]*(\d+)\b/i.exec(latest.text)
  if (unknownWorker && !names.length) return { policy: 'FIXED', ...scoped, unknownWorker: unknownWorker[0] }
  return { policy: 'FIXED', ...scoped, ...(genericWorker || names.length > 1 ? { needsChoice: true } : {}) }
}

export function destinationChoices(intent, knowledge) {
  const candidates = validDestinations(knowledge, PICKUP, intent.type)
  if (!intent.nearest || !candidates.length) return candidates
  const distances = candidates.map(destination => deliveryPath(PICKUP, destination, knowledge).length)
  const nearest = Math.min(...distances)
  return candidates.filter((_, index) => distances[index] === nearest)
}

function explicitRuntimeChoice(text) {
  const name = /^(?:(?:yes|okay|ok|sure)[, ]+)?(?:please )?(?:(?:use|choose|switch to|go to|i authorize|deliver (?:it )?to|redirect (?:it )?to|take it to|send it to) )?(?:the )?((?:pack(?:ing|aging) )?area [12]|worker[ -]*(?:[12]|one|two)|(?:first|second) worker)(?: instead)?(?: please)?$/.exec(text)
  if (name) return { choice: 'REDIRECT', destination: namedDestinations(name[1])[0] }
  const wait = /^(?:please )?(?:let's |we can )?wait(?: for (?:the )?((?:pack(?:ing|aging) )?area [12]|worker [12]|receiver [12]|original destination)(?: to (?:reopen|be available|become available))?)?(?: please)?$/.exec(text)
  if (wait) return { choice: 'WAIT', waitFor: wait[1] }
  if (/^(?:please )?(?:stop|cancel|abort)(?: (?:the )?(?:task|delivery))?$/.test(text)) return { choice: 'STOP' }
  return null
}

export function runtimeAuthorization(answer, proposal, situation, pending = null) {
  const text = answer.trim().toLowerCase().replace(/[.!]+$/, '').replace(/[’]/g, "'")
  if (proposal.classification === 'CLEAR_REJECTION' || /^(?:no(?:,? thanks)?|no thank you)$/.test(text)) {
    return { rejected: true }
  }
  if (proposal.classification === 'INVALID_REQUEST') return { issue: 'The requested action is not available.' }
  if (proposal.choice === 'NONE') return { issue: 'The reply did not identify an action.' }
  if (!proposal.evidence.trim() || !answer.includes(proposal.evidence)) {
    return { issue: 'The interpretation did not cite words from the reply.' }
  }

  const candidate = { choice: proposal.choice }
  if (candidate.choice === 'REDIRECT') {
    if (!situation.alternatives.some(alternative => sameDestination(alternative, proposal.destination))) return { issue: 'The proposed destination is unavailable or unreachable.' }
    candidate.destination = proposal.destination
  }
  const matches = choice => choice?.choice === candidate.choice && (candidate.destination ? sameDestination(choice?.destination, candidate.destination) : !choice?.destination)
  const explicit = explicitRuntimeChoice(text)
  if (explicit?.waitFor && explicit.waitFor !== 'original destination') {
    const receiver = AREAS[situation.destination.id]?.receiver
    if (!sameDestination(namedDestinations(explicit.waitFor)[0], situation.destination) && receiver?.toLowerCase() !== explicit.waitFor) {
      return { issue: 'That wait request names a different destination.' }
    }
  }
  const assent = /^(?:yes(?:,? please)?|correct|confirm|that's right|go ahead|okay|ok)$/.test(text)
  // A model interpretation can suggest a choice. Only the current operator reply can authorize it.
  if (proposal.classification === 'CLEAR_AUTHORIZATION' && (matches(explicit) || (assent && matches(pending)))) {
    return { authorization: candidate }
  }
  if (explicit || assent || /\b(?:no|not|never|don't|cannot|can't|instead of)\b/.test(text)) {
    return { issue: 'The proposed action was not confirmed by this reply.' }
  }
  return { confirmation: candidate }
}

export function confirmedTransportSpeed(instruction, history) {
  const sources = [
    { text: instruction, speedAnswer: false },
    ...history.filter(turn => turn.sufficient).map(turn => ({
      text: turn.answer, speedAnswer: /speed|velocity/i.test(turn.category),
    })),
  ]
  const numeric = /(?<![\w.])([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*(?:m\s*\/\s*s|meters? per second|metres? per second)\b/gi
  const atSpeed = /\bat\s+(?:a speed of\s+)?([+-]?(?:\d+(?:\.\d+)?|\.\d+))(?=\s*[.!?]?\s*$)/i
  const maximum = /\b(?:(?:maximum|fastest|highest) safe speed|(?:currently )?permitted maximum(?: speed)?|maximum permitted speed)\b/i
  const latest = sources.findLast(entry => entry.speedAnswer || maximum.test(entry.text) || atSpeed.test(entry.text) ||
    [...entry.text.matchAll(numeric)].length)
  if (!latest) return null
  const values = [...latest.text.matchAll(numeric)].map(match => Number(match[1]))
  const bare = atSpeed.exec(latest.text) || (latest.speedAnswer && /^\s*(\d+(?:\.\d+)?|\.\d+)\s*[.!]?\s*$/.exec(latest.text))
  if (bare) values.push(Number(bare[1]))
  if (!values.length && maximum.test(latest.text) && !negative.test(latest.text)) {
    if (/(?:^|\bat )half (?:of )?the\b/i.test(latest.text)) values.push(RISK_SPEED / 2)
    else if (!/\b(?:around|about|approximately|less|more|below|above|under|over|half|twice|times|percent)\b/i.test(latest.text)) values.push(RISK_SPEED)
  }
  if (values.length !== 1 || /\b(?:around|about|approximately|between|or|not)\b/i.test(latest.text)) return null
  return values[0]
}

export function speedIntentIssue(instruction, history, proposed) {
  const speed = confirmedTransportSpeed(instruction, history)
  if (speed == null || proposed == null) return 'Confirm an exact transport speed in m/s or request the maximum safe speed.'
  return Math.abs(speed - proposed) < 1e-9 ? null : 'The proposed speed differs from the operator’s instruction.'
}

export function cargoIntentIssue(instruction, history, target) {
  const cargoPattern = /\b(A[123])\b/gi
  const sources = [
    { text: instruction, cargoAnswer: false },
    ...history.filter(turn => turn.sufficient).map(turn => ({
      text: turn.answer, cargoAnswer: /cargo|item/i.test(turn.category),
    })),
  ]
  const latest = sources.findLast(entry => entry.cargoAnswer || [...entry.text.matchAll(cargoPattern)].length)?.text
  if (!latest || negative.test(latest)) return null
  const ids = new Set([...latest.matchAll(cargoPattern)].map(match => match[1].toUpperCase()))
  if (ids.size > 1 && !/\b(?:any|either|choose|one of)\b/i.test(latest)) return 'Select exactly one cargo or delegate that choice.'
  if (ids.size === 1 && !ids.has(target)) return `The operator selected ${[...ids][0]}.`
  return null
}
