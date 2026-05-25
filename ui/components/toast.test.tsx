import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  render,
  screen,
  act,
  waitFor,
  fireEvent,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { ToastContainer, showSidecarErrorToast, showToast } from "./toast";

describe("toast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders a plain error toast without an action button", () => {
    render(<ToastContainer />);
    act(() => {
      showToast("Something went wrong", "error");
    });
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("omits the Restart CTA when status is not a gateway error", () => {
    render(<ToastContainer />);
    act(() => {
      showSidecarErrorToast("Bad request", {
        sidecarName: "v2a",
        status: 400,
      });
    });
    expect(
      screen.queryByRole("button", { name: /restart sidecar/i }),
    ).toBeNull();
  });

  it("omits the Restart CTA when sidecarName is missing", () => {
    render(<ToastContainer />);
    act(() => {
      showSidecarErrorToast("Gateway down", { status: 502 });
    });
    expect(
      screen.queryByRole("button", { name: /restart sidecar/i }),
    ).toBeNull();
  });

  it.each([502, 503, 504])("attaches a Restart CTA on HTTP %i", (status) => {
    render(<ToastContainer />);
    act(() => {
      showSidecarErrorToast("Sidecar unavailable", {
        sidecarName: "v2a",
        status,
      });
    });
    expect(
      screen.getByRole("button", { name: /restart sidecar/i }),
    ).toBeInTheDocument();
  });

  it("POSTs to the restart endpoint with bearer token when CTA is clicked", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));

    render(<ToastContainer />);
    act(() => {
      showSidecarErrorToast("Sidecar down", {
        sidecarName: "music studio",
        status: 503,
        apiBase: "http://localhost:8787",
        apiToken: "secret",
      });
    });

    const button = screen.getByRole("button", { name: /restart sidecar/i });
    await act(async () => {
      fireEvent.click(button);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      "http://localhost:8787/api/admin/ai-sidecars/music%20studio/restart",
    );
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer secret");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("omits Authorization header when no token is provided", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));

    render(<ToastContainer />);
    act(() => {
      showSidecarErrorToast("Boom", {
        sidecarName: "v2a",
        status: 502,
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /restart sidecar/i }));
    });

    const headers = fetchMock.mock.calls[0]![1]?.headers as Record<
      string,
      string
    >;
    expect(headers.Authorization).toBeUndefined();
  });

  it("surfaces a failure toast when restart fails", async () => {
    vi.useRealTimers();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("nope", { status: 500 }),
    );

    render(<ToastContainer />);
    act(() => {
      showSidecarErrorToast("Down", {
        sidecarName: "v2a",
        status: 502,
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /restart sidecar/i }));
    });

    await waitFor(() =>
      expect(screen.getByText(/failed to restart v2a/i)).toBeInTheDocument(),
    );
  });

  it("auto-dismisses after the default duration", () => {
    render(<ToastContainer />);
    act(() => {
      showToast("Hello", "info");
    });
    expect(screen.getByText("Hello")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(4001);
    });
    expect(screen.queryByText("Hello")).toBeNull();
  });
});
