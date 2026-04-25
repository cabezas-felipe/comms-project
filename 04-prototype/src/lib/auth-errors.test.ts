import { describe, it, expect } from "vitest";
import { isRateLimitError } from "./auth-errors";

describe("isRateLimitError", () => {
  it("returns false for null", () => expect(isRateLimitError(null)).toBe(false));
  it("returns false for undefined", () => expect(isRateLimitError(undefined)).toBe(false));
  it("returns false for a plain string", () => expect(isRateLimitError("oops")).toBe(false));
  it("returns false for a number", () => expect(isRateLimitError(500)).toBe(false));

  it("returns true when status is 429", () => {
    expect(isRateLimitError({ status: 429 })).toBe(true);
  });

  it("returns false for non-429 status codes", () => {
    expect(isRateLimitError({ status: 400 })).toBe(false);
    expect(isRateLimitError({ status: 500 })).toBe(false);
    expect(isRateLimitError({ status: 401 })).toBe(false);
  });

  it("returns true for 'rate limit exceeded' message (case-insensitive)", () => {
    expect(isRateLimitError({ message: "Email rate limit exceeded" })).toBe(true);
    expect(isRateLimitError({ message: "email rate limit exceeded" })).toBe(true);
    expect(isRateLimitError({ message: "EMAIL RATE LIMIT EXCEEDED" })).toBe(true);
  });

  it("returns true for Supabase over_email_send_rate_limit code in message", () => {
    expect(isRateLimitError({ message: "over_email_send_rate_limit" })).toBe(true);
  });

  it("returns true for 'too many requests' message", () => {
    expect(isRateLimitError({ message: "too many requests" })).toBe(true);
    expect(isRateLimitError({ message: "Too Many Requests" })).toBe(true);
  });

  it("returns false for unrelated error messages", () => {
    expect(isRateLimitError({ message: "User not found" })).toBe(false);
    expect(isRateLimitError({ message: "Invalid login credentials" })).toBe(false);
    expect(isRateLimitError({ message: "Email not confirmed" })).toBe(false);
  });

  it("returns true based on status even when message is absent", () => {
    expect(isRateLimitError({ status: 429, code: "some_code" })).toBe(true);
  });

  it("returns true based on message even when status is absent", () => {
    expect(isRateLimitError({ message: "rate limit reached" })).toBe(true);
  });
});
