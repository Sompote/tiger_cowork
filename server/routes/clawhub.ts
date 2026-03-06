import { Router } from "express";
import { clawhubSearch, clawhubInstall, listInstalledSkills, readSkill } from "../services/clawhub";

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

// Install a skill from clawhub
clawhubRouter.post("/install", async (req, res) => {
  const { slug, force } = req.body;
  if (!slug) return res.status(400).json({ error: "slug required" });
  try {
    const result = await clawhubInstall(slug, Boolean(force));
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
