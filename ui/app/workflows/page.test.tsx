import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

vi.mock("./workflow-builder", () => ({
  WorkflowBuilder: () => <div data-testid="wb">workflow-builder</div>,
}));

import WorkflowsPage from "./page";

describe("/workflows page", () => {
  it("mounts the WorkflowBuilder", () => {
    render(<WorkflowsPage />);
    expect(screen.getByTestId("wb")).toBeInTheDocument();
  });
});
