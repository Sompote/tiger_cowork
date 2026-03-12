import { Router } from "express";
import { v4 as uuid } from "uuid";
import { getTasks, saveTasks } from "../services/data";
import { scheduleTask, stopTask } from "../services/scheduler";
import { getActiveTasks, killActiveTask } from "../services/socket";

export const tasksRouter = Router();

tasksRouter.get("/", (_req, res) => {
  res.json(getTasks());
});

tasksRouter.get("/active", (_req, res) => {
  res.json(getActiveTasks());
});

tasksRouter.post("/active/:id/kill", (req, res) => {
  const killed = killActiveTask(req.params.id);
  if (!killed) return res.status(404).json({ error: "Task not found or already completed" });
  res.json({ success: true });
});

tasksRouter.post("/", (req, res) => {
  const tasks = getTasks();
  const task = {
    id: uuid(),
    name: req.body.name || "Untitled Task",
    cron: req.body.cron || "0 * * * *",
    command: req.body.command || "",
    enabled: req.body.enabled ?? true,
    createdAt: new Date().toISOString(),
  };
  tasks.push(task);
  saveTasks(tasks);
  if (task.enabled) scheduleTask(task);
  res.json(task);
});

tasksRouter.patch("/:id", (req, res) => {
  const tasks = getTasks();
  const idx = tasks.findIndex((t) => t.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: "Not found" });

  Object.assign(tasks[idx], req.body);
  saveTasks(tasks);

  if (tasks[idx].enabled) {
    scheduleTask(tasks[idx]);
  } else {
    stopTask(tasks[idx].id);
  }
  res.json(tasks[idx]);
});

tasksRouter.delete("/:id", (req, res) => {
  let tasks = getTasks();
  stopTask(req.params.id);
  tasks = tasks.filter((t) => t.id !== req.params.id);
  saveTasks(tasks);
  res.json({ success: true });
});
