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
      description: "Execute React/JSX code by generating an HTML file with inline React. The component will be rendered in the output panel. Returns the generated HTML file path.",
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

// Dynamic tools getter: built-in + MCP tools
export function getTools() {
  return [...builtinTools, ...getMcpTools()];
}

// Keep backward-compat export (static reference for imports that use `tools`)
export const tools = builtinTools;

// --- Tool implementations ---

async function webSearch(args: { query: string }): Promise<any> {
  const settings = getSettings();
  const query = args.query;
  const results: any[] = [];

  // Try DuckDuckGo Instant Answer API
  try {
    const ddgRes = await fetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`
    );
    const ddg = await ddgRes.json();

    if (ddg.Abstract) {
      results.push({ source: "abstract", title: ddg.Heading, text: ddg.Abstract, url: ddg.AbstractURL });
    }
    for (const topic of (ddg.RelatedTopics || []).slice(0, 8)) {
      if (topic.Text) {
        results.push({ source: "related", text: topic.Text, url: topic.FirstURL });
      }
    }
  } catch {}

  // Also try DuckDuckGo HTML search for better results
  try {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: { "User-Agent": "TigerCowork/1.0 (Web Search Bot)" },
    });
    const html = await res.text();
    // Extract result links and snippets
    const resultBlocks = [...html.matchAll(/<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)];
    for (const m of resultBlocks.slice(0, 8)) {
      results.push({
        source: "web",
        url: m[1],
        title: m[2].replace(/<[^>]+>/g, "").trim(),
        text: m[3].replace(/<[^>]+>/g, "").trim(),
      });
    }
  } catch {}

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
  const filename = `react_${Date.now()}.html`;
  const filePath = path.join(outputDir, filename);

  // Map common library names to CDN URLs
  const cdnMap: Record<string, string> = {
    recharts: "https://unpkg.com/recharts@2.12.7/umd/Recharts.js",
    "chart.js": "https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js",
    lodash: "https://unpkg.com/lodash@4.17.21/lodash.min.js",
    dayjs: "https://unpkg.com/dayjs@1.11.13/dayjs.min.js",
    axios: "https://unpkg.com/axios@1.7.7/dist/axios.min.js",
    "tailwindcss": "https://cdn.tailwindcss.com",
  };

  const extraScripts = (args.dependencies || [])
    .map((dep) => {
      const url = cdnMap[dep.toLowerCase()] || dep;
      return `<script src="${url}"></script>`;
    })
    .join("\n    ");

  // Clean up AI-generated code: strip import/export statements that break UMD context
  let code = args.code || "";

  // Remove import statements (React/ReactDOM/libs are loaded via UMD globals)
  code = code.replace(/^\s*import\s+.*?\s+from\s+['"][^'"]+['"];?\s*$/gm, "");
  code = code.replace(/^\s*import\s+['"][^'"]+['"];?\s*$/gm, "");

  // Convert "export default ComponentName" to just capture the name
  let exportedComponent = "";
  const exportDefaultMatch = code.match(/export\s+default\s+(\w+)\s*;?/);
  if (exportDefaultMatch) {
    exportedComponent = exportDefaultMatch[1];
  }
  // Convert "export default function ComponentName" to just "function ComponentName"
  const exportDefaultFuncMatch = code.match(/export\s+default\s+function\s+(\w+)/);
  if (exportDefaultFuncMatch) {
    exportedComponent = exportDefaultFuncMatch[1];
  }
  code = code.replace(/export\s+default\s+(function|class)\s+/g, "$1 ");
  code = code.replace(/^\s*export\s+default\s+\w+\s*;?\s*$/gm, "");
  code = code.replace(/^\s*export\s+/gm, "");

  // Detect component names defined in the code (function/const declarations that start with uppercase)
  const componentMatches = code.match(/(?:function|const|class)\s+([A-Z]\w+)/g) || [];
  const componentNames = componentMatches.map((m) => m.replace(/^(?:function|const|class)\s+/, ""));

  // Determine which component to render
  const renderTarget = exportedComponent
    || componentNames.find((n) => n === "App")
    || componentNames[componentNames.length - 1]
    || "";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${args.title || "React Preview"}</title>
    <script src="https://unpkg.com/react@18/umd/react.development.js"></script>
    <script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
    <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
    ${extraScripts}
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
      #root { min-height: 100vh; }
      .react-error { color: #e53935; padding: 20px; font-family: monospace; white-space: pre-wrap; }
    </style>
</head>
<body>
    <div id="root"></div>
    <script type="text/babel">
      // React hooks & helpers
      const { useState, useEffect, useRef, useMemo, useCallback, useReducer, useContext, createContext, Fragment } = React;

      // Expose Recharts components as globals if loaded
      if (typeof Recharts !== 'undefined') {
        Object.keys(Recharts).forEach(function(k) { window[k] = Recharts[k]; });
      }

      try {
        ${code}

        // Render the component
        ${renderTarget ? `ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(${renderTarget}));` : "// No component detected"}
      } catch (err) {
        document.getElementById('root').innerHTML = '<div class=\"react-error\">Error: ' + err.message + '</div>';
        console.error(err);
      }
    </script>
</body>
</html>`;

  try {
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(filePath, html, "utf8");
    const relPath = `output_file/${filename}`;
    return {
      ok: true,
      outputFiles: [relPath],
      message: `React app saved to ${relPath}. It will be rendered in the output panel.`,
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
  return { ok: true, path: target, bytes: Buffer.byteLength(args.content) };
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

function listSkillsTool(): any {
  const clawhubSkills: string[] = [];
  if (fs.existsSync(SKILLS_DIR)) {
    const dirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
    for (const d of dirs) {
      if (d.isDirectory() && fs.existsSync(path.join(SKILLS_DIR, d.name, "SKILL.md"))) {
        clawhubSkills.push(d.name);
      }
    }
  }

  // Also get skills from data/skills.json
  const dataSkills = getSettings();  // just to check
  let builtinSkills: string[] = [];
  try {
    const skillsFile = path.resolve("data/skills.json");
    if (fs.existsSync(skillsFile)) {
      const skills = JSON.parse(fs.readFileSync(skillsFile, "utf8"));
      builtinSkills = skills.filter((s: any) => s.enabled).map((s: any) => s.name);
    }
  } catch {}

  return {
    clawhub_skills: clawhubSkills,
    builtin_skills: builtinSkills,
    skills_dir: SKILLS_DIR,
    hint: "Use load_skill with a clawhub skill name to see its SKILL.md with usage instructions.",
  };
}

function loadSkillTool(args: { skill: string }): any {
  const skillName = args.skill.trim();
  if (!skillName) return { ok: false, error: "Missing skill name" };

  const skillFile = path.join(SKILLS_DIR, skillName, "SKILL.md");
  if (fs.existsSync(skillFile)) {
    const content = fs.readFileSync(skillFile, "utf8");
    // Also check for _meta.json
    let meta: any = {};
    const metaFile = path.join(SKILLS_DIR, skillName, "_meta.json");
    if (fs.existsSync(metaFile)) {
      try { meta = JSON.parse(fs.readFileSync(metaFile, "utf8")); } catch {}
    }
    return {
      ok: true,
      skill: skillName,
      content: content.slice(0, 15000),
      meta,
      truncated: content.length > 15000,
    };
  }

  return { ok: false, error: `Skill "${skillName}" not found in ${SKILLS_DIR}` };
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

// --- Dispatcher ---

export async function callTool(name: string, args: any): Promise<any> {
  switch (name) {
    case "web_search": return webSearch(args);
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
    default:
      // Route MCP tools to MCP client
      if (isMcpTool(name)) return callMcpTool(name, args);
      return { ok: false, error: `Unknown tool: ${name}` };
  }
}
