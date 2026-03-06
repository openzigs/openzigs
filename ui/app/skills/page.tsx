"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchJson } from "@/lib/api";
import {
  Film, Music, Radio, PenTool, BookOpen, Shield,
  ChevronDown, ChevronRight, ExternalLink, Sparkles,
} from "lucide-react";

type SkillMetadata = {
  name: string;
  displayName: string;
  description: string;
  icon: string;
  tools: string[];
  rulesCount: number;
  loaded: boolean;
  examples: string[];
  skillMdPath: string;
  content?: string;
};

const SKILL_LUCIDE_ICONS: Record<string, typeof Film> = {
  "media-director": Film,
  "remix-engineer": Music,
  "platform-manager": Radio,
  "content-creator": PenTool,
  "knowledge-curator": BookOpen,
  "system-operator": Shield,
};

function SkillCard({
  skill,
  expanded,
  onToggle,
  onTryIt,
}: {
  skill: SkillMetadata;
  expanded: boolean;
  onToggle: () => void;
  onTryIt: (prompt: string) => void;
}) {
  const Icon = SKILL_LUCIDE_ICONS[skill.name] ?? Sparkles;

  return (
    <div className="rounded-2xl border border-border bg-card shadow-sm transition-shadow hover:shadow-md">
      <button
        type="button"
        className="flex w-full items-start gap-4 p-6 text-left"
        onClick={onToggle}
      >
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Icon className="h-6 w-6" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-semibold text-card-foreground">{skill.displayName}</h3>
            {skill.loaded && (
              <span className="rounded-full bg-green-500/10 px-2 py-0.5 text-[11px] font-medium text-green-600 dark:text-green-400">
                Loaded
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-muted-foreground line-clamp-2">{skill.description}</p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {skill.tools.slice(0, 4).map((tool) => (
              <span
                key={tool}
                className="rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[11px] text-muted-foreground"
              >
                {tool}
              </span>
            ))}
            {skill.tools.length > 4 && (
              <span className="rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[11px] text-muted-foreground">
                +{skill.tools.length - 4} more
              </span>
            )}
          </div>
        </div>
        <div className="shrink-0 pt-1 text-muted-foreground">
          {expanded ? <ChevronDown className="h-5 w-5" /> : <ChevronRight className="h-5 w-5" />}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-border px-6 pb-6 pt-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Tools ({skill.tools.length})
              </h4>
              <ul className="mt-2 space-y-1">
                {skill.tools.map((tool) => (
                  <li key={tool} className="text-sm text-foreground">
                    <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{tool}</code>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Stats
              </h4>
              <dl className="mt-2 space-y-1 text-sm">
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Behavioral Rules</dt>
                  <dd className="font-medium">{skill.rulesCount}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Status</dt>
                  <dd className="font-medium text-green-600 dark:text-green-400">Active</dd>
                </div>
              </dl>
            </div>
          </div>

          {skill.examples.length > 0 && (
            <div className="mt-4">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Try It
              </h4>
              <div className="mt-2 flex flex-wrap gap-2">
                {skill.examples.map((example) => (
                  <button
                    key={example}
                    type="button"
                    className="flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-muted"
                    onClick={() => onTryIt(example)}
                  >
                    <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="line-clamp-1">{example}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function SkillsPage() {
  const [skills, setSkills] = useState<SkillMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedSkill, setExpandedSkill] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    fetchJson<{ skills: SkillMetadata[] }>("/api/admin/skills")
      .then((data) => {
        setSkills(data.skills ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const handleTryIt = (prompt: string) => {
    const encoded = encodeURIComponent(prompt);
    router.push(`/chat?prompt=${encoded}`);
  };

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-foreground">Skills</h1>
        <p className="mt-2 text-muted-foreground">
          Skills are specialized AI personas loaded into your agent sessions. Each skill brings
          domain expertise, tool knowledge, and behavioral rules that guide the AI.
        </p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      ) : skills.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border p-10 text-center">
          <Sparkles className="mx-auto h-10 w-10 text-muted-foreground/40" />
          <p className="mt-4 text-muted-foreground">
            No skills configured. Add SKILL.md files to <code>src/skills/</code> directories and
            configure <code>skillDirectories</code> in your CopilotWrapper options.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {skills.map((skill) => (
            <SkillCard
              key={skill.name}
              skill={skill}
              expanded={expandedSkill === skill.name}
              onToggle={() =>
                setExpandedSkill((prev) => (prev === skill.name ? null : skill.name))
              }
              onTryIt={handleTryIt}
            />
          ))}
        </div>
      )}

      <div className="mt-8 rounded-xl border border-border bg-muted/30 p-5">
        <h3 className="text-sm font-semibold text-foreground">How Skills Work</h3>
        <p className="mt-2 text-sm text-muted-foreground">
          Skills are <code>SKILL.md</code> markdown files loaded via the Copilot SDK&apos;s{" "}
          <code>skillDirectories</code> configuration. They are injected into every session&apos;s
          context, giving the AI domain-specific rules, tool routing instructions, and behavioral
          constraints. Type <code>!</code> in the chat to browse skills, or just describe what you need.
        </p>
      </div>
    </div>
  );
}
