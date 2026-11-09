# Warehouse Clarification Lab

A browser-based research prototype for interactive robot instruction clarification and runtime adaptation. The left panel hosts the Gemini conversation. The right panel shows the same experiment as a Three.js warehouse with an animated AMR, cargo, receivers, and the current route.

## Run locally

Use Node.js 22.12 or later and a browser with WebGL 2.

```bash
npm install
cp .env.example .env
```

Set `GEMINI_API_KEY` in `.env` for Live Gemini. Set `GEMINI_MODEL` to a structured-output-capable model available to your key. The example uses `gemini-3.8-flash`. The Node proxy binds to loopback and holds the key server-side. The Vite client calls the same-origin proxy.

```bash
npm run dev
```

Open [http://127.0.0.1:5173/](http://127.0.0.1:5173/). The development command starts Vite and the Express proxy together. If a default port is in use, set `WEB_PORT` or `PORT` in `.env` and restart. For a production build on the same machine, run `npm run build` and then `npm start`, and open [http://127.0.0.1:8787/](http://127.0.0.1:8787/). For tests, run `npm test`.

The **Replay fixture** in the mode menu runs the included experiment without a key. Live mode sends the instruction, clarification history, and observed warehouse context to the Google Gemini API. [Gemini API structured output](https://ai.google.dev/gemini-api/docs/structured-output)

## Run the closure experiment

1. Select **Live Gemini** or **Replay fixture**. Select **Example instruction** and send it. The example is “Transport the fragile cargo on Shelf A to the packing area quickly.”
2. Select or type answers for cargo **A2**, **Packing Area 2**, and **Maximum safe speed**. A confirmed maximum maps to 0.8 m/s. After validation, the task is ready and **Start** becomes available.
3. Open **Experiment Controls**. Choose **Close packing area**, **Packing Area 2**, **Execution phase**, and **Transport cargo**. Select **Schedule event**. For manual timing, select **Apply now** and apply the event after cargo is on board.
4. Select **Start**. Use **4×** to shorten wall-clock time. The robot moves to Shelf A and picks up A2. When it starts transport, the closure causes it to hold while the assistant assesses the event and requests authorization.
5. Reply “delivery to work 1.” The assistant asks “Do you mean Packing Area 1?” if it identifies that area as the likely alternative. Reply **Yes** to authorize that specific redirect. You can also directly select **Use Packing Area 1**, **Wait**, or **Stop delivery**.
6. Open **Experiment Log** and select **Export JSON** or **Export CSV**. Select **Reset** to clear the run and return the cargo and environment to their initial states.

The camera supports drag to orbit, scroll to zoom, and **Reset camera**. **Pause** and **Resume** control simulated time. During travel, the chat also reports the robot’s current status on request. Temporary blocks use zero-based row and column. **Use next cell** copies the next planned cell into the event form.

## Research method and source comparison

The implementation follows the APRIS2026 sequence of information extraction, parameter verification, human clarification, and iterative belief update. The language operations preserve the original separation in `llm.py` and `main.py`: ambiguity analysis, answer evaluation, task generation, and execution review when deterministic validation finds a problem. Each subsequent turn includes the earlier answers, and the latest relevant accepted answer takes precedence. Runtime assessment and runtime answer interpretation use separate structured operations.

| Topic | APRIS2026 slide deck | Python source and browser implementation |
| --- | --- | --- |
| Fragile cargo | The case study lists two fragile boxes. | `simulator.py` marks red A1, blue A2, and yellow A3 as fragile. All three are candidates in the browser. |
| Speed | Slide 8 uses 1.5 m/s and asks about “as quickly as possible.” | The Python validator rejects speeds above 0.8 m/s for fragile cargo. The browser preserves that ceiling and distinguishes a vague speed preference from an explicit request for the maximum safe speed. |
| Destination | The example resolves to “packing area A.” | Packing Area 1 at (1, 8) and Packing Area 2 at (8, 8) require an available receiver. Worker 1 at (6, 7) and Worker 2 at (4, 8) also accept direct handovers. |
| Evaluation | Slide 9 reports 96 correct decisions out of 100 commands across ten warehouse environments. | The browser adds dynamic experiments and tests policy and integration behavior. Its test results are separate from the deck’s detection evaluation. |

The warehouse uses the Python grid coordinates, static obstacle and congestion cells, Shelf A footprint and pickup at (6, 2), worker positions, and AMR start at (0, 0). The Python world advertises a nominal unloaded speed of 1.0 m/s, while its movement loop uses 0.82 cells/s. The browser models one meter per cell and uses the observed movement rate of 0.82 m/s, a 1.4 s pickup pause, and the confirmed loaded speed. Four-directional A* preserves Python’s Manhattan heuristic and priority tie order.

## Runtime policy and assumptions

`RuntimeMonitor.js` and `RuntimeDecision.js` are reconstructions based on the interfaces and behavior visible in `simulator.py`. They retain observation, decision, and replanning boundaries. The following rules specify the browser experiment.

- **Observation.** The 3D view and event controls show actual warehouse state. The robot receives immediate packing-area and receiver updates through a simulated status feed. Temporary aisle blocks and recoveries are sensed within a 1.5-cell radius of the last committed cell and remembered until observed to change. Gemini receives the resulting observations and current task facts. Future schedules and unobserved blocks remain in the simulator.
- **Motion.** The engine uses 50 ms simulation steps. The browser interpolates the rendered AMR between cells. A replan starts at the last committed cell. An aisle event cannot block the occupied cell, and the physical commit also checks the next cell. Workers show the receiver role visually and do not add navigation obstacles, matching the Python grid.
- **Runtime reasoning.** Gemini gets the original instruction, clarification history, confirmed task and destination policy, recent observations, and current robot and route facts. It judges task impact, whether the original intent can still be fulfilled, whether it can adapt autonomously, and whether it needs clarification or fresh authorization. Its structured response includes a proposed action, rationale, and uncertainty category. The simulator skips obvious irrelevant changes and unchanged situations.
- **Aisle blockage.** A newly observed block affecting the plan triggers an assessment. If a safe route reaches the same destination, Gemini can propose a replan without asking the operator. JavaScript computes and checks that route with A*. If no route exists, the robot can hold or stop, or consider a viable alternative subject to the destination policy.
- **Closure.** A closed area cannot receive deliveries. Gemini can propose waiting or asking the operator about a viable alternative for a fixed destination. A delegated destination permits an autonomous redirect to an available, reachable area. A destination confirmed by the operator becomes fixed for subsequent assessments.
- **Direct worker delivery.** Tasks distinguish `{ "type": "WORKER", "id": "worker-1" }` from `{ "type": "PACKING_AREA", "id": "Packing Area 1" }`. The robot uses the shortest safe route from Shelf A to a cell adjacent to the worker. “Nearest available worker” compares those delivery routes and asks on a tie. “An available worker” delegates worker selection. If the chosen worker becomes unavailable, the robot holds while Gemini assesses waiting or redirecting to an eligible worker. A fixed worker can change only with operator authorization. Worker availability and the assigned packing-area receiver role are tracked separately.
- **Busy receiver.** The area stays open. Gemini can continue travel on a safe route while the robot is away from handover. The engine prevents handover until the receiver is available. A change at the handover boundary can trigger a separate assessment if the receiver is still busy.
- **Authorization.** Gemini classifies each reply as `CLEAR_AUTHORIZATION`, `CLEAR_REJECTION`, `INCOMPLETE_OR_AMBIGUOUS`, or `INVALID_REQUEST`. A plausible interpretation can produce a short confirmation question tied to one action and destination. JavaScript checks evidence from the operator's text, accepts directly verifiable affirmative commands, and permits a bare affirmative only for an active, specific confirmation. An unclear reply or a refusal leaves the robot held. JavaScript also enforces the task's speed, route, availability, and authorization constraints independently of Gemini.
- **Clock and recovery.** Operator pause, Gemini assessment, and required clarification freeze the simulation clock. Policy-approved waiting advances it. Manual recovery can supersede an outstanding assessment or clarification. Time-triggered events fire on the first eligible tick, phase triggers fire at the first eligible tick in that phase, and simultaneous events apply in schedule order. An event that attempts to block the occupied cell is logged as skipped.

The MVP runs one AMR and one cargo per experiment. It supports the modeled packing-area, receiver, and route constraints. Instructions asking for custom operational rules or unsupported actions require clarification. The simulation state lives in the browser session.

## Manual test matrix

Reset before each scenario. Use Replay fixture for the example and Live Gemini for fresh instructions. Options from a live model may appear in a different order.

| Scenario | Steps and expected observation |
| --- | --- |
| Ambiguous cargo | Send the example. A cargo question offers the fragile items. Reply “all of them” to check that the system asks for one. |
| Ambiguous destination | In the example select A2. When both areas are open, the assistant asks for a destination. An affirmative “any available packing area” delegates the choice. |
| Resolvable instruction | In Live Gemini enter “Deliver A2 to Packing Area 2 at the maximum safe speed.” Expect a ready task at 0.8 m/s without a question. |
| Aisle blockage | Start the example, select **Block aisle**, copy **Use next cell**, and apply immediately where another route exists. Gemini assesses the obstruction. The teal route changes, the destination stays fixed, and the assistant asks no authorization question. |
| Fixed area closure | Follow the closure experiment above. Try “delivery to work 1.” Check that time and position hold through the targeted confirmation and that delivery redirects only after **Yes**. |
| Delegated destination | In Live Gemini enter “Deliver A2 to any available packing area at the maximum safe speed.” Close whichever area the task selects during transport. Expect automatic redirection if the other area is reachable and has an available receiver. |
| Worker delivery | In Live Gemini enter “Transport A1 to Worker 1 at 0.8 m/s.” Start the task and confirm that A1 is handed over beside Worker 1. “Transport A1 to a worker” asks which worker when both are eligible. Reply “I mean Worker 1” to keep the cargo and resolve the destination. |
| Worker unavailable | During worker transport, select **Set worker unavailable** and choose the target worker. The AMR holds until the model proposes a validated action. Restore availability or explicitly authorize an eligible worker redirect. |
| Receiver busy | Before arrival, set the selected area’s receiver busy. The area stays open and the AMR holds near the handover cell. Set the receiver available to resume. |
| Invalid Gemini decision | In Replay fixture, arm **Invalid runtime decision** under Experiment Controls and trigger a fixed-area closure with an alternative. The chat reports the rejection, and the AMR stays stopped. Select **Retry** to read the normal fixture response. |
| API failure | In Replay fixture, arm **API failure** before sending the example or before triggering a closure. The error exposes **Retry**, which resumes the pending operation. The robot remains stationary until an executable task or validated runtime action is available. |

## Reproducibility and logs

The JSON export (version 3) contains the initial configuration, original and current task, event schedule, statistics, and ordered events with simulation timestamps. CSV contains the same event stream with each event’s payload in a quoted JSON column. Use the assessment `id` to join `observed_environment_state`, `runtime_action_suggested`, `runtime_reasoning`, `clarification_necessity`, `runtime_validation`, and `runtime_decision_executed`. Environmental events and observations have their own entries. Operator turns are recorded as `clarification_answer`, `runtime_reply_interpreted`, and `authorization_validation`.

The source is `gemini` for live proposals and reply interpretations, `replay_fixture` for scripted ones, `deterministic` for validation and simulator decisions, and `combined` when a proposed or interpreted action passes the checks and is executed. The execution record identifies its proposer and any operator or delegated authorization. A rejected proposal records `runtime_decision_overridden` and a deterministic `HOLD`. The model's original judgment remains in the log, including its clarification judgment. Logs also include the model, prompt version, request context, latency, and any errors. The export contains the experiment's conversation.

Recreate a fixture experiment with the same answers and phase/time schedule to reproduce the simulated trajectory and event times. Live Gemini responses and wall-clock latencies can vary. Manual events depend on the tick at which the operator applies them. Run the Vitest suite for headless fixtures covering motion, clarification, safety checks, failure recovery, and stale responses.

## Source layout

- `src/simulation/` contains the warehouse data, A*, fixed-step engine, monitor, and deterministic validators.
- `src/ResearchSession.js` coordinates clarification, runtime assessments, retries, and the browser session.
- `src/components/` and `src/visualization/` render the chat, controls, telemetry, log, and Three.js scene.
- `server/` contains the loopback Express proxy, prompts, and official Gemini SDK integration.
- `shared/contracts.js` defines structured response schemas. `tests/` exercises the engine and conversation with fixtures.
