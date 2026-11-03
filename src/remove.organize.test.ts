import ts from "typescript";
import { describe, expect, it } from "vitest";
import { removeComments } from "./remove.js";
import { analyzeSource } from "./scanner.js";

// imports.ts mirrors how TypeScript's organizeImports groups the imports and
// exports it sorts. These tests run the real one — the language service of
// the typescript@6 package the scanner parses with, which tsserver, VS Code
// and prettier-plugin-organize-imports run — so the mirror cannot drift from
// tsc 6 silently. tsc 7's port groups imports the same way and ends runs of
// exports at more statements, never at fewer; dprint and Biome are checked by
// hand.

const FILE = "/main.ts";

/** What organizeImports makes of a single in-memory file, sorting and merging only. */
function organize(text: string): string {
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [FILE],
    getScriptVersion: () => "1",
    getScriptSnapshot: (name) => (name === FILE ? ts.ScriptSnapshot.fromString(text) : undefined),
    getCurrentDirectory: () => "/",
    getCompilationSettings: () => ({ noLib: true, types: [] }),
    getDefaultLibFileName: () => "/lib.d.ts",
    fileExists: (name) => name === FILE,
    readFile: (name) => (name === FILE ? text : undefined),
  };
  const [change] = ts
    .createLanguageService(host)
    .organizeImports(
      { type: "file", fileName: FILE, skipDestructiveCodeActions: true },
      ts.getDefaultFormatCodeSettings("\n"),
      undefined,
    );
  const edits = [...(change?.textChanges ?? [])].sort((x, y) => y.span.start - x.span.start);
  return edits.reduce(
    (result, edit) =>
      result.slice(0, edit.span.start) + edit.newText + result.slice(edit.span.start + edit.span.length),
    text,
  );
}

/** The module each import and export declaration names, in document order, those of ambient modules included. */
function modules(text: string): string[] {
  const names: string[] = [];
  const visit = (statements: readonly ts.Statement[]): void => {
    for (const statement of statements) {
      if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier) {
        names.push((statement.moduleSpecifier as ts.StringLiteral).text);
      } else if (
        ts.isModuleDeclaration(statement) &&
        statement.body !== undefined &&
        ts.isModuleBlock(statement.body)
      ) {
        visit(statement.body.statements);
      }
    }
  };
  visit(ts.createSourceFile(FILE, text, ts.ScriptTarget.Latest).statements);
  return names;
}

const splitsForTypeScript = (source: string): boolean =>
  analyzeSource(source).importGroups.some((gap) => gap.splits.includes("typescript"));

// Two declarations of `./b` and `./a` with a gap between them: organizeImports
// leaves `./b` first only where it sorts the two in groups of their own.
const layouts: Array<[string, (gap: string) => string]> = [
  ["imports", (gap) => `import { b } from "./b";${gap}import { a } from "./a";\nexport const ab = [a, b];\n`],
  [
    "imports past a statement",
    (gap) => `import { b } from "./b";\nexport const x = 1;${gap}import { a } from "./a";\nexport const ab = [a, b];\n`,
  ],
  ["`export … from`s", (gap) => `export * from "./b";${gap}export { a } from "./a";\n`],
  [
    "`export … from`s past a statement",
    (gap) => `export * from "./b";\nexport const x = 1;${gap}export * from "./a";\n`,
  ],
  [
    "imports of an ambient module",
    (gap) => `declare module "m" {\n  import { b } from "./b";${gap}import { a } from "./a";\n}\n`,
  ],
];

// U+2028 or U+2029 in front of a comment line makes organizeImports fail
// ("Changes overlap"), with or without the comment, so those are left out.
const gaps = [
  "\n",
  "\n\n",
  "\n// note\n",
  "\n// one\n// two\n",
  "\n/* note */\n",
  "\n/* note\n   more */\n",
  "\n/* one */ /* two */\n",
  " // note\n",
  "\n/* note */ ",
  "\n/* note\n */ ",
  " /* note\n */\n",
  "\n// note\n/* x\n */ ",
  "\n// note\n\n",
  "\n\n// note\n",
  "\r\n// note\r\n",
  "\r// note\n",
  "\n// note\r",
  "\n// note ",
];

describe.each(layouts)("import groups of %s, against tsc 6's organizeImports", (_, layout) => {
  it.each(gaps)("agrees on where a group starts, and keeps it there, across %j", (gap) => {
    const source = layout(gap);
    const organized = modules(organize(source));

    expect(splitsForTypeScript(source)).toBe(organized[0] === "./b");
    expect(modules(organize(removeComments(source).code))).toEqual(organized);
  });
});

describe("comment removal in files organizeImports sorts, against tsc 6", () => {
  it.each([
    [
      'import React from "react";',
      'import { useState } from "react";',
      "// components",
      'import { Button } from "./Button";',
      'import { Card } from "./Card"; // the new card',
      "// utilities, added for the review",
      'import { cx } from "./cx";',
      "",
      "export const App = () => [React, useState, Button, Card, cx];",
      "",
    ].join("\n"),
    'import { a } from "./x";\n// more from x\nimport { b } from "./x";\nexport const ab = [a, b];\n',
    [
      "// The public API.",
      'export * from "./scan";',
      "// removal",
      'export { removeComments } from "./remove";',
      'export type { RemoveOptions } from "./remove";',
      "",
      "// formatting",
      'export * from "./format";',
      "",
    ].join("\n"),
    'import { z } from "z";\r\n// local\r\nimport { a } from "./a";\r\nexport const az = [a, z];\r\n',
  ])("keeps what organizeImports does to %j", (source) => {
    expect(modules(organize(removeComments(source).code))).toEqual(modules(organize(source)));
  });
});
