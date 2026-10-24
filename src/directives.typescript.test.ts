import ts from "typescript";
import { describe, expect, it } from "vitest";
import { detectDirective } from "./directives.js";
import { removeComments } from "./remove.js";
import { scanComments } from "./scanner.js";
import type { CommentKind } from "./types.js";

// The TypeScript rules in directives.ts mirror the compiler's own comment
// handling (the scanner's comment-directive regexes, the pragma parser, the
// triple-slash reader and the walk that finds a suppression's target line).
// These tests run the real compiler — the typescript@6 package the scanner
// parses with — over the same comments, so the mirror cannot drift from
// tsc 6 silently. tsc 7 (the Go port) and Flow honour a few forms tsc 6
// rejects; those carry a note, since only tsc 6 runs here.

const TYPE_ERROR = 'const a: number = "x";';
const TYPE_MISMATCH = 2322;

/** Error codes tsc 6 reports for a single in-memory file. */
function diagnosticCodes(fileName: string, text: string, options: ts.CompilerOptions = {}): number[] {
  const compilerOptions: ts.CompilerOptions = { noLib: true, noEmit: true, strict: true, types: [], ...options };
  const host = ts.createCompilerHost(compilerOptions);
  host.getSourceFile = (name, languageVersion) =>
    name === fileName ? ts.createSourceFile(name, text, languageVersion) : undefined;
  host.fileExists = (name) => name === fileName;
  host.readFile = (name) => (name === fileName ? text : undefined);
  const program = ts.createProgram([fileName], compilerOptions, host);
  return program.getSemanticDiagnostics(program.getSourceFile(fileName)).map((diagnostic) => diagnostic.code);
}

const kindOf = (comment: string): CommentKind => (comment.startsWith("//") ? "line" : "block");

const hasDirective = (source: string, names: readonly string[]): boolean =>
  scanComments(source).some((comment) => comment.directive !== undefined && names.includes(comment.directive));

/** Whether tsc 6 suppresses the type error on the line below the comment. */
const suppressesNextLine = (comment: string): boolean =>
  !diagnosticCodes("/main.ts", `${comment}\n${TYPE_ERROR}\n`).includes(TYPE_MISMATCH);

/** Whether tsc 6 leaves a TypeScript file unchecked. */
const skipsChecking = (source: string): boolean => !diagnosticCodes("/main.ts", source).includes(TYPE_MISMATCH);

/** Whether tsc 6 checks a JavaScript file under the leading comment although checkJs is off. */
const checksJavaScript = (comment: string): boolean =>
  diagnosticCodes("/main.js", `${comment}\n/** @type {number} */\nconst a = "x";\n`, { allowJs: true }).includes(
    TYPE_MISMATCH,
  );

/** Whether tsc 6 reads the line comment as a triple-slash directive. */
function readsTripleSlash(comment: string): boolean {
  const file = ts.createSourceFile("/main.ts", `${comment}\nexport {};\n`, ts.ScriptTarget.Latest);
  const references =
    file.referencedFiles.length +
    file.typeReferenceDirectives.length +
    file.libReferenceDirectives.length +
    file.amdDependencies.length;
  return references > 0 || file.moduleName !== undefined;
}

/**
 * The scanner has to detect exactly the forms tsc 6 honours, plus those only
 * another tool (named in the table) honours — which tsc 6 must then reject,
 * or the note is stale.
 */
function expectAgreement(detected: boolean, honouredByTsc6: boolean, alsoHonouredBy: string | undefined): void {
  expect({ detected, honouredByTsc6 }).toEqual(
    alsoHonouredBy === undefined
      ? { detected: honouredByTsc6, honouredByTsc6 }
      : { detected: true, honouredByTsc6: false },
  );
}

describe("@ts-ignore and @ts-expect-error, against tsc 6", () => {
  it.each([
    ["// @ts-ignore"],
    ["//@ts-ignore"],
    ["/// @ts-ignore"],
    ["//\t@ts-ignore"],
    ["//\u00a0@ts-ignore"],
    ["// @ts-ignoreTODO"],
    ["// @ts-ignore: reason"],
    ["// @ts-expect-error"],
    ["// @TS-IGNORE"],
    ["// note @ts-ignore"],
    ["// -- @ts-ignore"],
    ["/* @ts-ignore */"],
    ["/*@ts-expect-error*/"],
    ["/** @ts-ignore */"],
    ["/*/ @ts-ignore */"],
    ["/*\n * @ts-ignore */"],
    ["/* note\n @ts-ignore */"],
    ["/* @ts-ignore: reason */"],
    ["/* note @ts-ignore */"],
    // tsc 7 skips any number of extra slashes.
    ["//// @ts-ignore", "tsc 7"],
    // Flow reads the directive from the start of the comment value, stars
    // and line breaks skipped, wherever the comment's last line is.
    ["// * @ts-ignore", "Flow"],
    ["/* @ts-ignore\n */", "Flow"],
    ["/**\n * @ts-expect-error\n */", "Flow"],
  ])("agrees on %j", (comment, alsoHonouredBy?: string) => {
    const name = detectDirective(kindOf(comment), comment);
    const detected = name === "@ts-ignore" || name === "@ts-expect-error";
    expectAgreement(detected, suppressesNextLine(comment), alsoHonouredBy);
  });
});

describe("check pragmas, against tsc 6", () => {
  it.each([
    ["// @ts-nocheck"],
    ["//@ts-nocheck"],
    ["/// @ts-nocheck"],
    ["//// @ts-nocheck"],
    ["// @ts-nocheck: legacy"],
    ["// @ts-nocheck legacy"],
    ["//\u00a0@ts-nocheck"],
    ["// @TS-NOCHECK"],
    ["// @ts-nocheckfoo"],
    ["// @ts-nocheck-foo"],
    ["// note @ts-nocheck"],
    ["/* @ts-nocheck */"],
    ["/** @ts-nocheck */"],
    // tsc 7 ends the pragma name at anything but an ASCII letter or hyphen.
    ["// @ts-nocheck.", "tsc 7"],
    ["// @ts-nocheck1", "tsc 7"],
  ])("agrees on %j", (comment, alsoHonouredBy?: string) => {
    const detected = detectDirective(kindOf(comment), comment) === "@ts-nocheck";
    expectAgreement(detected, skipsChecking(`${comment}\n${TYPE_ERROR}\n`), alsoHonouredBy);
  });

  it.each(["// @ts-check", "/// @ts-check", "// @TS-CHECK reason", "// @ts-checked", "/* @ts-check */"])(
    "agrees on %j in a JavaScript file",
    (comment) => {
      expect(detectDirective(kindOf(comment), comment) === "@ts-check").toBe(checksJavaScript(comment));
    },
  );

  it.each([
    "// @ts-nocheck\n",
    "\n\n// @ts-nocheck\n",
    "#!/usr/bin/env node\n// @ts-nocheck\n",
    "/* lead */\n// @ts-nocheck\n",
    'import "./a.js";\n// @ts-nocheck\n',
    "const y = 1;\n// @ts-nocheck\n",
  ])("agrees on where the pragma may sit: %j", (lead) => {
    const source = `${lead}${TYPE_ERROR}\n`;
    expect(hasDirective(source, ["@ts-nocheck"])).toBe(skipsChecking(source));
  });
});

describe("triple-slash directives, against tsc 6", () => {
  it.each([
    ['/// <reference path="./a.ts" />'],
    ['///<reference path="./a.ts"/>'],
    ['/// <reference types="node" />'],
    ['/// <reference lib="es2015" />'],
    ['/// <REFERENCE path="./a.ts" />'],
    ['/// <amd-module name="a" />'],
    ["/// <amd-module />"],
    ['/// <amd-dependency path="./a" />'],
    ['//// <reference path="./a.ts" />'],
    ['/// note <reference path="./a.ts" />'],
    ['// <reference path="./a.ts" />'],
    ["/// <referencex />"],
    // tsc 7 needs neither the whitespace nor the closing `/>`.
    ['/// <reference path="./a.ts">', "tsc 7"],
    ["/// <reference>", "tsc 7"],
  ])("agrees on %j", (comment, alsoHonouredBy?: string) => {
    const detected = detectDirective("line", comment)?.startsWith("triple-slash-") === true;
    expectAgreement(detected, readsTripleSlash(comment), alsoHonouredBy);
  });
});

describe("comment removal below suppressions, against tsc 6", () => {
  // Each source carries a suppression above an error; whatever removeComments
  // deletes, tsc 6 has to report exactly what it reported before.
  it.each([
    `// @ts-expect-error\n\n/* blocker */\n${TYPE_ERROR}\n`,
    `// @ts-ignore\n// note\n\n// gone\n${TYPE_ERROR}\n`,
    `// @ts-expect-error\n\n\u00a0// note\n${TYPE_ERROR}\n`,
    `// @ts-expect-error\n\n/*! legal */ /* gone */\n${TYPE_ERROR}\n`,
    `// @ts-expect-error\n\v\n/* stop */\n${TYPE_ERROR}\n`,
    `// @ts-expect-error\n\v\n// gone\n${TYPE_ERROR}\n`,
    `// @ts-expect-error\n\u00a0\n/* stop */\n${TYPE_ERROR}\n`,
    `// @ts-expect-error\n  \u2028/* stop */\n${TYPE_ERROR}\n`,
    `/* @ts-expect-error */ /* note\n   more */\n${TYPE_ERROR}\n`,
    `// @ts-expect-error\n/* a */ /* b */\n${TYPE_ERROR}\n`,
    `// @ts-expect-error\n\n\t// note\n\n/* stop */\n${TYPE_ERROR}\n`,
    `// @ts-expect-error\n/* note\n */ ${TYPE_ERROR}\n`,
    `// @ts-ignore\n// @ts-expect-error\n\n/* stop */\n${TYPE_ERROR}\n`,
    `// @ts-expect-error\n\n// gone\n${TYPE_ERROR}\n`,
    `// @ts-expect-error\r\n\r\n/* stop */\r\n${TYPE_ERROR}\r\n`,
    `// @ts-expect-error\n\n// a\n\n// b\n${TYPE_ERROR}\n`,
    `// @ts-expect-error\n\n/* stop */ // y\n${TYPE_ERROR}\n`,
    `// @ts-expect-error\n\n// gone\n/* stop */\n\n${TYPE_ERROR}\n`,
    `const b = 1; // @ts-expect-error\n\n/* stop */\n${TYPE_ERROR}\n`,
    `/* @ts-expect-error */ const b = 1;\n\n/* stop */\n${TYPE_ERROR}\n`,
    `/* @ts-expect-error */ const b = 1; /* note\n */\n\n/* gone */\n${TYPE_ERROR}\n`,
  ])("keeps what tsc reports for %j", (source) => {
    expect(diagnosticCodes("/main.ts", removeComments(source).code)).toEqual(diagnosticCodes("/main.ts", source));
  });
});
