import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { AudioWaveformCompare } from "./audio-waveform-compare";

const wsInstances: Array<{
  on: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}> = [];

vi.mock("wavesurfer.js", () => {
  return {
    default: {
      create: vi.fn(() => {
        const inst = {
          on: vi.fn(),
          destroy: vi.fn(),
        };
        wsInstances.push(inst);
        return inst;
      }),
    },
  };
});

describe("AudioWaveformCompare", () => {
  it("renders the original waveform container and a placeholder when no cleaned url", async () => {
    render(<AudioWaveformCompare originalUrl="blob:original" />);
    expect(screen.getByTestId("waveform-original")).toBeInTheDocument();
    expect(screen.queryByTestId("waveform-cleaned")).toBeNull();
    expect(screen.getByText(/Run cleanup/i)).toBeInTheDocument();
    await waitFor(() => expect(wsInstances.length).toBeGreaterThanOrEqual(1));
  });

  it("renders both containers when both URLs provided", async () => {
    render(
      <AudioWaveformCompare
        originalUrl="blob:original"
        cleanedUrl="blob:cleaned"
      />,
    );
    expect(screen.getByTestId("waveform-original")).toBeInTheDocument();
    expect(screen.getByTestId("waveform-cleaned")).toBeInTheDocument();
    await waitFor(() => expect(wsInstances.length).toBeGreaterThanOrEqual(2));
  });
});
