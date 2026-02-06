import { Role } from "./auth/auth.js";

declare global {
  namespace Express {
    interface Request {
      userRole?: Role;
    }
  }
}

export {};
