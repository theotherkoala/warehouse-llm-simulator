import { useEffect, useRef, useState } from 'react'
import { DEMO_INSTRUCTION } from '../services.js'
import { Icon } from './Icon.jsx'

export function ChatPanel({ session }) {
  const { engine, messages, running, question, error, mode } = session
  const [draft, setDraft] = useState('')
  const input = useRef()
  const end = useRef()
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end', behavior: 'instant' })
  }, [messages.length, running, error])
  useEffect(() => { setDraft('') }, [engine])

  const send = value => {
    if (!value.trim() || !session.canSend) return
    setDraft('')
    void session.send(value)
  }
  const placeholder = question ? 'Type your answer…' : engine.active && session.canSend ? 'Ask for robot status…' : session.canSend ? 'Enter a robot instruction…' :
    engine.phase === 'READY' ? 'Task is ready. Select Start.' : 'Waiting for the next interaction…'
  const operatorQuestion = question?.runtimeId ? 'Runtime clarification' : 'Task clarification'

  return <section className="panel chat-panel" aria-labelledby="chat-heading">
    <header className="panel-heading">
      <div className="panel-icon"><Icon name="bot" size={20} /></div>
      <div><h2 id="chat-heading">Robot Assistant — Gemini</h2><p>Task clarification and runtime decisions</p></div>
      <span className="small-tag chat-mode">{mode === 'replay' ? 'Replay' : 'Live'}</span>
    </header>

    <div className="chat-history" role="log" aria-label="Robot conversation" aria-live="polite">
      {!messages.length && <div className="chat-intro">
        <div className="intro-icon"><Icon name="sparkle" size={24} /></div>
        <h3>Give the robot an instruction</h3>
        <p>The assistant checks your instruction against the warehouse and asks about choices it can’t resolve.</p>
        <button type="button" className="example-prompt" onClick={() => { setDraft(DEMO_INSTRUCTION); input.current?.focus() }}>
          <span><small>EXAMPLE INSTRUCTION</small>{DEMO_INSTRUCTION}</span><Icon name="arrow" size={17} />
        </button>
      </div>}
      {messages.map(message => {
        const current = question?.messageId === message.id
        if (message.role === 'system') return <div className="system-message" key={message.id}>
          <Icon name="info" size={14} /><span>{message.text}</span>
        </div>
        return <div key={message.id} className={`message ${message.role}`}>
          {message.role === 'assistant' && <div className="message-icon"><Icon name="bot" size={14} /></div>}
          <div className="message-content">
            <span className="message-label">{message.role === 'user' ? 'You' : current ? operatorQuestion : mode === 'replay' ? 'Replay assistant' : 'Gemini'}</span>
            <div className="message-body">{message.text}</div>
            {current && message.options.length > 0 && <div className="option-list">
              {message.options.map((option, index) =>
                <button type="button" key={index} className="option-button" onClick={() => send(option)}>{option}</button>)}
            </div>}
          </div>
        </div>
      })}
      {running && <div className="loading-message" role="status">
        <span className="loading-dots"><i /><i /><i /></span>
        {mode === 'replay' ? 'Reading replay response' : 'Gemini is assessing'}
      </div>}
      {error && <div className="chat-error" role="alert">
        <Icon name="info" size={16} /><div><p>{error}</p><button type="button" onClick={() => session.retry()}>Retry</button></div>
      </div>}
      <div ref={end} />
    </div>

    <div className="composer">
      <form onSubmit={event => { event.preventDefault(); send(draft) }}>
        <input ref={input} value={draft} onChange={event => setDraft(event.target.value)} maxLength={1600}
          aria-label={question ? 'Clarification answer' : engine.active ? 'Robot status query' : 'Robot instruction'} placeholder={placeholder} disabled={!session.canSend} />
        <button type="submit" className="primary send" disabled={!draft.trim() || !session.canSend} aria-label="Send">
          <Icon name="send" size={17} />
        </button>
      </form>
      <p><Icon name="info" size={13} /> One cargo per task. Use Reset to begin a new experiment.</p>
    </div>
  </section>
}
