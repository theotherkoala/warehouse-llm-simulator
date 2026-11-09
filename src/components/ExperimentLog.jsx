import { Icon } from './Icon.jsx'

const csvCell = value => `"${String(value).replaceAll('"', '""')}"`

export function exportReport(engine, format) {
  const report = engine.report()
  const csv = () => ['sequence,sim_time_s,kind,data', ...report.events.map(event =>
    [event.sequence, event.sim_time_s, event.kind, JSON.stringify(event.data)].map(csvCell).join(','))].join('\r\n')
  const contents = format === 'json' ? JSON.stringify(report, null, 2) : csv()
  const type = format === 'json' ? 'application/json' : 'text/csv'
  const url = URL.createObjectURL(new Blob([contents], { type: `${type};charset=utf-8` }))
  const link = document.createElement('a')
  link.href = url
  link.download = `warehouse-experiment.${format}`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function ExperimentLog({ session }) {
  const { engine } = session
  const stats = engine.stats()
  return <details className="research-section">
    <summary><span><Icon name="log" size={17} /> Experiment Log <small>{engine.log.length}</small></span><Icon name="chevron" size={15} /></summary>
    <div className="research-content">
      <div className="log-toolbar">
        <p>{stats.clarification_rounds} clarification rounds · {stats.replans} replans · {stats.waiting_time_s.toFixed(2)} s waiting</p>
        <div>
          <button type="button" onClick={() => exportReport(engine, 'json')}>Export JSON</button>
          <button type="button" onClick={() => exportReport(engine, 'csv')}>Export CSV</button>
          <button type="button" onClick={() => session.reset()}>Reset experiment</button>
        </div>
      </div>
      <div className="log-entries">
        {engine.log.map(entry => <details key={entry.sequence}>
          <summary><time>{entry.sim_time_s.toFixed(2)} s</time><span>{entry.kind.replaceAll('_', ' ')}</span></summary>
          <pre>{JSON.stringify(entry.data, null, 2)}</pre>
        </details>)}
      </div>
    </div>
  </details>
}
