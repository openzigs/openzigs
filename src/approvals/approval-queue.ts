import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { AuditLogger } from "../logging/audit-logger.js";

export type ApprovalChannel = "web" | "telegram" | "discord";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export type ApprovalRequest = {
  sessionId?: string;
  channelType?: ApprovalChannel;
  tool: string;
  args: Record<string, unknown>;
  riskLevel: "medium" | "high";
  explanation: string;
  preview?: string;
  requestedBy?: string;
  timeoutMs?: number;
};

export type PendingApproval = {
  id: string;
  sessionId?: string;
  channelType: ApprovalChannel;
  tool: string;
  args: Record<string, unknown>;
  riskLevel: "medium" | "high";
  status: ApprovalStatus;
  createdAt: Date;
  expiresAt: Date;
  explanation: string;
  preview?: string;
  decidedBy?: string;
  decidedAt?: Date;
  decidedVia?: ApprovalChannel;
};

export type ApprovalDecision = {
  approved: boolean;
  decidedBy?: string;
  decidedVia?: ApprovalChannel;
};

export type ApprovalResult = {
  approved: boolean;
  status: ApprovalStatus;
  approval: PendingApproval;
};

export type ApprovalQueueOptions = {
  clock?: () => Date;
  timeoutMs?: number;
  retentionMs?: number;
  auditLogger?: AuditLogger;
};

export class ApprovalQueue extends EventEmitter {
  private approvals = new Map<string, PendingApproval>();
  private waiters = new Map<string, (result: ApprovalResult) => void>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private clock: () => Date;
  private timeoutMs: number;
  private retentionMs: number;
  private auditLogger?: AuditLogger;

  constructor(options: ApprovalQueueOptions = {}) {
    super();
    this.clock = options.clock ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
    this.retentionMs = options.retentionMs ?? 10 * 60 * 1000;
    this.auditLogger = options.auditLogger;
  }

  async requestApproval(request: ApprovalRequest): Promise<ApprovalResult> {
    const createdAt = this.clock();
    const timeoutMs = request.timeoutMs ?? this.timeoutMs;
    const approval: PendingApproval = {
      id: randomUUID(),
      sessionId: request.sessionId,
      channelType: request.channelType ?? "web",
      tool: request.tool,
      args: request.args,
      riskLevel: request.riskLevel,
      status: "pending",
      createdAt,
      expiresAt: new Date(createdAt.getTime() + timeoutMs),
      explanation: request.explanation,
      preview: request.preview
    };

    this.approvals.set(approval.id, approval);
    this.emit("approval:created", approval);
    if (this.auditLogger) {
      void this.auditLogger.log({
        level: "security",
        category: "system",
        event: "approval_requested",
        details: {
          approvalId: approval.id,
          tool: approval.tool,
          riskLevel: approval.riskLevel,
          channelType: approval.channelType,
          sessionId: approval.sessionId,
          explanation: approval.explanation,
          preview: approval.preview,
          expiresAt: approval.expiresAt.toISOString()
        }
      });
    }

    return new Promise((resolve) => {
      this.waiters.set(approval.id, resolve);
      const timer = setTimeout(() => {
        this.expireApproval(approval.id);
      }, timeoutMs);
      this.timers.set(approval.id, timer);
    });
  }

  handleDecision(id: string, decision: ApprovalDecision): boolean {
    return this.finalizeDecision(id, decision.approved ? "approved" : "rejected", decision);
  }

  list({ status }: { status?: ApprovalStatus | "all" } = {}): PendingApproval[] {
    const approvals = Array.from(this.approvals.values());
    const filtered = status && status !== "all"
      ? approvals.filter((approval) => approval.status === status)
      : approvals;

    return filtered.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  get(id: string): PendingApproval | undefined {
    return this.approvals.get(id);
  }

  private expireApproval(id: string) {
    this.finalizeDecision(id, "expired", { approved: false });
  }

  private finalizeDecision(
    id: string,
    status: ApprovalStatus,
    decision: ApprovalDecision
  ): boolean {
    const approval = this.approvals.get(id);
    if (!approval || approval.status !== "pending") {
      return false;
    }

    const decidedAt = this.clock();
    const updated: PendingApproval = {
      ...approval,
      status,
      decidedAt,
      decidedBy: decision.decidedBy,
      decidedVia: decision.decidedVia
    };

    this.approvals.set(id, updated);
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
    }
    this.timers.delete(id);
    this.scheduleCleanup(id);

    const result: ApprovalResult = {
      approved: status === "approved",
      status,
      approval: updated
    };

    const waiter = this.waiters.get(id);
    if (waiter) {
      waiter(result);
      this.waiters.delete(id);
    }

    this.emit("approval:decided", updated);
    if (this.auditLogger) {
      void this.auditLogger.log({
        level: "security",
        category: "system",
        event: status === "expired" ? "approval_expired" : "approval_decided",
        details: {
          approvalId: updated.id,
          tool: updated.tool,
          riskLevel: updated.riskLevel,
          status: updated.status,
          decidedBy: updated.decidedBy,
          decidedVia: updated.decidedVia
        }
      });
    }

    return true;
  }

  private scheduleCleanup(id: string) {
    if (this.retentionMs <= 0) {
      return;
    }
    const existing = this.cleanupTimers.get(id);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.cleanupApproval(id);
    }, this.retentionMs);
    this.cleanupTimers.set(id, timer);
  }

  private cleanupApproval(id: string) {
    const approval = this.approvals.get(id);
    if (!approval || approval.status === "pending") {
      return;
    }
    this.approvals.delete(id);
    const cleanupTimer = this.cleanupTimers.get(id);
    if (cleanupTimer) {
      clearTimeout(cleanupTimer);
    }
    this.cleanupTimers.delete(id);
  }
}
