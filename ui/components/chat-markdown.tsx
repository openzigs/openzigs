"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { MermaidDiagram } from "./mermaid-diagram";
import type { ComponentPropsWithoutRef, ReactElement } from "react";
import { isValidElement } from "react";

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
 * mermaid diagrams (client-side via mermaid lib), and proper typography styles.
 */
export const ChatMarkdown = ({ content, isStreaming }: ChatMarkdownProps) => {
  return (
    <div className="prose prose-sm dark:prose-invert max-w-none prose-p:my-1.5 prose-headings:my-2 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5 prose-pre:my-2 prose-code:before:content-none prose-code:after:content-none">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
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

/** Check whether the children of a `<pre>` is a MermaidDiagram element. */
function isMermaidChild(children: unknown): boolean {
  if (!isValidElement(children)) return false;
  return (children as ReactElement).type === MermaidDiagram;
}
