"use client";

import { FieldLabel, TextInput, type PropertyEditorProps } from "./shared";

interface Event {
  when: string;
  what: string;
}

interface TimelineSlide {
  template: "timeline";
  content: {
    heading: string;
    events: Event[];
  };
  speaker_notes?: string;
  source_anchor?: string;
}

const MAX_EVENTS = 8;
const MIN_EVENTS = 2;

const TimelineEditor = ({
  slide,
  onChange,
}: PropertyEditorProps<TimelineSlide>) => {
  const c = slide.content;
  const setEvents = (next: Event[]) =>
    onChange({ ...slide, content: { ...c, events: next } });

  const update = (i: number, patch: Partial<Event>) =>
    setEvents(c.events.map((e, idx) => (idx === i ? { ...e, ...patch } : e)));
  const addEvent = () =>
    c.events.length < MAX_EVENTS &&
    setEvents([...c.events, { when: "", what: "" }]);
  const removeEvent = (i: number) =>
    c.events.length > MIN_EVENTS &&
    setEvents(c.events.filter((_, idx) => idx !== i));
  const move = (from: number, to: number) => {
    if (to < 0 || to >= c.events.length) return;
    const next = c.events.slice();
    const [pulled] = next.splice(from, 1);
    next.splice(to, 0, pulled);
    setEvents(next);
  };

  return (
    <div data-testid="prop-editor-timeline">
      <FieldLabel label="Heading">
        <TextInput
          testId="prop-tl-heading"
          value={c.heading}
          maxLength={120}
          onChange={(v) => onChange({ ...slide, content: { ...c, heading: v } })}
        />
      </FieldLabel>
      <FieldLabel
        label={`Events (${c.events.length}, ${MIN_EVENTS}–${MAX_EVENTS})`}
      >
        <ul className="space-y-2" data-testid="prop-tl-events">
          {c.events.map((e, i) => (
            <li
              key={i}
              data-testid={`prop-tl-row-${i}`}
              className="rounded border border-border p-2"
            >
              <TextInput
                testId={`prop-tl-when-${i}`}
                value={e.when}
                maxLength={40}
                placeholder="When (e.g. Q3 2026)"
                onChange={(v) => update(i, { when: v })}
              />
              <div className="mt-1">
                <TextInput
                  testId={`prop-tl-what-${i}`}
                  value={e.what}
                  maxLength={160}
                  placeholder="What"
                  onChange={(v) => update(i, { what: v })}
                />
              </div>
              <div className="mt-1 flex gap-1">
                <button
                  type="button"
                  aria-label="Move up"
                  data-testid={`prop-tl-up-${i}`}
                  disabled={i === 0}
                  onClick={() => move(i, i - 1)}
                  className="rounded border border-border px-1 text-[10px] disabled:opacity-30"
                >
                  ▲
                </button>
                <button
                  type="button"
                  aria-label="Move down"
                  data-testid={`prop-tl-down-${i}`}
                  disabled={i === c.events.length - 1}
                  onClick={() => move(i, i + 1)}
                  className="rounded border border-border px-1 text-[10px] disabled:opacity-30"
                >
                  ▼
                </button>
                <button
                  type="button"
                  aria-label="Remove event"
                  data-testid={`prop-tl-remove-${i}`}
                  disabled={c.events.length <= MIN_EVENTS}
                  onClick={() => removeEvent(i)}
                  className="rounded border border-border px-1 text-[10px] disabled:opacity-30"
                >
                  ×
                </button>
              </div>
            </li>
          ))}
        </ul>
        <button
          type="button"
          data-testid="prop-tl-add"
          disabled={c.events.length >= MAX_EVENTS}
          onClick={addEvent}
          className="mt-1 rounded border border-border px-2 py-1 text-[10px] disabled:opacity-50"
        >
          + Add event
        </button>
      </FieldLabel>
    </div>
  );
};

export default TimelineEditor;
