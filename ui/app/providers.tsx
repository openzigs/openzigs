"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { SocketProvider } from "@/lib/socket-context";
import { ActivityProvider } from "@/lib/activity-context";
import { ProduceNotifier } from "@/components/produce-notifier";
import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";

export const Providers = ({ children }: { children: React.ReactNode }) => {
  const [client] = useState(() => new QueryClient());
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <QueryClientProvider client={client}>
        <SocketProvider>
          <ActivityProvider>
            <TooltipProvider>
              {children}
              <ProduceNotifier />
            </TooltipProvider>
          </ActivityProvider>
        </SocketProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
};
