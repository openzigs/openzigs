import "express";

declare module "express-serve-static-core" {
  interface Request {
    userRole?: "viewer" | "operator" | "admin";
  }
}
