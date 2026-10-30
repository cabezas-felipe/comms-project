import { describe, expect, it } from "vitest";
import { classifyEmailValidationFailure, isValidEmailForLanding } from "@/lib/email-validation";

describe("isValidEmailForLanding", () => {
  it.each([
    "name@domain.com",
    "name.surname@domain.co",
    "name+tag@sub.domain.com",
  ])("accepts valid address: %s", (email) => {
    expect(isValidEmailForLanding(email)).toBe(true);
  });

  it.each([
    ["", "empty string"],
    ["123", "no @"],
    ["123@456", "domain has no dot"],
    ["@domain.com", "missing local part"],
    ["name@", "missing domain"],
    ["name@domain", "domain missing dot"],
    ["name@.domain.com", "domain starts with dot"],
    ["name@domain.", "domain ends with dot"],
    ["name@do..main.com", "consecutive dots in domain"],
    ["na me@domain.com", "space in local part"],
    ["name@do main.com", "space in domain"],
    ["a@b@c.com", "multiple @ signs"],
    ["a@@b.com", "consecutive @ signs"],
  ] as [string, string][])("rejects invalid address — %s (%s)", (email) => {
    expect(isValidEmailForLanding(email)).toBe(false);
  });
});

describe("classifyEmailValidationFailure", () => {
  it.each([
    ["", "empty"],
    ["123", "missing_at"],
    ["@domain.com", "missing_at"],
    ["123@456", "invalid_domain"],
    ["name@", "invalid_domain"],
    ["name@domain", "invalid_domain"],
    ["name@.domain.com", "invalid_domain"],
    ["name@domain.", "invalid_domain"],
    ["name@do..main.com", "invalid_domain"],
    ["na me@domain.com", "invalid_domain"],
    ["a@b@c.com", "invalid_domain"],
    ["a@@b.com", "invalid_domain"],
  ] as [string, string][])("classifies %s as %s", (email, expected) => {
    expect(classifyEmailValidationFailure(email)).toBe(expected);
  });
});
