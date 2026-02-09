import { Suspense } from "react";
import { ChatView } from "@/components/chat-view";

export const metadata = { title: "OpenZigs Chat" };

export default function ChatPage() {
  return (
    <Suspense>
      <ChatView />
    </Suspense>
  );
}
