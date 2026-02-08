"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { SocketProvider } from "@/lib/socket-context";

export const Providers = ({ children }: { children: React.ReactNode }) => {
  const [client] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={client}>
      <SocketProvider>{children}</SocketProvider>
    </QueryClientProvider>
  );
};
