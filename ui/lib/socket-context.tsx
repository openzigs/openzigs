"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { io, type Socket } from "socket.io-client";
import { showToast } from "@/components/toast";

const RAW_SOCKET_URL = process.env.NEXT_PUBLIC_OPENZIGS_SOCKET_URL ?? process.env.NEXT_PUBLIC_OPENZIGS_API_BASE ?? "";
const AUTH_TOKEN = process.env.NEXT_PUBLIC_OPENZIGS_TOKEN ?? "";

/**
 * Resolve Socket.IO server URL at runtime.
 * When configured URL's origin differs from the browser origin (different
 * host or port, e.g. Cloudflare tunnel or dev server on a non-default port),
 * return empty string so socket.io-client connects to same-origin and
 * Next.js rewrites proxy to the backend.
 */
function resolveSocketUrl(): string {
  if (!RAW_SOCKET_URL) return "";
  if (typeof window === "undefined") return RAW_SOCKET_URL;
  try {
    const base = new URL(RAW_SOCKET_URL);
    if (base.origin !== window.location.origin) {
      return "";
    }
  } catch { /* malformed URL, use as-is */ }
  return RAW_SOCKET_URL;
}
const CLIENT_ID_KEY = "openzigs:client-id";

/** Get or generate a stable client identity that persists across page navigations. */
const getStableClientId = (): string => {
  if (typeof window === "undefined") return "ssr";
  try {
    let clientId = localStorage.getItem(CLIENT_ID_KEY);
    if (!clientId) {
      clientId = crypto.randomUUID();
      localStorage.setItem(CLIENT_ID_KEY, clientId);
    }
    return clientId;
  } catch {
    return crypto.randomUUID();
  }
};

type SocketContextValue = {
  socket: Socket | null;
  connected: boolean;
};

const SocketContext = createContext<SocketContextValue>({ socket: null, connected: false });

export const useSocket = () => useContext(SocketContext);

export const SocketProvider = ({ children }: { children: ReactNode }) => {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const hadDisconnectRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const clientId = getStableClientId();
    const socketUrl = resolveSocketUrl();
    const socket = io(socketUrl || undefined, {
      query: { clientId },
      auth: { token: AUTH_TOKEN },
      transports: ["polling", "websocket"],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 3000,
      timeout: 20_000,
    });
    socketRef.current = socket;

    const onConnect = () => {
      setConnected(true);
      if (reconnectTimerRef.current) {
        clearInterval(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (hadDisconnectRef.current) {
        showToast("Reconnected to server.", "success");
        hadDisconnectRef.current = false;
      }
    };
    const onDisconnect = (reason: Socket.DisconnectReason) => {
      setConnected(false);
      if (!hadDisconnectRef.current) {
        showToast("Connection lost. Reconnecting…", "info");
        hadDisconnectRef.current = true;
      }
      if (!reconnectTimerRef.current) {
        reconnectTimerRef.current = setInterval(() => {
          if (!socket.connected) {
            socket.connect();
          }
        }, 2000);
      }
      if (reason === "io server disconnect") {
        socket.connect();
      }
    };
    const onConnectError = () => setConnected(false);

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("connect_error", onConnectError);

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("connect_error", onConnectError);
      if (reconnectTimerRef.current) {
        clearInterval(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      socket.disconnect();
      socketRef.current = null;
    };
  }, []);

  return (
    <SocketContext.Provider value={{ socket: socketRef.current, connected }}>
      {children}
    </SocketContext.Provider>
  );
};
