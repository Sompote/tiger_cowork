import { useState, useEffect } from "react";
import { api } from "../utils/api";
import "./PageStyles.css";

interface McpStatus {
  name: string;
  connected: boolean;
  toolCount: number;
  tools: string[];
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<any>({});
  const [saved, setSaved] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [newTool, setNewTool] = useState({ name: "", url: "" });
  const [mcpStatuses, setMcpStatuses] = useState<McpStatus[]>([]);
  const [mcpConnecting, setMcpConnecting] = useState<string | null>(null);
  const [mcpMessage, setMcpMessage] = useState<{ name: string; text: string; ok: boolean } | null>(null);

  useEffect(() => {
    api.getSettings().then(setSettings);
    api.mcpStatus().then(setMcpStatuses).catch(() => {});
  }, []);

  const save = async () => {
    await api.saveSettings(settings);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const testConnection = async () => {
    setTestResult(null);
    const result = await api.testConnection({
      apiKey: settings.tigerBotApiKey,
      apiUrl: settings.tigerBotApiUrl,
      model: settings.tigerBotModel,
    });
    setTestResult(result);
  };

  const addTool = () => {
    if (!newTool.name || !newTool.url) return;
    const tools = [...(settings.mcpTools || []), { ...newTool, enabled: true }];
    setSettings({ ...settings, mcpTools: tools });
    setNewTool({ name: "", url: "" });
  };

  const removeTool = (idx: number) => {
    const tools = [...(settings.mcpTools || [])];
    tools.splice(idx, 1);
    setSettings({ ...settings, mcpTools: tools });
  };

  const toggleTool = (idx: number) => {
    const tools = [...(settings.mcpTools || [])];
    tools[idx].enabled = !tools[idx].enabled;
    setSettings({ ...settings, mcpTools: tools });
  };

  const connectMcp = async (tool: { name: string; url: string }) => {
    setMcpConnecting(tool.name);
    setMcpMessage(null);
    try {
      const result = await api.mcpConnect(tool.name, tool.url);
      if (result.ok) {
        setMcpMessage({ name: tool.name, text: `Connected! ${result.tools} tools discovered`, ok: true });
      } else {
        setMcpMessage({ name: tool.name, text: result.error || "Connection failed", ok: false });
      }
      api.mcpStatus().then(setMcpStatuses).catch(() => {});
    } catch (err: any) {
      setMcpMessage({ name: tool.name, text: err.message, ok: false });
    }
    setMcpConnecting(null);
  };

  const disconnectMcp = async (name: string) => {
    await api.mcpDisconnect(name);
    setMcpMessage({ name, text: "Disconnected", ok: true });
    api.mcpStatus().then(setMcpStatuses).catch(() => {});
  };

  const reconnectAll = async () => {
    setMcpConnecting("__all__");
    // Save settings first so server has latest config
    await api.saveSettings(settings);
    const result = await api.mcpReconnectAll();
    setMcpStatuses(result.status || []);
    setMcpConnecting(null);
  };

  const getMcpStatusFor = (name: string): McpStatus | undefined => {
    return mcpStatuses.find((s) => s.name === name);
  };

  return (
    <div className="page">
      <div className="page-header">
        <h1>Settings</h1>
        <button className={`btn btn-primary ${saved ? "btn-success" : ""}`} onClick={save}>
          {saved ? "Saved!" : "Save changes"}
        </button>
      </div>

      <div className="settings-grid">
        <section className="card">
          <h3>TigerBot API</h3>
          <div className="form-group">
            <label>API Key</label>
            <input type="password" value={settings.tigerBotApiKey || ""} onChange={(e) => setSettings({ ...settings, tigerBotApiKey: e.target.value })} placeholder="Enter your TigerBot API key" />
          </div>
          <div className="form-group">
            <label>API URL</label>
            <input value={settings.tigerBotApiUrl || ""} onChange={(e) => setSettings({ ...settings, tigerBotApiUrl: e.target.value })} placeholder="https://api.tigerbot.com/bot-chat/openai/v1/chat/completions" />
          </div>
          <div className="form-group">
            <label>Model</label>
            <input value={settings.tigerBotModel || ""} onChange={(e) => setSettings({ ...settings, tigerBotModel: e.target.value })} placeholder="e.g. TigerBot-70B-Chat, gpt-4o, claude-sonnet-4-20250514" />
          </div>
          <div className="form-actions">
            <button className="btn btn-secondary" onClick={testConnection}>Test Connection</button>
            {testResult && (
              <span className={`test-result ${testResult.success ? "success" : "error"}`}>
                {testResult.message}
              </span>
            )}
          </div>
        </section>

        <section className="card">
          <h3>Sandbox</h3>
          <div className="form-group">
            <label>Sandbox Directory</label>
            <input value={settings.sandboxDir || ""} onChange={(e) => setSettings({ ...settings, sandboxDir: e.target.value })} />
            <p className="hint">All file operations are restricted to this directory</p>
          </div>
          <div className="form-group">
            <label>Python Path</label>
            <input value={settings.pythonPath || ""} onChange={(e) => setSettings({ ...settings, pythonPath: e.target.value })} placeholder="python3" />
          </div>
        </section>

        <section className="card">
          <h3>Web Search</h3>
          <div className="form-group">
            <label className="toggle-label">
              <input type="checkbox" checked={settings.webSearchEnabled || false} onChange={(e) => setSettings({ ...settings, webSearchEnabled: e.target.checked })} />
              <span>Enable web search</span>
            </label>
          </div>
          <div className="form-group">
            <label>Search Engine</label>
            <select value={settings.webSearchEngine || "duckduckgo"} onChange={(e) => setSettings({ ...settings, webSearchEngine: e.target.value })}>
              <option value="duckduckgo">DuckDuckGo (free)</option>
              <option value="google">Google Custom Search</option>
            </select>
          </div>
          {settings.webSearchEngine === "google" && (
            <>
              <div className="form-group">
                <label>Google API Key</label>
                <input type="password" value={settings.webSearchApiKey || ""} onChange={(e) => setSettings({ ...settings, webSearchApiKey: e.target.value })} />
              </div>
              <div className="form-group">
                <label>Google Search CX</label>
                <input value={settings.googleSearchCx || ""} onChange={(e) => setSettings({ ...settings, googleSearchCx: e.target.value })} />
              </div>
            </>
          )}
        </section>

        <section className="card">
          <h3>MCP Servers</h3>
          <p className="hint" style={{ marginBottom: 12 }}>
            Connect external tools via Model Context Protocol (MCP). Supports HTTP/SSE URLs or stdio commands.
          </p>

          {(settings.mcpTools || []).map((tool: any, idx: number) => {
            const status = getMcpStatusFor(tool.name);
            const isConnected = status?.connected;
            return (
              <div key={idx} className="tool-item" style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
                <label className="toggle-label" style={{ flex: 1 }}>
                  <input type="checkbox" checked={tool.enabled} onChange={() => toggleTool(idx)} />
                  <span>
                    <strong>{tool.name}</strong>
                    <span style={{ opacity: 0.6, fontSize: 12, marginLeft: 6 }}>{tool.url}</span>
                  </span>
                </label>
                {isConnected && (
                  <span style={{ fontSize: 11, color: "#137333", fontWeight: 600 }}>
                    {status!.toolCount} tools
                  </span>
                )}
                <span style={{
                  width: 8, height: 8, borderRadius: "50%",
                  background: isConnected ? "#34a853" : "#ea4335",
                  display: "inline-block",
                }} title={isConnected ? "Connected" : "Disconnected"} />
                {!isConnected ? (
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => connectMcp(tool)}
                    disabled={mcpConnecting === tool.name}
                  >
                    {mcpConnecting === tool.name ? "..." : "Connect"}
                  </button>
                ) : (
                  <button className="btn btn-ghost btn-sm" onClick={() => disconnectMcp(tool.name)}>
                    Disconnect
                  </button>
                )}
                <button className="btn btn-danger btn-sm" onClick={() => removeTool(idx)}>Remove</button>
                {mcpMessage && mcpMessage.name === tool.name && (
                  <span style={{ fontSize: 11, color: mcpMessage.ok ? "#137333" : "#c5221f" }}>
                    {mcpMessage.text}
                  </span>
                )}
              </div>
            );
          })}

          {/* Show discovered tools for connected servers */}
          {mcpStatuses.some((s) => s.connected && s.toolCount > 0) && (
            <details style={{ marginTop: 8, fontSize: 13 }}>
              <summary style={{ cursor: "pointer", opacity: 0.7 }}>Discovered MCP Tools</summary>
              <div style={{ padding: "8px 0", maxHeight: 200, overflow: "auto" }}>
                {mcpStatuses.filter((s) => s.connected).map((s) => (
                  <div key={s.name} style={{ marginBottom: 8 }}>
                    <strong>{s.name}</strong>
                    <div style={{ paddingLeft: 12, opacity: 0.7 }}>
                      {s.tools.map((t) => <div key={t}>{t}</div>)}
                    </div>
                  </div>
                ))}
              </div>
            </details>
          )}

          <div className="inline-form" style={{ marginTop: 8 }}>
            <input
              placeholder="Server name (e.g. github)"
              value={newTool.name}
              onChange={(e) => setNewTool({ ...newTool, name: e.target.value.replace(/\s+/g, "-").toLowerCase() })}
            />
            <input
              placeholder="URL or command (e.g. http://localhost:8080/mcp or npx @mcp/server)"
              value={newTool.url}
              onChange={(e) => setNewTool({ ...newTool, url: e.target.value })}
              style={{ flex: 2 }}
            />
            <button className="btn btn-secondary" onClick={addTool}>Add</button>
          </div>
          <div className="form-actions" style={{ marginTop: 8 }}>
            <button
              className="btn btn-primary"
              onClick={reconnectAll}
              disabled={mcpConnecting === "__all__"}
            >
              {mcpConnecting === "__all__" ? "Reconnecting..." : "Save & Connect All"}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
