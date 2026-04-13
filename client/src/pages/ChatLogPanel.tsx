import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../utils/api";
import { useTzMode, rewriteLogTimestamps } from "../utils/timezone";

interface ChatLogPanelProps {
  sessionId: string;
  maxHeight?: number;
  pollMs?: number;
}

export default function ChatLogPanel({ sessionId, maxHeight = 280, pollMs = 2000 }: ChatLogPanelProps) {
  const [log, setLog] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [autoScroll, setAutoScroll] = useState(true);
  const preRef = useRef<HTMLPreElement>(null);
  const tzMode = useTzMode();
  const displayLog = useMemo(() => rewriteLogTimestamps(log, tzMode), [log, tzMode]);

  useEffect(() => {
    let cancelled = false;
    const fetchLog = async () => {
      try {
        const res: any = await api.getChatLog(sessionId);
        if (cancelled) return;
        const content = typeof res === "string" ? res : (res?.log ?? res?.content ?? "");
        setLog(content || "");
        setError("");
      } catch (e: any) {
        if (!cancelled) setError(e?.message || "Failed to load log");
      }
    };
    fetchLog();
    const id = setInterval(fetchLog, pollMs);
    return () => { cancelled = true; clearInterval(id); };
  }, [sessionId, pollMs]);

  useEffect(() => {
    if (autoScroll && preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
    }
  }, [displayLog, autoScroll]);

  const onScroll = () => {
    const el = preRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 16;
    setAutoScroll(atBottom);
  };

  return (
    <div style={{
      marginTop: 8,
      border: "1px solid #e5e7eb",
      borderRadius: 8,
      background: "#ffffff",
      overflow: "hidden",
    }}>
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "6px 10px",
        background: "#f3f4f6",
        borderBottom: "1px solid #e5e7eb",
        fontSize: 11,
        color: "#374151",
        fontFamily: "system-ui, sans-serif",
      }}>
        <span>Chat log · <code style={{ color: "#111827" }}>{sessionId}</code></span>
        <span>{tzMode === "server" ? "server time (UTC)" : "local time"} · {autoScroll ? "live" : "paused"}</span>
      </div>
      {error ? (
        <div style={{ padding: 10, color: "#dc2626", fontSize: 11 }}>{error}</div>
      ) : (
        <pre
          ref={preRef}
          onScroll={onScroll}
          style={{
            margin: 0,
            padding: 10,
            maxHeight,
            overflow: "auto",
            fontSize: 11,
            lineHeight: 1.45,
            color: "#000000",
            background: "#ffffff",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {displayLog || "(empty log)"}
        </pre>
      )}
    </div>
  );
}
