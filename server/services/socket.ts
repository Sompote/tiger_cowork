import { Server, Socket } from "socket.io";
import { v4 as uuid } from "uuid";
import { callTigerBotWithTools, callTigerBot } from "./tigerbot";
import { getChatHistory, saveChatHistory, ChatSession, getSettings } from "./data";
import { runPython } from "./python";
import path from "path";

function buildSystemPrompt(): string {
  // Gather installed clawhub skills
  const fs = require("fs");
  const skillsDir = path.resolve("Tiger_bot/skills");
  let installedSkills: string[] = [];
  try {
    if (fs.existsSync(skillsDir)) {
      installedSkills = fs.readdirSync(skillsDir, { withFileTypes: true })
        .filter((d: any) => d.isDirectory() && fs.existsSync(path.join(skillsDir, d.name, "SKILL.md")))
        .map((d: any) => d.name);
    }
  } catch {}

  const skillsList = installedSkills.length > 0
    ? `\n\nInstalled ClawHub skills: ${installedSkills.join(", ")}\nTo use a skill, call list_skills then load_skill to read its SKILL.md, then follow its instructions using run_python or run_shell.`
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
- clawhub_install: Install skills from ClawHub by slug

Rules:
- USE TOOLS actively. When asked to search, use web_search. When asked to fetch a page, use fetch_url.
- For web search tasks: prefer using the installed duckduckgo-search skill via run_python (it gives better results than the basic web_search). Load the skill first with load_skill("duckduckgo-search") to see usage.
- For coding tasks, use run_python, run_react, or run_shell to execute code directly.
- For interactive UIs, dashboards, or React components, use run_react. It supports hooks, state, and CDN libraries like Recharts and Tailwind CSS.
- For file operations, use read_file, write_file, list_files.
- Be concise and actionable.
- If web_search returns limited results, follow up with fetch_url on relevant URLs.
- If you generate files (PDF, Word, etc.), mention them so the user can download.
- For ClawHub skills, use clawhub_search to find and clawhub_install to install them.
- Do NOT just describe what you would do — actually call the tools and provide real results.
- When a user asks about skills, call list_skills to show what's available.
- CHARTS & PLOTS: When creating charts/graphs with matplotlib or plotly, ALWAYS save to a .png file (e.g. plt.savefig('chart.png', dpi=150, bbox_inches='tight')). The image will be rendered in the output panel on the right. Never call plt.show(). For interactive charts, use run_react with Recharts.
- REPORTS: When generating HTML reports, save to a .html file. It will be rendered in the output panel. For PDF reports, save to .pdf and it will show an embedded preview.
- REACT APPS: When asked to build UI components or interactive visualizations, use run_react. The component renders in the output panel. You can include dependencies like 'recharts', 'tailwindcss', 'chart.js', etc. IMPORTANT: Do NOT use import/export statements in run_react code — React, ReactDOM, hooks (useState, useEffect, etc.), and library globals (like Recharts components: BarChart, LineChart, etc.) are already available as globals. Just define your component function and it will be auto-rendered.
- Use matplotlib.use('Agg') is already set automatically. Just import matplotlib.pyplot and save figures.${skillsList}`;
}

export function setupSocket(io: Server): void {
  io.on("connection", (socket: Socket) => {
    console.log("Client connected:", socket.id);

    socket.on("chat:send", async (data: { sessionId: string; message: string }) => {
      const { sessionId, message } = data;
      const sessions = getChatHistory();
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
      saveChatHistory(sessions);

      // Check if user sent Python code directly
      const pythonMatch = message.match(/```python\n([\s\S]*?)```/);
      if (pythonMatch) {
        const settings = getSettings();
        const sandboxDir = settings.sandboxDir || path.resolve("sandbox");
        socket.emit("chat:status", { status: "running_python" });
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
        saveChatHistory(sessions);
        socket.emit("chat:response", { sessionId, content: assistantMsg, done: true, files: result.outputFiles });
        return;
      }

      // Use tool-calling AI loop
      const chatMessages = session.messages.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

      socket.emit("chat:status", { status: "thinking" });
      const toolsUsed: string[] = [];
      const outputFiles: string[] = [];

      try {
        const result = await callTigerBotWithTools(
          chatMessages,
          buildSystemPrompt(),
          // onToolCall — show what tool is being called
          (name, args) => {
            toolsUsed.push(name);
            socket.emit("chat:status", { status: "tool_call", tool: name, args });
            // Stream a visible progress indicator
            const argSummary = name === "web_search" ? `: "${args.query}"`
              : name === "fetch_url" ? `: ${args.url}`
              : name === "run_shell" ? `: \`${args.command}\``
              : name === "clawhub_search" ? `: "${args.query}"`
              : name === "clawhub_install" ? `: ${args.slug}`
              : name === "read_file" ? `: ${args.path}`
              : name === "load_skill" ? `: ${args.skill}`
              : name === "run_python" ? ""
              : name === "run_react" ? `: ${args.title || "component"}`
              : "";
            socket.emit("chat:chunk", { sessionId, content: `\n> **${name}**${argSummary}\n` });
          },
          // onToolResult — show brief result
          (name, toolResult) => {
            socket.emit("chat:status", { status: "tool_result", tool: name });
            // Collect output files
            if (toolResult?.outputFiles) {
              outputFiles.push(...toolResult.outputFiles);
            }
          }
        );

        // Stream the final AI response
        if (result.content) {
          socket.emit("chat:chunk", { sessionId, content: "\n" + result.content });
        }

        // Build full content including tool call indicators
        const toolLines = toolsUsed.map((t) => `> **${t}**`).join("\n");
        const fullResponse = (toolLines ? toolLines + "\n\n" : "") + result.content +
          (outputFiles.length > 0 ? `\n\nGenerated files: ${outputFiles.join(", ")}` : "");

        session.messages.push({
          role: "assistant",
          content: fullResponse,
          timestamp: new Date().toISOString(),
          files: outputFiles.length > 0 ? outputFiles : undefined,
        });
        saveChatHistory(sessions);
        socket.emit("chat:response", { sessionId, content: fullResponse, done: true, files: outputFiles.length > 0 ? outputFiles : undefined });
      } catch (err: any) {
        // Fallback to simple call without tools
        try {
          const result = await callTigerBot(chatMessages, buildSystemPrompt());
          session.messages.push({
            role: "assistant",
            content: result.content,
            timestamp: new Date().toISOString(),
          });
          saveChatHistory(sessions);
          socket.emit("chat:response", { sessionId, content: result.content, done: true });
        } catch (fallbackErr: any) {
          const errMsg = `Error: ${fallbackErr.message || err.message}`;
          socket.emit("chat:response", { sessionId, content: errMsg, done: true });
        }
      }
    });

    socket.on("python:run", async (data: { code: string }) => {
      const settings = getSettings();
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
