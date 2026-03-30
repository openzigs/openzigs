import { logger } from "../logging/logger.js";
import type { RAGHealthStatus, SentinelConfig } from "./sentinel-state.js";
import type { SentinelAlert } from "./task-reviewer.js";

/** Minimal interface for the knowledge service dependency. */
export interface KnowledgeServiceLike {
  getStats(): Promise<{
    totalDocuments: number;
    totalChunks: number;
    pendingDocuments: number;
    lastIndexedAt: string | null;
  }>;
  get isRunning(): boolean;
  restart(): Promise<void>;
}

/**
 * Checks the health of the RAG knowledge base subsystem.
 *
 * Returns a status object with metrics and any alerts to fire.
 * Gracefully degrades when the knowledge service is not configured.
 */
export class RAGHealthCheck {
  private knowledgeService: KnowledgeServiceLike | null;
  private ragQueueDepthThreshold: number;
  private clock: () => Date;

  constructor(opts: {
    knowledgeService?: KnowledgeServiceLike | null;
    config: Pick<SentinelConfig, "ragQueueDepthThreshold">;
    clock?: () => Date;
  }) {
    this.knowledgeService = opts.knowledgeService ?? null;
    this.ragQueueDepthThreshold = opts.config.ragQueueDepthThreshold;
    this.clock = opts.clock ?? (() => new Date());
  }

  /** Run the RAG health check. Returns status and any alerts. */
  async check(): Promise<{ status: RAGHealthStatus; alerts: SentinelAlert[] }> {
    if (!this.knowledgeService) {
      return {
        status: {
          available: false,
          dbAccessible: false,
          ingestionRunning: false,
          totalDocuments: 0,
          totalChunks: 0,
          pendingDocuments: 0,
          lastIndexedAt: null,
          alerts: [],
        },
        alerts: [],
      };
    }

    const alerts: SentinelAlert[] = [];
    const now = this.clock().toISOString();

    // 1. Try to get stats (tests DB accessibility)
    let stats: Awaited<ReturnType<KnowledgeServiceLike["getStats"]>>;
    try {
      stats = await this.knowledgeService.getStats();
    } catch (err) {
      const msg = `RAG database unreachable: ${err instanceof Error ? err.message : String(err)}`;
      logger.error(`[Sentinel] ${msg}`);
      const alert: SentinelAlert = {
        type: "rag-db-unreachable",
        priority: "critical",
        message: msg,
        data: {},
        timestamp: now,
      };
      alerts.push(alert);
      return {
        status: {
          available: false,
          dbAccessible: false,
          ingestionRunning: this.knowledgeService.isRunning,
          totalDocuments: 0,
          totalChunks: 0,
          pendingDocuments: 0,
          lastIndexedAt: null,
          alerts: alerts.map((a) => ({ type: a.type, priority: a.priority, message: a.message })),
        },
        alerts,
      };
    }

    // 2. Check ingestion running
    const ingestionRunning = this.knowledgeService.isRunning;
    if (!ingestionRunning) {
      const alert: SentinelAlert = {
        type: "rag-ingestion-down",
        priority: "warning",
        message: "RAG ingestion service is not running. Attempting restart.",
        data: {},
        timestamp: now,
      };
      alerts.push(alert);

      // Attempt restart
      try {
        await this.knowledgeService.restart();
        logger.info("[Sentinel] RAG ingestion service restarted successfully");
      } catch (err) {
        logger.error(`[Sentinel] Failed to restart RAG ingestion: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 3. Check queue depth
    if (stats.pendingDocuments > this.ragQueueDepthThreshold) {
      const alert: SentinelAlert = {
        type: "rag-queue-depth",
        priority: "warning",
        message: `RAG ingestion queue depth (${stats.pendingDocuments}) exceeds threshold (${this.ragQueueDepthThreshold})`,
        data: { pending: stats.pendingDocuments, threshold: this.ragQueueDepthThreshold },
        timestamp: now,
      };
      alerts.push(alert);
    }

    return {
      status: {
        available: true,
        dbAccessible: true,
        ingestionRunning,
        totalDocuments: stats.totalDocuments,
        totalChunks: stats.totalChunks,
        pendingDocuments: stats.pendingDocuments,
        lastIndexedAt: stats.lastIndexedAt,
        alerts: alerts.map((a) => ({ type: a.type, priority: a.priority, message: a.message })),
      },
      alerts,
    };
  }
}
