import { useLayoutEffect, useRef } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Html, Line, OrbitControls } from '@react-three/drei'
import { MathUtils } from 'three'
import {
  AREAS, CARGO, CONGESTION, GRID, OBSTACLES, PICKUP, SHELF, WORKERS, cellKey, sameDestination,
} from '../simulation/warehouse.js'

const sceneBackground = '#e8efeb'
const point = ([r, c], y = 0) => [c - (GRID - 1) / 2, y, r - (GRID - 1) / 2]

function Box({ position, size, color, shadow = true, receive = true }) {
  return <mesh position={position} castShadow={shadow} receiveShadow={receive}>
    <boxGeometry args={size} />
    <meshStandardMaterial color={color} roughness={0.78} />
  </mesh>
}

function Plate({ cell, color, width = 0.92, y = 0.013 }) {
  return <Box position={point(cell, y)} size={[width, 0.022, width]} color={color} shadow={false} />
}

function Label({ position, children, variant = '' }) {
  return <Html position={position} center zIndexRange={[20, 1]} className="world-label-anchor" style={{ pointerEvents: 'none' }}>
    <span className={`world-label ${variant}`}>{children}</span>
  </Html>
}

function WarehouseFloor() {
  const lines = []
  for (let i = 0; i <= GRID; i++) {
    const x = i - GRID / 2
    lines.push(<Line key={`x${i}`} points={[[x, 0.005, -5], [x, 0.005, 5]]} color="#bfccc6" lineWidth={1} />)
    lines.push(<Line key={`z${i}`} points={[[-5, 0.005, x], [5, 0.005, x]]} color="#bfccc6" lineWidth={1} />)
  }
  return <>
    <Box position={[0, -0.16, 0]} size={[10.2, 0.3, 10.2]} color="#d3dfda" />
    <Box position={[0, -0.032, 0]} size={[10, 0.064, 10]} color="#e4ebe7" shadow={false} />
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.325, 0]} receiveShadow>
      <planeGeometry args={[100, 100]} />
      <meshStandardMaterial color={sceneBackground} />
    </mesh>
    {lines}
    {Array.from({ length: GRID }, (_, i) => <group key={i}>
      <Label position={point([10.14, i], 0.01)} variant="axis">{i}</Label>
      <Label position={point([i, -0.66], 0.01)} variant="axis">{i}</Label>
    </group>)}
    <Plate cell={[0, 0]} color="#cfe3d9" />
    <Plate cell={PICKUP} color="#bfd9cd" />
    <Label position={point(PICKUP, 0.16)} variant="floor-label">PICKUP</Label>
  </>
}

function CargoBox({ id, position, size = 0.36, label = false }) {
  return <group position={position}>
    <Box position={[0, size * 0.43, 0]} size={[size, size * 0.86, size * 0.87]} color={CARGO[id].rgb} />
    <Box position={[0, size * 0.86 + 0.005, 0]} size={[size * 0.24, 0.012, size * 0.86]} color="#faf2dc" shadow={false} />
    {label && <Label position={[0, size * 0.39, size * 0.48]} variant="cargo-tag">{id}</Label>}
  </group>
}

function ShelfModel({ missing }) {
  const [r, c] = SHELF[0]
  return <group position={point([r + 0.5, c + 0.5])}>
    {[0.13, 0.74, 1.35].map(y => <Box key={y} position={[0, y, 0]} size={[1.8, 0.1, 1.78]} color="#789c8e" />)}
    {[-0.85, 0.85].flatMap(x => [-0.84, 0.84].map(z =>
      <Box key={`${x},${z}`} position={[x, 0.75, z]} size={[0.075, 1.5, 0.075]} color="#497568" />))}
    <Box position={[0, 1.43, 0.84]} size={[1.68, 0.24, 0.09]} color="#537d70" />
    <Label position={[0, 1.48, 0.91]} variant="shelf-tag">Shelf A</Label>
    {Object.keys(CARGO).map((id, i) => id !== missing &&
      <CargoBox key={id} id={id} position={[(i - 1) * 0.53, 0.79, 0.59]} label />)}
  </group>
}

function Stripes({ cell, blocked = false }) {
  const colors = blocked ? ['#eecfca', '#ba756b'] : ['#eee4cd', '#b9a471']
  return <group position={point(cell)}>
    <Box position={[0, 0.009, 0]} size={[0.94, 0.014, 0.94]} color={colors[0]} shadow={false} />
    {[-0.24, 0, 0.24].map(z => <group key={z} position={[0, 0.023, z]} rotation={[0, -0.38, 0]}>
      <Box position={[0, 0, 0]} size={[0.64, 0.012, 0.043]} color={colors[1]} shadow={false} />
    </group>)}
    {blocked && <Box position={[0, 0.13, 0]} size={[0.63, 0.22, 0.13]} color="#aa6057" />}
  </group>
}

function PackingArea({ name, location, status, delivered }) {
  const color = status.open ? '#78a59c' : '#a76561'
  const state = !status.open ? 'Closed' : status.receiverAvailable ? 'Available' : 'Receiver busy'
  const variant = !status.open ? 'closed' : status.receiverAvailable ? 'available' : 'busy'
  return <group position={point(location)}>
    <Box position={[0, 0.02, 0]} size={[1.02, 0.04, 0.96]} color={status.open ? '#bcdad0' : '#e5c1bc'} shadow={false} />
    <Box position={[0.07, 0.16, 0]} size={[0.72, 0.28, 0.55]} color={color} />
    <Box position={[0.07, 0.32, 0]} size={[0.78, 0.055, 0.62]} color={status.open ? '#a8c8bd' : '#c69389'} />
    <Box position={[-0.44, 0.37, -0.29]} size={[0.052, 0.69, 0.052]} color="#5a8176" />
    <mesh position={[-0.44, 0.72, -0.29]}>
      <sphereGeometry args={[0.073, 12, 8]} />
      <meshStandardMaterial color={variant === 'available' ? '#6bac83' : variant === 'busy' ? '#dfb358' : '#ce6e61'} />
    </mesh>
    {delivered && <CargoBox id={delivered} position={[0.11, 0.35, 0]} />}
    <Label position={[0.25, 0.23, 0.65]} variant={`packing-tag ${variant}`}>
      <strong>{name}</strong><small>{state}</small>
    </Label>
  </group>
}

function Worker({ cell, available, name, delivered }) {
  const color = available ? '#cba960' : '#c2816d'
  return <group position={point(cell)}>
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
      <ringGeometry args={[0.29, 0.32, 26]} />
      <meshBasicMaterial color={color} />
    </mesh>
    <Box position={[-0.06, 0.12, 0]} size={[0.082, 0.23, 0.13]} color="#556f78" />
    <Box position={[0.06, 0.12, 0]} size={[0.082, 0.23, 0.13]} color="#556f78" />
    <mesh position={[0, 0.3, 0]} castShadow>
      <capsuleGeometry args={[0.13, 0.19, 4, 12]} />
      <meshStandardMaterial color={color} />
    </mesh>
    <mesh position={[0, 0.55, 0]} castShadow>
      <sphereGeometry args={[0.115, 14, 10]} />
      <meshStandardMaterial color="#e0c6a8" />
    </mesh>
    {delivered && <CargoBox id={delivered} position={[0.33, 0.03, 0.16]} size={0.27} />}
    <Label position={[0, 0.75, 0]} variant="worker-tag">{name}</Label>
  </group>
}

function RobotModel({ engine, interpolation }) {
  const root = useRef()
  const body = useRef()
  useFrame((_, delta) => {
    const [x, , z] = point(engine.cell)
    const next = engine.path[0]
    const [nx, , nz] = next ? point(next) : [x, 0, z]
    const moving = engine.clockEnabled && !engine.hold && engine.phase !== 'PICKING_UP'
    const speed = engine.phase === 'MOVING_TO_SHELF' ? 0.82 : engine.task?.transport_speed_mps ?? 0
    const fraction = Math.min(1, engine.fraction + (moving ? interpolation.current * speed : 0))
    root.current.position.set(MathUtils.lerp(x, nx, fraction), 0, MathUtils.lerp(z, nz, fraction))
    const angle = body.current.rotation.y
    const turn = Math.atan2(Math.sin(engine.heading - angle), Math.cos(engine.heading - angle))
    if (moving) body.current.rotation.y = MathUtils.damp(angle, angle + turn, 14, delta)
  })
  const initial = point(engine.cell)
  return <group ref={root} position={initial}>
    <group ref={body}>
      <Box position={[0, 0.145, 0]} size={[0.69, 0.19, 0.74]} color="#345b55" />
      <Box position={[0, 0.261, -0.015]} size={[0.59, 0.105, 0.62]} color="#78ac9f" />
      <Box position={[0, 0.216, 0.375]} size={[0.41, 0.06, 0.035]} color="#b8f1db" />
      {[-0.33, 0.33].flatMap(x => [-0.23, 0.23].map(z =>
        <Box key={`${x},${z}`} position={[x, 0.097, z]} size={[0.11, 0.18, 0.21]} color="#304844" />))}
      <Box position={[0, 0.315, 0.17]} size={[0.33, 0.018, 0.14]} color="#dae9e1" shadow={false} />
      {engine.carrying && <CargoBox id={engine.carrying} position={[0, 0.33, -0.075]} size={0.36} />}
    </group>
    <Label position={[0, engine.carrying ? 0.89 : 0.61, 0]} variant="robot-tag"><i /> AMR-01{engine.carrying ? ` · ${engine.carrying}` : ''}</Label>
  </group>
}

function SceneCamera({ revision }) {
  const controls = useRef()
  const { camera, size } = useThree()
  const horizontalSpan = size.width < 500 ? 14 : 13.3
  const zoom = Math.min(size.width / horizontalSpan, size.height / 9.3)
  useLayoutEffect(() => {
    const orbit = controls.current
    camera.position.set(4, 14, 18)
    camera.zoom = zoom
    camera.updateProjectionMatrix()
    orbit.target.set(0, 0.19, 0)
    orbit.update()
  }, [camera, zoom, revision])
  return <OrbitControls ref={controls} makeDefault enablePan={false} enableDamping
    minZoom={zoom * 0.68} maxZoom={zoom * 2.6} minPolarAngle={0.19} maxPolarAngle={Math.PI / 2.15} />
}

export function WarehouseScene({ engine, interpolation, cameraRevision }) {
  const route = engine.path.length ? [engine.cell, ...engine.path] : []
  return <Canvas orthographic shadows dpr={[1, 1.7]} camera={{ near: 0.1, far: 100, position: [4, 14, 18] }}
    fallback={<div className="webgl-fallback">WebGL is unavailable. The simulation and controls remain active.</div>}>
    <color attach="background" args={[sceneBackground]} />
    <ambientLight intensity={1.05} />
    <hemisphereLight args={['#ffffff', '#b8c9bf', 1.1]} />
    <directionalLight position={[-5, 12, -4]} intensity={1.8} castShadow
      shadow-mapSize={[1024, 1024]} shadow-camera-left={-8} shadow-camera-right={8}
      shadow-camera-top={8} shadow-camera-bottom={-8} shadow-normalBias={0.035} />
    <SceneCamera revision={cameraRevision} />
    <WarehouseFloor />
    {OBSTACLES.map(cell => <Box key={cellKey(cell)} position={point(cell, 0.33)} size={[0.71, 0.66, 0.72]} color="#9eafaf" />)}
    {CONGESTION.map(cell => <Stripes key={cellKey(cell)} cell={cell} />)}
    {[...engine.world.blocked].map(key => <Stripes key={key} cell={key.split(',').map(Number)} blocked />)}
    <ShelfModel missing={engine.carrying ?? engine.delivered} />
    {Object.entries(AREAS).map(([name, area]) =>
      <PackingArea key={name} name={name} location={area.cell} status={engine.world.areas[name]}
        delivered={sameDestination(engine.task?.destination, { type: 'PACKING_AREA', id: name }) ? engine.delivered : null} />)}
    {Object.entries(engine.world.workers).map(([id, worker]) =>
      <Worker key={id} cell={worker.cell} available={worker.available} name={WORKERS[id].name}
        delivered={sameDestination(engine.task?.destination, { type: 'WORKER', id }) ? engine.delivered : null} />)}
    {route.length > 1 && <Line points={route.map(cell => point(cell, 0.057))} color="#338673" lineWidth={3.25} />}
    {route.slice(1).map(cell => <mesh key={cellKey(cell)} position={point(cell, 0.061)} rotation={[-Math.PI / 2, 0, 0]}>
      <circleGeometry args={[0.07, 14]} />
      <meshBasicMaterial color="#287d69" />
    </mesh>)}
    <RobotModel engine={engine} interpolation={interpolation} />
  </Canvas>
}
