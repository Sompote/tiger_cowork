/**
 * Inter-agent communication protocols: TCP, Bus, Queue
 *
 * These are real in-process implementations that sub-agents use to
 * exchange messages during execution.
 *
 *  - TCP:   Point-to-point bidirectional channel via Node net server/client on localhost
 *  - Bus:   In-process pub/sub event bus (topics)
 *  - Queue: FIFO message queue with persistence per channel
 */

import net from "net";
import { EventEmitter } from "events";

// ─── Types ───

export interface ProtocolMessage {
  from: string;      // sender agent id
  to?: string;       // recipient agent id (optional for bus broadcast)
  topic: string;
  payload: any;
  timestamp: string;
}

// ─── TCP Protocol ───
// Creates ephemeral localhost TCP servers per agent pair for bidirectional messaging.

interface TcpChannel {
  server: net.Server;
  port: number;
  buffer: ProtocolMessage[];
  clients: net.Socket[];
}

const tcpChannels = new Map<string, TcpChannel>();

function tcpChannelKey(from: string, to: string): string {
  return [from, to].sort().join("<->"); // bidirectional
}

export async function tcpOpen(agentA: string, agentB: string): Promise<{ port: number; channelId: string }> {
  const key = tcpChannelKey(agentA, agentB);
  if (tcpChannels.has(key)) {
    const ch = tcpChannels.get(key)!;
    return { port: ch.port, channelId: key };
  }

  return new Promise((resolve, reject) => {
    const buffer: ProtocolMessage[] = [];
    const clients: net.Socket[] = [];

    const server = net.createServer((socket) => {
      clients.push(socket);
      let pending = "";

      socket.on("data", (data) => {
        pending += data.toString();
        // Messages are newline-delimited JSON
        const lines = pending.split("\n");
        pending = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg: ProtocolMessage = JSON.parse(line);
            msg.timestamp = msg.timestamp || new Date().toISOString();
            buffer.push(msg);
            // Forward to other connected clients
            for (const c of clients) {
              if (c !== socket && !c.destroyed) {
                c.write(line + "\n");
              }
            }
          } catch {}
        }
      });

      socket.on("close", () => {
        const idx = clients.indexOf(socket);
        if (idx >= 0) clients.splice(idx, 1);
      });

      socket.on("error", () => {});
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as net.AddressInfo;
      const channel: TcpChannel = { server, port: addr.port, buffer, clients };
      tcpChannels.set(key, channel);
      console.log(`[Protocol:TCP] Channel ${key} opened on port ${addr.port}`);
      resolve({ port: addr.port, channelId: key });
    });

    server.on("error", (err) => {
      reject(err);
    });
  });
}

export async function tcpSend(agentFrom: string, agentTo: string, topic: string, payload: any): Promise<boolean> {
  const key = tcpChannelKey(agentFrom, agentTo);
  const ch = tcpChannels.get(key);
  if (!ch) return false;

  const msg: ProtocolMessage = {
    from: agentFrom,
    to: agentTo,
    topic,
    payload,
    timestamp: new Date().toISOString(),
  };

  return new Promise((resolve) => {
    const client = net.createConnection({ port: ch.port, host: "127.0.0.1" }, () => {
      client.write(JSON.stringify(msg) + "\n");
      client.end();
      resolve(true);
    });
    client.on("error", () => resolve(false));
  });
}

export function tcpRead(agentA: string, agentB: string): ProtocolMessage[] {
  const key = tcpChannelKey(agentA, agentB);
  const ch = tcpChannels.get(key);
  return ch ? [...ch.buffer] : [];
}

export function tcpClose(agentA: string, agentB: string): void {
  const key = tcpChannelKey(agentA, agentB);
  const ch = tcpChannels.get(key);
  if (ch) {
    for (const c of ch.clients) c.destroy();
    ch.server.close();
    tcpChannels.delete(key);
    console.log(`[Protocol:TCP] Channel ${key} closed`);
  }
}

// ─── Bus Protocol ───
// In-process pub/sub event bus. Agents subscribe to topics and broadcast.

class AgentBus extends EventEmitter {
  private history: ProtocolMessage[] = [];
  private maxHistory = 500;

  publish(msg: ProtocolMessage): void {
    msg.timestamp = msg.timestamp || new Date().toISOString();
    this.history.push(msg);
    if (this.history.length > this.maxHistory) this.history.shift();
    this.emit(`topic:${msg.topic}`, msg);
    this.emit("message", msg);
  }

  subscribe(topic: string, handler: (msg: ProtocolMessage) => void): () => void {
    this.on(`topic:${topic}`, handler);
    return () => this.off(`topic:${topic}`, handler);
  }

  getHistory(topic?: string): ProtocolMessage[] {
    if (topic) return this.history.filter((m) => m.topic === topic);
    return [...this.history];
  }

  clear(): void {
    this.history = [];
    this.removeAllListeners();
  }
}

// One bus per session/system
const busInstances = new Map<string, AgentBus>();

export function busGet(sessionId: string): AgentBus {
  if (!busInstances.has(sessionId)) {
    busInstances.set(sessionId, new AgentBus());
    console.log(`[Protocol:Bus] Created bus for session ${sessionId}`);
  }
  return busInstances.get(sessionId)!;
}

export function busPublish(sessionId: string, from: string, topic: string, payload: any): void {
  const bus = busGet(sessionId);
  bus.publish({ from, topic, payload, timestamp: new Date().toISOString() });
}

export function busSubscribe(sessionId: string, topic: string, handler: (msg: ProtocolMessage) => void): () => void {
  const bus = busGet(sessionId);
  return bus.subscribe(topic, handler);
}

export function busHistory(sessionId: string, topic?: string): ProtocolMessage[] {
  const bus = busGet(sessionId);
  return bus.getHistory(topic);
}

export function busDestroy(sessionId: string): void {
  const bus = busInstances.get(sessionId);
  if (bus) {
    bus.clear();
    busInstances.delete(sessionId);
    console.log(`[Protocol:Bus] Destroyed bus for session ${sessionId}`);
  }
}

// ─── Queue Protocol ───
// Per-channel FIFO message queue. Producers enqueue, consumers dequeue.

interface MessageQueue {
  messages: ProtocolMessage[];
  maxSize: number;
}

const queues = new Map<string, MessageQueue>();

function queueKey(from: string, to: string, topic?: string): string {
  return `${from}->${to}${topic ? `:${topic}` : ""}`;
}

export function queueEnqueue(from: string, to: string, topic: string, payload: any): number {
  const key = queueKey(from, to, topic);
  if (!queues.has(key)) {
    queues.set(key, { messages: [], maxSize: 200 });
  }
  const q = queues.get(key)!;
  const msg: ProtocolMessage = {
    from,
    to,
    topic,
    payload,
    timestamp: new Date().toISOString(),
  };
  q.messages.push(msg);
  if (q.messages.length > q.maxSize) q.messages.shift();
  console.log(`[Protocol:Queue] Enqueued ${key} (depth=${q.messages.length})`);
  return q.messages.length;
}

export function queueDequeue(from: string, to: string, topic?: string): ProtocolMessage | null {
  const key = queueKey(from, to, topic);
  const q = queues.get(key);
  if (!q || q.messages.length === 0) return null;
  return q.messages.shift()!;
}

export function queuePeek(from: string, to: string, topic?: string, count: number = 5): ProtocolMessage[] {
  const key = queueKey(from, to, topic);
  const q = queues.get(key);
  if (!q) return [];
  return q.messages.slice(0, count);
}

export function queueDepth(from: string, to: string, topic?: string): number {
  const key = queueKey(from, to, topic);
  const q = queues.get(key);
  return q ? q.messages.length : 0;
}

export function queueDrain(from: string, to: string, topic?: string): ProtocolMessage[] {
  const key = queueKey(from, to, topic);
  const q = queues.get(key);
  if (!q) return [];
  const all = q.messages.splice(0);
  console.log(`[Protocol:Queue] Drained ${key} (${all.length} messages)`);
  return all;
}

export function queueClear(from: string, to: string, topic?: string): void {
  const key = queueKey(from, to, topic);
  queues.delete(key);
}

// ─── Cleanup ───
// Call this when a session ends to free all protocol resources

export function cleanupSessionProtocols(sessionId: string): void {
  busDestroy(sessionId);
  // Clean TCP channels that include session-scoped agents
  for (const [key, ch] of tcpChannels.entries()) {
    if (key.includes(sessionId)) {
      for (const c of ch.clients) c.destroy();
      ch.server.close();
      tcpChannels.delete(key);
    }
  }
}

// ─── Status / Debug ───

export function getProtocolStatus(): {
  tcp: { channels: number; details: { id: string; port: number; buffered: number }[] };
  bus: { sessions: number; details: { session: string; history: number }[] };
  queue: { channels: number; details: { id: string; depth: number }[] };
} {
  return {
    tcp: {
      channels: tcpChannels.size,
      details: Array.from(tcpChannels.entries()).map(([id, ch]) => ({
        id, port: ch.port, buffered: ch.buffer.length,
      })),
    },
    bus: {
      sessions: busInstances.size,
      details: Array.from(busInstances.entries()).map(([session, bus]) => ({
        session, history: bus.getHistory().length,
      })),
    },
    queue: {
      channels: queues.size,
      details: Array.from(queues.entries()).map(([id, q]) => ({
        id, depth: q.messages.length,
      })),
    },
  };
}
