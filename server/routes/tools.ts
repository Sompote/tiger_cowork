import { Router } from "express";
import { getSettings } from "../services/data";

export const toolsRouter = Router();

// Web search proxy
toolsRouter.post("/web-search", async (req, res) => {
  const settings = getSettings();
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: "query required" });

  if (!settings.webSearchEnabled) {
    return res.status(400).json({ error: "Web search not enabled. Configure in Settings." });
  }

  try {
    // Support multiple search engines
    const engine = settings.webSearchEngine || "duckduckgo";
    let results: any[] = [];

    if (engine === "duckduckgo") {
      const response = await fetch(
        `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`
      );
      const data = await response.json();
      results = (data.RelatedTopics || []).slice(0, 5).map((t: any) => ({
        title: t.Text?.slice(0, 80),
        url: t.FirstURL,
        snippet: t.Text,
      }));
    } else if (engine === "google" && settings.webSearchApiKey) {
      const cx = settings.googleSearchCx || "";
      const response = await fetch(
        `https://www.googleapis.com/customsearch/v1?key=${settings.webSearchApiKey}&cx=${cx}&q=${encodeURIComponent(query)}`
      );
      const data = await response.json();
      results = (data.items || []).slice(0, 5).map((item: any) => ({
        title: item.title,
        url: item.link,
        snippet: item.snippet,
      }));
    }

    res.json({ results });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Fetch a URL (internet access for the AI)
toolsRouter.post("/fetch", async (req, res) => {
  const { url, method, headers, body } = req.body;
  if (!url) return res.status(400).json({ error: "url required" });
  try {
    const response = await fetch(url, {
      method: method || "GET",
      headers: headers || {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const contentType = response.headers.get("content-type") || "";
    let data: any;
    if (contentType.includes("json")) {
      data = await response.json();
    } else {
      data = await response.text();
      // Truncate very large HTML responses
      if (typeof data === "string" && data.length > 50000) {
        data = data.slice(0, 50000) + "\n...(truncated)";
      }
    }
    res.json({ ok: response.ok, status: response.status, data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// MCP tool proxy
toolsRouter.post("/mcp/:toolName", async (req, res) => {
  const settings = getSettings();
  const tool = settings.mcpTools?.find((t) => t.name === req.params.toolName && t.enabled);
  if (!tool) return res.status(404).json({ error: "Tool not found or disabled" });

  try {
    const response = await fetch(tool.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
