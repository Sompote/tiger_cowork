import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import yaml from "js-yaml";
import { runPython } from "./python";
import { getSettings, appendAgentHistory, flushAgentHistory } from "./data";
import { getMcpTools, callMcpTool, isMcpTool } from "./mcp";
import {
  tcpOpen, tcpSend, tcpRead, tcpClose,
  busPublish, busSubscribe, busHistory, busGet, busWaitForMessage, busLoadHistory,
  queueEnqueue, queueDequeue, queuePeek, queueDepth, queueDrain,
  getProtocolStatus, cleanupSessionProtocols,
} from "./protocols";


const execAsync = promisify(exec);

// --- Tool definitions (OpenAI function-calling format) ---

const builtinTools = [
  {
    type: "function" as const,
    function: {
      name: "web_search",
      description: "Search the web using DuckDuckGo or Google. Returns search results with titles, URLs, and snippets.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "fetch_url",
      description: "Fetch content from a URL. Returns the response body (JSON or text, truncated if large).",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to fetch" },
          method: { type: "string", description: "HTTP method (default GET)" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "run_python",
      description: "Execute Python code in the sandbox. Working directory is output_file/. Use PROJECT_DIR variable to access project files (e.g. os.path.join(PROJECT_DIR, 'uploads/file.xlsx')). Returns stdout, stderr, and any generated files.",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "Python code to execute" },
        },
        required: ["code"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "run_react",
      description: "Execute React/JSX code. The component is compiled with esbuild and rendered natively in the output panel using Recharts (already available — no CDN needed). Write a single default-exported React component. Recharts components (LineChart, BarChart, PieChart, ResponsiveContainer, etc.) are available as globals.",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "React JSX component code. Should export or define a default component. Can use hooks, state, etc. IMPORTANT: Keep code under 3000 characters to avoid truncation. For complex UIs, split into multiple run_react calls or use helper functions." },
          title: { type: "string", description: "Title for the HTML page (optional)" },
          dependencies: {
            type: "array",
            items: { type: "string" },
            description: "Additional CDN libraries to include (e.g. 'recharts', 'chart.js'). React and ReactDOM are included by default.",
          },
        },
        required: ["code"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "run_shell",
      description: "Execute a shell command. Use for installing packages, git operations, system tasks, etc.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to run" },
          cwd: { type: "string", description: "Working directory (optional)" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "read_file",
      description: "Read a file from disk. Returns content (truncated if very large).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to read" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "write_file",
      description: "Write or append content to a file on disk.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path" },
          content: { type: "string", description: "Content to write" },
          append: { type: "boolean", description: "Append instead of overwrite" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_files",
      description: "List files and directories at a given path.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path (default: sandbox root)" },
          recursive: { type: "boolean", description: "List recursively" },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_skills",
      description: "List all installed skills (both built-in and from ClawHub marketplace). Returns skill names you can load with load_skill.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "load_skill",
      description: "Load the full SKILL.md content for a specific installed skill. This gives you the skill's instructions, commands, and usage examples. Use this when you need to execute a skill.",
      parameters: {
        type: "object",
        properties: {
          skill: { type: "string", description: "Skill name/slug (e.g. 'duckduckgo-search', 'youtube-transcript')" },
        },
        required: ["skill"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "clawhub_search",
      description: "Search the ClawHub/OpenClaw skill marketplace.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          limit: { type: "integer", description: "Max results (default 10)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "clawhub_install",
      description: "Install a skill from ClawHub marketplace by slug.",
      parameters: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Skill slug to install" },
          force: { type: "boolean", description: "Force reinstall" },
        },
        required: ["slug"],
      },
    },
  },
];

// Sub-agent spawning tool (conditionally included)
const spawnSubagentTool = {
  type: "function" as const,
  function: {
    name: "spawn_subagent",
    description: "Spawn a sub-agent to handle a specific sub-task independently. The sub-agent gets its own tool-calling loop and returns results when done. Use this for: parallel research, breaking complex tasks into parts, or delegating specialized work. Each sub-agent runs autonomously with full tool access.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "Clear description of the sub-task for the sub-agent to complete" },
        label: { type: "string", description: "Short label for this sub-agent (e.g. 'research-api', 'generate-chart')" },
        context: { type: "string", description: "Optional additional context or data the sub-agent needs" },
        agentId: { type: "string", description: "Optional agent ID from manual YAML config to use specific agent definition" },
      },
      required: ["task"],
    },
  },
};

// ─── Protocol Tools (TCP / Bus / Queue) ───

const tcpTools = [
  {
    type: "function" as const,
    function: {
      name: "proto_tcp_send",
      description: "Send a message to another agent via TCP point-to-point channel. Opens a channel automatically if needed.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "Target agent ID" },
          topic: { type: "string", description: "Message topic" },
          payload: { type: "string", description: "Message content (JSON string or plain text)" },
        },
        required: ["to", "topic", "payload"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "proto_tcp_read",
      description: "Read all messages from a TCP channel with another agent.",
      parameters: {
        type: "object",
        properties: {
          peer: { type: "string", description: "The other agent's ID" },
        },
        required: ["peer"],
      },
    },
  },
];

const busTools = [
  {
    type: "function" as const,
    function: {
      name: "proto_bus_publish",
      description: "Publish a message to the shared event bus. All bus-connected agents on the same session can see it.",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string", description: "Topic to publish to" },
          payload: { type: "string", description: "Message content" },
        },
        required: ["topic", "payload"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "proto_bus_history",
      description: "Read the message history from the event bus, optionally filtered by topic.",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string", description: "Optional topic filter" },
        },
        required: [],
      },
    },
  },
];

const queueTools = [
  {
    type: "function" as const,
    function: {
      name: "proto_queue_send",
      description: "Enqueue a message to another agent's queue (FIFO). The receiving agent can dequeue it later.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "Target agent ID" },
          topic: { type: "string", description: "Message topic" },
          payload: { type: "string", description: "Message content" },
        },
        required: ["to", "topic", "payload"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "proto_queue_receive",
      description: "Dequeue (consume) the next message from your queue, optionally filtered by sender.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "Sender agent ID to read from" },
          topic: { type: "string", description: "Optional topic filter" },
        },
        required: ["from"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "proto_queue_peek",
      description: "Peek at messages in your queue without consuming them.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "Sender agent ID" },
          topic: { type: "string", description: "Optional topic filter" },
          count: { type: "number", description: "Number of messages to peek (default 5)" },
        },
        required: ["from"],
      },
    },
  },
];

// All protocol tools combined (for backward compat / orchestrator)
const protocolTools = [...tcpTools, ...busTools, ...queueTools];

// OpenRouter Web Search tool (conditionally included)
const openRouterSearchTool = {
  type: "function" as const,
  function: {
    name: "openrouter_web_search",
    description: "Search the web using OpenRouter's Responses API with the web search plugin. Returns AI-summarized results with source citations. Best for detailed, up-to-date answers from the web.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
      },
      required: ["query"],
    },
  },
};

// Get protocol tools filtered by agent config
export function getProtocolToolsForAgent(agentDef?: AgentConfig | null, connections?: any[], systemConfig?: AgentSystemConfig | null): any[] {
  if (!agentDef) return protocolTools; // no config = give all (orchestrator / auto mode)

  const tools: any[] = [];

  // Bus: if agent has bus.enabled, OR hybrid orchestrator (monitors all bus traffic)
  const isHybridOrch = systemConfig?.system?.orchestration_mode === "hybrid" && agentDef.role === "orchestrator";
  if (agentDef.bus?.enabled || isHybridOrch) {
    tools.push(...busTools);
  }

  // TCP/Queue: check if agent has connections using these protocols
  if (connections && connections.length > 0) {
    const agentConns = connections.filter(
      (c: any) => c.from === agentDef.id || c.to === agentDef.id
    );
    const protocols = new Set(agentConns.map((c: any) => c.protocol));
    if (protocols.has("tcp")) tools.push(...tcpTools);
    if (protocols.has("queue")) tools.push(...queueTools);
  } else {
    // No connections info available — give tcp + queue as fallback
    tools.push(...tcpTools, ...queueTools);
  }

  return tools;
}

// Dynamic tools getter: built-in + MCP tools + conditional OpenRouter search + sub-agent
export async function getTools(opts?: { excludeSubagent?: boolean }) {
  const settings = await getSettings();
  const tools: any[] = [...builtinTools];
  if (settings.openRouterSearchEnabled && settings.openRouterSearchApiKey) {
    tools.push(openRouterSearchTool);
  }
  if (settings.subAgentEnabled && !opts?.excludeSubagent) {
    if (settings.subAgentMode === "realtime") {
      // Realtime mode: use send_task/wait_result instead of spawn_subagent
      tools.push(sendTaskTool, waitResultTool, checkAgentsTool);
    } else {
      tools.push(spawnSubagentTool);
    }
  }
  if (settings.subAgentEnabled) {
    tools.push(...protocolTools);
  }
  return [...tools, ...getMcpTools()];
}

// Get manual agent config summary for system prompt injection
export async function getManualAgentConfigSummary(): Promise<string | null> {
  const settings = await getSettings();
  // Realtime mode has its own summary
  if (settings.subAgentMode === "realtime") return await getRealtimeAgentConfigSummary();
  if (settings.subAgentMode !== "manual" || !settings.subAgentConfigFile) return null;
  const config = loadAgentConfig(settings.subAgentConfigFile);
  if (!config) return null;
  let summary = `\n\nMANUAL AGENT TEAM CONFIGURATION (${config.system?.name || "Unnamed"}):\n`;
  summary += `Orchestration mode: ${config.system?.orchestration_mode || "hierarchical"}\n`;
  summary += `Available agents:\n`;
  for (const a of config.agents || []) {
    const flags = [
      a.bus?.enabled ? "bus" : "",
      a.mesh?.enabled ? "mesh" : "",
    ].filter(Boolean).join(", ");
    summary += `  - ${a.id} ("${a.name}"): role=${a.role}${flags ? ` [${flags}]` : ""}, persona=${a.persona || "N/A"}\n`;
    if (a.responsibilities && a.responsibilities.length > 0) {
      summary += `    responsibilities: ${a.responsibilities.join("; ")}\n`;
    }
  }

  // Include workflow sequence so the LLM knows the exact delegation order
  if (config.workflow?.sequence && config.workflow.sequence.length > 0) {
    summary += `\nWORKFLOW SEQUENCE (you MUST follow this order):\n`;
    for (const step of config.workflow.sequence) {
      const agent = config.agents?.find((a: AgentConfig) => a.id === step.agent);
      const agentName = agent ? `${agent.name} (${agent.role})` : step.agent;
      const outputsTo = step.outputs_to ? ` → outputs to: ${step.outputs_to.join(", ")}` : "";
      summary += `  Step ${step.step}: ${step.agent} [${agentName}] — ${step.action}${outputsTo}\n`;
    }
  }

  summary += `\nINSTRUCTIONS: You MUST spawn sub-agents using the agentId parameter to match agents from this config.\n`;
  summary += `For each user task, follow the workflow sequence: spawn agents in order, pass context between them, and synthesize the final result.\n`;
  summary += `Example: spawn_subagent({task: "...", label: "Project manager", agentId: "agent_1", context: "..."})\n`;
  return summary;
}

// Get tools for sub-agents — filters protocol tools based on agent config
export async function getToolsForSubagent(
  currentDepth: number,
  agentDef?: AgentConfig | null,
  connections?: any[],
  systemConfig?: AgentSystemConfig | null
): Promise<any[]> {
  const settings = await getSettings();
  const maxDepth = settings.subAgentMaxDepth || 2;
  const tools: any[] = [...builtinTools];

  if (settings.openRouterSearchEnabled && settings.openRouterSearchApiKey) {
    tools.push(openRouterSearchTool);
  }
  const isManual = settings.subAgentMode === "manual";
  if (settings.subAgentEnabled) {
    if (isManual) {
      // Manual mode: no depth limit — YAML structure is the boundary.
      // Agent gets spawn tool if it has downstream agents, mesh.enabled, or global mesh mode.
      const hasDownstream = agentDef && systemConfig?.workflow?.sequence?.some(
        (step: any) => step.agent === agentDef.id && step.outputs_to?.length > 0
      );
      const hasMesh = agentDef?.mesh?.enabled === true || systemConfig?.system?.orchestration_mode === "mesh";
      if (hasDownstream || hasMesh) tools.push(spawnSubagentTool);
    } else {
      // Auto mode: depth limit applies
      if (currentDepth < maxDepth) tools.push(spawnSubagentTool);
    }
  }
  if (settings.subAgentEnabled) {
    // Only give protocol tools the agent is configured to use
    tools.push(...getProtocolToolsForAgent(agentDef, connections, systemConfig));
  }
  return [...tools, ...getMcpTools()];
}

// Keep backward-compat export (static reference for imports that use `tools`)
export const tools = builtinTools;

// --- Tool implementations ---

async function webSearch(args: { query: string }): Promise<any> {
  const settings = await getSettings();
  const query = args.query;
  const results: any[] = [];

  // Primary: DuckDuckGo Python library (reliable, bypasses bot detection)
  try {
    const safeQuery = query.replace(/'/g, "\\'");
    const pyScript = [
      "import json",
      "try:",
      "    from ddgs import DDGS",
      `    r = list(DDGS().text('${safeQuery}', max_results=8))`,
      "    print(json.dumps(r))",
      "except ImportError:",
      "    from duckduckgo_search import DDGS",
      "    with DDGS() as ddgs:",
      `        r = list(ddgs.text('${safeQuery}', max_results=8))`,
      "        print(json.dumps(r))",
    ].join("\n");
    const tmpFile = `/tmp/ddg_search_${Date.now()}.py`;
    fs.writeFileSync(tmpFile, pyScript);
    const { stdout } = await execAsync(`python3 ${tmpFile}`, { timeout: 30000 });
    try { fs.unlinkSync(tmpFile); } catch {}
    const ddgResults = JSON.parse(stdout.trim());
    for (const r of ddgResults) {
      results.push({
        source: "web",
        title: r.title || "",
        url: r.href || r.link || "",
        text: r.body || r.snippet || "",
      });
    }
  } catch (err: any) {
    console.error("[webSearch] DuckDuckGo Python failed:", err.message);
  }

  // Fallback: DuckDuckGo Instant Answer API (for quick facts/definitions)
  if (results.length === 0) {
    try {
      const ddgRes = await fetch(
        `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`
      );
      const ddg = await ddgRes.json();
      if (ddg.Abstract) {
        results.push({ source: "abstract", title: ddg.Heading, text: ddg.Abstract, url: ddg.AbstractURL });
      }
      for (const topic of (ddg.RelatedTopics || []).slice(0, 5)) {
        if (topic.Text) {
          results.push({ source: "related", text: topic.Text, url: topic.FirstURL });
        }
      }
    } catch {}
  }

  // If Google is configured, also try Google
  if (settings.webSearchEngine === "google" && settings.webSearchApiKey) {
    try {
      const cx = settings.googleSearchCx || "";
      const gRes = await fetch(
        `https://www.googleapis.com/customsearch/v1?key=${settings.webSearchApiKey}&cx=${cx}&q=${encodeURIComponent(query)}`
      );
      const gData = await gRes.json();
      for (const item of (gData.items || []).slice(0, 5)) {
        results.push({ source: "google", title: item.title, url: item.link, text: item.snippet });
      }
    } catch {}
  }

  // Also try Wikipedia search as it's reliable for knowledge queries
  try {
    const wikiRes = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&format=json&list=search&srsearch=${encodeURIComponent(query)}&srlimit=3`,
      { headers: { "User-Agent": "TigerCowork/1.0" } }
    );
    const wikiData = await wikiRes.json();
    for (const item of (wikiData.query?.search || [])) {
      results.push({
        source: "wikipedia",
        title: item.title,
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /g, "_"))}`,
        text: item.snippet?.replace(/<[^>]+>/g, "") || "",
      });
    }
  } catch {}

  if (results.length === 0) {
    return { results: [], note: "No results found. Try a different query or use fetch_url to access a specific page." };
  }
  return { results };
}

async function fetchUrl(args: { url: string; method?: string }): Promise<any> {
  const { url, method } = args;
  try {
    const response = await fetch(url, {
      method: method || "GET",
      headers: { "User-Agent": "TigerCowork/1.0" },
    });
    const contentType = response.headers.get("content-type") || "";
    let data: any;
    if (contentType.includes("json")) {
      data = await response.json();
    } else {
      data = await response.text();
      if (typeof data === "string" && data.length > 30000) {
        data = data.slice(0, 30000) + "\n...(truncated)";
      }
    }
    return { ok: response.ok, status: response.status, data };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

async function runPythonTool(args: { code: string }): Promise<any> {
  const settings = await getSettings();
  const sandboxDir = settings.sandboxDir || path.resolve("sandbox");
  const result = await runPython(args.code, sandboxDir, 60000, _currentProjectWorkingFolder);
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.slice(0, 20000),
    stderr: result.stderr.slice(0, 5000),
    outputFiles: result.outputFiles,
  };
}

async function runReactTool(args: { code: string; title?: string; dependencies?: string[] }): Promise<any> {
  const settings = await getSettings();
  const sandboxDir = settings.sandboxDir || path.resolve("sandbox");
  const outputDir = _currentProjectWorkingFolder || path.join(sandboxDir, "output_file");
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  let code = args.code || "";

  // Strip import statements — React/Recharts are injected at runtime by the client
  code = code.replace(/^\s*import\s+.*?\s+from\s+['"][^'"]+['"];?\s*$/gm, "");
  code = code.replace(/^\s*import\s+['"][^'"]+['"];?\s*$/gm, "");

  // Detect exported component name
  let exportedComponent = "";
  const exportDefaultFuncMatch = code.match(/export\s+default\s+function\s+(\w+)/);
  if (exportDefaultFuncMatch) {
    exportedComponent = exportDefaultFuncMatch[1];
  } else {
    const exportDefaultMatch = code.match(/export\s+default\s+(\w+)\s*;?/);
    if (exportDefaultMatch) exportedComponent = exportDefaultMatch[1];
  }

  // Strip export keywords
  code = code.replace(/export\s+default\s+(function|class)\s+/g, "$1 ");
  code = code.replace(/^\s*export\s+default\s+\w+\s*;?\s*$/gm, "");
  code = code.replace(/^\s*export\s+/gm, "");

  // Detect component names (uppercase function/const/class declarations)
  const componentMatches = code.match(/(?:function|const|class)\s+([A-Z]\w+)/g) || [];
  const componentNames = componentMatches.map((m) => m.replace(/^(?:function|const|class)\s+/, ""));
  const renderTarget = exportedComponent
    || componentNames.find((n) => n === "App")
    || componentNames[componentNames.length - 1]
    || "";

  // Wrap code: destructure React hooks + Recharts at top, return the component at bottom
  const wrapped = `const { useState, useEffect, useRef, useMemo, useCallback, useReducer, useContext, createContext, Fragment, memo, forwardRef, lazy, Suspense } = React;
const _Recharts = typeof Recharts !== 'undefined' ? Recharts : {};
const { LineChart, Line, BarChart, Bar, AreaChart, Area, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ScatterChart, Scatter, RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis, ComposedChart, Treemap, Funnel, FunnelChart, RadialBarChart, RadialBar, Sankey, LabelList, Brush, ReferenceLine, ReferenceArea, ReferenceDot, ErrorBar, Label } = _Recharts;

${code}

return ${renderTarget || "null"};`;

  // Compile JSX → JS using esbuild
  let compiled: string;
  try {
    const esbuild = await import("esbuild");
    const result = await esbuild.transform(wrapped, {
      loader: "jsx",
      jsx: "transform",
      jsxFactory: "React.createElement",
      jsxFragment: "React.Fragment",
    });
    compiled = result.code;
  } catch (err: any) {
    return { ok: false, error: `JSX compilation failed: ${err.message}`, outputFiles: [] };
  }

  // Save as .js with metadata header
  const filename = `react_${Date.now()}.jsx.js`;
  const filePath = path.join(outputDir, filename);
  const meta = JSON.stringify({ title: args.title || "React Component", renderTarget });
  const output = `// __REACT_META__=${meta}\n${compiled}`;

  try {
    fs.writeFileSync(filePath, output, "utf8");
    const relPath = path.relative(sandboxDir, filePath);
    return {
      ok: true,
      outputFiles: [relPath],
      message: `React component compiled to ${relPath}. It will render natively in the output panel.`,
    };
  } catch (err: any) {
    return { ok: false, error: err.message, outputFiles: [] };
  }
}

async function runShell(args: { command?: string; cmd?: string; cwd?: string }): Promise<any> {
  // Accept both "command" and "cmd" since models sometimes use either
  const command = args.command || args.cmd;
  if (!command) return { ok: false, error: "No command provided" };
  const settings = await getSettings();
  const cwd = args.cwd || settings.sandboxDir || process.cwd();
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, stdout: String(stdout).slice(0, 20000), stderr: String(stderr).slice(0, 5000) };
  } catch (err: any) {
    return { ok: false, error: err.message, stdout: String(err.stdout || "").slice(0, 10000), stderr: String(err.stderr || "").slice(0, 5000) };
  }
}

function readFileTool(args: { path?: string; file?: string; filepath?: string }): any {
  const filePath = args.path || args.file || args.filepath;
  if (!filePath) return { ok: false, error: "No path provided" };
  const target = path.resolve(filePath);
  if (!fs.existsSync(target)) return { ok: false, error: "File not found: " + target };
  const content = fs.readFileSync(target, "utf8");
  return { ok: true, path: target, content: content.slice(0, 30000), truncated: content.length > 30000 };
}

async function writeFileTool(args: { path: string; content: string; append?: boolean }): Promise<any> {
  const settings = await getSettings();
  const sandboxDir = settings.sandboxDir || path.resolve("sandbox");
  const outputDir = _currentProjectWorkingFolder || path.join(sandboxDir, "output_file");
  const target = path.resolve(outputDir, args.path);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (args.append) {
    fs.appendFileSync(target, args.content, "utf8");
  } else {
    fs.writeFileSync(target, args.content, "utf8");
  }
  // Return outputFiles so the file appears in the output panel
  const ext = path.extname(args.path).toLowerCase();
  const outputExts = [".pdf", ".docx", ".doc", ".xlsx", ".csv", ".png", ".jpg", ".jpeg", ".svg", ".html", ".gif", ".webp", ".txt", ".md"];
  const relPath = path.relative(sandboxDir, target);
  const outputFiles = outputExts.includes(ext) ? [relPath] : [];
  return { ok: true, path: target, bytes: Buffer.byteLength(args.content), outputFiles };
}

async function listFilesTool(args: { path?: string; recursive?: boolean }): Promise<any> {
  const settings = await getSettings();
  const target = path.resolve(args.path || settings.sandboxDir || ".");
  if (!fs.existsSync(target)) return { ok: false, error: "Directory not found" };
  const items: { path: string; type: string }[] = [];
  const limit = 200;

  function walk(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (items.length >= limit) return;
      // Skip node_modules and .git
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      items.push({ path: full, type: entry.isDirectory() ? "dir" : "file" });
      if (args.recursive && entry.isDirectory()) walk(full);
    }
  }
  walk(target);
  return { root: target, items, truncated: items.length >= limit };
}

const SKILLS_DIR = path.resolve("Tiger_bot/skills");
const CUSTOM_SKILLS_DIR = path.resolve("skills");

function listSkillsTool(): any {
  // ClawHub skills
  const clawhubSkills: { name: string; files: string[] }[] = [];
  if (fs.existsSync(SKILLS_DIR)) {
    const dirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
    for (const d of dirs) {
      if (d.isDirectory() && fs.existsSync(path.join(SKILLS_DIR, d.name, "SKILL.md"))) {
        const files = fs.readdirSync(path.join(SKILLS_DIR, d.name), { withFileTypes: true })
          .filter((f: any) => !f.isDirectory() && !f.name.startsWith("."))
          .map((f: any) => f.name);
        clawhubSkills.push({ name: d.name, files });
      }
    }
  }

  // Custom uploaded skills
  const customSkills: { name: string; files: string[] }[] = [];
  if (fs.existsSync(CUSTOM_SKILLS_DIR)) {
    const dirs = fs.readdirSync(CUSTOM_SKILLS_DIR, { withFileTypes: true });
    for (const d of dirs) {
      if (d.isDirectory()) {
        const files = fs.readdirSync(path.join(CUSTOM_SKILLS_DIR, d.name), { withFileTypes: true })
          .filter((f: any) => !f.isDirectory() && !f.name.startsWith("."))
          .map((f: any) => f.name);
        customSkills.push({ name: d.name, files });
      }
    }
  }

  // Registered skills from data/skills.json
  let registeredSkills: { name: string; source: string; enabled: boolean }[] = [];
  try {
    const skillsFile = path.resolve("data/skills.json");
    if (fs.existsSync(skillsFile)) {
      const skills = JSON.parse(fs.readFileSync(skillsFile, "utf8"));
      registeredSkills = skills.map((s: any) => ({ name: s.name, source: s.source, enabled: s.enabled }));
    }
  } catch {}

  return {
    clawhub_skills: clawhubSkills,
    custom_skills: customSkills,
    registered_skills: registeredSkills,
    clawhub_dir: SKILLS_DIR,
    custom_dir: CUSTOM_SKILLS_DIR,
    hint: "Use load_skill with a skill name to see its SKILL.md and supporting files. Works for both ClawHub and custom skills.",
  };
}

function loadSkillTool(args: { skill: string }): any {
  const skillName = args.skill.trim();
  if (!skillName) return { ok: false, error: "Missing skill name" };

  // Search in both ClawHub and custom skills directories
  const searchDirs = [
    { dir: SKILLS_DIR, label: "clawhub" },
    { dir: CUSTOM_SKILLS_DIR, label: "custom" },
  ];

  for (const { dir, label } of searchDirs) {
    const skillBaseDir = path.join(dir, skillName);
    const skillFile = path.join(skillBaseDir, "SKILL.md");
    if (fs.existsSync(skillFile)) {
      const content = fs.readFileSync(skillFile, "utf8").replace(/\{baseDir\}/g, skillBaseDir);

      // Collect metadata
      let meta: any = {};
      const metaFile = path.join(skillBaseDir, "_meta.json");
      if (fs.existsSync(metaFile)) {
        try { meta = JSON.parse(fs.readFileSync(metaFile, "utf8")); } catch {}
      }

      // List all supporting files in the skill folder (recursive)
      const supportingFiles: string[] = [];
      const walkSkillDir = (d: string, prefix: string) => {
        try {
          const entries = fs.readdirSync(d, { withFileTypes: true });
          for (const e of entries) {
            if (e.name.startsWith(".") || e.name === "__MACOSX") continue;
            const rel = prefix ? `${prefix}/${e.name}` : e.name;
            if (e.isDirectory()) {
              walkSkillDir(path.join(d, e.name), rel);
            } else if (e.name !== "SKILL.md" && e.name !== "_meta.json") {
              supportingFiles.push(rel);
            }
          }
        } catch {}
      };
      walkSkillDir(skillBaseDir, "");

      return {
        ok: true,
        skill: skillName,
        source: label,
        skillDir: skillBaseDir,
        content: content.slice(0, 15000),
        meta,
        supportingFiles,
        truncated: content.length > 15000,
      };
    }
  }

  return { ok: false, error: `Skill "${skillName}" not found in ${SKILLS_DIR} or ${CUSTOM_SKILLS_DIR}` };
}

async function clawhubSearchTool(args: { query: string; limit?: number }): Promise<any> {
  const { execFile } = await import("child_process");
  const { promisify: prom } = await import("util");
  const execFileAsync = prom(execFile);

  // Find clawhub binary
  const candidates = [
    path.resolve("Tiger_bot/node_modules/.bin/clawhub"),
    "clawhub",
  ];
  let bin = "";
  for (const b of candidates) {
    try {
      await execFileAsync(b, ["--cli-version"], { timeout: 5000 });
      bin = b;
      break;
    } catch {}
  }
  if (!bin) return { ok: false, error: "clawhub CLI not found" };

  const limit = Math.min(50, Math.max(1, args.limit || 10));
  const workdir = path.resolve("Tiger_bot");
  try {
    const { stdout, stderr } = await execFileAsync(
      bin,
      ["search", args.query, "--limit", String(limit), "--no-input", "--workdir", workdir, "--dir", "skills"],
      { timeout: 30000, maxBuffer: 1024 * 1024 }
    );
    return { ok: true, output: stdout.trim(), warning: stderr.trim() };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

async function clawhubInstallTool(args: { slug: string; force?: boolean }): Promise<any> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(args.slug)) {
    return { ok: false, error: "Invalid slug format" };
  }

  const { execFile } = await import("child_process");
  const { promisify: prom } = await import("util");
  const execFileAsync = prom(execFile);

  const candidates = [
    path.resolve("Tiger_bot/node_modules/.bin/clawhub"),
    "clawhub",
  ];
  let bin = "";
  for (const b of candidates) {
    try {
      await execFileAsync(b, ["--cli-version"], { timeout: 5000 });
      bin = b;
      break;
    } catch {}
  }
  if (!bin) return { ok: false, error: "clawhub CLI not found" };

  const workdir = path.resolve("Tiger_bot");
  const argv = ["install", args.slug, "--no-input", "--workdir", workdir, "--dir", "skills"];
  if (args.force) argv.push("--force");

  try {
    const { stdout, stderr } = await execFileAsync(bin, argv, { timeout: 120000, maxBuffer: 1024 * 1024 });
    return { ok: true, slug: args.slug, output: stdout.trim(), warning: stderr.trim() };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

// --- OpenRouter Web Search ---

async function openRouterWebSearch(args: { query: string }): Promise<any> {
  const settings = await getSettings();
  const apiKey = settings.openRouterSearchApiKey;
  if (!apiKey) return { ok: false, error: "OpenRouter API key not configured" };

  const model = settings.openRouterSearchModel || "openai/gpt-4.1-mini";
  const maxTokens = settings.openRouterSearchMaxTokens || 4096;
  const maxResults = Math.min(10, Math.max(1, settings.openRouterSearchMaxResults || 5));

  try {
    const response = await fetch("https://openrouter.ai/api/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: args.query,
        max_output_tokens: maxTokens,
        tools: [{ type: "web_search_preview", search_context_size: "medium" }],
        plugins: [{ id: "web", max_results: maxResults }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return { ok: false, error: `OpenRouter API error ${response.status}: ${errText}` };
    }

    const data = await response.json();

    // Extract text and citations from response
    const output = data.output || [];
    let text = "";
    const citations: Array<{ url: string; title?: string }> = [];

    for (const item of output) {
      if (item.type === "message" && item.content) {
        for (const block of item.content) {
          if (block.type === "output_text") {
            text += block.text || "";
            // Collect annotations/citations
            for (const ann of (block.annotations || [])) {
              if (ann.type === "url_citation" && ann.url) {
                citations.push({ url: ann.url, title: ann.title });
              }
            }
          }
        }
      }
    }

    return {
      ok: true,
      text: text.slice(0, 15000),
      citations: citations.slice(0, 20),
      model,
      usage: data.usage,
    };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

// --- Manual agent config loading ---

interface AgentConfig {
  id: string;
  name: string;
  role: string;
  model: string;
  persona: string;
  responsibilities: string[];
  constraints?: string[];
  tools_allowed?: string[];
  bus?: {
    enabled: boolean;
    topics?: string[];
  };
  mesh?: {
    enabled: boolean;
  };
}

interface AgentSystemConfig {
  system: { name: string; orchestration_mode: string };
  agents: AgentConfig[];
  connections?: any[];
  workflow?: any;
  communication?: any;
}

export function loadAgentConfig(filename: string): AgentSystemConfig | null {
  const agentsDir = path.resolve("data/agents");
  const fp = path.join(agentsDir, filename);
  if (!fs.existsSync(fp)) return null;
  try {
    const content = fs.readFileSync(fp, "utf8");
    return yaml.load(content) as AgentSystemConfig;
  } catch (err) {
    console.error(`[AgentConfig] Failed to parse ${filename}:`, err);
    return null;
  }
}

function getManualAgentPrompt(agentDef: AgentConfig, systemConfig: AgentSystemConfig): string {
  let prompt = `You are "${agentDef.name}" (ID: ${agentDef.id}), a ${agentDef.role} in the "${systemConfig.system.name}" system.\n\n`;
  if (agentDef.persona) {
    prompt += `PERSONA:\n${agentDef.persona}\n\n`;
  }
  if (agentDef.responsibilities && agentDef.responsibilities.length > 0) {
    prompt += `RESPONSIBILITIES:\n${agentDef.responsibilities.map(r => `- ${r}`).join("\n")}\n\n`;
  }
  if (agentDef.constraints && agentDef.constraints.length > 0) {
    prompt += `CONSTRAINTS:\n${agentDef.constraints.map(c => `- ${c}`).join("\n")}\n\n`;
  }
  // Determine downstream agents this agent can spawn (from workflow outputs_to + connections)
  const workflowStep = systemConfig.workflow?.sequence?.find((s: any) => s.agent === agentDef.id);
  const outputsTo: string[] = workflowStep?.outputs_to || [];
  const connTargets = (systemConfig.connections || [])
    .filter((c: any) => c.from === agentDef.id)
    .map((c: any) => c.to);
  const downstream = [...new Set([...outputsTo, ...connTargets])];

  if (downstream.length > 0) {
    const downstreamInfo = downstream.map(id => {
      const a = systemConfig.agents?.find((ag: AgentConfig) => ag.id === id);
      return a ? `  - ${a.id} ("${a.name}", role: ${a.role})` : `  - ${id}`;
    }).join("\n");
    prompt += `RULES:\n- Focus on your designated role and responsibilities\n- Be concise and efficient\n- Provide structured output suitable for downstream agents\n- Flag any issues or ambiguities clearly\n- You can ONLY spawn the following downstream agents (use agentId):\n${downstreamInfo}\n- Do NOT spawn agents outside this list.\n`;
  } else {
    prompt += `RULES:\n- Focus on your designated role and responsibilities\n- Be concise and efficient\n- Provide structured output suitable for downstream agents\n- Flag any issues or ambiguities clearly\n- You are a leaf agent — complete your assigned task directly. You cannot spawn sub-agents.\n`;
  }
  return prompt;
}

// --- Sub-agent spawning ---

// Active sub-agent tracking
interface SubagentRun {
  id: string;
  label: string;
  task: string;
  depth: number;
  status: "running" | "completed" | "error";
  startedAt: string;
  completedAt?: string;
  result?: string;
  toolCalls: string[];
}

const activeSubagents = new Map<string, SubagentRun>();

export function getActiveSubagents(): SubagentRun[] {
  return Array.from(activeSubagents.values());
}

// Sub-agent status broadcast callback (set by socket.ts)
let subagentStatusCallback: ((data: Record<string, any>) => void) | null = null;

export function setSubagentStatusCallback(cb: (data: Record<string, any>) => void) {
  subagentStatusCallback = cb;
}

// Import callTigerBotWithTools lazily to avoid circular dependency
let _callTigerBotForSubagent: typeof import("./tigerbot").callTigerBotWithTools | null = null;

async function getSubagentCaller() {
  if (!_callTigerBotForSubagent) {
    const mod = await import("./tigerbot");
    _callTigerBotForSubagent = mod.callTigerBotWithTools;
  }
  return _callTigerBotForSubagent;
}

export async function spawnSubagent(
  args: { task: string; label?: string; context?: string; agentId?: string },
  parentSessionId?: string,
  currentDepth: number = 0,
  signal?: AbortSignal,
): Promise<any> {
  const settings = await getSettings();
  if (!settings.subAgentEnabled) {
    return { ok: false, error: "Sub-agents are disabled. Enable them in Settings > Sub-Agent." };
  }

  const maxDepth = settings.subAgentMaxDepth || 2;

  // In manual mode: no depth limit — YAML structure is the boundary.
  // Validate that the calling agent is allowed to spawn the target agent
  // based on workflow outputs_to or connections.
  if (settings.subAgentMode === "manual" && settings.subAgentConfigFile) {
    const systemConfig = loadAgentConfig(settings.subAgentConfigFile);
    if (systemConfig) {
      const callerId = _currentAgentId;
      const targetId = args.agentId;

      if (!targetId) {
        return { ok: false, error: "In manual mode, agentId is required. You must spawn a specific agent defined in the architecture." };
      }

      // Check target agent exists in YAML
      const targetExists = systemConfig.agents?.some((a: AgentConfig) => a.id === targetId);
      if (!targetExists) {
        const available = systemConfig.agents?.map((a: AgentConfig) => a.id).join(", ") || "none";
        return { ok: false, error: `Agent "${targetId}" not found in architecture. Available agents: ${available}` };
      }

      // Validate caller is allowed to spawn target (via workflow outputs_to, connections, or mesh)
      if (callerId !== "main") {
        const callerDef = systemConfig.agents?.find((a: AgentConfig) => a.id === callerId);
        const callerHasMesh = callerDef?.mesh?.enabled === true;
        const isGlobalMesh = systemConfig.system?.orchestration_mode === "mesh";

        if (!callerHasMesh && !isGlobalMesh) {
          const callerStep = systemConfig.workflow?.sequence?.find((s: any) => s.agent === callerId);
          const allowedTargets: string[] = callerStep?.outputs_to || [];

          // Also check connections
          const connTargets = (systemConfig.connections || [])
            .filter((c: any) => c.from === callerId)
            .map((c: any) => c.to);
          const allAllowed = [...new Set([...allowedTargets, ...connTargets])];

          if (!allAllowed.includes(targetId)) {
            return { ok: false, error: `Agent "${callerId}" is not allowed to spawn "${targetId}". Allowed targets: ${allAllowed.join(", ") || "none"}` };
          }
        }
      }
    }
  } else {
    // Auto mode: enforce depth limit
    if (currentDepth >= maxDepth) {
      return { ok: false, error: `Sub-agent depth limit reached (max ${maxDepth}). Cannot spawn deeper.` };
    }
  }

  // Check concurrent limit
  const maxConcurrent = settings.subAgentMaxConcurrent || 3;
  const runningCount = Array.from(activeSubagents.values()).filter(s => s.status === "running").length;
  if (runningCount >= maxConcurrent) {
    return { ok: false, error: `Too many concurrent sub-agents (${runningCount}/${maxConcurrent}). Wait for one to finish.` };
  }

  const agentId = args.agentId || `subagent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const subagentId = agentId;
  const label = args.label || "subagent";
  const timeout = (settings.subAgentTimeout || 120) * 1000; // default 120s

  const run: SubagentRun = {
    id: subagentId,
    label,
    task: args.task,
    depth: currentDepth + 1,
    status: "running",
    startedAt: new Date().toISOString(),
    toolCalls: [],
  };
  activeSubagents.set(subagentId, run);

  // Persist spawn start to agent history
  if (parentSessionId) {
    appendAgentHistory(parentSessionId, "spawn.jsonl", {
      id: subagentId, label, task: args.task.slice(0, 2000), depth: currentDepth + 1,
      status: "running", startedAt: run.startedAt,
    }).catch(() => {});
  }

  // Broadcast sub-agent spawn status
  if (subagentStatusCallback) {
    subagentStatusCallback({
      sessionId: parentSessionId,
      status: "subagent_spawn",
      subagentId,
      label,
      task: args.task.slice(0, 200),
      depth: currentDepth + 1,
    });
  }

  console.log(`[SubAgent:${label}] Spawned at depth ${currentDepth + 1}. Task: ${args.task.slice(0, 200)}`);

  // Build sub-agent system prompt — check for manual YAML config
  let subPrompt: string;
  const subModel = settings.subAgentModel || undefined;
  let resolvedAgentDef: AgentConfig | null = null;
  let resolvedConnections: any[] | undefined;
  let resolvedSystemConfig: AgentSystemConfig | null = null;

  if (settings.subAgentMode === "manual" && settings.subAgentConfigFile) {
    // Load agent definition from YAML config
    const systemConfig = loadAgentConfig(settings.subAgentConfigFile);
    const agentDef = systemConfig?.agents?.find((a: AgentConfig) =>
      a.id === args.agentId || a.id === label || a.name === label
    );
    resolvedConnections = systemConfig?.connections;
    resolvedSystemConfig = systemConfig;

    if (agentDef && systemConfig) {
      resolvedAgentDef = agentDef;
      subPrompt = getManualAgentPrompt(agentDef, systemConfig);
      subPrompt += `\nYOUR TASK:\n${args.task}\n`;
      if (args.context) subPrompt += `\nADDITIONAL CONTEXT:\n${args.context}\n`;
      subPrompt += `\nYou are sub-agent "${label}" at depth ${currentDepth + 1}/${maxDepth}.`;
    } else {
      // Fallback to auto mode if agent not found in config
      subPrompt = `You are a focused sub-agent. You have been spawned by a parent agent to complete a specific task.

YOUR TASK:
${args.task}

${args.context ? `ADDITIONAL CONTEXT:\n${args.context}\n` : ""}

RULES:
- Focus ONLY on completing the assigned task
- Be concise and efficient — minimize unnecessary tool calls
- Return your findings/results clearly so the parent agent can use them
- You have full access to tools (web search, file read/write, Python, shell, etc.)
- Do NOT ask follow-up questions — work with what you have
- If the task is ambiguous, make reasonable assumptions and proceed
- When done, provide a clear summary of what you accomplished

You are sub-agent "${label}" at depth ${currentDepth + 1}/${maxDepth}.`;
    }
  } else {
    subPrompt = `You are a focused sub-agent. You have been spawned by a parent agent to complete a specific task.

YOUR TASK:
${args.task}

${args.context ? `ADDITIONAL CONTEXT:\n${args.context}\n` : ""}

RULES:
- Focus ONLY on completing the assigned task
- Be concise and efficient — minimize unnecessary tool calls
- Return your findings/results clearly so the parent agent can use them
- You have full access to tools (web search, file read/write, Python, shell, etc.)
- Do NOT ask follow-up questions — work with what you have
- If the task is ambiguous, make reasonable assumptions and proceed
- When done, provide a clear summary of what you accomplished

You are sub-agent "${label}" at depth ${currentDepth + 1}/${maxDepth}.`;
  }

  // Append protocol instructions based on agent's actual config
  const agentProtoTools = getProtocolToolsForAgent(resolvedAgentDef, resolvedConnections, resolvedSystemConfig);
  const protoNames = agentProtoTools.map((t: any) => t.function.name);
  const hasProto = protoNames.length > 0;

  if (hasProto) {
    const protoLines: string[] = [];
    if (protoNames.some((n: string) => n.startsWith("proto_tcp"))) {
      protoLines.push("- TCP (proto_tcp_send / proto_tcp_read): Point-to-point messaging with a specific agent");
    }
    if (protoNames.some((n: string) => n.startsWith("proto_bus"))) {
      const topicHint = resolvedAgentDef?.bus?.topics?.length
        ? ` Your configured topics: ${resolvedAgentDef.bus.topics.join(", ")}`
        : "";
      protoLines.push(`- Bus (proto_bus_publish / proto_bus_history): Broadcast messages to all bus-connected agents on a topic.${topicHint}`);
    }
    if (protoNames.some((n: string) => n.startsWith("proto_queue"))) {
      protoLines.push("- Queue (proto_queue_send / proto_queue_receive / proto_queue_peek): FIFO message queue to another agent");
    }
    subPrompt += `\n\nCOMMUNICATION PROTOCOLS:\nYour agent ID is "${agentId}".\n${protoLines.join("\n")}\nUse these to coordinate with peer agents when your task requires collaboration.`;
  } else {
    subPrompt += `\n\nYour agent ID is "${agentId}". You have no inter-agent communication protocols configured.`;
  }

  // Set agent context so protocol tools know who we are — preserve project folder
  const prevAgentId = _currentAgentId;
  const prevProjectFolder = _currentProjectWorkingFolder;
  setCallContext(parentSessionId, currentDepth + 1, agentId, _currentProjectWorkingFolder);

  try {
    const callAgent = await getSubagentCaller();

    // Create abort with timeout
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), timeout);

    // Combine parent signal and timeout
    const combinedSignal = signal && typeof (AbortSignal as any).any === "function"
      ? (AbortSignal as any).any([signal, timeoutController.signal])
      : timeoutController.signal;

    // Build filtered tool set for this sub-agent
    const subagentTools = await getToolsForSubagent(currentDepth + 1, resolvedAgentDef, resolvedConnections, resolvedSystemConfig);

    // Use agent-specific model if defined, fall back to system sub-agent model override
    const agentModel = resolvedAgentDef?.model || subModel || undefined;

    const result = await callAgent(
      [{ role: "user" as const, content: args.task }],
      subPrompt,
      // onToolCall
      (name: string, toolArgs: any) => {
        run.toolCalls.push(name);
        console.log(`[SubAgent:${label}] Tool: ${name}`);
        if (subagentStatusCallback) {
          subagentStatusCallback({
            sessionId: parentSessionId,
            status: "subagent_tool",
            subagentId,
            label,
            tool: name,
          });
        }
      },
      // onToolResult
      (name: string, toolResult: any) => {
        if (subagentStatusCallback) {
          subagentStatusCallback({
            sessionId: parentSessionId,
            status: "subagent_tool_done",
            subagentId,
            label,
            tool: name,
          });
        }
      },
      combinedSignal,
      subagentTools,
      agentModel,
    );

    clearTimeout(timeoutId);
    // Restore parent agent context
    setCallContext(parentSessionId, currentDepth, prevAgentId, prevProjectFolder);

    run.status = "completed";
    run.completedAt = new Date().toISOString();
    run.result = result.content?.slice(0, 5000);

    // Persist spawn completion to agent history
    if (parentSessionId) {
      appendAgentHistory(parentSessionId, "spawn.jsonl", {
        id: subagentId, label, status: "completed", completedAt: run.completedAt,
        result: run.result, toolCallCount: run.toolCalls.length,
      }).catch(() => {});
    }

    console.log(`[SubAgent:${label}] Completed. ${run.toolCalls.length} tool calls.`);

    // Broadcast completion
    if (subagentStatusCallback) {
      subagentStatusCallback({
        sessionId: parentSessionId,
        status: "subagent_done",
        subagentId,
        label,
      });
    }

    // Clean up after a delay
    setTimeout(() => activeSubagents.delete(subagentId), 60000);

    return {
      ok: true,
      subagentId,
      label,
      result: result.content,
      toolCalls: run.toolCalls,
      outputFiles: result.toolResults?.flatMap((tr: any) => tr.result?.outputFiles || []) || [],
    };
  } catch (err: any) {
    // Restore parent agent context
    setCallContext(parentSessionId, currentDepth, prevAgentId, prevProjectFolder);
    run.status = "error";
    run.completedAt = new Date().toISOString();

    // Persist spawn error to agent history
    if (parentSessionId) {
      appendAgentHistory(parentSessionId, "spawn.jsonl", {
        id: subagentId, label, status: "error", completedAt: run.completedAt,
        error: err.message,
      }).catch(() => {});
    }

    console.error(`[SubAgent:${label}] Error: ${err.message}`);

    if (subagentStatusCallback) {
      subagentStatusCallback({
        sessionId: parentSessionId,
        status: "subagent_error",
        subagentId,
        label,
        error: err.message,
      });
    }

    setTimeout(() => activeSubagents.delete(subagentId), 30000);

    return {
      ok: false,
      subagentId,
      label,
      error: err.name === "AbortError" ? "Sub-agent timed out" : err.message,
      toolCalls: run.toolCalls,
    };
  }
}

// ─── Realtime Agent System ───
// All agents from YAML boot at session start, stay alive, communicate via bus.

// --- Tool definitions for realtime mode ---

const sendTaskTool = {
  type: "function" as const,
  function: {
    name: "send_task",
    description: "Send a task to an agent in the realtime session. The agent is already alive and will process the task immediately. You can send tasks to multiple agents in one response for parallel execution.",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: "Target agent ID (e.g. 'agent_2')" },
        task: { type: "string", description: "Task description for the agent" },
        context: { type: "string", description: "Additional context or data" },
        wait: { type: "boolean", description: "If true, block until the agent finishes and return the result inline (default: false)" },
      },
      required: ["to", "task"],
    },
  },
};

const waitResultTool = {
  type: "function" as const,
  function: {
    name: "wait_result",
    description: "Wait for a result from an agent that was previously given a task via send_task. Blocks until the agent publishes its result.",
    parameters: {
      type: "object",
      properties: {
        from: { type: "string", description: "Agent ID to wait for result from" },
        timeout: { type: "number", description: "Max seconds to wait (default: uses session timeout)" },
      },
      required: ["from"],
    },
  },
};

const checkAgentsTool = {
  type: "function" as const,
  function: {
    name: "check_agents",
    description: "Check the status of all agents in the realtime session. Shows which agents are idle, working, or completed.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
};

// --- Realtime Session tracking ---

interface RealtimeAgentHandle {
  agentDef: AgentConfig;
  promise: Promise<void>;
  status: "idle" | "working" | "completed" | "error";
  lastTask?: string;
  lastResult?: string;
}

interface RealtimeSession {
  sessionId: string;
  agents: Map<string, RealtimeAgentHandle>;
  abortController: AbortController;
  systemConfig: AgentSystemConfig;
}

const realtimeSessions = new Map<string, RealtimeSession>();

export function getRealtimeSession(sessionId: string): RealtimeSession | undefined {
  return realtimeSessions.get(sessionId);
}

// --- Boot all agents ---

export async function startRealtimeSession(
  sessionId: string,
  configFile: string,
  signal?: AbortSignal,
): Promise<RealtimeSession | null> {
  const settings = await getSettings();
  const systemConfig = loadAgentConfig(configFile);
  if (!systemConfig) {
    console.error("[Realtime] Failed to load agent config:", configFile);
    return null;
  }

  // If session already exists, return it
  if (realtimeSessions.has(sessionId)) {
    return realtimeSessions.get(sessionId)!;
  }

  const abortController = new AbortController();
  // Link parent signal
  if (signal) {
    signal.addEventListener("abort", () => abortController.abort(), { once: true });
  }

  const session: RealtimeSession = {
    sessionId,
    agents: new Map(),
    abortController,
    systemConfig,
  };

  console.log(`[Realtime] Starting session ${sessionId} with ${systemConfig.agents.length} agents`);

  // Reload saved bus history from previous session runs (if any)
  const loadedCount = await busLoadHistory(sessionId);
  if (loadedCount > 0) {
    console.log(`[Realtime] Loaded ${loadedCount} saved bus messages for session ${sessionId}`);
  }

  // Boot each agent concurrently (skip human nodes — they are entry points)
  for (const agentDef of systemConfig.agents) {
    const handle: RealtimeAgentHandle = {
      agentDef,
      status: agentDef.role === "human" ? "idle" : "idle",
      promise: Promise.resolve(),
    };

    // Human nodes don't get an LLM loop — they represent the real user
    if (agentDef.role !== "human") {
      handle.promise = realtimeAgentLoop(
        agentDef,
        sessionId,
        systemConfig,
        abortController.signal,
        handle,
      );
    } else {
      // Start a listener loop for the human node that forwards agent results to the client
      handle.promise = humanNodeLoop(agentDef, sessionId, abortController.signal);
    }

    session.agents.set(agentDef.id, handle);

    // Broadcast agent ready
    if (subagentStatusCallback) {
      subagentStatusCallback({
        sessionId,
        status: "realtime_agent_ready",
        agentId: agentDef.id,
        label: agentDef.name,
        role: agentDef.role,
      });
    }
  }

  realtimeSessions.set(sessionId, session);
  console.log(`[Realtime] All ${systemConfig.agents.length} agents alive and listening`);
  return session;
}

// --- Shutdown ---

export function shutdownRealtimeSession(sessionId: string): void {
  const session = realtimeSessions.get(sessionId);
  if (!session) return;

  console.log(`[Realtime] Shutting down session ${sessionId}`);
  // Flush any buffered agent history before cleanup
  flushAgentHistory(sessionId).catch(() => {});
  session.abortController.abort();
  realtimeSessions.delete(sessionId);
  cleanupSessionProtocols(sessionId);
}

// --- Agent event loop ---

async function realtimeAgentLoop(
  agentDef: AgentConfig,
  sessionId: string,
  systemConfig: AgentSystemConfig,
  signal: AbortSignal,
  handle: RealtimeAgentHandle,
): Promise<void> {
  const agentId = agentDef.id;
  const settings = await getSettings();

  // Build system prompt from YAML
  let systemPrompt = getManualAgentPrompt(agentDef, systemConfig);
  systemPrompt += `\nYou are agent "${agentDef.name}" (ID: ${agentId}) in a REALTIME multi-agent session.`;
  systemPrompt += `\nYou receive tasks automatically. Complete each task using your tools — your result is sent back automatically when you finish.`;
  systemPrompt += `\nIMPORTANT: Do NOT use proto_tcp_send or proto_bus_publish to assign tasks to other agents. If you need to delegate, use send_task (if available). Protocol tools are only for exchanging data/status, NOT for task assignment.`;
  systemPrompt += `\nYour agent ID is "${agentId}".`;

  // Protocol instructions
  const agentProtoTools = getProtocolToolsForAgent(agentDef, systemConfig.connections, systemConfig);
  const protoNames = agentProtoTools.map((t: any) => t.function.name);
  if (protoNames.length > 0) {
    const protoLines: string[] = [];
    if (protoNames.some((n: string) => n.startsWith("proto_tcp"))) {
      protoLines.push("- TCP (proto_tcp_send / proto_tcp_read): Point-to-point messaging with a specific agent");
    }
    if (protoNames.some((n: string) => n.startsWith("proto_bus"))) {
      protoLines.push("- Bus (proto_bus_publish / proto_bus_history): Broadcast on the shared bus");
    }
    if (protoNames.some((n: string) => n.startsWith("proto_queue"))) {
      protoLines.push("- Queue (proto_queue_send / proto_queue_receive): FIFO messaging");
    }
    systemPrompt += `\n\nCOMMUNICATION PROTOCOLS:\n${protoLines.join("\n")}`;
  }

  // Build tool set: builtin tools + protocol tools
  const agentTools: any[] = [...builtinTools];
  if (settings.openRouterSearchEnabled && settings.openRouterSearchApiKey) {
    agentTools.push(openRouterSearchTool);
  }
  // If this agent has downstream connections, mesh enabled, or global mesh mode — give it send_task + wait_result
  const orchMode = systemConfig.system?.orchestration_mode;
  const isGlobalMesh = orchMode === "mesh";
  const isHybrid = orchMode === "hybrid";
  const agentMeshEnabled = agentDef.mesh?.enabled === true;
  const hasMesh = isGlobalMesh || agentMeshEnabled;

  const workflowStep = systemConfig.workflow?.sequence?.find((s: any) => s.agent === agentId);
  const outputsTo: string[] = workflowStep?.outputs_to || [];
  const connTargets = (systemConfig.connections || [])
    .filter((c: any) => c.from === agentId)
    .map((c: any) => c.to);
  const downstream = [...new Set([...outputsTo, ...connTargets])];

  const allPeers = (systemConfig.agents || [])
    .filter((a: AgentConfig) => a.id !== agentId && a.role !== "human")
    .map((a: AgentConfig) => a.id);

  const meshPeers = (systemConfig.agents || [])
    .filter((a: AgentConfig) => a.id !== agentId && a.role !== "human" && a.mesh?.enabled === true)
    .map((a: AgentConfig) => a.id);

  if (isHybrid && agentDef.role === "orchestrator") {
    // Hybrid orchestrator: controls flow via connections, monitors bus, can stop mesh agents
    agentTools.push(sendTaskTool, waitResultTool, checkAgentsTool);
    systemPrompt += `\n\nHYBRID MODE (ORCHESTRATOR): You control the team and coordinate all work.`;
    systemPrompt += `\nYour connected agents: ${downstream.join(", ")}`;
    if (meshPeers.length > 0) {
      systemPrompt += `\nMesh-enabled agents (can collaborate freely): ${meshPeers.join(", ")}`;
    }
    systemPrompt += `\nYou can see all bus messages to monitor agent activity.`;
    systemPrompt += `\nYou are responsible for:`;
    systemPrompt += `\n  1. Delegating tasks to your connected agents via send_task`;
    systemPrompt += `\n  2. Monitoring mesh agents' progress via check_agents and bus messages`;
    systemPrompt += `\n  3. Collecting results via wait_result and synthesizing the final output`;
    systemPrompt += `\n  4. Ensuring work completes — if mesh agents loop or stall, reassign the task or provide direction`;
    systemPrompt += `\nUse send_task({to: "agent_id", task: "..."}) then wait_result({from: "agent_id"}) to collect results.`;
    systemPrompt += `\nSend tasks to MULTIPLE agents in a SINGLE response for parallel execution.`;
  } else if (hasMesh) {
    // Mesh: agent can send tasks to any other agent
    agentTools.push(sendTaskTool, waitResultTool, checkAgentsTool);
    if (isHybrid) {
      systemPrompt += `\n\nHYBRID MESH AGENT: You can collaborate with any peer agent, but the orchestrator coordinates the overall task.`;
      systemPrompt += `\nAvailable peers: ${allPeers.join(", ")}`;
      systemPrompt += `\nIMPORTANT: When your work is done, send your result back to the agent that assigned you the task. Do NOT loop indefinitely — complete your part and report back.`;
    } else {
      systemPrompt += `\n\nMESH: You can send tasks to any agent using send_task and wait_result.`;
      systemPrompt += `\nAvailable agents: ${allPeers.join(", ")}`;
    }
    if (downstream.length > 0) {
      systemPrompt += `\nYour primary downstream agents: ${downstream.join(", ")}`;
    }
    systemPrompt += `\nUse send_task({to: "agent_id", task: "..."}) then wait_result({from: "agent_id"}) to collect results.`;
    systemPrompt += `\nSend tasks to MULTIPLE agents in a SINGLE response for parallel execution. Do NOT use proto_tcp_send or proto_bus_publish to assign tasks — use send_task instead.`;
  } else if (downstream.length > 0) {
    agentTools.push(sendTaskTool, waitResultTool, checkAgentsTool);
    systemPrompt += `\n\nDELEGATION: You can delegate tasks to downstream agents using send_task and wait_result.`;
    systemPrompt += `\nYour downstream agents: ${downstream.join(", ")}`;
    systemPrompt += `\nUse send_task({to: "agent_id", task: "..."}) then wait_result({from: "agent_id"}) to collect results.`;
    systemPrompt += `\nSend tasks to MULTIPLE agents in a SINGLE response for parallel execution. Do NOT use proto_tcp_send or proto_bus_publish to assign tasks — use send_task instead.`;
  }
  agentTools.push(...agentProtoTools);
  const finalTools = [...agentTools, ...getMcpTools()];

  console.log(`[Realtime:${agentDef.name}] Agent loop started, waiting for tasks...`);

  // Event loop: wait for task → execute → publish result → repeat
  while (!signal.aborted) {
    try {
      handle.status = "idle";

      // Wait for a task message on bus topic "task:{agentId}"
      const msg = await busWaitForMessage(sessionId, `task:${agentId}`, 0, signal);

      handle.status = "working";
      const taskText = msg.payload?.task || "(no task)";
      handle.lastTask = taskText;

      console.log(`[Realtime:${agentDef.name}] Received task: ${taskText.slice(0, 200)}`);

      if (subagentStatusCallback) {
        subagentStatusCallback({
          sessionId,
          status: "realtime_agent_working",
          agentId,
          label: agentDef.name,
          task: taskText.slice(0, 200),
        });
      }

      // Set call context so protocol tools know who we are — preserve project folder
      const prevAgentId = _currentAgentId;
      const prevProjectFolder = _currentProjectWorkingFolder;
      setCallContext(sessionId, 0, agentId, _currentProjectWorkingFolder);

      // Get the tool-calling function
      const callAgent = await getSubagentCaller();

      // Run LLM tool loop for this task
      const taskPrompt = `${systemPrompt}\n\nYOUR TASK:\n${msg.payload.task}${msg.payload.context ? `\n\nADDITIONAL CONTEXT:\n${msg.payload.context}` : ""}`;

      // Use agent-specific model from YAML definition if set
      const realtimeAgentModel = agentDef.model || undefined;

      const result = await callAgent(
        [{ role: "user" as const, content: msg.payload.task }],
        taskPrompt,
        (name: string, toolArgs: any) => {
          console.log(`[Realtime:${agentDef.name}] Tool: ${name}`);
          if (subagentStatusCallback) {
            subagentStatusCallback({
              sessionId,
              status: "realtime_agent_tool",
              agentId,
              label: agentDef.name,
              tool: name,
            });
          }
        },
        (name: string, toolResult: any) => {
          if (subagentStatusCallback) {
            subagentStatusCallback({
              sessionId,
              status: "realtime_agent_tool_done",
              agentId,
              label: agentDef.name,
              tool: name,
            });
          }
        },
        signal,
        finalTools,
        realtimeAgentModel,
      );

      // Restore context
      setCallContext(sessionId, 0, prevAgentId, prevProjectFolder);

      const resultContent = result.content || "(no result)";
      handle.lastResult = resultContent.slice(0, 5000);
      handle.status = "idle";

      console.log(`[Realtime:${agentDef.name}] Task completed. Result: ${resultContent.slice(0, 200)}`);

      // Publish result to bus
      busPublish(sessionId, agentId, `result:${agentId}`, {
        result: resultContent,
        outputFiles: result.toolResults?.flatMap((tr: any) => tr.result?.outputFiles || []),
      });

      if (subagentStatusCallback) {
        subagentStatusCallback({
          sessionId,
          status: "realtime_agent_done",
          agentId,
          label: agentDef.name,
        });
      }

    } catch (err: any) {
      if (err.message === "aborted" || signal.aborted) {
        console.log(`[Realtime:${agentDef.name}] Agent loop ended (shutdown)`);
        break;
      }
      console.error(`[Realtime:${agentDef.name}] Error:`, err.message);
      handle.status = "error";
      // Keep the agent alive — publish error and continue
      busPublish(sessionId, agentId, `error:${agentId}`, { error: err.message });
    }
  }

  handle.status = "completed";
  console.log(`[Realtime:${agentDef.name}] Agent exited`);
}

// --- Human node loop: listens for tasks sent to the human node and forwards to client ---

async function humanNodeLoop(
  agentDef: AgentConfig,
  sessionId: string,
  signal: AbortSignal,
): Promise<void> {
  const agentId = agentDef.id;
  console.log(`[Realtime:Human] Human node "${agentId}" listening for agent outputs...`);

  while (!signal.aborted) {
    try {
      // Wait for any agent to send a task/result to the human node
      const msg = await busWaitForMessage(sessionId, `task:${agentId}`, 0, signal);

      const fromAgent = msg.payload?.from || "unknown";
      const content = msg.payload?.task || msg.payload?.result || "(no content)";

      console.log(`[Realtime:Human] Received from ${fromAgent}: ${content.slice(0, 200)}`);

      // Forward to client via status callback
      if (subagentStatusCallback) {
        subagentStatusCallback({
          sessionId,
          status: "human_node_message",
          agentId: fromAgent,
          label: fromAgent,
          content,
        });
      }
    } catch (err: any) {
      if (err.message === "aborted" || signal.aborted) break;
      console.error(`[Realtime:Human] Error:`, err.message);
    }
  }
  console.log(`[Realtime:Human] Human node "${agentId}" exited`);
}

// --- Human node helpers ---

/** Get agent IDs that the human node is directly connected to */
export function getHumanConnectedAgents(sessionId: string): string[] {
  const session = realtimeSessions.get(sessionId);
  if (!session) return [];

  const humanNode = session.systemConfig.agents?.find((a: AgentConfig) => a.role === "human");
  if (!humanNode) return [];

  const allNonHuman = Array.from(session.agents.entries())
    .filter(([, h]) => h.agentDef.role !== "human")
    .map(([id]) => id);

  // Global mesh mode OR human node has mesh.enabled: can talk to all agents
  const isGlobalMesh = session.systemConfig.system?.orchestration_mode === "mesh";
  const humanHasMesh = humanNode.mesh?.enabled === true;
  if (isGlobalMesh || humanHasMesh) {
    return allNonHuman;
  }

  // Get agents connected FROM the human node
  const connTargets = (session.systemConfig.connections || [])
    .filter((c: any) => c.from === humanNode.id)
    .map((c: any) => c.to);

  // Also include agents connected TO the human node (bidirectional)
  const connSources = (session.systemConfig.connections || [])
    .filter((c: any) => c.to === humanNode.id)
    .map((c: any) => c.from);

  // Also include any agent that has mesh.enabled (they accept tasks from anyone)
  const meshAgents = allNonHuman.filter((id) => {
    const agentDef = session.systemConfig.agents?.find((a: AgentConfig) => a.id === id);
    return agentDef?.mesh?.enabled === true;
  });

  return [...new Set([...connTargets, ...connSources, ...meshAgents])].filter(
    (id) => session.agents.has(id) && session.agents.get(id)!.agentDef.role !== "human"
  );
}

/** Send a task from the human to a specific agent */
export function humanSendToAgent(sessionId: string, targetAgentId: string, task: string, context?: string): { ok: boolean; error?: string } {
  const session = realtimeSessions.get(sessionId);
  if (!session) return { ok: false, error: "No realtime session active." };

  const targetAgent = session.agents.get(targetAgentId);
  if (!targetAgent) {
    const available = Array.from(session.agents.keys()).join(", ");
    return { ok: false, error: `Agent "${targetAgentId}" not found. Available: ${available}` };
  }

  // Verify human is connected to this agent
  // Skip check if: global mesh, human has mesh.enabled, or target agent has mesh.enabled
  const isGlobalMesh = session.systemConfig.system?.orchestration_mode === "mesh";
  const humanNode = session.systemConfig.agents?.find((a: AgentConfig) => a.role === "human");
  const humanHasMesh = humanNode?.mesh?.enabled === true;
  const targetHasMesh = targetAgent.agentDef.mesh?.enabled === true;

  if (!isGlobalMesh && !humanHasMesh && !targetHasMesh) {
    const humanConnected = getHumanConnectedAgents(sessionId);
    if (humanConnected.length > 0 && !humanConnected.includes(targetAgentId)) {
      return { ok: false, error: `You can only talk to agents connected to the human node: ${humanConnected.join(", ")}` };
    }
  }

  // Publish task to the agent's bus topic
  const humanNodeForPublish = humanNode || session.systemConfig.agents?.find((a: AgentConfig) => a.role === "human");
  busPublish(sessionId, humanNodeForPublish?.id || "human", `task:${targetAgentId}`, {
    task,
    context,
    from: humanNodeForPublish?.id || "human",
  });

  console.log(`[Realtime:Human] Human → ${targetAgentId}: ${task.slice(0, 100)}`);
  return { ok: true };
}

/** Send a task from human to ALL connected agents (broadcast) */
export function humanBroadcastToAgents(sessionId: string, task: string, context?: string): { ok: boolean; sent: string[]; errors: string[] } {
  const connectedAgents = getHumanConnectedAgents(sessionId);
  if (connectedAgents.length === 0) {
    return { ok: false, sent: [], errors: ["No agents connected to the human node"] };
  }

  const sent: string[] = [];
  const errors: string[] = [];

  for (const agentId of connectedAgents) {
    const result = humanSendToAgent(sessionId, agentId, task, context);
    if (result.ok) {
      sent.push(agentId);
    } else {
      errors.push(`${agentId}: ${result.error}`);
    }
  }

  return { ok: sent.length > 0, sent, errors };
}

/** Wait for a result from a specific agent (called by human) */
export async function humanWaitForAgent(sessionId: string, agentId: string, timeoutMs: number = 120000, signal?: AbortSignal): Promise<{ ok: boolean; result?: string; error?: string }> {
  try {
    const resultMsg = await busWaitForMessage(sessionId, `result:${agentId}`, timeoutMs, signal);
    return {
      ok: true,
      result: resultMsg.payload?.result || "(no result)",
    };
  } catch (err: any) {
    return { ok: false, error: `Timeout waiting for ${agentId}: ${err.message}` };
  }
}

// --- Realtime tool implementations ---

async function realtimeSendTask(args: { to: string; task: string; context?: string; wait?: boolean }, signal?: AbortSignal): Promise<any> {
  const sessionId = _currentParentSessionId || "default";
  const session = realtimeSessions.get(sessionId);
  if (!session) {
    return { ok: false, error: "No realtime session active." };
  }

  const targetAgent = session.agents.get(args.to);
  if (!targetAgent) {
    const available = Array.from(session.agents.keys()).join(", ");
    return { ok: false, error: `Agent "${args.to}" not found. Available: ${available}` };
  }

  // Validate caller is allowed to send to target
  const callerId = _currentAgentId;
  if (callerId === "main") {
    // Main LLM must respect hierarchy — if there's an orchestrator, only send to it
    const orchestrator = session.systemConfig.agents?.find((a: AgentConfig) => a.role === "orchestrator");
    if (orchestrator && args.to !== orchestrator.id) {
      return { ok: false, error: `You must send tasks to the orchestrator agent "${orchestrator.id}" ("${orchestrator.name}") only. The orchestrator will delegate to other agents.` };
    }
  } else {
    const callerDef = session.systemConfig.agents?.find((a: AgentConfig) => a.id === callerId);
    const callerHasMesh = callerDef?.mesh?.enabled === true;
    const globalMesh = session.systemConfig.system?.orchestration_mode === "mesh";
    const isHybridOrch = session.systemConfig.system?.orchestration_mode === "hybrid" && callerDef?.role === "orchestrator";

    if (!callerHasMesh && !globalMesh && !isHybridOrch) {
      // Strict access control via connections
      const callerStep = session.systemConfig.workflow?.sequence?.find((s: any) => s.agent === callerId);
      const allowedTargets: string[] = callerStep?.outputs_to || [];
      const connTargets = (session.systemConfig.connections || [])
        .filter((c: any) => c.from === callerId)
        .map((c: any) => c.to);
      const allAllowed = [...new Set([...allowedTargets, ...connTargets])];

      if (allAllowed.length > 0 && !allAllowed.includes(args.to)) {
        return { ok: false, error: `Agent "${callerId}" is not connected to "${args.to}". Allowed targets: ${allAllowed.join(", ")}` };
      }
    }
  }

  // If target is a human node, route output to client via callback (not LLM loop)
  if (targetAgent.agentDef.role === "human") {
    console.log(`[Realtime] ${_currentAgentId} → send_task → HUMAN (${args.to}): ${args.task.slice(0, 100)}`);
    if (subagentStatusCallback) {
      subagentStatusCallback({
        sessionId,
        status: "human_node_message",
        agentId: _currentAgentId,
        label: session.agents.get(_currentAgentId)?.agentDef.name || _currentAgentId,
        content: args.task,
      });
    }
    return {
      ok: true,
      agentId: args.to,
      agentName: targetAgent.agentDef.name,
      sent: true,
      note: `Output sent to human user.`,
    };
  }

  // Publish task to the agent's bus topic
  busPublish(sessionId, _currentAgentId, `task:${args.to}`, {
    task: args.task,
    context: args.context,
    from: _currentAgentId,
  });

  console.log(`[Realtime] ${_currentAgentId} → send_task → ${args.to}: ${args.task.slice(0, 100)}`);

  // If wait=true, block until the agent publishes its result
  if (args.wait) {
    try {
      const settings = await getSettings();
      const timeout = (args as any).timeout || (settings.subAgentTimeout || 120);
      const resultMsg = await busWaitForMessage(sessionId, `result:${args.to}`, timeout * 1000, signal);
      return {
        ok: true,
        agentId: args.to,
        agentName: targetAgent.agentDef.name,
        result: resultMsg.payload?.result || "(no result)",
        outputFiles: resultMsg.payload?.outputFiles || [],
      };
    } catch (err: any) {
      return { ok: false, error: `Timeout waiting for ${args.to}: ${err.message}` };
    }
  }

  return {
    ok: true,
    agentId: args.to,
    agentName: targetAgent.agentDef.name,
    sent: true,
    note: `Task sent to ${targetAgent.agentDef.name}. Use wait_result({from: "${args.to}"}) to collect the result.`,
  };
}

async function realtimeWaitResult(args: { from: string; timeout?: number }, signal?: AbortSignal): Promise<any> {
  const sessionId = _currentParentSessionId || "default";
  const session = realtimeSessions.get(sessionId);
  if (!session) {
    return { ok: false, error: "No realtime session active." };
  }

  const targetAgent = session.agents.get(args.from);
  if (!targetAgent) {
    return { ok: false, error: `Agent "${args.from}" not found in session.` };
  }

  // If agent already has a result cached and is idle, return it immediately
  if (targetAgent.status === "idle" && targetAgent.lastResult) {
    const result = targetAgent.lastResult;
    targetAgent.lastResult = undefined; // consume it
    return {
      ok: true,
      agentId: args.from,
      agentName: targetAgent.agentDef.name,
      result,
    };
  }

  // Otherwise wait for the bus message
  try {
    const settings = await getSettings();
    const timeout = (args.timeout || settings.subAgentTimeout || 120) * 1000;
    const resultMsg = await busWaitForMessage(sessionId, `result:${args.from}`, timeout, signal);
    return {
      ok: true,
      agentId: args.from,
      agentName: targetAgent.agentDef.name,
      result: resultMsg.payload?.result || "(no result)",
      outputFiles: resultMsg.payload?.outputFiles || [],
    };
  } catch (err: any) {
    return { ok: false, error: `Timeout waiting for result from ${args.from}: ${err.message}` };
  }
}

function realtimeCheckAgents(): any {
  const sessionId = _currentParentSessionId || "default";
  const session = realtimeSessions.get(sessionId);
  if (!session) {
    return { ok: false, error: "No realtime session active." };
  }

  const agents = Array.from(session.agents.entries()).map(([id, handle]) => ({
    id,
    name: handle.agentDef.name,
    role: handle.agentDef.role,
    status: handle.status,
    lastTask: handle.lastTask?.slice(0, 100),
  }));

  return { ok: true, agents, total: agents.length };
}

// --- Get tools for realtime orchestrator ---

export async function getToolsForRealtimeOrchestrator(): Promise<any[]> {
  const settings = await getSettings();
  const tools: any[] = [...builtinTools];
  if (settings.openRouterSearchEnabled && settings.openRouterSearchApiKey) {
    tools.push(openRouterSearchTool);
  }
  // Realtime tools instead of spawn_subagent
  tools.push(sendTaskTool, waitResultTool, checkAgentsTool);
  // Protocol tools for direct orchestrator communication
  tools.push(...protocolTools);
  return [...tools, ...getMcpTools()];
}

// --- Config summary for realtime mode ---

export async function getRealtimeAgentConfigSummary(): Promise<string | null> {
  const settings = await getSettings();
  if (settings.subAgentMode !== "realtime" || !settings.subAgentConfigFile) return null;
  const config = loadAgentConfig(settings.subAgentConfigFile);
  if (!config) return null;

  // Find the orchestrator agent (role === "orchestrator")
  const orchestrator = config.agents?.find((a: AgentConfig) => a.role === "orchestrator");

  let summary = `\n\nREALTIME AGENT SESSION (${config.system?.name || "Unnamed"}):\n`;
  summary += `All agents are ALREADY ALIVE and listening for tasks.\n\n`;

  const isHybrid = config.system?.orchestration_mode === "hybrid";
  if (orchestrator) {
    summary += `ORCHESTRATOR AGENT: ${orchestrator.id} ("${orchestrator.name}")\n`;
    summary += `You MUST send ALL tasks to the orchestrator agent ONLY. The orchestrator will coordinate and delegate to the team.\n`;
    summary += `Do NOT send tasks directly to worker agents — that is the orchestrator's job.\n`;
    if (isHybrid) {
      const meshAgents = (config.agents || []).filter((a: AgentConfig) => a.mesh?.enabled && a.role !== "human");
      summary += `\nHYBRID MODE: The orchestrator controls task flow via connections. Mesh-enabled agents (${meshAgents.map(a => a.id).join(", ")}) can collaborate freely with each other.\n`;
      summary += `The orchestrator monitors bus traffic and ensures work completes without infinite loops.\n`;
    }
    summary += `\n`;
  }

  // Note human node
  const humanNode = config.agents?.find((a: AgentConfig) => a.role === "human");
  if (humanNode) {
    summary += `HUMAN NODE: "${humanNode.id}" — the user interacts via this entry point.\n`;
    summary += `Agents connected to the human node can receive tasks directly from the user and send results back.\n\n`;
  }

  summary += `Agent team:\n`;
  for (const a of config.agents || []) {
    if (a.role === "human") {
      summary += `  - ${a.id} ("${a.name}"): role=human (user entry point)\n`;
      continue;
    }
    const flags = [
      a.bus?.enabled ? "bus" : "",
      a.mesh?.enabled ? "mesh" : "",
    ].filter(Boolean).join(", ");
    summary += `  - ${a.id} ("${a.name}"): role=${a.role}${flags ? ` [${flags}]` : ""}, persona=${a.persona || "N/A"}\n`;
    if (a.responsibilities && a.responsibilities.length > 0) {
      summary += `    responsibilities: ${a.responsibilities.join("; ")}\n`;
    }
  }

  if (config.workflow?.sequence && config.workflow.sequence.length > 0) {
    summary += `\nWORKFLOW SEQUENCE:\n`;
    for (const step of config.workflow.sequence) {
      const agent = config.agents?.find((a: AgentConfig) => a.id === step.agent);
      const agentName = agent ? `${agent.name} (${agent.role})` : step.agent;
      const outputsTo = step.outputs_to ? ` → outputs to: ${step.outputs_to.join(", ")}` : "";
      summary += `  Step ${step.step}: ${step.agent} [${agentName}] — ${step.action}${outputsTo}\n`;
    }
  }

  if (config.connections && config.connections.length > 0) {
    summary += `\nCONNECTIONS:\n`;
    for (const c of config.connections) {
      summary += `  ${c.from} → ${c.to} (${c.protocol})\n`;
    }
  }

  summary += `\nINSTRUCTIONS:\n`;
  if (orchestrator) {
    summary += `- Send the FULL task to the orchestrator: send_task({to: "${orchestrator.id}", task: "..."})\n`;
    summary += `- Then wait for the orchestrator's result: wait_result({from: "${orchestrator.id}"})\n`;
    summary += `- The orchestrator will manage all sub-delegation to worker/checker agents internally\n`;
    summary += `- Do NOT send tasks to other agents directly — respect the hierarchy\n`;
  } else {
    summary += `- Use send_task({to: "agent_id", task: "..."}) to assign work to agents\n`;
    summary += `- Use wait_result({from: "agent_id"}) to collect the result\n`;
    summary += `- Send tasks to MULTIPLE agents in a single response for parallel execution\n`;
  }
  summary += `- Use check_agents() to see agent statuses\n`;
  return summary;
}

// --- Dispatcher ---

// Track parent session ID, depth, agent ID, and project working folder for context
let _currentParentSessionId: string | undefined;
let _currentSubagentDepth: number = 0;
let _currentAgentId: string = "main";
let _currentProjectWorkingFolder: string | undefined;

export function setCallContext(sessionId?: string, depth?: number, agentId?: string, projectWorkingFolder?: string) {
  _currentParentSessionId = sessionId;
  _currentSubagentDepth = depth || 0;
  _currentAgentId = agentId || "main";
  _currentProjectWorkingFolder = projectWorkingFolder;
}

export async function callTool(name: string, args: any, signal?: AbortSignal): Promise<any> {
  switch (name) {
    case "web_search": return webSearch(args);
    case "openrouter_web_search": return openRouterWebSearch(args);
    case "fetch_url": return fetchUrl(args);
    case "run_python": return runPythonTool(args);
    case "run_react": return runReactTool(args);
    case "run_shell": return runShell(args);
    case "read_file": return readFileTool(args);
    case "write_file": return writeFileTool(args);
    case "list_files": return listFilesTool(args);
    case "list_skills": return listSkillsTool();
    case "load_skill": return loadSkillTool(args);
    case "clawhub_search": return clawhubSearchTool(args);
    case "clawhub_install": return clawhubInstallTool(args);
    case "spawn_subagent": return spawnSubagent(args, _currentParentSessionId, _currentSubagentDepth);

    // ─── Realtime Agent Tools ───
    case "send_task": return realtimeSendTask(args, signal);
    case "wait_result": return realtimeWaitResult(args, signal);
    case "check_agents": return realtimeCheckAgents();

    // ─── Protocol Tools ───
    case "proto_tcp_send": {
      const sessionId = _currentParentSessionId || "default";
      const from = _currentAgentId;
      await tcpOpen(from, args.to, sessionId);
      const sent = await tcpSend(from, args.to, args.topic, args.payload);
      return { ok: sent, protocol: "tcp", from, to: args.to, topic: args.topic };
    }
    case "proto_tcp_read": {
      const from = _currentAgentId;
      const messages = tcpRead(from, args.peer);
      return { ok: true, protocol: "tcp", peer: args.peer, messages, count: messages.length };
    }
    case "proto_bus_publish": {
      const sessionId = _currentParentSessionId || "default";
      busPublish(sessionId, _currentAgentId, args.topic, args.payload);
      return { ok: true, protocol: "bus", from: _currentAgentId, topic: args.topic };
    }
    case "proto_bus_history": {
      const sessionId = _currentParentSessionId || "default";
      const messages = busHistory(sessionId, args.topic);
      return { ok: true, protocol: "bus", topic: args.topic || "all", messages, count: messages.length };
    }
    case "proto_queue_send": {
      const sessionId = _currentParentSessionId || "default";
      const depth = queueEnqueue(_currentAgentId, args.to, args.topic, args.payload, sessionId);
      return { ok: true, protocol: "queue", from: _currentAgentId, to: args.to, topic: args.topic, queueDepth: depth };
    }
    case "proto_queue_receive": {
      const msg = queueDequeue(args.from, _currentAgentId, args.topic);
      return msg
        ? { ok: true, protocol: "queue", message: msg }
        : { ok: true, protocol: "queue", message: null, note: "Queue empty" };
    }
    case "proto_queue_peek": {
      const messages = queuePeek(args.from, _currentAgentId, args.topic, args.count || 5);
      return { ok: true, protocol: "queue", messages, count: messages.length };
    }

    default:
      // Route MCP tools to MCP client
      if (isMcpTool(name)) return callMcpTool(name, args);
      return { ok: false, error: `Unknown tool: ${name}` };
  }
}
