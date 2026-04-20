/**
 * Bounded URL-string sanitisation helpers.
 *
 * Sub-issue #900: The original admin.ts code used
 * `String(prov.baseUrl).replace(/\/+$/, "")` to strip trailing slashes from a
 * user-supplied base URL.  CodeQL flagged this as polynomial-class ReDoS
 * (`js/polynomial-redos`) because `/+$` exhibits superlinear backtracking on
 * pathological inputs, and the input was unbounded so an attacker could
 * supply a multi-MB string and pin the event loop.
 *
 * `capAndTrimTrailingSlashes` is the patched replacement: cap the input
 * length **first**, then strip trailing slashes with a deterministic linear
 * loop.  Exported as a named function so the regression test in
 * `src/security/security-hardening.test.ts` exercises the exact code path
 * used by `src/api/admin.ts` (rather than re-implementing the patched logic
 * inside the test).
 */

/** Hard cap on baseUrl length before trimming. 2048 mirrors common URL limits. */
export const MAX_BASE_URL_LENGTH = 2048;

/**
 * Cap an untrusted string at {@link MAX_BASE_URL_LENGTH} and strip any
 * trailing `/` characters.  Both steps are O(n) on the capped length, which
 * is constant, so the function runs in bounded time regardless of input
 * size.
 *
 * @param input  Untrusted string (typically a user-supplied baseUrl).
 * @returns      The capped, slash-trimmed string.  Always ≤ MAX_BASE_URL_LENGTH.
 */
export function capAndTrimTrailingSlashes(input: unknown): string {
  const capped = String(input).slice(0, MAX_BASE_URL_LENGTH);
  let s = capped;
  while (s.endsWith("/")) {
    s = s.slice(0, -1);
  }
  return s;
}
