"use client";

/**
 * Team Grid editor (#1049 AC6).
 *
 * Repeating editor for 2..12 team members. Photo URL + bio are optional.
 * Social links are deferred to a later iteration — the schema permits up
 * to 4 per member but a productive editor for them needs more UI than
 * this v1 inline panel warrants. They are preserved unchanged on edit.
 */

import { FieldLabel, TextArea, TextInput, type PropertyEditorProps } from "./shared";

interface TeamLink {
  label: string;
  href: string;
}
interface TeamMember {
  name: string;
  role: string;
  bio?: string;
  photoUrl?: string;
  links?: TeamLink[];
}

interface TeamGridSlide {
  template: "team_grid";
  content: {
    heading?: string;
    members: TeamMember[];
  };
  speaker_notes?: string;
  source_anchor?: string;
}

const blankMember = (): TeamMember => ({ name: "Name", role: "Role" });

const TeamGridEditor = ({
  slide,
  onChange,
}: PropertyEditorProps<TeamGridSlide>) => {
  const c = slide.content;
  const update = (patch: Partial<TeamGridSlide["content"]>) =>
    onChange({ ...slide, content: { ...c, ...patch } });

  const updateMember = (idx: number, patch: Partial<TeamMember>) => {
    const next = c.members.map((m, i) => (i === idx ? { ...m, ...patch } : m));
    update({ members: next });
  };

  const addMember = () => {
    if (c.members.length >= 12) return;
    update({ members: [...c.members, blankMember()] });
  };

  const removeMember = (idx: number) => {
    if (c.members.length <= 2) return;
    update({ members: c.members.filter((_, i) => i !== idx) });
  };

  return (
    <div data-testid="prop-editor-team-grid">
      <FieldLabel label="Heading (optional)" htmlFor="prop-tg-heading">
        <TextInput
          id="prop-tg-heading"
          testId="prop-tg-heading"
          value={c.heading ?? ""}
          maxLength={120}
          onChange={(v) => update({ heading: v || undefined })}
        />
      </FieldLabel>

      <div className="mb-1 flex items-center justify-between text-[11px] font-semibold text-muted-foreground">
        <span>Members ({c.members.length}/12)</span>
        <button
          type="button"
          data-testid="prop-tg-add-member"
          disabled={c.members.length >= 12}
          onClick={addMember}
          className="rounded border border-border px-2 py-0.5 text-[11px] hover:bg-muted/40 disabled:opacity-50"
        >
          + Add member
        </button>
      </div>

      <div className="space-y-3">
        {c.members.map((m, idx) => (
          <fieldset
            key={idx}
            data-testid={`prop-tg-member-${idx}`}
            className="space-y-2 rounded border border-border p-2"
          >
            <legend className="px-1 text-[10px] uppercase tracking-wide text-muted-foreground">
              Member {idx + 1}
            </legend>
            <div className="grid grid-cols-2 gap-2">
              <FieldLabel label="Name">
                <TextInput
                  testId={`prop-tg-member-${idx}-name`}
                  value={m.name}
                  maxLength={60}
                  onChange={(v) => updateMember(idx, { name: v })}
                />
              </FieldLabel>
              <FieldLabel label="Role">
                <TextInput
                  testId={`prop-tg-member-${idx}-role`}
                  value={m.role}
                  maxLength={80}
                  onChange={(v) => updateMember(idx, { role: v })}
                />
              </FieldLabel>
            </div>
            <FieldLabel label="Photo URL (optional)">
              <TextInput
                testId={`prop-tg-member-${idx}-photo`}
                value={m.photoUrl ?? ""}
                maxLength={500}
                onChange={(v) => updateMember(idx, { photoUrl: v || undefined })}
              />
            </FieldLabel>
            <FieldLabel label="Bio (optional)">
              <TextArea
                testId={`prop-tg-member-${idx}-bio`}
                value={m.bio ?? ""}
                maxLength={280}
                rows={2}
                onChange={(v) => updateMember(idx, { bio: v || undefined })}
              />
            </FieldLabel>
            <button
              type="button"
              data-testid={`prop-tg-member-${idx}-remove`}
              disabled={c.members.length <= 2}
              onClick={() => removeMember(idx)}
              className="rounded border border-border px-2 py-0.5 text-[11px] hover:bg-muted/40 disabled:opacity-50"
            >
              Remove
            </button>
          </fieldset>
        ))}
      </div>
    </div>
  );
};

export default TeamGridEditor;
