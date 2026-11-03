import { describe, it, expect } from "vitest";
import { astGrepReach, isFileWidePosition, rowStartOffsets } from "./astgrep.js";
import { analyzeSource } from "./scanner.js";

describe("isFileWidePosition", () => {
  const at = (text: string, comment: string): boolean => {
    const start = text.indexOf(comment);
    return isFileWidePosition(text, start, start + comment.length);
  };

  it("needs the comment to open the first row, with the next node two or more rows down", () => {
    expect(at("// a\n\nfoo();\n", "// a")).toBe(true);
    expect(at("  // a\n\nfoo();\n", "// a")).toBe(true);
    expect(at("// a", "// a")).toBe(true);
    expect(at("// a\nfoo();\n", "// a")).toBe(false);
    expect(at("// a\n// b\n\nfoo();\n", "// a")).toBe(false);
    expect(at("foo(); // a\n\nbar();\n", "// a")).toBe(false);
    expect(at("\n// a\n\nfoo();\n", "// a")).toBe(false);
  });

  it("counts rows by line feeds, as tree-sitter does", () => {
    expect(at("/* a\n\n */\nfoo();\n", "/* a\n\n */")).toBe(true);
    expect(at("// a\r\n\r\nfoo();\r\n", "// a")).toBe(true);
    // A lone CR or a line separator starts no new row for tree-sitter.
    expect(at("\r// a\n\nfoo();\n", "// a")).toBe(true);
    expect(at("// a\u2028\u2028foo();\n", "// a")).toBe(false);
  });

  it("takes U+200B and U+2060 for whitespace, as tree-sitter does", () => {
    expect(at("\u200B// a\n\nfoo();\n", "// a")).toBe(true);
    expect(at("\uFEFF// a\n\nfoo();\n", "// a")).toBe(true);
    expect(at("// a\n\u2060\nfoo();\n", "// a")).toBe(true);
    expect(at("\u0085// a\n\nfoo();\n", "// a")).toBe(false);
  });
});

describe("rowStartOffsets", () => {
  it("starts a row after each line feed only", () => {
    expect(rowStartOffsets("a\nb\r\nc\rd\u2028e")).toEqual([0, 2, 5]);
    expect(rowStartOffsets("")).toEqual([0]);
  });
});

describe("astGrepReach", () => {
  /** The reach of the comment, with the units it holds among the given ones (named by their text). */
  const reach = (source: string, comment: string, units: readonly string[]) => {
    const analysis = analyzeSource(source);
    const found = analysis.comments.find((candidate) => candidate.text === comment);
    if (found === undefined) throw new Error("no such comment");
    const result = astGrepReach(
      source,
      rowStartOffsets(source),
      found,
      analysis.preceding.get(found) ?? { tokenEnd: 0 },
    );
    const spans = units.map((text) => {
      const start = source.indexOf(text);
      return { text, start, end: start + text.length };
    });
    return {
      held: spans.filter((span) => result.holds(span)).map((span) => span.text),
      nextRow: result.nextRow === undefined ? undefined : source.slice(result.nextRow.start, result.nextRow.end),
    };
  };

  it("covers the next row from a comment standing alone", () => {
    const source = "x();\n// ast-grep-ignore\nfoo(); // a\nbar();\n";

    expect(reach(source, "// ast-grep-ignore", ["// a"])).toEqual({ held: [], nextRow: "\nfoo(); // a\n" });
  });

  it("covers nothing below a comment trailing a node that starts on its row", () => {
    const source = "foo(); /* a */ // ast-grep-ignore\n/* b */\nbar();\n";

    expect(reach(source, "// ast-grep-ignore", ["/* a */", "/* b */"])).toEqual({
      held: ["/* a */"],
      nextRow: undefined,
    });
  });

  it("also covers the next row below a node that starts rows up, as releases up to 0.43 read it", () => {
    const source = "foo(\n  1,\n); // ast-grep-ignore\n// a\nbar();\n";

    expect(reach(source, "// ast-grep-ignore", ["// a"]).nextRow).toBe("\n// a\n");
  });

  it("holds the comments after the last token in front of it, and those in front that break rows", () => {
    const source = "foo(/* in */ a, /* b\n */ c); /* d */ // ast-grep-ignore\n";

    expect(reach(source, "// ast-grep-ignore", ["/* in */", "/* b\n */", "/* d */"]).held).toEqual([
      "/* b\n */",
      "/* d */",
    ]);
  });

  it("holds what breaks rows on the row the node in front of it starts on", () => {
    const source = "hit(/* a\n */ 1); /* b\n */ /* ast-grep-ignore */\n";

    expect(reach(source, "/* ast-grep-ignore */", ["/* a\n */"]).held).toEqual(["/* a\n */"]);
  });

  it("covers nothing below a comment spanning three rows, whose second row is its own", () => {
    const source = "x();\n/* ast-grep-ignore\n\n */\n// a\nfoo();\n";

    expect(reach(source, "/* ast-grep-ignore\n\n */", ["// a"])).toEqual({ held: [], nextRow: undefined });
  });

  it("holds what follows it on the row it ends on when it opens the file", () => {
    const source = "/* ast-grep-ignore\n */ /* a */\n/* b */\n\nfoo();\n";

    expect(reach(source, "/* ast-grep-ignore\n */", ["/* a */", "/* b */"]).held).toEqual(["/* a */"]);
  });
});
