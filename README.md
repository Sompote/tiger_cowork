![Tiger Cowork Banner](picture/banner2.png)

# Tiger Cowork v0.3.2

A self-hosted AI workspace that brings chat, code execution, multi-agent orchestration, project management, and a skill marketplace into one web interface. Connect any **OpenAI-compatible API** (OpenRouter, Ollama, TigerBot, etc.) and let the AI use 16 built-in tools — from web search and Python execution to visual multi-agent systems with mesh networking.

> **Warning:** This app executes AI-generated code and shell commands. Run it inside Docker or a sandboxed environment. See [Security & Docker Setup](docs/TECHNICAL.md#security-notice).

## Screenshots

![Tiger Cowork — AI chat with output panel](picture/screen3.png)

*AI Chat with tool-calling — reads data, generates React/Recharts visualizations, renders them in the output panel.*

![Tiger Cowork — Agent System Editor](picture/agent2.png)

*Visual Agent Editor — drag-and-drop multi-agent design with mesh networking, bus communication, and YAML export.*

![Tiger Cowork — Skills management page](picture/screen_shot2.png)

*Skills marketplace — install and manage skills from built-in catalog, OpenClaw, and ClawHub community.*

## Demo

[![Auto Generate Swarm Agent Architecture](https://img.youtube.com/vi/1Ke2dxha1og/maxresdefault.jpg)](https://youtu.be/1Ke2dxha1og)

*Auto-generate a complete multi-agent architecture from a natural language description — watch the AI build agent teams with roles, connections, and protocols.*

![Auto-Generated Agent Architecture](picture/autoagent.png)

*Auto-generated agent architecture — AI creates a complete multi-agent system with roles, connections, and communication protocols from a single prompt.*

## Key Features

- **AI Chat with Tools** — 16 built-in tools (web search, Python, React, shell, files, skills, sub-agents) with real-time streaming
- **Multi-Agent System** — Visual editor for designing agent teams. Three modes: Auto, Spawn Agent, and Realtime. Supports mesh networking, bus communication, TCP/Queue protocols, and hybrid orchestration
- **Projects** — Dedicated workspaces with memory, skill selection, file browser, and sandboxed or external working folders
- **Reflection Loop** — Optional self-evaluation that scores and retries incomplete work
- **Output Panel** — Renders React components, charts, HTML, PDF, Word, Excel, images, and Markdown inline
- **Skills & ClawHub** — Install and manage AI skills from the marketplace or build your own
- **MCP Integration** — Connect external MCP servers (Stdio, SSE, StreamableHTTP) to extend the AI's toolbox
- **Scheduled Tasks** — Cron-based jobs with presets and a management UI

## Installation

### One-Click Installers (No coding required)

**Mac:**
1. Download [`TigerCoworkInstaller.app`](https://github.com/Sompote/tiger_cowork/releases/latest) (zip)
2. Unzip and double-click — it installs Docker, downloads the app, builds, and opens `http://localhost:3001`

**Windows:**
1. Download [`TigerCoworkInstaller.zip`](https://github.com/Sompote/tiger_cowork/releases/latest)
2. Unzip and double-click `TigerCoworkInstaller.bat` — same automatic setup

**Prerequisite:** [Docker Desktop](https://www.docker.com/products/docker-desktop/) must be installed and running.

| | Mac | Windows |
|---|---|---|
| **Start** | Double-click `TigerCowork.app` in install folder | Double-click `TigerCoworkStart.bat` |
| **Stop** | Docker Desktop → Containers → Stop | Double-click `TigerCoworkStop.bat` |
| **Set token** | Edit `.env` → `ACCESS_TOKEN=your-token` | Edit `.env` → `ACCESS_TOKEN=your-token` |

### Terminal Install

**Mac/Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/Sompote/tiger_cowork/main/install.sh | bash
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/Sompote/tiger_cowork/main/install.ps1 | iex
```

### Manual Install

**Prerequisites:** Node.js >= 18, npm, Python 3 (optional)

```bash
git clone https://github.com/Sompote/tiger_cowork.git
cd tiger_cowork
bash setup.sh        # installs deps, prompts for ClawHub token

# Optional: protect with access token
cp .env.example .env
# Edit .env → ACCESS_TOKEN=your-secret-token

npm run dev          # development → http://localhost:3001
```

**Production:**
```bash
npm run build && npm start
# Or with PM2:
npm run build && pm2 start npm --name "cowork" -- start
```

## Quick Start

1. Open `http://localhost:3001`
2. Go to **Settings** → enter your API Key, API URL, and Model
3. Click **Test Connection** to verify
4. Start chatting — the AI can search the web, run code, generate charts, and more

## Documentation

| Document | Description |
|---|---|
| [Technical Documentation](docs/TECHNICAL.md) | Architecture, agent system details, sub-agent modes, reflection loop, all features, API endpoints, Socket.IO events, project structure, Docker setup, configuration |
| [Changelog](docs/CHANGELOG.md) | Full version history and release notes |

## License

This project is licensed under the [MIT License](LICENSE).
