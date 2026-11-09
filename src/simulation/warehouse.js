export const GRID = 10
export const START = [0, 0]
export const PICKUP = [6, 2]
export const SHELF = [[4, 1], [4, 2], [5, 1], [5, 2]]
export const OBSTACLES = [[2, 6], [6, 4], [7, 2], [1, 3], [2, 4]]
export const CONGESTION = [[3, 6], [4, 6], [7, 6]]
export const RISK_SPEED = 0.8
export const CARGO = {
  A1: { colour: 'Red', rgb: '#d24e4e', fragile: true },
  A2: { colour: 'Blue', rgb: '#4e7ed2', fragile: true },
  A3: { colour: 'Yellow', rgb: '#dfb446', fragile: true },
}
export const AREAS = {
  'Packing Area 1': { cell: [1, 8], receiver: 'Receiver 1', workerId: 'worker-1' },
  'Packing Area 2': { cell: [8, 8], receiver: 'Receiver 2', workerId: 'worker-2' },
}
export const WORKERS = {
  'worker-1': { name: 'Worker 1', cell: [6, 7] },
  'worker-2': { name: 'Worker 2', cell: [4, 8] },
}
export const areaNames = Object.keys(AREAS)
export const workerIds = Object.keys(WORKERS)
export const DESTINATIONS = [
  ...areaNames.map(id => ({ type: 'PACKING_AREA', id })),
  ...workerIds.map(id => ({ type: 'WORKER', id })),
]
export const cellKey = cell => cell.join(',')
export const inGrid = cell => Array.isArray(cell) && cell.length === 2 &&
  cell.every(n => Number.isInteger(n) && n >= 0 && n < GRID)
export const distance = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1])
export const FIXED_BLOCKS = new Set([...SHELF, ...OBSTACLES, ...CONGESTION].map(cellKey))

export function normalizePackingDestination(destination) {
  return areaNames.includes(destination) ? { type: 'PACKING_AREA', id: destination } : destination
}

export function sameDestination(left, right) {
  return Boolean(left?.type && left.type === right?.type && left.id === right.id)
}

export function destinationName(destination) {
  if (destination?.type === 'WORKER') return WORKERS[destination.id]?.name
  if (destination?.type === 'PACKING_AREA') return destination.id
}

export function destinationStatus(world, destination) {
  if (destination?.type === 'PACKING_AREA' && areaNames.includes(destination.id)) {
    const { open, receiverAvailable } = world.areas[destination.id]
    return { open, available: receiverAvailable, cell: AREAS[destination.id].cell }
  }
  if (destination?.type === 'WORKER' && workerIds.includes(destination.id)) {
    const { available, cell } = world.workers[destination.id]
    return { open: true, available, cell }
  }
  return null
}

export function atHandoverCell(cell, destination, world) {
  const status = destinationStatus(world, destination)
  return status && distance(cell, status.cell) === (destination.type === 'WORKER' ? 1 : 0)
}

export function deliveryPath(start, destination, world) {
  const status = destinationStatus(world, destination)
  if (!status) return null
  if (destination.type === 'PACKING_AREA') return findPath(start, status.cell, world.blocked)

  const [row, col] = status.cell
  const occupied = Object.values(world.workers).map(worker => cellKey(worker.cell))
  const blocked = new Set([...world.blocked, ...occupied])
  let shortest = null
  for (const cell of [[row - 1, col], [row, col - 1], [row, col + 1], [row + 1, col]]) {
    const path = findPath(start, cell, blocked)
    if (path && (!shortest || path.length < shortest.length)) shortest = path
  }
  return shortest
}

export function createWorld() {
  return {
    areas: Object.fromEntries(areaNames.map(name => [name, { open: true, receiverAvailable: true }])),
    workers: Object.fromEntries(workerIds.map(id => [id, { cell: [...WORKERS[id].cell], available: true }])),
    blocked: new Set(),
  }
}

export function describeWorld(world) {
  return {
    grid: { rows: GRID, columns: GRID, cell_m: 1 },
    robot: { start: START, default_unloaded_speed_mps: 1, simulated_unloaded_speed_mps: 0.82 },
    task_scope: 'Each run transports exactly one cargo item. Shelf A is the only source.',
    shelves: {
      'Shelf A': {
        position: SHELF[0], occupied_cells: SHELF, pickup: PICKUP,
        cargo: Object.fromEntries(Object.entries(CARGO).map(([id, { colour, fragile }]) => [id, { colour, fragile }])),
      },
    },
    packing_areas: Object.fromEntries(areaNames.map(name => [name, {
      position: AREAS[name].cell,
      status: world.areas[name].open ? 'available' : 'closed',
      receiver: AREAS[name].receiver,
      receiver_status: world.areas[name].receiverAvailable ? 'available' : 'busy',
      assigned_worker_id: AREAS[name].workerId,
    }])),
    workers: Object.fromEntries(workerIds.map(id => [id, {
      name: WORKERS[id].name, position: world.workers[id].cell,
      status: world.workers[id].available ? 'available' : 'unavailable',
    }])),
    obstacle_cells: OBSTACLES,
    congested_cells: CONGESTION,
    observed_temporary_blocks: [...world.blocked].sort().map(key => key.split(',').map(Number)),
    delivery_rules: 'Deliver either to an open packing area with an available receiver, or directly to an available worker at an adjacent cell. Worker and packing-area receiver availability are tracked separately.',
    safety_rules: {
      fragile_cargo_risk_speed_mps: RISK_SPEED,
      fragile_speed_rule: 'Speeds above 0.8 m/s are rejected. 0.8 m/s is the maximum safe speed, not the default.',
      obstacles_and_congestion_must_be_avoided: true,
    },
  }
}

export function findPath(start, goal, extra = new Set()) {
  const blocked = cell => FIXED_BLOCKS.has(cellKey(cell)) || extra.has(cellKey(cell))
  if (!inGrid(start) || !inGrid(goal) || blocked(start) || blocked(goal)) return null
  const queue = [{ cell: start, g: 0, f: distance(start, goal) }]
  const previous = new Map()
  const scores = new Map([[cellKey(start), 0]])
  const goalKey = cellKey(goal)
  while (queue.length) {
    // The small grid permits a sorted frontier. Match Python's (f, g, row, column) tie order.
    queue.sort((a, b) => a.f - b.f || a.g - b.g || a.cell[0] - b.cell[0] || a.cell[1] - b.cell[1])
    const { cell, g } = queue.shift()
    const key = cellKey(cell)
    if (g !== scores.get(key)) continue
    if (key === goalKey) {
      const path = [cell]
      while (previous.has(cellKey(path.at(-1)))) path.push(previous.get(cellKey(path.at(-1))))
      return path.reverse()
    }
    const [r, c] = cell
    for (const next of [[r + 1, c], [r - 1, c], [r, c + 1], [r, c - 1]]) {
      if (!inGrid(next) || blocked(next)) continue
      const nextKey = cellKey(next)
      if (g + 1 >= (scores.get(nextKey) ?? Infinity)) continue
      scores.set(nextKey, g + 1)
      previous.set(nextKey, cell)
      queue.push({ cell: next, g: g + 1, f: g + 1 + distance(next, goal) })
    }
  }
  return null
}
