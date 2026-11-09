import { setTimeout as delay } from 'node:timers/promises'
import { GoogleGenAI } from '@google/genai'
import { z } from 'zod'
import { DEFAULT_MODEL, PROMPT_VERSION, responses } from '../shared/contracts.js'
import { buildPrompt } from './prompts.js'

const jsonSchemas = Object.fromEntries(Object.entries(responses).map(([operation, schema]) => {
  const { $schema, ...jsonSchema } = z.toJSONSchema(schema)
  return [operation, jsonSchema]
}))

export function createGeminiService({ key = process.env.GEMINI_API_KEY, model = process.env.GEMINI_MODEL || DEFAULT_MODEL } = {}) {
  const ai = key ? new GoogleGenAI({ apiKey: key, httpOptions: { timeout: 18_000, retryOptions: { attempts: 1 } } }) : null
  return {
    model,
    configured: Boolean(ai),
    async request(operation, context, signal) {
      const started = performance.now()
      const meta = () => ({
        model, prompt_version: PROMPT_VERSION, latency_ms: Math.round(performance.now() - started),
      })
      if (!ai) return { status: 503, error: 'Set GEMINI_API_KEY on the local server and restart it.', ...meta(), attempts: 0 }
      for (let attempt = 1; attempt <= 2; attempt++) {
        let invalid = false
        try {
          const result = await ai.models.generateContent({
            model,
            contents: buildPrompt(operation, context),
            config: {
              temperature: 0.1,
              responseMimeType: 'application/json',
              responseJsonSchema: jsonSchemas[operation],
              automaticContinuation: false,
              abortSignal: signal,
            },
          })
          invalid = true
          const response = responses[operation].parse(JSON.parse(result.text ?? ''))
          return { response, ...meta(), attempts: attempt }
        } catch (error) {
          if (signal?.aborted) throw error
          const status = Number(error.status)
          const retryable = invalid || status === 429 || status >= 500 || !status
          if (attempt === 1 && retryable) {
            await delay(400, undefined, { signal })
            continue
          }
          const message = invalid ? 'Gemini returned an invalid structured response.' :
            status === 429 ? 'Gemini quota or rate limit reached. Check your quota and retry.' :
              status === 404 ? 'Gemini could not find the configured model. Check GEMINI_MODEL.' :
                [400, 401, 403].includes(status) ? 'Gemini rejected the request. Check the API key and model access.' :
                  'Gemini is temporarily unavailable. Retry when ready.'
          return { status: 502, error: message, ...meta(), attempts: attempt }
        }
      }
    },
  }
}
