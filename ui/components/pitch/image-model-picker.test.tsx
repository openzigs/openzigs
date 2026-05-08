import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import { ImageModelPicker } from "./image-model-picker";

describe("ImageModelPicker", () => {
  it("renders both options and shows the current value", () => {
    render(<ImageModelPicker value="flux-schnell" onChange={() => {}} />);
    const select = screen.getByTestId("pitch-image-model-select") as HTMLSelectElement;
    expect(select.value).toBe("flux-schnell");
    expect(screen.getByRole("option", { name: /Fast \(flux-schnell\)/ })).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: /High quality \(flux-dev\)/ }),
    ).toBeInTheDocument();
  });

  it("falls back to flux-schnell when value is null/undefined", () => {
    render(<ImageModelPicker value={null} onChange={() => {}} />);
    const select = screen.getByTestId("pitch-image-model-select") as HTMLSelectElement;
    expect(select.value).toBe("flux-schnell");
  });

  it("reflects an existing flux-dev selection", () => {
    render(<ImageModelPicker value="flux-dev" onChange={() => {}} />);
    const select = screen.getByTestId("pitch-image-model-select") as HTMLSelectElement;
    expect(select.value).toBe("flux-dev");
  });

  it("invokes onChange with the new model when the user picks one", () => {
    const onChange = vi.fn();
    render(<ImageModelPicker value="flux-schnell" onChange={onChange} />);
    const select = screen.getByTestId("pitch-image-model-select");
    fireEvent.change(select, { target: { value: "flux-dev" } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("flux-dev");
  });

  it("respects the disabled prop", () => {
    render(
      <ImageModelPicker
        value="flux-schnell"
        onChange={() => {}}
        disabled
      />,
    );
    expect(screen.getByTestId("pitch-image-model-select")).toBeDisabled();
  });
});
