import { describe, it, expect } from "vitest";
import { LINE_BREAK, LINE_TERMINATOR, isBlank, lastLine, lineStartOffsets, splitLines } from "./lines.js";

describe("line helpers", () => {
  it("recognise every ECMAScript line terminator", () => {
    for (const terminator of ["\n", "\r", "\u2028", "\u2029"]) {
      expect(LINE_TERMINATOR.test(terminator)).toBe(true);
      expect(LINE_BREAK.test(terminator)).toBe(true);
    }
    expect(LINE_TERMINATOR.test("\t")).toBe(false);
  });

  it("splits CRLF as one break and every other terminator on its own", () => {
    expect(splitLines("a\r\nb\rc\nd\u2028e\u2029f")).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("returns the literal last line", () => {
    expect(lastLine("/* a\n * b */")).toBe(" * b */");
    expect(lastLine("no break")).toBe("no break");
  });

  it("treats whitespace, including a byte-order mark, as blank", () => {
    expect(isBlank("")).toBe(true);
    expect(isBlank(" \t\uFEFF")).toBe(true);
    expect(isBlank(" x ")).toBe(false);
  });

  it("numbers line starts the way the scanner does", () => {
    expect(lineStartOffsets("ab\ncd\r\nef\rg\u2028h\u2029")).toEqual([0, 3, 7, 10, 12, 14]);
    expect(lineStartOffsets("")).toEqual([0]);
  });
});
