import { useState, useEffect } from "react";
import { api } from "../utils/api";
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

const CRON_PRESETS = [
  { label: "Every minute", value: "* * * * *" },
  { label: "Every hour", value: "0 * * * *" },
  { label: "Every day at midnight", value: "0 0 * * *" },
  { label: "Every Monday", value: "0 0 * * 1" },
  { label: "Every 5 minutes", value: "*/5 * * * *" },
];

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", cron: "0 * * * *", command: "" });

  useEffect(() => {
    api.getTasks().then(setTasks);
  }, []);

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
