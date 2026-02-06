import type { Role } from "./auth/auth.js";

declare module "express-serve-static-core" {
  interface Request {
    userRole?: Role;
  }
}
