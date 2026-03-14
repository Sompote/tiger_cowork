import { Router } from "express";
import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { getProtocolStatus } from "../services/protocols";

const router = Router();
const AGENTS_DIR = path.resolve("data/agents");

// Ensure agents directory exists
if (!fs.existsSync(AGENTS_DIR)) {
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
}

// List all agent YAML configs
router.get("/", (_req, res) => {
  try {
    const files = fs.readdirSync(AGENTS_DIR)
      .filter(f => f.endsWith(".yaml") || f.endsWith(".yml"))
      .map(f => {
        const content = fs.readFileSync(path.join(AGENTS_DIR, f), "utf8");
        let parsed: any = {};
        try { parsed = yaml.load(content) as any; } catch {}
        return {
          filename: f,
          name: parsed?.system?.name || f.replace(/\.ya?ml$/, ""),
          agentCount: parsed?.agents?.length || 0,
          updatedAt: fs.statSync(path.join(AGENTS_DIR, f)).mtime.toISOString(),
        };
      });
    res.json(files);
  } catch (err: any) {
    res.json([]);
  }
});

// Get a specific agent config
router.get("/:filename", (req, res) => {
  const filename = req.params.filename;
  if (!filename.match(/^[\w\-. ]+\.ya?ml$/)) {
    return res.status(400).json({ error: "Invalid filename" });
  }
  const fp = path.join(AGENTS_DIR, filename);
  if (!fs.existsSync(fp)) {
    return res.status(404).json({ error: "File not found" });
  }
  const content = fs.readFileSync(fp, "utf8");
  let parsed: any = {};
  try { parsed = yaml.load(content); } catch {}
  res.json({ filename, content, parsed });
});

// Save agent config (create or update)
router.post("/", (req, res) => {
  const { filename, content } = req.body;
  if (!filename || !content) {
    return res.status(400).json({ error: "filename and content required" });
  }
  const safeName = filename.replace(/[^a-zA-Z0-9_\-. ]/g, "");
  const finalName = safeName.endsWith(".yaml") || safeName.endsWith(".yml")
    ? safeName
    : safeName + ".yaml";

  // Validate YAML
  try {
    yaml.load(content);
  } catch (err: any) {
    return res.status(400).json({ error: `Invalid YAML: ${err.message}` });
  }

  fs.writeFileSync(path.join(AGENTS_DIR, finalName), content, "utf8");
  res.json({ ok: true, filename: finalName });
});

// Delete agent config
router.delete("/:filename", (req, res) => {
  const filename = req.params.filename;
  const fp = path.join(AGENTS_DIR, filename);
  if (fs.existsSync(fp)) {
    fs.unlinkSync(fp);
  }
  res.json({ ok: true });
});

// Parse YAML content (utility endpoint)
router.post("/parse", (req, res) => {
  try {
    const parsed = yaml.load(req.body.content);
    res.json({ ok: true, parsed });
  } catch (err: any) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Generate YAML from editor data
router.post("/generate", (req, res) => {
  try {
    const data = req.body;
    const yamlContent = yaml.dump(data, {
      indent: 2,
      lineWidth: 120,
      noRefs: true,
      sortKeys: false,
    });
    res.json({ ok: true, content: yamlContent });
  } catch (err: any) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Protocol status endpoint
router.get("/protocols/status", (_req, res) => {
  res.json(getProtocolStatus());
});

export const agentsRouter = router;
