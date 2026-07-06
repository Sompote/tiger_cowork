import { useEffect, useRef, useState, useCallback } from "react";
import { io, Socket } from "socket.io-client";
import { getAccessToken } from "../utils/api";

// One shared connection for the whole app, refcounted by hook consumers.
// The previous implementation opened a fresh websocket per useSocket() call
// (Chat + Projects + Tasks + one per expanded diagram), multiplying auth
// handshakes and broadcast traffic.
let sharedSocket: Socket | null = null;
let refCount = 0;

function acquireSocket(): Socket {
  if (!sharedSocket) {
    const token = getAccessToken();
    sharedSocket = io(window.location.origin, {
      transports: ["websocket", "polling"],
      auth: { token },
    });
  }
  refCount++;
  return sharedSocket;
}

function releaseSocket() {
  refCount--;
  if (refCount <= 0) {
    refCount = 0;
    sharedSocket?.disconnect();
    sharedSocket = null;
  }
}

export function useSocket() {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const socket = acquireSocket();
    socketRef.current = socket;
    setConnected(socket.connected);
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socketRef.current = null;
      releaseSocket();
    };
  }, []);

  const sendMessage = useCallback((sessionId: string, message: string, images?: { path: string; type: string }[]) => {
    socketRef.current?.emit("chat:send", { sessionId, message, images });
  }, []);

  const sendProjectMessage = useCallback((projectId: string, sessionId: string, message: string, images?: { path: string; type: string }[]) => {
    socketRef.current?.emit("project:chat:send", { projectId, sessionId, message, images });
  }, []);

  const onChunk = useCallback((cb: (data: { sessionId: string; content: string }) => void) => {
    const socket = socketRef.current;
    socket?.on("chat:chunk", cb);
    return () => { socket?.off("chat:chunk", cb); };
  }, []);

  const onResponse = useCallback((cb: (data: { sessionId: string; content: string; done: boolean; files?: string[] }) => void) => {
    const socket = socketRef.current;
    socket?.on("chat:response", cb);
    return () => { socket?.off("chat:response", cb); };
  }, []);

  const onStatus = useCallback((cb: (data: { status: string }) => void) => {
    const socket = socketRef.current;
    socket?.on("chat:status", cb);
    return () => { socket?.off("chat:status", cb); };
  }, []);

  return { connected, sendMessage, sendProjectMessage, onChunk, onResponse, onStatus, socket: socketRef };
}
