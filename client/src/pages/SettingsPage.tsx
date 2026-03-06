import { useState, useEffect } from "react";
import { api } from "../utils/api";
import "./PageStyles.css";

export default function SettingsPage() {
  const [settings, setSettings] = useState<any>({});
  const [saved, setSaved] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [newTool, setNewTool] = useState({ name: "", url: "" });

  useEffect(() => {
    api.getSettings().then(setSettings);
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
          <h3>MCP Tools</h3>
          <p className="hint" style={{ marginBottom: 12 }}>Connect external tools via MCP protocol</p>
          {(settings.mcpTools || []).map((tool: any, idx: number) => (
            <div key={idx} className="tool-item">
              <label className="toggle-label">
                <input type="checkbox" checked={tool.enabled} onChange={() => toggleTool(idx)} />
                <span><strong>{tool.name}</strong> — {tool.url}</span>
              </label>
              <button className="btn btn-danger btn-sm" onClick={() => removeTool(idx)}>Remove</button>
            </div>
          ))}
          <div className="inline-form">
            <input placeholder="Tool name" value={newTool.name} onChange={(e) => setNewTool({ ...newTool, name: e.target.value })} />
            <input placeholder="Tool URL" value={newTool.url} onChange={(e) => setNewTool({ ...newTool, url: e.target.value })} style={{ flex: 2 }} />
            <button className="btn btn-secondary" onClick={addTool}>Add</button>
          </div>
        </section>
      </div>
    </div>
  );
}
