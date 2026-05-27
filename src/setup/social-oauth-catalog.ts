/**
 * Static catalog of the seven OAuth platforms (+ TikTok manual token) exposed
 * by the onboarding wizard.
 *
 * Issue #1162 — Wizard: unified social OAuth step.
 *
 * The catalog is consumed by the wizard UI to render Connect/Disconnect rows
 * with consistent metadata. OAuth flows themselves continue to live in
 * `src/api/admin.ts` (e.g. `/api/admin/pinterest/oauth/authorize`); the wizard
 * just renders status and points users at the existing routes.
 */

export type SocialPlatformId =
  | "meta"
  | "linkedin"
  | "youtube"
  | "pinterest"
  | "reddit"
  | "x"
  | "tiktok";

export interface SocialPlatformDescriptor {
  id: SocialPlatformId;
  label: string;
  description: string;
  /**
   * Either `"oauth"` (full OAuth round-trip) or `"manual_token"` (user pastes
   * a token from the platform's developer portal).
   */
  authMode: "oauth" | "manual_token";
  /**
   * Relative admin route that starts the OAuth flow.  `null` for manual-token
   * platforms.
   */
  authorizeRoute: string | null;
  /** Documentation link with platform-specific app-creation instructions. */
  docsUrl: string;
}

export const SOCIAL_PLATFORMS: SocialPlatformDescriptor[] = [
  {
    id: "meta",
    label: "Meta (Facebook & Instagram)",
    description: "Publish to Facebook Pages and Instagram Business accounts.",
    authMode: "oauth",
    authorizeRoute: "/api/admin/meta/oauth/authorize",
    docsUrl: "https://developers.facebook.com/docs/facebook-login/overview",
  },
  {
    id: "linkedin",
    label: "LinkedIn",
    description: "Share posts as your personal profile or a company page.",
    authMode: "oauth",
    authorizeRoute: "/api/admin/linkedin/oauth/authorize",
    docsUrl:
      "https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow",
  },
  {
    id: "youtube",
    label: "YouTube",
    description: "Upload videos and manage your channel from OpenZigs.",
    authMode: "oauth",
    authorizeRoute: "/api/admin/youtube/oauth/authorize",
    docsUrl: "https://developers.google.com/youtube/v3/guides/authentication",
  },
  {
    id: "pinterest",
    label: "Pinterest",
    description: "Publish pins and analyze board performance.",
    authMode: "oauth",
    authorizeRoute: "/api/admin/pinterest/oauth/authorize",
    docsUrl:
      "https://developers.pinterest.com/docs/getting-started/authentication/",
  },
  {
    id: "reddit",
    label: "Reddit",
    description: "Post to subreddits and monitor comments.",
    authMode: "oauth",
    authorizeRoute: "/api/admin/reddit/oauth/authorize",
    docsUrl: "https://github.com/reddit-archive/reddit/wiki/OAuth2",
  },
  {
    id: "x",
    label: "X (Twitter)",
    description: "Publish tweets and threads.",
    authMode: "oauth",
    authorizeRoute: "/api/admin/x/oauth/authorize",
    docsUrl: "https://developer.x.com/en/docs/authentication/oauth-2-0",
  },
  {
    id: "tiktok",
    label: "TikTok",
    description:
      "Paste an access token from the TikTok developer portal. Full OAuth coming in a future release.",
    authMode: "manual_token",
    authorizeRoute: null,
    docsUrl:
      "https://developers.tiktok.com/doc/oauth-user-access-token-management/",
  },
];

export function findPlatform(id: string): SocialPlatformDescriptor | undefined {
  return SOCIAL_PLATFORMS.find((p) => p.id === id);
}
