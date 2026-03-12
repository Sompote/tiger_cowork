import { Router } from "express";
import { getProjects, saveProjects, getSettings, Project } from "../services/data";
import { v4 as uuid } from "uuid";
import fs from "fs";
import path from "path";

export const projectsRouter = Router();

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

// List files in project working folder
projectsRouter.get("/:id/files", (req, res) => {
  const projects = getProjects();
  const project = projects.find((p) => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: "Project not found" });
  if (!project.workingFolder) return res.json({ files: [] });

  const subPath = (req.query.path as string) || "";
  const fullPath = path.join(project.workingFolder, subPath);

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
