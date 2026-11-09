import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ResearchSession } from './ResearchSession.js'
import { destinationName } from './simulation/warehouse.js'
import { STEP } from './simulation/WarehouseEngine.js'
import { ChatPanel } from './components/ChatPanel.jsx'
import { ExperimentControls } from './components/ExperimentControls.jsx'
import { ExperimentLog } from './components/ExperimentLog.jsx'
import { Icon } from './components/Icon.jsx'
import { WarehouseScene } from './visualization/WarehouseScene.jsx'

const phases = {
  IDLE: 'Standby', CLARIFYING: 'Clarifying task', READY: 'Ready', MOVING_TO_SHELF: 'To shelf',
  PICKING_UP: 'Picking up', MOVING_TO_DESTINATION: 'In transit', WAITING: 'Waiting',
  AWAITING_ASSESSMENT: 'Assessing', AWAITING_USER: 'Awaiting operator', COMPLETED: 'Delivered', STOPPED: 'Stopped',
}

function useSimulationClock(session, speed, engine) {
  const interpolation = useRef(0)
  const rate = useRef(speed)
  rate.current = speed
  useEffect(() => {
    let frame
    let previous
    interpolation.current = 0
    const tick = now => {
      const dt = previous === undefined ? 0 : Math.min((now - previous) / 1000, 0.2)
      previous = now
      if (engine.clockEnabled) {
        interpolation.current += dt * rate.current
        if (interpolation.current >= STEP) {
          session.control(sim => {
            while (interpolation.current >= STEP && sim.step()) interpolation.current -= STEP
          })
        }
      }
      if (!engine.clockEnabled) interpolation.current = 0
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [session, engine])
  return interpolation
}

function SimulationPanel({ session }) {
  const { engine } = session
  const [speed, setSpeed] = useState(1)
  const [camera, setCamera] = useState(0)
  const interpolation = useSimulationClock(session, speed, engine)
  useEffect(() => setSpeed(1), [engine])
  const visible = engine.visiblePhase
  const status = engine.paused ? 'Paused' : phases[visible]
  const attention = engine.paused || ['WAITING', 'AWAITING_ASSESSMENT', 'AWAITING_USER', 'STOPPED'].includes(visible)

  return <section className="panel simulation-panel" aria-labelledby="sim-heading">
    <header className="panel-heading">
      <div className="panel-icon"><Icon name="grid" size={19} /></div>
      <div><h2 id="sim-heading">Warehouse Simulation</h2><p>Real-time digital workspace</p></div>
      <span className={`status-tag ${attention ? 'attention' : ''}`}><i />{status}</span>
    </header>

    <div className="simulation-body">
      <div className="scene" aria-label="Interactive 3D warehouse">
        <WarehouseScene engine={engine} interpolation={interpolation} cameraRevision={camera} />
        <span className="scene-tag"><i /> GROUND TRUTH · 10 × 10 GRID</span>
        <span className="scene-hint">Drag to orbit · Scroll to zoom</span>
      </div>
      <div className="legend" aria-label="Scene legend">
        <span><i className="robot-key" /> AMR</span>
        <span><i className="route-key" /> Planned route</span>
        <span><i className="obstacle-key" /> Static obstacle</span>
        <span><i className="congestion-key" /> Congestion</span>
        <span><i className="blocked-key" /> Temporary block</span>
      </div>
      <div className="telemetry">
        <div><span>ROBOT</span><strong>AMR-01</strong><small>Cell {engine.cell.join(', ')}</small></div>
        <div><span>CARGO</span><strong>{engine.carrying ?? engine.delivered ?? engine.task?.target ?? '—'}</strong>
          <small>{engine.carrying ? 'On board' : engine.delivered ? 'Delivered' : engine.task ? 'At Shelf A' : 'Unassigned'}</small></div>
        <div><span>DESTINATION</span><strong>{destinationName(engine.task?.destination) ?? '—'}</strong>
          <small>{engine.task ? engine.task.destination_policy === 'DELEGATED' ? 'Delegated' : 'Fixed' : 'Unassigned'}</small></div>
        <div><span>SIMULATION TIME</span><strong>{engine.time.toFixed(2)} s</strong><small>{status}</small></div>
      </div>
      {engine.task && <p className="current-action"><span>Current action</span> {engine.action}</p>}
      <div className="simulation-toolbar" aria-label="Simulation controls">
        <div className="transport-controls">
          <button type="button" className="primary" disabled={engine.phase !== 'READY'} onClick={() => session.control(sim => sim.start())}>
            <Icon name="play" size={16} /> Start
          </button>
          <button type="button" disabled={!engine.active} onClick={() => session.control(sim => sim.setPaused(!sim.paused))}>
            <Icon name={engine.paused ? 'play' : 'pause'} size={16} /> {engine.paused ? 'Resume' : 'Pause'}
          </button>
          <button type="button" onClick={() => session.reset()}><Icon name="reset" size={16} /> Reset</button>
        </div>
        <div className="view-controls">
          <div className="speed-controls" role="group" aria-label="Simulation speed">
            {[1, 2, 4].map(rate => <button key={rate} type="button" aria-pressed={speed === rate}
              onClick={() => setSpeed(rate)}>{rate}×</button>)}
          </div>
          <button type="button" onClick={() => setCamera(n => n + 1)}><Icon name="camera" size={16} /> Reset camera</button>
        </div>
      </div>
      <ExperimentControls session={session} />
      <ExperimentLog session={session} />
    </div>
  </section>
}

export default function App() {
  const [session] = useState(() => new ResearchSession())
  const [api, setApi] = useState(null)
  useSyncExternalStore(session.subscribe, session.snapshot)
  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/status', { signal: controller.signal })
      .then(response => response.json())
      .then(status => {
        if (status.model) session.liveModel = status.model
        setApi(status)
      })
      .catch(() => {})
    return () => controller.abort()
  }, [session])

  return <>
    <header className="app-header">
      <div className="app-brand">
        <div className="brand-icon"><Icon name="box" size={23} /></div>
        <div><h1>Warehouse Clarification Lab</h1><p>Human–robot interaction research</p></div>
      </div>
      <div className="header-actions">
        <span className="header-label"><i className={session.mode === 'live' && api?.configured ? 'connected' : ''} />
          {session.mode === 'replay' ? 'Deterministic fixture' : api?.configured ? api.model : 'Gemini key required'}
        </span>
        <select aria-label="Research mode" title="Reset the experiment to switch modes" value={session.mode}
          disabled={session.engine.phase !== 'IDLE'} onChange={event => session.setMode(event.target.value)}>
          <option value="live">Live Gemini</option>
          <option value="replay">Replay fixture</option>
        </select>
      </div>
    </header>
    <main className="workspace">
      <ChatPanel session={session} />
      <SimulationPanel session={session} />
    </main>
  </>
}
