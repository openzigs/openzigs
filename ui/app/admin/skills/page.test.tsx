import { describe, it, expect, vi } from "vitest";

const mockRedirect = vi.fn();
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    mockRedirect(url);
    throw new Error("NEXT_REDIRECT");
  },
}));

import AdminSkillsRedirect from "./page";

describe("AdminSkillsRedirect", () => {
  it("redirects to /skills", () => {
    expect(() => AdminSkillsRedirect()).toThrow("NEXT_REDIRECT");
    expect(mockRedirect).toHaveBeenCalledWith("/skills");
  });
});
