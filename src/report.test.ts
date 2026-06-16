import { describe, it, expect } from "vitest";
import { formatText, formatJson, formatStripSummary } from "./report.js";
import type { FileScanResult, StripResult } from "./types.js";

const oneFile: FileScanResult[] = [
  {
    file: "a.ts",
    comments: [
      { kind: "line", text: "// hi", start: 0, end: 5, line: 1, column: 1 },
      { kind: "block", text: "/* yo */", start: 10, end: 18, line: 2, column: 1 },
    ],
  },
];

describe("formatText", () => {
  it("renders each comment as file:line:column [kind] preview", () => {
    expect(formatText(oneFile)).toBe(
      ["a.ts:1:1 [line] // hi", "a.ts:2:1 [block] /* yo */", "", "2 comments across 1 file"].join("\n"),
    );
  });

  it("collapses a multi-line block comment into a single-line preview", () => {
    const results: FileScanResult[] = [
      { file: "a.ts", comments: [{ kind: "block", text: "/**\n * doc\n */", start: 0, end: 13, line: 1, column: 1 }] },
    ];

    expect(formatText(results)).toContain("a.ts:1:1 [block] /** * doc */");
  });

  it("omits files that have no comments", () => {
    const results: FileScanResult[] = [
      { file: "empty.ts", comments: [] },
      { file: "a.ts", comments: [{ kind: "line", text: "// hi", start: 0, end: 5, line: 1, column: 1 }] },
    ];

    const output = formatText(results);

    expect(output).not.toContain("empty.ts");
    expect(output).toContain("1 comment across 1 file");
  });

  it("uses singular wording for a single comment in a single file", () => {
    const results: FileScanResult[] = [
      { file: "a.ts", comments: [{ kind: "line", text: "// hi", start: 0, end: 5, line: 1, column: 1 }] },
    ];

    expect(formatText(results)).toContain("1 comment across 1 file");
  });

  it("returns a not-found message when there are no comments", () => {
    expect(formatText([{ file: "a.ts", comments: [] }])).toBe("No comments found.");
  });
});

describe("formatJson", () => {
  it("produces JSON with a summary and per-file comments", () => {
    expect(JSON.parse(formatJson(oneFile))).toEqual({
      summary: { files: 1, comments: 2 },
      files: [
        {
          file: "a.ts",
          comments: [
            { kind: "line", text: "// hi", start: 0, end: 5, line: 1, column: 1 },
            { kind: "block", text: "/* yo */", start: 10, end: 18, line: 2, column: 1 },
          ],
        },
      ],
    });
  });

  it("excludes files that have no comments", () => {
    const results: FileScanResult[] = [
      { file: "empty.ts", comments: [] },
      { file: "a.ts", comments: [{ kind: "line", text: "// hi", start: 0, end: 5, line: 1, column: 1 }] },
    ];

    const parsed = JSON.parse(formatJson(results)) as {
      summary: { files: number; comments: number };
      files: FileScanResult[];
    };

    expect(parsed.summary).toEqual({ files: 1, comments: 1 });
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]?.file).toBe("a.ts");
  });
});

describe("formatStripSummary", () => {
  it("lists each changed file and totals the comments removed", () => {
    const results: StripResult[] = [
      { file: "a.ts", output: "", removed: 2, changed: true },
      { file: "b.ts", output: "", removed: 1, changed: true },
      { file: "skipped.ts", output: "", removed: 0, changed: false },
    ];

    expect(formatStripSummary(results)).toBe(
      ["a.ts: 2 comments removed", "b.ts: 1 comment removed", "", "3 comments removed across 2 files"].join("\n"),
    );
  });

  it("returns a nothing-to-remove message when no file changed", () => {
    expect(formatStripSummary([{ file: "a.ts", output: "", removed: 0, changed: false }])).toBe(
      "No comments to remove.",
    );
  });
});
