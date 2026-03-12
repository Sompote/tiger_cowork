import { Router } from "express";
import { v4 as uuid } from "uuid";
import multer from "multer";
import path from "path";
import fs from "fs";
import AdmZip from "adm-zip";
import { getSkills, saveSkills } from "../services/data";
import { listInstalledSkills } from "../services/clawhub";

export const skillsRouter = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB for zip files

skillsRouter.get("/", (_req, res) => {
  const skills = getSkills();
  // Merge in any ClawHub-installed skills not yet registered in skills.json
  try {
    const clawhubSkills = listInstalledSkills();
    let changed = false;
    for (const cs of clawhubSkills) {
      if (cs.installed && !skills.some((s) => s.name === cs.name && s.source === "clawhub")) {
        skills.push({
          id: uuid(),
          name: cs.name,
          description: cs.description || `ClawHub skill: ${cs.name}`,
          source: "clawhub" as const,
          script: cs.name,
          enabled: true,
          installedAt: new Date().toISOString(),
        });
        changed = true;
      }
    }
    if (changed) saveSkills(skills);
  } catch {}
  res.json(skills);
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

/** Parse SKILL.md frontmatter and return name + description */
function parseFrontmatter(content: string): { name: string; description: string } {
  let name = "";
  let description = "";
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (fmMatch) {
    for (const line of fmMatch[1].split("\n")) {
      const idx = line.indexOf(":");
      if (idx <= 0) continue;
      const key = line.slice(0, idx).trim().toLowerCase();
      const val = line.slice(idx + 1).trim();
      if (key === "name") name = val;
      else if (key === "description") description = val;
    }
  }
  return { name, description };
}

// Upload skill — accepts SKILL.md file or .zip folder
skillsRouter.post("/upload", upload.single("file"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const ext = path.extname(req.file.originalname).toLowerCase();
    let name = "";
    let description = "";

    if (ext === ".zip") {
      // --- ZIP upload: extract entire folder as a skill ---
      const zip = new AdmZip(req.file.buffer);
      const entries = zip.getEntries();

      // Find SKILL.md inside the zip (may be at root or inside a single top-level folder)
      let skillMdEntry = entries.find((e) => e.entryName === "SKILL.md" || e.entryName.endsWith("/SKILL.md"));
      // Determine the prefix (top-level folder inside zip, if any)
      let prefix = "";
      if (skillMdEntry && skillMdEntry.entryName.includes("/")) {
        prefix = skillMdEntry.entryName.replace(/SKILL\.md$/, "");
      }

      // Parse frontmatter from SKILL.md if found
      if (skillMdEntry) {
        const skillMdContent = skillMdEntry.getData().toString("utf-8");
        const parsed = parseFrontmatter(skillMdContent);
        name = parsed.name;
        description = parsed.description;
      }

      // Fallback name from zip filename
      if (!name) {
        name = path.basename(req.file.originalname, ".zip");
      }

      const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
      const skillDir = path.join(process.cwd(), "skills", sanitized);
      fs.mkdirSync(skillDir, { recursive: true });

      // Extract all entries under the prefix into skillDir
      for (const entry of entries) {
        if (entry.isDirectory) continue;
        // Strip the prefix to flatten if zip has a single top-level folder
        let relativePath = entry.entryName;
        if (prefix && relativePath.startsWith(prefix)) {
          relativePath = relativePath.slice(prefix.length);
        }
        // Skip hidden/system files
        if (relativePath.startsWith("__MACOSX") || relativePath.startsWith(".")) continue;

        const destPath = path.join(skillDir, relativePath);
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.writeFileSync(destPath, entry.getData());
      }

      // If no SKILL.md was in the zip, create a minimal one
      if (!skillMdEntry) {
        const minimalSkillMd = `---\nname: ${name}\ndescription: Custom skill\n---\n\n# ${name}\n`;
        fs.writeFileSync(path.join(skillDir, "SKILL.md"), minimalSkillMd, "utf-8");
      }

      // Count extracted files for response
      const fileCount = entries.filter((e) => !e.isDirectory && !e.entryName.startsWith("__MACOSX")).length;

      // Register in skills.json
      const skills = getSkills();
      const existing = skills.find((s) => s.name === name && s.source === "custom");
      if (existing) {
        existing.script = name;
        existing.description = description || existing.description;
        saveSkills(skills);
        return res.json({ ...existing, fileCount });
      }

      const skill = {
        id: uuid(),
        name,
        description: description || `Custom skill from ${req.file.originalname}`,
        source: "custom" as const,
        script: name,
        enabled: true,
        installedAt: new Date().toISOString(),
      };
      skills.push(skill);
      saveSkills(skills);
      res.json({ ...skill, fileCount });

    } else {
      // --- Single SKILL.md file upload (existing behavior) ---
      const content = req.file.buffer.toString("utf-8");
      const parsed = parseFrontmatter(content);
      name = parsed.name;
      description = parsed.description;

      if (!name) {
        name = path.basename(req.file.originalname, path.extname(req.file.originalname));
      }

      const skillDir = path.join(process.cwd(), "skills", name.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase());
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), content, "utf-8");

      const skills = getSkills();
      const existing = skills.find((s) => s.name === name && s.source === "custom");
      if (existing) {
        existing.script = name;
        existing.description = description || existing.description;
        saveSkills(skills);
        return res.json(existing);
      }

      const skill = {
        id: uuid(),
        name,
        description: description || `Custom skill from ${req.file.originalname}`,
        source: "custom" as const,
        script: name,
        enabled: true,
        installedAt: new Date().toISOString(),
      };
      skills.push(skill);
      saveSkills(skills);
      res.json(skill);
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
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
