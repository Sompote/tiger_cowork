import { Server, Socket } from "socket.io";
import { v4 as uuid } from "uuid";
import { callTigerBotWithTools, callTigerBot } from "./tigerbot";
import { getChatHistory, saveChatHistory, ChatSession, getSettings, getProjects, getSkills } from "./data";
import { runPython } from "./python";
import path from "path";
import { execSync } from "child_process";
import fs from "fs";

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

export function getActiveTasks(): ActiveTask[] {
  return Array.from(activeTasks.values());
}

function buildSystemPrompt(): string {
  // Gather installed clawhub skills
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
- IMPORTANT: Do NOT call the same tool repeatedly with the same arguments. If a tool returns a result, use that result — do not call it again.
- IMPORTANT: If a tool (especially run_shell) returns an error like "command not found", do NOT retry it. Tell the user what needs to be installed and how.
- When using skills (after load_skill), you may need several tool calls to complete the workflow — that's OK. But if a command fails, explain the error to the user instead of retrying.
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
- MCP TOOLS: External tools connected via Model Context Protocol are available with names starting with "mcp_". Use them like any other tool when they match the user's request.${skillsList}`;
}

// Store io reference for broadcasting status to all connected clients
let ioRef: Server | null = null;

// Broadcast status to ALL connected sockets (so reconnected clients get updates)
function broadcastStatus(data: Record<string, any>) {
  if (ioRef) ioRef.emit("chat:status", data);
}

export function setupSocket(io: Server): void {
  ioRef = io;

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
        saveChatHistory(sessions);
        socket.emit("chat:response", { sessionId, content: assistantMsg, done: true, files: result.outputFiles });
        return;
      }

      // Use tool-calling AI loop — build multimodal content for images
      const settings = getSettings();
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

      try {
        const result = await callTigerBotWithTools(
          chatMessages,
          buildSystemPrompt(),
          // onToolCall — show status only (no chunks)
          (name, args) => {
            toolsUsed.push(name);
            broadcastStatus({ sessionId, status: "tool_call", tool: name, args });
            // Update active task
            activeTask.status = `Running: ${name}`;
            activeTask.toolCalls.push(name);
            activeTask.lastUpdate = new Date().toISOString();
          },
          // onToolResult — collect output files, show status only
          (name, toolResult) => {
            broadcastStatus({ sessionId, status: "tool_result", tool: name });
            activeTask.status = `${name} done, thinking...`;
            activeTask.lastUpdate = new Date().toISOString();
            if (toolResult?.outputFiles) {
              outputFiles.push(...toolResult.outputFiles);
            }
          }
        );

        // Stream the final AI response
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
        saveChatHistory(sessions);
        socket.emit("chat:response", { sessionId, content: fullResponse, done: true, files: outputFiles.length > 0 ? outputFiles : undefined });
      } catch (err: any) {
        // Fallback to simple call without tools — still include any outputFiles collected during tool calls
        try {
          const result = await callTigerBot(chatMessages, buildSystemPrompt());
          const fallbackContent = result.content +
            (outputFiles.length > 0 ? `\n\nGenerated files: ${outputFiles.join(", ")}` : "");
          session.messages.push({
            role: "assistant",
            content: fallbackContent,
            timestamp: new Date().toISOString(),
            files: outputFiles.length > 0 ? outputFiles : undefined,
          });
          saveChatHistory(sessions);
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
          saveChatHistory(sessions);
          socket.emit("chat:response", { sessionId, content: errorContent, done: true, files: outputFiles.length > 0 ? outputFiles : undefined });
        }
      } finally {
        activeTasks.delete(taskId);
      }
    });

    // ─── Project Chat ───
    socket.on("project:chat:send", async (data: { projectId: string; sessionId: string; message: string; images?: { path: string; type: string }[] }) => {
      const { projectId, sessionId, message, images } = data;
      const projects = getProjects();
      const project = projects.find((p) => p.id === projectId);
      if (!project) {
        socket.emit("chat:response", { sessionId, content: "Error: Project not found", done: true });
        return;
      }

      // Build project-aware system prompt
      let projectPrompt = buildSystemPrompt();

      // Read project memory fresh from {workingFolder}/memory.md every time
      let projectMemory = "";
      if (project.workingFolder) {
        const memoryPath = path.join(project.workingFolder, "memory.md");
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
      if (project.workingFolder) {
        projectPrompt += `\n\nProject working folder: ${project.workingFolder}\nWhen the user asks about files, search this folder first. Use this folder for reading/writing project files.`;
      }

      // Inject selected skills
      if (project.skills && project.skills.length > 0) {
        const allSkills = getSkills();
        const selectedSkills = allSkills.filter((s) => project.skills.includes(s.id));
        if (selectedSkills.length > 0) {
          projectPrompt += `\n\nProject priority skills: ${selectedSkills.map((s) => s.name).join(", ")}\nThese skills are selected for this project. Prioritize using them when relevant.`;
        }
      }

      // Append instruction to auto-record project info
      projectPrompt += `\n\nIMPORTANT: If the user shares project information (tech stack, architecture decisions, conventions, key files, etc.), suggest recording it to the project memory. You can mention "Would you like me to add this to the project memory?"`;

      // Reuse the same chat session logic
      const sessions = getChatHistory();
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
      saveChatHistory(sessions);

      const settings = getSettings();
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

      try {
        const result = await callTigerBotWithTools(
          chatMessages,
          projectPrompt,
          (name, args) => {
            broadcastStatus({ sessionId, status: "tool_call", tool: name, args });
            activeTask.status = `Running: ${name}`;
            activeTask.toolCalls.push(name);
            activeTask.lastUpdate = new Date().toISOString();
          },
          (name, toolResult) => {
            broadcastStatus({ sessionId, status: "tool_result", tool: name });
            activeTask.status = `${name} done, thinking...`;
            activeTask.lastUpdate = new Date().toISOString();
            if (toolResult?.outputFiles) outputFiles.push(...toolResult.outputFiles);
          }
        );

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
        saveChatHistory(sessions);
        socket.emit("chat:response", { sessionId, content: fullResponse, done: true, files: outputFiles.length > 0 ? outputFiles : undefined });
      } catch (err: any) {
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
          saveChatHistory(sessions);
          socket.emit("chat:response", { sessionId, content: fallbackContent, done: true, files: outputFiles.length > 0 ? outputFiles : undefined });
        } catch (fallbackErr: any) {
          const errMsg = `Error: ${fallbackErr.message || err.message}`;
          session.messages.push({
            role: "assistant",
            content: errMsg,
            timestamp: new Date().toISOString(),
          });
          saveChatHistory(sessions);
          socket.emit("chat:response", { sessionId, content: errMsg, done: true });
        }
      } finally {
        activeTasks.delete(taskId);
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
