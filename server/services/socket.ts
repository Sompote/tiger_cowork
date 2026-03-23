import { Server, Socket } from "socket.io";
import { v4 as uuid } from "uuid";
import { callTigerBotWithTools, callTigerBot } from "./tigerbot";
import { getChatHistory, saveChatHistory, ChatSession, getSettings, getProjects, getSkills } from "./data";
import { runPython } from "./python";
import { setSubagentStatusCallback, setCallContext, getManualAgentConfigSummary, startRealtimeSession, shutdownRealtimeSession, getRealtimeSession, getToolsForRealtimeOrchestrator, getHumanConnectedAgents, humanSendToAgent, humanBroadcastToAgents, humanWaitForAgent } from "./toolbox";
import path from "path";
import { execSync } from "child_process";
import fs from "fs";

// ─── Scan output_file/ for newly created files ───
const OUTPUT_EXTS = [".pdf", ".docx", ".doc", ".xlsx", ".csv", ".png", ".jpg", ".jpeg", ".svg", ".html", ".gif", ".webp", ".txt", ".md"];

function scanOutputFiles(sandboxDir: string, sinceMs: number): string[] {
  const outputDir = path.join(sandboxDir, "output_file");
  const found: string[] = [];
  try {
    if (!fs.existsSync(outputDir)) return found;
    for (const f of fs.readdirSync(outputDir)) {
      const ext = path.extname(f).toLowerCase();
      const isJsxJs = f.endsWith(".jsx.js");
      if (!OUTPUT_EXTS.includes(ext) && !isJsxJs) continue;
      const fullPath = path.join(outputDir, f);
      const stat = fs.statSync(fullPath);
      if (stat.mtimeMs >= sinceMs - 1000) {
        found.push(path.relative(sandboxDir, fullPath));
      }
    }
  } catch {}
  return found;
}

// ─── Active Agent Task Tracking ───
export interface ActiveTask {
  id: string;
  sessionId: string;
  projectId?: string;
  projectName?: string;
  title: string;
  status: string;
  toolCalls: string[];
  startedAt: string;
  lastUpdate: string;
}

const activeTasks = new Map<string, ActiveTask>();
const taskAbortControllers = new Map<string, AbortController>();

export function getActiveTasks(): ActiveTask[] {
  return Array.from(activeTasks.values());
}

export function killActiveTask(taskId: string): boolean {
  const controller = taskAbortControllers.get(taskId);
  if (controller) {
    controller.abort();
    // Immediately remove from active tasks so UI updates
    activeTasks.delete(taskId);
    taskAbortControllers.delete(taskId);
    return true;
  }
  return false;
}

async function buildSystemPrompt(filterSkillIds?: string[]): Promise<string> {
  // Gather installed clawhub skills
  const clawhubDir = path.resolve("Tiger_bot/skills");
  let clawhubSkills: string[] = [];
  try {
    if (fs.existsSync(clawhubDir)) {
      clawhubSkills = fs.readdirSync(clawhubDir, { withFileTypes: true })
        .filter((d: any) => d.isDirectory() && fs.existsSync(path.join(clawhubDir, d.name, "SKILL.md")))
        .map((d: any) => d.name);
    }
  } catch {}

  // Gather custom uploaded skills from /skills/
  const customDir = path.resolve("skills");
  let customSkills: { name: string; description: string; files: string[] }[] = [];
  try {
    if (fs.existsSync(customDir)) {
      const dirs = fs.readdirSync(customDir, { withFileTypes: true }).filter((d: any) => d.isDirectory());
      for (const d of dirs) {
        const skillMdPath = path.join(customDir, d.name, "SKILL.md");
        let desc = "";
        if (fs.existsSync(skillMdPath)) {
          const content = fs.readFileSync(skillMdPath, "utf8");
          const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
          if (fmMatch) {
            for (const line of fmMatch[1].split("\n")) {
              const idx = line.indexOf(":");
              if (idx > 0) {
                const key = line.slice(0, idx).trim().toLowerCase();
                const val = line.slice(idx + 1).trim();
                if (key === "description") desc = val;
              }
            }
          }
        }
        // List supporting files in the skill folder
        const files = fs.readdirSync(path.join(customDir, d.name), { withFileTypes: true })
          .filter((f: any) => !f.isDirectory())
          .map((f: any) => f.name);
        customSkills.push({ name: d.name, description: desc, files });
      }
    }
  } catch {}

  // Filter clawhub and custom skills by enabled status in skills.json
  let allSkillRecords: { id: string; name: string; enabled: boolean; source: string }[] = [];
  try {
    allSkillRecords = await getSkills();
  } catch {}
  const disabledSkillNames = new Set(allSkillRecords.filter((s) => !s.enabled).map((s) => s.name));
  clawhubSkills = clawhubSkills.filter((name) => !disabledSkillNames.has(name));
  customSkills = customSkills.filter((cs) => !disabledSkillNames.has(cs.name));

  // Also include enabled skills from skills.json that aren't already listed
  let registeredSkills: string[] = [];
  registeredSkills = allSkillRecords
    .filter((s) => s.enabled && !clawhubSkills.includes(s.name) && !customSkills.some((cs) => cs.name === s.name))
    .map((s) => `${s.name} (${s.source})`);

  // If project has specific skill selections, filter to only those
  if (filterSkillIds && filterSkillIds.length > 0) {
    clawhubSkills = clawhubSkills.filter((name) => filterSkillIds.includes(name));
    customSkills = customSkills.filter((cs) => filterSkillIds.includes(cs.name));
    const allSkills = await getSkills();
    const selectedSkillNames = allSkills.filter((s) => filterSkillIds.includes(s.id)).map((s) => s.name);
    registeredSkills = registeredSkills.filter((rs) => {
      const name = rs.split(" (")[0];
      return selectedSkillNames.includes(name) || filterSkillIds.includes(name);
    });
  }

  let skillsList = "";
  if (clawhubSkills.length > 0 || customSkills.length > 0 || registeredSkills.length > 0) {
    skillsList += `\n\n=== INSTALLED SKILLS ===`;
    skillsList += `\nIMPORTANT: BEFORE answering any user request, scan the skill list below. If a skill's description matches the user's task, you MUST load and use that skill FIRST by calling load_skill("<skill-name>"), then follow its SKILL.md instructions. Do NOT write your own code from scratch when a matching skill exists. Skills contain tested implementations and supporting files (like Python engines) that should be used.`;
  }
  if (customSkills.length > 0) {
    skillsList += `\n\nCustom skills (priority — always prefer these):`;
    for (const cs of customSkills) {
      skillsList += `\n- "${cs.name}"${cs.description ? ": " + cs.description : ""} [files: ${cs.files.join(", ")}]`;
    }
  }
  if (clawhubSkills.length > 0) {
    skillsList += `\n\nClawHub skills: ${clawhubSkills.join(", ")}`;
  }
  if (registeredSkills.length > 0) {
    skillsList += `\n\nOther registered skills: ${registeredSkills.join(", ")}`;
  }
  if (skillsList) {
    skillsList += `\n\nSkill usage workflow: 1) call load_skill("<name>") to read SKILL.md and see supporting files, 2) if the skill has supporting .py files, use read_file to load them, 3) use run_python or run_shell to execute following the skill instructions.`;
  }

  const settings = await getSettings();
  const isManualSubAgent = settings.subAgentEnabled && settings.subAgentMode === "manual";
  const isRealtimeAgent = settings.subAgentEnabled && settings.subAgentMode === "realtime";
  const subAgentInfo = settings.subAgentEnabled
    ? isRealtimeAgent
      ? `\n- send_task: Send a task to an agent in the realtime session (all agents are already alive). Params: to (agent ID), task (description), context (optional), wait (optional, block for result).\n- wait_result: Wait for a result from an agent. Params: from (agent ID), timeout (optional seconds).\n- check_agents: Check status of all agents in the realtime session.`
      : `\n- spawn_subagent: Delegate a sub-task to an independent sub-agent. The sub-agent runs its own tool-calling loop and returns results. Use for: parallel research, breaking complex tasks into parts, or specialized work. Params: task (required), label (short name), context (extra info), agentId (match agent from YAML config).`
    : "";

  return `You are Tiger Cowork, a powerful AI assistant with direct access to tools for internet, files, code execution, and skill marketplace.

Available tools:
- web_search: Search the internet for any information
- fetch_url: Fetch content from any URL (web pages, APIs, etc.)
- run_python: Execute Python code in the sandbox
- run_react: Execute React/JSX code — renders as an interactive HTML page in the output panel. Great for dashboards, UI components, data visualizations with Recharts, interactive forms, etc.
- run_shell: Run shell commands (install packages, git, system tasks)
- read_file: Read file contents from disk
- write_file: Write or append content to files
- list_files: List directory contents
- list_skills: List all installed skills (ClawHub + built-in)
- load_skill: Load a skill's SKILL.md to learn how to use it
- clawhub_search: Search the ClawHub/OpenClaw skill marketplace
- clawhub_install: Install skills from ClawHub by slug${subAgentInfo}

Rules:${isRealtimeAgent ? `
- REALTIME AGENTS: You are operating in REALTIME agent mode. All agents from the architecture are ALREADY ALIVE and listening. Do NOT try to spawn agents — they are running.
- HIERARCHY: The agent team has a defined hierarchy. Check the agent roles — if there is an orchestrator agent (role=orchestrator), you MUST send the task ONLY to that orchestrator. The orchestrator will manage all delegation to workers/checkers internally. Do NOT bypass the orchestrator by sending tasks directly to worker agents.
- SEND TASKS: Use send_task({to: "agent_id", task: "..."}) to assign work. Use wait_result({from: "agent_id"}) to collect results.
- MANDATORY: You MUST delegate ALL work through the agent team. Do NOT do the work yourself. Send the task, wait for results, then synthesize the final response.` : isManualSubAgent ? `
- SUB-AGENTS (MANDATORY): You are operating in MANUAL sub-agent mode. You MUST use spawn_subagent for ALL user tasks — do NOT answer directly by yourself. Your role is to act as an orchestrator: analyze the user's request, then delegate work to the predefined agent team by calling spawn_subagent with the appropriate agentId for each agent. Follow the workflow sequence defined in the agent configuration. After all sub-agents complete, synthesize their results into a final response.
- WORKFLOW: Follow the workflow sequence strictly. Each agent can only spawn downstream agents defined in its outputs_to and connections. Agents with no downstream targets are leaf agents — they complete tasks directly. The architecture file defines who can delegate to whom. Always use the agentId parameter.
- PARALLEL SPAWNING: When an agent has multiple independent downstream agents, spawn them ALL in a single response so they run in parallel. Do not wait for one to finish before spawning the next unless there is a true data dependency.
- IMPORTANT: Even for simple tasks, you must delegate through sub-agents when manual mode is enabled. This ensures proper review and quality control through the agent pipeline.` : settings.subAgentEnabled ? `
- SUB-AGENTS: For complex multi-part tasks, use spawn_subagent to delegate sub-tasks. Each sub-agent runs independently with full tool access. Good use cases: researching multiple topics simultaneously, generating charts while analyzing data, or any task that can be broken into independent parts. Provide a clear task description and label. Wait for results before using them.` : ""}
- SKILL-FIRST: Before writing any code, check if an installed skill matches the user's request. If a skill's name or description is relevant (e.g. user asks about "slope stability" and skill "slope-stability" exists), you MUST call load_skill first and use that skill's code/engine. Never reinvent what a skill already provides.
- USE TOOLS actively. When asked to search, use web_search. When asked to fetch a page, use fetch_url.
- IMPORTANT: Do NOT call the same tool repeatedly with the same arguments. If a tool returns a result, use that result — do not call it again.
- IMPORTANT: If a tool (especially run_shell) returns an error like "command not found", do NOT retry it. Tell the user what needs to be installed and how.
- When using skills (after load_skill), you may need several tool calls to complete the workflow — that's OK. But if a command fails, explain the error to the user instead of retrying. If the skill has supporting files (e.g. gle_engine.py), read them with read_file and use them in your run_python code.
- For web search tasks: prefer using the installed duckduckgo-search skill via run_python (it gives better results than the basic web_search). Load the skill first with load_skill("duckduckgo-search") to see usage.
- For coding tasks, use run_python, run_react, or run_shell to execute code directly.
- For interactive UIs, dashboards, or React components, use run_react. It supports hooks, state, and CDN libraries like Recharts and Tailwind CSS.
- For file operations, use read_file, write_file, list_files. Call list_files ONCE, not repeatedly.
- Be concise and actionable.
- If web_search returns limited results, follow up with fetch_url on relevant URLs.
- If you generate files (PDF, Word, etc.), mention them so the user can download.
- For ClawHub skills, use clawhub_search to find and clawhub_install to install them.
- Do NOT just describe what you would do — actually call the tools and provide real results.
- When a user asks about skills, call list_skills to show what's available.
- CHARTS & PLOTS: When creating charts/graphs with matplotlib or plotly, ALWAYS save to a .png file (e.g. plt.savefig('chart.png', dpi=150, bbox_inches='tight')). The image will be rendered in the output panel on the right. Never call plt.show(). For interactive charts, use run_react with Recharts.
- REPORTS: When generating HTML reports, save to a .html file. It will be rendered in the output panel. For PDF reports, save to .pdf and it will show an embedded preview.
- WORD FILES: When asked to create Word/DOCX files, ALWAYS use run_python with the python-docx library. Example: from docx import Document; doc = Document(); doc.add_heading('Title', 0); doc.add_paragraph('Content'); doc.save('report.docx'). The .docx file will be rendered with its content in the output panel. NEVER use write_file for Word documents — it only writes text, not binary formats.
- OUTPUT FILES: The Python working directory is output_file/ inside the sandbox. All output files (plots, reports, etc.) are saved here automatically.
- IMPORTANT WORKFLOW: When the user asks for analysis, charts, graphs, or reports — DO NOT just print data. You MUST generate actual output files (PNG charts, HTML reports, etc.) in the SAME run_python call or in a follow-up call. Combine data reading and chart generation in one run_python call when possible. For example: read the data, process it, AND create matplotlib charts all in a single code block. Do NOT spend multiple rounds just exploring data — go straight to producing visual outputs.
- MULTI-CHART: When asked for analysis or report graphs, generate multiple relevant charts (e.g. depth profiles, property distributions, scatter plots, summary tables) in one or two run_python calls. Save each chart as a separate PNG file.
- FILE PATHS: A variable PROJECT_DIR is available in run_python pointing to the project root. Use it to access uploaded files: e.g. os.path.join(PROJECT_DIR, 'uploads/filename.xlsx'). ALWAYS use PROJECT_DIR when reading files from uploads/ or other project directories. Never use bare relative paths like 'uploads/...' — they won't work because the working directory is output_file/.
- REACT APPS: When asked to build UI components or interactive visualizations, use run_react. The component renders in the output panel. You can include dependencies like 'recharts', 'tailwindcss', 'chart.js', etc. IMPORTANT: Do NOT use import/export statements in run_react code — React, ReactDOM, hooks (useState, useEffect, etc.), and library globals (like Recharts components: BarChart, LineChart, etc.) are already available as globals. Just define your component function and it will be auto-rendered.
- Use matplotlib.use('Agg') is already set automatically. Just import matplotlib.pyplot and save figures.
- MCP TOOLS: External tools connected via Model Context Protocol are available with names starting with "mcp_". Use them like any other tool when they match the user's request.${skillsList}${await getManualAgentConfigSummary() || ""}`;
}

// Store io reference for broadcasting status to all connected clients
let ioRef: Server | null = null;

// Broadcast status to ALL connected sockets (so reconnected clients get updates)
function broadcastStatus(data: Record<string, any>) {
  if (ioRef) ioRef.emit("chat:status", data);
}

export function setupSocket(io: Server): void {
  ioRef = io;

  // Track whether swarm tag was already shown per session
  const swarmTagShown = new Set<string>();

  // Wire up sub-agent status broadcasting — emit both status AND chat chunks for live progress
  setSubagentStatusCallback((data) => {
    broadcastStatus(data);
    // Stream sub-agent progress as chat chunks so user sees real-time updates in the chat
    if (data.sessionId && ioRef) {
      let progressText = "";

      // Show swarm mode tag on first sub-agent spawn in this session
      if (data.status === "subagent_spawn" && !swarmTagShown.has(data.sessionId)) {
        swarmTagShown.add(data.sessionId);
        progressText += `\n<div class="swarm-tag">🐝 SWARM MODE ACTIVE</div>\n\n`;
      }

      if (data.status === "subagent_spawn") {
        progressText += `> **🔄 Sub-agent "${data.label}"** spawned (depth ${data.depth}) — _${(data.task || "").slice(0, 120)}_\n`;
      } else if (data.status === "subagent_tool") {
        // Tag protocol tool usage
        if (data.tool?.startsWith("proto_")) {
          const protoName = data.tool.replace("proto_", "").split("_")[0].toUpperCase();
          progressText = `> <span class="proto-tag proto-${protoName.toLowerCase()}">${protoName}</span> **${data.label}** → \`${data.tool}\`\n`;
        } else {
          progressText = `> **⚙️ ${data.label}** → \`${data.tool}\`\n`;
        }
      } else if (data.status === "subagent_done") {
        progressText = `> **✅ Sub-agent "${data.label}"** completed\n`;
      } else if (data.status === "subagent_error") {
        progressText = `> **❌ Sub-agent "${data.label}"** failed: ${data.error}\n`;

      // ─── Realtime Agent progress ───
      } else if (data.status === "realtime_agent_ready") {
        if (!swarmTagShown.has(data.sessionId)) {
          swarmTagShown.add(data.sessionId);
          progressText += `\n<div class="swarm-tag">⚡ REALTIME AGENT MODE</div>\n\n`;
        }
        progressText += `> **🟢 ${data.label}** (${data.role}) is ready\n`;
      } else if (data.status === "realtime_agent_working") {
        progressText = `> **🔄 ${data.label}** working — _${(data.task || "").slice(0, 120)}_\n`;
      } else if (data.status === "realtime_agent_tool") {
        if (data.tool?.startsWith("proto_")) {
          const protoName = data.tool.replace("proto_", "").split("_")[0].toUpperCase();
          progressText = `> <span class="proto-tag proto-${protoName.toLowerCase()}">${protoName}</span> **${data.label}** → \`${data.tool}\`\n`;
        } else if (data.tool === "send_task") {
          progressText = `> **📤 ${data.label}** delegating task\n`;
        } else if (data.tool === "wait_result") {
          progressText = `> **⏳ ${data.label}** waiting for result\n`;
        } else {
          progressText = `> **⚙️ ${data.label}** → \`${data.tool}\`\n`;
        }
      } else if (data.status === "realtime_agent_tool_done") {
        // silent — avoid flooding
      } else if (data.status === "realtime_agent_done") {
        progressText = `> **✅ ${data.label}** task completed\n`;

      // ─── Human Node messages (agent → human) ───
      } else if (data.status === "human_node_message") {
        progressText = `\n<div class="agent-response-tag" data-agent="${data.agentId}">📨 <strong>${data.label}</strong></div>\n\n${data.content}\n`;
      }
      if (progressText) {
        ioRef.emit("chat:chunk", { sessionId: data.sessionId, content: progressText });
      }
    }
  });

  io.on("connection", (socket: Socket) => {
    console.log("Client connected:", socket.id);

    // Send active tasks to newly connected client so they can restore progress state
    const active = getActiveTasks();
    if (active.length > 0) {
      for (const task of active) {
        socket.emit("chat:status", {
          sessionId: task.sessionId,
          status: task.status.startsWith("Running:") ? "tool_call" : "thinking",
          tool: task.status.startsWith("Running:") ? task.status.replace("Running: ", "") : undefined,
        });
      }
    }

    socket.on("chat:send", async (data: { sessionId: string; message: string; images?: { path: string; type: string }[] }) => {
      const { sessionId, message, images } = data;
      const sessions = await getChatHistory();
      let session = sessions.find((s) => s.id === sessionId);

      if (!session) {
        session = {
          id: sessionId,
          title: message.slice(0, 50),
          messages: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        sessions.push(session);
      }

      session.messages.push({
        role: "user",
        content: message,
        timestamp: new Date().toISOString(),
      });
      session.updatedAt = new Date().toISOString();
      await saveChatHistory(sessions);

      // ─── /agent command: talk directly to agents in realtime mode ───
      // Format: /agent [agent_name_or_id] "prompt"  OR  /agent "prompt" (broadcast to all connected)
      const agentCmdMatch = message.match(/^\/agent\s+(?:(\S+)\s+)?[""]?([\s\S]+?)[""]?\s*$/i);
      if (agentCmdMatch) {
        const rtSession = getRealtimeSession(sessionId);
        if (!rtSession) {
          const errMsg = "No realtime agent session is active. Start a realtime session first (enable realtime mode in settings with an agent config).";
          session.messages.push({ role: "assistant", content: errMsg, timestamp: new Date().toISOString() });
          await saveChatHistory(sessions);
          socket.emit("chat:response", { sessionId, content: errMsg, done: true });
          return;
        }

        const targetArg = agentCmdMatch[1]; // agent name/id or undefined (broadcast)
        const prompt = agentCmdMatch[2].trim();

        if (targetArg) {
          // Find agent by ID or name (case-insensitive)
          const connectedIds = getHumanConnectedAgents(sessionId);
          let targetId: string | undefined;

          // First try exact ID match
          if (rtSession.agents.has(targetArg)) {
            targetId = targetArg;
          } else {
            // Try name match (case-insensitive)
            for (const [id, handle] of rtSession.agents.entries()) {
              if (handle.agentDef.name.toLowerCase() === targetArg.toLowerCase() ||
                  handle.agentDef.id.toLowerCase() === targetArg.toLowerCase()) {
                targetId = id;
                break;
              }
            }
          }

          if (!targetId) {
            const available = Array.from(rtSession.agents.entries())
              .filter(([, h]) => h.agentDef.role !== "human")
              .map(([id, h]) => `${h.agentDef.name} (${id})`)
              .join(", ");
            const errMsg = `Agent "${targetArg}" not found. Available agents: ${available}`;
            session.messages.push({ role: "assistant", content: errMsg, timestamp: new Date().toISOString() });
            await saveChatHistory(sessions);
            socket.emit("chat:response", { sessionId, content: errMsg, done: true });
            return;
          }

          // Validate human can talk to this agent
          if (connectedIds.length > 0 && !connectedIds.includes(targetId)) {
            const allowedNames = connectedIds.map((id) => {
              const h = rtSession.agents.get(id);
              return h ? `${h.agentDef.name} (${id})` : id;
            }).join(", ");
            const errMsg = `You can only talk to agents connected to the human node: ${allowedNames}`;
            session.messages.push({ role: "assistant", content: errMsg, timestamp: new Date().toISOString() });
            await saveChatHistory(sessions);
            socket.emit("chat:response", { sessionId, content: errMsg, done: true });
            return;
          }

          // Send task to specific agent
          const agentName = rtSession.agents.get(targetId)!.agentDef.name;
          const agentStartTime = Date.now();
          socket.emit("chat:chunk", {
            sessionId,
            content: `> <span class="proto-tag proto-bus">HUMAN</span> → **${agentName}** (\`${targetId}\`): _${prompt.slice(0, 120)}_\n`,
          });

          const result = humanSendToAgent(sessionId, targetId, prompt);
          if (!result.ok) {
            const errMsg = `Failed to send to ${targetId}: ${result.error}`;
            session.messages.push({ role: "assistant", content: errMsg, timestamp: new Date().toISOString() });
            await saveChatHistory(sessions);
            socket.emit("chat:response", { sessionId, content: errMsg, done: true });
            return;
          }

          // Wait for the agent's result
          socket.emit("chat:chunk", { sessionId, content: `> Waiting for **${agentName}** to respond...\n` });
          const waitResult = await humanWaitForAgent(sessionId, targetId, 120000);
          const responseContent = waitResult.ok
            ? `<div class="agent-response-tag" data-agent="${targetId}">📨 <strong>${agentName}</strong></div>\n\n${waitResult.result}`
            : `**${agentName}** did not respond in time: ${waitResult.error}`;

          // Scan for output files generated during agent execution
          const agentSettings = await getSettings();
          const agentSandboxDir = agentSettings.sandboxDir || path.resolve("sandbox");
          const agentOutputFiles = scanOutputFiles(agentSandboxDir, agentStartTime);

          session.messages.push({ role: "assistant", content: responseContent, timestamp: new Date().toISOString(), files: agentOutputFiles.length > 0 ? agentOutputFiles : undefined });
          await saveChatHistory(sessions);
          socket.emit("chat:chunk", { sessionId, content: "", clear: true });
          socket.emit("chat:response", { sessionId, content: responseContent, done: true, files: agentOutputFiles.length > 0 ? agentOutputFiles : undefined });
          return;

        } else {
          // Broadcast to all connected agents
          const connectedIds = getHumanConnectedAgents(sessionId);
          if (connectedIds.length === 0) {
            const errMsg = "No agents are connected to the human node. Add connections from the human node to agents in the Agent Editor.";
            session.messages.push({ role: "assistant", content: errMsg, timestamp: new Date().toISOString() });
            await saveChatHistory(sessions);
            socket.emit("chat:response", { sessionId, content: errMsg, done: true });
            return;
          }

          const agentNames = connectedIds.map((id) => {
            const h = rtSession.agents.get(id);
            return h ? `${h.agentDef.name} (${id})` : id;
          });
          socket.emit("chat:chunk", {
            sessionId,
            content: `> <span class="proto-tag proto-bus">HUMAN</span> → Broadcasting to **${agentNames.join(", ")}**: _${prompt.slice(0, 120)}_\n`,
          });

          const broadcastStartTime = Date.now();
          const broadcastResult = humanBroadcastToAgents(sessionId, prompt);
          if (!broadcastResult.ok) {
            const errMsg = `Broadcast failed: ${broadcastResult.errors.join("; ")}`;
            session.messages.push({ role: "assistant", content: errMsg, timestamp: new Date().toISOString() });
            await saveChatHistory(sessions);
            socket.emit("chat:response", { sessionId, content: errMsg, done: true });
            return;
          }

          // Collect results from all agents concurrently
          socket.emit("chat:chunk", { sessionId, content: `> Waiting for ${broadcastResult.sent.length} agent(s) to respond...\n` });

          const resultPromises = broadcastResult.sent.map(async (agentId) => {
            const agentName = rtSession.agents.get(agentId)?.agentDef.name || agentId;
            const waitResult = await humanWaitForAgent(sessionId, agentId, 120000);
            if (waitResult.ok) {
              return `<div class="agent-response-tag" data-agent="${agentId}">📨 <strong>${agentName}</strong></div>\n\n${waitResult.result}`;
            } else {
              return `<div class="agent-response-tag" data-agent="${agentId}">⏱️ <strong>${agentName}</strong> (timeout)</div>\n\n${waitResult.error}`;
            }
          });

          const results = await Promise.all(resultPromises);
          const fullResponse = results.join("\n\n---\n\n");

          // Scan for output files generated during agent execution
          const bcSettings = await getSettings();
          const bcSandboxDir = bcSettings.sandboxDir || path.resolve("sandbox");
          const bcOutputFiles = scanOutputFiles(bcSandboxDir, broadcastStartTime);

          session.messages.push({ role: "assistant", content: fullResponse, timestamp: new Date().toISOString(), files: bcOutputFiles.length > 0 ? bcOutputFiles : undefined });
          await saveChatHistory(sessions);
          socket.emit("chat:chunk", { sessionId, content: "", clear: true });
          socket.emit("chat:response", { sessionId, content: fullResponse, done: true, files: bcOutputFiles.length > 0 ? bcOutputFiles : undefined });
          return;
        }
      }

      // Check if user sent Python code directly
      const pythonMatch = message.match(/```python\n([\s\S]*?)```/);
      if (pythonMatch) {
        const settings = await getSettings();
        const sandboxDir = settings.sandboxDir || path.resolve("sandbox");
        broadcastStatus({ sessionId, status: "running_python" });
        const result = await runPython(pythonMatch[1], sandboxDir);
        const resultMsg = [
          result.stdout && `Output:\n\`\`\`\n${result.stdout}\`\`\``,
          result.stderr && `Errors:\n\`\`\`\n${result.stderr}\`\`\``,
          result.outputFiles.length > 0 && `Generated files: ${result.outputFiles.join(", ")}`,
        ].filter(Boolean).join("\n\n");

        const assistantMsg = `Python execution (exit code ${result.exitCode}):\n\n${resultMsg}`;
        session.messages.push({
          role: "assistant",
          content: assistantMsg,
          timestamp: new Date().toISOString(),
          files: result.outputFiles,
        });
        await saveChatHistory(sessions);
        socket.emit("chat:response", { sessionId, content: assistantMsg, done: true, files: result.outputFiles });
        return;
      }

      // Use tool-calling AI loop — build multimodal content for images
      const settings = await getSettings();
      const sandboxDir = settings.sandboxDir || path.resolve("sandbox");
      const chatMessages = session.messages.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

      // If the latest user message has images, convert to multimodal content
      console.log(`[Image] images received:`, images ? JSON.stringify(images) : "none");
      fs.writeFileSync("/tmp/cowork-image-debug.log", `${new Date().toISOString()} images: ${JSON.stringify(images)}\nmessage: ${message.slice(0,200)}\n`, { flag: "a" });
      if (images && images.length > 0) {
        const lastIdx = chatMessages.length - 1;
        const textContent = chatMessages[lastIdx].content;
        const contentParts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
          { type: "text", text: textContent },
        ];
        for (const img of images) {
          try {
            const imgPath = path.resolve(img.path);
            let imgBuffer = fs.readFileSync(imgPath);
            let mimeType = img.type || "image/png";

            // Compress if larger than 4MB (API limit is 5MB for base64)
            const MAX_SIZE = 4 * 1024 * 1024;
            if (imgBuffer.length > MAX_SIZE) {
              console.log(`[Image] ${img.path} is ${(imgBuffer.length / 1024 / 1024).toFixed(1)}MB, compressing...`);
              try {
                const tmpOut = `/tmp/cowork_resized_${Date.now()}.jpg`;
                execSync(`python3 -c "
from PIL import Image
import sys
img = Image.open('${imgPath.replace(/'/g, "\\'")}')
img.thumbnail((1600, 1600), Image.LANCZOS)
img = img.convert('RGB')
img.save('${tmpOut}', 'JPEG', quality=80)
"`, { timeout: 10000 });
                imgBuffer = fs.readFileSync(tmpOut);
                mimeType = "image/jpeg";
                fs.unlinkSync(tmpOut);
                console.log(`[Image] Compressed to ${(imgBuffer.length / 1024 / 1024).toFixed(1)}MB`);
              } catch (compErr: any) {
                console.error(`[Image] Compression failed:`, compErr.message);
              }
            }

            const base64 = imgBuffer.toString("base64");
            contentParts.push({
              type: "image_url",
              image_url: { url: `data:${mimeType};base64,${base64}` },
            });
          } catch (err: any) {
            console.error(`[Image] Failed to read ${img.path}:`, err.message);
          }
        }
        (chatMessages[lastIdx] as any).content = contentParts;
      }

      broadcastStatus({ sessionId, status: "thinking" });
      swarmTagShown.delete(sessionId); // Reset swarm tag for new turn
      const toolsUsed: string[] = [];
      const outputFiles: string[] = [];

      // Track active task
      const taskId = uuid();
      const activeTask: ActiveTask = {
        id: taskId,
        sessionId,
        title: message.slice(0, 80),
        status: "Thinking...",
        toolCalls: [],
        startedAt: new Date().toISOString(),
        lastUpdate: new Date().toISOString(),
      };
      activeTasks.set(taskId, activeTask);
      const abortController = new AbortController();
      taskAbortControllers.set(taskId, abortController);

      try {
        // Set call context for sub-agent spawning
        setCallContext(sessionId, 0);

        // Boot realtime agents if in realtime mode
        const rtSettings = await getSettings();
        let realtimeTools: any[] | undefined;
        if (rtSettings.subAgentEnabled && rtSettings.subAgentMode === "realtime" && rtSettings.subAgentConfigFile) {
          const rtSession = await startRealtimeSession(sessionId, rtSettings.subAgentConfigFile, abortController.signal);
          if (rtSession) {
            realtimeTools = await getToolsForRealtimeOrchestrator();
            // Notify client that realtime agents are alive
            const agentNames = Array.from(rtSession.agents.values()).map(h => `${h.agentDef.name} (${h.agentDef.id})`);
            socket.emit("chat:chunk", {
              sessionId,
              content: `> **Realtime Agents Active:** ${agentNames.join(", ")}\n\n`,
            });
          }
        }

        const result = await callTigerBotWithTools(
          chatMessages,
          await buildSystemPrompt(),
          // onToolCall — show status + protocol tags
          (name, args) => {
            toolsUsed.push(name);
            broadcastStatus({ sessionId, status: "tool_call", tool: name, args });
            // Tag protocol tool usage in chat
            if (name.startsWith("proto_") && ioRef) {
              const protoName = name.replace("proto_", "").split("_")[0].toUpperCase();
              ioRef.emit("chat:chunk", {
                sessionId,
                content: `> <span class="proto-tag proto-${protoName.toLowerCase()}">${protoName}</span> \`${name}\` — ${args.topic || args.peer || args.to || ""}\n`,
              });
            }
            // Tag realtime agent tools in chat
            if ((name === "send_task" || name === "wait_result") && ioRef) {
              const targetId = args.to || args.from || "";
              ioRef.emit("chat:chunk", {
                sessionId,
                content: `> <span class="proto-tag proto-bus">AGENT</span> \`${name}\` → ${targetId}\n`,
              });
            }
            // Update active task with descriptive status for orchestrator tools
            if (name === "send_task") {
              activeTask.status = `Running: send_task — delegating to ${args.to || "agent"}`;
            } else if (name === "wait_result") {
              activeTask.status = `Running: wait_result — waiting for ${args.from || "agent"}`;
            } else if (name === "check_agents") {
              activeTask.status = `Running: check_agents`;
            } else {
              activeTask.status = `Running: ${name}`;
            }
            activeTask.toolCalls.push(name);
            activeTask.lastUpdate = new Date().toISOString();
          },
          // onToolResult — collect output files, show status only
          (name, toolResult) => {
            broadcastStatus({ sessionId, status: "tool_result", tool: name });
            if (name === "wait_result") {
              activeTask.status = "Agent result received, thinking...";
            } else if (name === "send_task") {
              activeTask.status = "Task delegated, orchestrating...";
            } else {
              activeTask.status = `${name} done, thinking...`;
            }
            activeTask.lastUpdate = new Date().toISOString();
            if (toolResult?.outputFiles) {
              outputFiles.push(...toolResult.outputFiles);
            }
          },
          abortController.signal,
          realtimeTools,
        );

        // Clear streaming progress and show final AI response
        socket.emit("chat:chunk", { sessionId, content: "", clear: true });
        if (result.content) {
          socket.emit("chat:chunk", { sessionId, content: "\n" + result.content });
        }

        const fullResponse = result.content +
          (outputFiles.length > 0 ? `\n\nGenerated files: ${outputFiles.join(", ")}` : "");

        session.messages.push({
          role: "assistant",
          content: fullResponse,
          timestamp: new Date().toISOString(),
          files: outputFiles.length > 0 ? outputFiles : undefined,
        });
        await saveChatHistory(sessions);
        socket.emit("chat:response", { sessionId, content: fullResponse, done: true, files: outputFiles.length > 0 ? outputFiles : undefined });
      } catch (err: any) {
        // If aborted, don't fallback — just report cancellation
        if (abortController.signal.aborted) {
          const cancelMsg = "Task was cancelled." +
            (outputFiles.length > 0 ? `\n\nGenerated files: ${outputFiles.join(", ")}` : "");
          session.messages.push({
            role: "assistant",
            content: cancelMsg,
            timestamp: new Date().toISOString(),
            files: outputFiles.length > 0 ? outputFiles : undefined,
          });
          await saveChatHistory(sessions);
          socket.emit("chat:response", { sessionId, content: cancelMsg, done: true, files: outputFiles.length > 0 ? outputFiles : undefined });
        } else {
          // Fallback to simple call without tools — still include any outputFiles collected during tool calls
          try {
            const result = await callTigerBot(chatMessages, await buildSystemPrompt());
            const fallbackContent = result.content +
              (outputFiles.length > 0 ? `\n\nGenerated files: ${outputFiles.join(", ")}` : "");
            session.messages.push({
              role: "assistant",
              content: fallbackContent,
              timestamp: new Date().toISOString(),
              files: outputFiles.length > 0 ? outputFiles : undefined,
            });
            await saveChatHistory(sessions);
            socket.emit("chat:response", { sessionId, content: fallbackContent, done: true, files: outputFiles.length > 0 ? outputFiles : undefined });
          } catch (fallbackErr: any) {
            const errMsg = `Error: ${fallbackErr.message || err.message}`;
            const errorContent = errMsg +
              (outputFiles.length > 0 ? `\n\nGenerated files: ${outputFiles.join(", ")}` : "");
            session.messages.push({
              role: "assistant",
              content: errorContent,
              timestamp: new Date().toISOString(),
              files: outputFiles.length > 0 ? outputFiles : undefined,
            });
            await saveChatHistory(sessions);
            socket.emit("chat:response", { sessionId, content: errorContent, done: true, files: outputFiles.length > 0 ? outputFiles : undefined });
          }
        }
      } finally {
        // Shutdown realtime session when task completes — unless human node is present
        // (human mode keeps the session alive for multi-turn interaction via /agent commands)
        const rtSessionCheck = getRealtimeSession(sessionId);
        const hasHumanNode = rtSessionCheck?.systemConfig?.agents?.some((a: any) => a.role === "human");
        if (!hasHumanNode) {
          shutdownRealtimeSession(sessionId);
        }
        activeTasks.delete(taskId);
        taskAbortControllers.delete(taskId);
      }
    });

    // ─── Project Chat ───
    socket.on("project:chat:send", async (data: { projectId: string; sessionId: string; message: string; images?: { path: string; type: string }[] }) => {
      const { projectId, sessionId, message, images } = data;
      const projects = await getProjects();
      const project = projects.find((p) => p.id === projectId);
      if (!project) {
        socket.emit("chat:response", { sessionId, content: "Error: Project not found", done: true });
        return;
      }

      // Resolve working folder (handle relative paths)
      const settings_proj = await getSettings();
      const sandboxDir_proj = settings_proj.sandboxDir || path.resolve("sandbox");
      const resolvedWorkingFolder = project.workingFolder
        ? (path.isAbsolute(project.workingFolder) ? project.workingFolder : path.join(sandboxDir_proj, project.workingFolder))
        : "";

      // Build project-aware system prompt (filter skills to only project-selected ones)
      let projectPrompt = await buildSystemPrompt(project.skills && project.skills.length > 0 ? project.skills : undefined);

      // Read project memory fresh from {workingFolder}/memory.md every time
      let projectMemory = "";
      if (resolvedWorkingFolder) {
        const memoryPath = path.join(resolvedWorkingFolder, "memory.md");
        try {
          if (fs.existsSync(memoryPath)) {
            projectMemory = fs.readFileSync(memoryPath, "utf-8");
          }
        } catch (err: any) {
          console.error(`Failed to read memory.md for project ${project.id}:`, err.message);
        }
      }
      // Fallback to stored memory if no file found
      if (!projectMemory && project.memory) {
        projectMemory = project.memory;
      }

      // Inject project memory
      if (projectMemory) {
        projectPrompt += `\n\n--- PROJECT MEMORY (memory.md) ---\nThe user is working in project "${project.name}". Here is the project memory that records key information:\n\n${projectMemory}\n--- END PROJECT MEMORY ---`;
      }

      // Inject project description
      if (project.description) {
        projectPrompt += `\n\nProject description: ${project.description}`;
      }

      // Inject working folder info
      if (resolvedWorkingFolder) {
        projectPrompt += `\n\nProject working folder: ${resolvedWorkingFolder}\nWhen the user asks about files, search this folder first. Use this folder for reading/writing project files.\nIMPORTANT: All output files (charts, reports, documents, etc.) are saved directly to this project working folder. The Python working directory (os.chdir) is set to this folder. PROJECT_DIR also points to this folder.`;
      }

      // Inject selected skills info
      if (project.skills && project.skills.length > 0) {
        const allSkills = await getSkills();
        const selectedSkills = allSkills.filter((s) => project.skills.includes(s.id));
        if (selectedSkills.length > 0) {
          projectPrompt += `\n\nProject skills (ONLY these skills are available for this project): ${selectedSkills.map((s) => s.name).join(", ")}\nYou MUST use these skills when they match the user's request. These are the only skills loaded for this project.`;
        }
      }

      // Append instruction to auto-record project info
      projectPrompt += `\n\nIMPORTANT: If the user shares project information (tech stack, architecture decisions, conventions, key files, etc.), suggest recording it to the project memory. You can mention "Would you like me to add this to the project memory?"`;

      // Reuse the same chat session logic
      const sessions = await getChatHistory();
      let session = sessions.find((s) => s.id === sessionId);

      if (!session) {
        session = {
          id: sessionId,
          title: `[${project.name}] ${message.slice(0, 40)}`,
          messages: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        sessions.push(session);
      }

      session.messages.push({
        role: "user",
        content: message,
        timestamp: new Date().toISOString(),
      });
      session.updatedAt = new Date().toISOString();
      await saveChatHistory(sessions);

      // ─── /agent command in project chat ───
      const agentCmdMatchProj = message.match(/^\/agent\s+(?:(\S+)\s+)?[""]?([\s\S]+?)[""]?\s*$/i);
      if (agentCmdMatchProj) {
        const rtSession = getRealtimeSession(sessionId);
        if (!rtSession) {
          const errMsg = "No realtime agent session is active for this project.";
          session.messages.push({ role: "assistant", content: errMsg, timestamp: new Date().toISOString() });
          await saveChatHistory(sessions);
          socket.emit("chat:response", { sessionId, content: errMsg, done: true });
          return;
        }

        const targetArg = agentCmdMatchProj[1];
        const prompt = agentCmdMatchProj[2].trim();

        if (targetArg) {
          const connectedIds = getHumanConnectedAgents(sessionId);
          let targetId: string | undefined;
          if (rtSession.agents.has(targetArg)) {
            targetId = targetArg;
          } else {
            for (const [id, handle] of rtSession.agents.entries()) {
              if (handle.agentDef.name.toLowerCase() === targetArg.toLowerCase() ||
                  handle.agentDef.id.toLowerCase() === targetArg.toLowerCase()) {
                targetId = id;
                break;
              }
            }
          }

          if (!targetId) {
            const available = Array.from(rtSession.agents.entries())
              .filter(([, h]) => h.agentDef.role !== "human")
              .map(([id, h]) => `${h.agentDef.name} (${id})`)
              .join(", ");
            const errMsg = `Agent "${targetArg}" not found. Available: ${available}`;
            session.messages.push({ role: "assistant", content: errMsg, timestamp: new Date().toISOString() });
            await saveChatHistory(sessions);
            socket.emit("chat:response", { sessionId, content: errMsg, done: true });
            return;
          }

          if (connectedIds.length > 0 && !connectedIds.includes(targetId)) {
            const allowedNames = connectedIds.map((id) => rtSession.agents.get(id)?.agentDef.name || id).join(", ");
            const errMsg = `You can only talk to agents connected to the human node: ${allowedNames}`;
            session.messages.push({ role: "assistant", content: errMsg, timestamp: new Date().toISOString() });
            await saveChatHistory(sessions);
            socket.emit("chat:response", { sessionId, content: errMsg, done: true });
            return;
          }

          const agentName = rtSession.agents.get(targetId)!.agentDef.name;
          const projAgentStartTime = Date.now();
          socket.emit("chat:chunk", {
            sessionId,
            content: `> <span class="proto-tag proto-bus">HUMAN</span> → **${agentName}** (\`${targetId}\`): _${prompt.slice(0, 120)}_\n`,
          });

          const result = humanSendToAgent(sessionId, targetId, prompt);
          if (!result.ok) {
            const errMsg = `Failed: ${result.error}`;
            session.messages.push({ role: "assistant", content: errMsg, timestamp: new Date().toISOString() });
            await saveChatHistory(sessions);
            socket.emit("chat:response", { sessionId, content: errMsg, done: true });
            return;
          }

          socket.emit("chat:chunk", { sessionId, content: `> Waiting for **${agentName}**...\n` });
          const waitResult = await humanWaitForAgent(sessionId, targetId, 120000);
          const responseContent = waitResult.ok
            ? `<div class="agent-response-tag" data-agent="${targetId}">📨 <strong>${agentName}</strong></div>\n\n${waitResult.result}`
            : `**${agentName}** did not respond: ${waitResult.error}`;

          // Scan for output files generated during agent execution
          const projAgentSettings = await getSettings();
          const projAgentSandboxDir = projAgentSettings.sandboxDir || path.resolve("sandbox");
          const projAgentOutputFiles = scanOutputFiles(projAgentSandboxDir, projAgentStartTime);

          session.messages.push({ role: "assistant", content: responseContent, timestamp: new Date().toISOString(), files: projAgentOutputFiles.length > 0 ? projAgentOutputFiles : undefined });
          await saveChatHistory(sessions);
          socket.emit("chat:chunk", { sessionId, content: "", clear: true });
          socket.emit("chat:response", { sessionId, content: responseContent, done: true, files: projAgentOutputFiles.length > 0 ? projAgentOutputFiles : undefined });
          return;

        } else {
          const connectedIds = getHumanConnectedAgents(sessionId);
          if (connectedIds.length === 0) {
            const errMsg = "No agents connected to human node.";
            session.messages.push({ role: "assistant", content: errMsg, timestamp: new Date().toISOString() });
            await saveChatHistory(sessions);
            socket.emit("chat:response", { sessionId, content: errMsg, done: true });
            return;
          }

          const agentNames = connectedIds.map((id) => rtSession.agents.get(id)?.agentDef.name || id);
          socket.emit("chat:chunk", {
            sessionId,
            content: `> <span class="proto-tag proto-bus">HUMAN</span> → Broadcasting to **${agentNames.join(", ")}**: _${prompt.slice(0, 120)}_\n`,
          });

          const projBcStartTime = Date.now();
          const broadcastResult = humanBroadcastToAgents(sessionId, prompt);
          if (!broadcastResult.ok) {
            const errMsg = `Broadcast failed: ${broadcastResult.errors.join("; ")}`;
            session.messages.push({ role: "assistant", content: errMsg, timestamp: new Date().toISOString() });
            await saveChatHistory(sessions);
            socket.emit("chat:response", { sessionId, content: errMsg, done: true });
            return;
          }

          socket.emit("chat:chunk", { sessionId, content: `> Waiting for ${broadcastResult.sent.length} agent(s)...\n` });
          const results = await Promise.all(
            broadcastResult.sent.map(async (agentId) => {
              const agentName = rtSession.agents.get(agentId)?.agentDef.name || agentId;
              const waitResult = await humanWaitForAgent(sessionId, agentId, 120000);
              return waitResult.ok
                ? `<div class="agent-response-tag" data-agent="${agentId}">📨 <strong>${agentName}</strong></div>\n\n${waitResult.result}`
                : `<div class="agent-response-tag" data-agent="${agentId}">⏱️ <strong>${agentName}</strong> (timeout)</div>\n\n${waitResult.error}`;
            })
          );

          const fullResponse = results.join("\n\n---\n\n");

          // Scan for output files generated during agent execution
          const projBcSettings = await getSettings();
          const projBcSandboxDir = projBcSettings.sandboxDir || path.resolve("sandbox");
          const projBcOutputFiles = scanOutputFiles(projBcSandboxDir, projBcStartTime);

          session.messages.push({ role: "assistant", content: fullResponse, timestamp: new Date().toISOString(), files: projBcOutputFiles.length > 0 ? projBcOutputFiles : undefined });
          await saveChatHistory(sessions);
          socket.emit("chat:chunk", { sessionId, content: "", clear: true });
          socket.emit("chat:response", { sessionId, content: fullResponse, done: true, files: projBcOutputFiles.length > 0 ? projBcOutputFiles : undefined });
          return;
        }
      }

      const settings = await getSettings();
      const chatMessages = session.messages.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

      // Handle images same as regular chat
      if (images && images.length > 0) {
        const lastIdx = chatMessages.length - 1;
        const textContent = chatMessages[lastIdx].content;
        const contentParts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
          { type: "text", text: textContent },
        ];
        for (const img of images) {
          try {
            const imgPath = path.resolve(img.path);
            let imgBuffer = fs.readFileSync(imgPath);
            let mimeType = img.type || "image/png";
            const MAX_SIZE = 4 * 1024 * 1024;
            if (imgBuffer.length > MAX_SIZE) {
              try {
                const tmpOut = `/tmp/cowork_resized_${Date.now()}.jpg`;
                execSync(`python3 -c "
from PIL import Image
img = Image.open('${imgPath.replace(/'/g, "\\'")}')
img.thumbnail((1600, 1600), Image.LANCZOS)
img = img.convert('RGB')
img.save('${tmpOut}', 'JPEG', quality=80)
"`, { timeout: 10000 });
                imgBuffer = fs.readFileSync(tmpOut);
                mimeType = "image/jpeg";
                fs.unlinkSync(tmpOut);
              } catch {}
            }
            const base64 = imgBuffer.toString("base64");
            contentParts.push({
              type: "image_url",
              image_url: { url: `data:${mimeType};base64,${base64}` },
            });
          } catch {}
        }
        (chatMessages[lastIdx] as any).content = contentParts;
      }

      broadcastStatus({ sessionId, status: "thinking" });
      const outputFiles: string[] = [];

      // Track active task for project chat
      const taskId = uuid();
      const activeTask: ActiveTask = {
        id: taskId,
        sessionId,
        projectId,
        projectName: project.name,
        title: message.slice(0, 80),
        status: "Thinking...",
        toolCalls: [],
        startedAt: new Date().toISOString(),
        lastUpdate: new Date().toISOString(),
      };
      activeTasks.set(taskId, activeTask);
      const abortController = new AbortController();
      taskAbortControllers.set(taskId, abortController);

      try {
        // Set call context for sub-agent spawning — pass project working folder so output goes there
        setCallContext(sessionId, 0, undefined, resolvedWorkingFolder || undefined);

        // Boot realtime agents if in realtime mode
        const rtSettings = await getSettings();
        let realtimeTools: any[] | undefined;
        if (rtSettings.subAgentEnabled && rtSettings.subAgentMode === "realtime" && rtSettings.subAgentConfigFile) {
          const rtSession = await startRealtimeSession(sessionId, rtSettings.subAgentConfigFile, abortController.signal);
          if (rtSession) {
            realtimeTools = await getToolsForRealtimeOrchestrator();
            const agentNames = Array.from(rtSession.agents.values()).map(h => `${h.agentDef.name} (${h.agentDef.id})`);
            socket.emit("chat:chunk", {
              sessionId,
              content: `> **Realtime Agents Active:** ${agentNames.join(", ")}\n\n`,
            });
          }
        }

        const result = await callTigerBotWithTools(
          chatMessages,
          projectPrompt,
          (name, args) => {
            broadcastStatus({ sessionId, status: "tool_call", tool: name, args });
            // Tag protocol tool usage in chat
            if (name.startsWith("proto_") && ioRef) {
              const protoName = name.replace("proto_", "").split("_")[0].toUpperCase();
              ioRef.emit("chat:chunk", {
                sessionId,
                content: `> <span class="proto-tag proto-${protoName.toLowerCase()}">${protoName}</span> \`${name}\` — ${args.topic || args.peer || args.to || ""}\n`,
              });
            }
            // Tag realtime agent tools in chat
            if ((name === "send_task" || name === "wait_result") && ioRef) {
              const targetId = args.to || args.from || "";
              ioRef.emit("chat:chunk", {
                sessionId,
                content: `> <span class="proto-tag proto-bus">AGENT</span> \`${name}\` → ${targetId}\n`,
              });
            }
            // Descriptive active task status for orchestrator tools
            if (name === "send_task") {
              activeTask.status = `Running: send_task — delegating to ${args.to || "agent"}`;
            } else if (name === "wait_result") {
              activeTask.status = `Running: wait_result — waiting for ${args.from || "agent"}`;
            } else if (name === "check_agents") {
              activeTask.status = `Running: check_agents`;
            } else {
              activeTask.status = `Running: ${name}`;
            }
            activeTask.toolCalls.push(name);
            activeTask.lastUpdate = new Date().toISOString();
          },
          (name, toolResult) => {
            broadcastStatus({ sessionId, status: "tool_result", tool: name });
            if (name === "wait_result") {
              activeTask.status = "Agent result received, thinking...";
            } else if (name === "send_task") {
              activeTask.status = "Task delegated, orchestrating...";
            } else {
              activeTask.status = `${name} done, thinking...`;
            }
            activeTask.lastUpdate = new Date().toISOString();
            if (toolResult?.outputFiles) outputFiles.push(...toolResult.outputFiles);
          },
          abortController.signal,
          realtimeTools,
        );

        // Clear streaming progress and show final AI response
        socket.emit("chat:chunk", { sessionId, content: "", clear: true });
        if (result.content) {
          socket.emit("chat:chunk", { sessionId, content: "\n" + result.content });
        }

        const fullResponse = result.content +
          (outputFiles.length > 0 ? `\n\nGenerated files: ${outputFiles.join(", ")}` : "");

        session.messages.push({
          role: "assistant",
          content: fullResponse,
          timestamp: new Date().toISOString(),
          files: outputFiles.length > 0 ? outputFiles : undefined,
        });
        await saveChatHistory(sessions);
        socket.emit("chat:response", { sessionId, content: fullResponse, done: true, files: outputFiles.length > 0 ? outputFiles : undefined });
      } catch (err: any) {
        if (abortController.signal.aborted) {
          const cancelMsg = "Task was cancelled." +
            (outputFiles.length > 0 ? `\n\nGenerated files: ${outputFiles.join(", ")}` : "");
          session.messages.push({
            role: "assistant",
            content: cancelMsg,
            timestamp: new Date().toISOString(),
            files: outputFiles.length > 0 ? outputFiles : undefined,
          });
          await saveChatHistory(sessions);
          socket.emit("chat:response", { sessionId, content: cancelMsg, done: true, files: outputFiles.length > 0 ? outputFiles : undefined });
        } else {
          try {
            const result = await callTigerBot(chatMessages, projectPrompt);
            const fallbackContent = result.content +
              (outputFiles.length > 0 ? `\n\nGenerated files: ${outputFiles.join(", ")}` : "");
            session.messages.push({
              role: "assistant",
              content: fallbackContent,
              timestamp: new Date().toISOString(),
              files: outputFiles.length > 0 ? outputFiles : undefined,
            });
            await saveChatHistory(sessions);
            socket.emit("chat:response", { sessionId, content: fallbackContent, done: true, files: outputFiles.length > 0 ? outputFiles : undefined });
          } catch (fallbackErr: any) {
            const errMsg = `Error: ${fallbackErr.message || err.message}`;
            session.messages.push({
              role: "assistant",
              content: errMsg,
              timestamp: new Date().toISOString(),
            });
            await saveChatHistory(sessions);
            socket.emit("chat:response", { sessionId, content: errMsg, done: true });
          }
        }
      } finally {
        // Keep session alive if human node is present
        const rtSessionCheck2 = getRealtimeSession(sessionId);
        const hasHumanNode2 = rtSessionCheck2?.systemConfig?.agents?.some((a: any) => a.role === "human");
        if (!hasHumanNode2) {
          shutdownRealtimeSession(sessionId);
        }
        activeTasks.delete(taskId);
        taskAbortControllers.delete(taskId);
      }
    });

    socket.on("python:run", async (data: { code: string }) => {
      const settings = await getSettings();
      const sandboxDir = settings.sandboxDir || path.resolve("sandbox");
      socket.emit("python:status", { status: "running" });
      const result = await runPython(data.code, sandboxDir);
      socket.emit("python:result", result);
    });

    socket.on("disconnect", () => {
      console.log("Client disconnected:", socket.id);
    });
  });
}
