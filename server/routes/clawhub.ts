import { Router } from "express";
import { v4 as uuid } from "uuid";
import fs from "fs";
import path from "path";
import { clawhubSearch, clawhubInstall, clawhubInfo, listInstalledSkills, readSkill } from "../services/clawhub";
import { getSkills, saveSkills } from "../services/data";

export const clawhubRouter = Router();

// List installed skills
clawhubRouter.get("/skills", (_req, res) => {
  try {
    res.json(listInstalledSkills());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Read a skill's SKILL.md
clawhubRouter.get("/skills/:name", (req, res) => {
  const content = readSkill(req.params.name);
  if (!content) return res.status(404).json({ error: "Skill not found" });
  res.json({ name: req.params.name, content });
});

// Search clawhub catalog
clawhubRouter.get("/search", async (req, res) => {
  const query = String(req.query.q || "").trim();
  if (!query) return res.status(400).json({ error: "q parameter required" });
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
  try {
    const result = await clawhubSearch(query, limit);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get skill detail/info from clawhub
clawhubRouter.get("/info/:slug", async (req, res) => {
  const slug = req.params.slug;
  try {
    const result = await clawhubInfo(slug);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Install a skill from clawhub
clawhubRouter.post("/install", async (req, res) => {
  const { slug, force } = req.body;
  if (!slug) return res.status(400).json({ error: "slug required" });
  try {
    const result = await clawhubInstall(slug, Boolean(force));
    // Register in skills.json so it appears in the installed list
    if (result.installed) {
      const skills = getSkills();
      const existing = skills.find((s) => s.name === slug && s.source === "clawhub");
      if (!existing) {
        // Read description from SKILL.md frontmatter
        let description = `ClawHub skill: ${slug}`;
        const skillFile = path.join(process.cwd(), "Tiger_bot", "skills", slug, "SKILL.md");
        if (fs.existsSync(skillFile)) {
          try {
            const content = fs.readFileSync(skillFile, "utf-8");
            const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
            if (fmMatch) {
              for (const line of fmMatch[1].split("\n")) {
                const idx = line.indexOf(":");
                if (idx > 0 && line.slice(0, idx).trim() === "description") {
                  description = line.slice(idx + 1).trim();
                  break;
                }
              }
            }
          } catch {}
        }
        skills.push({
          id: uuid(),
          name: slug,
          description,
          source: "clawhub",
          script: slug,
          enabled: true,
          installedAt: new Date().toISOString(),
        });
        saveSkills(skills);
      }
    }
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
