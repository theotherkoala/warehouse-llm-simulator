import { z } from 'zod'

const text = z.string()
const destination = z.union([
  z.object({ type: z.enum(['PACKING_AREA']), id: z.enum(['Packing Area 1', 'Packing Area 2']) }),
  z.object({ type: z.enum(['WORKER']), id: z.enum(['worker-1', 'worker-2']) }),
])
const ambiguity = z.object({
  text, category: text, reason: text, missing_information: text, question: text,
  options: z.array(text).max(5),
})

export const responses = {
  analyze: z.object({ ambiguities: z.array(ambiguity).max(8) }),
  evaluate: z.object({ sufficient: z.boolean(), reason: text, follow_up_question: text }),
  task: z.object({
    target: text, source: text, destination: destination.nullable(), transport_speed_mps: z.number().nullable(),
    destination_policy: z.enum(['FIXED', 'DELEGATED']), delegation_evidence: text,
  }),
  review: z.object({ ready: z.boolean(), issue_type: text, reason: text, clarification_question: text }),
  runtime: z.object({
    action: z.enum(['CONTINUE', 'WAIT', 'REPLAN', 'ASK_USER', 'STOP']),
    reason: text,
    triggering_event: z.enum(['AREA_CLOSED', 'RECEIVER_BUSY', 'WORKER_UNAVAILABLE', 'AISLE_BLOCKED']),
    affects_active_task: z.boolean(),
    original_intent_executable: z.boolean(),
    autonomous_adaptation_possible: z.boolean(),
    uncertainty_category: z.enum(['NONE', 'ENVIRONMENT_STATE', 'ROUTE_FEASIBILITY', 'DESTINATION_AUTHORIZATION', 'OPERATOR_INTENT']),
    clarification_needed: z.boolean(),
    requires_authorization: z.boolean(),
    proposed_alternative: destination.nullable(),
    clarification_question: text,
  }),
  authorize: z.object({
    classification: z.enum(['CLEAR_AUTHORIZATION', 'CLEAR_REJECTION', 'INCOMPLETE_OR_AMBIGUOUS', 'INVALID_REQUEST']),
    choice: z.enum(['REDIRECT', 'WAIT', 'STOP', 'NONE']),
    destination: destination.nullable(), evidence: text, reason: text, follow_up_question: text,
  }),
}

export const requestSchema = z.object({
  operation: z.enum(Object.keys(responses)),
  context: z.record(z.string(), z.unknown()),
})

export const PROMPT_VERSION = 'warehouse-1.2.1'
export const DEFAULT_MODEL = 'gemini-3.8-flash'
