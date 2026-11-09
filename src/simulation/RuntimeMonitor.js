import { areaNames, cellKey, createWorld, workerIds } from './warehouse.js'

export class RuntimeMonitor {
  knowledge = createWorld()

  observe(world, robot) {
    const observations = []
    for (const area of areaNames) {
      const current = world.areas[area]
      const previous = this.knowledge.areas[area]
      if (current.open !== previous.open) {
        observations.push({ kind: 'area', area, value: current.open, channel: 'status_feed' })
      }
      if (current.receiverAvailable !== previous.receiverAvailable) {
        observations.push({ kind: 'receiver', area, value: current.receiverAvailable, channel: 'status_feed' })
      }
      this.knowledge.areas[area] = { ...current }
    }
    for (const workerId of workerIds) {
      const current = world.workers[workerId]
      if (current.available !== this.knowledge.workers[workerId].available) {
        observations.push({ kind: 'worker', workerId, value: current.available, channel: 'status_feed' })
      }
      this.knowledge.workers[workerId] = { cell: [...current.cell], available: current.available }
    }
    for (let row = robot[0] - 1; row <= robot[0] + 1; row++) {
      for (let col = robot[1] - 1; col <= robot[1] + 1; col++) {
        // The 3×3 neighborhood is the set of cells within a 1.5-cell Euclidean radius.
        const cell = [row, col]
        const key = cellKey(cell)
        const value = world.blocked.has(key)
        if (value === this.knowledge.blocked.has(key)) continue
        if (value) this.knowledge.blocked.add(key)
        else this.knowledge.blocked.delete(key)
        observations.push({ kind: 'aisle', cell, value, channel: 'local_sensor' })
      }
    }
    return observations
  }
}
