import ts from "typescript";
import { describe, expect, it } from "vitest";
import { removeComments } from "./remove.js";

// A tsc suppression applies to a line found by going up from a diagnostic
// (see tscReach in shields.ts), so removing the comments around one must not
// move code onto that line or off it. These tests run the real compiler — the
// typescript@6 package the scanner parses with — over a file before and after
// the removal: it has to report the same.

/** What tsc 6 reports for a TypeScript file: the code of each diagnostic and the text it points at. */
function diagnostics(text: string): string[] {
  const fileName = "/main.ts";
  const compilerOptions: ts.CompilerOptions = { noLib: true, noEmit: true, strict: true, types: [] };
  const host = ts.createCompilerHost(compilerOptions);
  host.getSourceFile = (name, languageVersion) =>
    name === fileName ? ts.createSourceFile(name, text, languageVersion, true) : undefined;
  host.fileExists = (name) => name === fileName;
  host.readFile = (name) => (name === fileName ? text : undefined);
  const program = ts.createProgram([fileName], compilerOptions, host);
  const file = program.getSourceFile(fileName);
  return [...program.getSyntacticDiagnostics(file), ...program.getSemanticDiagnostics(file)].map(
    (diagnostic) =>
      `${diagnostic.code}: ${text.slice(diagnostic.start, (diagnostic.start ?? 0) + (diagnostic.length ?? 0))}`,
  );
}

// Two assignments tsc rejects; which of them a suppression hides shows where it applies.
const A = 'const a: number = "x";';
const B = 'const b: number = "y";';

describe("removeComments around tsc suppressions, against tsc 6", () => {
  it.each([
    // A comment line the compiler steps over goes, and its line stays, empty.
    [`// @ts-expect-error\n// note\n${A}\n`, `// @ts-expect-error\n\n${A}\n`],
    [`// @ts-ignore\n\n// note\n// more\n${A}\n${B}\n`, `// @ts-ignore\n\n${A}\n${B}\n`],
    // One it stops at stays: the suppression has no target, and would get one.
    [`// @ts-expect-error\n/* blocker */\n${A}\n`, `// @ts-expect-error\n/* blocker */\n${A}\n`],
    [`// @ts-expect-error\n/* a\n*/ ${A}\n`, `// @ts-expect-error\n/* a\n*/ ${A}\n`],
    [`// @ts-ignore\n// note\n/* multi\n   line */ ${A}\n`, `// @ts-ignore\n\n/* multi\n   line */ ${A}\n`],
    // No code is pulled onto the line the suppression applies to.
    [`// @ts-ignore\nconst a: number = /* a\n*/ "x"; ${B}\n`, `// @ts-ignore\nconst a: number =\n "x"; ${B}\n`],
    [`// @ts-ignore\n${A} /* a\n*/ ${B}\n`, `// @ts-ignore\n${A}\n ${B}\n`],
    [
      `// @ts-ignore\n\n// note\nconst a: number = /* why\n   so */ "x"; ${B}\n`,
      `// @ts-ignore\n\nconst a: number =\n "x"; ${B}\n`,
    ],
    // A suppression in between takes the diagnostics from below, and its line stays one.
    [`// @ts-expect-error\n// @ts-ignore\n// plain\n${A}\n`, `// @ts-expect-error\n// @ts-ignore\n\n${A}\n`],
    // One sharing its line with code applies from the line below on.
    [`/* @ts-ignore */ ${A} // note\n// more\n${B}\n`, `/* @ts-ignore */ ${A}\n\n${B}\n`],
    [`${A} // @ts-ignore\n// note\n${B}\n`, `${A} // @ts-ignore\n\n${B}\n`],
    // Past the line it applies to, comments go as anywhere.
    [`// @ts-expect-error\n${A} // note\n${B} // gone\n`, `// @ts-expect-error\n${A}\n${B}\n`],
  ])("leaves tsc reporting the same for %j", (source, expected) => {
    const result = removeComments(source);

    expect(result.code).toBe(expected);
    expect(diagnostics(result.code)).toEqual(diagnostics(source));
  });

  it("would change what tsc reports were the lines joined or dropped", () => {
    expect(diagnostics(`// @ts-ignore\n${A}\n${B}\n`)).toEqual(["2322: b"]);
    // Joined to the suppressed line, the second assignment is suppressed too.
    expect(diagnostics(`// @ts-ignore\n${A} ${B}\n`)).toEqual([]);
    // With the blocking comment gone, the unused suppression has a target.
    expect(diagnostics(`// @ts-expect-error\n/* blocker */\n${A}\n`)).not.toEqual(
      diagnostics(`// @ts-expect-error\n${A}\n`),
    );
  });
});
