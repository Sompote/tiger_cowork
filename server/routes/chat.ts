import { FastifyInstance } from "fastify";
import { v4 as uuid } from "uuid";
import { getChatHistory, updateChatHistory, ChatSession, deleteAgentHistory } from "../services/data";
import { callTigerBot } from "../services/tigerbot";
import { getAutoCreatedArchitecture, getRealtimeSession, shutdownRealtimeSession } from "../services/toolbox";
import yaml from "js-yaml";
import path from "path";
import fs from "fs";

const ACTIVITY_LOG_DIR = path.resolve("data", "activity_logs");
const CHAT_LOG_DIR = path.resolve("data", "chat_logs");

// Session ids are UUIDs/generated ids — anything else in the URL param is a
// crafted path (e.g. "../../data/x") and must not reach the filesystem.
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/;

export async function chatRoutes(fastify: FastifyInstance) {
  // Get activity log for a session
  fastify.get("/sessions/:id/activity", async (request, reply) => {
    const sessionId = (request.params as any).id;
    if (!SAFE_SESSION_ID.test(sessionId)) { reply.code(400); return { ok: false, error: "Invalid session id" }; }
    const logPath = path.join(ACTIVITY_LOG_DIR, `${sessionId}.log`);
    try {
      const content = fs.readFileSync(logPath, "utf-8");
      return { ok: true, content };
    } catch {
      return { ok: true, content: "" };
    }
  });

  // Get chat log for a session
  fastify.get("/sessions/:id/chatlog", async (request, reply) => {
    const sessionId = (request.params as any).id;
    if (!SAFE_SESSION_ID.test(sessionId)) { reply.code(400); return { ok: false, error: "Invalid session id" }; }
    const logPath = path.join(CHAT_LOG_DIR, `${sessionId}.log`);
    try {
      const content = fs.readFileSync(logPath, "utf-8");
      return { ok: true, content };
    } catch {
      return { ok: true, content: "" };
    }
  });

  // Get all chat sessions
  fastify.get("/sessions", async (request, reply) => {
    const sessions = await getChatHistory();
    return sessions.map((s) => ({ id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt, messageCount: s.messages.length }));
  });

  // Get single session
  fastify.get("/sessions/:id", async (request, reply) => {
    const sessionId = (request.params as any).id;
    const sessions = await getChatHistory();
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) { reply.code(404); return { error: "Session not found" }; }

    // Include auto-created architecture info if present
    const autoArchFilename = getAutoCreatedArchitecture(sessionId);
    if (autoArchFilename) {
      try {
        const filePath = path.join(path.resolve("data/agents"), autoArchFilename);
        const content = fs.readFileSync(filePath, "utf8");
        const parsed = yaml.load(content) as any;
        (session as any).autoCreatedArch = {
          filename: autoArchFilename,
          systemName: parsed?.system?.name || autoArchFilename.replace(/\.ya?ml$/, ""),
        };
      } catch {
        (session as any).autoCreatedArch = {
          filename: autoArchFilename,
          systemName: autoArchFilename.replace(/\.ya?ml$/, ""),
        };
      }
    }

    return session;
  });

  // Create new session
  fastify.post("/sessions", async (request, reply) => {
    const body = request.body as any;
    const session: ChatSession = {
      id: uuid(),
      title: body.title || "New Chat",
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await updateChatHistory((sessions) => {
      sessions.push(session);
      return sessions;
    });
    return session;
  });

  // Delete session
  fastify.delete("/sessions/:id", async (request, reply) => {
    const sessionId = (request.params as any).id;
    // deleteAgentHistory does a recursive rm under this id — never let a
    // crafted param reach it.
    if (!SAFE_SESSION_ID.test(sessionId)) { reply.code(400); return { error: "Invalid session id" }; }
    await updateChatHistory((sessions) => sessions.filter((s) => s.id !== sessionId));
    // Free realtime agents, bus, blackboard, and TCP channels for this session
    if (getRealtimeSession(sessionId)) {
      try { shutdownRealtimeSession(sessionId); } catch {}
    }
    // Clean up agent history folder for this session
    await deleteAgentHistory(sessionId);
    return { success: true };
  });

  // Rename session
  fastify.patch("/sessions/:id", async (request, reply) => {
    const body = request.body as any;
    let updated: ChatSession | undefined;
    await updateChatHistory((sessions) => {
      const session = sessions.find((s) => s.id === (request.params as any).id);
      if (session && body.title) session.title = body.title;
      updated = session;
      return sessions;
    });
    if (!updated) { reply.code(404); return { error: "Session not found" }; }
    return updated;
  });

  // Save thumb up/down + optional comment on a single message (by index)
  fastify.post("/sessions/:id/messages/:index/feedback", async (request, reply) => {
    const sessionId = (request.params as any).id;
    const index = parseInt((request.params as any).index, 10);
    const body = (request.body as any) || {};
    const rating = body.rating === "up" || body.rating === "down" ? body.rating : undefined;
    const comment = typeof body.comment === "string" ? body.comment.slice(0, 4000) : undefined;
    if (rating === undefined && comment === undefined && body.clear !== true) {
      reply.code(400); return { ok: false, error: "Provide rating, comment, or clear=true" };
    }
    let error: { code: number; message: string } | null = null;
    let feedback: any = null;
    await updateChatHistory((sessions) => {
      const session = sessions.find((s) => s.id === sessionId);
      if (!session) { error = { code: 404, message: "Session not found" }; return sessions; }
      if (!Number.isFinite(index) || index < 0 || index >= session.messages.length) {
        error = { code: 400, message: "Invalid message index" };
        return sessions;
      }
      const msg: any = session.messages[index];
      if (body.clear === true) {
        delete msg.feedback;
      } else {
        const existing = msg.feedback || {};
        msg.feedback = {
          ...existing,
          ...(rating !== undefined ? { rating } : {}),
          ...(comment !== undefined ? { comment } : {}),
          submittedAt: new Date().toISOString(),
        };
      }
      feedback = msg.feedback || null;
      // Bump updatedAt so the auto-skill loop will re-consider this session
      session.updatedAt = new Date().toISOString();
      return sessions;
    });
    if (error) { reply.code((error as any).code); return { ok: false, error: (error as any).message }; }
    return { ok: true, feedback };
  });

  // Send message (non-streaming fallback)
  fastify.post("/sessions/:id/messages", async (request, reply) => {
    const sessionId = (request.params as any).id;
    const sessions = await getChatHistory();
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) { reply.code(404); return { error: "Session not found" }; }

    const body = request.body as any;
    const userMessage = {
      role: "user",
      content: body.message,
      timestamp: new Date().toISOString(),
    };

    const chatMessages = [...session.messages, userMessage].map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));

    // The LLM call can take minutes — append to fresh state afterwards
    // instead of saving the pre-call snapshot wholesale.
    const result = await callTigerBot(chatMessages);
    const assistantMessage = {
      role: "assistant",
      content: result.content,
      timestamp: new Date().toISOString(),
    };
    await updateChatHistory((fresh) => {
      const target = fresh.find((s) => s.id === sessionId);
      if (target) {
        target.messages.push(userMessage, assistantMessage);
        target.updatedAt = new Date().toISOString();
      }
      return fresh;
    });

    return { content: result.content, usage: result.usage };
  });
}
