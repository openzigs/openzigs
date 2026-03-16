import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Mock next/navigation
const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => new URLSearchParams(),
}));

// Mock socket-context
vi.mock("@/lib/socket-context", () => ({
  useSocket: () => ({ socket: null }),
}));

// Mock AskAi components
vi.mock("@/components/ask-ai/AskAiPanel", () => ({
  AskAiPanel: () => null,
  AskAiButton: ({ onClick }: { onClick: () => void }) => (
    <button onClick={onClick}>Ask AI</button>
  ),
}));

// Mock fetchJson
vi.mock("@/lib/api", () => ({
  fetchJson: vi.fn(),
}));

import SkillsPage from "./page";

const mockSkills = [
  {
    name: "media-director",
    displayName: "Media Director",
    description: "Orchestrates image generation and media queue",
    icon: "🎬",
    tools: ["submit-media-job", "web-search"],
    rulesCount: 5,
    loaded: true,
    examples: ["Generate a hero image for the blog"],
    skillMdPath: "src/skills/media-director/SKILL.md",
    allowedTools: ["submit-media-job", "web-search", "read-file", "list-directory", "browser-navigate"],
    content: "---\nname: media-director\n---",
  },
  {
    name: "my-custom-skill",
    displayName: "My Custom Skill",
    description: "A user-created skill",
    icon: "✨",
    tools: ["web-search"],
    rulesCount: 2,
    loaded: true,
    examples: [],
    skillMdPath: "/home/user/.openzigs/skills/my-custom-skill/SKILL.md",
    allowedTools: ["web-search"],
    content: "---\nname: my-custom-skill\n---",
  },
];

function createWrapper(queryData?: { skills: typeof mockSkills }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (queryData) {
    qc.setQueryData(["skills"], queryData);
  }

  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  Wrapper.displayName = "SkillsTestWrapper";
  return Wrapper;
}

describe("SkillsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the page heading", () => {
    render(<SkillsPage />, { wrapper: createWrapper({ skills: mockSkills }) });
    expect(screen.getByRole("heading", { name: "Skills", level: 1 })).toBeInTheDocument();
  });

  it("renders the subtitle", () => {
    render(<SkillsPage />, { wrapper: createWrapper({ skills: mockSkills }) });
    expect(screen.getByText("Manage built-in and custom SKILL.md skill files")).toBeInTheDocument();
  });

  it("renders the New Skill button", () => {
    render(<SkillsPage />, { wrapper: createWrapper({ skills: mockSkills }) });
    expect(screen.getByRole("button", { name: "New Skill" })).toBeInTheDocument();
  });

  it("renders skill cards with display names", () => {
    render(<SkillsPage />, { wrapper: createWrapper({ skills: mockSkills }) });
    expect(screen.getByText("Media Director")).toBeInTheDocument();
    expect(screen.getByText("My Custom Skill")).toBeInTheDocument();
  });

  it("shows Built-in badge for built-in skills", () => {
    render(<SkillsPage />, { wrapper: createWrapper({ skills: mockSkills }) });
    expect(screen.getByText("Built-in")).toBeInTheDocument();
  });

  it("shows Custom badge for user skills", () => {
    render(<SkillsPage />, { wrapper: createWrapper({ skills: mockSkills }) });
    expect(screen.getByText("Custom")).toBeInTheDocument();
  });

  it("shows Edit and Delete buttons only for custom skills", () => {
    render(<SkillsPage />, { wrapper: createWrapper({ skills: mockSkills }) });
    // Custom skill should have Edit and Delete
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("shows View buttons for all skills", () => {
    render(<SkillsPage />, { wrapper: createWrapper({ skills: mockSkills }) });
    const viewBtns = screen.getAllByRole("button", { name: "View" });
    expect(viewBtns).toHaveLength(2);
  });

  it("shows tool tags on skill cards", () => {
    render(<SkillsPage />, { wrapper: createWrapper({ skills: mockSkills }) });
    expect(screen.getByText("submit-media-job")).toBeInTheDocument();
    expect(screen.getAllByText("web-search")).toHaveLength(2);
  });

  it("shows overflow indicator when skill has more than 4 tools", () => {
    render(<SkillsPage />, { wrapper: createWrapper({ skills: mockSkills }) });
    expect(screen.getByText("+1 more")).toBeInTheDocument();
  });

  it("shows Try It button for skills with examples", () => {
    render(<SkillsPage />, { wrapper: createWrapper({ skills: mockSkills }) });
    expect(screen.getByRole("button", { name: "Try It" })).toBeInTheDocument();
  });

  it("navigates to chat with prompt when Try It is clicked", () => {
    render(<SkillsPage />, { wrapper: createWrapper({ skills: mockSkills }) });
    fireEvent.click(screen.getByRole("button", { name: "Try It" }));
    expect(mockPush).toHaveBeenCalledWith(
      `/chat?prompt=${encodeURIComponent("Generate a hero image for the blog")}`
    );
  });

  it("switches to create view when New Skill is clicked", async () => {
    render(<SkillsPage />, { wrapper: createWrapper({ skills: mockSkills }) });
    fireEvent.click(screen.getByRole("button", { name: "New Skill" }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Create Skill", level: 1 })).toBeInTheDocument();
    });
  });

  it("shows Cancel button in create view", async () => {
    render(<SkillsPage />, { wrapper: createWrapper({ skills: mockSkills }) });
    fireEvent.click(screen.getByRole("button", { name: "New Skill" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    });
  });

  it("returns to gallery when Cancel is clicked in create view", async () => {
    render(<SkillsPage />, { wrapper: createWrapper({ skills: mockSkills }) });
    fireEvent.click(screen.getByRole("button", { name: "New Skill" }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Create Skill", level: 1 })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Skills", level: 1 })).toBeInTheDocument();
    });
  });

  it("shows empty state when no skills", () => {
    render(<SkillsPage />, { wrapper: createWrapper({ skills: [] }) });
    expect(screen.getByText("No skills found. Create your first skill to get started.")).toBeInTheDocument();
  });

  it("shows How Skills Work section in gallery view", () => {
    render(<SkillsPage />, { wrapper: createWrapper({ skills: mockSkills }) });
    expect(screen.getByText("How Skills Work")).toBeInTheDocument();
  });

  it("does not render ← Admin link", () => {
    render(<SkillsPage />, { wrapper: createWrapper({ skills: mockSkills }) });
    expect(screen.queryByText("← Admin")).not.toBeInTheDocument();
  });

  /* ── Guided Skill Builder ── */

  it("shows Guided/Advanced toggle in create view", async () => {
    render(<SkillsPage />, { wrapper: createWrapper({ skills: mockSkills }) });
    fireEvent.click(screen.getByRole("button", { name: "New Skill" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Guided" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Advanced" })).toBeInTheDocument();
    });
  });

  it("defaults to guided mode with description textarea", async () => {
    render(<SkillsPage />, { wrapper: createWrapper({ skills: mockSkills }) });
    fireEvent.click(screen.getByRole("button", { name: "New Skill" }));
    await waitFor(() => {
      expect(screen.getByText("Describe Your Skill")).toBeInTheDocument();
      expect(screen.getByPlaceholderText(/social media manager/i)).toBeInTheDocument();
    });
  });

  it("shows Generate Skill button in guided mode", async () => {
    render(<SkillsPage />, { wrapper: createWrapper({ skills: mockSkills }) });
    fireEvent.click(screen.getByRole("button", { name: "New Skill" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Generate Skill" })).toBeInTheDocument();
    });
  });

  it("Generate Skill button is disabled when description is empty", async () => {
    render(<SkillsPage />, { wrapper: createWrapper({ skills: mockSkills }) });
    fireEvent.click(screen.getByRole("button", { name: "New Skill" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Generate Skill" })).toBeDisabled();
    });
  });

  it("shows tool search input in guided mode", async () => {
    render(<SkillsPage />, { wrapper: createWrapper({ skills: mockSkills }) });
    fireEvent.click(screen.getByRole("button", { name: "New Skill" }));
    await waitFor(() => {
      expect(screen.getByPlaceholderText("Search tools...")).toBeInTheDocument();
    });
  });

  it("switches to advanced mode showing raw editor", async () => {
    render(<SkillsPage />, { wrapper: createWrapper({ skills: mockSkills }) });
    fireEvent.click(screen.getByRole("button", { name: "New Skill" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Advanced" })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
    await waitFor(() => {
      expect(screen.getByText("New Skill", { selector: "h2" })).toBeInTheDocument();
      expect(screen.getByPlaceholderText("my-custom-skill")).toBeInTheDocument();
    });
  });

  it("shows subtitle about AI generation in guided mode", async () => {
    render(<SkillsPage />, { wrapper: createWrapper({ skills: mockSkills }) });
    fireEvent.click(screen.getByRole("button", { name: "New Skill" }));
    await waitFor(() => {
      expect(screen.getByText("Describe what you need and let AI generate it")).toBeInTheDocument();
    });
  });
});
