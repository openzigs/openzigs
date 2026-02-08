import { describe, it, expect } from "vitest";
import { formatApprovalContext } from "./approval-formatters.js";

describe("Approval Formatters", () => {
  describe("gmail-send", () => {
    it("should format email send approval", () => {
      const ctx = formatApprovalContext("gmail-send", {
        to: "boss@corp.com",
        subject: "Q4 Report",
        body: "Please find attached the quarterly report.",
      });

      expect(ctx).toBeDefined();
      expect(ctx!.summary).toContain("boss@corp.com");
      expect(ctx!.details).toContainEqual(expect.stringContaining("boss@corp.com"));
      expect(ctx!.details).toContainEqual(expect.stringContaining("Q4 Report"));
      expect(ctx!.details).toContainEqual(expect.stringContaining("Please find attached"));
      expect(ctx!.destructiveAction).toContain("send an email");
    });

    it("should truncate long email body in details", () => {
      const longBody = "A".repeat(500);
      const ctx = formatApprovalContext("gmail-send", {
        to: "user@test.com",
        subject: "Test",
        body: longBody,
      });

      const bodyDetail = ctx!.details.find((d) => d.startsWith("Body:"));
      expect(bodyDetail).toBeDefined();
      expect(bodyDetail!.length).toBeLessThan(500);
      expect(bodyDetail).toContain("...");
    });
  });

  describe("db-query", () => {
    it("should format SQL query approval", () => {
      const ctx = formatApprovalContext("db-query", {
        query: "DELETE FROM users WHERE active = false",
      });

      expect(ctx).toBeDefined();
      expect(ctx!.summary).toContain("SQL");
      expect(ctx!.details).toContainEqual("DELETE FROM users WHERE active = false");
    });

    it("should set correct destructive action message", () => {
      const ctx = formatApprovalContext("db-query", {
        query: "DROP TABLE sessions",
      });

      expect(ctx!.destructiveAction).toContain("SQL query");
    });
  });

  describe("github-create-pr", () => {
    it("should format PR creation approval", () => {
      const ctx = formatApprovalContext("github-create-pr", {
        owner: "octocat",
        repo: "hello-world",
        title: "Add feature X",
        head: "feature-x",
        base: "main",
      });

      expect(ctx).toBeDefined();
      expect(ctx!.summary).toContain("octocat/hello-world");
      expect(ctx!.details).toContainEqual(expect.stringContaining("Add feature X"));
      expect(ctx!.details).toContainEqual(expect.stringContaining("feature-x"));
      expect(ctx!.details).toContainEqual(expect.stringContaining("main"));
    });
  });

  describe("social-post", () => {
    it("should format social media post approval", () => {
      const ctx = formatApprovalContext("social-post", {
        platform: "twitter",
        content: "Check out our new release!",
      });

      expect(ctx).toBeDefined();
      expect(ctx!.summary).toContain("twitter");
      expect(ctx!.details).toContainEqual(expect.stringContaining("Check out our new release!"));
    });
  });

  describe("write-file", () => {
    it("should format file write approval", () => {
      const ctx = formatApprovalContext("write-file", {
        path: "/etc/nginx/nginx.conf",
        content: "server { listen 80; }",
      });

      expect(ctx).toBeDefined();
      expect(ctx!.summary).toContain("/etc/nginx/nginx.conf");
      expect(ctx!.details).toContainEqual(expect.stringContaining("/etc/nginx/nginx.conf"));
    });
  });

  describe("shell-execute", () => {
    it("should format shell command approval", () => {
      const ctx = formatApprovalContext("shell-execute", {
        command: "rm -rf /tmp/old-data",
      });

      expect(ctx).toBeDefined();
      expect(ctx!.summary).toContain("rm -rf");
      expect(ctx!.details).toContainEqual(expect.stringContaining("rm -rf /tmp/old-data"));
    });
  });

  describe("browser-navigate", () => {
    it("should format browser navigation approval", () => {
      const ctx = formatApprovalContext("browser-navigate", {
        url: "https://admin.example.com/delete-all",
        action: "click",
      });

      expect(ctx).toBeDefined();
      expect(ctx!.summary).toContain("click");
      expect(ctx!.details).toContainEqual(expect.stringContaining("admin.example.com"));
    });
  });

  describe("unknown tool", () => {
    it("should return undefined for unrecognized tools", () => {
      const ctx = formatApprovalContext("unknown-tool", { foo: "bar" });
      expect(ctx).toBeUndefined();
    });
  });
});
