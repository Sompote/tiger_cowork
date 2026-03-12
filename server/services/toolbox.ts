import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { runPython } from "./python";
import { getSettings } from "./data";
import { getMcpTools, callMcpTool, isMcpTool } from "./mcp";


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
          code: { type: "string", description: "React JSX component code. Should export or define a default component. Can use hooks, state, etc." },
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
      },
      required: ["task"],
    },
  },
};

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

// Dynamic tools getter: built-in + MCP tools + conditional OpenRouter search + sub-agent
export function getTools(opts?: { excludeSubagent?: boolean }) {
  const settings = getSettings();
  const tools: any[] = [...builtinTools];
  if (settings.openRouterSearchEnabled && settings.openRouterSearchApiKey) {
    tools.push(openRouterSearchTool);
  }
  if (settings.subAgentEnabled && !opts?.excludeSubagent) {
    tools.push(spawnSubagentTool);
  }
  return [...tools, ...getMcpTools()];
}

// Get tools for sub-agents (no spawn_subagent to prevent infinite recursion at max depth)
export function getToolsForSubagent(currentDepth: number): ReturnType<typeof getTools> {
  const settings = getSettings();
  const maxDepth = settings.subAgentMaxDepth || 2;
  // Sub-agents can spawn their own sub-agents if not at max depth
  return getTools({ excludeSubagent: currentDepth >= maxDepth });
}

// Keep backward-compat export (static reference for imports that use `tools`)
export const tools = builtinTools;

// --- Tool implementations ---

async function webSearch(args: { query: string }): Promise<any> {
  const settings = getSettings();
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
  const settings = getSettings();
  const sandboxDir = settings.sandboxDir || path.resolve("sandbox");
  const result = await runPython(args.code, sandboxDir, 60000);
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.slice(0, 20000),
    stderr: result.stderr.slice(0, 5000),
    outputFiles: result.outputFiles,
  };
}

async function runReactTool(args: { code: string; title?: string; dependencies?: string[] }): Promise<any> {
  const settings = getSettings();
  const sandboxDir = settings.sandboxDir || path.resolve("sandbox");
  const outputDir = path.join(sandboxDir, "output_file");
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
    const relPath = `output_file/${filename}`;
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
  const settings = getSettings();
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

function writeFileTool(args: { path: string; content: string; append?: boolean }): any {
  const settings = getSettings();
  const sandboxDir = settings.sandboxDir || path.resolve("sandbox");
  const outputDir = path.join(sandboxDir, "output_file");
  const target = path.resolve(outputDir, args.path);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (args.append) {
    fs.appendFileSync(target, args.content, "utf8");
  } else {
    fs.writeFileSync(target, args.content, "utf8");
  }
  // Return outputFiles so the file appears in the output panel
  const ext = path.extname(args.path).toLowerCase();
  const outputExts = [".pdf", ".docx", ".doc", ".xlsx", ".csv", ".png", ".jpg", ".jpeg", ".svg", ".html", ".gif", ".webp"];
  const relPath = path.relative(sandboxDir, target);
  const outputFiles = outputExts.includes(ext) ? [relPath] : [];
  return { ok: true, path: target, bytes: Buffer.byteLength(args.content), outputFiles };
}

function listFilesTool(args: { path?: string; recursive?: boolean }): any {
  const settings = getSettings();
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
  const settings = getSettings();
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
  args: { task: string; label?: string; context?: string },
  parentSessionId?: string,
  currentDepth: number = 0,
  signal?: AbortSignal,
): Promise<any> {
  const settings = getSettings();
  if (!settings.subAgentEnabled) {
    return { ok: false, error: "Sub-agents are disabled. Enable them in Settings > Sub-Agent." };
  }

  const maxDepth = settings.subAgentMaxDepth || 2;
  if (currentDepth >= maxDepth) {
    return { ok: false, error: `Sub-agent depth limit reached (max ${maxDepth}). Cannot spawn deeper.` };
  }

  // Check concurrent limit
  const maxConcurrent = settings.subAgentMaxConcurrent || 3;
  const runningCount = Array.from(activeSubagents.values()).filter(s => s.status === "running").length;
  if (runningCount >= maxConcurrent) {
    return { ok: false, error: `Too many concurrent sub-agents (${runningCount}/${maxConcurrent}). Wait for one to finish.` };
  }

  const subagentId = `subagent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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

  // Build sub-agent system prompt
  const subModel = settings.subAgentModel || undefined; // use default model if not set
  const subPrompt = `You are a focused sub-agent. You have been spawned by a parent agent to complete a specific task.

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

  try {
    const callAgent = await getSubagentCaller();

    // Create abort with timeout
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), timeout);

    // Combine parent signal and timeout
    const combinedSignal = signal && typeof (AbortSignal as any).any === "function"
      ? (AbortSignal as any).any([signal, timeoutController.signal])
      : timeoutController.signal;

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
    );

    clearTimeout(timeoutId);

    run.status = "completed";
    run.completedAt = new Date().toISOString();
    run.result = result.content?.slice(0, 5000);

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
    run.status = "error";
    run.completedAt = new Date().toISOString();

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

// --- Dispatcher ---

// Track parent session ID and depth for sub-agent context
let _currentParentSessionId: string | undefined;
let _currentSubagentDepth: number = 0;

export function setCallContext(sessionId?: string, depth?: number) {
  _currentParentSessionId = sessionId;
  _currentSubagentDepth = depth || 0;
}

export async function callTool(name: string, args: any): Promise<any> {
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
    default:
      // Route MCP tools to MCP client
      if (isMcpTool(name)) return callMcpTool(name, args);
      return { ok: false, error: `Unknown tool: ${name}` };
  }
}
