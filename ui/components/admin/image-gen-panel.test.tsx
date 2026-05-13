import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ImageGenPanel } from "./image-gen-panel";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const createWrapper = (
  config = {
    mode: "local" as const,
    networkNodeUrl: "",
    networkNodeToken: "",
    hasToken: false,
  },
) => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  qc.setQueryData(["image-gen-config"], config);

  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  Wrapper.displayName = "ImageGenPanelTestWrapper";
  return Wrapper;
};

describe("ImageGenPanel", () => {
  it("renders mode toggle with local selected by default", () => {
    render(<ImageGenPanel />, { wrapper: createWrapper() });

    expect(screen.getByText("Local Process")).toBeInTheDocument();
    expect(screen.getByText("Network Node")).toBeInTheDocument();
    expect(
      screen.getByText(/Image generation runs on this machine/),
    ).toBeInTheDocument();
  });

  it("shows network config fields when switching to network mode", () => {
    render(<ImageGenPanel />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByText("Network Node"));

    expect(screen.getByText("Node URL")).toBeInTheDocument();
    expect(screen.getByText(/Secret Token/)).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("http://192.168.1.50:5005"),
    ).toBeInTheDocument();
  });

  it("hides network config fields in local mode", () => {
    render(<ImageGenPanel />, { wrapper: createWrapper() });

    expect(screen.queryByText("Node URL")).not.toBeInTheDocument();
  });

  it("renders health check button", () => {
    render(<ImageGenPanel />, { wrapper: createWrapper() });

    expect(screen.getByText("Test Connection")).toBeInTheDocument();
  });

  it("renders save button", () => {
    render(<ImageGenPanel />, { wrapper: createWrapper() });

    expect(screen.getByText("Save")).toBeInTheDocument();
  });

  it("shows configured token indicator in network mode", () => {
    render(<ImageGenPanel />, {
      wrapper: createWrapper({
        mode: "network",
        networkNodeUrl: "http://192.168.1.50:5005",
        networkNodeToken: "••••••••",
        hasToken: true,
      }),
    });

    expect(screen.getByText("(configured)")).toBeInTheDocument();
  });
});
