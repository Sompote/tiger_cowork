import { FastifyInstance } from "fastify";
import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { getProtocolStatus } from "../services/protocols";
import { getSettings } from "../services/data";
import { callTigerBotWithTools } from "../services/tigerbot";

const AGENTS_DIR = path.resolve("data/agents");

// Ensure agents directory exists
if (!fs.existsSync(AGENTS_DIR)) {
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
}

export async function agentsRoutes(fastify: FastifyInstance) {
  // List all agent YAML configs
  fastify.get("/", async (request, reply) => {
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
      return files;
    } catch (err: any) {
      return [];
    }
  });

  // Get a specific agent config
  fastify.get("/:filename", async (request, reply) => {
    const filename = (request.params as any).filename;
    if (!filename.match(/^[\w\-. ]+\.ya?ml$/)) {
      reply.code(400); return { error: "Invalid filename" };
    }
    const fp = path.join(AGENTS_DIR, filename);
    if (!fs.existsSync(fp)) {
      reply.code(404); return { error: "File not found" };
    }
    const content = fs.readFileSync(fp, "utf8");
    let parsed: any = {};
    try { parsed = yaml.load(content); } catch {}
    return { filename, content, parsed };
  });

  // Save agent config (create or update)
  fastify.post("/", async (request, reply) => {
    const { filename, content } = request.body as any;
    if (!filename || !content) {
      reply.code(400); return { error: "filename and content required" };
    }
    const safeName = filename.replace(/[^a-zA-Z0-9_\-. ]/g, "");
    const finalName = safeName.endsWith(".yaml") || safeName.endsWith(".yml")
      ? safeName
      : safeName + ".yaml";

    // Validate YAML
    try {
      yaml.load(content);
    } catch (err: any) {
      reply.code(400); return { error: `Invalid YAML: ${err.message}` };
    }

    fs.writeFileSync(path.join(AGENTS_DIR, finalName), content, "utf8");
    return { ok: true, filename: finalName };
  });

  // Delete agent config
  fastify.delete("/:filename", async (request, reply) => {
    const filename = (request.params as any).filename;
    const fp = path.join(AGENTS_DIR, filename);
    if (fs.existsSync(fp)) {
      fs.unlinkSync(fp);
    }
    return { ok: true };
  });

  // Parse YAML content (utility endpoint)
  fastify.post("/parse", async (request, reply) => {
    try {
      const parsed = yaml.load((request.body as any).content);
      return { ok: true, parsed };
    } catch (err: any) {
      reply.code(400); return { ok: false, error: err.message };
    }
  });

  // Generate YAML from editor data
  fastify.post("/generate", async (request, reply) => {
    try {
      const data = request.body as any;
      const yamlContent = yaml.dump(data, {
        indent: 2,
        lineWidth: 120,
        noRefs: true,
        sortKeys: false,
      });
      return { ok: true, content: yamlContent };
    } catch (err: any) {
      reply.code(400); return { ok: false, error: err.message };
    }
  });

  // Generate agent definition using LLM
  fastify.post("/generate-definition", async (request, reply) => {
    const { description } = request.body as any;
    if (!description || typeof description !== "string") {
      reply.code(400); return { ok: false, error: "description is required" };
    }

    try {
      const result = await callTigerBotWithTools(
        [{ role: "user", content: `Based on this description, generate a JSON object for an agent definition.

Description: ${description}

Return ONLY a valid JSON object (no markdown, no code fences) with these fields:
- "name": string (short agent name)
- "role": one of ["orchestrator", "worker", "checker", "reporter", "researcher"]
- "persona": detailed persona description (2-3 sentences)
- "responsibilities": array of 3-5 responsibility strings

Example:
{"name": "Code Reviewer", "role": "checker", "persona": "You are a meticulous code reviewer who checks for bugs, security issues, and best practices.", "responsibilities": ["Review code for correctness", "Check for security vulnerabilities", "Suggest improvements"]}` }],
        "You are a helpful assistant that generates JSON agent definitions. Return ONLY valid JSON, nothing else. Do not use any tools.",
        undefined,
        undefined,
        undefined,
        [], // no tools
      );

      if (result.content) {
        let jsonStr = result.content.trim();
        const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
        if (jsonMatch) jsonStr = jsonMatch[0];
        try {
          const parsed = JSON.parse(jsonStr);
          return { ok: true, definition: parsed };
        } catch {
          return { ok: false, error: "Failed to parse LLM response", raw: result.content };
        }
      } else {
        return { ok: false, error: "No response from LLM" };
      }
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  });

  // Validate model availability by calling the provider's /models endpoint
  fastify.post("/validate-model", async (request, reply) => {
    const { model } = request.body as any;
    if (!model || typeof model !== "string") {
      reply.code(400); return { ok: false, error: "model is required" };
    }

    const settings = await getSettings();
    const apiKey = settings.tigerBotApiKey;
    if (!apiKey) {
      return { ok: false, error: "API key not configured", available: false };
    }

    const rawUrl = settings.tigerBotApiUrl || "https://api.tigerbot.com/bot-chat/openai/v1/chat/completions";
    // Derive /models endpoint from the API URL
    const modelsUrl = rawUrl.replace(/\/chat\/completions\/?$/, "/models").replace(/\/$/, "");

    try {
      const response = await fetch(modelsUrl, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      if (!response.ok) {
        // If /models endpoint is not available, we can't validate -- assume ok
        return { ok: true, available: true, warning: "Cannot list models from provider, model not validated" };
      }

      const data: any = await response.json();
      const models: string[] = (data.data || data.models || []).map((m: any) => typeof m === "string" ? m : m.id || m.name || "");
      const available = models.some((m: string) => m === model || m.includes(model) || model.includes(m));

      return { ok: true, available, models };
    } catch (err: any) {
      // Network error -- can't validate, assume ok
      return { ok: true, available: true, warning: `Could not reach models endpoint: ${err.message}` };
    }
  });

  // Protocol status endpoint
  fastify.get("/protocols/status", async (request, reply) => {
    return getProtocolStatus();
  });
}
