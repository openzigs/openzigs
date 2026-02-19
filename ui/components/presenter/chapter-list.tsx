"use client";

interface Chapter {
  title: string;
  startSeconds: number;
  endSeconds: number;
}

function formatTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

export function ChapterList({
  chapters,
  currentChapter,
  onSeek,
}: {
  chapters: Chapter[];
  currentChapter: number;
  onSeek: (index: number) => void;
}) {
  if (chapters.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card p-4">
        <p className="text-xs text-muted-foreground">No chapters detected.</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card">
      <h3 className="border-b border-border px-4 py-3 text-sm font-semibold text-foreground">
        Chapters
      </h3>
      <ul className="divide-y divide-border">
        {chapters.map((ch, i) => {
          const isActive = i === currentChapter;
          return (
            <li key={i}>
              <button
                onClick={() => onSeek(i)}
                className={`flex w-full items-center gap-3 px-4 py-2.5 text-left transition hover:bg-muted/50 ${
                  isActive ? "bg-primary/5" : ""
                }`}
              >
                <span
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                    isActive
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p
                    className={`truncate text-xs font-medium ${
                      isActive ? "text-primary" : "text-foreground"
                    }`}
                  >
                    {ch.title}
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    {formatTime(ch.startSeconds)}
                  </p>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
