// In-memory rate limiter for /api/login (SPEC 8.1): 5 wrong attempts within
// 10 minutes from one IP, then 429 for 10 minutes. The SPEC explicitly allows
// an in-memory counter; Tapedeck is single-user, so a module-scoped Map is
// enough. State resets on restart, which can only shorten a block, never
// lower the 5-tries-per-10-minutes bar while the process is up.

const MAX_WRONG_ATTEMPTS = 5;
const WRONG_WINDOW_MS = 10 * 60 * 1000;
const BLOCK_MS = 10 * 60 * 1000;

interface IpRecord {
  wrongAt: number[];
  blockedUntil: number;
}

const records = new Map<string, IpRecord>();

function prune(record: IpRecord, now: number): void {
  if (record.blockedUntil <= now) record.blockedUntil = 0;
  record.wrongAt = record.wrongAt.filter((t) => now - t < WRONG_WINDOW_MS);
}

/** True while this IP is serving its 10-minute block. */
export function isRateLimited(ip: string, now: number = Date.now()): boolean {
  const record = records.get(ip);
  if (!record) return false;
  prune(record, now);
  return record.blockedUntil > now;
}

/**
 * Count a wrong password attempt. The 5th wrong attempt within the window
 * arms the block; further attempts during a block do not extend it.
 */
export function recordWrongAttempt(ip: string, now: number = Date.now()): void {
  let record = records.get(ip);
  if (!record) {
    record = { wrongAt: [], blockedUntil: 0 };
    records.set(ip, record);
  }
  prune(record, now);
  if (record.blockedUntil > now) return;
  record.wrongAt.push(now);
  if (record.wrongAt.length >= MAX_WRONG_ATTEMPTS) {
    record.blockedUntil = now + BLOCK_MS;
    record.wrongAt = [];
  }
}

/** Successful login: the IP starts from a clean slate. */
export function clearWrongAttempts(ip: string): void {
  records.delete(ip);
}

/** Test-only: wipe all rate limiter state between tests. */
export function resetLoginRateLimiter(): void {
  records.clear();
}
