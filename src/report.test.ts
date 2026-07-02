import { describe, it, expect } from "vitest";
import { formatText, formatJson, formatGitHub } from "./report.js";
import type { FileScanResult } from "./types.js";

const comment = (overrides: Partial<FileScanResult["comments"][number]> = {}): FileScanResult["comments"][number] => ({
  kind: "line",
  text: "// hi",
  start: 0,
  end: 5,
  line: 1,
  column: 1,
  endLine: 1,
  endColumn: 6,
  ...overrides,
});

const oneFile: FileScanResult[] = [
  {
    file: "a.ts",
    comments: [
      comment(),
      comment({ kind: "block", text: "/* yo */", start: 10, end: 18, line: 2, column: 1, endLine: 2, endColumn: 9 }),
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
      {
        file: "a.ts",
        comments: [comment({ kind: "block", text: "/**\n * doc\n */", start: 0, end: 13, endLine: 3, endColumn: 4 })],
      },
    ];

    expect(formatText(results)).toContain("a.ts:1:1 [block] /** * doc */");
  });

  it("marks directive comments with the directive name", () => {
    const results: FileScanResult[] = [
      { file: "a.ts", comments: [comment({ text: "// @ts-ignore", end: 13, endColumn: 14, directive: "@ts-ignore" })] },
    ];

    expect(formatText(results)).toContain("a.ts:1:1 [line] [@ts-ignore] // @ts-ignore");
  });

  it("omits files that have no comments", () => {
    const results: FileScanResult[] = [
      { file: "empty.ts", comments: [] },
      { file: "a.ts", comments: [comment()] },
    ];

    const output = formatText(results);

    expect(output).not.toContain("empty.ts");
    expect(output).toContain("1 comment across 1 file");
  });

  it("uses singular wording for a single comment in a single file", () => {
    const results: FileScanResult[] = [{ file: "a.ts", comments: [comment()] }];

    expect(formatText(results)).toContain("1 comment across 1 file");
  });

  it("returns a not-found message when there are no comments", () => {
    expect(formatText([{ file: "a.ts", comments: [] }])).toBe("No comments found.");
  });
});

describe("formatJson", () => {
  it("produces JSON with a summary and per-file comments", () => {
    expect(JSON.parse(formatJson(oneFile))).toEqual({
      summary: { files: 1, comments: 2, directives: 0 },
      files: [
        {
          file: "a.ts",
          comments: [
            { kind: "line", text: "// hi", start: 0, end: 5, line: 1, column: 1, endLine: 1, endColumn: 6 },
            { kind: "block", text: "/* yo */", start: 10, end: 18, line: 2, column: 1, endLine: 2, endColumn: 9 },
          ],
        },
      ],
    });
  });

  it("counts directives in the summary", () => {
    const results: FileScanResult[] = [
      {
        file: "a.ts",
        comments: [comment(), comment({ text: "// @ts-ignore", directive: "@ts-ignore" })],
      },
    ];

    const parsed = JSON.parse(formatJson(results)) as { summary: { directives: number } };

    expect(parsed.summary.directives).toBe(1);
  });

  it("excludes files that have no comments", () => {
    const results: FileScanResult[] = [
      { file: "empty.ts", comments: [] },
      { file: "a.ts", comments: [comment()] },
    ];

    const parsed = JSON.parse(formatJson(results)) as {
      summary: { files: number; comments: number };
      files: FileScanResult[];
    };

    expect(parsed.summary).toMatchObject({ files: 1, comments: 1 });
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]?.file).toBe("a.ts");
  });
});

describe("formatGitHub", () => {
  it("emits a notice workflow command per comment plus a summary", () => {
    const output = formatGitHub([{ file: "src/a.ts", comments: [comment()] }]);

    expect(output).toBe(
      [
        "::notice file=src/a.ts,line=1,endLine=1,col=1,endColumn=6,title=line comment::// hi",
        "",
        "1 comment across 1 file",
      ].join("\n"),
    );
  });

  it("includes the directive name in the annotation title", () => {
    const output = formatGitHub([
      { file: "a.ts", comments: [comment({ text: "// @ts-ignore", directive: "@ts-ignore" })] },
    ]);

    expect(output).toContain("title=line comment (@ts-ignore)::");
  });

  it("escapes newlines and percent signs in the message", () => {
    const output = formatGitHub([
      {
        file: "a.ts",
        comments: [comment({ kind: "block", text: "/* 50%\ndone */", endLine: 2, endColumn: 8 })],
      },
    ]);

    expect(output).toContain("::/* 50%25%0Adone */");
  });

  it("omits column properties for multi-line comments", () => {
    const output = formatGitHub([
      { file: "a.ts", comments: [comment({ kind: "block", text: "/*\n*/", endLine: 2, endColumn: 3 })] },
    ]);

    expect(output).toContain("file=a.ts,line=1,endLine=2,title=");
    expect(output).not.toContain("col=");
  });

  it("escapes commas and colons in property values", () => {
    const output = formatGitHub([{ file: "we,ird:name.ts", comments: [comment()] }]);

    expect(output).toContain("file=we%2Cird%3Aname.ts,");
  });

  it("returns a plain message when there is nothing to report", () => {
    expect(formatGitHub([{ file: "a.ts", comments: [] }])).toBe("No comments found.");
  });
});
