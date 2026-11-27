import { describe, expect, it } from "vitest";
import { removeComments } from "./remove.js";
import { analyzeSource } from "./scanner.js";

// The linters read two things off the layout of a switch statement that a
// removal used to change:
//
// - no-fallthrough reports an empty `case` that a line stands below, in front
//   of the clause after it, like a case whose statements fall through. A
//   comment line is such a line, so deleting it took the report away, and
//   left a directive that suppressed the report unused.
// - oxlint's default-case takes the last comment from the start of the last
//   clause to the end of the switch for the switch's `no default` comment,
//   so deleting the comments behind one made it that comment.
//
// Checked against ESLint 9.39.5 and 10.15.0 and oxlint 1.94.0 and 1.95.0
// (November 2026). Over 6,000 generated switch statements each of them
// reports the same clauses before and after the removal; over 2,000 of them
// 1.23.0's removal changed what ESLint reports in 38, what oxlint 1.95.0
// reports in 57 and what oxlint 1.94.0 reports in 49.

/** A switch statement around the clauses. */
const inSwitch = (clauses: string): string => `switch (x) {\n${clauses}}\n`;

/** Each gap below an empty clause, as its text and the linters that find a line in it. */
const gaps = (source: string): Array<[string, string[]]> =>
  analyzeSource(source).emptyCases.map((gap) => [source.slice(gap.start, gap.end), gap.apart]);

describe("the gaps below empty switch clauses", () => {
  it("reads the gap between an empty clause and the clause after it", () => {
    expect(gaps(inSwitch("  case 0:\n  // note\n  case 1:\n    b();\n  case 2:\n  default:\n"))).toEqual([
      ["\n  // note\n  ", ["eslint", "oxlint"]],
      ["\n  ", []],
    ]);
  });

  it("reads none below a clause that holds statements, nor below the last clause", () => {
    expect(gaps(inSwitch("  case 0:\n    a();\n  // note\n  case 1:\n  // note\n"))).toEqual([]);
    expect(gaps(inSwitch(""))).toEqual([]);
  });

  it("counts the line breaks inside a comment, and every line break for ESLint", () => {
    expect(gaps(inSwitch("  case 0: /* a\n\n b */ case 1:\n"))).toEqual([[" /* a\n\n b */ ", ["eslint", "oxlint"]]]);
    // oxlint counted line feeds alone up to 1.94.0.
    expect(gaps(inSwitch("  case 0:\r  // note\r  case 1:\n"))).toEqual([["\r  // note\r  ", ["eslint"]]]);
    expect(gaps(inSwitch("  case 0:\r\n\r\n  case 1:\n"))).toEqual([["\r\n\r\n  ", ["eslint", "oxlint"]]]);
  });

  it("lists the gaps of nested switches in document order", () => {
    const source = inSwitch(
      "  case 0:\n    switch (y) {\n      case 5:\n      case 6:\n    }\n  case 1:\n\n  case 2:\n",
    );

    expect(gaps(source)).toEqual([
      ["\n      ", []],
      ["\n\n  ", ["eslint", "oxlint"]],
    ]);
  });
});

describe("removeComments below an empty case", () => {
  it("leaves an empty line in place of the comment line between an empty case and the next clause", () => {
    const result = removeComments(inSwitch("  case 0:\n  // shares the handler below\n  case 1:\n    b();\n"));

    expect(result.code).toBe(inSwitch("  case 0:\n\n  case 1:\n    b();\n"));
    expect(result.removed).toHaveLength(1);
    expect(result.kept).toEqual([]);
  });

  it("leaves one empty line for all the comment lines there", () => {
    expect(removeComments(inSwitch("  case 0:\n  // one\n  // two\n  case 1:\n    b();\n")).code).toBe(
      inSwitch("  case 0:\n\n  case 1:\n    b();\n"),
    );
    expect(removeComments(inSwitch("  case 0: // trailing\n  // note\n  case 1:\n    b();\n")).code).toBe(
      inSwitch("  case 0:\n\n  case 1:\n    b();\n"),
    );
  });

  it("leaves an empty line in place of a comment that spans the lines", () => {
    expect(removeComments(inSwitch("  case 0:\n  /* a\n b */\n  case 1:\n    b();\n")).code).toBe(
      inSwitch("  case 0:\n\n  case 1:\n    b();\n"),
    );
    expect(removeComments(inSwitch("  case 0: /* a\n\n b */ case 1:\n    b();\n")).code).toBe(
      inSwitch("  case 0:\n\n case 1:\n    b();\n"),
    );
  });

  it("holds the line in front of a `default` clause and below an empty one", () => {
    expect(removeComments(inSwitch("  case 0:\n  // note\n  default:\n    b();\n")).code).toBe(
      inSwitch("  case 0:\n\n  default:\n    b();\n"),
    );
    expect(removeComments(inSwitch("  default:\n  // note\n  case 1:\n    b();\n")).code).toBe(
      inSwitch("  default:\n\n  case 1:\n    b();\n"),
    );
  });

  it("holds the lines of nested switches each on their own", () => {
    const source = inSwitch(
      "  case 0:\n    switch (y) {\n      case 5:\n      // inner\n      case 6:\n        c();\n    }\n  case 1:\n  // outer\n  case 2:\n    b();\n",
    );

    expect(removeComments(source).code).toBe(source.replace("      // inner\n", "\n").replace("  // outer\n", "\n"));
  });

  it("removes the comments where the next clause stays on the line below either way", () => {
    expect(removeComments(inSwitch("  case 0: // note\n  case 1:\n    b();\n")).code).toBe(
      inSwitch("  case 0:\n  case 1:\n    b();\n"),
    );
    expect(removeComments(inSwitch("  case 0: /* a\n b */ case 1:\n    b();\n")).code).toBe(
      inSwitch("  case 0:\n case 1:\n    b();\n"),
    );
  });

  it("adds no empty line where a blank line or a comment that stays holds the clause apart", () => {
    expect(removeComments(inSwitch("  case 0:\n\n  // note\n  case 1:\n    b();\n")).code).toBe(
      inSwitch("  case 0:\n\n  case 1:\n    b();\n"),
    );
    expect(
      removeComments(
        inSwitch("  case 0:\n  // note\n  // eslint-disable-next-line no-fallthrough\n  case 1:\n    b();\n"),
      ).code,
    ).toBe(inSwitch("  case 0:\n  // eslint-disable-next-line no-fallthrough\n  case 1:\n    b();\n"));
  });

  it("removes the comment lines below a case that holds statements", () => {
    expect(removeComments(inSwitch("  case 0:\n    a();\n  // note\n  case 1:\n    b();\n")).code).toBe(
      inSwitch("  case 0:\n    a();\n  case 1:\n    b();\n"),
    );
  });

  it("keeps the line breaks the source has around the line that stays", () => {
    // ESLint finds its line between the clauses, and oxlint up to 1.94.0,
    // which counted line feeds alone, finds none before or after.
    expect(removeComments(inSwitch("  case 0:\r  // note\r  case 1:\n    b();\n")).code).toBe(
      inSwitch("  case 0:\r\r  case 1:\n    b();\n"),
    );
    expect(removeComments(inSwitch("  case 0:\r\n  // note\r\n  case 1:\r\n    b();\r\n")).code).toBe(
      inSwitch("  case 0:\r\n\r\n  case 1:\r\n    b();\r\n"),
    );
  });

  it("keeps the comment where no line that stays holds the line feeds a linter counted", () => {
    // Two line feeds stand between the clauses, and the line above the
    // second clause ends in a lone CR: emptied, the comment line would take
    // one of the line feeds along.
    const source = inSwitch("  case 0:\n  // note\n\r  case 1:\n    b();\n");
    const result = removeComments(source);

    expect(result.code).toBe(source);
    expect(result.kept.map((comment) => comment.text)).toEqual(["// note"]);
  });
});

describe("removeComments behind a `no default` comment oxlint reads", () => {
  it("keeps the last comment between it and the end of the switch", () => {
    const afterBlock = inSwitch("  case 1: {\n    // no default\n    a();\n  } // note\n");

    expect(removeComments(afterBlock).code).toBe(afterBlock);
    expect(removeComments(inSwitch("  case 1:\n    // no default\n    a(); // one\n    b(); // two\n")).code).toBe(
      inSwitch("  case 1:\n    // no default\n    a();\n    b(); // two\n"),
    );
  });

  it("keeps one for every switch that reads the comment from its last clause on", () => {
    const source = inSwitch(
      "  case 1:\n    switch (y) {\n      case 2:\n        // no default\n        c(); /* in */\n    }\n    /* out */\n",
    );

    expect(removeComments(source).code).toBe(source);
  });

  it("reads no further than the switches whose last clause holds the comment", () => {
    // The outer switch reads its comment from `case 3` on, where the inner switch is not.
    const source = inSwitch(
      "  case 1:\n    switch (y) {\n      case 2:\n        // no default\n        c(); // in\n    }\n    break; // gone\n  case 3:\n    d(); // out\n",
    );

    expect(removeComments(source).code).toBe(source.replace(" // gone", "").replace(" // out", ""));
  });

  it("removes the comments in front of it, and those of a switch that reads none", () => {
    expect(removeComments(inSwitch("  case 1:\n    a(); // gone\n  // no default\n")).code).toBe(
      inSwitch("  case 1:\n    a();\n  // no default\n"),
    );
    // In front of the last clause, and in a switch with a default clause, the words are prose.
    expect(removeComments(inSwitch("  // no default\n  case 1:\n    a(); // note\n")).code).toBe(
      inSwitch("  case 1:\n    a();\n"),
    );
    expect(
      removeComments(inSwitch("  case 1:\n    // no default\n    a(); // note\n  default:\n    b();\n")).code,
    ).toBe(inSwitch("  case 1:\n    a();\n  default:\n    b();\n"));
  });
});
