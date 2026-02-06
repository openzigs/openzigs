/* eslint-disable @typescript-eslint/no-explicit-any */

// Local type declaration for cors — avoids dependency on @types/cors
// which pnpm intermittently fails to install on self-hosted CI runners.
declare module "cors" {
  import type { RequestHandler } from "express";

  interface CorsOptions {
    origin?: any;
    methods?: string | string[];
    allowedHeaders?: string | string[];
    exposedHeaders?: string | string[];
    credentials?: boolean;
    maxAge?: number;
    preflightContinue?: boolean;
    optionsSuccessStatus?: number;
  }

  function cors(options?: CorsOptions): RequestHandler;
  export = cors;
}

// Augment Express Request with custom properties
declare global {
  namespace Express {
    interface Request {
      userRole?: import("./auth/auth.js").Role;
    }
  }
}
