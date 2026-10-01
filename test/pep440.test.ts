import { describe, expect, it } from "vitest";
import { compareVersions, parseVersion, satisfies } from "../src/core/pep440.js";

describe("pep440", () => {
  it("orders pre-releases before the release", () => {
    const a = parseVersion("1.0.0a1")!;
    const b = parseVersion("1.0.0")!;
    expect(compareVersions(a, b)).toBeLessThan(0);
  });

  it("matches the supported range", () => {
    expect(satisfies("1.0.0", ">=1.0.0 <2.0.0")).toBe(true);
    expect(satisfies("1.4.2", ">=1.0.0 <2.0.0")).toBe(true);
    expect(satisfies("0.3.1", ">=1.0.0 <2.0.0")).toBe(false);
    expect(satisfies("2.0.0", ">=1.0.0 <2.0.0")).toBe(false);
  });

  it("does not let a 2.0 pre-release into <2.0.0", () => {
    expect(satisfies("2.0.0a1", ">=1.0.0 <2.0.0")).toBe(false);
  });

  it("rejects garbage", () => {
    expect(parseVersion("not-a-version")).toBeUndefined();
    expect(satisfies("1.0.0", "???")).toBe(false);
  });

  it("supports compatible release", () => {
    expect(satisfies("1.4.9", "~=1.4")).toBe(true);
    expect(satisfies("2.0.0", "~=1.4")).toBe(false);
  });
});
