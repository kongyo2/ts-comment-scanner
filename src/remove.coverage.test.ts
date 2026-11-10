import { describe, expect, it } from "vitest";
import { ignoredByC8 } from "../test/coverage.js";
import { removeComments } from "./remove.js";

// A coverage hint that counts lines covers code by where it stands: c8 and
// Node's test runner count rows that only a line feed ends, from hints they
// find by searching the text, and monocart counts lines from the comments it
// parses (see coverage.ts). The removal has to leave every tool ignoring the
// code it ignored. For c8 the tests check that against the real converter,
// v8-to-istanbul; for the other tools they pin outputs that were checked by
// hand against Node 22's test runner and monocart-coverage-reports 3.2.1.

/** The calls (`a()`, `b()`, ...) on the rows c8 ignores. */
async function callsIgnoredByC8(source: string): Promise<string[]> {
  const ignored = await ignoredByC8(source);
  return source
    .split("\n")
    .flatMap((row, index) => (ignored.includes(index + 1) ? (row.match(/\b[a-z]\(\)/g) ?? []) : []));
}

describe("removeComments on the rows a coverage hint counts, against v8-to-istanbul", () => {
  it.each([
    // The rows below the hint stay rows: emptied, one stays as an empty line.
    ["/* c8 ignore next 3 */\na();\n// note\nb();\nc();\n", "/* c8 ignore next 3 */\na();\n\nb();\nc();\n"],
    [
      "/* c8 ignore next 3 */\r\na();\r\n// note\r\nb();\r\nc();\r\n",
      "/* c8 ignore next 3 */\r\na();\r\n\r\nb();\r\nc();\r\n",
    ],
    [
      "/* c8 ignore next 3 */\na();\n/* note\n   more */\nb();\nc();\n",
      "/* c8 ignore next 3 */\na();\n\n\nb();\nc();\n",
    ],
    ["/* c8 ignore next 2 */\na(); /* note\n*/ b();\nc();\n", "/* c8 ignore next 2 */\na();\n b();\nc();\n"],
    ["/* c8 ignore next 2 */\na(); /* note\n*/\nb();\nc();\n", "/* c8 ignore next 2 */\na();\n\nb();\nc();\n"],
    [
      "/* c8 ignore next 3 */\na(/* note\n*/);\nb(); // note\nc();\nd();\n",
      "/* c8 ignore next 3 */\na(\n);\nb();\nc();\nd();\n",
    ],
    // A row runs past a lone CR or a U+2028, which end a line for tsc alone.
    ["/* c8 ignore next 2 */\na(); b();\n// note\nc();\n", "/* c8 ignore next 2 */\na(); b();\n\nc();\n"],
    ["/* c8 ignore next 2 */\na();\r// note\rb();\nc();\nd();\n", "/* c8 ignore next 2 */\na();\r\rb();\nc();\nd();\n"],
    [
      "/* c8 ignore next 2 */\na(); /* note\r\n*/ b();\nc();\nd();\n",
      "/* c8 ignore next 2 */\na();\r\n b();\nc();\nd();\n",
    ],
    // A line feed stays in front of a lone CR that would otherwise read as one CRLF with it.
    ["/* c8 ignore next 3 */\na();\n/* x\ry */\nb();\n", "/* c8 ignore next 3 */\na();\n\n\rb();\n"],
    ["/* c8 ignore next 4 */\na();\n/* x\ry\nz */\nb();\n", "/* c8 ignore next 4 */\na();\n\n\n\rb();\n"],
    ["/* c8 ignore next 3 */\na();\n/* x\ry\rz */\nb();\n", "/* c8 ignore next 3 */\na();\n\n\r\rb();\n"],
    // Every hint in a comment counts: c8 reads the text row by row.
    [
      "/* c8 ignore next 1\n/* v8 ignore next 3 */\na();\n// note\nb();\nc();\n",
      "/* c8 ignore next 1\n/* v8 ignore next 3 */\na();\n\nb();\nc();\n",
    ],
    [
      "/*\n * c8 ignore next\n/* c8 ignore next 2 */\na();\n// note\nb();\nc();\n",
      "/*\n * c8 ignore next\n/* c8 ignore next 2 */\na();\n\nb();\nc();\n",
    ],
    // So does one in a string, which is no comment at all.
    ['const s = "/* c8 ignore next */"; // note\na();\n', 'const s = "/* c8 ignore next */";\na();\n'],
    // A hint further into its row covers that row alone, and nothing below it is held.
    [
      "// see /* c8 ignore next 2 */ for why\na();\n// note\nb();\nc();\n",
      "// see /* c8 ignore next 2 */ for why\na();\nb();\nc();\n",
    ],
    // Below the last code there is nothing to move up, so no empty line is left.
    ["/* c8 ignore next 3 */\na();\n// note\n", "/* c8 ignore next 3 */\na();\n"],
    ["a();\n/* c8 ignore next 2 */\n", "a();\n/* c8 ignore next 2 */\n"],
    ["a(); // note\n/* c8 ignore next */", "a();\n/* c8 ignore next */"],
    ["/* c8 ignore next 5 */\na(); // note\n", "/* c8 ignore next 5 */\na();\n"],
  ])("leaves c8 ignoring the same code in %j", async (source, expected) => {
    const result = removeComments(source);

    expect(result.code).toBe(expected);
    expect(await callsIgnoredByC8(result.code)).toEqual(await callsIgnoredByC8(source));
  });
});

describe("removeComments in front of a coverage hint on its row, against v8-to-istanbul", () => {
  // c8 counts the rows below a hint only where nothing but non-word characters
  // stands in front of it on its row. A comment holding a word keeps the hint
  // to its own row, so deleting it would have c8 ignore the rows below too.
  it.each([
    // The rows below hold code: the comment that keeps the hint from counting them stays.
    ["/* note */ /* c8 ignore next */\na();\nb();\n", "/* note */ /* c8 ignore next */\na();\nb();\n"],
    [
      "/* one */ /* two */ /* c8 ignore next 2 */\na();\nb();\nc();\n",
      "/* two */ /* c8 ignore next 2 */\na();\nb();\nc();\n",
    ],
    // Code in front of the hint does the same, and the comment goes.
    ["a(); /* note */ /* c8 ignore next */\nb();\n", "a(); /* c8 ignore next */\nb();\n"],
    // A comment without a word on the hint's row never kept the hint from counting.
    ["/* --- */ /* c8 ignore next */\na(); // note\nb();\n", "/* c8 ignore next */\na();\nb();\n"],
    ["/* note\n*/ /* v8 ignore next */\na();\nb();\n", "/* v8 ignore next */\na();\nb();\n"],
    // With no code on the rows the hint would newly count, they only have to stay rows.
    ["/* note */ /* c8 ignore next */\n\na();\n", "/* c8 ignore next */\n\na();\n"],
    ["/* note */ /* c8 ignore next */\n", "/* c8 ignore next */\n"],
    ["/* note */ /* c8 ignore next */\n// gone", "/* c8 ignore next */\n"],
  ])("leaves c8 ignoring the same code in %j", async (source, expected) => {
    const result = removeComments(source);

    expect(result.code).toBe(expected);
    expect(await callsIgnoredByC8(result.code)).toEqual(await callsIgnoredByC8(source));
  });

  it("removes that comment along with the hint when directives go too", () => {
    const source = "/* note */ /* c8 ignore next */\na();\n";

    expect(removeComments(source, { removeDirectives: true }).code).toBe("a();\n");
  });
});

describe("removeComments on the rows Node's test runner ignores", () => {
  // Node reads the whole comment, `/* node:coverage ignore next 2 *​/`,
  // anywhere on a row — in a string or another comment too — and ignores the
  // rows below it.
  it("holds the rows below a hint wherever it stands on its row", () => {
    const inString = 'const s = "/* node:coverage ignore next 2 */";\n// note\na();\nb();\n';
    const inComment = "a(); // see /* node:coverage ignore next */\n// note\nb();\n// gone\nc();\n";

    expect(removeComments(inString).code).toBe('const s = "/* node:coverage ignore next 2 */";\n\na();\nb();\n');
    expect(removeComments(inComment).code).toBe("a(); // see /* node:coverage ignore next */\n\nb();\nc();\n");
  });

  it("holds no row past the end of the file", () => {
    expect(removeComments("a(); // note\n/* node:coverage ignore next */").code).toBe(
      "a();\n/* node:coverage ignore next */",
    );
    expect(removeComments("/* node:coverage ignore next 5 */\na(); // note\n").code).toBe(
      "/* node:coverage ignore next 5 */\na();\n",
    );
  });

  it("holds nothing below a hint Node does not read", () => {
    const source = 'const s = "/* node:coverage ignore next -- legacy */";\n// note\na();\n';

    expect(removeComments(source).code).toBe('const s = "/* node:coverage ignore next -- legacy */";\na();\n');
  });
});

describe("removeComments on the lines monocart counts", () => {
  it("counts from the line a hint's comment ends on, lines that any line terminator ends", () => {
    const source = "/* v8 ignore next 2\n   legacy */\na(); // note b();\nc();\n";

    expect(removeComments(source).code).toBe("/* v8 ignore next 2\n   legacy */\na();  b();\nc();\n");
  });

  it("counts the lines below a hint that trails code, which c8 gives its own row alone", () => {
    const source = "x(); // v8 ignore next 2\na();\n// note\nb();\n";

    expect(removeComments(source).code).toBe("x(); // v8 ignore next 2\na();\n\nb();\n");
  });

  it("covers no line below a block hint that code follows on its line", () => {
    // The hint is for `a()`; monocart ignores nothing below it, and neither does c8 below a row's end.
    const source = "x(); /* v8 ignore next */ a();\n// note\nb();\n";

    expect(removeComments(source).code).toBe("x(); /* v8 ignore next */ a();\n\nb();\n");
  });

  it("reads no count from a hint spelled for another tool", () => {
    const source = "/* istanbul ignore next 3 */\na();\n// note\nb();\nc();\n";

    expect(removeComments(source).code).toBe("/* istanbul ignore next 3 */\na();\nb();\nc();\n");
  });
});

describe("removeComments after a hint only c8 or monocart reads", () => {
  // ast-v8-to-istanbul applies a hint to the node right after the comment it
  // opens. A hint further into a comment, or one glued to a count, is not its
  // to read, so no comment has to stay between it and the code.
  it.each([
    ["x(); // see /* c8 ignore next */\n// note\na();\n", "x(); // see /* c8 ignore next */\n\na();\n"],
    ["/* v8 ignore next3 */\n// note\na();\nb();\nc();\nd();\n", "/* v8 ignore next3 */\n\na();\nb();\nc();\nd();\n"],
  ])("removes the comment below it in %j", async (source, expected) => {
    const result = removeComments(source);

    expect(result.code).toBe(expected);
    expect(await callsIgnoredByC8(result.code)).toEqual(await callsIgnoredByC8(source));
  });

  it("keeps one where the hint opens its comment", () => {
    const source = "/* c8 ignore next */\n// note\n// more\na();\n";

    expect(removeComments(source).code).toBe("/* c8 ignore next */\n// note\na();\n");
  });
});
