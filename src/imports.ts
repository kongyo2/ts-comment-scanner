import ts from "typescript";
import { firstIndexAtOrAfter, type Range } from "./ranges.js";

type ImportSorter = "typescript" | "dprint";

/**
 * The gap in front of an import or export declaration that an import sorter
 * reads to tell whether the declaration starts a new group, which it sorts
 * and merges apart from the group before it: the declaration's leading
 * trivia, from the end of the token before it to its first token.
 */
export interface ImportGroupGap extends Range {
  /** The sorters that start a new group at the declaration after the gap. */
  splits: ImportSorter[];
}

/**
 * The gaps the import sorters read, in document order — one for every
 * declaration past the first of a run a sorter sorts, so that the same
 * declarations have gaps however the comments around them change:
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
 *
 * Both start a group at an empty line, which is what removal leaves where it
 * deletes the comments that held two groups apart. Biome's organizeImports
 * starts a chunk only at a comment that an empty line follows, never at the
 * empty line alone, so no layout without the comment keeps its chunks apart,
 * and they are not read.
 */
export function importGroupGaps(
  source: string,
  sourceFile: ts.SourceFile,
  comments: readonly Range[],
): ImportGroupGap[] {
  const readers = new Map<ts.Statement, Set<ImportSorter>>();
  const read = (declaration: ts.Statement, sorter: ImportSorter): void => {
    const sorters = readers.get(declaration) ?? new Set();
    sorters.add(sorter);
    readers.set(declaration, sorters);
  };
  for (const statements of [sourceFile.statements, ...ambientModuleBodies(sourceFile)]) {
    for (const declaration of statements.filter(ts.isImportDeclaration).slice(1)) read(declaration, "typescript");
  }
  for (const run of exportRuns(sourceFile.statements)) {
    for (const declaration of run.slice(1)) read(declaration, "typescript");
  }
  for (const declaration of adjacentOfOneKind(sourceFile.statements, dprintKind)) read(declaration, "dprint");
  return [...readers]
    .sort(([a], [b]) => a.pos - b.pos)
    .map(([declaration, sorters]) => {
      const gap = { start: declaration.pos, end: declaration.getStart(sourceFile) };
      const splits = [...sorters].filter((sorter) => STARTS_GROUP[sorter](source, gap, comments));
      return { ...gap, splits };
    });
}

// Whether the sorter starts a new group at the declaration after the gap.
const STARTS_GROUP: Readonly<
  Record<ImportSorter, (source: string, gap: Range, comments: readonly Range[]) => boolean>
> = {
  typescript: (source, gap, comments) => newLineTrivia(source, gap, comments) >= 2,
  dprint: (source, gap) => source.slice(gap.start, gap.end).split("\n").length > 2,
};

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
