import ts from "typescript";
import { isFileWidePosition, type PrecedingNode } from "./astgrep.js";
import { bunMarkerOffset, carriesAstGrepSuppression, directiveNames, type DirectivePlacement } from "./directives.js";
import { importGroupGaps, type ImportGroupGap } from "./imports.js";
import { jsxLayout, type JsxLayout } from "./jsx.js";
import { byStart, firstIndexAtOrAfter, rangeAt, type Range } from "./ranges.js";
import type { Comment, CommentKind } from "./types.js";

export interface ScanOptions {
  jsx?: boolean;
  /**
   * The source is JavaScript. It is parsed the way tsc parses a `.js` file —
   * with JSX, and with `a < b > (c)` a comparison, as JavaScript has no type
   * arguments — and the JSDoc tags tsc takes its types from are directives
   * (see DirectivePlacement.jsDoc).
   */
  javascript?: boolean;
}

export function scanComments(source: string, options: ScanOptions = {}): Comment[] {
  return analyzeSource(source, options).comments;
}

/** A source's comments together with the layout of its JSX children, from a single parse. */
export interface SourceAnalysis {
  comments: Comment[];
  /**
   * Every directive each directive comment carries, its `directive` first
   * (see directiveNames).
   */
  directives: ReadonlyMap<Comment, readonly string[]>;
  jsx: JsxLayout;
  /** What stands in front of each comment carrying an ast-grep suppression (see precedingNode). */
  preceding: ReadonlyMap<Comment, PrecedingNode>;
  /**
   * In JavaScript, the tags tsc reads from each JSDoc comment it takes types
   * from (see typeTags). The names are among the comment's directives; they
   * are listed apart because a `@type` docblock is a directive wherever it
   * stands, to prettier, and only where tsc attaches it to a node here.
   */
  typed: ReadonlyMap<Comment, readonly string[]>;
  /**
   * In JavaScript, for each JSDoc comment whose tags tsc does not apply to
   * their node because a later JSDoc comment belongs to the same node, that
   * later comment: tsc takes a node's `@type`, `@param` and the like from
   * its last JSDoc comment alone, so deleting that one would bring the
   * earlier comment's tags to bear on the node.
   */
  shadows: ReadonlyMap<Comment, Comment>;
  /**
   * The JSDoc comments prettier reads as type casts (`@type`, `@satisfies`)
   * that a parenthesized expression follows, past any further comments.
   * Prettier keeps the parentheses only while nothing but whitespace stands
   * between the comment and them (see CAST_DIRECTIVES in shields.ts).
   */
  casts: ReadonlySet<Comment>;
  /**
   * The gaps in front of the import and export declarations the import
   * sorters group, and in front of the statements after the imports, where
   * the linters want an empty line (see importGroupGaps).
   */
  importGroups: ImportGroupGap[];
}

export function analyzeSource(source: string, options: ScanOptions = {}): SourceAnalysis {
  const javascript = options.javascript === true;
  // tsc reads JavaScript with JSX whatever the extension, and takes
  // `f < a > (b)` for a comparison there, where TypeScript reads type
  // arguments: parsed as TypeScript, a regular expression after such a `>`
  // would be a division, and a `//` or `/*` inside it a comment.
  const [fileName, scriptKind] = javascript
    ? ["module.js", ts.ScriptKind.JS]
    : options.jsx === true
      ? ["module.tsx", ts.ScriptKind.TSX]
      : ["module.ts", ts.ScriptKind.TS];
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind);

  const jsxTextSpans: Range[] = [];
  const jsxParents: Array<ts.JsxElement | ts.JsxFragment> = [];
  const ranges: ts.CommentRange[] = [];
  const seen = new Set<number>();
  /** Every token, in document order. */
  const tokens: ts.Node[] = [];
  /**
   * The insides of the blocks with no statements and the switches with no
   * clauses (see DirectivePlacement.emptyBlock), from just past the opening
   * brace to the block's end — from the `static` keyword on for a class
   * static block — in document order. Nothing but comments sits in such a
   * block, so no two of them overlap.
   */
  const emptyBlocks: Range[] = [];
  /** The JSDoc comments of every node tsc attaches some to, in document order. */
  const jsDocs: ts.JSDoc[][] = [];

  const collect = (found: readonly ts.CommentRange[] | undefined): void => {
    if (!found) return;
    for (const range of found) {
      if (seen.has(range.pos)) continue;
      seen.add(range.pos);
      ranges.push(range);
    }
  };

  // Iterative depth-first walk: generated or minified sources nest thousands
  // of expressions deep, where a recursive visitor overflows the call stack
  // even though the parse itself succeeded.
  const pending: ts.Node[] = [sourceFile];
  while (pending.length > 0) {
    const node = pending.pop() as ts.Node;
    if (ts.isJsxElement(node) || ts.isJsxFragment(node)) jsxParents.push(node);
    if ((ts.isBlock(node) && node.statements.length === 0) || (ts.isCaseBlock(node) && node.clauses.length === 0)) {
      // A block the parser had to make up, with no opening brace, holds nothing.
      const start = node.getStart(sourceFile);
      if (source[start] === "{") {
        // oxlint's no-empty-static-block counts the comments of the whole
        // static block, `static /* c */ {}` included (its span starts at the
        // keyword); no comment starts inside the keyword itself.
        const from = ts.isClassStaticBlockDeclaration(node.parent) ? node.parent.getStart(sourceFile) : start + 1;
        emptyBlocks.push({ start: from, end: node.end });
      }
    }
    // JSDoc nodes start inside the comment text itself; descending into them
    // would hide the comment (e.g. a trailing JSDoc attached to the
    // end-of-file token). Treat them as trivia like any other comment.
    const children: ts.Node[] = [];
    const docs: ts.JSDoc[] = [];
    for (const child of node.getChildren(sourceFile)) {
      if (ts.isJSDoc(child)) docs.push(child);
      else children.push(child);
    }
    if (docs.length > 0) jsDocs.push(docs);
    if (children.length === 0) {
      tokens.push(node);
      if (node.kind === ts.SyntaxKind.JsxText) {
        jsxTextSpans.push({ start: node.getFullStart(), end: node.getEnd() });
      }
      collect(ts.getLeadingCommentRanges(source, node.getFullStart()));
      // A JSX closing tag opens with the one token `</`, which getChildren
      // splits into `<` and `/` — and reads that slash as the start of a
      // comment where another slash follows it (`<//* note *​/div>`). The
      // comments after the token start past its slash.
      collect(ts.getTrailingCommentRanges(source, opensClosingTag(node) ? node.end + 1 : node.getEnd()));
      continue;
    }
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push(children[index] as ts.Node);
    }
  }

  // JsxText spans never overlap, so the one a position is inside is found by
  // binary search, keeping comment-dense TSX files out of quadratic time.
  jsxTextSpans.sort(byStart);
  const sorted = ranges.filter((range) => rangeAt(jsxTextSpans, range.pos) === undefined).sort((a, b) => a.pos - b.pos);

  // Directive rules with positional requirements (header pragmas, prettier's
  // first-comment docblock, Bun's file-start marker) get the comment's actual
  // placement; a shebang does not count as content before the first comment,
  // matching jest-docblock.
  const firstTokenStart = sourceFile.getStart(sourceFile);
  const tags = javascript ? typeTags(jsDocs) : NO_TYPE_TAGS;
  const shebangEnd = ts.getShebang(source)?.length ?? 0;
  const firstCommentPos = sorted.length > 0 ? (sorted[0] as ts.CommentRange).pos : -1;
  const bunMarkerPos = bunMarkerOffset(source);
  const emptyFile = holdsNoCode(sourceFile);
  // The token after a comment, past any further comments: no token overlaps
  // a comment, so it is the first one ending at or past the comment's end
  // (the end-of-file token ends at the text's end). Token ends never
  // decrease in document order, so a binary search finds it — without
  // skipping the leading trivia a token start would need.
  const tokenAfter = (offset: number): ts.Node =>
    tokens[firstIndexAtOrAfter(tokens, offset, (token) => token.end)] as ts.Node;
  const placementOf = (range: ts.CommentRange): DirectivePlacement => {
    // The switch slots walk the syntax tree, so they are worked out only for
    // the comments a switch-clause rule matched, when it asks.
    let slots: ReturnType<typeof switchSlots> | undefined;
    const slotsOf = (): ReturnType<typeof switchSlots> => (slots ??= switchSlots(tokenAfter(range.end)));
    const firstComment = range.pos === firstCommentPos;
    const jsDoc = tags.read.get(range.pos);
    return {
      header: range.pos < firstTokenStart,
      firstComment: firstComment && /^\s*$/.test(source.slice(shebangEnd, range.pos)),
      fileStart: range.pos === bunMarkerPos,
      // A comment opening the first row has only whitespace in front of it,
      // so only the first comment needs the check.
      fileWide: firstComment && isFileWidePosition(source, range.pos, range.end),
      emptyBlock: rangeAt(emptyBlocks, range.pos) !== undefined,
      emptyFile,
      ...(jsDoc === undefined ? {} : { jsDoc }),
      get fallthroughSlot() {
        return slotsOf().fallthroughSlot;
      },
      get noDefaultSlot() {
        return slotsOf().noDefaultSlot;
      },
    };
  };

  const directives = new Map<Comment, readonly string[]>();
  const comments = sorted.map((range): Comment => {
    const kind: CommentKind = range.kind === ts.SyntaxKind.SingleLineCommentTrivia ? "line" : "block";
    const text = source.slice(range.pos, range.end);
    const startPosition = sourceFile.getLineAndCharacterOfPosition(range.pos);
    const endPosition = sourceFile.getLineAndCharacterOfPosition(range.end);
    const names = directiveNames(kind, text, placementOf(range));
    const directive = names[0];
    const comment: Comment = {
      kind,
      text,
      start: range.pos,
      end: range.end,
      line: startPosition.line + 1,
      column: startPosition.character + 1,
      endLine: endPosition.line + 1,
      endColumn: endPosition.character + 1,
      ...(directive === undefined ? {} : { directive }),
    };
    if (directive !== undefined) directives.set(comment, names);
    return comment;
  });

  const preceding = new Map<Comment, PrecedingNode>();
  const typed = new Map<Comment, readonly string[]>();
  const shadows = new Map<Comment, Comment>();
  const casts = new Set<Comment>();
  const commentAt = (offset: number): Comment =>
    comments[firstIndexAtOrAfter(comments, offset, (comment) => comment.start)] as Comment;
  for (const [index, comment] of comments.entries()) {
    if (carriesAstGrepSuppression(comment.text)) {
      preceding.set(comment, precedingNode(sourceFile, tokens, comments[index - 1], comment.start));
    }
    const read = tags.read.get(comment.start);
    if (read !== undefined) typed.set(comment, read);
    const shadow = tags.shadows.get(comment.start);
    if (shadow !== undefined) shadows.set(comment, commentAt(shadow));
    if (directives.get(comment)?.some((name) => CAST_TAGS.has(name)) === true) {
      const next = tokenAfter(comment.end);
      if (next.kind === ts.SyntaxKind.OpenParenToken && ts.isParenthesizedExpression(next.parent)) casts.add(comment);
    }
  }

  return {
    comments,
    directives,
    jsx: jsxLayout(source, sourceFile, jsxParents, comments),
    preceding,
    typed,
    shadows,
    casts,
    importGroups: importGroupGaps(source, sourceFile, comments),
  };
}

/** Whether the token is the `<` that getChildren makes of the `</` opening a JSX closing tag. */
function opensClosingTag(token: ts.Node): boolean {
  return (
    token.kind === ts.SyntaxKind.LessThanToken &&
    (ts.isJsxClosingElement(token.parent) || ts.isJsxClosingFragment(token.parent))
  );
}

// The tags prettier's isTypeCastComment looks for (see the JSDoc type cast rule in directives.ts).
const CAST_TAGS: ReadonlySet<string> = new Set(["@type", "@satisfies"]);

// The JSDoc tags tsc reads types from in a JavaScript file, by the name a
// comment holding one is given. Aliases share a name: `@arg` and `@argument`
// are `@param`, `@return` is `@returns`, `@augments` is `@extends` and
// `@constructor` is `@class`. The tags tsc parses and reads nothing from
// (`@author`, `@deprecated`, `@see`, `@throws`) and the ones it does not know
// (`@example`, `@default`, ...) are absent: a comment holding only those is
// documentation.
const TYPE_TAGS: ReadonlyMap<ts.SyntaxKind, string> = new Map([
  [ts.SyntaxKind.JSDocTypedefTag, "@typedef"],
  [ts.SyntaxKind.JSDocCallbackTag, "@callback"],
  [ts.SyntaxKind.JSDocEnumTag, "@enum"],
  [ts.SyntaxKind.JSDocImportTag, "@import"],
  [ts.SyntaxKind.JSDocOverloadTag, "@overload"],
  [ts.SyntaxKind.JSDocTypeTag, "@type"],
  [ts.SyntaxKind.JSDocSatisfiesTag, "@satisfies"],
  [ts.SyntaxKind.JSDocParameterTag, "@param"],
  [ts.SyntaxKind.JSDocReturnTag, "@returns"],
  [ts.SyntaxKind.JSDocTemplateTag, "@template"],
  [ts.SyntaxKind.JSDocThisTag, "@this"],
  [ts.SyntaxKind.JSDocAugmentsTag, "@extends"],
  [ts.SyntaxKind.JSDocImplementsTag, "@implements"],
  [ts.SyntaxKind.JSDocClassTag, "@class"],
  [ts.SyntaxKind.JSDocPublicTag, "@public"],
  [ts.SyntaxKind.JSDocPrivateTag, "@private"],
  [ts.SyntaxKind.JSDocProtectedTag, "@protected"],
  [ts.SyntaxKind.JSDocReadonlyTag, "@readonly"],
  [ts.SyntaxKind.JSDocOverrideTag, "@override"],
]);

// The tags that declare something of their own — a type, an import, a
// signature — which tsc binds from every JSDoc comment of a node. The other
// tags describe the node, and tsc applies those from the node's last JSDoc
// comment alone (`filterOwnedJSDocTags` in its utilities.ts), though it
// checks the types of every one, and counts what they refer to as used.
const DECLARING_TAGS: ReadonlySet<string> = new Set(["@typedef", "@callback", "@enum", "@import", "@overload"]);

/** The type tags of JSDoc comments, by the offset the comment starts at. */
interface TypeTags {
  /** The names of the tags tsc reads from the comment (see TYPE_TAGS). */
  read: ReadonlyMap<number, readonly string[]>;
  /** For a comment holding tags a later one of its node keeps off the node, where that later comment starts. */
  shadows: ReadonlyMap<number, number>;
}

const NO_TYPE_TAGS: TypeTags = { read: new Map(), shadows: new Map() };

/**
 * What tsc reads from the JSDoc comments of a JavaScript file, given the
 * comments of every node it attaches some to. A comment no node holds — one
 * in front of a closing brace, or sharing the line of the token before it —
 * is not among them, and tsc reads nothing from it.
 */
function typeTags(jsDocs: readonly (readonly ts.JSDoc[])[]): TypeTags {
  const read = new Map<number, readonly string[]>();
  const shadows = new Map<number, number>();
  for (const docs of jsDocs) {
    const last = docs.at(-1) as ts.JSDoc;
    for (const doc of docs) {
      const names = (doc.tags ?? []).flatMap((tag) => typeTagName(tag) ?? []);
      if (names.length > 0) read.set(doc.pos, [...new Set(names)]);
      if (doc !== last && names.some((name) => !DECLARING_TAGS.has(name))) shadows.set(doc.pos, last.pos);
    }
  }
  return { read, shadows };
}

/**
 * The name of the tag when tsc reads it. A `@returns` without a type says
 * nothing. A `@param` without one still does: a function with any `@param`
 * tag has the parameters it declares, each required unless its tag says
 * otherwise, where one without takes any number of arguments.
 */
function typeTagName(tag: ts.JSDocTag): string | undefined {
  if (ts.isJSDocReturnTag(tag) && tag.typeExpression === undefined) return undefined;
  return TYPE_TAGS.get(tag.kind);
}

/**
 * What stands in front of the comment at `offset` in tree-sitter's tree.
 * tree-sitter puts a comment in the innermost node with code on both sides
 * of it, so the comment's previous sibling is the comment right before it
 * when no token stands between them, and otherwise the outermost node that
 * ends with the token before it. TypeScript's nodes end where tree-sitter's
 * do, except that tree-sitter's automatic semicolon can take a trailing
 * comment into its statement, which makes the sibling smaller and starting
 * no earlier: the start read off here is never on a later row.
 */
function precedingNode(
  sourceFile: ts.SourceFile,
  tokens: readonly ts.Node[],
  previous: Comment | undefined,
  offset: number,
): PrecedingNode {
  // Empty lists are leaves too, as are missing tokens; neither holds text.
  let index = firstIndexAtOrAfter(tokens, offset + 1, (token) => token.end) - 1;
  while (index >= 0 && (tokens[index] as ts.Node).getStart(sourceFile) >= (tokens[index] as ts.Node).end) index -= 1;
  const token = tokens[index];
  const tokenEnd = token?.end ?? 0;
  if (previous !== undefined && previous.end > tokenEnd) return { start: previous.start, tokenEnd };
  if (token === undefined) return { tokenEnd };
  let node = token;
  while (!ts.isSourceFile(node.parent) && node.parent.end === token.end) node = node.parent;
  return { start: node.getStart(sourceFile), tokenEnd };
}

/**
 * The switch slots (see DirectivePlacement) a comment in front of the given
 * token sits in. The token is what follows the comment past any further
 * comments — the end-of-file token at the latest, whose parent is the file.
 */
function switchSlots(token: ts.Node): { fallthroughSlot: boolean; noDefaultSlot: boolean } {
  let fallthroughSlot = false;
  let noDefaultSlot = false;
  const parent = token.parent;
  if (
    (token.kind === ts.SyntaxKind.CaseKeyword || token.kind === ts.SyntaxKind.DefaultKeyword) &&
    ts.isCaseOrDefaultClause(parent)
  ) {
    // In front of a clause: where ESLint, oxlint and deno_lint read the
    // comment saying the clause before it falls through — so not the first.
    fallthroughSlot = parent.parent.clauses[0] !== parent;
  } else if (
    token.kind === ts.SyntaxKind.CloseBraceToken &&
    ts.isBlock(parent) &&
    ts.isCaseOrDefaultClause(parent.parent)
  ) {
    // Inside a block that is the last statement of a clause (its only one,
    // for ESLint and oxlint), in front of its closing brace — read when
    // another clause follows.
    const clause = parent.parent;
    const clauses = clause.parent.clauses;
    fallthroughSlot = clause.statements.at(-1) === parent && clauses.at(-1) !== clause;
  } else if (token.kind === ts.SyntaxKind.CloseBraceToken && ts.isCaseBlock(parent)) {
    // After the last clause of a switch, in front of its closing brace:
    // where ESLint's default-case reads its comment.
    noDefaultSlot = lacksDefaultClause(parent);
  }
  // oxlint's default-case reads the last comment from the last clause's
  // start to the switch's end, so the comments inside that clause count too
  // — all but one in front of the clause's opening `case`.
  for (let node = parent; !noDefaultSlot && !ts.isSourceFile(node); node = node.parent) {
    noDefaultSlot =
      ts.isCaseClause(node) &&
      node.parent.clauses.at(-1) === node &&
      lacksDefaultClause(node.parent) &&
      (node !== parent || token.kind !== ts.SyntaxKind.CaseKeyword);
  }
  return { fallthroughSlot, noDefaultSlot };
}

/** Whether the switch has clauses but none of them is a default clause. */
function lacksDefaultClause(caseBlock: ts.CaseBlock): boolean {
  return caseBlock.clauses.length > 0 && !caseBlock.clauses.some(ts.isDefaultClause);
}

/**
 * Whether the file holds no code, as the no-empty-file rules of oxlint and
 * eslint-plugin-unicorn read it (see DirectivePlacement.emptyFile): every
 * statement is an empty one or a block of nothing else, past the directive
 * prologue — the string-literal statements that open the file.
 */
function holdsNoCode(sourceFile: ts.SourceFile): boolean {
  let prologue = true;
  return sourceFile.statements.every((statement) => {
    prologue &&= ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression);
    return prologue || isEmptyStatement(statement);
  });
}

function isEmptyStatement(statement: ts.Statement): boolean {
  return ts.isEmptyStatement(statement) || (ts.isBlock(statement) && statement.statements.every(isEmptyStatement));
}
