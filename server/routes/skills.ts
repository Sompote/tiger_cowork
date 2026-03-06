import { Router } from "express";
import { v4 as uuid } from "uuid";
import { getSkills, saveSkills } from "../services/data";

export const skillsRouter = Router();

skillsRouter.get("/", (_req, res) => {
  res.json(getSkills());
});

// Install skill
skillsRouter.post("/", (req, res) => {
  const skills = getSkills();
  const skill = {
    id: uuid(),
    name: req.body.name || "Untitled Skill",
    description: req.body.description || "",
    source: req.body.source || "custom",
    script: req.body.script || "",
    enabled: true,
    installedAt: new Date().toISOString(),
  };
  skills.push(skill);
  saveSkills(skills);
  res.json(skill);
});

// Toggle or update skill
skillsRouter.patch("/:id", (req, res) => {
  const skills = getSkills();
  const idx = skills.findIndex((s) => s.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: "Not found" });
  Object.assign(skills[idx], req.body);
  saveSkills(skills);
  res.json(skills[idx]);
});

// Uninstall
skillsRouter.delete("/:id", (req, res) => {
  let skills = getSkills();
  skills = skills.filter((s) => s.id !== req.params.id);
  saveSkills(skills);
  res.json({ success: true });
});

// Browse available skills (Claude / OpenClaw catalog)
skillsRouter.get("/catalog", (_req, res) => {
  // Built-in skill catalog
  const catalog = [
    { name: "Web Search", description: "Search the web using configured search engine", source: "claude", script: "web-search" },
    { name: "Code Review", description: "Review code for quality and security issues", source: "claude", script: "code-review" },
    { name: "File Converter", description: "Convert between file formats (PDF, DOCX, CSV)", source: "claude", script: "file-converter" },
    { name: "Data Analyzer", description: "Analyze CSV/JSON data and generate charts", source: "openclaw", script: "data-analyzer" },
    { name: "API Tester", description: "Test REST APIs with custom requests", source: "openclaw", script: "api-tester" },
    { name: "Markdown Renderer", description: "Render markdown to HTML/PDF", source: "openclaw", script: "markdown-renderer" },
    { name: "Git Helper", description: "Git operations within sandbox", source: "claude", script: "git-helper" },
    { name: "Image Processor", description: "Resize, crop, and convert images", source: "openclaw", script: "image-processor" },
  ];
  res.json(catalog);
});
