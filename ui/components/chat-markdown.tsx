"use client";

import { memo, useMemo, isValidElement, Children } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { MermaidDiagram } from "./mermaid-diagram";
import { ChatImageBlock } from "./chat-image-block";
import { ChatAudioBlock } from "./chat-audio-block";
import { ChatVideoBlock } from "./chat-video-block";
import type { ComponentPropsWithoutRef, ReactElement, ReactNode } from "react";

// The react-syntax-highlighter types export the style as a union that doesn't
// match the component's prop type. This is a well-known issue — cast once here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const codeStyle = oneDark as any;

const AUDIO_EXTS = /\.(mp3|wav|ogg|flac|m4a|aac|webm)$/i;
const VIDEO_EXTS = /\.(mp4|webm|mov|avi|mkv)$/i;

/**
 * Convert raw HTML <audio> / <video> tags to the emoji-prefixed markdown link
 * format that ChatAudioBlock / ChatVideoBlock expect. react-markdown has no
 * rehype-raw plugin so those tags would otherwise render as escaped plain text.
 */
function normalizeHtmlMediaTags(text: string): string {
  // <audio src="URL" ...>...</audio>  or  <audio ...src="URL"...>...</audio>
  text = text.replace(
    /<audio[^>]*?\bsrc=["']([^"']+)["'][^>]*>[\s\S]*?<\/audio>/gi,
    (_, url: string) => {
      const filename = decodeURIComponent(url.split("/").pop()?.split("?")[0] ?? "audio");
      return `[🎵 ${filename}](${url})`;
    },
  );
  // <video src="URL" ...>...</video>
  text = text.replace(
    /<video[^>]*?\bsrc=["']([^"']+)["'][^>]*>[\s\S]*?<\/video>/gi,
    (_, url: string) => {
      const filename = decodeURIComponent(url.split("/").pop()?.split("?")[0] ?? "video");
      return `[🎬 ${filename}](${url})`;
    },
  );
  return text;
}

function isMediaUrl(href: string): "audio" | "video" | null {
  if (!href) return null;
  const isAssetUrl = href.includes("/api/queue/assets/") || href.includes("/api/admin/knowledge/");
  if (AUDIO_EXTS.test(href) || (isAssetUrl && href.includes("audio"))) return "audio";
  if (VIDEO_EXTS.test(href) || (isAssetUrl && href.includes("video"))) return "video";
  return null;
}

function extractLinkText(children: ReactNode): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map(extractLinkText).join("");
  if (isValidElement(children) && children.props?.children) {
    return extractLinkText(children.props.children as ReactNode);
  }
  return "";
}

type ChatMarkdownProps = {
  content: string;
  /** True while the assistant is still streaming this message */
  isStreaming?: boolean;
  /** When provided, ordered lists render as clickable choice buttons. */
  onChoiceSelect?: (choice: string) => void;
};

/**
 * Renders assistant markdown content with syntax highlighting, GFM tables,
 * mermaid diagrams (client-side via mermaid lib), and proper typography styles.
 */
export const ChatMarkdown = memo(function ChatMarkdown({ content, isStreaming, onChoiceSelect }: ChatMarkdownProps) {
  // Memoize components object so ReactMarkdown sees a stable reference.
  // Without this, every parent re-render (e.g. user typing) creates a new
  // components object → ReactMarkdown remounts children → ChatImageBlock loses
  // its `loaded` state → images flash on every keystroke.
  const components = useMemo((): Components => ({
          // Override <pre> to unwrap mermaid blocks (which don't need <pre>)
          pre({ children, ...rest }) {
            // If the sole child is our mermaid component, render it without the <pre> wrapper
            if (isMermaidChild(children)) {
              return <>{children}</>;
            }
            return <pre {...rest}>{children}</pre>;
          },

          // Code blocks with syntax highlighting + mermaid support
          code({ className, children, ...rest }: ComponentPropsWithoutRef<"code"> & { inline?: boolean }) {
            const match = /language-(\w+)/.exec(className || "");
            const lang = match?.[1];
            const text = String(children).replace(/\n$/, "");

            // Mermaid: only render the diagram after streaming is complete
            // to avoid spamming mermaid.render() with incomplete syntax.
            if (lang === "mermaid" && !isStreaming) {
              return <MermaidDiagram chart={text} />;
            }

            // Multi-line code block (also used for mermaid while streaming)
            if (lang || text.includes("\n")) {
              return (
                <SyntaxHighlighter
                  style={codeStyle}
                  language={lang === "mermaid" ? "text" : (lang || "text")}
                  PreTag="div"
                  customStyle={{
                    margin: 0,
                    borderRadius: "0.5rem",
                    fontSize: "0.8rem",
                  }}
                  {...rest}
                >
                  {text}
                </SyntaxHighlighter>
              );
            }

            // Inline code
            return (
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs" {...rest}>
                {children}
              </code>
            );
          },

          // Links: detect media URLs and render inline players
          a({ children, href, ...rest }) {
            if (href) {
              const mediaType = isMediaUrl(href);
              const linkText = extractLinkText(children);

              // Audio links → inline player
              if (mediaType === "audio" || linkText.startsWith("🎵")) {
                const title = linkText.replace(/^🎵\s*/, "").trim() || undefined;
                return <ChatAudioBlock src={href} title={title} />;
              }

              // Video links → inline player
              if (mediaType === "video" || linkText.startsWith("🎬")) {
                const title = linkText.replace(/^🎬\s*/, "").trim() || undefined;
                return <ChatVideoBlock src={href} title={title} />;
              }
            }

            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline underline-offset-2 hover:opacity-80"
                {...rest}
              >
                {children}
              </a>
            );
          },

          // Tables with dark-mode styling
          table({ children, ...rest }) {
            return (
              <div className="overflow-x-auto my-2">
                <table className="min-w-full text-xs" {...rest}>
                  {children}
                </table>
              </div>
            );
          },

          // Images with lightbox, download, and proper sizing
          img({ src, alt }) {
            return <ChatImageBlock src={src} alt={alt} />;
          },

          // Ordered lists: render as interactive choice pills when onChoiceSelect is provided
          ol({ children, start, ...rest }) {
            if (!onChoiceSelect || isStreaming) {
              return <ol start={start} {...rest}>{children}</ol>;
            }

            // Collect list items and extract their plain text
            const choices: string[] = [];
            Children.forEach(children as ReactNode, (child) => {
              if (isValidElement(child)) {
                const text = extractLinkText(
                  (child as ReactElement<{ children?: ReactNode }>).props.children
                ).trim();
                if (text) choices.push(text);
              }
            });

            // Only render as interactive choices if 2–8 reasonably short items
            if (choices.length < 2 || choices.length > 8 || choices.some((c) => c.length > 200)) {
              return <ol start={start} {...rest}>{children}</ol>;
            }

            const startIdx = typeof start === "number" ? start : 1;

            return (
              <div className="space-y-1.5 my-2 not-prose">
                {choices.map((text, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => onChoiceSelect(text)}
                    className="flex w-full items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-2 text-sm transition-all hover:border-primary/50 hover:bg-primary/5 text-left cursor-pointer group"
                  >
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-muted-foreground/40 text-xs text-muted-foreground group-hover:border-primary group-hover:text-primary transition-colors">
                      {startIdx + idx}
                    </span>
                    <span className="group-hover:text-primary transition-colors">{text}</span>
                  </button>
                ))}
              </div>
            );
          },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        }), [isStreaming, onChoiceSelect]);

  const normalizedContent = useMemo(() => normalizeHtmlMediaTags(content), [content]);

  return (
    <div className="prose prose-sm dark:prose-invert max-w-none prose-p:my-1.5 prose-headings:my-2 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5 prose-pre:my-2 prose-code:before:content-none prose-code:after:content-none">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={components}
      >
        {normalizedContent}
      </ReactMarkdown>
      {isStreaming && (
        <span className="ml-0.5 inline-block h-[1em] w-0.5 animate-pulse bg-primary align-text-bottom" />
      )}
    </div>
  );
});

/** Check whether the children of a `<pre>` is a MermaidDiagram element. */
function isMermaidChild(children: unknown): boolean {
  if (!isValidElement(children)) return false;
  return (children as ReactElement).type === MermaidDiagram;
}
