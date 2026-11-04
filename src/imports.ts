import ts from "typescript";
import { LINE_BREAK } from "./lines.js";
import { firstIndexAtOrAfter, type Range } from "./ranges.js";

type ImportSorter = "typescript" | "dprint";

/**
 * The linters whose newline-after-import rule wants an empty line between
 * the imports and the code after them: eslint-plugin-import ("eslint"),
 * whose rule eslint-plugin-import-x and eslint-plugin-import-lite carry
 * over, and oxlint, which ports it ("oxlint").
 */
type ImportLinter = "eslint" | "oxlint";

/**
 * The gap in front of an import or export declaration that an import sorter
 * reads to tell whether the declaration starts a new group, which it sorts
 * and merges apart from the group before it, or in front of the statement
 * after an import that a linter reads to tell whether an empty line ends the
 * imports: the statement's leading trivia, from the end of the token before
 * it to its first token — for a class, to its first decorator, which the
 * linters measure from, past an `export` in front of it.
 */
export interface ImportGroupGap extends Range {
  /** The sorters that start a new group at the declaration after the gap. */
  splits: ImportSorter[];
  /** The linters that find the empty line they want in the gap. */
  spaced: ImportLinter[];
}

/**
 * The gaps the import sorters and linters read, in document order — one for
 * every declaration past the first of a run a sorter sorts, and one for every
 * statement a linter measures from the import before it, so that the same
 * statements have gaps however the comments around them change:
 *
 * - TypeScript's organizeImports (`groupByNewlineContiguous` in tsc 6 and in
 *   tsc 7's port; tsserver and VS Code, prettier-plugin-organize-imports)
 *   sorts the import declarations of the file, and those of each ambient
 *   module, across whatever stands between them, and the file's export
 *   declarations in the runs of exportRuns. A declaration starts a group
 *   when its leading trivia holds two line breaks outside comments: `\n`,
 *   `\r` or `\r\n`, its scanner's NewLineTrivia — U+2028 and U+2029 are
 *   skipped as whitespace.
 * - dprint's TypeScript plugin (`module.sortImportDeclarations` and
 *   `sortExportDeclarations`, on by default; `get_stmt_groups`) sorts runs of
 *   adjacent top-level declarations of one kind, imports with specifiers or
 *   `export … from`s, and starts a group where a declaration starts two or
 *   more lines below the end of the one before it, counting line feeds alone.
 *   A declaration a `dprint-ignore` comment exempts ends dprint's run, and
 *   stays in it here, which only reads more gaps. `deno fmt`, which runs the
 *   plugin, keeps the order.
 * - The newline-after-import rules (see ImportLinter), with their default
 *   options, want the statement after an import declaration, or after an
 *   `import x = …` that is not exported, to start two or more lines below
 *   the import's end, unless it is one of those itself — so a comment line
 *   in between holds one of the lines. In the file's own statements they
 *   want the same after a statement holding a require (see holdsRequire),
 *   unless the next one holds one too. eslint-plugin-import counts the line
 *   breaks its parsers number lines by, U+2028 and U+2029 included, and reads
 *   the imports in the bodies of modules and namespaces as well (see
 *   moduleBodies); oxlint counts line feeds alone, in the file's own
 *   statements.
 *
 * The sorters start a group at an empty line, and the linters find theirs
 * there, which is what removal leaves where it deletes the comments that held
 * a gap open. Biome's organizeImports starts a chunk only at a comment that
 * an empty line follows, never at the empty line alone, so no layout without
 * the comment keeps its chunks apart, and they are not read.
 */
export function importGroupGaps(
  source: string,
  sourceFile: ts.SourceFile,
  comments: readonly Range[],
): ImportGroupGap[] {
  const sorters = new Map<ts.Statement, Set<ImportSorter>>();
  const linters = new Map<ts.Statement, Set<ImportLinter>>();
  for (const statements of [sourceFile.statements, ...ambientModuleBodies(sourceFile)]) {
    for (const declaration of statements.filter(ts.isImportDeclaration).slice(1)) {
      addReader(sorters, declaration, "typescript");
    }
  }
  for (const run of exportRuns(sourceFile.statements)) {
    for (const declaration of run.slice(1)) addReader(sorters, declaration, "typescript");
  }
  for (const declaration of adjacentOfOneKind(sourceFile.statements, dprintKind)) {
    addReader(sorters, declaration, "dprint");
  }
  for (const statement of statementsAfterImports(sourceFile.statements, true)) {
    addReader(linters, statement, "eslint");
    addReader(linters, statement, "oxlint");
  }
  for (const statements of moduleBodies(sourceFile.statements)) {
    for (const statement of statementsAfterImports(statements, false)) addReader(linters, statement, "eslint");
  }
  return [...new Set([...sorters.keys(), ...linters.keys()])]
    .sort((a, b) => a.pos - b.pos)
    .map((statement) => {
      const gap = { start: statement.pos, end: gapEnd(statement, sourceFile) };
      const splits = [...(sorters.get(statement) ?? [])].filter((sorter) =>
        STARTS_GROUP[sorter](source, gap, comments),
      );
      const spaced = [...(linters.get(statement) ?? [])].filter((linter) => FINDS_EMPTY_LINE[linter](source, gap));
      return { ...gap, splits, spaced };
    });
}

/** Records that the tool reads the gap in front of the statement. */
function addReader<T>(readers: Map<ts.Statement, Set<T>>, statement: ts.Statement, reader: T): void {
  const statementReaders = readers.get(statement) ?? new Set();
  statementReaders.add(reader);
  readers.set(statement, statementReaders);
}

// Whether the sorter starts a new group at the declaration after the gap.
const STARTS_GROUP: Readonly<
  Record<ImportSorter, (source: string, gap: Range, comments: readonly Range[]) => boolean>
> = {
  typescript: (source, gap, comments) => newLineTrivia(source, gap, comments) >= 2,
  dprint: (source, gap) => source.slice(gap.start, gap.end).split("\n").length > 2,
};

// Whether the linter finds its empty line in the gap: two line breaks or
// more, those inside comments included.
const FINDS_EMPTY_LINE: Readonly<Record<ImportLinter, (source: string, gap: Range) => boolean>> = {
  eslint: (source, gap) => source.slice(gap.start, gap.end).split(LINE_BREAK).length > 2,
  oxlint: (source, gap) => source.slice(gap.start, gap.end).split("\n").length > 2,
};

/**
 * Where the gap in front of the statement ends: at its first token, or at the
 * first decorator of a class, which the linters measure the class from —
 * past an `export` in front of it, too.
 */
function gapEnd(statement: ts.Statement, sourceFile: ts.SourceFile): number {
  const decorator = ts.isClassDeclaration(statement) ? ts.getDecorators(statement)?.[0] : undefined;
  return (decorator ?? statement).getStart(sourceFile);
}

/**
 * The statements the newline-after-import rules measure from the statement
 * before them: the ones after an import that are none (see isImport), and,
 * where `requires` asks, the ones after a statement holding a require that
 * hold none (see holdsRequire).
 */
function statementsAfterImports(statements: readonly ts.Statement[], requires: boolean): ts.Statement[] {
  const holding = statements.map((statement) => requires && holdsRequire(statement));
  return statements.filter(
    (statement, index) =>
      index > 0 &&
      ((isImport(statements[index - 1] as ts.Statement) && !isImport(statement)) ||
        (holding[index - 1] === true && !holding[index])),
  );
}

/** Whether the linters read the statement as an import: an import declaration, or an `import x = …` not exported. */
function isImport(statement: ts.Statement): boolean {
  return (
    ts.isImportDeclaration(statement) ||
    (ts.isImportEqualsDeclaration(statement) &&
      statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) !== true)
  );
}

/**
 * Whether the statement holds a call eslint-plugin-import reads as a require
 * (see isRequireCall) outside the nodes it looks for none in: functions with
 * a body, blocks, object literals and decorators, which it counts as levels.
 * A class static block is no block to it, a method's computed name lies
 * outside its function, an object literal that an assignment destructures
 * into is a pattern, no object (see isAssignmentTarget), and overloads and
 * the other function-likes without a body are no functions, so the defaults
 * of their parameters count, though tsc rejects them. oxlint stops at the
 * same nodes among a call's ancestors and at functions without a body, and
 * takes only the global `require`, called without parentheses around it or
 * its string; the requires it leaves out are read for it all the same, as
 * eslint-plugin-import reads the gaps after them anyway. Walked without
 * recursion, as the deeply nested expressions of generated code need, and
 * over the syntax tree alone, so that removing comments never changes which
 * statements hold one.
 */
function holdsRequire(statement: ts.Statement): boolean {
  const pending: ts.Node[] = [statement];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (ts.isCallExpression(node) && isRequireCall(node)) return true;
    if (ts.isFunctionLike(node) && "body" in node && node.body !== undefined) {
      if (node.name !== undefined && ts.isComputedPropertyName(node.name)) pending.push(node.name);
      continue;
    }
    if (
      (ts.isBlock(node) && !ts.isClassStaticBlockDeclaration(node.parent)) ||
      (ts.isObjectLiteralExpression(node) && !isAssignmentTarget(node)) ||
      ts.isDecorator(node)
    ) {
      continue;
    }
    // forEachChild stops at a callback that returns a value, so this one returns none.
    ts.forEachChild(node, (child) => {
      pending.push(child);
    });
  }
  return false;
}

/**
 * Whether the object literal is what an assignment destructures into — the
 * left of an `=`, the target of a `for … of` or `for … in`, or an element, a
 * rest or a property's value in one — which ESTree reads as a pattern.
 */
function isAssignmentTarget(literal: ts.ObjectLiteralExpression): boolean {
  let node: ts.Node = literal;
  for (;;) {
    const parent = node.parent;
    if (ts.isBinaryExpression(parent)) {
      return parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.left === node;
    }
    if (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) return parent.initializer === node;
    if (ts.isArrayLiteralExpression(parent) || ts.isSpreadElement(parent)) {
      node = parent;
    } else if (ts.isPropertyAssignment(parent) && parent.initializer === node) {
      node = parent.parent;
    } else {
      return false;
    }
  }
}

/**
 * Whether the call is a require to eslint-plugin-import: `require` with a
 * single string literal, the parentheses around either part aside, as
 * ESLint's parsers drop them.
 */
function isRequireCall(call: ts.CallExpression): boolean {
  const callee = unparenthesized(call.expression);
  const [argument] = call.arguments;
  return (
    ts.isIdentifier(callee) &&
    callee.text === "require" &&
    call.arguments.length === 1 &&
    ts.isStringLiteral(unparenthesized(argument as ts.Expression))
  );
}

function unparenthesized(expression: ts.Expression): ts.Expression {
  let inner = expression;
  while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
  return inner;
}

/**
 * The statements of every module and namespace body in the file (`declare
 * module "m" { … }`, `declare global { … }`, `namespace N { … }`, the ones
 * nested in them included), whose imports eslint-plugin-import reads too:
 * an `import x = N.y` is at home in a namespace.
 */
function moduleBodies(statements: readonly ts.Statement[]): Array<readonly ts.Statement[]> {
  const bodies: Array<readonly ts.Statement[]> = [];
  const pending: Array<readonly ts.Statement[]> = [statements];
  for (let list = pending.pop(); list !== undefined; list = pending.pop()) {
    for (const statement of list) {
      if (!ts.isModuleDeclaration(statement)) continue;
      // `namespace A.B { … }` nests the declaration of B in A's.
      let body = statement.body;
      while (body !== undefined && ts.isModuleDeclaration(body)) body = body.body;
      if (body === undefined) continue;
      const inner = (body as ts.ModuleBlock).statements;
      bodies.push(inner);
      pending.push(inner);
    }
  }
  return bodies;
}

/** The statements past the first of each run of adjacent ones that `kindOf` puts in one kind. */
function adjacentOfOneKind(
  statements: readonly ts.Statement[],
  kindOf: (statement: ts.Statement) => string | undefined,
): ts.Statement[] {
  return statements.filter((statement, index) => {
    const kind = kindOf(statement);
    return index > 0 && kind !== undefined && kindOf(statements[index - 1] as ts.Statement) === kind;
  });
}

/**
 * The statements of the ambient modules (`declare module "m" { … }`,
 * `declare global { … }`) at the top of the file, whose imports
 * organizeImports sorts too (it leaves their exports in one run).
 */
function ambientModuleBodies(sourceFile: ts.SourceFile): Array<ts.NodeArray<ts.Statement>> {
  return sourceFile.statements.flatMap((statement) =>
    ts.isModuleDeclaration(statement) &&
    statement.body !== undefined &&
    (ts.isStringLiteral(statement.name) || (statement.flags & ts.NodeFlags.GlobalAugmentation) !== 0)
      ? [(statement.body as ts.ModuleBlock).statements]
      : [],
  );
}

/**
 * The runs of top-level export declarations that tsc 6's organizeImports
 * sorts (`getTopLevelExportGroups`): `export … from`s join the run across
 * the statements between them, and a local `export { … }` takes the export
 * declarations right after it into the run and ends it. tsc 7 also ends a run
 * at any other statement, so its runs divide these and it reads no gap tsc 6
 * does not.
 */
function exportRuns(statements: readonly ts.Statement[]): ts.ExportDeclaration[][] {
  const runs: ts.ExportDeclaration[][] = [];
  let run: ts.ExportDeclaration[] = [];
  let ending = false;
  for (const statement of statements) {
    if (ts.isExportDeclaration(statement)) {
      run.push(statement);
      ending ||= statement.moduleSpecifier === undefined;
    } else if (ending) {
      runs.push(run);
      run = [];
      ending = false;
    }
  }
  runs.push(run);
  return runs;
}

/** What dprint sorts the statement among: imports with specifiers, `export … from`s, or neither. */
function dprintKind(statement: ts.Statement): "imports" | "exports" | undefined {
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    const bindings = clause?.namedBindings;
    const specified =
      clause?.name !== undefined ||
      (bindings !== undefined && (ts.isNamespaceImport(bindings) || bindings.elements.length > 0));
    return specified ? "imports" : undefined;
  }
  return ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined ? "exports" : undefined;
}

/** The line breaks TypeScript's scanner reads as NewLineTrivia in the gap, past its (sorted) comments. */
function newLineTrivia(source: string, gap: Range, comments: readonly Range[]): number {
  let count = 0;
  let from = gap.start;
  for (
    let index = firstIndexAtOrAfter(comments, gap.start, (comment) => comment.start);
    (comments[index]?.start ?? gap.end) < gap.end;
    index += 1
  ) {
    const comment = comments[index] as Range;
    count += lineBreaks(source.slice(from, comment.start));
    from = comment.end;
  }
  return count + lineBreaks(source.slice(from, gap.end));
}

function lineBreaks(text: string): number {
  return text.match(/\r\n?|\n/g)?.length ?? 0;
}
