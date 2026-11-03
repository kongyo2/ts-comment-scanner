import { describe, it, expect, vi } from "vitest";
import { analyzeSource, type SourceAnalysis } from "./scanner.js";
import { removeComments } from "./remove.js";
import type { Comment } from "./types.js";

// The post-removal verification cannot fail through the public API (that is
// the point of it), so the re-scan is tampered with to prove the guard holds.
vi.mock("./scanner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./scanner.js")>();
  return { ...actual, analyzeSource: vi.fn(actual.analyzeSource) };
});

const { analyzeSource: realAnalyze } = await vi.importActual<typeof import("./scanner.js")>("./scanner.js");

/** Analyses the source for real, then hands the result to `tamper`. */
function tampered(tamper: (analysis: SourceAnalysis) => SourceAnalysis): typeof analyzeSource {
  return (code, options) => tamper(realAnalyze(code, options));
}

/** The analysis with the rendering of one JSX stretch altered. */
const alterSegment = (index: number) => (analysis: SourceAnalysis) => ({
  ...analysis,
  jsx: {
    ...analysis.jsx,
    segments: analysis.jsx.segments.map((segment, at) => (at === index ? `${segment}!` : segment)),
  },
});

describe("removeComments result verification", () => {
  it("throws instead of returning output whose comments do not match the kept set", () => {
    const ghost: Comment = {
      kind: "line",
      text: "// ghost",
      start: 0,
      end: 8,
      line: 1,
      column: 1,
      endLine: 1,
      endColumn: 9,
    };
    vi.mocked(analyzeSource)
      .mockImplementationOnce(realAnalyze)
      .mockImplementationOnce(tampered((analysis) => ({ ...analysis, comments: [ghost] })));

    expect(() => removeComments("// gone\nconst x = 1;\n")).toThrow(/unexpected result/);
  });

  it("throws when a surviving comment's text does not match the kept one", () => {
    vi.mocked(analyzeSource)
      .mockImplementationOnce(realAnalyze)
      .mockImplementationOnce(
        tampered((analysis) => ({
          ...analysis,
          comments: analysis.comments.map((comment) => ({ ...comment, text: "// tampered" })),
        })),
      );

    expect(() => removeComments("// @ts-nocheck\n// gone\nconst x = 1;\n")).toThrow(/unexpected result/);
  });

  it("throws when a directive changes with no removal before it to re-protect", () => {
    // Cannot happen through the public API: a surviving comment's placement
    // only changes when a removal preceded it. Tampering with the re-scan
    // proves the guard fails closed instead of looping or returning output
    // with altered semantics.
    vi.mocked(analyzeSource)
      .mockImplementationOnce(realAnalyze)
      .mockImplementationOnce(
        tampered((analysis) => ({
          ...analysis,
          comments: analysis.comments.map((comment) => ({ ...comment, directive: "@ts-check" })),
        })),
      );

    expect(() => removeComments("// @ts-nocheck\n// gone\nconst x = 1;\n")).toThrow(/unexpected result/);
  });
});

describe("removeComments import group verification", () => {
  it("throws when the output's import and export declarations are laid out differently", () => {
    vi.mocked(analyzeSource)
      .mockImplementationOnce(realAnalyze)
      .mockImplementationOnce(tampered((analysis) => ({ ...analysis, importGroups: [] })));

    expect(() => removeComments('import { b } from "./b";\n// note\nimport { a } from "./a";\n')).toThrow(
      /unexpected result/,
    );
  });

  it("throws when the output joins import groups where no removal holds the gap", () => {
    // A blank line holds these groups apart, which no removal touches.
    vi.mocked(analyzeSource)
      .mockImplementationOnce(realAnalyze)
      .mockImplementationOnce(
        tampered((analysis) => ({
          ...analysis,
          importGroups: analysis.importGroups.map((gap) => ({ ...gap, splits: [] })),
        })),
      );

    expect(() => removeComments('import { b } from "./b";\n\nimport { a } from "./a";\n// gone\n')).toThrow(
      /unexpected result/,
    );
  });

  it("throws when the output joins Biome's chunks where no removal is a detached comment of the gap", () => {
    // The legal comment that starts the chunk stays, which no removal touches.
    vi.mocked(analyzeSource)
      .mockImplementationOnce(realAnalyze)
      .mockImplementationOnce(
        tampered((analysis) => ({
          ...analysis,
          importGroups: analysis.importGroups.map((gap) => ({
            ...gap,
            splits: gap.splits.filter((sorter) => sorter !== "biome"),
          })),
        })),
      );

    expect(() =>
      removeComments('import { b } from "./b";\n/*! kept */\n\nimport { a } from "./a";\n// gone\n'),
    ).toThrow(/unexpected result/);
  });
});

describe("removeComments JSX rendering verification", () => {
  it("throws when the output's JSX children are laid out differently", () => {
    vi.mocked(analyzeSource)
      .mockImplementationOnce(realAnalyze)
      .mockImplementationOnce(
        tampered((analysis) => ({ ...analysis, jsx: { ...analysis.jsx, segments: [...analysis.jsx.segments, "[]"] } })),
      );

    expect(() => removeComments("const e = <p>{/* gone */}</p>;\n", { jsx: true })).toThrow(/unexpected result/);
  });

  it("throws when JSX renders differently where no container could be to blame", () => {
    // The only container sits between tags, where dropping it cannot change
    // the rendering, so a difference there leaves nothing to put back.
    vi.mocked(analyzeSource)
      .mockImplementationOnce(realAnalyze)
      .mockImplementationOnce(tampered(alterSegment(1)));

    expect(() =>
      removeComments("const e = (\n  <div>\n    <b />\n    {/* gone */}\n    <i />\n  </div>\n);\n", { jsx: true }),
    ).toThrow(/unexpected result/);
  });

  it("throws when keeping the braces still does not restore the rendering", () => {
    vi.mocked(analyzeSource)
      .mockImplementationOnce(realAnalyze)
      .mockImplementation(tampered(alterSegment(0)));
    try {
      expect(() => removeComments("const e = <p>Hello {/* gone */} world</p>;\n", { jsx: true })).toThrow(
        /unexpected result/,
      );
    } finally {
      vi.mocked(analyzeSource).mockImplementation(realAnalyze);
    }
  });
});
