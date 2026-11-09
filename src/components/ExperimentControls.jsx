import { useEffect, useState } from 'react'
import { AREAS, WORKERS, areaNames, workerIds } from '../simulation/warehouse.js'
import { eventLabel } from '../simulation/WarehouseEngine.js'
import { Icon } from './Icon.jsx'

const eventTypes = {
  close_area: { kind: 'area', value: false, label: 'Close packing area' },
  reopen_area: { kind: 'area', value: true, label: 'Reopen packing area' },
  busy: { kind: 'receiver', value: false, label: 'Set receiver busy' },
  available: { kind: 'receiver', value: true, label: 'Set receiver available' },
  worker_unavailable: { kind: 'worker', value: false, label: 'Set worker unavailable' },
  worker_available: { kind: 'worker', value: true, label: 'Set worker available' },
  block: { kind: 'aisle', value: true, label: 'Block aisle' },
  unblock: { kind: 'aisle', value: false, label: 'Reopen aisle' },
}
const phases = {
  MOVING_TO_SHELF: 'Travel to shelf',
  PICKING_UP: 'Pickup',
  MOVING_TO_DESTINATION: 'Transport cargo',
}

export function ExperimentControls({ session }) {
  const { engine } = session
  const [type, setType] = useState('close_area')
  const [area, setArea] = useState(areaNames[1])
  const [workerId, setWorkerId] = useState(workerIds[0])
  const [row, setRow] = useState('0')
  const [column, setColumn] = useState('1')
  const [trigger, setTrigger] = useState('now')
  const [time, setTime] = useState('15')
  const [phase, setPhase] = useState('MOVING_TO_DESTINATION')
  const [feedback, setFeedback] = useState('')
  useEffect(() => setFeedback(''), [engine])

  const { kind, value } = eventTypes[type]
  const submit = event => {
    event.preventDefault()
    let change = { kind, value, area }
    if (kind === 'aisle') change = { kind, value, cell: [Number(row), Number(column)] }
    if (kind === 'worker') change = { kind, value, workerId }
    const when = trigger === 'time' ? { type: 'time', time: Number(time) } : { type: 'phase', phase }
    const issue = session.control(sim => trigger === 'now' ? sim.inject(change) : sim.scheduleEvent(change, when))
    setFeedback(issue ?? (trigger === 'now' ? 'Event applied to the warehouse.' : 'Event scheduled.'))
  }

  return <details className="research-section">
    <summary><span><Icon name="flask" size={17} /> Experiment Controls</span><Icon name="chevron" size={15} /></summary>
    <div className="research-content">
      <form className="event-form" onSubmit={submit}>
        <label>Event
          <select value={type} onChange={event => { setType(event.target.value); setFeedback('') }}>
            {Object.entries(eventTypes).map(([id, { label }]) => <option key={id} value={id}>{label}</option>)}
          </select>
        </label>
        {kind === 'aisle' ? <div className="cell-fields">
          <label>Row<input type="number" value={row} required min="0" max="9" onChange={event => setRow(event.target.value)} /></label>
          <label>Column<input type="number" value={column} required min="0" max="9" onChange={event => setColumn(event.target.value)} /></label>
          <button type="button" disabled={!engine.path.length} onClick={() => {
            setRow(String(engine.path[0][0])); setColumn(String(engine.path[0][1]))
          }}>Use next cell</button>
        </div> : kind === 'worker' ? <label>Worker
          <select value={workerId} onChange={event => setWorkerId(event.target.value)}>
            {workerIds.map(id => <option key={id} value={id}>{WORKERS[id].name}</option>)}
          </select>
        </label> : <label>{kind === 'receiver' ? 'Receiver' : 'Packing area'}
          <select value={area} onChange={event => setArea(event.target.value)}>
            {areaNames.map(name => <option key={name} value={name}>{kind === 'receiver' ? AREAS[name].receiver : name}</option>)}
          </select>
        </label>}
        <label>Trigger
          <select value={trigger} onChange={event => setTrigger(event.target.value)}>
            <option value="now">Apply now</option>
            <option value="time">Simulation time</option>
            <option value="phase">Execution phase</option>
          </select>
        </label>
        {trigger === 'time' && <label>Simulation seconds
          <input type="number" value={time} required min={engine.time} step="any" onChange={event => setTime(event.target.value)} />
        </label>}
        {trigger === 'phase' && <label>Phase
          <select value={phase} onChange={event => setPhase(event.target.value)}>
            {Object.entries(phases).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
        </label>}
        <button className="secondary event-submit" type="submit">{trigger === 'now' ? 'Apply event' : 'Schedule event'}</button>
      </form>
      {session.mode === 'replay' && <div className="event-form fixture-controls">
        <label>Replay fault injection
          <select value={session.fixtureFault} onChange={event => session.setFixtureFault(event.target.value)}>
            <option value="none">None</option>
            <option value="decision">Invalid runtime decision</option>
            <option value="api">API failure</option>
          </select>
        </label>
      </div>}
      {feedback && <p role="status" className="control-feedback">{feedback}</p>}
      <div className="environment-list">
        {areaNames.map((name, index) => <div key={name}>
          <strong>{name}</strong>
          <span>{engine.world.areas[name].open ? 'Open' : 'Closed'} · R{index + 1} {engine.world.areas[name].receiverAvailable ? 'available' : 'busy'}</span>
        </div>)}
        {workerIds.map(id => <div key={id}>
          <strong>{WORKERS[id].name}</strong>
          <span>{engine.world.workers[id].available ? 'Available' : 'Unavailable'}</span>
        </div>)}
        <div><strong>Blocked aisles</strong><span>{[...engine.world.blocked].map(key => `(${key.replace(',', ', ')})`).join('  ') || 'None'}</span></div>
      </div>
      {engine.schedule.length > 0 && <ul className="schedule-list" aria-label="Scheduled events">
        {engine.schedule.map(item => <li key={item.id}>
          <span>{eventLabel(item.event)} <small>{item.trigger.type === 'time' ? `At ${item.trigger.time} s` : phases[item.trigger.phase]} · {item.status}</small></span>
          {item.status === 'pending' && <button type="button" onClick={() => session.control(sim => sim.removeSchedule(item.id))}>Remove</button>}
        </li>)}
      </ul>}
    </div>
  </details>
}
