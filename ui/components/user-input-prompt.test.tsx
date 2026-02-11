import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { UserInputPrompt } from "./user-input-prompt";
import type { UserInputRequest } from "@/lib/types";

const baseRequest: UserInputRequest = {
  requestId: "req-1",
  question: "Which deployment target?",
  choices: ["production", "staging", "development"],
  allowFreeform: true,
};

describe("UserInputPrompt", () => {
  it("renders the question", () => {
    render(<UserInputPrompt request={baseRequest} onSubmit={vi.fn()} />);
    expect(screen.getByText("Which deployment target?")).toBeInTheDocument();
  });

  it("renders all choices", () => {
    render(<UserInputPrompt request={baseRequest} onSubmit={vi.fn()} />);
    expect(screen.getByText("production")).toBeInTheDocument();
    expect(screen.getByText("staging")).toBeInTheDocument();
    expect(screen.getByText("development")).toBeInTheDocument();
  });

  it("renders freeform input when allowFreeform is true", () => {
    render(<UserInputPrompt request={baseRequest} onSubmit={vi.fn()} />);
    expect(screen.getByPlaceholderText(/type your answer/i)).toBeInTheDocument();
  });

  it("starts with submit button disabled", () => {
    render(<UserInputPrompt request={baseRequest} onSubmit={vi.fn()} />);
    expect(screen.getByRole("button", { name: /submit/i })).toBeDisabled();
  });

  it("enables submit after selecting a choice", () => {
    render(<UserInputPrompt request={baseRequest} onSubmit={vi.fn()} />);
    fireEvent.click(screen.getByText("staging"));
    expect(screen.getByRole("button", { name: /submit/i })).not.toBeDisabled();
  });

  it("calls onSubmit with selected choice", () => {
    const onSubmit = vi.fn();
    render(<UserInputPrompt request={baseRequest} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByText("production"));
    fireEvent.click(screen.getByRole("button", { name: /submit/i }));
    expect(onSubmit).toHaveBeenCalledWith("production", false);
  });

  it("calls onSubmit with freeform text", () => {
    const onSubmit = vi.fn();
    render(<UserInputPrompt request={baseRequest} onSubmit={onSubmit} />);
    const input = screen.getByPlaceholderText(/type your answer/i);
    fireEvent.change(input, { target: { value: "custom-env" } });
    fireEvent.click(screen.getByRole("button", { name: /submit/i }));
    expect(onSubmit).toHaveBeenCalledWith("custom-env", true);
  });

  it("shows answered state after submission", () => {
    render(<UserInputPrompt request={baseRequest} onSubmit={vi.fn()} />);
    fireEvent.click(screen.getByText("staging"));
    fireEvent.click(screen.getByRole("button", { name: /submit/i }));
    expect(screen.getByText(/answered:/i)).toBeInTheDocument();
    expect(screen.getByText("staging")).toBeInTheDocument();
  });

  it("renders without choices as freeform-only", () => {
    const request: UserInputRequest = {
      requestId: "req-2",
      question: "Enter a custom name",
    };
    render(<UserInputPrompt request={request} onSubmit={vi.fn()} />);
    expect(screen.getByPlaceholderText(/type your answer/i)).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
  });

  it("submits on Enter key in freeform input", () => {
    const onSubmit = vi.fn();
    const request: UserInputRequest = {
      requestId: "req-3",
      question: "Enter name",
    };
    render(<UserInputPrompt request={request} onSubmit={onSubmit} />);
    const input = screen.getByPlaceholderText(/type your answer/i);
    fireEvent.change(input, { target: { value: "my-name" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("my-name", true);
  });
});
