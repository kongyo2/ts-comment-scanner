import * as prettier from "prettier";
import { describe, expect, it } from "vitest";
import { detectDirective } from "./directives.js";
import { scanComments } from "./scanner.js";
import type { CommentKind } from "./types.js";

// The prettier rules in directives.ts mirror prettier's own comment checks
// (isPrettierIgnoreComment, the jest-docblock pragma parser, isTypeCastComment,
// hasLanguageComment and isFlowFile). These tests run the real prettier — the
// project's devDependency — over the same comments, so the mirror cannot drift
// from the formatter silently. Each helper turns a formatting outcome into
// "prettier honoured the comment".

/** A statement prettier rewrites whenever it formats the file at all. */
const MISFORMATTED = "const x = [ 1,2 ]\n";

function format(source: string, options: prettier.Options = {}): Promise<string> {
  return prettier.format(source, { parser: "typescript", ...options });
}

const kindOf = (comment: string): CommentKind => (comment.startsWith("//") ? "line" : "block");

const hasDirective = (source: string, names: readonly string[]): boolean =>
  scanComments(source).some((comment) => comment.directive !== undefined && names.includes(comment.directive));

/** Whether prettier leaves the misformatted statement below the comment alone. */
async function ignoresNextNode(comment: string): Promise<boolean> {
  const output = await format(`${comment}\n${MISFORMATTED}`);
  return output.includes("[ 1,2 ]");
}

/** Whether --require-pragma finds a format pragma: the misformatted file then gets formatted. */
async function hasFormatPragma(source: string): Promise<boolean> {
  return (await format(source, { requirePragma: true })) !== source;
}

/** Whether --check-ignore-pragma finds an ignore pragma: the misformatted file is then left as is. */
async function hasIgnorePragma(source: string): Promise<boolean> {
  return (await format(source, { checkIgnorePragma: true })) === source;
}

/** Whether prettier's babel parser (a JavaScript file's) keeps the parentheses after the comment: a type cast. */
async function keepsCastParentheses(comment: string): Promise<boolean> {
  const output = await format(`const a = ${comment} (foo);\n`, { parser: "babel" });
  return output.includes("(foo)");
}

/** Whether prettier formats the template literal after the comment as HTML. */
async function formatsAsHtml(comment: string): Promise<boolean> {
  const output = await format(`const t = ${comment} \`<div   class="a"></div>\`;\n`);
  return output.includes('<div class="a"></div>');
}

/** Whether prettier formats the template literal after the comment as GraphQL. */
async function formatsAsGraphql(comment: string): Promise<boolean> {
  const output = await format(`const q = ${comment} \`query{a}\`;\n`);
  return output.includes("query {");
}

/** Whether prettier's babel parser reads the file as Flow: a numeric object key then keeps its quotes. */
async function parsesAsFlow(source: string): Promise<boolean> {
  const output = await format(source, { parser: "babel" });
  return output.includes('"1"');
}

describe("prettier-ignore, against prettier", () => {
  it.each([
    "// prettier-ignore",
    "//prettier-ignore",
    "// prettier-ignore ",
    "/* prettier-ignore */",
    "/*prettier-ignore*/",
    "/*\n  prettier-ignore\n*/",
    "/* prettier-ignore x */",
    "/** prettier-ignore */",
    "/* * prettier-ignore */",
    "// prettier-ignore-start",
    "// prettier-ignore-end",
    "// prettier-ignore because it is hand-aligned",
    "// prettier-ignores",
  ])("agrees on %j", async (comment) => {
    expect(detectDirective(kindOf(comment), comment) === "prettier-ignore").toBe(await ignoresNextNode(comment));
  });
});

describe("format pragmas, against prettier", () => {
  it.each([
    "/** @format */",
    "/* @format */",
    "/**\n * @prettier\n */",
    "/**\n * @flow\n * @format\n */",
    "/**\n * @license MIT\n * @format\n */",
    "/** @format*/",
    "/**@format*/",
    "/**\r\n * @format\r\n */",
    "/**\n\t* @format\n */",
    "/**\n ** @format\n */",
    "/**\n *\t@format\n */",
    "/** foo @format */",
    "/** @format, */",
    "/** @format:reason */",
    "/** @FORMAT */",
    "/** @prettier-plugin notes */",
    "/** @format  */",
  ])("agrees on %j as the first comment", async (docblock) => {
    const source = `${docblock}\n${MISFORMATTED}`;
    expect(hasDirective(source, ["@format", "@prettier"])).toBe(await hasFormatPragma(source));
  });

  it.each([
    "/** @noformat */",
    "/** @noprettier -- reason to not format */",
    "/**\n * @flow\n * @noprettier\n */",
    "/* @noformat */",
    "/** @noformat, */",
    "/** @format @noformat */",
    "/** @NOFORMAT */",
  ])("agrees on the ignore pragma in %j", async (docblock) => {
    const source = `${docblock}\n${MISFORMATTED}`;
    expect(hasDirective(source, ["@noformat", "@noprettier"])).toBe(await hasIgnorePragma(source));
  });

  it.each([
    "/** @format */\n",
    "\n\n  /** @format */\n",
    "﻿/** @format */\n",
    "#!/usr/bin/env node\n/** @format */\n",
    "/* lead */\n/** @format */\n",
    "// lead\n/** @format */\n",
    "const y = 1;\n/** @format */\n",
  ])("agrees on where the docblock may sit: %j", async (lead) => {
    const source = `${lead}${MISFORMATTED}`;
    expect(hasDirective(source, ["@format"])).toBe(await hasFormatPragma(source));
  });
});

describe("type cast comments, against prettier's babel parser", () => {
  it.each([
    "/** @type {string} */",
    "/**@type{string}*/",
    "/** @type string */",
    "/** @satisfies {Record<string, string>} */",
    "/**\n * @type {{\n *   width: number,\n * }}\n */",
    "/** @type {!Foo} ***/",
    "/** see @type above */",
    "/** @type-param T */",
    "/* @type {string} */",
    "/** @typefoo Foo */",
    "/** @typedef {Foo} Bar */",
    "/** @Type {string} */",
    "/** @types */",
    "/* some comment */",
  ])("agrees on %j", async (comment) => {
    const name = detectDirective("block", comment);
    expect(name === "@type" || name === "@satisfies").toBe(await keepsCastParentheses(comment));
  });
});

describe("embedded-language comments, against prettier", () => {
  it.each(["/* HTML */", "/*HTML*/", "/* html */", "/** HTML */", "/* HTML  */", "/* HTML template */"])(
    "agrees on %j",
    async (comment) => {
      expect(detectDirective("block", comment) === "HTML").toBe(await formatsAsHtml(comment));
    },
  );

  it.each(["/* GraphQL */", "/*GraphQL*/", "/* graphql */", "/** GraphQL */", "/* GraphQL query */"])(
    "never misses a GraphQL comment prettier honours: %j",
    async (comment) => {
      // The rule also covers graphql-tag-pluck, which matches the comment
      // case-insensitively, so it may accept comments prettier ignores — but
      // never the reverse.
      const honoured = await formatsAsGraphql(comment);
      const detected = detectDirective("block", comment) === "GraphQL";
      expect(detected || !honoured).toBe(true);
    },
  );
});

describe("@flow pragma, against prettier's babel parser", () => {
  it.each([
    "// @flow\n",
    "//@flow\n",
    "/* @flow */\n",
    "/**\n *                      @noflow\n */\n",
    "//  another comment\n//                     @flow\n",
    "#!/usr/bin/env node\n// @flow\n",
    "// by fisker@flow.prettier.com :)\n",
    "// @flow-strict\n",
    "// @flowflow\n",
    "// flow\n",
    "#!/usr/bin/env @flow\n",
    "const y = 1;\n// @flow\n",
  ])("agrees on %j", async (lead) => {
    const source = `${lead}foo = { "1": bar };\n`;
    expect(hasDirective(source, ["@flow", "@noflow"])).toBe(await parsesAsFlow(source));
  });
});
