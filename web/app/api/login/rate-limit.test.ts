// Unit tests for the /api/login rate limiter (SPEC 8.1): 5 wrong attempts
// within 10 minutes from one IP, then 429 for 10 minutes.
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearWrongAttempts,
  isRateLimited,
  recordWrongAttempt,
  resetLoginRateLimiter,
} from "./rate-limit";

const IP = "203.0.113.7";
const MINUTE = 60 * 1000;
const T0 = 1_800_000_000_000;

describe("login rate limiter", () => {
  beforeEach(() => {
    resetLoginRateLimiter();
  });

  it("allows fewer than 5 wrong attempts", () => {
    for (let i = 0; i < 4; i++) recordWrongAttempt(IP, T0 + i);
    expect(isRateLimited(IP, T0 + 4)).toBe(false);
  });

  it("limits after the 5th wrong attempt within 10 minutes", () => {
    for (let i = 0; i < 5; i++) recordWrongAttempt(IP, T0 + i);
    expect(isRateLimited(IP, T0 + 5)).toBe(true);
  });

  it("keeps limiting for 10 minutes, then unblocks", () => {
    // All five attempts in the same millisecond: the block ends exactly
    // 10 minutes after T0.
    for (let i = 0; i < 5; i++) recordWrongAttempt(IP, T0);
    expect(isRateLimited(IP, T0 + 10 * MINUTE - 1)).toBe(true);
    expect(isRateLimited(IP, T0 + 10 * MINUTE + 1)).toBe(false);
  });

  it("does not extend the block with attempts made during it", () => {
    for (let i = 0; i < 5; i++) recordWrongAttempt(IP, T0);
    recordWrongAttempt(IP, T0 + 6 * MINUTE);
    expect(isRateLimited(IP, T0 + 10 * MINUTE + 1)).toBe(false);
  });

  it("forgets wrong attempts older than the 10 minute window", () => {
    for (let i = 0; i < 3; i++) recordWrongAttempt(IP, T0 + i);
    recordWrongAttempt(IP, T0 + 11 * MINUTE);
    recordWrongAttempt(IP, T0 + 11 * MINUTE + 1);
    // The 3 old attempts pruned, only 2 remain: no block.
    expect(isRateLimited(IP, T0 + 11 * MINUTE + 2)).toBe(false);
  });

  it("starts clean after a successful login clears the IP", () => {
    for (let i = 0; i < 4; i++) recordWrongAttempt(IP, T0 + i);
    clearWrongAttempts(IP);
    expect(isRateLimited(IP, T0 + 4)).toBe(false);
  });

  it("tracks IPs separately", () => {
    for (let i = 0; i < 5; i++) recordWrongAttempt(IP, T0 + i);
    expect(isRateLimited("198.51.100.9", T0 + 5)).toBe(false);
    expect(isRateLimited(IP, T0 + 5)).toBe(true);
  });
});
