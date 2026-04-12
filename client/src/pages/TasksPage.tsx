import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../utils/api";
import { useSocket } from "../hooks/useSocket";
import AgentGraphic from "./AgentGraphic";
import AgentDiagram from "./AgentDiagram";
import "./PageStyles.css";

interface Task {
  id: string;
  name: string;
  cron: string;
  command: string;
  enabled: boolean;
  lastRun?: string;
  lastResult?: string;
  createdAt: string;
}

interface ActiveTask {
  id: string;
  sessionId: string;
  projectId?: string;
  projectName?: string;
  title: string;
  status: string;
  toolCalls: string[];
  activeAgent?: string;
  activeAgents?: string[];
  doneAgents?: string[];
  agentTools: Record<string, string[]>;
  startedAt: string;
  lastUpdate: string;
}

interface RemoteTask {
  taskId: string;
  sessionId: string;
  status: "running" | "completed" | "error";
  progress: string[];
  result?: string;
  error?: string;
  startedAt: number;
  updatedAt: number;
  elapsed: number;
  agentTools?: Record<string, string[]>;
  activeAgents?: string[];
  doneAgents?: string[];
}

interface FinishedTask {
  id: string;
  sessionId: string;
  projectId?: string;
  projectName?: string;
  title: string;
  status: "completed" | "cancelled" | "error";
  toolCalls: string[];
  agents: string[];
  agentTools: Record<string, string[]>;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

const CRON_PRESETS = [
  { label: "Every minute", value: "* * * * *" },
  { label: "Every hour", value: "0 * * * *" },
  { label: "Every day at midnight", value: "0 0 * * *" },
  { label: "Every Monday", value: "0 0 * * 1" },
  { label: "Every 5 minutes", value: "*/5 * * * *" },
];

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ago`;
}

function dedupTools(tools: string[]): { name: string; count: number }[] {
  const map = new Map<string, number>();
  for (const t of tools) map.set(t, (map.get(t) || 0) + 1);
  return Array.from(map.entries()).map(([name, count]) => ({ name, count }));
}

// Stable color assignment: hash agent name to a color index (0-7)
function agentColorIndex(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 8;
}

function elapsed(startStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(startStr).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export default function TasksPage() {
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [activeTasks, setActiveTasks] = useState<ActiveTask[]>([]);
  const [finishedTasks, setFinishedTasks] = useState<FinishedTask[]>([]);
  const [remoteTasks, setRemoteTasks] = useState<RemoteTask[]>([]);
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [expandedRemote, setExpandedRemote] = useState<Record<string, boolean>>({});
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", cron: "0 * * * *", command: "" });
  const [refreshing, setRefreshing] = useState(false);
  const [graphicOpen, setGraphicOpen] = useState<Record<string, boolean>>({});
  const [diagramOpen, setDiagramOpen] = useState<Record<string, boolean>>({});
  const [remoteGraphicOpen, setRemoteGraphicOpen] = useState<Record<string, boolean>>({});
  const [remoteDiagramOpen, setRemoteDiagramOpen] = useState<Record<string, boolean>>({});
  const { onStatus } = useSocket();

  const killTask = async (taskId: string) => {
    try {
      await api.killActiveTask(taskId);
      loadActiveTasks();
    } catch {
      // Task may have already completed
      loadActiveTasks();
    }
  };

  const killRemoteTask = async (taskId: string) => {
    if (!confirm("Kill this remote task?")) return;
    try {
      await api.killRemoteTask(taskId);
    } catch {
      // already finished or gone
    }
    loadActiveTasks();
  };

  const loadActiveTasks = useCallback(async () => {
    setRefreshing(true);
    try {
      const data = await api.getActiveTasks();
      setActiveTasks(data);
      const fin = await api.getFinishedTasks();
      setFinishedTasks(fin);
      try {
        const rem = await api.getRemoteTasks();
        setRemoteTasks(rem?.tasks || []);
      } catch {
        // remote endpoint may be unavailable
      }
    } catch {
      // ignore
    }
    setRefreshing(false);
  }, []);

  useEffect(() => {
    api.getTasks().then(setTasks);
    loadActiveTasks();
  }, [loadActiveTasks]);

  // Auto-refresh active tasks every 2 seconds for live tool updates
  useEffect(() => {
    const interval = setInterval(loadActiveTasks, 2000);
    return () => clearInterval(interval);
  }, [loadActiveTasks]);

  // Real-time socket updates: refresh on agent activity events
  useEffect(() => {
    const unsub = onStatus((data: any) => {
      if (data.status === "thinking" || data.status === "done" || data.status === "job_complete" ||
          data.status === "tool_call" || data.status === "tool_result" ||
          data.status === "realtime_agent_working" || data.status === "realtime_agent_tool" ||
          data.status === "realtime_agent_done" || data.status === "subagent_spawn" ||
          data.status === "subagent_tool" || data.status === "subagent_done") {
        loadActiveTasks();
      }
    });
    return unsub;
  }, [onStatus, loadActiveTasks]);

  const createTask = async () => {
    const task = await api.createTask(form);
    setTasks((prev) => [...prev, task]);
    setShowForm(false);
    setForm({ name: "", cron: "0 * * * *", command: "" });
  };

  const toggleTask = async (task: Task) => {
    const updated = await api.updateTask(task.id, { enabled: !task.enabled });
    setTasks((prev) => prev.map((t) => (t.id === task.id ? updated : t)));
  };

  const deleteTask = async (id: string) => {
    await api.deleteTask(id);
    setTasks((prev) => prev.filter((t) => t.id !== id));
  };

  return (
    <div className="page">
      {/* ─── Running Agent Tasks ─── */}
      <div className="page-header">
        <h1>Running Agent Tasks</h1>
        <button
          className={`btn btn-ghost btn-sm${refreshing ? " spin-btn" : ""}`}
          onClick={loadActiveTasks}
          disabled={refreshing}
          title="Refresh"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className={refreshing ? "spin" : ""}>
            <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
          </svg>
          Refresh
        </button>
      </div>

      {activeTasks.length > 0 ? (
        <div className="card-list" style={{ marginBottom: 32 }}>
          {activeTasks.map((task) => (
            <div key={task.id} className="card active-task-card">
              <div className="card-header">
                <div className="card-title-row">
                  <div className="active-task-indicator" />
                  <h3>{task.title}</h3>
                  {task.projectName && (
                    <span className="source-badge clawhub">{task.projectName}</span>
                  )}
                </div>
                <div className="active-task-actions">
                  <span className="active-task-elapsed">{elapsed(task.startedAt)}</span>
                  <button
                    className={`btn btn-sm${graphicOpen[task.id] ? " btn-primary" : " btn-ghost"}`}
                    onClick={() => setGraphicOpen(prev => ({ ...prev, [task.id]: !prev[task.id] }))}
                    title="Toggle agent graphic view"
                    style={{ gap: 4 }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-4-8c.79 0 1.5-.71 1.5-1.5S8.79 9 8 9s-1.5.71-1.5 1.5S7.21 12 8 12zm8 0c.79 0 1.5-.71 1.5-1.5S16.79 9 16 9s-1.5.71-1.5 1.5.71 1.5 1.5 1.5zm-4 4c2.21 0 4-1.12 4-2.5h-8c0 1.38 1.79 2.5 4 2.5z"/>
                    </svg>
                    Graphic
                  </button>
                  <button
                    className={`btn btn-sm${diagramOpen[task.id] ? " btn-primary" : " btn-ghost"}`}
                    onClick={() => setDiagramOpen(prev => ({ ...prev, [task.id]: !prev[task.id] }))}
                    title="Toggle agent flow diagram"
                    style={{ gap: 4 }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M4 4h6v6H4V4zm10 0h6v6h-6V4zM4 14h6v6H4v-6zm10 0h6v6h-6v-6zM10 7h4M7 10v4M17 10v4M10 17h4" stroke="currentColor" strokeWidth="1.5" fill="none"/>
                    </svg>
                    Diagram
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => navigate(`/?session=${task.sessionId}`)}
                    title="Go to chat session"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style={{ marginRight: 4 }}>
                      <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/>
                    </svg>
                    Chat
                  </button>
                  <button className="btn btn-danger btn-sm" onClick={() => killTask(task.id)} title="Kill task">
                    Kill
                  </button>
                </div>
              </div>
              <div className="card-body">
                <div className="card-detail">
                  <strong>Status:</strong> <span className="active-task-status">{task.status}</span>
                </div>

                {/* Active & waiting agents pills */}
                {task.agentTools && Object.keys(task.agentTools).length > 0 && (() => {
                  const running = (task.activeAgents || []);
                  const done = new Set(task.doneAgents || []);
                  const waiting = Object.keys(task.agentTools).filter(a => !running.includes(a) && !done.has(a));
                  return (running.length > 0 || waiting.length > 0) ? (
                    <div className="card-detail">
                      {running.length > 0 && (<>
                        <strong>Running:</strong>
                        <div className="active-agents-row">
                          {running.map((agent, i) => (
                            <span key={i} className={`active-agent-badge agent-color-${agentColorIndex(agent)}`}>
                              <span className="agent-dot" />
                              {agent}
                            </span>
                          ))}
                        </div>
                      </>)}
                      {waiting.length > 0 && (<>
                        <strong style={{ marginLeft: running.length > 0 ? 12 : 0 }}>Waiting:</strong>
                        <div className="active-agents-row">
                          {waiting.map((agent, i) => (
                            <span key={i} className={`active-agent-badge agent-waiting-badge agent-color-${agentColorIndex(agent)}`}>
                              <span className="agent-dot agent-dot-waiting" />
                              {agent}
                            </span>
                          ))}
                        </div>
                      </>)}
                    </div>
                  ) : null;
                })()}

                {/* Agent tools breakdown with colors */}
                {task.agentTools && Object.keys(task.agentTools).length > 0 ? (
                  <div className="agent-tools-breakdown">
                    {Object.entries(task.agentTools).map(([agent, tools]) => {
                      const isActive = (task.activeAgents || []).includes(agent);
                      const isDone = (task.doneAgents || []).includes(agent);
                      const isWaiting = !isActive && !isDone;
                      const colorIdx = agentColorIndex(agent);
                      const stateClass = isActive ? "agent-active" : isWaiting ? "agent-waiting" : "agent-done";
                      const stateIcon = isActive ? "\u25B6" : isWaiting ? "\u23F3" : "\u2713";
                      return (
                        <div
                          key={agent}
                          className={`agent-tools-row agent-color-${colorIdx}${isActive ? " agent-row-active" : isWaiting ? " agent-row-waiting" : ""}`}
                        >
                          <span className={`agent-name-label agent-color-${colorIdx} ${stateClass}`}>
                            <span className="agent-status-icon">{stateIcon}</span>
                            {agent}
                          </span>
                          <span className="active-task-tools">
                            {dedupTools(tools).map((t, i) => (
                              <code key={i}>{t.name}{t.count > 1 ? ` \u00D7${t.count}` : ""}</code>
                            ))}
                          </span>
                          <span className="agent-tool-count">{tools.length} call{tools.length !== 1 ? "s" : ""}</span>
                        </div>
                      );
                    })}
                  </div>
                ) : task.toolCalls.length > 0 ? (
                  <div className="card-detail">
                    <strong>Tools used:</strong>{" "}
                    <span className="active-task-tools">
                      {task.toolCalls.map((t, i) => (
                        <code key={i}>{t}</code>
                      ))}
                    </span>
                  </div>
                ) : null}
                <div className="card-detail" style={{ marginTop: 4 }}>
                  <strong>Started:</strong> {new Date(task.startedAt).toLocaleTimeString()}
                  {" \u00B7 "}
                  <strong>Last update:</strong> {timeAgo(task.lastUpdate)}
                </div>
              </div>
              {graphicOpen[task.id] && (
                <AgentGraphic
                  agentTools={task.agentTools}
                  activeAgents={task.activeAgents || []}
                  doneAgents={task.doneAgents || []}
                  status={task.status}
                />
              )}
              {diagramOpen[task.id] && (
                <AgentDiagram
                  agentTools={task.agentTools}
                  activeAgents={task.activeAgents || []}
                  doneAgents={task.doneAgents || []}
                  status={task.status}
                />
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="empty-state" style={{ marginBottom: 32, padding: "24px 0" }}>
          <p style={{ color: "var(--text-tertiary)", fontSize: 13 }}>No agent tasks running</p>
        </div>
      )}

      {/* ─── Finished Tasks ─── */}
      <div className="page-header" style={{ marginTop: 24 }}>
        <h1>Finished Tasks <span style={{ fontSize: 12, fontWeight: 400, opacity: 0.6 }}>(last {finishedTasks.length})</span></h1>
      </div>

      {finishedTasks.length > 0 ? (
        <div className="card-list" style={{ marginBottom: 32 }}>
          {finishedTasks.map((task) => {
            const dur = task.durationMs;
            const durStr = dur < 1000 ? `${dur}ms` : dur < 60000 ? `${(dur/1000).toFixed(1)}s` : `${Math.floor(dur/60000)}m ${Math.floor((dur%60000)/1000)}s`;
            const statusColor = task.status === "completed" ? "#4caf50" : task.status === "cancelled" ? "#ff9800" : "#f44336";
            const statusIcon = task.status === "completed" ? "✓" : task.status === "cancelled" ? "⏹" : "✗";
            return (
              <div key={task.id} className="card" style={{ borderLeft: `3px solid ${statusColor}` }}>
                <div className="card-header">
                  <div className="card-title-row">
                    <span style={{ color: statusColor, fontWeight: 700, fontSize: 14 }}>{statusIcon}</span>
                    <h3 style={{ margin: 0 }}>{task.title}</h3>
                    {task.projectName && (
                      <span className="source-badge clawhub">{task.projectName}</span>
                    )}
                  </div>
                  <div className="active-task-actions">
                    <span className="active-task-elapsed" title={`Started: ${new Date(task.startedAt).toLocaleString()}\nFinished: ${new Date(task.finishedAt).toLocaleString()}`}>
                      {durStr} · {timeAgo(task.finishedAt)}
                    </span>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => navigate(task.projectId ? `/projects?session=${task.sessionId}&project=${task.projectId}` : `/?session=${task.sessionId}`)}
                      title="Open chat session"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style={{ marginRight: 4 }}>
                        <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/>
                      </svg>
                      Open Chat
                    </button>
                  </div>
                </div>
                <div className="card-body">
                  <div className="card-detail">
                    <strong>Status:</strong> <span style={{ color: statusColor, textTransform: "capitalize" }}>{task.status}</span>
                  </div>
                  {task.agents && task.agents.length > 0 && (
                    <div className="card-detail">
                      <strong>Agents:</strong>
                      <div className="active-agents-row">
                        {task.agents.map((agent, i) => (
                          <span key={i} className={`active-agent-badge agent-color-${agentColorIndex(agent)}`}>
                            {agent}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  {task.toolCalls && task.toolCalls.length > 0 && (
                    <div className="card-detail">
                      <strong>Tools used:</strong>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 }}>
                        {dedupTools(task.toolCalls).slice(0, 12).map((t) => (
                          <span key={t.name} style={{ fontSize: 10, padding: "2px 8px", borderRadius: 8, background: "rgba(255,255,255,0.08)", color: "#bbb" }}>
                            {t.name}{t.count > 1 ? ` ×${t.count}` : ""}
                          </span>
                        ))}
                        {task.toolCalls.length > 12 && <span style={{ fontSize: 10, opacity: 0.5 }}>+{task.toolCalls.length - 12} more</span>}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="empty-state" style={{ marginBottom: 32, padding: "24px 0" }}>
          <p style={{ color: "var(--text-tertiary)", fontSize: 13 }}>No finished tasks yet</p>
        </div>
      )}

      {/* ─── Remote Tasks (collapsible menu) ─── */}
      <div className="page-header" style={{ marginTop: 24, cursor: "pointer" }} onClick={() => setRemoteOpen(v => !v)}>
        <h1 style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ display: "inline-block", transform: remoteOpen ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s" }}>▶</span>
          Remote Tasks
          <span style={{ fontSize: 12, fontWeight: 400, opacity: 0.6 }}>
            ({remoteTasks.filter(t => t.status === "running").length} running · {remoteTasks.length} total)
          </span>
        </h1>
      </div>

      {remoteOpen && (
        remoteTasks.length > 0 ? (
          <div className="card-list" style={{ marginBottom: 32 }}>
            {remoteTasks.map((task) => {
              const statusColor = task.status === "running" ? "#2196f3" : task.status === "completed" ? "#4caf50" : "#f44336";
              const statusIcon = task.status === "running" ? "●" : task.status === "completed" ? "✓" : "✗";
              const isExpanded = expandedRemote[task.taskId];
              const firstProgress = task.progress[0] || "";
              const title = firstProgress.length > 80 ? firstProgress.slice(0, 80) + "…" : firstProgress || `Remote task ${task.taskId.slice(0, 8)}`;
              return (
                <div key={task.taskId} className="card" style={{ borderLeft: `3px solid ${statusColor}` }}>
                  <div className="card-header">
                    <div className="card-title-row">
                      <span style={{ color: statusColor, fontWeight: 700, fontSize: 14 }}>{statusIcon}</span>
                      <h3 style={{ margin: 0 }}>{title}</h3>
                      <span className="source-badge clawhub">remote</span>
                    </div>
                    <div className="active-task-actions">
                      <span className="active-task-elapsed">
                        {task.elapsed}s · {timeAgo(new Date(task.updatedAt).toISOString())}
                      </span>
                      <button
                        className={`btn btn-sm${remoteGraphicOpen[task.taskId] ? " btn-primary" : " btn-ghost"}`}
                        onClick={() => setRemoteGraphicOpen(prev => ({ ...prev, [task.taskId]: !prev[task.taskId] }))}
                        title="Toggle agent graphic view"
                        style={{ gap: 4 }}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-4-8c.79 0 1.5-.71 1.5-1.5S8.79 9 8 9s-1.5.71-1.5 1.5S7.21 12 8 12zm8 0c.79 0 1.5-.71 1.5-1.5S16.79 9 16 9s-1.5.71-1.5 1.5.71 1.5 1.5 1.5zm-4 4c2.21 0 4-1.12 4-2.5h-8c0 1.38 1.79 2.5 4 2.5z"/>
                        </svg>
                        Graphic
                      </button>
                      <button
                        className={`btn btn-sm${remoteDiagramOpen[task.taskId] ? " btn-primary" : " btn-ghost"}`}
                        onClick={() => setRemoteDiagramOpen(prev => ({ ...prev, [task.taskId]: !prev[task.taskId] }))}
                        title="Toggle agent flow diagram"
                        style={{ gap: 4 }}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M4 4h6v6H4V4zm10 0h6v6h-6V4zM4 14h6v6H4v-6zm10 0h6v6h-6v-6zM10 7h4M7 10v4M17 10v4M10 17h4" stroke="currentColor" strokeWidth="1.5" fill="none"/>
                        </svg>
                        Diagram
                      </button>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => setExpandedRemote(prev => ({ ...prev, [task.taskId]: !prev[task.taskId] }))}
                      >
                        {isExpanded ? "Hide" : "Details"}
                      </button>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => navigate(`/?session=${task.sessionId}`)}
                        title="Open chat session"
                      >
                        Chat
                      </button>
                      {task.status === "running" && (
                        <button
                          className="btn btn-danger btn-sm"
                          onClick={() => killRemoteTask(task.taskId)}
                          title="Kill remote task"
                        >
                          Kill
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="card-body">
                    <div className="card-detail">
                      <strong>Status:</strong>{" "}
                      <span style={{ color: statusColor, textTransform: "capitalize" }}>{task.status}</span>
                      {" · "}
                      <strong>Task ID:</strong> <code>{task.taskId.slice(0, 8)}</code>
                    </div>

                    {/* Active & done agents pills for remote tasks */}
                    {task.agentTools && Object.keys(task.agentTools).length > 0 && (() => {
                      const running = task.activeAgents || [];
                      const done = new Set(task.doneAgents || []);
                      const waiting = Object.keys(task.agentTools).filter(a => !running.includes(a) && !done.has(a));
                      return (running.length > 0 || waiting.length > 0) ? (
                        <div className="card-detail">
                          {running.length > 0 && (<>
                            <strong>Running:</strong>
                            <div className="active-agents-row">
                              {running.map((agent, i) => (
                                <span key={i} className={`active-agent-badge agent-color-${agentColorIndex(agent)}`}>
                                  <span className="agent-dot" />
                                  {agent}
                                </span>
                              ))}
                            </div>
                          </>)}
                          {waiting.length > 0 && (<>
                            <strong style={{ marginLeft: running.length > 0 ? 12 : 0 }}>Waiting:</strong>
                            <div className="active-agents-row">
                              {waiting.map((agent, i) => (
                                <span key={i} className={`active-agent-badge agent-waiting-badge agent-color-${agentColorIndex(agent)}`}>
                                  <span className="agent-dot agent-dot-waiting" />
                                  {agent}
                                </span>
                              ))}
                            </div>
                          </>)}
                        </div>
                      ) : null;
                    })()}

                    {isExpanded && task.progress.length > 0 && (
                      <pre className="card-result" style={{ maxHeight: 240, overflow: "auto", fontSize: 11 }}>
                        {task.progress.join("\n")}
                      </pre>
                    )}
                    {isExpanded && task.result && (
                      <div className="card-detail" style={{ marginTop: 8 }}>
                        <strong>Result:</strong>
                        <pre className="card-result" style={{ maxHeight: 200, overflow: "auto" }}>{task.result}</pre>
                      </div>
                    )}
                    {isExpanded && task.error && (
                      <div className="card-detail" style={{ marginTop: 8, color: "#f44336" }}>
                        <strong>Error:</strong> {task.error}
                      </div>
                    )}
                  </div>
                  {remoteGraphicOpen[task.taskId] && (
                    <AgentGraphic
                      agentTools={task.agentTools || {}}
                      activeAgents={task.activeAgents || []}
                      doneAgents={task.doneAgents || []}
                      status={task.status}
                    />
                  )}
                  {remoteDiagramOpen[task.taskId] && (
                    <AgentDiagram
                      agentTools={task.agentTools || {}}
                      activeAgents={task.activeAgents || []}
                      doneAgents={task.doneAgents || []}
                      status={task.status}
                    />
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="empty-state" style={{ marginBottom: 32, padding: "24px 0" }}>
            <p style={{ color: "var(--text-tertiary)", fontSize: 13 }}>No remote tasks</p>
          </div>
        )
      )}

      {/* ─── Scheduled Tasks ─── */}
      <div className="page-header">
        <h1>Scheduled Tasks</h1>
        <button className="btn btn-primary" onClick={() => setShowForm(true)}>New task</button>
      </div>

      {showForm && (
        <div className="card form-card">
          <h3>Create Task</h3>
          <div className="form-group">
            <label>Name</label>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Task name" />
          </div>
          <div className="form-group">
            <label>Schedule (cron)</label>
            <input value={form.cron} onChange={(e) => setForm({ ...form, cron: e.target.value })} placeholder="* * * * *" />
            <div className="preset-chips">
              {CRON_PRESETS.map((p) => (
                <button key={p.value} className="chip" onClick={() => setForm({ ...form, cron: p.value })}>{p.label}</button>
              ))}
            </div>
          </div>
          <div className="form-group">
            <label>Command</label>
            <textarea value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} placeholder="python3 script.py" rows={3} />
          </div>
          <div className="form-actions">
            <button className="btn btn-primary" onClick={createTask}>Create</button>
            <button className="btn btn-ghost" onClick={() => setShowForm(false)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="card-list">
        {tasks.map((task) => (
          <div key={task.id} className="card">
            <div className="card-header">
              <div className="card-title-row">
                <h3>{task.name}</h3>
                <span className={`status-badge ${task.enabled ? "active" : "inactive"}`}>
                  {task.enabled ? "Active" : "Paused"}
                </span>
              </div>
              <div className="card-actions">
                <button className="btn btn-ghost btn-sm" onClick={() => toggleTask(task)}>
                  {task.enabled ? "Pause" : "Resume"}
                </button>
                <button className="btn btn-danger btn-sm" onClick={() => deleteTask(task.id)}>Delete</button>
              </div>
            </div>
            <div className="card-body">
              <div className="card-detail"><strong>Schedule:</strong> <code>{task.cron}</code></div>
              <div className="card-detail"><strong>Command:</strong> <code>{task.command}</code></div>
              {task.lastRun && <div className="card-detail"><strong>Last run:</strong> {new Date(task.lastRun).toLocaleString()}</div>}
              {task.lastResult && <pre className="card-result">{task.lastResult}</pre>}
            </div>
          </div>
        ))}
        {tasks.length === 0 && !showForm && (
          <div className="empty-state-full">
            <p>No scheduled tasks yet</p>
            <p className="hint">Create a cron job to automate recurring tasks</p>
          </div>
        )}
      </div>
    </div>
  );
}
