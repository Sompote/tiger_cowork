import { FastifyInstance } from "fastify";
import { getSettings, saveSettings, getFileTokens, saveFileTokens, generateToken } from "../services/data";
import { connectServer, disconnectServer, getMcpStatus, initMcpServers } from "../services/mcp";

export async function settingsRoutes(fastify: FastifyInstance) {
  fastify.get("/", async (request, reply) => {
    const settings = await getSettings();
    // Mask API key for security
    const masked = { ...settings };
    if (masked.tigerBotApiKey) {
      masked.tigerBotApiKey = masked.tigerBotApiKey.slice(0, 8) + "..." + masked.tigerBotApiKey.slice(-4);
    }
    if (masked.webSearchApiKey) {
      masked.webSearchApiKey = masked.webSearchApiKey.slice(0, 8) + "..." + masked.webSearchApiKey.slice(-4);
    }
    if (masked.openRouterSearchApiKey) {
      masked.openRouterSearchApiKey = masked.openRouterSearchApiKey.slice(0, 8) + "..." + masked.openRouterSearchApiKey.slice(-4);
    }
    return masked;
  });

  fastify.put("/", async (request, reply) => {
    const current = await getSettings();
    const body = request.body as any;
    const updated = { ...current, ...body };
    // Don't overwrite keys with masked values
    if (body.tigerBotApiKey?.includes("...")) {
      updated.tigerBotApiKey = current.tigerBotApiKey;
    }
    if (body.webSearchApiKey?.includes("...")) {
      updated.webSearchApiKey = current.webSearchApiKey;
    }
    if (body.openRouterSearchApiKey?.includes("...")) {
      updated.openRouterSearchApiKey = current.openRouterSearchApiKey;
    }
    await saveSettings(updated);
    return { success: true };
  });

  // Test API connection
  fastify.post("/test-connection", async (request, reply) => {
    const { apiKey, apiUrl, model } = request.body as any;
    try {
      const url = apiUrl || "https://api.tigerbot.com/bot-chat/openai/v1/chat/completions";
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: model || "TigerBot-70B-Chat",
          messages: [{ role: "user", content: "Hello" }],
          max_tokens: 10,
        }),
      });
      if (response.ok) {
        return { success: true, message: "Connection successful" };
      } else {
        const err = await response.text();
        return { success: false, message: `Error ${response.status}: ${err}` };
      }
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  });

  // --- File Access Tokens ---

  fastify.get("/file-tokens", async (request, reply) => {
    const tokens = await getFileTokens();
    return tokens;
  });

  fastify.post("/file-tokens", async (request, reply) => {
    const { name } = request.body as any;
    const tokens = await getFileTokens();
    const newToken = {
      id: Date.now().toString(36),
      name: name || `Token ${tokens.length + 1}`,
      token: generateToken(),
      createdAt: new Date().toISOString(),
    };
    tokens.push(newToken);
    await saveFileTokens(tokens);
    return newToken;
  });

  fastify.delete("/file-tokens/:id", async (request, reply) => {
    let tokens = await getFileTokens();
    tokens = tokens.filter((t) => t.id !== (request.params as any).id);
    await saveFileTokens(tokens);
    return { success: true };
  });

  fastify.post("/file-tokens/:id/regenerate", async (request, reply) => {
    const tokens = await getFileTokens();
    const token = tokens.find((t) => t.id === (request.params as any).id);
    if (!token) { reply.code(404); return { error: "Token not found" }; }
    token.token = generateToken();
    await saveFileTokens(tokens);
    return token;
  });

  // --- MCP Server Management ---

  // Get status of all MCP connections
  fastify.get("/mcp/status", async (request, reply) => {
    return getMcpStatus();
  });

  // Connect to a single MCP server
  fastify.post("/mcp/connect", async (request, reply) => {
    const { name, url } = request.body as any;
    if (!name || !url) { reply.code(400); return { error: "name and url required" }; }
    const result = await connectServer({ name, url, enabled: true });
    return result;
  });

  // Disconnect a single MCP server
  fastify.post("/mcp/disconnect", async (request, reply) => {
    const { name } = request.body as any;
    if (!name) { reply.code(400); return { error: "name required" }; }
    await disconnectServer(name);
    return { ok: true };
  });

  // Reconnect all MCP servers from settings
  fastify.post("/mcp/reconnect-all", async (request, reply) => {
    await initMcpServers();
    return { ok: true, status: getMcpStatus() };
  });
}
