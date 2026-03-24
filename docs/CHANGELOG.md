# Changelog

## v0.3.2 (2026-03-23)
- Add **per-agent Mesh checkbox** — individual agents can be marked as "mesh enabled" to freely send tasks to any other agent without needing connection lines, similar to the Bus checkbox for broadcast data sharing
- Add **Hybrid architecture mode** — combines an orchestrator (controls flow via TCP connections) with mesh-enabled workers (collaborate freely as peers); orchestrator auto-receives bus tools to monitor all agent activity and prevent infinite loops
- Add **config file name display** in chat header — shows the active YAML architecture file name next to the Realtime Agent / Swarm tag
- Change connection line protocols to **TCP and Queue only** — removed Bus as a connection protocol since bus access is controlled per-agent via the Bus checkbox, not via connection lines
- Change **Mesh from global mode to per-agent** — instead of a global orchestration mode, each agent individually opts into mesh via checkbox; global Mesh mode still available for all-agents-free-talk scenarios
- Add per-agent mesh access control: mesh-enabled agents bypass connection validation in `send_task`; non-mesh agents must use explicit connections
- Add mesh-aware tool assignment: mesh agents receive `send_task`/`wait_result` tools with full peer list even without explicit downstream connections
- Add `mesh` field to `AgentConfig` interface and YAML schema (`mesh: { enabled: true }`)
- Update auto-architecture LLM prompt with connection policy (TCP/Queue only), bus policy (checkbox only), mesh policy (per-agent), and hybrid architecture rules
- Fix **agent config delete** not working — Fastify 5 rejected DELETE requests with empty JSON body; now only sets `Content-Type: application/json` when request has a body

## v0.3.1 (2026-03-22)
- Add **Human Node** role — new "human" agent role that acts as the user's entry point in realtime agent graphs without running an LLM loop
- Add **`/agent` command** for direct agent communication: `/agent [name] "prompt"` (targeted) or `/agent "prompt"` (broadcast to all connected agents)
- Add **human-to-agent and agent-to-human messaging** — human node loop listens for agent outputs and forwards to chat UI with attribution tags
- Add human node UI in Agent Editor — dedicated styling, info panel, hidden AI-setup and model fields for human role
- Add `getHumanConnectedAgents`, `humanSendToAgent`, `humanBroadcastToAgents`, `humanWaitForAgent` helpers in toolbox service
- Add drawing-analyzer v2.1.0 to ClawHub plugin registry

## v0.3.0 (2026-03-21)
**Major rewrite: Express → Fastify async-first framework**

- **Fastify 5** replaces Express.js — natively async handlers, ~2x faster request throughput, built-in Pino structured logging
- **Async file I/O everywhere** — All data layer and sandbox operations converted from synchronous `fs.*Sync` to async `fs/promises`
- **Plugin architecture** — All 10 route files converted from Express `Router()` to Fastify async plugins with scoped hooks
- **@fastify/multipart** replaces `multer` — async file upload handling
- **@fastify/static** replaces `express.static()`
- **@fastify/cors** replaces `cors` middleware
- **@fastify/middie** bridges Vite dev middleware for HMR
- **Native PDF preview** — PDF files render inline using the browser's native PDF viewer
- **Abort signal propagation** — Kill task now immediately cancels blocking `wait_result` and `send_task` calls
- **React output path fix** — `run_react` tool now returns correct sandbox-relative paths in project context

## v0.2.4
- Rich file preview in file browser (images, HTML, Excel, PDF, Word, Markdown, video/audio)
- Auto-generate project memory from chat via LLM
- LLM-powered agent definition generator
- Agent model validation
- Project file browser with preview panel

## v0.2.3
- Windows installer (`TigerCoworkInstaller.bat`)
- Docker Desktop prerequisite with download links
- Sandbox 401 fix for fresh installs
- Docker image includes Python3

## v0.2.2
- **Realtime Agent Mode** — all agents boot at session start for true parallel execution
- New orchestrator tools: `send_task`, `wait_result`, `check_agents`
- Bus toggle per agent in Agent Editor
- Protocol-aware tool filtering
- Agent Editor file manager
- Port-based connection drawing
- Free-text model input
- Renamed "Manual" to "Spawn Agent"

## v0.2.1
- **Agent System Editor** — visual drag-and-drop canvas for multi-agent systems
- AI-assisted agent setup
- Four orchestration modes: Hierarchical, Flat, Mesh, Pipeline
- YAML export with full system metadata

## v0.2.0
- **Sub-Agent System** — spawn independent child agents with own tool loops
- New tool: `spawn_subagent`
- Real-time sub-agent status via Socket.IO
- Depth-aware tool filtering

## v0.1.5
- **Agent Reflection Loop** — self-evaluation with auto-retry
- Fix: reflection block was unreachable due to early `return`

## v0.1.4
- Working folder: Sandbox vs External with access levels
- Docker volume mount generator
- Configurable agent parameters

## v0.1.3
- Projects feature with working folder, memory, skill selection, file browser
- Output panel for project chat
- Word/PDF document preview
- Image attachment support

## v0.1.2
- Access token authentication
- Context overflow fix
- Tool loop reliability improvements
- `ReactComponentRenderer` for native React rendering
- MCP integration (Stdio/SSE/StreamableHTTP)

## v0.1.1
- Tool loop reliability and chart generation improvements

## v0.1.0
- Initial release: Express + Vite web app with AI chat, file manager, Python execution, scheduled tasks, skills marketplace, and web search
