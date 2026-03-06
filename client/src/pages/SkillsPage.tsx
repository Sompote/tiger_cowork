import { useState, useEffect } from "react";
import { api } from "../utils/api";
import "./PageStyles.css";

interface Skill {
  id?: string;
  name: string;
  description: string;
  source: string;
  script: string;
  enabled?: boolean;
  installedAt?: string;
}

export default function SkillsPage() {
  const [installed, setInstalled] = useState<Skill[]>([]);
  const [catalog, setCatalog] = useState<Skill[]>([]);
  const [tab, setTab] = useState<"installed" | "catalog" | "clawhub" | "custom">("installed");
  const [customForm, setCustomForm] = useState({ name: "", description: "", script: "" });
  const [clawhubQuery, setClawhubQuery] = useState("");
  const [clawhubResults, setClawhubResults] = useState("");
  const [clawhubLoading, setClawhubLoading] = useState(false);
  const [clawhubInstalling, setClawhubInstalling] = useState<string | null>(null);

  useEffect(() => {
    api.getSkills().then(setInstalled);
    api.getSkillCatalog().then(setCatalog);
  }, []);

  const searchClawhub = async () => {
    if (!clawhubQuery.trim()) return;
    setClawhubLoading(true);
    setClawhubResults("");
    try {
      const res = await api.clawhubSearch(clawhubQuery.trim(), 20);
      setClawhubResults(res.output || res.error || "No results");
    } catch (err: any) {
      setClawhubResults("Error: " + (err.message || "Search failed"));
    }
    setClawhubLoading(false);
  };

  const installFromClawhub = async (slug: string) => {
    setClawhubInstalling(slug);
    try {
      const res = await api.clawhubInstall(slug);
      if (res.ok) {
        setClawhubResults((prev) => prev + `\n\nInstalled "${slug}" successfully!`);
        api.getSkills().then(setInstalled);
      } else {
        setClawhubResults((prev) => prev + `\n\nFailed to install "${slug}": ${res.error || res.output}`);
      }
    } catch (err: any) {
      setClawhubResults((prev) => prev + `\n\nInstall error: ${err.message}`);
    }
    setClawhubInstalling(null);
  };

  const installSkill = async (skill: Skill) => {
    const result = await api.installSkill(skill);
    setInstalled((prev) => [...prev, result]);
  };

  const toggleSkill = async (skill: Skill) => {
    if (!skill.id) return;
    const updated = await api.updateSkill(skill.id, { enabled: !skill.enabled });
    setInstalled((prev) => prev.map((s) => (s.id === skill.id ? updated : s)));
  };

  const uninstallSkill = async (id: string) => {
    await api.deleteSkill(id);
    setInstalled((prev) => prev.filter((s) => s.id !== id));
  };

  const installCustom = async () => {
    const result = await api.installSkill({ ...customForm, source: "custom" });
    setInstalled((prev) => [...prev, result]);
    setCustomForm({ name: "", description: "", script: "" });
    setTab("installed");
  };

  const isInstalled = (name: string) => installed.some((s) => s.name === name);

  return (
    <div className="page">
      <div className="page-header">
        <h1>Skills</h1>
        <div className="tab-bar">
          {(["installed", "catalog", "clawhub", "custom"] as const).map((t) => (
            <button key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
              {t === "installed" ? `Installed (${installed.length})` : t === "catalog" ? "Built-in" : t === "clawhub" ? "Clawhub" : "Custom Skill"}
            </button>
          ))}
        </div>
      </div>

      {tab === "installed" && (
        <div className="card-list">
          {installed.map((skill) => (
            <div key={skill.id} className="card">
              <div className="card-header">
                <div className="card-title-row">
                  <h3>{skill.name}</h3>
                  <span className={`source-badge ${skill.source}`}>{skill.source}</span>
                  <span className={`status-badge ${skill.enabled ? "active" : "inactive"}`}>
                    {skill.enabled ? "Enabled" : "Disabled"}
                  </span>
                </div>
                <div className="card-actions">
                  <button className="btn btn-ghost btn-sm" onClick={() => toggleSkill(skill)}>
                    {skill.enabled ? "Disable" : "Enable"}
                  </button>
                  <button className="btn btn-danger btn-sm" onClick={() => uninstallSkill(skill.id!)}>Uninstall</button>
                </div>
              </div>
              <p className="card-desc">{skill.description}</p>
            </div>
          ))}
          {installed.length === 0 && <div className="empty-state-full"><p>No skills installed</p><p className="hint">Browse the catalog to install skills</p></div>}
        </div>
      )}

      {tab === "catalog" && (
        <div className="card-list">
          {catalog.map((skill) => (
            <div key={skill.name} className="card">
              <div className="card-header">
                <div className="card-title-row">
                  <h3>{skill.name}</h3>
                  <span className={`source-badge ${skill.source}`}>{skill.source}</span>
                </div>
                <button
                  className={`btn ${isInstalled(skill.name) ? "btn-ghost" : "btn-primary"} btn-sm`}
                  onClick={() => installSkill(skill)}
                  disabled={isInstalled(skill.name)}
                >
                  {isInstalled(skill.name) ? "Installed" : "Install"}
                </button>
              </div>
              <p className="card-desc">{skill.description}</p>
            </div>
          ))}
        </div>
      )}

      {tab === "clawhub" && (
        <div className="card form-card">
          <h3>Clawhub Marketplace</h3>
          <p className="hint" style={{ marginBottom: 12 }}>Search and install skills from the Clawhub / OpenClaw marketplace</p>
          <div className="form-group" style={{ display: "flex", gap: 8 }}>
            <input
              value={clawhubQuery}
              onChange={(e) => setClawhubQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && searchClawhub()}
              placeholder="Search skills... (e.g. web, deploy, search)"
              style={{ flex: 1 }}
            />
            <button className="btn btn-primary" onClick={searchClawhub} disabled={clawhubLoading}>
              {clawhubLoading ? "Searching..." : "Search"}
            </button>
          </div>
          {clawhubResults && (
            <div style={{ marginTop: 12 }}>
              {clawhubResults.split("\n").filter(Boolean).map((line, i) => {
                const slugMatch = line.match(/^(\S+)\s+(.+?)\s+\([\d.]+\)$/);
                if (slugMatch) {
                  const [, slug, title] = slugMatch;
                  return (
                    <div key={i} className="card" style={{ marginBottom: 8, padding: "10px 14px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div>
                        <strong>{slug}</strong>
                        <span style={{ marginLeft: 8, opacity: 0.7 }}>{title}</span>
                      </div>
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={() => installFromClawhub(slug)}
                        disabled={clawhubInstalling === slug}
                      >
                        {clawhubInstalling === slug ? "Installing..." : "Install"}
                      </button>
                    </div>
                  );
                }
                return <div key={i} style={{ padding: "2px 0", opacity: line.startsWith("-") ? 0.5 : 1 }}>{line}</div>;
              })}
            </div>
          )}
        </div>
      )}

      {tab === "custom" && (
        <div className="card form-card">
          <h3>Create Custom Skill</h3>
          <div className="form-group">
            <label>Name</label>
            <input value={customForm.name} onChange={(e) => setCustomForm({ ...customForm, name: e.target.value })} placeholder="My Custom Skill" />
          </div>
          <div className="form-group">
            <label>Description</label>
            <input value={customForm.description} onChange={(e) => setCustomForm({ ...customForm, description: e.target.value })} placeholder="What this skill does" />
          </div>
          <div className="form-group">
            <label>Script / Command</label>
            <textarea value={customForm.script} onChange={(e) => setCustomForm({ ...customForm, script: e.target.value })} placeholder="python3 my_skill.py" rows={5} />
          </div>
          <div className="form-actions">
            <button className="btn btn-primary" onClick={installCustom} disabled={!customForm.name}>Install</button>
          </div>
        </div>
      )}
    </div>
  );
}
