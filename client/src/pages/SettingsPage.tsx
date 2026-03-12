import { useState, useEffect } from "react";
import { api } from "../utils/api";
import "./PageStyles.css";

interface McpStatus {
  name: string;
  connected: boolean;
  toolCount: number;
  tools: string[];
}

interface FileToken {
  id: string;
  name: string;
  token: string;
  createdAt: string;
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<any>({});
  const [saved, setSaved] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [newTool, setNewTool] = useState({ name: "", url: "" });
  const [mcpStatuses, setMcpStatuses] = useState<McpStatus[]>([]);
  const [mcpConnecting, setMcpConnecting] = useState<string | null>(null);
  const [mcpMessage, setMcpMessage] = useState<{ name: string; text: string; ok: boolean } | null>(null);
  const [fileTokens, setFileTokens] = useState<FileToken[]>([]);
  const [newTokenName, setNewTokenName] = useState("");
  const [copiedTokenId, setCopiedTokenId] = useState<string | null>(null);
  const [showTokenId, setShowTokenId] = useState<string | null>(null);

  useEffect(() => {
    api.getSettings().then(setSettings);
    api.mcpStatus().then(setMcpStatuses).catch(() => {});
    api.getFileTokens().then(setFileTokens).catch(() => {});
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

  const createFileToken = async () => {
    const token = await api.createFileToken(newTokenName || `Token ${fileTokens.length + 1}`);
    setFileTokens([...fileTokens, token]);
    setNewTokenName("");
  };

  const deleteFileToken = async (id: string) => {
    if (!confirm("Delete this file access token? Any links using it will stop working.")) return;
    await api.deleteFileToken(id);
    setFileTokens(fileTokens.filter((t) => t.id !== id));
  };

  const regenerateFileToken = async (id: string) => {
    if (!confirm("Regenerate this token? The old token will stop working immediately.")) return;
    const updated = await api.regenerateFileToken(id);
    setFileTokens(fileTokens.map((t) => (t.id === id ? updated : t)));
  };

  const copyToken = (id: string, token: string) => {
    navigator.clipboard.writeText(token);
    setCopiedTokenId(id);
    setTimeout(() => setCopiedTokenId(null), 2000);
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
          <h3>OpenRouter Web Search</h3>
          <p className="hint" style={{ marginBottom: 12 }}>
            Use OpenRouter's Responses API as a web search tool for the agent. Requires an OpenRouter API key.
          </p>
          <div className="form-group">
            <label className="toggle-label">
              <input type="checkbox" checked={settings.openRouterSearchEnabled || false} onChange={(e) => setSettings({ ...settings, openRouterSearchEnabled: e.target.checked })} />
              <span>Enable OpenRouter Web Search</span>
            </label>
          </div>
          {settings.openRouterSearchEnabled && (
            <>
              <div className="form-group">
                <label>API Key</label>
                <input type="password" value={settings.openRouterSearchApiKey || ""} onChange={(e) => setSettings({ ...settings, openRouterSearchApiKey: e.target.value })} placeholder="sk-or-v1-..." />
              </div>
              <div className="form-group">
                <label>Model</label>
                <input value={settings.openRouterSearchModel || ""} onChange={(e) => setSettings({ ...settings, openRouterSearchModel: e.target.value })} placeholder="openai/gpt-4.1-mini (default)" />
                <p className="hint">OpenRouter model to use for web search. Must support the web search plugin.</p>
              </div>
              <div className="form-group">
                <label>Max Output Tokens</label>
                <input type="number" value={settings.openRouterSearchMaxTokens || 4096} onChange={(e) => setSettings({ ...settings, openRouterSearchMaxTokens: parseInt(e.target.value) || 4096 })} min={100} max={32000} />
              </div>
              <div className="form-group">
                <label>Max Search Results (1-10)</label>
                <input type="number" value={settings.openRouterSearchMaxResults || 5} onChange={(e) => setSettings({ ...settings, openRouterSearchMaxResults: Math.min(10, Math.max(1, parseInt(e.target.value) || 5)) })} min={1} max={10} />
              </div>
            </>
          )}
        </section>

        <section className="card">
          <h3>Agent Parameters</h3>
          <p className="hint" style={{ marginBottom: 12 }}>
            Controls how many tool calls and rounds the AI agent can use per conversation turn. Increase for complex research tasks.
          </p>
          <div className="form-group">
            <label>Max Tool Rounds</label>
            <input type="number" value={settings.agentMaxToolRounds || 8} onChange={(e) => setSettings({ ...settings, agentMaxToolRounds: Math.max(1, parseInt(e.target.value) || 8) })} min={1} max={50} />
            <p className="hint">Maximum iterations of the tool-calling loop (default: 8)</p>
          </div>
          <div className="form-group">
            <label>Max Tool Calls</label>
            <input type="number" value={settings.agentMaxToolCalls || 12} onChange={(e) => setSettings({ ...settings, agentMaxToolCalls: Math.max(1, parseInt(e.target.value) || 12) })} min={1} max={100} />
            <p className="hint">Maximum total tool calls per turn (default: 12)</p>
          </div>
          <div className="form-group">
            <label>Max Consecutive Errors</label>
            <input type="number" value={settings.agentMaxConsecutiveErrors || 3} onChange={(e) => setSettings({ ...settings, agentMaxConsecutiveErrors: Math.max(1, parseInt(e.target.value) || 3) })} min={1} max={20} />
            <p className="hint">Stop after this many consecutive tool failures (default: 3)</p>
          </div>
          <div className="form-group">
            <label>Tool Result Max Length</label>
            <input type="number" value={settings.agentToolResultMaxLen || 6000} onChange={(e) => setSettings({ ...settings, agentToolResultMaxLen: Math.max(1000, parseInt(e.target.value) || 6000) })} min={1000} max={50000} step={1000} />
            <p className="hint">Max characters per tool result before truncation (default: 6000)</p>
          </div>
          <div className="form-group">
            <label>Temperature</label>
            <input type="number" value={settings.agentTemperature ?? 0.7} onChange={(e) => setSettings({ ...settings, agentTemperature: Math.min(2, Math.max(0, parseFloat(e.target.value) || 0)) })} min={0} max={2} step={0.1} />
            <p className="hint">LLM temperature (0 = deterministic, 2 = very creative, default: 0.7)</p>
          </div>
        </section>

        <section className="card">
          <h3>Sub-Agent</h3>
          <p className="hint" style={{ marginBottom: 12 }}>
            Allow the AI to spawn independent sub-agents for complex tasks. Sub-agents run their own tool-calling loop and return results to the parent agent. Useful for parallel research, multi-step analysis, or breaking down large tasks.
          </p>
          <div className="form-group">
            <label className="toggle-label">
              <input type="checkbox" checked={settings.subAgentEnabled || false} onChange={(e) => setSettings({ ...settings, subAgentEnabled: e.target.checked })} />
              <span>Enable Sub-Agent Spawning</span>
            </label>
          </div>
          {settings.subAgentEnabled && (
            <>
              <div className="form-group">
                <label>Sub-Agent Model (optional)</label>
                <input value={settings.subAgentModel || ""} onChange={(e) => setSettings({ ...settings, subAgentModel: e.target.value })} placeholder="Leave empty to use main model" />
                <p className="hint">Override the LLM model for sub-agents (e.g. use a smaller/cheaper model)</p>
              </div>
              <div className="form-group">
                <label>Max Depth</label>
                <input type="number" value={settings.subAgentMaxDepth ?? 2} onChange={(e) => setSettings({ ...settings, subAgentMaxDepth: Math.min(5, Math.max(1, parseInt(e.target.value) || 2)) })} min={1} max={5} />
                <p className="hint">How many levels deep sub-agents can spawn other sub-agents (default: 2, max: 5)</p>
              </div>
              <div className="form-group">
                <label>Max Concurrent Sub-Agents</label>
                <input type="number" value={settings.subAgentMaxConcurrent ?? 3} onChange={(e) => setSettings({ ...settings, subAgentMaxConcurrent: Math.min(10, Math.max(1, parseInt(e.target.value) || 3)) })} min={1} max={10} />
                <p className="hint">Maximum sub-agents running at the same time (default: 3)</p>
              </div>
              <div className="form-group">
                <label>Timeout (seconds)</label>
                <input type="number" value={settings.subAgentTimeout ?? 120} onChange={(e) => setSettings({ ...settings, subAgentTimeout: Math.min(600, Math.max(30, parseInt(e.target.value) || 120)) })} min={30} max={600} step={10} />
                <p className="hint">Max time per sub-agent before timeout (default: 120s, max: 600s)</p>
              </div>
            </>
          )}
        </section>

        <section className="card">
          <h3>Reflection Loop Check</h3>
          <p className="hint" style={{ marginBottom: 12 }}>
            After the agent finishes, evaluate if the result satisfies the objective. If the score is below the threshold, the agent retries to address gaps. Disable to save tokens.
          </p>
          <div className="form-group">
            <label className="toggle-label">
              <input type="checkbox" checked={settings.agentReflectionEnabled || false} onChange={(e) => setSettings({ ...settings, agentReflectionEnabled: e.target.checked })} />
              <span>Enable Reflection Loop</span>
            </label>
          </div>
          {settings.agentReflectionEnabled && (
            <>
              <div className="form-group">
                <label>Evaluation Score Threshold</label>
                <input type="number" value={settings.agentEvalThreshold ?? 0.7} onChange={(e) => setSettings({ ...settings, agentEvalThreshold: Math.min(1, Math.max(0, parseFloat(e.target.value) || 0.7)) })} min={0} max={1} step={0.05} />
                <p className="hint">Minimum score (0.0–1.0) to consider objective satisfied (default: 0.7)</p>
              </div>
              <div className="form-group">
                <label>Max Reflection Retries</label>
                <input type="number" value={settings.agentMaxReflectionRetries ?? 2} onChange={(e) => setSettings({ ...settings, agentMaxReflectionRetries: Math.min(5, Math.max(1, parseInt(e.target.value) || 2)) })} min={1} max={5} />
                <p className="hint">How many times to re-evaluate and retry (default: 2, max: 5)</p>
              </div>
            </>
          )}
        </section>

        <section className="card">
          <h3>File Access Tokens</h3>
          <p className="hint" style={{ marginBottom: 12 }}>
            Tokens protect sandbox file access. Without a valid token, external users cannot view or download files via the port.
            Share a token only with people you want to grant file access.
          </p>

          {fileTokens.map((ft) => (
            <div key={ft.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
              <div style={{ flex: 1 }}>
                <strong>{ft.name}</strong>
                <div style={{ fontFamily: "monospace", fontSize: 12, marginTop: 2, color: "var(--text-muted)" }}>
                  {showTokenId === ft.id ? ft.token : ft.token.slice(0, 8) + "••••••••" + ft.token.slice(-4)}
                </div>
                <div style={{ fontSize: 11, opacity: 0.5 }}>
                  Created: {new Date(ft.createdAt).toLocaleDateString()}
                </div>
              </div>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setShowTokenId(showTokenId === ft.id ? null : ft.id)}
                title={showTokenId === ft.id ? "Hide" : "Show"}
              >
                {showTokenId === ft.id ? "Hide" : "Show"}
              </button>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => copyToken(ft.id, ft.token)}
              >
                {copiedTokenId === ft.id ? "Copied!" : "Copy"}
              </button>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => regenerateFileToken(ft.id)}
              >
                Regenerate
              </button>
              <button
                className="btn btn-danger btn-sm"
                onClick={() => deleteFileToken(ft.id)}
              >
                Delete
              </button>
            </div>
          ))}

          {fileTokens.length === 0 && (
            <div style={{ padding: "12px 0", opacity: 0.6 }}>No file tokens yet. Create one to secure file access.</div>
          )}

          <div className="inline-form" style={{ marginTop: 8 }}>
            <input
              placeholder="Token name (e.g. Team, Public)"
              value={newTokenName}
              onChange={(e) => setNewTokenName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && createFileToken()}
            />
            <button className="btn btn-primary" onClick={createFileToken}>Create Token</button>
          </div>
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
