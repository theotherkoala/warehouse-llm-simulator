import express from 'express'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PROMPT_VERSION, requestSchema } from '../shared/contracts.js'
import { createGeminiService } from './gemini.js'

const app = express()
const gemini = createGeminiService()
const dist = fileURLToPath(new URL('../dist', import.meta.url))
app.disable('x-powered-by')
app.use('/api', (_, res, next) => {
  res.set('Cache-Control', 'no-store')
  next()
})
app.get('/api/status', (_, res) => res.json({
  configured: gemini.configured, model: gemini.model, prompt_version: PROMPT_VERSION,
}))
app.post('/api/gemini', express.json({ limit: '96kb' }), async (req, res) => {
  const parsed = requestSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid Gemini operation or context.' })
  const abort = new AbortController()
  res.on('close', () => abort.abort())
  try {
    const { operation, context } = parsed.data
    const { status = 200, ...result } = await gemini.request(operation, context, abort.signal)
    if (!abort.signal.aborted) res.status(status).json(result)
  } catch {
    if (!abort.signal.aborted) res.status(502).json({ error: 'Gemini request failed. Retry when ready.' })
  }
})
app.use('/api', (_, res) => res.status(404).json({ error: 'Unknown API route.' }))
app.use((error, _req, res, _next) => {
  res.status(error.status === 413 ? 413 : 400).json({ error: 'Invalid or oversized request.' })
})
if (existsSync(dist)) app.use(express.static(dist))

const port = Number(process.env.PORT || 8787)
app.listen(port, '127.0.0.1', () => {
  console.log(`Warehouse API on http://127.0.0.1:${port} (${gemini.configured ? gemini.model : 'key required for Live mode'})`)
})
