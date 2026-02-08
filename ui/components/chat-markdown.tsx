"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import type { ComponentPropsWithoutRef } from "react";

// The react-syntax-highlighter types export the style as a union that doesn't
// match the component's prop type. This is a well-known issue — cast once here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const codeStyle = oneDark as any;

type ChatMarkdownProps = {
  content: string;
  /** True while the assistant is still streaming this message */
  isStreaming?: boolean;
};

/**
 * Renders assistant markdown content with syntax highlighting, GFM tables,
 * mermaid diagrams (as mermaid.ink images), and proper typography styles.
 */
export const ChatMarkdown = ({ content, isStreaming }: ChatMarkdownProps) => {
  return (
    <div className="prose prose-sm dark:prose-invert max-w-none prose-p:my-1.5 prose-headings:my-2 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5 prose-pre:my-2 prose-code:before:content-none prose-code:after:content-none">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Code blocks with syntax highlighting + mermaid support
          code({ className, children, ...rest }: ComponentPropsWithoutRef<"code"> & { inline?: boolean }) {
            const match = /language-(\w+)/.exec(className || "");
            const lang = match?.[1];
            const text = String(children).replace(/\n$/, "");

            // Mermaid: render as an ink image link
            if (lang === "mermaid") {
              const encoded = btoa(text);
              const url = `https://mermaid.ink/img/${encoded}`;
              return (
                <a href={url} target="_blank" rel="noopener noreferrer" className="block my-2">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={url}
                    alt="Mermaid diagram"
                    className="max-w-full rounded-lg border border-border"
                    loading="lazy"
                  />
                </a>
              );
            }

            // Multi-line code block
            if (lang || text.includes("\n")) {
              return (
                <SyntaxHighlighter
                  style={codeStyle}
                  language={lang || "text"}
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

          // Links open in new tab
          a({ children, href, ...rest }) {
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
        }}
      >
        {content}
      </ReactMarkdown>
      {isStreaming && (
        <span className="ml-0.5 inline-block h-[1em] w-0.5 animate-pulse bg-primary align-text-bottom" />
      )}
    </div>
  );
};
