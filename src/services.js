import { PROMPT_VERSION } from '../shared/contracts.js'
import { destinationName } from './simulation/warehouse.js'
import { canConsiderAnotherDestination, canContinue } from './simulation/RuntimeDecision.js'

export async function liveRequest(operation, context, signal) {
  const result = await fetch('/api/gemini', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation, context }),
    signal,
  })
  const payload = await result.json().catch(() => ({}))
  if (!result.ok) {
    const error = new Error(payload.error || 'The local Gemini server is unavailable. Retry when ready.')
    error.metadata = payload
    throw error
  }
  return payload
}

export const DEMO_INSTRUCTION = 'Transport the fragile cargo on Shelf A to the packing area quickly.'

const demoQuestions = [
  { text: 'fragile cargo', category: 'cargo', reason: 'A1, A2, and A3 are all fragile.',
    missing_information: 'One cargo ID', question: 'Which fragile cargo should I transport?',
    options: ['A1 (red)', 'A2 (blue)', 'A3 (yellow)'] },
  { text: 'the packing area', category: 'destination', reason: 'Both packing areas are available.',
    missing_information: 'One destination', question: 'Which packing area should receive the cargo?',
    options: ['Packing Area 1', 'Packing Area 2', 'Any available packing area'] },
  { text: 'quickly', category: 'speed', reason: 'Several speeds meet the warehouse limit.',
    missing_information: 'One numerical speed', question: 'What transport speed should I use?',
    options: ['0.6 m/s', 'Maximum safe speed'] },
]

export async function fixtureRequest(operation, context, signal) {
  signal.throwIfAborted()
  const history = context.history ?? []
  const selected = category => history.findLast(turn => turn.sufficient && turn.category === category)?.answer ?? ''
  const answer = context.answer ?? ''
  let response
  if (operation === 'analyze' && context.instruction === DEMO_INSTRUCTION) {
    response = { ambiguities: demoQuestions.filter(question => !selected(question.category)) }
  } else if (operation === 'evaluate') {
    const options = demoQuestions.find(question => question.category === context.question.category)?.options ?? []
    const sufficient = options.includes(answer) || /^(?:A[123]|(?:0?\.\d+)\s*m\/s)$/i.test(answer)
    response = { sufficient, reason: sufficient ? 'The fixture accepts this selection.' : 'Choose a listed fixture answer.',
      follow_up_question: sufficient ? '' : 'Please select one of the listed choices for the replay.' }
  } else if (operation === 'task' && context.instruction === DEMO_INSTRUCTION) {
    const delegated = selected('destination') === 'Any available packing area'
    response = {
      target: selected('cargo').slice(0, 2), source: 'Shelf A',
      destination: delegated ? context.valid_destinations[0] ?? null :
        { type: 'PACKING_AREA', id: selected('destination') },
      transport_speed_mps: selected('speed') === 'Maximum safe speed' ? 0.8 : Number.parseFloat(selected('speed')) || null,
      destination_policy: delegated ? 'DELEGATED' : 'FIXED',
      delegation_evidence: delegated ? selected('destination') : '',
    }
  } else if (operation === 'review') {
    response = { ready: false, issue_type: 'fixture', reason: context.issues.join(' '),
      clarification_question: 'Reset the replay and use the listed fixture options with both areas open.' }
  } else if (operation === 'runtime') {
    response = fixtureAssessment(context.situation)
  } else if (operation === 'authorize') {
    response = fixtureInterpretation(context, answer)
  } else {
    throw new Error('Replay uses the included example instruction. Switch to Live Gemini for a new instruction.')
  }
  return { response, model: 'replay-fixture', prompt_version: PROMPT_VERSION, latency_ms: 0, attempts: 1 }
}

function fixtureAssessment(situation) {
  const { kind, destinationName: destination, destinationPolicy, sameGoalRouteExists, alternatives } = situation
  let action = 'WAIT'
  let alternative = null
  if (canContinue(situation)) action = 'CONTINUE'
  else if (kind === 'AISLE_BLOCKED' && sameGoalRouteExists) action = 'REPLAN'
  else if (canConsiderAnotherDestination(situation)) {
    alternative = alternatives[0]
    action = destinationPolicy === 'DELEGATED' ? 'REPLAN' : 'ASK_USER'
  }
  const ask = action === 'ASK_USER'
  const adapt = action === 'REPLAN' || action === 'CONTINUE'
  const reason = {
    AREA_CLOSED: alternative && !ask ? `${destination} closed. Prior delegation permits delivery to ${destinationName(alternative)}.` :
      `${destination} closed. Holding position.`,
    RECEIVER_BUSY: action === 'CONTINUE' ? 'The receiver is busy, but the robot can safely continue until the handover area.' :
      'The receiver is busy. Waiting for availability before handover.',
    WORKER_UNAVAILABLE: `${destination} is unavailable. Holding for a validated worker handover.`,
    AISLE_BLOCKED: action === 'REPLAN' ? 'The blocked aisle can be bypassed without changing the delivery goal.' :
      'The planned aisle is blocked and the current destination cannot be reached.',
  }[kind]
  return {
    action, reason, triggering_event: kind, affects_active_task: true,
    original_intent_executable: (adapt && !['RECEIVER_BUSY', 'WORKER_UNAVAILABLE'].includes(kind)), autonomous_adaptation_possible: adapt,
    uncertainty_category: ask ? 'DESTINATION_AUTHORIZATION' : kind === 'AISLE_BLOCKED' ? 'ROUTE_FEASIBILITY' : 'ENVIRONMENT_STATE',
    clarification_needed: ask, requires_authorization: ask, proposed_alternative: alternative,
    clarification_question: ask ? `Use ${destinationName(alternative)} instead, or wait for ${destination} to ${kind === 'AREA_CLOSED' ? 'reopen' : 'be available'}?` : '',
  }
}

function fixtureInterpretation({ situation, question }, answer) {
  const text = answer.toLowerCase()
  const confirmation = question.confirmation
  let selection = null
  let classification = 'INCOMPLETE_OR_AMBIGUOUS'
  let destination = situation.alternatives.find(area => text.includes(destinationName(area).toLowerCase()))
  if (/^no\b/i.test(text)) classification = 'CLEAR_REJECTION'
  else if (confirmation && /^yes[.!]?$/i.test(text)) selection = confirmation
  else if (/^wait\b/i.test(text)) selection = { choice: 'WAIT' }
  else if (/^stop\b/i.test(text)) selection = { choice: 'STOP' }
  else if (destination && !/\b(?:maybe|if|not|could)\b|\?/.test(text)) selection = { choice: 'REDIRECT', destination }
  else if (text === 'delivery to work 1') destination = situation.alternatives.find(area => area.type === 'PACKING_AREA' && area.id === 'Packing Area 1')
  if (selection) classification = 'CLEAR_AUTHORIZATION'
  const interpretation = selection ?? { choice: destination ? 'REDIRECT' : 'NONE', destination }
  return {
    classification, choice: interpretation.choice, destination: interpretation.destination ?? null, evidence: answer,
    reason: 'Replay fixture interpreted the reply.', follow_up_question: 'Which available destination did you mean?',
  }
}
