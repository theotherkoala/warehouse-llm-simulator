import { DEFAULT_MODEL, PROMPT_VERSION, responses } from '../shared/contracts.js'
import { fixtureRequest, liveRequest } from './services.js'
import { WarehouseEngine } from './simulation/WarehouseEngine.js'
import { RISK_SPEED, describeWorld, destinationName, normalizePackingDestination, sameDestination } from './simulation/warehouse.js'
import { cargoIntentIssue, confirmedTransportSpeed, destinationChoices, destinationIntent, isDestinationCategory, runtimeAuthorization, speedIntentIssue, validDestinations, validateTask } from './simulation/validation.js'

const destinationFields = { task: 'destination', runtime: 'proposed_alternative', authorize: 'destination' }

export class ResearchSession {
  version = 0
  listeners = new Set()
  mode = 'live'
  liveModel = DEFAULT_MODEL

  constructor(request) {
    this.liveRequest = request ?? liveRequest
    this.reset()
  }

  subscribe = callback => {
    this.listeners.add(callback)
    return () => this.listeners.delete(callback)
  }

  snapshot = () => this.version

  publish() {
    this.version++
    for (const callback of this.listeners) callback()
  }

  reset() {
    this.running?.controller.abort()
    this.running = null
    this.retryJob = null
    this.error = null
    this.question = null
    this.instruction = ''
    this.history = []
    this.queue = []
    this.messages = []
    this.attemptedId = null
    this.fixtureFault = 'none'
    this.engine = new WarehouseEngine(text => this.message('system', text))
    this.engine.record('experiment_mode', { mode: this.mode })
    this.publish()
  }

  setMode(mode) {
    if (this.engine.phase !== 'IDLE' || this.running || !['live', 'replay'].includes(mode)) return
    if (this.mode === mode) return
    this.mode = mode
    this.fixtureFault = 'none'
    this.engine.record('experiment_mode', { mode })
    this.publish()
  }

  setFixtureFault(fault) {
    if (this.mode !== 'replay' || !['none', 'api', 'decision'].includes(fault)) return
    this.fixtureFault = fault
    this.engine.record('fixture_fault_selected', { fault })
    this.publish()
  }

  message(role, text, details = {}) {
    const message = { id: this.messages.length + 1, role, text, ...details }
    this.messages.push(message)
    if (role !== 'system') this.engine.record('chat_message', message)
    return message
  }

  ask(question, runtimeId) {
    this.question = { ...question, runtimeId }
    const message = this.message('assistant', question.question, { options: question.options ?? [] })
    this.question.messageId = message.id
    this.engine.record('clarification_question', { ...this.question })
  }

  get canSend() {
    const { active, hold, phase } = this.engine
    return !this.running && !this.retryJob && (phase === 'IDLE' || Boolean(this.question) ||
      (active && (!hold || hold.state === 'WAITING')))
  }

  async send(input) {
    const answer = input.trim()
    if (!answer || !this.canSend) return
    this.message('user', answer)
    if (this.question) {
      const question = this.question
      this.question = null
      this.engine.rounds++
      this.engine.record('clarification_answer', { source: 'operator', answer, question, round: this.engine.rounds })
      const job = question.runtimeId
        ? scope => this.answerRuntime(question, answer, scope)
        : scope => this.answerPreflight(question, answer, scope)
      return this.run(job, question.runtimeId)
    }
    if (this.engine.active) {
      const { cell, task, carrying, action } = this.engine
      this.message('system', `AMR-01 is at (${cell.join(', ')}), ${carrying ? `carrying ${carrying}` : `assigned to collect ${task.target}`} for ${destinationName(task.destination)}. ${action}`)
      this.publish()
      return
    }
    this.instruction = answer
    this.engine.record('original_instruction', { instruction: answer })
    this.engine.transition('CLARIFYING')
    this.engine.action = 'Checking task parameters'
    return this.run(scope => this.analyze(scope))
  }

  context() {
    const knowledge = this.engine.knowledge
    const intent = destinationIntent(this.instruction, this.history)
    const choices = destinationChoices(intent, knowledge)
    const canResolveSingle = intent.type === 'PACKING_AREA' || intent.nearest || intent.needsChoice || intent.policy === 'DELEGATED'
    const selected = intent.named ?? (canResolveSingle && choices.length === 1 ? choices[0] : null)
    return {
      instruction: this.instruction,
      history: this.history,
      warehouse: describeWorld(knowledge),
      valid_destinations: validDestinations(knowledge, undefined, intent.type).map(destination => ({
        ...destination, name: destinationName(destination),
      })),
      confirmed_transport_speed_mps: confirmedTransportSpeed(this.instruction, this.history),
      destination_authorization: intent,
      destination_resolution: { selected, choices },
    }
  }

  async query(operation, context, scope) {
    const input = structuredClone(context)
    const request = this.mode === 'replay' ? fixtureRequest : this.liveRequest
    const engine = this.engine
    const started = performance.now()
    const model = this.mode === 'replay' ? 'replay-fixture' : this.liveModel
    engine.record('gemini_request', { operation, model, prompt_version: PROMPT_VERSION, input })
    const fault = this.mode === 'replay' && (this.fixtureFault === 'api' ||
      (this.fixtureFault === 'decision' && operation === 'runtime')) ? this.fixtureFault : 'none'
    if (fault !== 'none') {
      this.fixtureFault = 'none'
      engine.record('fixture_fault_applied', { fault, operation })
    }
    try {
      if (fault === 'api') throw new Error('Simulated Gemini API failure. Retry to continue the replay.')
      const result = await request(operation, input, scope.controller.signal)
      if (fault === 'decision') result.response = { ...result.response, action: 'CONTINUE' }
      const field = destinationFields[operation]
      const value = result.response?.[field]
      const destination = normalizePackingDestination(value)
      // A running backend from before worker support can still return a packing-area name.
      const payload = destination === value ? result.response : { ...result.response, [field]: destination }
      const parsed = responses[operation].safeParse(payload)
      if (!parsed.success) {
        const error = new Error('Gemini returned an invalid response. Try the request again.')
        error.metadata = { validation_issues: parsed.error.issues }
        throw error
      }
      const response = parsed.data
      scope.controller.signal.throwIfAborted()
      engine.record('gemini_response', { operation, input, ...result, response })
      return response
    } catch (error) {
      if (!scope.controller.signal.aborted) engine.record('gemini_error', {
        operation, model, input, prompt_version: PROMPT_VERSION,
        latency_ms: Math.round(performance.now() - started), ...error.metadata, error: error.message,
      })
      throw error
    }
  }

  async run(job, runtimeId) {
    const scope = { controller: new AbortController(), runtimeId, retry: job }
    this.running = scope
    this.error = null
    this.retryJob = null
    this.publish()
    try {
      await job(scope)
    } catch (error) {
      if (this.running !== scope || scope.controller.signal.aborted) return
      this.error = error instanceof Error ? error.message : 'The assessment failed. Retry when ready.'
      this.retryJob = { job: scope.retry, runtimeId }
    } finally {
      if (this.running === scope) {
        this.running = null
        this.syncRuntime()
        this.publish()
      }
    }
  }

  retry() {
    if (this.running || !this.retryJob) return
    const { job, runtimeId } = this.retryJob
    return this.run(job, runtimeId)
  }

  async analyze(scope) {
    const context = this.context()
    const result = await this.query('analyze', context, scope)
    const { destination_authorization: authorization, destination_resolution: resolution, valid_destinations: destinations } = context
    const resolvedDestination = destinations.some(item => sameDestination(item, resolution.selected)) ||
      (authorization.policy === 'DELEGATED' && destinations.length > 0)
    const speed = confirmedTransportSpeed(this.instruction, this.history)
    const resolvedSpeed = speed > 0 && speed <= RISK_SPEED
    const workerRequest = authorization.type === 'WORKER'
    this.queue = result.ambiguities.filter(issue => {
      const category = issue.category.trim().toLowerCase().replaceAll('_', ' ')
      if (isDestinationCategory(category) && (resolvedDestination || workerRequest)) return false
      if (['speed', 'transport speed'].includes(category) && resolvedSpeed) return false
      return true
    })
    const workerChoiceNeeded = authorization.needsChoice || authorization.nearest || authorization.unknownWorker ||
      resolution.selected || result.ambiguities.some(issue => isDestinationCategory(issue.category))
    if (workerRequest && !resolvedDestination && resolution.choices.length && workerChoiceNeeded) {
      const selected = destinationName(resolution.selected)
      const unavailable = selected ? `${selected} is unavailable or unreachable.` : null
      const unknown = authorization.unknownWorker ? `${authorization.unknownWorker} is not in the warehouse.` : null
      const issue = unavailable ?? unknown
      this.queue.unshift({
        text: selected ?? authorization.unknownWorker ?? 'a worker', category: 'destination',
        reason: issue ?? 'The instruction does not identify one eligible worker.',
        missing_information: 'The worker who should receive the cargo.',
        question: issue ? `${issue} Which worker should receive the cargo instead?` : 'Which worker should receive the cargo?',
        options: resolution.choices.map(destinationName),
      })
    }
    this.engine.record('ambiguities_detected', { reported: result.ambiguities, remaining: this.queue })
    scope.retry = next => this.advance(next)
    await this.advance(scope)
  }

  async advance(scope) {
    if (this.queue.length) {
      this.ask(this.queue.shift())
      return
    }
    await this.build(scope)
  }

  async answerPreflight(question, answer, scope) {
    const evaluation = await this.query('evaluate', { ...this.context(), question, answer }, scope)
    const named = destinationIntent(answer, []).named
    const destinationQuestion = isDestinationCategory(question.category)
    const correctsDestination = /^\s*(?:i mean|actually|(?:can|could|would|will) you (?:please )?deliver)\b/i.test(answer)
    const destinationConfirmed = Boolean((destinationQuestion || correctsDestination) && named &&
      validDestinations(this.engine.knowledge).some(item => sameDestination(item, named)))
    const sufficient = evaluation.sufficient || (destinationQuestion && destinationConfirmed)
    this.history.push({ stage: question.stage ?? 'initial', category: question.category, question: question.question,
      answer, sufficient, destinationConfirmed })
    if (!sufficient) {
      this.ask({ ...question, question: evaluation.follow_up_question || question.question })
      return
    }
    if (this.queue.length && !question.options?.includes(answer)) {
      scope.retry = next => this.analyze(next)
      await this.analyze(scope)
    } else {
      scope.retry = next => this.advance(next)
      await this.advance(scope)
    }
  }

  async build(scope, feedback = [], corrected = false) {
    const proposed = await this.query('task', { ...this.context(), validation_feedback: feedback }, scope)
    const { destination_authorization: intent, destination_resolution: resolution,
      confirmed_transport_speed_mps: confirmedSpeed } = this.context()
    const { delegation_evidence: _evidence, ...task } = proposed
    task.destination_policy = intent.policy
    task.transport_speed_mps ??= confirmedSpeed
    if (resolution.selected && !sameDestination(task.destination, resolution.selected)) {
      this.engine.record('destination_resolution_corrected', { proposed: task.destination, selected: resolution.selected })
      task.destination = resolution.selected
    }
    const issues = validateTask(task, this.engine.knowledge, this.engine.cell)
    if (intent.unknownWorker) issues.push(`${intent.unknownWorker} is not in the warehouse.`)
    if (intent.type === 'WORKER' && !resolution.choices.length) issues.push('No worker is currently available and reachable.')
    const cargoIssue = cargoIntentIssue(this.instruction, this.history, task.target)
    if (cargoIssue) issues.push(cargoIssue)
    const speedIssue = speedIntentIssue(this.instruction, this.history, task.transport_speed_mps)
    if (speedIssue) issues.push(speedIssue)
    if (intent.type && task.destination && intent.type !== task.destination.type) {
      issues.push(intent.type === 'WORKER' ? 'The operator requested a worker destination.' : 'The operator requested a packing area.')
    }
    if (proposed.destination_policy !== intent.policy) {
      this.engine.record('destination_policy_corrected', {
        proposed: proposed.destination_policy, validated: intent.policy, evidence: intent.evidence ?? proposed.delegation_evidence,
      })
    }
    if (!issues.length) {
      this.engine.stage(task)
      this.message('assistant', `Task validated. I'll collect ${task.target} from Shelf A and deliver it to ${destinationName(task.destination)} at ${task.transport_speed_mps} m/s. Select Start when you're ready.`)
      return
    }
    this.engine.record('task_validation', { issues, task })
    scope.retry = next => this.review(task, issues, corrected, next)
    await this.review(task, issues, corrected, scope)
  }

  async review(task, issues, corrected, scope) {
    const review = await this.query('review', { ...this.context(), task, issues }, scope)
    if (review.ready && !corrected) {
      scope.retry = next => this.build(next, issues, true)
      await this.build(scope, issues, true)
      return
    }
    const category = review.issue_type || (issues.some(issue => /speed/i.test(issue)) ? 'speed' : 'execution')
    this.ask({
      stage: 'execution_review', category, text: JSON.stringify(task),
      missing_information: review.reason || issues.join(' '),
      question: review.clarification_question || `${issues.join(' ')} How should I revise the task?`,
    })
  }

  syncRuntime() {
    const hold = this.engine.hold
    if (this.question?.runtimeId && this.question.runtimeId !== hold?.id) this.question = null
    if (this.running?.runtimeId && this.running.runtimeId !== hold?.id) {
      this.running.controller.abort()
      this.running = null
    }
    if (this.retryJob?.runtimeId && this.retryJob.runtimeId !== hold?.id) {
      this.retryJob = null
      this.error = null
    }
    if (!hold || hold.state !== 'AWAITING_ASSESSMENT' || this.running || this.attemptedId === hold.id) return
    this.attemptedId = hold.id
    void this.run(scope => this.assess(hold.id, scope), hold.id)
  }

  runtimeContext() {
    const { hold, task, cell, path, carrying, phase, time } = this.engine
    const observations = this.engine.log.filter(entry => entry.kind === 'robot_observation').slice(-8)
      .map(({ sim_time_s, data }) => ({ sim_time_s, ...data }))
    return {
      ...this.context(), original_task: this.engine.originalTask, task, observations,
      destination_authorization: { policy: task.destination_policy, current_destination: task.destination },
      situation: hold.situation, robot: { cell, path, carrying, phase, time },
    }
  }

  get runtimeProposer() {
    return this.mode === 'replay' ? 'replay_fixture' : 'gemini'
  }

  async assess(id, scope) {
    const result = await this.query('runtime', this.runtimeContext(), scope)
    const applied = this.engine.assess(id, result, this.runtimeProposer)
    if (applied.stale) return
    if (applied.issue) throw new Error(`Runtime proposal rejected. ${applied.issue}`)
    if (result.action === 'ASK_USER') this.askRuntime(id, result.clarification_question)
    else this.message('assistant', result.reason)
  }

  askRuntime(id, text, { confirmation = null, options } = {}) {
    const alternatives = this.engine.hold.situation.alternatives
    this.ask({
      category: 'runtime authorization', question: text, confirmation,
      options: options ?? [...alternatives.map(item => `Use ${destinationName(item)}`), 'Wait', 'Stop delivery'],
    }, id)
  }

  confirmRuntime(id, confirmation) {
    const { choice, destination } = confirmation
    const question = choice === 'REDIRECT' ? `Do you mean ${destinationName(destination)}?` :
      choice === 'WAIT' ? `Should I wait for ${destinationName(this.engine.task.destination)}?` : 'Should I stop the delivery?'
    this.askRuntime(id, question, { confirmation, options: ['Yes', 'No'] })
  }

  async answerRuntime(question, answer, scope) {
    const id = question.runtimeId
    const result = await this.query('authorize', { ...this.runtimeContext(), question, answer }, scope)
    const hold = this.engine.hold
    if (hold?.id !== id) return
    const proposer = this.runtimeProposer
    this.engine.record('runtime_reply_interpreted', { id, source: proposer, answer, interpretation: result })
    const { authorization, confirmation, rejected, issue } = runtimeAuthorization(
      answer, result, hold.situation, question.confirmation,
    )
    const applied = authorization ? this.engine.authorize(id, authorization, proposer) : null
    if (applied?.stale) return
    const accepted = Boolean(applied?.ok)
    const overridden = result.classification === 'CLEAR_AUTHORIZATION' && !accepted
    const validationIssue = applied?.issue ?? issue
    this.engine.record('authorization_validation', {
      id, source: 'deterministic', answer, authorization, accepted, confirmation, rejected, overridden, issue: validationIssue,
    })
    this.history.push({
      stage: 'runtime', category: question.category, question: question.question, answer,
      sufficient: accepted, classification: result.classification, confirmed_action: accepted ? authorization : null,
    })
    if (accepted) return
    if (confirmation) this.confirmRuntime(id, confirmation)
    else if (rejected) {
      this.askRuntime(id, `Should I wait for ${destinationName(this.engine.task.destination)}, or stop the delivery?`, { options: ['Wait', 'Stop delivery'] })
    } else if (question.confirmation && result.classification !== 'INVALID_REQUEST') {
      this.confirmRuntime(id, question.confirmation)
    } else {
      const followUp = result.follow_up_question.trim()
      const fallback = validationIssue ?? 'Please name an available destination or choose an action below.'
      this.askRuntime(id, followUp && followUp !== question.question ? followUp : fallback)
    }
  }

  control(callback) {
    const result = callback(this.engine)
    this.syncRuntime()
    this.publish()
    return result
  }
}
