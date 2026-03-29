import { useState, useEffect, useCallback } from "react";
import { api } from "../utils/api";
import { useSocket } from "../hooks/useSocket";
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
  startedAt: string;
  lastUpdate: string;
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

function elapsed(startStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(startStr).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [activeTasks, setActiveTasks] = useState<ActiveTask[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", cron: "0 * * * *", command: "" });
  const [refreshing, setRefreshing] = useState(false);
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

  const loadActiveTasks = useCallback(async () => {
    setRefreshing(true);
    try {
      const data = await api.getActiveTasks();
      setActiveTasks(data);
    } catch {
      // ignore
    }
    setRefreshing(false);
  }, []);

  useEffect(() => {
    api.getTasks().then(setTasks);
    loadActiveTasks();
  }, [loadActiveTasks]);

  // Auto-refresh active tasks every 5 seconds (always poll so we catch new tasks)
  useEffect(() => {
    const interval = setInterval(loadActiveTasks, 5000);
    return () => clearInterval(interval);
  }, [loadActiveTasks]);

  // Real-time socket updates: refresh immediately on task start/finish events
  useEffect(() => {
    const unsub = onStatus((data: any) => {
      if (data.status === "thinking" || data.status === "done" || data.status === "job_complete") {
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
                  <button className="btn btn-danger btn-sm" onClick={() => killTask(task.id)} title="Kill task">
                    Kill
                  </button>
                </div>
              </div>
              <div className="card-body">
                <div className="card-detail">
                  <strong>Status:</strong> <span className="active-task-status">{task.status}</span>
                </div>
                {task.toolCalls.length > 0 && (
                  <div className="card-detail">
                    <strong>Tools used:</strong>{" "}
                    <span className="active-task-tools">
                      {task.toolCalls.map((t, i) => (
                        <code key={i}>{t}</code>
                      ))}
                    </span>
                  </div>
                )}
                <div className="card-detail">
                  <strong>Started:</strong> {new Date(task.startedAt).toLocaleTimeString()}
                  {" · "}
                  <strong>Last update:</strong> {timeAgo(task.lastUpdate)}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty-state" style={{ marginBottom: 32, padding: "24px 0" }}>
          <p style={{ color: "var(--text-tertiary)", fontSize: 13 }}>No agent tasks running</p>
        </div>
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
