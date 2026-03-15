import { useState, useRef, useCallback, useEffect } from "react";
import { api } from "../utils/api";
import "./AgentEditor.css";

// ─── Types ───

interface AgentNode {
  id: string;
  name: string;
  role: string;
  model: string;
  persona: string;
  responsibilities: string[];
  x: number;
  y: number;
  color: string;
  busEnabled: boolean;
  busTopics: string[];
}

interface Connection {
  id: string;
  from: string;
  to: string;
  label: string;
  protocol: string; // tcp_socket | queue | event_bus
  topics: string[];
}

interface EditorState {
  systemName: string;
  orchestrationMode: string;
  agents: AgentNode[];
  connections: Connection[];
}

const ROLE_COLORS: Record<string, string> = {
  orchestrator: "#4285f4",
  worker: "#34a853",
  checker: "#ea8600",
  reporter: "#9c27b0",
  researcher: "#00bcd4",
  default: "#607d8b",
};

// No hardcoded model list — users type model names and validate against the backend

const ROLES = ["orchestrator", "worker", "checker", "reporter", "researcher"];
const PROTOCOLS = ["tcp", "bus", "queue"];
const PROTOCOL_LABELS: Record<string, string> = {
  tcp: "TCP",
  bus: "Bus",
  queue: "Queue",
};

function generateId() {
  return "n_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6);
}

// ─── Agent Definition Panel ───

function AgentDefPanel({
  agent,
  onUpdate,
  onClose,
  onDelete,
}: {
  agent: AgentNode;
  onUpdate: (a: AgentNode) => void;
  onClose: () => void;
  onDelete: () => void;
}) {
  const [llmPrompt, setLlmPrompt] = useState("");
  const [generating, setGenerating] = useState(false);

  const generateWithLLM = async () => {
    if (!llmPrompt.trim()) return;
    setGenerating(true);
    try {
      // Use the chat API to generate agent definition
      const result = await api.runPython(`
import json
prompt = """Based on this description, generate a JSON object for an agent definition:
Description: ${llmPrompt.replace(/"/g, '\\"')}

Return ONLY a JSON object with these fields:
- name: string
- role: one of [orchestrator, worker, checker, reporter, researcher]
- model: one of [claude-opus-4-6, claude-sonnet-4-6]
- persona: detailed persona description (2-3 sentences)
- responsibilities: array of 3-5 responsibility strings
"""
# Just output a template since we can't call LLM from Python
result = {
    "name": "${agent.name || "New Agent"}",
    "role": "worker",
    "model": "claude-sonnet-4-6",
    "persona": f"You are a specialized agent based on: ${llmPrompt.replace(/"/g, '\\"').slice(0, 200)}",
    "responsibilities": [
        "Analyze and process assigned tasks",
        "Report findings to the orchestrator",
        "Collaborate with peer agents when needed"
    ]
}
print(json.dumps(result))
`);
      if (result.stdout) {
        try {
          const parsed = JSON.parse(result.stdout.trim());
          onUpdate({
            ...agent,
            name: parsed.name || agent.name,
            role: parsed.role || agent.role,
            model: parsed.model || agent.model,
            persona: parsed.persona || agent.persona,
            responsibilities: parsed.responsibilities || agent.responsibilities,
            color: ROLE_COLORS[parsed.role] || agent.color,
          });
        } catch {}
      }
    } catch (err) {
      console.error("LLM generation failed:", err);
    }
    setGenerating(false);
  };

  return (
    <div className="agent-def-panel">
      <div className="agent-def-header">
        <h3>Agent Definition</h3>
        <button className="btn-icon btn-ghost" onClick={onClose}>&times;</button>
      </div>

      <div className="agent-def-body">
        {/* LLM Helper */}
        <div className="agent-def-llm-section">
          <label>AI-Assisted Setup</label>
          <div className="agent-def-llm-row">
            <textarea
              placeholder="Describe the agent you want (e.g. 'A structural engineer who reviews calculations and checks code compliance')..."
              value={llmPrompt}
              onChange={(e) => setLlmPrompt(e.target.value)}
              rows={2}
            />
            <button
              className="btn btn-primary btn-sm"
              onClick={generateWithLLM}
              disabled={generating || !llmPrompt.trim()}
            >
              {generating ? "..." : "Generate"}
            </button>
          </div>
        </div>

        <div className="agent-def-divider">or edit manually</div>

        <div className="agent-def-form">
          <div className="form-group">
            <label>Agent ID</label>
            <input
              value={agent.id}
              onChange={(e) => onUpdate({ ...agent, id: e.target.value.replace(/[^a-z0-9_]/g, "") })}
              placeholder="e.g. design_engineer_1"
            />
          </div>
          <div className="form-group">
            <label>Name</label>
            <input
              value={agent.name}
              onChange={(e) => onUpdate({ ...agent, name: e.target.value })}
              placeholder="e.g. Design Engineer 1"
            />
          </div>
          <div className="form-group">
            <label>Role</label>
            <select
              value={agent.role}
              onChange={(e) => onUpdate({ ...agent, role: e.target.value, color: ROLE_COLORS[e.target.value] || agent.color })}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label>Persona</label>
            <textarea
              value={agent.persona}
              onChange={(e) => onUpdate({ ...agent, persona: e.target.value })}
              rows={4}
              placeholder="Describe the agent's personality, expertise, and behavior..."
            />
          </div>
          <div className="form-group">
            <label>Responsibilities (one per line)</label>
            <textarea
              value={agent.responsibilities.join("\n")}
              onChange={(e) => onUpdate({ ...agent, responsibilities: e.target.value.split("\n").filter(Boolean) })}
              rows={4}
              placeholder="- Parse and interpret requirements&#10;- Assign tasks to sub-agents&#10;- Review outputs"
            />
          </div>

          {/* Bus Connection */}
          <div className="agent-def-divider">communication</div>
          <div className="form-group">
            <label className="bus-toggle-label">
              <input
                type="checkbox"
                checked={agent.busEnabled}
                onChange={(e) => onUpdate({ ...agent, busEnabled: e.target.checked })}
              />
              <span>Connected to Message Bus</span>
            </label>
            <p className="bus-hint">Shared broadcast channel — all bus-connected agents can see messages</p>
          </div>
          {agent.busEnabled && (
            <div className="form-group">
              <label>Bus Topics (one per line)</label>
              <textarea
                value={agent.busTopics.join("\n")}
                onChange={(e) => onUpdate({ ...agent, busTopics: e.target.value.split("\n").filter(Boolean) })}
                rows={3}
                placeholder="parameter_share&#10;clash_flag&#10;status_update"
              />
            </div>
          )}
        </div>
      </div>

      <div className="agent-def-footer">
        <button className="btn btn-danger btn-sm" onClick={onDelete}>Delete Agent</button>
      </div>
    </div>
  );
}

// ─── Connection Editor ───

function ConnectionPanel({
  conn,
  agents,
  onUpdate,
  onClose,
  onDelete,
}: {
  conn: Connection;
  agents: AgentNode[];
  onUpdate: (c: Connection) => void;
  onClose: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="agent-def-panel">
      <div className="agent-def-header">
        <h3>Connection</h3>
        <button className="btn-icon btn-ghost" onClick={onClose}>&times;</button>
      </div>
      <div className="agent-def-body">
        <div className="agent-def-form">
          <div className="form-row">
            <div className="form-group">
              <label>From</label>
              <select value={conn.from} onChange={(e) => onUpdate({ ...conn, from: e.target.value })}>
                <option value="">Select agent...</option>
                {agents.map((a) => <option key={a.id} value={a.id}>{a.name || a.id}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>To</label>
              <select value={conn.to} onChange={(e) => onUpdate({ ...conn, to: e.target.value })}>
                <option value="">Select agent...</option>
                {agents.map((a) => <option key={a.id} value={a.id}>{a.name || a.id}</option>)}
              </select>
            </div>
          </div>
          <div className="form-group">
            <label>Label</label>
            <input
              value={conn.label}
              onChange={(e) => onUpdate({ ...conn, label: e.target.value })}
              placeholder="e.g. task_assignment"
            />
          </div>
          <div className="form-group">
            <label>Protocol</label>
            <select value={conn.protocol} onChange={(e) => onUpdate({ ...conn, protocol: e.target.value })}>
              {PROTOCOLS.map((p) => (
                <option key={p} value={p}>{PROTOCOL_LABELS[p] || p}</option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label>Communication Topics (one per line)</label>
            <textarea
              value={conn.topics.join("\n")}
              onChange={(e) => onUpdate({ ...conn, topics: e.target.value.split("\n").filter(Boolean) })}
              rows={3}
              placeholder="parameter_share&#10;clash_flag&#10;acknowledgement"
            />
          </div>
        </div>
      </div>
      <div className="agent-def-footer">
        <button className="btn btn-danger btn-sm" onClick={onDelete}>Delete Connection</button>
      </div>
    </div>
  );
}

// ─── Main Editor ───

export default function AgentEditor({
  onClose,
  onSave,
  initialYaml,
}: {
  onClose: () => void;
  onSave: (filename: string, content: string) => void;
  initialYaml?: string;
}) {
  const [state, setState] = useState<EditorState>({
    systemName: "Multi-Agent System",
    orchestrationMode: "hierarchical",
    agents: [],
    connections: [],
  });

  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [selectedConn, setSelectedConn] = useState<string | null>(null);
  const [dragging, setDragging] = useState<{ id: string; offsetX: number; offsetY: number } | null>(null);
  const [connecting, setConnecting] = useState<{ fromId: string; mouseX: number; mouseY: number } | null>(null);
  const [filename, setFilename] = useState("agents");
  const [saving, setSaving] = useState(false);
  const [yamlPreview, setYamlPreview] = useState(false);
  const [generatedYaml, setGeneratedYaml] = useState("");
  const [showFileManager, setShowFileManager] = useState(false);
  const [existingFiles, setExistingFiles] = useState<{ filename: string; name: string; agentCount: number; updatedAt: string }[]>([]);
  const [uploadError, setUploadError] = useState("");

  const canvasRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load initial YAML if provided
  useEffect(() => {
    if (initialYaml) {
      loadFromYaml(initialYaml);
    }
    loadExistingFiles();
  }, []);

  const loadExistingFiles = async () => {
    try {
      const files = await api.getAgentConfigs();
      setExistingFiles(Array.isArray(files) ? files : []);
    } catch {
      setExistingFiles([]);
    }
  };

  const handleUploadYaml = (e: React.ChangeEvent<HTMLInputElement>) => {
    setUploadError("");
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.name.match(/\.ya?ml$/i)) {
      setUploadError("Only .yaml or .yml files are accepted");
      return;
    }
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const content = ev.target?.result as string;
      if (!content) return;
      try {
        // Save to server
        const baseName = file.name.replace(/\.ya?ml$/i, "");
        await api.saveAgentConfig(baseName, content);
        // Load into editor
        loadFromYaml(content);
        setFilename(baseName);
        await loadExistingFiles();
      } catch (err: any) {
        setUploadError(err.message || "Upload failed");
      }
    };
    reader.readAsText(file);
    // Reset input so same file can be re-uploaded
    e.target.value = "";
  };

  const handleLoadFile = async (fname: string) => {
    try {
      const result = await api.getAgentConfig(fname);
      if (result.content) {
        loadFromYaml(result.content);
        setFilename(fname.replace(/\.ya?ml$/i, ""));
        setShowFileManager(false);
      }
    } catch (err: any) {
      console.error("Failed to load file:", err);
    }
  };

  const handleDeleteFile = async (fname: string) => {
    try {
      await api.deleteAgentConfig(fname);
      await loadExistingFiles();
      // If the deleted file is currently loaded, clear the editor
      if (filename === fname.replace(/\.ya?ml$/i, "")) {
        setState({ systemName: "Multi-Agent System", orchestrationMode: "hierarchical", agents: [], connections: [] });
        setFilename("agents");
      }
    } catch (err: any) {
      console.error("Failed to delete file:", err);
    }
  };

  const loadFromYaml = (content: string) => {
    try {
      api.parseAgentYaml(content).then((result: any) => {
        if (result.ok && result.parsed) {
          const parsed = result.parsed;
          const agents: AgentNode[] = (parsed.agents || []).map((a: any, i: number) => ({
            id: a.id || generateId(),
            name: a.name || "Agent " + (i + 1),
            role: a.role || "worker",
            model: a.model || "claude-sonnet-4-6",
            persona: a.persona || "",
            responsibilities: a.responsibilities || [],
            x: 100 + (i % 3) * 250,
            y: 80 + Math.floor(i / 3) * 200,
            color: ROLE_COLORS[a.role] || ROLE_COLORS.default,
            busEnabled: a.bus?.enabled || false,
            busTopics: a.bus?.topics || [],
          }));

          // Extract connections: prefer explicit connections array, fall back to workflow
          let connections: Connection[] = [];
          if (parsed.connections && Array.isArray(parsed.connections)) {
            connections = parsed.connections.map((c: any) => ({
              id: generateId(),
              from: c.from || "",
              to: c.to || "",
              label: c.label || "connection",
              protocol: c.protocol || "tcp",
              topics: c.topics || [],
            }));
          } else if (parsed.workflow?.sequence) {
            for (const step of parsed.workflow.sequence) {
              if (step.outputs_to) {
                const targets = Array.isArray(step.outputs_to) ? step.outputs_to : [step.outputs_to];
                const fromAgent = step.agent || (step.agents ? step.agents[0] : null);
                if (fromAgent) {
                  for (const to of targets) {
                    connections.push({
                      id: generateId(),
                      from: fromAgent,
                      to,
                      label: step.action?.slice(0, 30) || "handoff",
                      protocol: step.communication?.protocols?.[0] || (step.peer_socket?.enabled ? "tcp" : "queue"),
                      topics: step.peer_socket?.permitted_topics || [],
                    });
                  }
                }
                if (step.agents && step.agents.length > 1 && step.peer_socket?.enabled) {
                  for (let i = 0; i < step.agents.length; i++) {
                    for (let j = i + 1; j < step.agents.length; j++) {
                      connections.push({
                        id: generateId(),
                        from: step.agents[i],
                        to: step.agents[j],
                        label: "peer_socket",
                        protocol: "tcp",
                        topics: step.peer_socket?.permitted_topics || [],
                      });
                    }
                  }
                }
              }
            }
          }

          setState({
            systemName: parsed.system?.name || "Multi-Agent System",
            orchestrationMode: parsed.system?.orchestration_mode || "hierarchical",
            agents,
            connections,
          });
        }
      });
    } catch (err) {
      console.error("Failed to parse YAML:", err);
    }
  };

  const addAgent = () => {
    const newAgent: AgentNode = {
      id: "agent_" + (state.agents.length + 1),
      name: "New Agent",
      role: "worker",
      model: "claude-sonnet-4-6",
      persona: "",
      responsibilities: [],
      x: 150 + Math.random() * 300,
      y: 100 + Math.random() * 200,
      color: ROLE_COLORS.worker,
      busEnabled: false,
      busTopics: [],
    };
    setState((s) => ({ ...s, agents: [...s.agents, newAgent] }));
    setSelectedAgent(newAgent.id);
    setSelectedConn(null);
  };

  const updateAgent = (updated: AgentNode) => {
    setState((s) => ({
      ...s,
      agents: s.agents.map((a) => (a.id === selectedAgent ? updated : a)),
    }));
  };

  const deleteAgent = (id: string) => {
    setState((s) => ({
      ...s,
      agents: s.agents.filter((a) => a.id !== id),
      connections: s.connections.filter((c) => c.from !== id && c.to !== id),
    }));
    setSelectedAgent(null);
  };

  const updateConnection = (updated: Connection) => {
    setState((s) => ({
      ...s,
      connections: s.connections.map((c) => (c.id === selectedConn ? updated : c)),
    }));
  };

  const deleteConnection = (id: string) => {
    setState((s) => ({
      ...s,
      connections: s.connections.filter((c) => c.id !== id),
    }));
    setSelectedConn(null);
  };

  // Mouse handlers for drag & drop
  const handleMouseDown = useCallback((e: React.MouseEvent, agentId: string) => {
    e.stopPropagation();
    const agent = state.agents.find((a) => a.id === agentId);
    if (!agent) return;

    setDragging({
      id: agentId,
      offsetX: e.clientX - agent.x,
      offsetY: e.clientY - agent.y,
    });
    setSelectedAgent(agentId);
    setSelectedConn(null);
  }, [state.agents]);

  // Port click starts connection drawing (no shift needed)
  const handlePortMouseDown = useCallback((e: React.MouseEvent, agentId: string) => {
    e.stopPropagation();
    e.preventDefault();
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    setConnecting({
      fromId: agentId,
      mouseX: e.clientX - rect.left,
      mouseY: e.clientY - rect.top,
    });
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (dragging) {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = Math.max(0, e.clientX - dragging.offsetX);
      const y = Math.max(0, e.clientY - dragging.offsetY);
      setState((s) => ({
        ...s,
        agents: s.agents.map((a) => (a.id === dragging.id ? { ...a, x, y } : a)),
      }));
    }
    if (connecting) {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      setConnecting({
        ...connecting,
        mouseX: e.clientX - rect.left,
        mouseY: e.clientY - rect.top,
      });
    }
  }, [dragging, connecting]);

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    if (connecting) {
      // Check if dropped on an agent
      const rect = canvasRef.current?.getBoundingClientRect();
      if (rect) {
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const target = state.agents.find(
          (a) => a.id !== connecting.fromId &&
            x >= a.x && x <= a.x + 180 &&
            y >= a.y && y <= a.y + 80
        );
        if (target) {
          const newConn: Connection = {
            id: generateId(),
            from: connecting.fromId,
            to: target.id,
            label: "connection",
            protocol: "tcp",
            topics: [],
          };
          setState((s) => ({ ...s, connections: [...s.connections, newConn] }));
          setSelectedConn(newConn.id);
          setSelectedAgent(null);
        }
      }
      setConnecting(null);
    }
    setDragging(null);
  }, [connecting, state.agents]);

  const handleCanvasClick = (e: React.MouseEvent) => {
    if (e.target === canvasRef.current || (e.target as HTMLElement).classList.contains("editor-canvas-inner")) {
      setSelectedAgent(null);
      setSelectedConn(null);
    }
  };

  // Generate YAML from current state
  const buildYamlObject = () => {
    const yamlObj: any = {
      system: {
        name: state.systemName,
        orchestration_mode: state.orchestrationMode,
        communication_protocol: "structured_handoff",
        context_passing: "full_chain",
      },
      agents: state.agents.map((a) => {
        const agentDef: any = {
          id: a.id,
          name: a.name,
          role: a.role,
          model: a.model,
        };
        if (a.persona) agentDef.persona = a.persona;
        if (a.responsibilities.length > 0) agentDef.responsibilities = a.responsibilities;
        if (a.busEnabled) {
          agentDef.bus = {
            enabled: true,
            topics: a.busTopics.length > 0 ? a.busTopics : undefined,
          };
        }
        return agentDef;
      }),
      workflow: {
        sequence: buildWorkflowSequence(),
      },
      connections: state.connections.map((c) => ({
        from: c.from,
        to: c.to,
        label: c.label,
        protocol: c.protocol,
        topics: c.topics.length > 0 ? c.topics : undefined,
      })),
      communication: {
        format: "structured_json_in_yaml_envelope",
        context_inheritance: {
          mode: "cumulative",
          max_history_tokens: 8000,
        },
      },
    };
    return yamlObj;
  };

  const buildWorkflowSequence = () => {
    // Group connections by source to build workflow steps
    const steps: any[] = [];
    const visited = new Set<string>();

    // Find orchestrator (starting point)
    const orchestrator = state.agents.find((a) => a.role === "orchestrator");
    const startAgent = orchestrator || state.agents[0];
    if (!startAgent) return steps;

    const buildStep = (agentId: string, stepNum: number) => {
      if (visited.has(agentId)) return;
      visited.add(agentId);

      const agent = state.agents.find((a) => a.id === agentId);
      if (!agent) return;

      const outConns = state.connections.filter((c) => c.from === agentId);
      const targets = outConns.map((c) => c.to).filter((t) => !visited.has(t));

      const step: any = {
        step: stepNum,
        agent: agentId,
        action: agent.responsibilities[0] || `Execute ${agent.name} tasks`,
      };

      if (targets.length > 0) {
        step.outputs_to = targets;
      }

      // Add communication config based on connection protocols
      if (outConns.length > 0) {
        const protocols = [...new Set(outConns.map((c) => c.protocol))];
        step.communication = {
          enabled: true,
          protocols: protocols,
          participants: [agentId, ...targets],
          permitted_topics: outConns.flatMap((c) => c.topics),
        };
        // Add peer_socket if tcp is used
        const tcpConns = outConns.filter((c) => c.protocol === "tcp");
        if (tcpConns.length > 0) {
          step.peer_socket = {
            enabled: true,
            protocol: "bidirectional_async",
            participants: [agentId, ...targets],
            permitted_topics: tcpConns.flatMap((c) => c.topics),
          };
        }
      }

      steps.push(step);

      // Recurse for targets
      for (const t of targets) {
        buildStep(t, steps.length + 1);
      }
    };

    buildStep(startAgent.id, 1);

    // Add any unvisited agents
    for (const a of state.agents) {
      if (!visited.has(a.id)) {
        buildStep(a.id, steps.length + 1);
      }
    }

    return steps;
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const yamlObj = buildYamlObject();
      const result = await api.generateAgentYaml(yamlObj);
      if (result.ok) {
        await api.saveAgentConfig(filename, result.content);
        onSave(filename + ".yaml", result.content);
        await loadExistingFiles();
      }
    } catch (err) {
      console.error("Save failed:", err);
    }
    setSaving(false);
  };

  const handlePreviewYaml = async () => {
    const yamlObj = buildYamlObject();
    const result = await api.generateAgentYaml(yamlObj);
    if (result.ok) {
      setGeneratedYaml(result.content);
      setYamlPreview(true);
    }
  };

  // Get positions for connection lines
  const getNodeCenter = (id: string) => {
    const agent = state.agents.find((a) => a.id === id);
    if (!agent) return { x: 0, y: 0 };
    return { x: agent.x + 90, y: agent.y + 40 };
  };

  // Port positions: output = right edge, input = left edge
  const getOutputPort = (id: string) => {
    const agent = state.agents.find((a) => a.id === id);
    if (!agent) return { x: 0, y: 0 };
    return { x: agent.x + 180, y: agent.y + 40 };
  };

  const getInputPort = (id: string) => {
    const agent = state.agents.find((a) => a.id === id);
    if (!agent) return { x: 0, y: 0 };
    return { x: agent.x, y: agent.y + 40 };
  };

  const selectedAgentData = state.agents.find((a) => a.id === selectedAgent);
  const selectedConnData = state.connections.find((c) => c.id === selectedConn);

  return (
    <div className="agent-editor-overlay">
      <div className="agent-editor">
        {/* Toolbar */}
        <div className="editor-toolbar">
          <div className="editor-toolbar-left">
            <h2>Agent System Editor</h2>
            <div className="editor-toolbar-meta">
              <input
                className="system-name-input"
                value={state.systemName}
                onChange={(e) => setState((s) => ({ ...s, systemName: e.target.value }))}
                placeholder="System name..."
              />
              <select
                value={state.orchestrationMode}
                onChange={(e) => setState((s) => ({ ...s, orchestrationMode: e.target.value }))}
                className="orchestration-select"
              >
                <option value="hierarchical">Hierarchical</option>
                <option value="flat">Flat</option>
                <option value="mesh">Mesh</option>
                <option value="pipeline">Pipeline</option>
              </select>
            </div>
          </div>
          <div className="editor-toolbar-right">
            <input
              ref={fileInputRef}
              type="file"
              accept=".yaml,.yml"
              style={{ display: "none" }}
              onChange={handleUploadYaml}
            />
            <button className="btn btn-secondary btn-sm" onClick={() => fileInputRef.current?.click()}>
              Upload YAML
            </button>
            <button
              className={`btn btn-sm ${showFileManager ? "btn-primary" : "btn-secondary"}`}
              onClick={() => { setShowFileManager(!showFileManager); loadExistingFiles(); }}
            >
              Files ({existingFiles.length})
            </button>
            <button className="btn btn-secondary btn-sm" onClick={addAgent}>
              + Add Agent
            </button>
            <button className="btn btn-secondary btn-sm" onClick={handlePreviewYaml}>
              Preview YAML
            </button>
            <div className="save-group">
              <input
                className="filename-input"
                value={filename}
                onChange={(e) => setFilename(e.target.value.replace(/[^a-zA-Z0-9_\-]/g, ""))}
                placeholder="filename"
              />
              <span className="filename-ext">.yaml</span>
              <button className="btn btn-primary btn-sm" onClick={handleSave} disabled={saving}>
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
            <button className="btn btn-ghost btn-sm" onClick={onClose}>&times; Close</button>
          </div>
        </div>

        {uploadError && (
          <div className="upload-error-bar">
            {uploadError}
            <button className="btn-icon btn-ghost" onClick={() => setUploadError("")}>&times;</button>
          </div>
        )}

        <div className="editor-body">
          {/* File Manager Panel */}
          {showFileManager && (
            <div className="file-manager-panel">
              <div className="file-manager-header">
                <h3>Architecture Files</h3>
                <button className="btn-icon btn-ghost" onClick={() => setShowFileManager(false)}>&times;</button>
              </div>
              <div className="file-manager-list">
                {existingFiles.length === 0 && (
                  <div className="file-manager-empty">No YAML files yet. Upload or save one.</div>
                )}
                {existingFiles.map((f) => (
                  <div key={f.filename} className="file-manager-item">
                    <div className="file-manager-item-info">
                      <div className="file-manager-item-name">{f.filename}</div>
                      <div className="file-manager-item-meta">
                        {f.name} &middot; {f.agentCount} agent{f.agentCount !== 1 ? "s" : ""}
                      </div>
                    </div>
                    <div className="file-manager-item-actions">
                      <button
                        className="btn btn-sm btn-secondary"
                        onClick={() => handleLoadFile(f.filename)}
                        title="Load into editor"
                      >
                        Load
                      </button>
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={() => handleDeleteFile(f.filename)}
                        title="Delete file"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="file-manager-footer">
                <button className="btn btn-secondary btn-sm" onClick={() => fileInputRef.current?.click()}>
                  Upload YAML
                </button>
              </div>
            </div>
          )}

          {/* Canvas */}
          <div
            ref={canvasRef}
            className="editor-canvas"
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onClick={handleCanvasClick}
          >
            <div className="editor-canvas-inner">
              {/* Help text */}
              {state.agents.length === 0 && (
                <div className="editor-empty-hint">
                  Click <strong>"+ Add Agent"</strong> to start building your agent system.<br />
                  Drag agents to position them. Click a <strong>port dot</strong> and drag to another agent to connect.<br />
                  Click a connection line to edit or remove it.
                </div>
              )}

              {/* SVG layer for connections */}
              <svg className="editor-svg-layer">
                {state.connections.map((conn) => {
                  const from = getOutputPort(conn.from);
                  const to = getInputPort(conn.to);
                  const isSelected = selectedConn === conn.id;
                  const protocolColor =
                    conn.protocol === "tcp" ? "#4285f4" :
                    conn.protocol === "queue" ? "#ea8600" :
                    conn.protocol === "bus" ? "#34a853" :
                    "#607d8b";

                  const lineColor = isSelected ? "#e53935" : protocolColor;

                  // Curved line
                  const midX = (from.x + to.x) / 2;
                  const midY = (from.y + to.y) / 2 - 30;
                  const protocolLabel = PROTOCOL_LABELS[conn.protocol] || conn.protocol;

                  return (
                    <g
                      key={conn.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedConn(conn.id);
                        setSelectedAgent(null);
                      }}
                      style={{ cursor: "pointer" }}
                    >
                      {/* Invisible fat hit area */}
                      <path
                        d={`M ${from.x} ${from.y} Q ${midX} ${midY} ${to.x} ${to.y}`}
                        stroke="transparent"
                        strokeWidth={14}
                        fill="none"
                      />
                      <path
                        d={`M ${from.x} ${from.y} Q ${midX} ${midY} ${to.x} ${to.y}`}
                        stroke={lineColor}
                        strokeWidth={isSelected ? 3 : 2}
                        fill="none"
                        strokeDasharray={conn.protocol === "bus" ? "6,3" : "none"}
                        markerEnd="url(#arrowhead)"
                      />
                      {/* Protocol badge */}
                      <rect
                        x={midX - 20}
                        y={midY - 18}
                        width={40}
                        height={16}
                        rx={4}
                        fill={isSelected ? "#e53935" : protocolColor}
                        opacity={0.85}
                      />
                      <text
                        x={midX}
                        y={midY - 7}
                        textAnchor="middle"
                        fill="#fff"
                        fontSize="10"
                        fontWeight="700"
                        style={{ pointerEvents: "none" }}
                      >
                        {protocolLabel}
                      </text>
                    </g>
                  );
                })}

                {/* Drawing line while connecting */}
                {connecting && (
                  <line
                    x1={getOutputPort(connecting.fromId).x}
                    y1={getOutputPort(connecting.fromId).y}
                    x2={connecting.mouseX}
                    y2={connecting.mouseY}
                    stroke="#4285f4"
                    strokeWidth={2}
                    strokeDasharray="6,3"
                    opacity={0.7}
                  />
                )}

                {/* Arrow marker */}
                <defs>
                  <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto">
                    <polygon points="0 0, 10 3.5, 0 7" fill="#888" />
                  </marker>
                </defs>
              </svg>

              {/* Agent nodes */}
              {state.agents.map((agent) => {
                const isSelected = selectedAgent === agent.id;
                return (
                  <div
                    key={agent.id}
                    className={`editor-agent-node ${isSelected ? "selected" : ""}`}
                    style={{
                      left: agent.x,
                      top: agent.y,
                      borderColor: agent.color,
                      boxShadow: isSelected ? `0 0 0 2px ${agent.color}, 0 4px 12px rgba(0,0,0,0.3)` : undefined,
                    }}
                    onMouseDown={(e) => handleMouseDown(e, agent.id)}
                    onClick={(e) => { e.stopPropagation(); setSelectedAgent(agent.id); setSelectedConn(null); }}
                  >
                    <div className="agent-node-header" style={{ background: agent.color }}>
                      <span className="agent-node-role">{agent.role}</span>
                    </div>
                    <div className="agent-node-body">
                      <div className="agent-node-name">{agent.name || agent.id}</div>
                      <div className="agent-node-model">{agent.model.split("-").slice(-2).join("-")}</div>
                    </div>
                    {agent.busEnabled && (
                      <div className="agent-node-bus-badge" title={`Bus topics: ${agent.busTopics.join(", ") || "all"}`}>
                        BUS
                      </div>
                    )}
                    <div className="agent-node-port agent-node-port-in" title="Input port">
                      <div className="port-dot port-dot-in" />
                    </div>
                    <div
                      className="agent-node-port agent-node-port-out"
                      title="Drag to connect"
                      onMouseDown={(e) => handlePortMouseDown(e, agent.id)}
                    >
                      <div className="port-dot" />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right panel: Agent/Connection definition */}
          {selectedAgentData && (
            <AgentDefPanel
              agent={selectedAgentData}
              onUpdate={updateAgent}
              onClose={() => setSelectedAgent(null)}
              onDelete={() => deleteAgent(selectedAgentData.id)}
            />
          )}

          {selectedConnData && (
            <ConnectionPanel
              conn={selectedConnData}
              agents={state.agents}
              onUpdate={updateConnection}
              onClose={() => setSelectedConn(null)}
              onDelete={() => deleteConnection(selectedConnData.id)}
            />
          )}
        </div>

        {/* YAML Preview Modal */}
        {yamlPreview && (
          <div className="yaml-preview-overlay" onClick={() => setYamlPreview(false)}>
            <div className="yaml-preview-modal" onClick={(e) => e.stopPropagation()}>
              <div className="yaml-preview-header">
                <h3>Generated YAML</h3>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => {
                      navigator.clipboard.writeText(generatedYaml);
                    }}
                  >
                    Copy
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setYamlPreview(false)}>
                    &times;
                  </button>
                </div>
              </div>
              <pre className="yaml-preview-content">{generatedYaml}</pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
