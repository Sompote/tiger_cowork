import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs";

const execFileAsync = promisify(execFile);
const TIGER_BOT_DIR = path.resolve("Tiger_bot");
const SKILLS_DIR = path.join(TIGER_BOT_DIR, "skills");

async function findClawhubBin(): Promise<string> {
  const local = path.join(TIGER_BOT_DIR, "node_modules", ".bin", "clawhub");
  for (const bin of [local, "clawhub"]) {
    try {
      await execFileAsync(bin, ["--cli-version"], { timeout: 5000 });
      return bin;
    } catch {}
  }
  throw new Error("clawhub CLI not found. Install with: npm i -g clawhub");
}

export async function clawhubSearch(query: string, limit = 10) {
  const bin = await findClawhubBin();
  const { stdout, stderr } = await execFileAsync(
    bin,
    ["search", query, "--limit", String(limit), "--no-input", "--workdir", TIGER_BOT_DIR, "--dir", "skills"],
    { timeout: 30000, maxBuffer: 1024 * 1024 }
  );
  return { ok: true, output: stdout.trim(), warning: stderr.trim() };
}

export async function clawhubInstall(slug: string, force = false) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    return { ok: false, error: "Invalid slug format" };
  }
  const bin = await findClawhubBin();
  const argv = ["install", slug, "--no-input", "--workdir", TIGER_BOT_DIR, "--dir", "skills"];
  if (force) argv.push("--force");

  const { stdout, stderr } = await execFileAsync(bin, argv, {
    timeout: 120000,
    maxBuffer: 1024 * 1024,
  });

  const skillPath = path.join(SKILLS_DIR, slug, "SKILL.md");
  return {
    ok: true,
    slug,
    installed: fs.existsSync(skillPath),
    output: stdout.trim(),
    warning: stderr.trim(),
  };
}

export function listInstalledSkills() {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  return fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const skillFile = path.join(SKILLS_DIR, d.name, "SKILL.md");
      const meta = path.join(SKILLS_DIR, d.name, "_meta.json");
      let description = "";
      if (fs.existsSync(meta)) {
        try {
          const m = JSON.parse(fs.readFileSync(meta, "utf-8"));
          description = m.description || "";
        } catch {}
      }
      return { name: d.name, installed: fs.existsSync(skillFile), description };
    });
}

export function readSkill(name: string): string | null {
  const skillFile = path.join(SKILLS_DIR, name, "SKILL.md");
  if (!fs.existsSync(skillFile)) return null;
  return fs.readFileSync(skillFile, "utf-8");
}
