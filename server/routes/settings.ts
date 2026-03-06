import { Router } from "express";
import { getSettings, saveSettings } from "../services/data";
import { connectServer, disconnectServer, getMcpStatus, initMcpServers } from "../services/mcp";

export const settingsRouter = Router();

settingsRouter.get("/", (_req, res) => {
  const settings = getSettings();
  // Mask API key for security
  const masked = { ...settings };
  if (masked.tigerBotApiKey) {
    masked.tigerBotApiKey = masked.tigerBotApiKey.slice(0, 8) + "..." + masked.tigerBotApiKey.slice(-4);
  }
  if (masked.webSearchApiKey) {
    masked.webSearchApiKey = masked.webSearchApiKey.slice(0, 8) + "..." + masked.webSearchApiKey.slice(-4);
  }
  res.json(masked);
});

settingsRouter.put("/", (req, res) => {
  const current = getSettings();
  const updated = { ...current, ...req.body };
  // Don't overwrite keys with masked values
  if (req.body.tigerBotApiKey?.includes("...")) {
    updated.tigerBotApiKey = current.tigerBotApiKey;
  }
  if (req.body.webSearchApiKey?.includes("...")) {
    updated.webSearchApiKey = current.webSearchApiKey;
  }
  saveSettings(updated);
  res.json({ success: true });
});

// Test API connection
settingsRouter.post("/test-connection", async (req, res) => {
  const { apiKey, apiUrl, model } = req.body;
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
      res.json({ success: true, message: "Connection successful" });
    } else {
      const err = await response.text();
      res.json({ success: false, message: `Error ${response.status}: ${err}` });
    }
  } catch (err: any) {
    res.json({ success: false, message: err.message });
  }
});

// --- MCP Server Management ---

// Get status of all MCP connections
settingsRouter.get("/mcp/status", (_req, res) => {
  res.json(getMcpStatus());
});

// Connect to a single MCP server
settingsRouter.post("/mcp/connect", async (req, res) => {
  const { name, url } = req.body;
  if (!name || !url) return res.status(400).json({ error: "name and url required" });
  const result = await connectServer({ name, url, enabled: true });
  res.json(result);
});

// Disconnect a single MCP server
settingsRouter.post("/mcp/disconnect", async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "name required" });
  await disconnectServer(name);
  res.json({ ok: true });
});

// Reconnect all MCP servers from settings
settingsRouter.post("/mcp/reconnect-all", async (_req, res) => {
  await initMcpServers();
  res.json({ ok: true, status: getMcpStatus() });
});
