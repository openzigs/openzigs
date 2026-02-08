"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { io, type Socket } from "socket.io-client";
import { showToast } from "@/components/toast";

const SOCKET_URL = process.env.NEXT_PUBLIC_OPENZIGS_SOCKET_URL ?? process.env.NEXT_PUBLIC_OPENZIGS_API_BASE ?? "http://localhost:3000";

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
    const socket = io(SOCKET_URL || undefined, {
      transports: ["websocket", "polling"],
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
