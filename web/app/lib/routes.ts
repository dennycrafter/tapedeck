/**
 * Pages that render without the app frame and never load the library:
 * the password screen, setup, the test-audio page and the offline fallback.
 */
export const BARE_PREFIXES = ["/login", "/setup", "/test-audio", "/~offline"];

export function isBarePath(pathname: string | null): boolean {
  return pathname != null && BARE_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}
