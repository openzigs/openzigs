import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

vi.mock("@/lib/api", () => ({
  buildUrl: (p: string) => p,
  fetchJson: vi.fn(),
  AUTH_TOKEN: "",
}));
vi.mock("@/components/toast", () => ({
  showToast: vi.fn(),
}));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({
    open,
    children,
  }: {
    open: boolean;
    children: ReactNode;
  }) => (open ? <div role="dialog">{children}</div> : null),
  DialogContent: ({ children, ...rest }: { children: ReactNode }) => (
    <div {...rest}>{children}</div>
  ),
  DialogHeader: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogFooter: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h3>{children}</h3>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
}));

import { fetchJson } from "@/lib/api";
import { BrandKitEditor } from "./brand-kit-editor";

const wrapper = ({ children }: { children: ReactNode }) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};

beforeEach(() => {
  vi.mocked(fetchJson).mockReset();
});

describe("BrandKitEditor", () => {
  it("does not render when closed", () => {
    render(
      <BrandKitEditor open={false} onOpenChange={vi.fn()} kit={null} />,
      { wrapper },
    );
    expect(screen.queryByTestId("pitch-brand-kit-editor")).toBeNull();
  });

  it("validates hex colors and surfaces an inline error", () => {
    render(<BrandKitEditor open onOpenChange={vi.fn()} kit={null} />, {
      wrapper,
    });
    fireEvent.change(screen.getByTestId("pitch-bk-name"), {
      target: { value: "Test" },
    });
    fireEvent.change(screen.getByTestId("pitch-bk-primaryColor-hex"), {
      target: { value: "abc" },
    });
    expect(
      screen.getByTestId("pitch-bk-primaryColor-error"),
    ).toBeInTheDocument();
    expect(
      (screen.getByTestId("pitch-bk-save") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("warns when selected colors have low presentation contrast", () => {
    render(<BrandKitEditor open onOpenChange={vi.fn()} kit={null} />, {
      wrapper,
    });
    fireEvent.change(screen.getByTestId("pitch-bk-name"), {
      target: { value: "Unreadable" },
    });
    fireEvent.change(screen.getByTestId("pitch-bk-primaryColor-hex"), {
      target: { value: "#111111" },
    });
    fireEvent.change(screen.getByTestId("pitch-bk-secondaryColor-hex"), {
      target: { value: "#101010" },
    });
    expect(screen.getByTestId("pitch-bk-contrast-warning")).toHaveTextContent(
      /low contrast/i,
    );
    expect(
      (screen.getByTestId("pitch-bk-save") as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("creates a new kit via POST when saving", async () => {
    vi.mocked(fetchJson).mockResolvedValue({ brandKit: { id: "new-1" } });
    const onSaved = vi.fn();
    render(
      <BrandKitEditor open onOpenChange={vi.fn()} kit={null} onSaved={onSaved} />,
      { wrapper },
    );
    fireEvent.change(screen.getByTestId("pitch-bk-name"), {
      target: { value: "Brand A" },
    });
    fireEvent.click(screen.getByTestId("pitch-bk-save"));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith("new-1"));
    const [url, init] = vi.mocked(fetchJson).mock.calls[0];
    expect(url).toBe("/api/admin/pitch/brand-kits");
    expect((init as { method: string }).method).toBe("POST");
    const body = JSON.parse((init as { body: string }).body);
    expect(body.name).toBe("Brand A");
    expect(body.fontFamily).toBeDefined();
  });

  it("PATCHes when editing an existing custom kit", async () => {
    vi.mocked(fetchJson).mockResolvedValue({});
    render(
      <BrandKitEditor
        open
        onOpenChange={vi.fn()}
        kit={{
          id: "k2",
          name: "Existing",
          primaryColor: "#111111",
          secondaryColor: "#222222",
          accentColor: "#333333",
          isStarter: false,
        }}
      />,
      { wrapper },
    );
    fireEvent.click(screen.getByTestId("pitch-bk-save"));
    await waitFor(() => expect(vi.mocked(fetchJson)).toHaveBeenCalled());
    const [url, init] = vi.mocked(fetchJson).mock.calls[0];
    expect(url).toBe("/api/admin/pitch/brand-kits/k2");
    expect((init as { method: string }).method).toBe("PATCH");
  });

  it("shows the starter notice and duplicates on click", async () => {
    vi.mocked(fetchJson).mockResolvedValue({ brandKit: { id: "dup-1" } });
    const onSaved = vi.fn();
    render(
      <BrandKitEditor
        open
        onOpenChange={vi.fn()}
        kit={{
          id: "starter-1",
          name: "Default Starter",
          primaryColor: "#111111",
          secondaryColor: "#222222",
          accentColor: "#333333",
          isStarter: true,
        }}
        onSaved={onSaved}
      />,
      { wrapper },
    );
    expect(
      screen.getByTestId("pitch-brand-kit-starter-notice"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("pitch-bk-duplicate"));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith("dup-1"));
    const body = JSON.parse(
      (vi.mocked(fetchJson).mock.calls[0][1] as { body: string }).body,
    );
    expect(body.name).toBe("Default Starter copy");
  });

  it("rejects oversize logo files", async () => {
    render(
      <BrandKitEditor
        open
        onOpenChange={vi.fn()}
        kit={{
          id: "k1",
          name: "x",
          primaryColor: "#000000",
          secondaryColor: "#ffffff",
          accentColor: "#0066ff",
          isStarter: false,
        }}
      />,
      { wrapper },
    );
    const input = screen.getByTestId(
      "pitch-bk-logo-input",
    ) as HTMLInputElement;
    const big = new File(
      [new Uint8Array(1)],
      "big.png",
      { type: "image/png" },
    );
    Object.defineProperty(big, "size", { value: 3 * 1024 * 1024 });
    fireEvent.change(input, { target: { files: [big] } });
    await waitFor(() =>
      expect(screen.getByTestId("pitch-bk-logo-error")).toHaveTextContent(
        /2 MB/,
      ),
    );
  });

  it("rejects logos with an unsupported mime", async () => {
    render(
      <BrandKitEditor
        open
        onOpenChange={vi.fn()}
        kit={{
          id: "k1",
          name: "x",
          primaryColor: "#000000",
          secondaryColor: "#ffffff",
          accentColor: "#0066ff",
          isStarter: false,
        }}
      />,
      { wrapper },
    );
    const input = screen.getByTestId(
      "pitch-bk-logo-input",
    ) as HTMLInputElement;
    const bad = new File([new Uint8Array(1)], "x.gif", { type: "image/gif" });
    fireEvent.change(input, { target: { files: [bad] } });
    await waitFor(() =>
      expect(screen.getByTestId("pitch-bk-logo-error")).toHaveTextContent(
        /PNG|JPEG|WebP/i,
      ),
    );
  });

  it("updates color picker, font heading/body, and footer text", () => {
    render(<BrandKitEditor open onOpenChange={vi.fn()} kit={null} />, {
      wrapper,
    });
    fireEvent.change(screen.getByTestId("pitch-bk-primaryColor-picker"), {
      target: { value: "#abcdef" },
    });
    expect(
      (screen.getByTestId("pitch-bk-primaryColor-hex") as HTMLInputElement)
        .value,
    ).toBe("#abcdef");
    fireEvent.change(screen.getByTestId("pitch-bk-font-heading"), {
      target: { value: "Lora" },
    });
    fireEvent.change(screen.getByTestId("pitch-bk-font-body"), {
      target: { value: "Roboto" },
    });
    fireEvent.change(screen.getByTestId("pitch-bk-footer"), {
      target: { value: "© ACME" },
    });
    expect(
      (screen.getByTestId("pitch-bk-font-heading") as HTMLInputElement).value,
    ).toBe("Lora");
    expect(
      (screen.getByTestId("pitch-bk-font-body") as HTMLInputElement).value,
    ).toBe("Roboto");
    expect(
      (screen.getByTestId("pitch-bk-footer") as HTMLInputElement).value,
    ).toBe("© ACME");
  });

  it("uploads a valid logo via fetch when a kit exists", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }));
    render(
      <BrandKitEditor
        open
        onOpenChange={vi.fn()}
        kit={{
          id: "k1",
          name: "x",
          primaryColor: "#000000",
          secondaryColor: "#ffffff",
          accentColor: "#0066ff",
          isStarter: false,
        }}
      />,
      { wrapper },
    );
    const input = screen.getByTestId(
      "pitch-bk-logo-input",
    ) as HTMLInputElement;
    const ok = new File([new Uint8Array(2)], "x.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [ok] } });
    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/admin/pitch/brand-kits/k1/logo",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    fetchSpy.mockRestore();
  });

  it("closes via the Close footer button", () => {
    const onOpenChange = vi.fn();
    render(<BrandKitEditor open onOpenChange={onOpenChange} kit={null} />, {
      wrapper,
    });
    fireEvent.click(screen.getByText("Close"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  // Sub-issue #1047 — default logo placement + slide-number toggle UI.
  describe("#1047 — default logo placement + slide-number toggle", () => {
    it("renders both controls", () => {
      render(<BrandKitEditor open onOpenChange={vi.fn()} kit={null} />, {
        wrapper,
      });
      expect(
        screen.getByTestId("pitch-bk-default-logo-placement"),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId("pitch-bk-show-slide-numbers"),
      ).toBeInTheDocument();
    });

    it("persists defaultLogoPlacement and showSlideNumbers on create", async () => {
      vi.mocked(fetchJson).mockResolvedValue({ brandKit: { id: "new-1" } });
      render(<BrandKitEditor open onOpenChange={vi.fn()} kit={null} />, {
        wrapper,
      });
      fireEvent.change(screen.getByTestId("pitch-bk-name"), {
        target: { value: "Brand A" },
      });
      fireEvent.change(
        screen.getByTestId("pitch-bk-default-logo-placement"),
        { target: { value: "top-left" } },
      );
      fireEvent.click(screen.getByTestId("pitch-bk-show-slide-numbers"));
      fireEvent.click(screen.getByTestId("pitch-bk-save"));
      await waitFor(() => expect(vi.mocked(fetchJson)).toHaveBeenCalled());
      const init = vi.mocked(fetchJson).mock.calls[0][1] as { body: string };
      const body = JSON.parse(init.body);
      expect(body.defaultLogoPlacement).toBe("top-left");
      expect(body.showSlideNumbers).toBe(true);
    });

    it("prefills the controls from an existing kit", () => {
      render(
        <BrandKitEditor
          open
          onOpenChange={vi.fn()}
          kit={{
            id: "k9",
            name: "Existing",
            primaryColor: "#111111",
            secondaryColor: "#222222",
            accentColor: "#333333",
            defaultLogoPlacement: "bottom-left",
            showSlideNumbers: true,
            footerText: "(c) ACME",
            isStarter: false,
          }}
        />,
        { wrapper },
      );
      expect(
        (screen.getByTestId(
          "pitch-bk-default-logo-placement",
        ) as HTMLSelectElement).value,
      ).toBe("bottom-left");
      expect(
        (screen.getByTestId(
          "pitch-bk-show-slide-numbers",
        ) as HTMLInputElement).checked,
      ).toBe(true);
      expect(
        (screen.getByTestId("pitch-bk-footer") as HTMLInputElement).value,
      ).toBe("(c) ACME");
    });

    it("omits defaultLogoPlacement when the user keeps the renderer default", async () => {
      vi.mocked(fetchJson).mockResolvedValue({ brandKit: { id: "new-1" } });
      render(<BrandKitEditor open onOpenChange={vi.fn()} kit={null} />, {
        wrapper,
      });
      fireEvent.change(screen.getByTestId("pitch-bk-name"), {
        target: { value: "Brand B" },
      });
      fireEvent.click(screen.getByTestId("pitch-bk-save"));
      await waitFor(() => expect(vi.mocked(fetchJson)).toHaveBeenCalled());
      const body = JSON.parse(
        (vi.mocked(fetchJson).mock.calls[0][1] as { body: string }).body,
      );
      expect(body.defaultLogoPlacement).toBeUndefined();
      expect(body.showSlideNumbers).toBe(false);
    });
  });

  // PR #1044 follow-up — discoverable logo upload + preview + remove.
  describe("logo preview / upload / remove (PR #1044 follow-up)", () => {
    const baseKit = {
      id: "k1",
      name: "x",
      primaryColor: "#000000",
      secondaryColor: "#ffffff",
      accentColor: "#0066ff",
      isStarter: false as const,
    };

    it("renders the empty-state placeholder when no logo is uploaded", () => {
      render(
        <BrandKitEditor
          open
          onOpenChange={vi.fn()}
          kit={{ ...baseKit, logoUrl: null }}
        />,
        { wrapper },
      );
      expect(screen.getByTestId("pitch-bk-logo-empty")).toHaveTextContent(
        /No logo uploaded/i,
      );
      expect(screen.queryByTestId("pitch-bk-logo-preview")).toBeNull();
      expect(screen.getByTestId("pitch-bk-logo-upload-label")).toHaveTextContent(
        /Upload logo/i,
      );
      expect(screen.queryByTestId("pitch-bk-logo-remove")).toBeNull();
    });

    it("renders an <img> preview when kit.logoUrl is set, with Replace + Remove buttons", () => {
      render(
        <BrandKitEditor
          open
          onOpenChange={vi.fn()}
          kit={{
            ...baseKit,
            logoUrl: "/api/admin/pitch/brand-kits/k1/logo",
          }}
        />,
        { wrapper },
      );
      const img = screen.getByTestId(
        "pitch-bk-logo-preview",
      ) as HTMLImageElement;
      expect(img).toBeInTheDocument();
      expect(img.getAttribute("src")).toBe(
        "/api/admin/pitch/brand-kits/k1/logo",
      );
      expect(screen.queryByTestId("pitch-bk-logo-empty")).toBeNull();
      expect(screen.getByTestId("pitch-bk-logo-upload-label")).toHaveTextContent(
        /Replace logo/i,
      );
      expect(screen.getByTestId("pitch-bk-logo-remove")).toBeInTheDocument();
    });

    it("renders the section in create mode with an enabled upload (queue-then-upload flow)", () => {
      render(<BrandKitEditor open onOpenChange={vi.fn()} kit={null} />, {
        wrapper,
      });
      expect(screen.getByTestId("pitch-bk-logo-section")).toBeInTheDocument();
      // Upload is enabled in create mode now \u2014 file is queued locally
      // and flushed after the kit is saved.
      expect(
        (screen.getByTestId("pitch-bk-logo-input") as HTMLInputElement).disabled,
      ).toBe(false);
      expect(screen.getByTestId("pitch-bk-logo-upload-label")).toHaveTextContent(
        /Upload logo/i,
      );
    });

    it("queues a logo file in create mode and previews it before save", async () => {
      // jsdom doesn't implement createObjectURL — stub it.
      const createObjectURL = vi.fn(() => "blob:mock");
      const revokeObjectURL = vi.fn();
      // @ts-expect-error — jsdom URL doesn't expose these by default.
      URL.createObjectURL = createObjectURL;
      // @ts-expect-error — same.
      URL.revokeObjectURL = revokeObjectURL;
      render(<BrandKitEditor open onOpenChange={vi.fn()} kit={null} />, {
        wrapper,
      });
      const file = new File([new Uint8Array(1)], "logo.png", { type: "image/png" });
      Object.defineProperty(file, "size", { value: 1024 });
      fireEvent.change(
        screen.getByTestId("pitch-bk-logo-input") as HTMLInputElement,
        { target: { files: [file] } },
      );
      await waitFor(() => {
        expect(screen.getByTestId("pitch-bk-logo-preview")).toHaveAttribute(
          "src",
          "blob:mock",
        );
      });
      expect(screen.getByTestId("pitch-bk-logo-upload-label")).toHaveTextContent(
        /Replace logo/i,
      );
      expect(screen.getByTestId("pitch-bk-logo-section")).toHaveTextContent(
        /Will upload "logo\.png"/,
      );
    });
    it("DELETEs the logo when Remove is clicked and the user confirms", async () => {
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
      vi.mocked(fetchJson).mockResolvedValue({});
      render(
        <BrandKitEditor
          open
          onOpenChange={vi.fn()}
          kit={{
            ...baseKit,
            logoUrl: "/api/admin/pitch/brand-kits/k1/logo",
          }}
        />,
        { wrapper },
      );
      fireEvent.click(screen.getByTestId("pitch-bk-logo-remove"));
      await waitFor(() =>
        expect(vi.mocked(fetchJson)).toHaveBeenCalledWith(
          "/api/admin/pitch/brand-kits/k1/logo",
          expect.objectContaining({ method: "DELETE" }),
        ),
      );
      confirmSpy.mockRestore();
    });

    it("does not DELETE when the user cancels the confirm dialog", () => {
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
      render(
        <BrandKitEditor
          open
          onOpenChange={vi.fn()}
          kit={{
            ...baseKit,
            logoUrl: "/api/admin/pitch/brand-kits/k1/logo",
          }}
        />,
        { wrapper },
      );
      fireEvent.click(screen.getByTestId("pitch-bk-logo-remove"));
      expect(vi.mocked(fetchJson)).not.toHaveBeenCalled();
      confirmSpy.mockRestore();
    });
  });
});
