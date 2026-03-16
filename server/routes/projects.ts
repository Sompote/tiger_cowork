import { Router } from "express";
import { getProjects, saveProjects, getSettings, getChatHistory, Project } from "../services/data";
import { callTigerBot } from "../services/tigerbot";
import { v4 as uuid } from "uuid";
import fs from "fs";
import path from "path";
import multer from "multer";

export const projectsRouter = Router();

const projectUpload = multer({ dest: "/tmp/cowork-uploads" });

// Helper to resolve project working folder (handles relative paths)
function resolveWorkingFolder(project: Project): string {
  if (!project.workingFolder) return "";
  if (path.isAbsolute(project.workingFolder)) return project.workingFolder;
  const settings = getSettings();
  const sandboxDir = settings.sandboxDir || path.resolve("sandbox");
  return path.join(sandboxDir, project.workingFolder);
}

// Helper to get sandbox-relative path for a file in a project
function projectFileRelPath(resolvedFolder: string, subFilePath: string): string {
  const settings = getSettings();
  const sandboxDir = settings.sandboxDir || path.resolve("sandbox");
  const fullPath = path.join(resolvedFolder, subFilePath);
  return path.relative(sandboxDir, fullPath);
}

// List all projects
projectsRouter.get("/", (_req, res) => {
  res.json(getProjects());
});

// Get single project
projectsRouter.get("/:id", (req, res) => {
  const projects = getProjects();
  const project = projects.find((p) => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: "Project not found" });
  res.json(project);
});

// Create project
projectsRouter.post("/", (req, res) => {
  const { name, description, workingFolder, skills } = req.body;
  const projects = getProjects();
  const settings = getSettings();

  // Resolve working folder path relative to sandbox
  let resolvedFolder = workingFolder || "";
  if (resolvedFolder && !path.isAbsolute(resolvedFolder)) {
    const sandboxDir = settings.sandboxDir || path.resolve("sandbox");
    resolvedFolder = path.join(sandboxDir, resolvedFolder);
  }

  const project: Project = {
    id: uuid(),
    name: name || "Untitled Project",
    description: description || "",
    workingFolder: resolvedFolder,
    memory: "",
    skills: skills || [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  projects.push(project);
  saveProjects(projects);

  // Create working folder if specified and doesn't exist
  if (project.workingFolder && !fs.existsSync(project.workingFolder)) {
    fs.mkdirSync(project.workingFolder, { recursive: true });
  }

  res.json(project);
});

// Update project
projectsRouter.patch("/:id", (req, res) => {
  const projects = getProjects();
  const idx = projects.findIndex((p) => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Project not found" });

  const updates = req.body;
  // Remove legacy fields if present
  delete updates.folderLocation;
  delete updates.folderAccess;
  projects[idx] = { ...projects[idx], ...updates, updatedAt: new Date().toISOString() };
  saveProjects(projects);
  res.json(projects[idx]);
});

// Delete project
projectsRouter.delete("/:id", (req, res) => {
  let projects = getProjects();
  projects = projects.filter((p) => p.id !== req.params.id);
  saveProjects(projects);
  res.json({ ok: true });
});

// Get project memory — read from {workingFolder}/memory.md
projectsRouter.get("/:id/memory", (req, res) => {
  const projects = getProjects();
  const project = projects.find((p) => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: "Project not found" });

  let content = "";
  if (project.workingFolder) {
    const memoryPath = path.join(project.workingFolder, "memory.md");
    try {
      if (fs.existsSync(memoryPath)) {
        content = fs.readFileSync(memoryPath, "utf-8");
      }
    } catch (err: any) {
      console.error(`Failed to read memory.md for project ${project.id}:`, err.message);
    }
  }
  // Fallback to stored memory if no file found
  if (!content && project.memory) {
    content = project.memory;
  }
  res.json({ content });
});

// Save project memory — write to {workingFolder}/memory.md
projectsRouter.put("/:id/memory", (req, res) => {
  const projects = getProjects();
  const idx = projects.findIndex((p) => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Project not found" });

  const content = req.body.content || "";
  const project = projects[idx];

  // Write to memory.md in the working folder
  if (project.workingFolder) {
    const memoryPath = path.join(project.workingFolder, "memory.md");
    try {
      if (!fs.existsSync(project.workingFolder)) {
        fs.mkdirSync(project.workingFolder, { recursive: true });
      }
      fs.writeFileSync(memoryPath, content, "utf-8");
    } catch (err: any) {
      console.error(`Failed to write memory.md for project ${project.id}:`, err.message);
      return res.status(500).json({ error: `Failed to write memory.md: ${err.message}` });
    }
  }

  // Also keep in project JSON as backup
  projects[idx].memory = content;
  projects[idx].updatedAt = new Date().toISOString();
  saveProjects(projects);
  res.json({ ok: true });
});

// Generate memory from chat history using LLM
projectsRouter.post("/:id/memory/generate", async (req, res) => {
  try {
    const projects = getProjects();
    const project = projects.find((p) => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: "Project not found" });

    // Find project chat sessions (prefixed with [ProjectName])
    const sessions = getChatHistory();
    const prefix = `[${project.name}]`;
    const projectSessions = sessions.filter((s) => s.title.startsWith(prefix));

    if (projectSessions.length === 0) {
      return res.status(400).json({ error: "No chat history found for this project" });
    }

    // Collect messages from all project sessions (limit to keep token usage reasonable)
    let chatSummary = "";
    for (const session of projectSessions.slice(-10)) {
      chatSummary += `\n--- Session: ${session.title} (${session.updatedAt}) ---\n`;
      for (const msg of session.messages.slice(-50)) {
        const role = msg.role === "user" ? "User" : "Assistant";
        const content = typeof msg.content === "string" ? msg.content : "[non-text content]";
        chatSummary += `${role}: ${content.slice(0, 500)}\n`;
      }
    }

    // Read existing memory if any
    let existingMemory = "";
    if (project.workingFolder) {
      const resolved = resolveWorkingFolder(project);
      const memoryPath = path.join(resolved, "memory.md");
      try {
        if (fs.existsSync(memoryPath)) {
          existingMemory = fs.readFileSync(memoryPath, "utf-8");
        }
      } catch {}
    }
    if (!existingMemory && project.memory) existingMemory = project.memory;

    const prompt = `You are a project memory assistant. Analyze the chat history below from project "${project.name}" and generate a concise project memory document in Markdown format.

${existingMemory ? `Here is the existing project memory — update and improve it based on the new chat history:\n\n${existingMemory}\n\n` : ""}Extract and organize the following information:
- **Project Overview**: What the project is about
- **Tech Stack**: Technologies, frameworks, libraries used
- **Key Decisions**: Important architectural or design decisions made
- **File Structure**: Important files and their purposes (if discussed)
- **Conventions**: Coding conventions or patterns established
- **Current Status**: What's been done and what's in progress
- **Notes**: Any other important information

Only include sections that have relevant information from the chat history. Be concise but thorough. Write in Markdown format.

--- CHAT HISTORY ---
${chatSummary.slice(0, 30000)}
--- END CHAT HISTORY ---

Generate the project memory document now:`;

    const result = await callTigerBot([
      { role: "user", content: prompt },
    ]);

    res.json({ content: result.content });
  } catch (err: any) {
    console.error("Memory generation error:", err.message);
    res.status(500).json({ error: err.message || "Failed to generate memory" });
  }
});

// List files in project working folder
projectsRouter.get("/:id/files", (req, res) => {
  const projects = getProjects();
  const project = projects.find((p) => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: "Project not found" });
  if (!project.workingFolder) return res.json({ files: [] });

  const resolved = resolveWorkingFolder(project);
  const subPath = (req.query.path as string) || "";
  const fullPath = path.join(resolved, subPath);

  if (!fs.existsSync(fullPath)) return res.json({ files: [] });

  try {
    const entries = fs.readdirSync(fullPath, { withFileTypes: true });
    const files = entries.map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory(),
      size: e.isDirectory() ? 0 : fs.statSync(path.join(fullPath, e.name)).size,
      path: subPath ? `${subPath}/${e.name}` : e.name,
    }));
    res.json({ files });
  } catch (err: any) {
    res.json({ files: [], error: err.message });
  }
});

// Upload file to project working folder
projectsRouter.post("/:id/files/upload", projectUpload.single("file"), (req, res) => {
  const projects = getProjects();
  const project = projects.find((p) => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: "Project not found" });
  if (!project.workingFolder) return res.status(400).json({ error: "No working folder" });
  if (!req.file) return res.status(400).json({ error: "No file" });

  const resolved = resolveWorkingFolder(project);
  const subPath = req.body.path || "";
  const destDir = subPath ? path.join(resolved, subPath) : resolved;
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

  const destPath = path.join(destDir, req.file.originalname);
  fs.renameSync(req.file.path, destPath);
  res.json({ success: true, name: req.file.originalname });
});

// Create directory in project working folder
projectsRouter.post("/:id/files/mkdir", (req, res) => {
  const projects = getProjects();
  const project = projects.find((p) => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: "Project not found" });
  if (!project.workingFolder) return res.status(400).json({ error: "No working folder" });

  const dirName = req.body.name;
  const subPath = req.body.path || "";
  if (!dirName) return res.status(400).json({ error: "name required" });

  const resolved = resolveWorkingFolder(project);
  const fullPath = path.join(resolved, subPath, dirName);

  // Prevent path traversal
  if (!fullPath.startsWith(resolved)) return res.status(403).json({ error: "Invalid path" });

  if (!fs.existsSync(fullPath)) fs.mkdirSync(fullPath, { recursive: true });
  res.json({ success: true });
});

// Delete file/directory in project working folder
projectsRouter.delete("/:id/files", (req, res) => {
  const projects = getProjects();
  const project = projects.find((p) => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: "Project not found" });
  if (!project.workingFolder) return res.status(400).json({ error: "No working folder" });

  const filePath = req.query.path as string;
  if (!filePath) return res.status(400).json({ error: "path required" });

  const resolved = resolveWorkingFolder(project);
  const fullPath = path.join(resolved, filePath);

  // Prevent path traversal
  if (!fullPath.startsWith(resolved)) return res.status(403).json({ error: "Invalid path" });

  if (!fs.existsSync(fullPath)) return res.status(404).json({ error: "File not found" });

  try {
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      fs.rmSync(fullPath, { recursive: true });
    } else {
      fs.unlinkSync(fullPath);
    }
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Download file from project working folder
projectsRouter.get("/:id/files/download", (req, res) => {
  const projects = getProjects();
  const project = projects.find((p) => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: "Project not found" });
  if (!project.workingFolder) return res.status(400).json({ error: "No working folder" });

  const filePath = req.query.path as string;
  if (!filePath) return res.status(400).json({ error: "path required" });

  const resolved = resolveWorkingFolder(project);
  const fullPath = path.join(resolved, filePath);

  if (!fullPath.startsWith(resolved)) return res.status(403).json({ error: "Invalid path" });
  if (!fs.existsSync(fullPath)) return res.status(404).json({ error: "File not found" });

  res.download(fullPath);
});

// Get sandbox-relative path for a project file (for preview/display in output panel)
projectsRouter.get("/:id/files/sandbox-path", (req, res) => {
  const projects = getProjects();
  const project = projects.find((p) => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: "Project not found" });
  if (!project.workingFolder) return res.status(400).json({ error: "No working folder" });

  const filePath = req.query.path as string;
  if (!filePath) return res.status(400).json({ error: "path required" });

  const resolved = resolveWorkingFolder(project);
  const relPath = projectFileRelPath(resolved, filePath);
  res.json({ sandboxPath: relPath });
});
