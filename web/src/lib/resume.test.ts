import { describe, it, expect } from "vitest";
import { resumeErrorText } from "./resume";

describe("resumeErrorText", () => {
  it("prefixes an Error's message with 'Fehler: '", () => {
    expect(resumeErrorText(new Error("server unreachable"))).toBe("Fehler: server unreachable");
  });

  it("stringifies a non-Error throw the same way", () => {
    expect(resumeErrorText("boom")).toBe("Fehler: boom");
  });
});
