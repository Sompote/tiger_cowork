import { FastifyInstance } from "fastify";
import { v4 as uuid } from "uuid";
import multipart from "@fastify/multipart";
import path from "path";
import fs from "fs";
import AdmZip from "adm-zip";
import yaml from "js-yaml";
import { getSkills, saveSkills } from "../services/data";
import { listInstalledSkills } from "../services/clawhub";
import {
  approveSkill as approveAutoSkill,
  rejectSkill as rejectAutoSkill,
  getProposedDiff,
  runAutoSkillUpdate,
} from "../services/skillAutoUpdater";

const CUSTOM_SKILLS_DIR = path.resolve("skills");
const CLAWHUB_SKILLS_DIR = path.resolve("Tiger_bot/skills");

function slugifySkillName(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Locate a skill's on-disk folder by trying the registry script, raw name, and slugified name across both skill directories. */
function resolveSkillDir(name: string, script?: string): { dir: string; source: "custom" | "clawhub" } | null {
  const candidates = Array.from(new Set([name, script, slugifySkillName(name)].filter(Boolean) as string[]));
  for (const cand of candidates) {
    for (const [dir, source] of [[CUSTOM_SKILLS_DIR, "custom"], [CLAWHUB_SKILLS_DIR, "clawhub"]] as const) {
      const base = path.join(dir, cand);
      if (fs.existsSync(path.join(base, "SKILL.md"))) return { dir: base, source };
    }
  }
  return null;
}

function listSkillFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, prefix: string) => {
    try {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name.startsWith(".") || e.name === "__MACOSX") continue;
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(d, e.name), rel);
        else out.push(rel);
      }
    } catch {}
  };
  walk(dir, "");
  return out;
}

/** Parse SKILL.md frontmatter and return name + description */
function parseFrontmatter(content: string): { name: string; description: string } {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fmMatch) return { name: "", description: "" };
  let parsed: any;
  try {
    parsed = yaml.load(fmMatch[1]);
  } catch {
    return { name: "", description: "" };
  }
  if (!parsed || typeof parsed !== "object") return { name: "", description: "" };
  const normalize = (v: any) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
  return {
    name: normalize(parsed.name),
    description: normalize(parsed.description),
  };
}

export async function skillsRoutes(fastify: FastifyInstance) {
  await fastify.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });

  fastify.get("/", async (request, reply) => {
    const skills = await getSkills();
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
      if (changed) await saveSkills(skills);
    } catch {}
    return skills;
  });

  // Install skill
  fastify.post("/", async (request, reply) => {
    const skills = await getSkills();
    const body = request.body as any;
    const skill = {
      id: uuid(),
      name: body.name || "Untitled Skill",
      description: body.description || "",
      source: body.source || "custom",
      script: body.script || "",
      enabled: true,
      installedAt: new Date().toISOString(),
    };
    skills.push(skill);
    await saveSkills(skills);
    return skill;
  });

  // Toggle or update skill
  fastify.patch("/:id", async (request, reply) => {
    const skills = await getSkills();
    const idx = skills.findIndex((s) => s.id === (request.params as any).id);
    if (idx < 0) { reply.code(404); return { error: "Not found" }; }
    Object.assign(skills[idx], request.body as any);
    await saveSkills(skills);
    return skills[idx];
  });

  // Uninstall
  fastify.delete("/:id", async (request, reply) => {
    let skills = await getSkills();
    skills = skills.filter((s) => s.id !== (request.params as any).id);
    await saveSkills(skills);
    return { success: true };
  });

  // Upload skill — accepts SKILL.md file or .zip folder
  fastify.post("/upload", async (request, reply) => {
    try {
      const data = await request.file();
      if (!data) { reply.code(400); return { error: "No file uploaded" }; }

      const buffer = await data.toBuffer();
      const originalname = data.filename;
      const ext = path.extname(originalname).toLowerCase();
      let name = "";
      let description = "";

      if (ext === ".zip") {
        // --- ZIP upload: extract entire folder as a skill ---
        const zip = new AdmZip(buffer);
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
          name = path.basename(originalname, ".zip");
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

          // Zip-slip guard: an entry like "foo/../../evil" resolves outside
          // skillDir (the leading-dot check above misses mid-path "..").
          const destPath = path.resolve(skillDir, relativePath);
          if (destPath !== skillDir && !destPath.startsWith(skillDir + path.sep)) continue;
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
        const skills = await getSkills();
        const existing = skills.find((s) => s.name === name && s.source === "custom");
        if (existing) {
          existing.script = name;
          existing.description = description || existing.description;
          await saveSkills(skills);
          return { ...existing, fileCount };
        }

        const skill = {
          id: uuid(),
          name,
          description: description || `Custom skill from ${originalname}`,
          source: "custom" as const,
          script: name,
          enabled: true,
          installedAt: new Date().toISOString(),
        };
        skills.push(skill);
        await saveSkills(skills);
        return { ...skill, fileCount };

      } else {
        // --- Single SKILL.md file upload (existing behavior) ---
        const content = buffer.toString("utf-8");
        const parsed = parseFrontmatter(content);
        name = parsed.name;
        description = parsed.description;

        if (!name) {
          name = path.basename(originalname, path.extname(originalname));
        }

        const skillDir = path.join(process.cwd(), "skills", name.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase());
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(path.join(skillDir, "SKILL.md"), content, "utf-8");

        const skills = await getSkills();
        const existing = skills.find((s) => s.name === name && s.source === "custom");
        if (existing) {
          existing.script = name;
          existing.description = description || existing.description;
          await saveSkills(skills);
          return existing;
        }

        const skill = {
          id: uuid(),
          name,
          description: description || `Custom skill from ${originalname}`,
          source: "custom" as const,
          script: name,
          enabled: true,
          installedAt: new Date().toISOString(),
        };
        skills.push(skill);
        await saveSkills(skills);
        return skill;
      }
    } catch (err: any) {
      reply.code(500); return { error: err.message };
    }
  });

  // ── Auto-generated skill review endpoints ──
  fastify.post("/auto/run-now", async (_request, reply) => {
    try {
      const summary = await runAutoSkillUpdate({ manual: true });
      return { ok: true, ...summary };
    } catch (err: any) {
      reply.code(500);
      return { ok: false, error: err.message };
    }
  });

  fastify.post("/:id/approve", async (request, reply) => {
    const id = (request.params as any).id;
    const result = await approveAutoSkill(id);
    if (!result.ok) { reply.code(400); return result; }
    return result;
  });

  fastify.post("/:id/reject", async (request, reply) => {
    const id = (request.params as any).id;
    const result = await rejectAutoSkill(id);
    if (!result.ok) { reply.code(400); return result; }
    return result;
  });

  fastify.get("/:id/proposed-diff", async (request, reply) => {
    const id = (request.params as any).id;
    const result = await getProposedDiff(id);
    if (!result.ok) { reply.code(400); return result; }
    return result;
  });

  // Read SKILL.md content + supporting file list for a skill (View action)
  fastify.get("/:id/content", async (request, reply) => {
    const id = (request.params as any).id;
    const skills = await getSkills();
    const skill = skills.find((s) => s.id === id);
    if (!skill) { reply.code(404); return { ok: false, error: "Skill not found" }; }
    const resolved = resolveSkillDir(skill.name, skill.script);
    if (!resolved) {
      return { ok: false, error: `No SKILL.md on disk for "${skill.name}". Tried ${CUSTOM_SKILLS_DIR} and ${CLAWHUB_SKILLS_DIR}.` };
    }
    let content = "";
    try {
      content = fs.readFileSync(path.join(resolved.dir, "SKILL.md"), "utf-8");
    } catch (err: any) {
      reply.code(500); return { ok: false, error: `Failed to read SKILL.md: ${err.message}` };
    }
    const supportingFiles = listSkillFiles(resolved.dir).filter((f) => f !== "SKILL.md");
    return {
      ok: true,
      name: skill.name,
      source: resolved.source,
      skillDir: resolved.dir,
      content,
      supportingFiles,
    };
  });

  // Download a skill: single SKILL.md if it's the only file, otherwise zip the whole folder
  fastify.get("/:id/download", async (request, reply) => {
    const id = (request.params as any).id;
    const skills = await getSkills();
    const skill = skills.find((s) => s.id === id);
    if (!skill) { reply.code(404); return reply.send({ ok: false, error: "Skill not found" }); }
    const resolved = resolveSkillDir(skill.name, skill.script);
    if (!resolved) {
      reply.code(404);
      return reply.send({ ok: false, error: `No SKILL.md on disk for "${skill.name}"` });
    }
    const safeName = slugifySkillName(skill.name) || "skill";
    const files = listSkillFiles(resolved.dir);

    if (files.length === 1 && files[0] === "SKILL.md") {
      const buf = fs.readFileSync(path.join(resolved.dir, "SKILL.md"));
      reply.header("Content-Type", "text/markdown; charset=utf-8");
      reply.header("Content-Disposition", `attachment; filename="${safeName}.SKILL.md"`);
      return reply.send(buf);
    }

    const zip = new AdmZip();
    for (const rel of files) {
      const abs = path.join(resolved.dir, rel);
      try {
        const data = fs.readFileSync(abs);
        const insideName = `${safeName}/${rel}`;
        zip.addFile(insideName, data);
      } catch {}
    }
    const buf = zip.toBuffer();
    reply.header("Content-Type", "application/zip");
    reply.header("Content-Disposition", `attachment; filename="${safeName}.zip"`);
    return reply.send(buf);
  });

  // Browse available skills (Claude / OpenClaw catalog)
  fastify.get("/catalog", async (request, reply) => {
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
    return catalog;
  });
}
