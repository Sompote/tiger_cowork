import { useEffect, useMemo, useRef, useState } from "react";
import { useSocket } from "../hooks/useSocket";

interface AgentDiagramProps {
  agentTools: Record<string, string[]>;
  activeAgents: string[];
  doneAgents: string[];
  status: string;
}

type LinkKind = "delegate" | "direct" | "bus" | "spawn";
type Direction = "outbound" | "return";

interface Signal {
  id: number;
  from: string;
  to: string;
  kind: LinkKind;
  direction: Direction;
  tool: string;
  startedAt: number;
}

interface BBTask {
  id: string;
  desc: string;
  proposer: string;
  bids: { bidder: string; conf: number; since: number }[];
  status: "open" | "awarded" | "completed";
  awardedTo?: string;
  createdAt: number;
  updatedAt: number;
}

const BB_MAX_CARDS = 4;

const SIGNAL_DURATION_MS = 4000;
const SIGNAL_LOOP_MS = 1000;

const TOOL_TO_KIND: Record<string, LinkKind> = {
  send_task: "delegate",
  wait_result: "delegate",
  spawn_subagent: "spawn",
  proto_tcp_send: "direct",
  proto_tcp_read: "direct",
  proto_bus_publish: "bus",
  proto_bus_history: "bus",
  bb_propose: "delegate",
  bb_bid: "delegate",
  bb_award: "delegate",
};

const RETURN_TOOLS = new Set(["wait_result", "proto_tcp_read", "proto_bus_history", "bb_bid"]);

// Light-theme palette
const COLORS = {
  bg: "#ffffff",
  panel: "#f9fafb",
  border: "#e5e7eb",
  text: "#111827",
  textDim: "#6b7280",
  textFaint: "#9ca3af",
  idleEdge: "#d1d5db",
  working: "#2563eb",
  waiting: "#d97706",
  done: "#059669",
  doneEdge: "#a7f3d0",
  delegate: "#f59e0b",
  direct: "#db2777",
  bus: "#0891b2",
  spawn: "#7c3aed",
  orchestrator: "#b45309",
};

const KIND_COLOR: Record<LinkKind, string> = {
  delegate: COLORS.delegate,
  direct: COLORS.direct,
  bus: COLORS.bus,
  spawn: COLORS.spawn,
};

function formatDoing(tool: string): string {
  const m: Record<string, string> = {
    web_search: "Searching web",
    fetch_url: "Fetching URL",
    run_python: "Running Python",
    run_react: "Building UI",
    run_shell: "Running shell",
    read_file: "Reading file",
    write_file: "Writing file",
    list_files: "Listing files",
    send_task: "Dispatching task",
    wait_result: "Awaiting result",
    proto_bus_publish: "Broadcasting",
    proto_bus_history: "Reading bus",
    proto_tcp_send: "TCP send",
    proto_tcp_read: "TCP recv",
    spawn_subagent: "Spawning helper",
    bb_propose: "Proposing task",
    bb_bid: "Bidding",
    bb_award: "Awarding",
    bb_complete: "Task complete",
    load_skill: "Loading skill",
  };
  if (tool.startsWith("remote:")) return tool.slice(7);
  return m[tool] || tool;
}

function colorFor(name: string): string {
  const palette = ["#2563eb", "#db2777", "#d97706", "#059669", "#7c3aed", "#dc2626", "#0891b2", "#ca8a04"];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  return palette[Math.abs(h) % palette.length];
}

function edgeKey(a: string, b: string): string {
  return [a, b].sort().join("\u0001");
}

export default function AgentDiagram({ agentTools, activeAgents, doneAgents, status }: AgentDiagramProps) {
  const agents = useMemo(() => Object.keys(agentTools), [agentTools]);

  const orchestrator = useMemo(() => {
    if (agents.length === 0) return null;
    const named = agents.find(a => /orchestr|coord|leader|manager|^agent_?1$/i.test(a));
    if (named) return named;
    let best = agents[0];
    let bestScore = -1;
    for (const a of agents) {
      const tools = agentTools[a] || [];
      const score = tools.filter(t => t === "send_task" || t === "spawn_subagent" || t === "bb_award").length;
      if (score > bestScore) { bestScore = score; best = a; }
    }
    return best;
  }, [agents, agentTools]);

  const workers = useMemo(() => agents.filter(a => a !== orchestrator), [agents, orchestrator]);

  const sigIdRef = useRef(0);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [bbTasks, setBbTasks] = useState<BBTask[]>([]);
  // FIFO of placeholder propose ids per proposer label, used to reconcile to real
  // server-generated task ids when the bb_propose tool_result arrives.
  const pendingProposesRef = useRef<Map<string, string[]>>(new Map());
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [fullscreen, setFullscreen] = useState(false);
  const panDragRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  // Persistent set of edges that have ever fired
  const seenEdgesRef = useRef<Map<string, LinkKind>>(new Map());
  // Open delegations: caller is parked waiting for callee. Edge stays "awaiting" until cleared.
  // Key is `${caller}\u0001${callee}` (directional, not symmetric).
  const pendingRef = useRef<Map<string, { caller: string; callee: string; kind: LinkKind; since: number }>>(new Map());
  const [, bumpEdges] = useState(0);
  // Dedupe guard: most recent (from→to/kind/direction) emission timestamp.
  // Prevents the activeAgents-transition watcher and the socket watcher from firing
  // duplicate moving-circle animations within ~600ms of each other.
  const recentEmitRef = useRef<Map<string, number>>(new Map());
  const DEDUPE_MS = 600;

  const openPending = (caller: string, callee: string, kind: LinkKind) => {
    if (!caller || !callee) return;
    const k = `${caller}\u0001${callee}`;
    pendingRef.current.set(k, { caller, callee, kind, since: Date.now() });
    bumpEdges(n => n + 1);
  };
  const closePending = (caller: string, callee: string) => {
    if (!caller || !callee) return;
    pendingRef.current.delete(`${caller}\u0001${callee}`);
    bumpEdges(n => n + 1);
  };

  // Live signals come from socket events, which carry the actual from/to.
  const { onStatus } = useSocket();
  const orchestratorRef = useRef<string | null>(null);
  orchestratorRef.current = orchestrator;

  useEffect(() => {
    const ORCH = "Orchestrator"; // synthetic name used by harness in agentTools
    const unsub = onStatus((data: any) => {
      if (!data) return;
      const now = Date.now();
      const status = data.status;
      const orch = orchestratorRef.current || ORCH;

      const emit = (sig: Omit<Signal, "id">) => {
        if (!sig.from || !sig.to) return;
        // Dedupe — skip if an identical signal fired within DEDUPE_MS
        const dKey = `${sig.from}\u0001${sig.to}\u0001${sig.kind}\u0001${sig.direction}`;
        const last = recentEmitRef.current.get(dKey) || 0;
        if (sig.startedAt - last < DEDUPE_MS) return;
        recentEmitRef.current.set(dKey, sig.startedAt);
        if (sig.to !== "BUS" && !sig.from.startsWith("BB:") && !sig.to.startsWith("BB:")) {
          const k = edgeKey(sig.from, sig.to);
          if (!seenEdgesRef.current.has(k)) {
            seenEdgesRef.current.set(k, sig.kind);
            bumpEdges(n => n + 1);
          }
        }
        setSignals(prev => [...prev, { id: ++sigIdRef.current, ...sig }]);
      };

      // Realtime worker boot/finish — synthesizes a delegate edge from orchestrator
      if (status === "realtime_agent_working") {
        const target = data.label || data.agentId;
        if (target) {
          openPending(orch, target, "delegate");
          emit({ from: orch, to: target, kind: "delegate", direction: "outbound", tool: "send_task", startedAt: now });
        }
        return;
      }
      if (status === "realtime_agent_done") {
        const source = data.label || data.agentId;
        if (source) {
          closePending(orch, source);
          emit({ from: source, to: orch, kind: "delegate", direction: "return", tool: "wait_result", startedAt: now });
        }
        return;
      }
      if (status === "subagent_spawn") {
        const target = data.label || data.agentId;
        const parent = data.parent || data.parentLabel || orch;
        if (target) {
          openPending(parent, target, "spawn");
          emit({ from: parent, to: target, kind: "spawn", direction: "outbound", tool: "spawn_subagent", startedAt: now });
        }
        return;
      }
      if (status === "subagent_done") {
        const source = data.label || data.agentId;
        const parent = data.parent || data.parentLabel || orch;
        if (source) {
          closePending(parent, source);
          emit({ from: source, to: parent, kind: "spawn", direction: "return", tool: "subagent_done", startedAt: now });
        }
        return;
      }

      // Bid request kick-off — bidder is about to bid on a known task. Seed the BB
      // card with the description from the bus payload so the card never appears
      // empty even if the proposer's bb_propose tool_call is delayed.
      if (status === "realtime_agent_bidding" && data.task_id) {
        const id = String(data.task_id);
        const desc = String(data.description || "");
        const proposedBy = String(data.proposed_by || "?");
        setBbTasks(prev => {
          const idx = prev.findIndex(t => t.id === id);
          if (idx === -1) {
            const fresh: BBTask = {
              id,
              desc: desc || "(awaiting bids)",
              proposer: proposedBy,
              bids: [],
              status: "open",
              createdAt: now,
              updatedAt: now,
            };
            return [fresh, ...prev].slice(0, 8);
          }
          const ex = prev[idx];
          const isPlaceholderDesc = !ex.desc || ex.desc === "(bid received)" || ex.desc === "(awaiting bids)";
          const isPlaceholderProposer = !ex.proposer || ex.proposer === "?";
          if (!isPlaceholderDesc && !isPlaceholderProposer) return prev;
          const next = [...prev];
          next[idx] = {
            ...ex,
            desc: isPlaceholderDesc && desc ? desc : ex.desc,
            proposer: isPlaceholderProposer && proposedBy !== "?" ? proposedBy : ex.proposer,
            updatedAt: now,
          };
          return next;
        });
        return;
      }

      // Tool result with bb winner / completion data — server populates these for bb_*
      if ((status === "tool_result" || status === "subagent_tool_done" || status === "realtime_agent_tool_done")
        && data.tool && String(data.tool).startsWith("bb_")) {
        const tool: string = data.tool;
        const id = data.task_id ? String(data.task_id) : "";
        const proposer = data.label || data.agentId || orch;
        if (tool === "bb_propose" && id) {
          // Reconcile placeholder id (assigned at tool_call time) → real server id.
          const queue = pendingProposesRef.current.get(proposer) || [];
          const placeholder = queue.shift();
          pendingProposesRef.current.set(proposer, queue);
          if (placeholder && placeholder !== id) {
            setBbTasks(prev => {
              const phIdx = prev.findIndex(t => t.id === placeholder);
              if (phIdx === -1) return prev;
              const realIdx = prev.findIndex(t => t.id === id);
              if (realIdx === -1) {
                // Simple rename in place — keeps slot ordering stable.
                const next = [...prev];
                next[phIdx] = { ...next[phIdx], id, updatedAt: now };
                return next;
              }
              // Both exist (a bid arrived before this reconcile). Merge them: keep
              // the placeholder's description/proposer, the real card's bids/award.
              const ph = prev[phIdx];
              const real = prev[realIdx];
              const merged: BBTask = {
                ...real,
                desc: ph.desc || real.desc,
                proposer: ph.proposer && ph.proposer !== "?" ? ph.proposer : real.proposer,
                createdAt: Math.min(ph.createdAt, real.createdAt),
                updatedAt: now,
              };
              const next = [...prev];
              next[phIdx] = merged;
              next.splice(realIdx, 1);
              return next;
            });
          }
          // Fast-path: bb_propose auto-awards the winner — update card status
          if (data.awarded_to) {
            const winner = String(data.awarded_to);
            setBbTasks(prev => {
              const idx = prev.findIndex(t => t.id === id);
              if (idx === -1) return prev;
              const next = [...prev];
              next[idx] = { ...next[idx], status: "awarded", awardedTo: winner, updatedAt: now };
              return next;
            });
            emit({ from: `BB:${id}`, to: winner, kind: "delegate", direction: "return", tool: "bb_award", startedAt: now });
          }
          return;
        }
        if (tool === "bb_award" && id && data.awarded_to) {
          const winner = String(data.awarded_to);
          setBbTasks(prev => {
            const idx = prev.findIndex(t => t.id === id);
            if (idx === -1) return prev;
            const next = [...prev];
            next[idx] = { ...next[idx], status: "awarded", awardedTo: winner, updatedAt: now };
            return next;
          });
          // Animate winner reveal: BB card → winner agent
          emit({ from: `BB:${id}`, to: winner, kind: "delegate", direction: "return", tool: "bb_award", startedAt: now });
        } else if (tool === "bb_complete" && id) {
          // Drop the finished card from the board after the completion particle finishes.
          setTimeout(() => {
            setBbTasks(prev => prev.filter(t => t.id !== id));
          }, SIGNAL_DURATION_MS);
        }
        return;
      }

      // Tool calls (orchestrator-level or agent-level) with real args
      if ((status === "tool_call" || status === "realtime_agent_tool" || status === "subagent_tool") && data.tool) {
        const tool: string = data.tool;
        const args = data.args || {};

        // ─── Blackboard tools: post to board + animate to/from a BB target ───
        if (tool === "bb_propose" || tool === "bb_bid" || tool === "bb_award" || tool === "bb_complete") {
          const id = String(args.task_id || args.taskId || args.id || `bb-${now}`);
          const agent = data.label || data.agentId || orch;
          const bbTarget = `BB:${id}`;

          if (tool === "bb_propose") {
            const desc = String(
              args.description || args.task || args.summary || args.task_description ||
              args.title || args.text || args.detail || ""
            );
            setBbTasks(prev => {
              const idx = prev.findIndex(t => t.id === id);
              if (idx >= 0) {
                // A card with this id already exists — typically because a fast bid
                // arrived before this propose event reached the client. Merge in the
                // description and proposer so the card isn't stuck on "(bid received)".
                const ex = prev[idx];
                const isPlaceholderDesc = !ex.desc || ex.desc === "(bid received)";
                const isPlaceholderProposer = !ex.proposer || ex.proposer === "?";
                const next = [...prev];
                next[idx] = {
                  ...ex,
                  desc: isPlaceholderDesc ? desc : ex.desc,
                  proposer: isPlaceholderProposer ? agent : ex.proposer,
                  updatedAt: now,
                };
                return next;
              }
              const fresh: BBTask = { id, desc, proposer: agent, bids: [], status: "open", createdAt: now, updatedAt: now };
              return [fresh, ...prev].slice(0, 8);
            });
            // If the LLM didn't provide a task_id, the server generates one. Track this
            // placeholder so we can rewrite it once the matching tool_result arrives.
            if (!args.task_id && !args.taskId && !args.id) {
              const queue = pendingProposesRef.current.get(agent) || [];
              queue.push(id);
              pendingProposesRef.current.set(agent, queue);
            }
            emit({ from: agent, to: bbTarget, kind: "delegate", direction: "outbound", tool, startedAt: now });
          } else if (tool === "bb_bid") {
            const conf = Number(args.confidence ?? args.score ?? 0);
            // Some bidders include the task description (e.g. echoed from bb_read) in
            // the reasoning field. Use it as a fallback if the proposer's bb_propose
            // event hasn't been processed yet so the card never shows blank.
            const fallbackDesc = String(args.description || args.task || args.task_description || "").trim();
            setBbTasks(prev => {
              const idx = prev.findIndex(t => t.id === id);
              if (idx === -1) {
                const fresh: BBTask = {
                  id,
                  desc: fallbackDesc || "(bid received)",
                  proposer: "?",
                  bids: [{ bidder: agent, conf, since: now }],
                  status: "open",
                  createdAt: now,
                  updatedAt: now,
                };
                return [fresh, ...prev].slice(0, 8);
              }
              const next = [...prev];
              const ex = next[idx];
              const desc = (!ex.desc || ex.desc === "(bid received)") && fallbackDesc ? fallbackDesc : ex.desc;
              if (!ex.bids.some(b => b.bidder === agent)) {
                next[idx] = { ...ex, desc, bids: [...ex.bids, { bidder: agent, conf, since: now }], updatedAt: now };
              } else if (desc !== ex.desc) {
                next[idx] = { ...ex, desc, updatedAt: now };
              }
              return next;
            });
            emit({ from: agent, to: bbTarget, kind: "delegate", direction: "outbound", tool, startedAt: now });
          } else if (tool === "bb_award") {
            const winner = String(args.winner || args.award_to || args.to || args.agent_id || "");
            setBbTasks(prev => {
              const idx = prev.findIndex(t => t.id === id);
              if (idx === -1) return prev;
              const next = [...prev];
              next[idx] = { ...next[idx], status: "awarded", awardedTo: winner || next[idx].awardedTo, updatedAt: now };
              return next;
            });
            if (winner) emit({ from: bbTarget, to: winner, kind: "delegate", direction: "return", tool, startedAt: now });
          } else if (tool === "bb_complete") {
            setBbTasks(prev => {
              const idx = prev.findIndex(t => t.id === id);
              if (idx === -1) return prev;
              const next = [...prev];
              next[idx] = { ...next[idx], status: "completed", updatedAt: now };
              return next;
            });
            emit({ from: agent, to: bbTarget, kind: "delegate", direction: "return", tool, startedAt: now });
          }
          return;
        }

        const kind = TOOL_TO_KIND[tool];
        if (!kind) return;
        const isReturn = RETURN_TOOLS.has(tool);

        // Sender: explicit label > agentId > implied orchestrator (harness-level tool_call)
        let from = data.label || data.agentId || orch;
        let to = "";
        let direction: Direction = isReturn ? "return" : "outbound";

        if (kind === "bus") {
          if (isReturn) {
            // Reading from bus: data flows BUS → caller agent
            to = from;
            from = "BUS";
          } else {
            to = "BUS";
          }
        } else if (tool === "send_task") {
          to = args.to || "";
        } else if (tool === "wait_result") {
          // wait_result: data flows args.from → caller
          to = from;
          from = args.from || "";
        } else if (tool === "spawn_subagent") {
          to = args.label || args.name || args.agent || "";
        } else if (tool === "proto_tcp_send") {
          to = args.to || args.target || "";
        } else if (tool === "proto_tcp_read") {
          to = from;
          from = args.from || args.source || "";
        } else if (tool === "bb_propose" || tool === "bb_award") {
          to = args.to || args.winner || args.agent_id || "";
        } else if (tool === "bb_bid") {
          // bidder responding to a proposer — best-effort, may be empty
          to = args.proposer || args.to || "";
        }

        if (!from || !to) return;

        // Track the open-delegation lifecycle so the edge stays "awaiting" between
        // send_task and the matching wait_result.
        if (tool === "send_task" || tool === "spawn_subagent") {
          openPending(from, to, kind);
        } else if (tool === "wait_result") {
          // The caller is `to` here (we swapped above), the awaited callee is `from`.
          closePending(to, from);
        }

        emit({ from, to, kind, direction, tool, startedAt: now });
      }
    });
    return unsub;
  }, [onStatus]);

  // Detect transitions in activeAgents / doneAgents and emit a 2-second moving signal
  // for each newly-dispatched (active) and newly-finished (done) worker. This is the
  // reliable source for "real delegation happened" since the server-side throttle
  // tends to coalesce the actual send_task / wait_result socket events.
  const prevActiveRef = useRef<Set<string>>(new Set());
  const prevDoneRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const orch = orchestratorRef.current;
    if (!orch) return;
    const now = Date.now();
    const curActive = new Set(activeAgents || []);
    const curDone = new Set(doneAgents || []);
    const prevActive = prevActiveRef.current;
    const prevDone = prevDoneRef.current;

    const toEmit: Omit<Signal, "id">[] = [];
    let edgesChanged = false;

    // Newly active worker → orchestrator just sent it a task
    for (const w of curActive) {
      if (w === orch || curDone.has(w)) continue;
      if (prevActive.has(w)) continue;
      const dKey = `${orch}\u0001${w}\u0001delegate\u0001outbound`;
      const last = recentEmitRef.current.get(dKey) || 0;
      if (now - last < DEDUPE_MS) continue;
      recentEmitRef.current.set(dKey, now);
      const ek = edgeKey(orch, w);
      if (!seenEdgesRef.current.has(ek)) {
        seenEdgesRef.current.set(ek, "delegate");
        edgesChanged = true;
      }
      toEmit.push({ from: orch, to: w, kind: "delegate", direction: "outbound", tool: "send_task", startedAt: now });
    }

    // Newly done worker → result coming back to the orchestrator
    for (const w of curDone) {
      if (w === orch) continue;
      if (prevDone.has(w)) continue;
      const dKey = `${w}\u0001${orch}\u0001delegate\u0001return`;
      const last = recentEmitRef.current.get(dKey) || 0;
      if (now - last < DEDUPE_MS) continue;
      recentEmitRef.current.set(dKey, now);
      const ek = edgeKey(w, orch);
      if (!seenEdgesRef.current.has(ek)) {
        seenEdgesRef.current.set(ek, "delegate");
        edgesChanged = true;
      }
      toEmit.push({ from: w, to: orch, kind: "delegate", direction: "return", tool: "wait_result", startedAt: now });
    }

    if (toEmit.length > 0) {
      setSignals(prev => [...prev, ...toEmit.map(s => ({ id: ++sigIdRef.current, ...s }))]);
    }
    if (edgesChanged) bumpEdges(n => n + 1);

    prevActiveRef.current = curActive;
    prevDoneRef.current = curDone;
  }, [activeAgents, doneAgents]);

  const [, setTick] = useState(0);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const now = Date.now();
      setSignals(prev => {
        const next = prev.filter(s => now - s.startedAt < SIGNAL_DURATION_MS && now - s.startedAt > -500);
        return next.length === prev.length ? prev : next;
      });
      setTick(n => (n + 1) % 1000000);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  if (agents.length === 0) return null;

  // Layout — Canva-style: roomy canvas, big colored cards
  const W = 1240;
  const H = 720;
  const hasBoard = bbTasks.length > 0;
  // Board panel (top-right). Agents shift left when the board is visible so cards don't overlap.
  const boardW = 290;
  const boardX = W - boardW - 16;
  const boardY = 16;
  const boardCardH = 110;
  const boardCardGap = 8;
  const boardHeaderH = 28;
  const boardH = boardHeaderH + BB_MAX_CARDS * (boardCardH + boardCardGap) + 6;
  const visibleBB = bbTasks.slice(0, BB_MAX_CARDS);
  const agentCenterX = hasBoard ? (W - boardW - 28) / 2 + 14 : W / 2;
  const orchPos = { x: agentCenterX, y: 110 };
  const workerY = 340;
  const slots = workers.length;
  const sidePad = 100;
  const workerSpace = hasBoard ? W - boardW - 28 - sidePad : W - 2 * sidePad;
  const workerSpread = Math.min(Math.max(workerSpace, 0), Math.max(slots * 170, 0));
  const workerStep = slots <= 1 ? 0 : workerSpread / (slots - 1);
  const workerStartX = slots <= 1 ? agentCenterX : agentCenterX - workerSpread / 2;
  const workerPos: Record<string, { x: number; y: number }> = {};
  workers.forEach((w, i) => {
    workerPos[w] = { x: workerStartX + i * workerStep, y: workerY };
  });
  const busY = 600;
  const busLeftX = hasBoard ? 60 : 100;
  const busRightX = hasBoard ? W - boardW - 40 : W - 100;

  const bbCardCenter = (idx: number) => ({
    x: boardX + boardW / 2,
    y: boardY + boardHeaderH + idx * (boardCardH + boardCardGap) + boardCardH / 2,
  });

  const posOf = (name: string): { x: number; y: number } | null => {
    if (name === "BUS") return { x: agentCenterX, y: busY };
    if (name.startsWith("BB:")) {
      const id = name.slice(3);
      const idx = visibleBB.findIndex(t => t.id === id);
      if (idx === -1) return null;
      return bbCardCenter(idx);
    }
    if (name === orchestrator) return orchPos;
    return workerPos[name] || null;
  };

  const stats = useMemo(() => {
    let total = 0, delegate = 0, bus = 0, direct = 0, spawn = 0;
    for (const a of agents) {
      for (const t of (agentTools[a] || [])) {
        total++;
        const k = TOOL_TO_KIND[t];
        if (k === "delegate") delegate++;
        else if (k === "bus") bus++;
        else if (k === "direct") direct++;
        else if (k === "spawn") spawn++;
      }
    }
    return { total, delegate, bus, direct, spawn };
  }, [agentTools, agents]);

  const stateOf = (name: string): "active" | "waiting" | "done" => {
    if ((doneAgents || []).includes(name)) return "done";
    if ((activeAgents || []).includes(name)) return "active";
    return "waiting";
  };

  const doingOf = (name: string): string => {
    const tools = agentTools[name] || [];
    if (tools.length === 0) return "Idle";
    if ((doneAgents || []).includes(name)) return "Done";
    return formatDoing(tools[tools.length - 1]);
  };

  // Agents that have won (been awarded) a bidding task
  const wonAgents = useMemo(() => {
    const s = new Set<string>();
    for (const t of bbTasks) {
      if (t.status === "awarded" && t.awardedTo) s.add(t.awardedTo);
    }
    return s;
  }, [bbTasks]);

  const now = Date.now();

  // Live signals indexed by edge for state derivation
  const liveByEdge = new Map<string, Signal[]>();
  for (const s of signals) {
    if (s.to === "BUS") continue;
    if (s.from.startsWith("BB:") || s.to.startsWith("BB:")) continue;
    const k = edgeKey(s.from, s.to);
    const arr = liveByEdge.get(k) || [];
    arr.push(s);
    liveByEdge.set(k, arr);
  }

  // Index pending delegations by symmetric edge key.
  // Two sources, merged:
  //   1. Socket-event tracked pendingRef (precise, but server throttles status events
  //      so individual send_task / wait_result calls can be lost in bursts).
  //   2. Derived from activeAgents: any worker that is currently active and not done
  //      implies the orchestrator is parked on wait_result for it. Realtime workers
  //      can only become active via the orchestrator dispatching to them, so this is
  //      a sound lower bound that works even when socket events are coalesced.
  const pendingByEdge = new Map<string, { caller: string; callee: string; kind: LinkKind; since: number }>();
  for (const p of pendingRef.current.values()) {
    pendingByEdge.set(edgeKey(p.caller, p.callee), p);
  }
  if (orchestrator) {
    const doneSet = new Set(doneAgents || []);
    for (const w of activeAgents || []) {
      if (w === orchestrator || doneSet.has(w)) continue;
      const k = edgeKey(orchestrator, w);
      if (!pendingByEdge.has(k)) {
        pendingByEdge.set(k, { caller: orchestrator, callee: w, kind: "delegate", since: now });
      }
    }
  }

  // Persistent edges = pairs that have actually exchanged traffic + pairs with an open delegation.
  // Kind is set from the first tool observed on that pair, so research swarms
  // using only TCP/bus will never get a delegate edge drawn.
  type EdgeSpec = { a: string; b: string; key: string; kind: LinkKind };
  const edgeSpecs: EdgeSpec[] = [];
  const edgeSpecKeys = new Set<string>();
  for (const [k, kind] of seenEdgesRef.current.entries()) {
    const [a, b] = k.split("\u0001");
    if (!agents.includes(a) || !agents.includes(b)) continue;
    edgeSpecs.push({ a, b, key: k, kind });
    edgeSpecKeys.add(k);
  }
  // Add pending-only edges that haven't yet been registered as "seen"
  for (const [k, p] of pendingByEdge.entries()) {
    if (edgeSpecKeys.has(k)) continue;
    if (!agents.includes(p.caller) || !agents.includes(p.callee)) continue;
    edgeSpecs.push({ a: p.caller, b: p.callee, key: k, kind: p.kind });
    edgeSpecKeys.add(k);
  }

  // Compute viewBox from zoom + pan so the SVG can pan/zoom interactively.
  const vbW = W / zoom;
  const vbH = H / zoom;
  const vbX = pan.x;
  const vbY = pan.y;
  const viewBox = `${vbX} ${vbY} ${vbW} ${vbH}`;

  const onWheel = (e: React.WheelEvent<SVGSVGElement>) => {
    e.preventDefault();
    const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * vbW + vbX;
    const my = ((e.clientY - rect.top) / rect.height) * vbH + vbY;
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const next = Math.min(4, Math.max(0.4, zoom * factor));
    const newVbW = W / next;
    const newVbH = H / next;
    const newX = mx - ((e.clientX - rect.left) / rect.width) * newVbW;
    const newY = my - ((e.clientY - rect.top) / rect.height) * newVbH;
    setZoom(next);
    setPan({ x: newX, y: newY });
  };
  const onMouseDown = (e: React.MouseEvent<SVGSVGElement>) => {
    if (e.button !== 0 && e.button !== 1) return;
    panDragRef.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
  };
  const onMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const d = panDragRef.current;
    if (!d) return;
    const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    const dx = ((e.clientX - d.x) / rect.width) * vbW;
    const dy = ((e.clientY - d.y) / rect.height) * vbH;
    setPan({ x: d.px - dx, y: d.py - dy });
  };
  const endDrag = () => { panDragRef.current = null; };
  const resetView = () => { setZoom(1); setPan({ x: 0, y: 0 }); };

  const wrapperStyle: React.CSSProperties = fullscreen
    ? {
        position: "fixed", inset: 0, zIndex: 9999,
        background: COLORS.bg, padding: 16, overflow: "auto",
        color: COLORS.text,
      }
    : {
        background: COLORS.bg,
        borderRadius: 8,
        border: `1px solid ${COLORS.border}`,
        overflow: "hidden",
        marginTop: 8,
        padding: 12,
        color: COLORS.text,
      };

  return (
    <div style={wrapperStyle}>
      {/* Scoreboard */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8, fontSize: 11 }}>
        <Stat label="Status" value={status} accent={COLORS.working} />
        <Stat label="Agents" value={String(agents.length)} accent={COLORS.text} />
        <Stat label="Active" value={String(activeAgents.length)} accent={COLORS.working} />
        <Stat label="Waiting" value={String(workers.filter(w => stateOf(w) === "waiting").length + (orchestrator && stateOf(orchestrator) === "waiting" ? 1 : 0))} accent={COLORS.waiting} />
        <Stat label="Done" value={String(doneAgents.length)} accent={COLORS.done} />
        <Stat label="Tool calls" value={String(stats.total)} accent={COLORS.text} />
        <Stat label="Delegate" value={String(stats.delegate)} accent={COLORS.delegate} />
        <Stat label="Bus" value={String(stats.bus)} accent={COLORS.bus} />
        <Stat label="Direct" value={String(stats.direct)} accent={COLORS.direct} />
        <Stat label="Spawn" value={String(stats.spawn)} accent={COLORS.spawn} />
        <Stat label="In flight" value={String(signals.length)} accent="#dc2626" />
        <Stat label="Board" value={String(bbTasks.length)} accent="#f59e0b" />
      </div>

      {/* View toolbar — zoom / reset / fullscreen */}
      <div style={{ display: "flex", gap: 6, marginBottom: 8, alignItems: "center", fontSize: 11 }}>
        <ToolbarBtn onClick={() => setZoom(z => Math.min(4, z * 1.2))}>+ Zoom in</ToolbarBtn>
        <ToolbarBtn onClick={() => setZoom(z => Math.max(0.4, z / 1.2))}>− Zoom out</ToolbarBtn>
        <ToolbarBtn onClick={resetView}>↺ Reset</ToolbarBtn>
        <ToolbarBtn onClick={() => setFullscreen(f => !f)}>
          {fullscreen ? "✕ Close fullscreen" : "⛶ Fullscreen"}
        </ToolbarBtn>
        <span style={{ color: COLORS.textDim, marginLeft: 8 }}>
          {Math.round(zoom * 100)}% · scroll to zoom · drag to pan
        </span>
      </div>

      <div style={{
        width: "100%",
        maxHeight: fullscreen ? "calc(100vh - 110px)" : 740,
        overflow: zoom > 1 ? "auto" : "hidden",
        borderRadius: 12,
        border: `1px solid ${COLORS.border}`,
      }}>
      <svg viewBox={viewBox}
        preserveAspectRatio="xMidYMid meet"
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={endDrag}
        onMouseLeave={endDrag}
        style={{
          width: "100%",
          height: fullscreen ? "calc(100vh - 130px)" : "auto",
          maxHeight: fullscreen ? undefined : 720,
          display: "block",
          borderRadius: 12,
          cursor: panDragRef.current ? "grabbing" : "grab",
          userSelect: "none",
        }}>
        <defs>
          <marker id="arrow-out" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0,0 L10,5 L0,10 z" fill={COLORS.delegate} />
          </marker>
          <marker id="arrow-in" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0,0 L10,5 L0,10 z" fill={COLORS.done} />
          </marker>
          <marker id="arrow-idle" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto">
            <path d="M0,0 L10,5 L0,10 z" fill={COLORS.idleEdge} />
          </marker>
          <filter id="card-shadow" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur in="SourceAlpha" stdDeviation="3" />
            <feOffset dx="0" dy="3" result="off" />
            <feComponentTransfer><feFuncA type="linear" slope="0.22" /></feComponentTransfer>
            <feMerge><feMergeNode /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <linearGradient id="canvas-bg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#fdf2f8" />
            <stop offset="50%" stopColor="#eff6ff" />
            <stop offset="100%" stopColor="#ecfeff" />
          </linearGradient>
        </defs>

        {/* Canvas background */}
        <rect x={0} y={0} width={W} height={H} fill="url(#canvas-bg)" />
        {/* Soft dotted backdrop */}
        {Array.from({ length: 12 }).map((_, r) => (
          Array.from({ length: 18 }).map((__, c) => (
            <circle key={`d-${r}-${c}`} cx={30 + c * 52} cy={30 + r * 48} r={1.2}
              fill="#94a3b8" opacity={0.18} />
          ))
        ))}

        {/* Blackboard panel — P2P contract-net job board */}
        {hasBoard && (
          <g>
            <rect x={boardX} y={boardY} width={boardW} height={boardH} rx={12}
              fill="#fffbeb" stroke="#fbbf24" strokeWidth={1.6} filter="url(#card-shadow)" />
            <text x={boardX + 12} y={boardY + 17} fontSize={10} fill="#92400e"
              fontFamily="system-ui, sans-serif" fontWeight={800} letterSpacing={1.2}>BLACKBOARD</text>
            <text x={boardX + boardW - 12} y={boardY + 17} textAnchor="end" fontSize={9}
              fill="#b45309" fontFamily="monospace">{bbTasks.length} job{bbTasks.length === 1 ? "" : "s"}</text>
            {visibleBB.map((t, i) => {
              const cy = boardY + boardHeaderH + i * (boardCardH + boardCardGap);
              const statusColor = t.status === "open" ? "#f59e0b"
                : t.status === "awarded" ? "#2563eb" : "#059669";
              const fillColor = t.status === "open" ? "#fef3c7"
                : t.status === "awarded" ? "#dbeafe" : "#d1fae5";
              const fresh = (now - t.updatedAt) < 1500;
              const pulse = fresh ? 1 + 0.04 * Math.sin((now - t.updatedAt) / 80) : 1;
              // Wrap description into up to three short lines (~38 chars each).
              const rawDesc = (t.desc || "").trim();
              const wrapAt = 40;
              const wrapLines = (s: string, max: number, lines: number): string[] => {
                const out: string[] = [];
                let rest = s;
                for (let i = 0; i < lines; i++) {
                  if (!rest) break;
                  if (rest.length <= max) { out.push(rest); rest = ""; break; }
                  let cut = rest.lastIndexOf(" ", max);
                  if (cut < max * 0.4) cut = max;
                  out.push(rest.slice(0, cut));
                  rest = rest.slice(cut).trimStart();
                }
                if (rest) {
                  const last = out[out.length - 1] || "";
                  out[out.length - 1] = last.slice(0, max - 1) + "…";
                }
                return out;
              };
              const descLines = wrapLines(rawDesc, wrapAt, 3);
              const topBidder = t.bids.length > 0
                ? [...t.bids].sort((a, b) => b.conf - a.conf)[0]
                : null;
              return (
                <g key={t.id} transform={`translate(${boardX + 8}, ${cy}) scale(${pulse})`}>
                  <rect x={0} y={0} width={boardW - 16} height={boardCardH} rx={7}
                    fill={fillColor} stroke={statusColor} strokeWidth={fresh ? 2 : 1.4} />
                  <text x={8} y={13} fontSize={9} fill={COLORS.textDim} fontFamily="monospace">
                    {t.id.slice(0, 14)}
                  </text>
                  <text x={boardW - 24} y={13} textAnchor="end" fontSize={8}
                    fill={statusColor} fontFamily="monospace" fontWeight="bold">
                    {t.status.toUpperCase()}
                  </text>
                  {(descLines.length > 0 ? descLines : ["(no description)"]).map((ln, li) => (
                    <text key={li} x={10} y={32 + li * 13} fontSize={11} fill={COLORS.text}
                      fontFamily="system-ui, sans-serif" fontWeight={li === 0 ? 600 : 500}>
                      {ln}
                    </text>
                  ))}
                  <text x={10} y={76} fontSize={10} fill={COLORS.textDim} fontFamily="monospace">
                    by {t.proposer.slice(0, 14)} · {t.bids.length} bid{t.bids.length === 1 ? "" : "s"}
                  </text>
                  {t.awardedTo ? (
                    <g>
                      <rect x={8} y={86} width={boardW - 32} height={18} rx={4}
                        fill={statusColor} opacity={0.95} />
                      <text x={14} y={99} fontSize={11} fill="#ffffff"
                        fontFamily="monospace" fontWeight="bold">
                        ★ WON BY {t.awardedTo.slice(0, 18)}
                      </text>
                    </g>
                  ) : topBidder ? (
                    <text x={10} y={99} fontSize={10} fill="#92400e" fontFamily="monospace">
                      top: {topBidder.bidder.slice(0, 14)} ({topBidder.conf.toFixed(2)})
                    </text>
                  ) : (
                    <text x={10} y={99} fontSize={10} fill={COLORS.textFaint} fontFamily="monospace">
                      awaiting bids…
                    </text>
                  )}
                </g>
              );
            })}
            {bbTasks.length > BB_MAX_CARDS && (
              <text x={boardX + boardW / 2} y={boardY + boardH - 4} textAnchor="middle"
                fontSize={9} fill={COLORS.textDim} fontFamily="monospace">
                +{bbTasks.length - BB_MAX_CARDS} more
              </text>
            )}
          </g>
        )}

        {/* Persistent edges */}
        {edgeSpecs.map(spec => {
          const pa = posOf(spec.a);
          const pb = posOf(spec.b);
          if (!pa || !pb) return null;
          const live = liveByEdge.get(spec.key) || [];
          const liveOut = live.find(s => s.direction === "outbound");
          const liveRet = live.find(s => s.direction === "return");
          const pending = pendingByEdge.get(spec.key);
          const sa = stateOf(spec.a);
          const sb = stateOf(spec.b);
          const wState: "active" | "waiting" | "done" =
            sa === "active" || sb === "active" ? "active"
            : sa === "waiting" || sb === "waiting" ? "waiting"
            : "done";

          let edgeState: "idle" | "working" | "waiting" | "done" | "outbound" | "return" | "awaiting";
          if (liveOut) edgeState = "outbound";
          else if (liveRet) edgeState = "return";
          else if (pending) edgeState = "awaiting";
          else if (wState === "active") edgeState = "working";
          else if (wState === "waiting") edgeState = "waiting";
          else edgeState = "done";

          // For an "awaiting" edge, orient it caller → callee so the arrow reads correctly
          let edgeFrom = pa, edgeTo = pb;
          if (pending) {
            const cp = posOf(pending.caller);
            const ep = posOf(pending.callee);
            if (cp && ep) { edgeFrom = cp; edgeTo = ep; }
          }

          return (
            <EdgeLine key={spec.key}
              from={edgeFrom} to={edgeTo}
              kind={spec.kind}
              state={edgeState}
              now={now}
            />
          );
        })}

        {/* Bus pipe */}
        <g>
          <rect x={busLeftX} y={busY - 14} width={busRightX - busLeftX} height={28} rx={14}
            fill="#ecfeff" stroke={COLORS.bus} strokeWidth={1.5} />
          <text x={busLeftX - 10} y={busY + 5} textAnchor="end" fontSize={12} fill={COLORS.bus} fontFamily="monospace" fontWeight="bold">BUS</text>
          {[orchestrator!, ...workers].filter(Boolean).map(a => {
            const p = posOf(a);
            if (!p) return null;
            return (
              <line key={`drop-${a}`}
                x1={p.x} y1={p.y + 56}
                x2={p.x} y2={busY - 14}
                stroke={COLORS.bus} strokeOpacity={0.22} strokeWidth={1.2} strokeDasharray="2 4" />
            );
          })}
          {/* Bus inner pulse marks */}
          {Array.from({ length: 10 }).map((_, i) => {
            const phase = ((now / 40 + i * 36) % 360) / 360;
            const x = busLeftX + 14 + phase * (busRightX - busLeftX - 28);
            return <circle key={i} cx={x} cy={busY} r={1.8} fill={COLORS.bus} opacity={0.55} />;
          })}
        </g>

        {/* Animated signals (particles) */}
        {signals.map(sig => {
          const dt = now - sig.startedAt;
          if (dt < 0 || dt >= SIGNAL_DURATION_MS) return null;
          // Particle moves at original speed (SIGNAL_LOOP_MS per traversal) and
          // re-loops along the edge until SIGNAL_DURATION_MS elapses, so the user
          // sees several passes per delegation event.
          const t = (dt % SIGNAL_LOOP_MS) / SIGNAL_LOOP_MS;
          const lifeT = dt / SIGNAL_DURATION_MS;
          // Gentle fade-in over first 15%, fade-out over last 15%; full brightness in between.
          const fade = lifeT < 0.15 ? lifeT / 0.15 : lifeT > 0.85 ? (1 - lifeT) / 0.15 : 1;
          const fp = posOf(sig.from);
          if (!fp) return null;
          const col = KIND_COLOR[sig.kind];

          if (sig.kind === "bus") {
            const isRead = sig.from === "BUS";
            if (isRead) {
              // BUS → agent: ring contracts at bus, then particle rises to the agent card
              const ap = posOf(sig.to);
              if (!ap) return null;
              if (t < 0.45) {
                const s = t / 0.45;
                return (
                  <g key={sig.id} opacity={fade * 0.95}>
                    <circle cx={ap.x} cy={busY} r={6 + (1 - s) * 60} fill="none" stroke={col} strokeWidth={2} />
                    <circle cx={ap.x} cy={busY} r={6 + (1 - s) * 42} fill="none" stroke={col} strokeWidth={1.2} opacity={0.6} />
                    <circle cx={ap.x} cy={busY} r={3} fill={col} />
                  </g>
                );
              }
              const s = (t - 0.45) / 0.55;
              const x = ap.x;
              const y = busY + (ap.y + 56 - busY) * s;
              return (
                <g key={sig.id} opacity={fade}>
                  <BusGlyph x={x} y={y} color={col} />
                  <text x={x + 10} y={y - 5} fontSize={10} fill={col} fontFamily="monospace" fontWeight="bold">{sig.tool} ↩</text>
                </g>
              );
            }
            // Publish: agent → bus → ring expansion
            if (t < 0.45) {
              const s = t / 0.45;
              const x = fp.x;
              const y = fp.y + 56 + (busY - fp.y - 56) * s;
              return (
                <g key={sig.id} opacity={fade}>
                  <BusGlyph x={x} y={y} color={col} />
                  <text x={x + 10} y={y - 5} fontSize={10} fill={col} fontFamily="monospace" fontWeight="bold">{sig.tool}</text>
                </g>
              );
            }
            const s = (t - 0.45) / 0.55;
            return (
              <g key={sig.id} opacity={(1 - s) * 0.95}>
                <circle cx={fp.x} cy={busY} r={6 + s * 70} fill="none" stroke={col} strokeWidth={2} />
                <circle cx={fp.x} cy={busY} r={6 + s * 50} fill="none" stroke={col} strokeWidth={1.2} opacity={0.6} />
                <circle cx={fp.x} cy={busY} r={3} fill={col} />
              </g>
            );
          }

          const tp = posOf(sig.to);
          if (!tp) return null;
          const x = fp.x + (tp.x - fp.x) * t;
          const y = fp.y + (tp.y - fp.y) * t;
          return (
            <g key={sig.id}>
              <SignalGlyph kind={sig.kind} direction={sig.direction} x={x} y={y} color={col} fade={fade} />
              <text x={x + 10} y={y - 8} fontSize={10} fill={col} fontFamily="monospace" fontWeight="bold" opacity={fade}>
                {sig.tool}{sig.direction === "return" ? " ↩" : ""}
              </text>
            </g>
          );
        })}

        {/* Orchestrator */}
        {orchestrator && (
          <AgentNode name={orchestrator} x={orchPos.x} y={orchPos.y}
            color={COLORS.orchestrator} state={stateOf(orchestrator)}
            doing={doingOf(orchestrator)} role="ORCHESTRATOR"
            won={wonAgents.has(orchestrator)} />
        )}

        {/* Workers */}
        {workers.map(w => (
          <AgentNode key={w} name={w} x={workerPos[w].x} y={workerPos[w].y}
            color={colorFor(w)} state={stateOf(w)}
            doing={doingOf(w)} role="AGENT"
            won={wonAgents.has(w)} />
        ))}

        {/* Legend — link types */}
        <g transform={`translate(${16}, ${H - 104})`}>
          <rect x={0} y={0} width={184} height={92} rx={12}
            fill="#ffffff" stroke={COLORS.border} strokeWidth={1.5}
            filter="url(#card-shadow)" />
          <text x={12} y={18} fontSize={10} fill={COLORS.textDim}
            fontFamily="system-ui, sans-serif" fontWeight={800} letterSpacing={1}>LINK TYPES</text>
          {(["delegate", "direct", "bus", "spawn"] as LinkKind[]).map((k, i) => (
            <g key={k} transform={`translate(12, ${28 + i * 14})`}>
              <LegendStroke kind={k} />
              <text x={62} y={9} fontSize={10} fill={COLORS.text}
                fontFamily="system-ui, sans-serif" fontWeight={600}>{k}</text>
              <SignalGlyph kind={k} direction="outbound" x={120} y={6} color={KIND_COLOR[k]} fade={1} />
            </g>
          ))}
        </g>

        {/* State legend */}
        <g transform={`translate(${W - 212}, ${H - 116})`}>
          <rect x={0} y={0} width={196} height={104} rx={12}
            fill="#ffffff" stroke={COLORS.border} strokeWidth={1.5}
            filter="url(#card-shadow)" />
          <text x={12} y={18} fontSize={10} fill={COLORS.textDim}
            fontFamily="system-ui, sans-serif" fontWeight={800} letterSpacing={1}>EDGE STATE</text>
          {[
            { label: "idle", color: COLORS.idleEdge },
            { label: "working", color: COLORS.working },
            { label: "awaiting result", color: COLORS.waiting },
            { label: "outbound →", color: COLORS.delegate },
            { label: "return ←", color: COLORS.done },
          ].map((s, i) => (
            <g key={s.label} transform={`translate(12, ${28 + i * 14})`}>
              <line x1={0} y1={6} x2={36} y2={6} stroke={s.color} strokeWidth={3} strokeLinecap="round" />
              <text x={44} y={10} fontSize={10} fill={COLORS.text}
                fontFamily="system-ui, sans-serif" fontWeight={600}>{s.label}</text>
            </g>
          ))}
        </g>
      </svg>
      </div>
    </div>
  );
}

function ToolbarBtn({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "4px 10px",
        borderRadius: 6,
        background: COLORS.panel,
        border: `1px solid ${COLORS.border}`,
        color: COLORS.text,
        fontSize: 11,
        cursor: "pointer",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      {children}
    </button>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div style={{
      padding: "4px 9px",
      borderRadius: 6,
      background: COLORS.panel,
      border: `1px solid ${accent ? accent + "66" : COLORS.border}`,
      display: "flex",
      gap: 6,
      alignItems: "center",
    }}>
      <span style={{ color: COLORS.textDim }}>{label}</span>
      <strong style={{ color: accent || COLORS.text }}>{value}</strong>
    </div>
  );
}

// Edge line drawn between two agents. Per-kind stroke signature, per-state color & animation.
function EdgeLine({ from, to, kind, state, now }: {
  from: { x: number; y: number };
  to: { x: number; y: number };
  kind: LinkKind;
  state: "idle" | "working" | "waiting" | "done" | "outbound" | "return" | "awaiting";
  now: number;
}) {
  // Trim endpoints so the line stops at the rounded card edge.
  const dx = to.x - from.x, dy = to.y - from.y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const ux = dx / len, uy = dy / len;
  // Half-extents of an AgentNode card (with a small margin).
  const HW = 76, HH = 34;
  const rectPad = (vx: number, vy: number) => {
    const ax = Math.abs(vx), ay = Math.abs(vy);
    const tx = ax > 0 ? HW / ax : Infinity;
    const ty = ay > 0 ? HH / ay : Infinity;
    const t = Math.min(tx, ty);
    return Math.sqrt((vx * t) ** 2 + (vy * t) ** 2);
  };
  const padFrom = rectPad(ux, uy);
  const padTo = rectPad(ux, uy);
  const x1 = from.x + ux * padFrom, y1 = from.y + uy * padFrom;
  const x2 = to.x - ux * padTo, y2 = to.y - uy * padTo;

  let color = COLORS.idleEdge;
  let width = 1.2;
  let dash: string | undefined = "4 5";
  let arrow: string | undefined;
  let animate = false;
  let awaitingPulse = false;

  if (state === "outbound") { color = KIND_COLOR[kind]; width = 2.6; arrow = "url(#arrow-out)"; animate = true; }
  else if (state === "return") { color = COLORS.done; width = 2.6; arrow = "url(#arrow-in)"; animate = true; }
  else if (state === "awaiting") { color = COLORS.waiting; width = 2.4; dash = "6 4"; arrow = "url(#arrow-out)"; animate = true; awaitingPulse = true; }
  else if (state === "working") { color = COLORS.working; width = 2; dash = undefined; }
  else if (state === "waiting") { color = COLORS.waiting; width = 1.5; dash = "2 6"; }
  else if (state === "done") { color = COLORS.doneEdge; width = 1.5; dash = "1 3"; }
  else { arrow = "url(#arrow-idle)"; }

  // Per-kind signature: delegate = single dashed; direct = double parallel solid;
  // bus and spawn handled too (bus is rendered through pipe but pair edges keep style)
  if (kind === "direct") {
    // Render two parallel offset lines
    const ox = -uy * 3, oy = ux * 3;
    return (
      <g>
        <line x1={x1 + ox} y1={y1 + oy} x2={x2 + ox} y2={y2 + oy}
          stroke={color} strokeWidth={width} strokeLinecap="round" />
        <line x1={x1 - ox} y1={y1 - oy} x2={x2 - ox} y2={y2 - oy}
          stroke={color} strokeWidth={width} strokeLinecap="round"
          markerEnd={arrow} />
        {animate && (
          <line x1={x1} y1={y1} x2={x2} y2={y2}
            stroke={color} strokeWidth={1} strokeDasharray="6 8"
            strokeDashoffset={(-now / 30) % 14} opacity={0.7} />
        )}
      </g>
    );
  }

  if (kind === "spawn") {
    // Dotted thick stroke + sparkle nodes along the line
    return (
      <g>
        <line x1={x1} y1={y1} x2={x2} y2={y2}
          stroke={color} strokeWidth={width + 0.5}
          strokeDasharray="1 5" strokeLinecap="round"
          markerEnd={arrow} />
        {animate && Array.from({ length: 4 }).map((_, i) => {
          const phase = ((now / 18 + i * 90) % 360) / 360;
          const px = x1 + (x2 - x1) * phase;
          const py = y1 + (y2 - y1) * phase;
          return <circle key={i} cx={px} cy={py} r={2.5} fill={color} opacity={0.9} />;
        })}
      </g>
    );
  }

  // Default: delegate / bus pair-line
  return (
    <g>
      {awaitingPulse && (
        // Soft glow underneath so the awaiting state is visible at a glance
        <line x1={x1} y1={y1} x2={x2} y2={y2}
          stroke={color} strokeWidth={width + 5}
          strokeOpacity={0.18} strokeLinecap="round" />
      )}
      <line x1={x1} y1={y1} x2={x2} y2={y2}
        stroke={color} strokeWidth={width}
        strokeDasharray={dash}
        strokeDashoffset={animate && dash ? (-now / 22) % 10 : undefined}
        strokeLinecap="round"
        markerEnd={arrow} />
      {state === "awaiting" && (
        <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 6} textAnchor="middle"
          fontSize={9} fill={color} fontFamily="monospace" fontWeight="bold">awaiting</text>
      )}
    </g>
  );
}

// Distinct visual marker per communication kind, traveling along an edge.
function SignalGlyph({ kind, direction, x, y, color, fade }: {
  kind: LinkKind;
  direction: Direction;
  x: number;
  y: number;
  color: string;
  fade: number;
}) {
  if (kind === "delegate") {
    // Round token
    return (
      <g opacity={fade}>
        <circle cx={x} cy={y} r={6} fill={color} />
        <circle cx={x} cy={y} r={6} fill="none" stroke="#fff" strokeWidth={1.5} />
        {direction === "return" && <text x={x} y={y + 3} textAnchor="middle" fontSize={9} fill="#fff" fontWeight="bold">↩</text>}
      </g>
    );
  }
  if (kind === "direct") {
    // Square pulse
    return (
      <g opacity={fade}>
        <rect x={x - 5} y={y - 5} width={10} height={10} fill={color} stroke="#fff" strokeWidth={1.5} />
      </g>
    );
  }
  if (kind === "spawn") {
    // 4-point star
    return (
      <g opacity={fade} transform={`translate(${x}, ${y}) rotate(${(Date.now() / 5) % 360})`}>
        <path d="M0,-7 L2,-2 L7,0 L2,2 L0,7 L-2,2 L-7,0 L-2,-2 Z" fill={color} stroke="#fff" strokeWidth={1.2} />
      </g>
    );
  }
  // bus glyph (also used in legend)
  return <BusGlyph x={x} y={y} color={color} />;
}

function BusGlyph({ x, y, color }: { x: number; y: number; color: string }) {
  return (
    <g>
      <polygon points={`${x},${y - 6} ${x + 6},${y} ${x},${y + 6} ${x - 6},${y}`}
        fill={color} stroke="#fff" strokeWidth={1.5} />
    </g>
  );
}

function LegendStroke({ kind }: { kind: LinkKind }) {
  const c = KIND_COLOR[kind];
  if (kind === "direct") {
    return (
      <g>
        <line x1={0} y1={3} x2={50} y2={3} stroke={c} strokeWidth={2} />
        <line x1={0} y1={9} x2={50} y2={9} stroke={c} strokeWidth={2} />
      </g>
    );
  }
  if (kind === "spawn") {
    return <line x1={0} y1={6} x2={50} y2={6} stroke={c} strokeWidth={2.5} strokeDasharray="1 5" />;
  }
  if (kind === "bus") {
    return <line x1={0} y1={6} x2={50} y2={6} stroke={c} strokeWidth={4} strokeLinecap="round" />;
  }
  return <line x1={0} y1={6} x2={50} y2={6} stroke={c} strokeWidth={2.5} strokeDasharray="5 4" />;
}

// Lighten a hex color toward white by amount (0..1) for a soft top-stripe gradient.
function lighten(hex: string, amt: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const m = (c: number) => Math.round(c + (255 - c) * amt);
  const toHex = (c: number) => c.toString(16).padStart(2, "0");
  return `#${toHex(m(r))}${toHex(m(g))}${toHex(m(b))}`;
}

function AgentNode({ name, x, y, color, state, doing, role, won }: {
  name: string;
  x: number;
  y: number;
  color: string;
  state: "active" | "waiting" | "done";
  doing: string;
  role: string;
  won?: boolean;
}) {
  const CW = 144, CH = 60;
  const stateColor = state === "done" ? COLORS.done : state === "waiting" ? COLORS.waiting : COLORS.working;
  const stateLabel = state === "done" ? "DONE" : state === "waiting" ? "WAITING" : "ACTIVE";
  const icon = state === "done" ? "\u2713" : state === "waiting" ? "\u29D6" : "\u25B6";
  const trunc = (s: string, n: number) => s.length > n ? s.slice(0, n - 1) + "\u2026" : s;
  const cardColor = won ? "#d97706" : color;
  const top = lighten(cardColor, 0.18);
  const gradId = `card-grad-${name.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

  return (
    <g>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={top} />
          <stop offset="100%" stopColor={color} />
        </linearGradient>
      </defs>

      {/* Active glow ring */}
      {state === "active" && (
        <rect x={x - CW / 2 - 7} y={y - CH / 2 - 7} width={CW + 14} height={CH + 14} rx={18}
          fill="none" stroke={stateColor} strokeWidth={3} opacity={0.55}>
          <animate attributeName="opacity" values="0.7;0.18;0.7" dur="1.8s" repeatCount="indefinite" />
          <animate attributeName="stroke-width" values="2;5;2" dur="1.8s" repeatCount="indefinite" />
        </rect>
      )}
      {state === "waiting" && (
        <rect x={x - CW / 2 - 5} y={y - CH / 2 - 5} width={CW + 10} height={CH + 10} rx={16}
          fill="none" stroke={stateColor} strokeWidth={2}
          strokeDasharray="5 5" opacity={0.6} />
      )}
      {won && (
        <g>
          <rect x={x - CW / 2 - 9} y={y - CH / 2 - 9} width={CW + 18} height={CH + 18} rx={20}
            fill="none" stroke="#f59e0b" strokeWidth={3} opacity={0.8}>
            <animate attributeName="opacity" values="0.9;0.35;0.9" dur="2s" repeatCount="indefinite" />
          </rect>
          <rect x={x - CW / 2 - 5} y={y - CH / 2 - 5} width={CW + 10} height={CH + 10} rx={17}
            fill="none" stroke="#fbbf24" strokeWidth={1.5} opacity={0.5} />
          <text x={x + CW / 2 + 4} y={y - CH / 2 - 2} fontSize={14} fill="#f59e0b"
            fontFamily="system-ui, sans-serif" fontWeight="bold">&#9733;</text>
        </g>
      )}

      {/* Soft drop shadow */}
      <rect x={x - CW / 2 + 2} y={y - CH / 2 + 5} width={CW} height={CH} rx={14}
        fill="#0f172a" opacity={0.18} />

      {/* Main filled card */}
      <rect x={x - CW / 2} y={y - CH / 2} width={CW} height={CH} rx={14}
        fill={`url(#${gradId})`} stroke="#ffffff" strokeWidth={3} />
      {/* Inner subtle border for that printed-sticker look */}
      <rect x={x - CW / 2 + 3} y={y - CH / 2 + 3} width={CW - 6} height={CH - 6} rx={11}
        fill="none" stroke="#ffffff" strokeOpacity={0.35} strokeWidth={1} />

      {/* Status dot inside the card */}
      <g>
        <circle cx={x - CW / 2 + 14} cy={y - CH / 2 + 14} r={5} fill="#ffffff" />
        <circle cx={x - CW / 2 + 14} cy={y - CH / 2 + 14} r={3.2} fill={stateColor}>
          {state === "active" && (
            <animate attributeName="opacity" values="1;0.35;1" dur="1.2s" repeatCount="indefinite" />
          )}
        </circle>
      </g>
      {/* State icon top-right */}
      <text x={x + CW / 2 - 12} y={y - CH / 2 + 18} textAnchor="end"
        fontSize={13} fill="#ffffff" fontWeight="bold">{icon}</text>

      {/* Agent name — the main attraction */}
      <text x={x} y={y + 4} textAnchor="middle" fontSize={14}
        fill="#ffffff" fontFamily="system-ui, -apple-system, sans-serif"
        fontWeight={800} letterSpacing={0.3}
        style={{ paintOrder: "stroke", stroke: "rgba(0,0,0,0.18)", strokeWidth: 0.6 }}>
        {trunc(name, 16)}
      </text>
      {/* Role caption inside the card, under the name */}
      <text x={x} y={y + 19} textAnchor="middle" fontSize={8}
        fill="#ffffff" fillOpacity={0.85}
        fontFamily="system-ui, sans-serif" fontWeight={700} letterSpacing={1.2}>
        {role}
      </text>

      {/* State chip below the card */}
      <g transform={`translate(${x}, ${y + CH / 2 + 6})`}>
        <rect x={-34} y={0} width={68} height={17} rx={8.5}
          fill="#ffffff" stroke={stateColor} strokeWidth={1.5} />
        <circle cx={-22} cy={8.5} r={3} fill={stateColor} />
        <text x={4} y={12} textAnchor="middle" fontSize={9}
          fill={stateColor} fontFamily="system-ui, sans-serif" fontWeight={800} letterSpacing={0.6}>
          {stateLabel}
        </text>
      </g>

      {/* Doing speech bubble */}
      <g transform={`translate(${x}, ${y + CH / 2 + 30})`}>
        <rect x={-72} y={0} width={144} height={20} rx={10}
          fill={won ? "#fffbeb" : "#fffbea"} stroke={cardColor} strokeWidth={1.5} />
        <text x={0} y={13} textAnchor="middle" fontSize={10}
          fill="#475569" fontFamily="system-ui, sans-serif" fontWeight={600}>
          {trunc(doing, 24)}
        </text>
      </g>
    </g>
  );
}
