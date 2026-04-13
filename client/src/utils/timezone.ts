// Global UI preference: "local" = browser local time, "server" = UTC (server canonical).
// Stored in localStorage under "app.tzMode" and synced across components via a custom event.

import { useEffect, useState } from "react";

export type TzMode = "local" | "server";

const KEY = "app.tzMode";
const EVENT = "app:tzmode-change";

export function getTzMode(): TzMode {
  try {
    const v = localStorage.getItem(KEY);
    return v === "server" ? "server" : "local";
  } catch {
    return "local";
  }
}

export function setTzMode(mode: TzMode): void {
  try {
    localStorage.setItem(KEY, mode);
  } catch {}
  try {
    window.dispatchEvent(new CustomEvent(EVENT, { detail: mode }));
  } catch {}
}

export function useTzMode(): TzMode {
  const [mode, setMode] = useState<TzMode>(getTzMode);
  useEffect(() => {
    const onChange = () => setMode(getTzMode());
    window.addEventListener(EVENT, onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener(EVENT, onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);
  return mode;
}

function pad(n: number): string { return n < 10 ? "0" + n : "" + n; }

// Format a Date according to the active mode. server = UTC, local = browser TZ.
export function formatDateTime(d: Date | string | number, mode: TzMode = getTzMode()): string {
  const dt = d instanceof Date ? d : new Date(d);
  if (mode === "server") {
    return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())} ${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}:${pad(dt.getUTCSeconds())} UTC`;
  }
  return dt.toLocaleString();
}

export function formatTime(d: Date | string | number, mode: TzMode = getTzMode()): string {
  const dt = d instanceof Date ? d : new Date(d);
  if (mode === "server") {
    return `${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}:${pad(dt.getUTCSeconds())} UTC`;
  }
  return dt.toLocaleTimeString();
}

// Rewrite "[YYYY-MM-DD HH:MM:SS]" prefixes in a chat-log blob.
// The raw value is always UTC (server writes via toISOString). For "local", we convert.
const TS_RE = /\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\]/g;
export function rewriteLogTimestamps(text: string, mode: TzMode = getTzMode()): string {
  if (mode === "server") return text;
  return text.replace(TS_RE, (_m, y, mo, d, h, mi, s) => {
    const dt = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
    return `[${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}]`;
  });
}
