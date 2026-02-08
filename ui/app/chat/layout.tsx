/**
 * Chat-specific layout — constrains the viewport so the input
 * stays pinned at the bottom while only the messages area scrolls.
 *
 * The parent wrapper in the root layout uses `overflow-y-auto`,
 * which works for scrollable pages (admin, library). For the chat
 * page we need `overflow-hidden` so the ChatView's internal flex
 * layout controls scrolling instead.
 */
export default function ChatLayout({ children }: { children: React.ReactNode }) {
  return <div className="h-full overflow-hidden">{children}</div>;
}
