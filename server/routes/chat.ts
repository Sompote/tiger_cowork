import { Router } from "express";
import { v4 as uuid } from "uuid";
import { getChatHistory, saveChatHistory, ChatSession } from "../services/data";
import { callTigerBot } from "../services/tigerbot";

export const chatRouter = Router();

// Get all chat sessions
chatRouter.get("/sessions", (_req, res) => {
  const sessions = getChatHistory();
  res.json(sessions.map((s) => ({ id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt, messageCount: s.messages.length })));
});

// Get single session
chatRouter.get("/sessions/:id", (req, res) => {
  const sessions = getChatHistory();
  const session = sessions.find((s) => s.id === req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  res.json(session);
});

// Create new session
chatRouter.post("/sessions", (req, res) => {
  const sessions = getChatHistory();
  const session: ChatSession = {
    id: uuid(),
    title: req.body.title || "New Chat",
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  sessions.push(session);
  saveChatHistory(sessions);
  res.json(session);
});

// Delete session
chatRouter.delete("/sessions/:id", (req, res) => {
  let sessions = getChatHistory();
  sessions = sessions.filter((s) => s.id !== req.params.id);
  saveChatHistory(sessions);
  res.json({ success: true });
});

// Rename session
chatRouter.patch("/sessions/:id", (req, res) => {
  const sessions = getChatHistory();
  const session = sessions.find((s) => s.id === req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (req.body.title) session.title = req.body.title;
  saveChatHistory(sessions);
  res.json(session);
});

// Send message (non-streaming fallback)
chatRouter.post("/sessions/:id/messages", async (req, res) => {
  const sessions = getChatHistory();
  const session = sessions.find((s) => s.id === req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });

  session.messages.push({
    role: "user",
    content: req.body.message,
    timestamp: new Date().toISOString(),
  });

  const chatMessages = session.messages.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));

  const result = await callTigerBot(chatMessages);
  session.messages.push({
    role: "assistant",
    content: result.content,
    timestamp: new Date().toISOString(),
  });
  session.updatedAt = new Date().toISOString();
  saveChatHistory(sessions);

  res.json({ content: result.content, usage: result.usage });
});
