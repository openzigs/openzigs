import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { YouTubeMetadataEditor } from "./youtube-metadata-editor";

// Mock fetchJson
vi.mock("@/lib/api", () => ({
  fetchJson: vi.fn(),
}));

vi.mock("@/components/toast", () => ({
  showToast: vi.fn(),
}));

import { fetchJson } from "@/lib/api";
const mockFetchJson = fetchJson as ReturnType<typeof vi.fn>;

describe("YouTubeMetadataEditor", () => {
  const defaultProps = {
    draftId: "draft-1",
    defaultTitle: "My Video",
    open: true,
    onClose: vi.fn(),
    onPublish: vi.fn(),
    publishing: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: categories endpoint returns a list
    mockFetchJson.mockImplementation((url: string) => {
      if (url.includes("/youtube/categories")) {
        return Promise.resolve({
          categories: [
            { id: "22", name: "People & Blogs" },
            { id: "28", name: "Science & Technology" },
          ],
        });
      }
      return Promise.resolve({});
    });
  });

  it("renders nothing when closed", () => {
    const { container } = render(
      <YouTubeMetadataEditor {...defaultProps} open={false} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders the modal when open", () => {
    render(<YouTubeMetadataEditor {...defaultProps} />);
    expect(screen.getByText("Publish to YouTube")).toBeInTheDocument();
  });

  it("displays the default title", () => {
    render(<YouTubeMetadataEditor {...defaultProps} />);
    const input = screen.getByPlaceholderText("Video title") as HTMLInputElement;
    expect(input.value).toBe("My Video");
  });

  it("shows privacy options", () => {
    render(<YouTubeMetadataEditor {...defaultProps} />);
    expect(screen.getByText("Public")).toBeInTheDocument();
    expect(screen.getByText("Unlisted")).toBeInTheDocument();
    expect(screen.getByText("Private")).toBeInTheDocument();
  });

  it("calls onPublish with metadata when Publish is clicked", () => {
    render(<YouTubeMetadataEditor {...defaultProps} />);
    const publishBtn = screen.getByRole("button", { name: "Publish" });
    fireEvent.click(publishBtn);
    expect(defaultProps.onPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "My Video",
        privacyStatus: "private",
        categoryId: "22",
      }),
    );
  });

  it("calls onClose when Cancel is clicked", () => {
    render(<YouTubeMetadataEditor {...defaultProps} />);
    fireEvent.click(screen.getByText("Cancel"));
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it("disables publish when title is empty", () => {
    render(<YouTubeMetadataEditor {...defaultProps} defaultTitle="" />);
    const publishBtn = screen.getByRole("button", { name: "Publish" });
    expect(publishBtn).toBeDisabled();
  });

  it("shows Publishing… state", () => {
    render(<YouTubeMetadataEditor {...defaultProps} publishing={true} />);
    expect(screen.getByText("Publishing…")).toBeInTheDocument();
  });

  it("calls generate-metadata API when Generate with AI is clicked", async () => {
    mockFetchJson.mockImplementation((url: string) => {
      if (url.includes("/youtube/categories")) {
        return Promise.resolve({
          categories: [{ id: "28", name: "Science & Technology" }],
        });
      }
      if (url.includes("/youtube/generate-metadata")) {
        return Promise.resolve({
          title: "AI Generated Title",
          description: "AI description",
          tags: ["ai", "tech"],
          suggestedCategory: "Science & Technology",
          chapters: "0:00 Intro\n1:30 Main Topic",
        });
      }
      return Promise.resolve({});
    });

    render(<YouTubeMetadataEditor {...defaultProps} />);
    fireEvent.click(screen.getByText("Generate with AI"));

    await waitFor(() => {
      const input = screen.getByPlaceholderText("Video title") as HTMLInputElement;
      expect(input.value).toBe("AI Generated Title");
    });
  });

  it("adds tags on Enter key", () => {
    render(<YouTubeMetadataEditor {...defaultProps} />);
    const tagInput = screen.getByPlaceholderText("Type a tag, press Enter");
    fireEvent.change(tagInput, { target: { value: "newtag" } });
    fireEvent.keyDown(tagInput, { key: "Enter" });
    expect(screen.getByText("newtag")).toBeInTheDocument();
  });
});
