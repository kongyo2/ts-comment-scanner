import ts from "typescript";
import { LINE_TERMINATOR, closesItsLine, isBlank, opensItsLine } from "./lines.js";
import { firstIndexAtOrAfter, rangesWithin, type Range } from "./ranges.js";
import type { Comment } from "./types.js";

/**
 * How the formatters that read the comments between two pieces of code one
 * after another decide which of the two a suppression belongs to.
 *
 * Prettier settles a comment that opens or ends its line on its own, by the
 * line breaks around the run of comments it stands in on that line. One with
 * code on both sides it reads with the comments behind it, as Biome does in
 * front of parentheses (see tiedBehind).
 * oxfmt and Biome go through the comments between two sibling nodes in order
 * instead, the tokens between the nodes notwithstanding — the `,` after an
 * element, the operator of a binary expression, the `=` of an initializer,
 * the `;` a statement ends with:
 *
 * - oxfmt (`get_trailing_comments` in oxc_formatter's formatter/comments.rs)
 *   takes the first comment a line break touches. With a line break in front
 *   of it, it and every comment after it lead the node that follows; with one
 *   only behind it, the comments up to it trail the node in front, and the
 *   rest lead the next. A suppression among the leading ones leaves the next
 *   node as written. So in
 *
 *       a = [ 1,2 ]
 *       // note
 *       , // oxfmt-ignore
 *       b = [ 3,4 ]
 *
 *   the note makes the suppression lead `b`, and without the note the
 *   suppression ends the line of the `,` and trails `a`. Where no line break
 *   touches a comment before the suppression, a suppression in the middle of
 *   its line goes by the first comment after it that one touches, and its
 *   node is left as written when the comments from it on end their line
 *   (`has_trailing_suppression_comment`).
 * - Biome reads the comments between the members of a union type that way
 *   (`is_type_suppressed` in its union_type_variant_list.rs): the comments
 *   after a member belong to it up to the first one a line break precedes,
 *   and from that one on to the next member.
 *
 * Biome also holds a comment back before it places it (`visit_token` in
 * biome_formatter's comments/builder.rs): a comment waits at the token after
 * it until a node starts or ends, and every token read while it waits — the
 * second `;` of a `for` without a condition, the `(` after the `while` of a
 * `do` loop — turns it into a comment that ends its line where a line break
 * stands in front of that token. Such a comment trails the node in front of
 * it where it led the node behind before, and so does its suppression:
 *
 *     for (i = [ 1,2 ]
 *     // biome-ignore format: x
 *     ; /* note
 *     *​/ ; i += a( 3,4 )) {}
 *
 * leaves the update as written, and with a line break in place of the note
 * the initializer.
 *
 * Checked against Prettier 3.10.1, oxfmt 0.79.0 and 0.80.0 and Biome 2.6.9.
 */

// Nodes of TypeScript's tree that the formatters' trees have no counterpart
// for, so that a token one of them starts or ends with stands between two
// sibling nodes to a formatter: parentheses, which oxfmt's parser drops; the
// braces of named imports and exports, of a switch and of a computed name;
// the `extends` and `implements` of a class; the `*` of `export * as ns`.
const TRANSPARENT: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.ParenthesizedExpression,
  ts.SyntaxKind.ParenthesizedType,
  ts.SyntaxKind.NamedImports,
  ts.SyntaxKind.NamedExports,
  ts.SyntaxKind.NamespaceExport,
  ts.SyntaxKind.ImportClause,
  ts.SyntaxKind.CaseBlock,
  ts.SyntaxKind.HeritageClause,
  ts.SyntaxKind.ComputedPropertyName,
]);

// The keywords that are expressions of their own.
const VALUE_KEYWORDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.ThisKeyword,
  ts.SyntaxKind.SuperKeyword,
  ts.SyntaxKind.NullKeyword,
  ts.SyntaxKind.TrueKeyword,
  ts.SyntaxKind.FalseKeyword,
]);

// The brackets no comment crosses to oxfmt: those of a call's arguments, of
// the head of an `if` or a loop and of a body (the "delimiters" of its
// AGENTS.md), unlike the parentheses around an expression, which it drops,
// and the ones it reads on over all the same (see CROSSED).
const DELIMITERS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.OpenParenToken,
  ts.SyntaxKind.CloseParenToken,
  ts.SyntaxKind.OpenBraceToken,
  ts.SyntaxKind.CloseBraceToken,
]);

// What a bracket belongs to that oxfmt reads on over: a node that is none
// to it; a switch, where the discriminant and the first clause are the nodes
// next to each other; a `new` expression, whose callee takes the comments
// behind the `(` for its own, as the type arguments of a call do (see
// delimits).
const CROSSED: ReadonlySet<ts.SyntaxKind> = new Set([
  ...TRANSPARENT,
  ts.SyntaxKind.SwitchStatement,
  ts.SyntaxKind.NewExpression,
]);

/** Whether the token is a bracket no comment crosses to oxfmt (see DELIMITERS). */
function delimits(token: ts.Node): boolean {
  const owner = token.parent;
  return (
    DELIMITERS.has(token.kind) &&
    !CROSSED.has(owner.kind) &&
    !(ts.isCallExpression(owner) && owner.typeArguments !== undefined)
  );
}

/** Whether the token is a node itself: a name, a literal, a keyword that is an expression or a type. */
function isNode(token: ts.Node): boolean {
  return (
    ts.isIdentifier(token) ||
    ts.isPrivateIdentifier(token) ||
    ts.isLiteralExpression(token) ||
    ts.isTemplateLiteralToken(token) ||
    ts.isTypeNode(token) ||
    VALUE_KEYWORDS.has(token.kind)
  );
}

/**
 * Whether a node of the formatters' trees starts or ends with the token: the
 * token is one itself (a name, a literal, a keyword that is an expression or
 * a type), it is a bracket that delimits one (see DELIMITERS), or a node
 * that is no mere wrapper to them (see TRANSPARENT) shares its start or its
 * end. Any other token — a separator, an operator, `else`, `from` — stands
 * between the nodes around it.
 */
function edgesNode(token: ts.Node, sourceFile: ts.SourceFile): boolean {
  const start = token.getStart(sourceFile);
  // An empty list and a missing token hold no text, and edge nothing. Nor
  // does the `with` of import attributes: oxc's with clause starts at its `{`.
  if (start >= token.end || (ts.isImportAttributes(token.parent) && start === token.parent.getStart(sourceFile))) {
    return false;
  }
  if (isNode(token) || delimits(token)) return true;
  // The `)` that oxfmt drops closes around a node that ended in front of it.
  if (token.kind === ts.SyntaxKind.CloseParenToken && TRANSPARENT.has(token.parent.kind)) return false;
  for (
    let node = token.parent;
    !ts.isSourceFile(node) && (node.end === token.end || node.getStart(sourceFile) === start);
    node = node.parent
  ) {
    if (!TRANSPARENT.has(node.kind)) return true;
  }
  return false;
}

/**
 * The stretch a formatter reads the comment's neighbours in (see above):
 * from the end of the node in front of the comment to the start of the node
 * behind it, across the tokens that belong to neither. A `;` is such a token
 * in front of the comment — oxfmt keeps the comments before a statement's own
 * `;` for the statement after it — and ends the stretch behind it. Where
 * TypeScript's tree has no node for one of the formatters' (the angle
 * brackets around type parameters and type arguments), the stretch runs on
 * to the next node edge, which only takes more comments in.
 */
export function stretchBetweenNodes(sourceFile: ts.SourceFile, tokens: readonly ts.Node[], comment: Range): Range {
  let start = 0;
  for (let index = firstIndexAtOrAfter(tokens, comment.start + 1, (token) => token.end) - 1; index >= 0; index -= 1) {
    const token = tokens[index] as ts.Node;
    if (token.kind !== ts.SyntaxKind.SemicolonToken && edgesNode(token, sourceFile)) {
      start = token.end;
      break;
    }
  }
  let end = sourceFile.text.length;
  for (let index = firstIndexAtOrAfter(tokens, comment.end, (token) => token.end); index < tokens.length; index += 1) {
    const token = tokens[index] as ts.Node;
    if (token.kind === ts.SyntaxKind.SemicolonToken || edgesNode(token, sourceFile)) {
      end = token.getStart(sourceFile);
      break;
    }
  }
  return { start, end };
}

/**
 * Whether a node of Biome's tree starts with the token for certain: the
 * token is a node itself, or a node of TypeScript's tree starts with it. The
 * `target` of `new.target` and the `meta` of `import.meta` are tokens to
 * Biome, and so are the braces of a switch.
 */
function startsNode(token: ts.Node, sourceFile: ts.SourceFile): boolean {
  if (isNode(token)) return !ts.isMetaProperty(token.parent);
  const start = token.getStart(sourceFile);
  for (let node = token.parent; !ts.isSourceFile(node) && node.getStart(sourceFile) === start; node = node.parent) {
    if (!ts.isCaseBlock(node)) return true;
  }
  return false;
}

/**
 * The stretch behind the comment across which Biome holds the comment back
 * (see above): from the end of the token after the comment to the start of
 * the first token behind that one which starts a node. A line break that
 * comes to stand between two tokens there changes how Biome places the
 * comment. Empty where the token after the comment starts a node itself.
 * Where Biome's tree starts a node that TypeScript's has none for (the
 * parentheses of a call's arguments), the stretch runs on to the next node,
 * which only takes more comments in.
 */
export function stretchHeldBack(sourceFile: ts.SourceFile, tokens: readonly ts.Node[], comment: Range): Range {
  let start: number | undefined;
  for (let index = firstIndexAtOrAfter(tokens, comment.end, (token) => token.end); index < tokens.length; index += 1) {
    const token = tokens[index] as ts.Node;
    const tokenStart = token.getStart(sourceFile);
    // An empty list and a missing token hold no text, and Biome reads none there.
    if (tokenStart >= token.end) continue;
    if (startsNode(token, sourceFile)) return { start: start ?? tokenStart, end: tokenStart };
    start ??= token.end;
  }
  return { start: start ?? sourceFile.text.length, end: sourceFile.text.length };
}

/** The comments within the span, in the runs that the tokens between them divide them into. */
function runsWithin(source: string, comments: readonly Comment[], span: Range): Comment[][] {
  const runs: Comment[][] = [];
  let end = span.start;
  for (const comment of rangesWithin(comments, span)) {
    if (runs.length === 0 || !isBlank(source.slice(end, comment.start))) runs.push([]);
    (runs.at(-1) as Comment[]).push(comment);
    end = comment.end;
  }
  return runs;
}

// The code between a member of a union type and a comment right behind the
// `|` after it: the bar, past the parentheses that close around the member.
const BEHIND_BAR = /^\)*\|$/;
// The code between a comment behind such parentheses and the next member:
// to Biome a closing parenthesis starts the count of the line breaks in
// front of a comment anew, so the comments inside decide for the one behind.
const IN_FRONT_OF_BAR = /^\|\(*$/;

/**
 * The comments of the suppression's stretch, in front of it and behind it,
 * as far as a formatter's reading of the suppression depends on them:
 *
 * - None where the comments the suppression shares its line with open that
 *   line: the first of them that stays, or the suppression itself, leads the
 *   code after it then, whatever else stands around.
 * - None where the suppression stands right in front of the node behind it,
 *   on its line, past comments and opening parentheses at most: it leads
 *   that node whatever stands before. In front of a `;` it leads none.
 * - Else those in front, and those behind where no line break follows the
 *   suppression.
 *
 * That is oxfmt's reading (`everywhere`). Biome reads the comments one
 * after another between the members of a union type alone — behind the bar
 * between two members, or behind the parentheses that close around the
 * first of them — and never those behind the suppression.
 *
 * Behind an assignment target in parentheses, oxfmt takes the comments in
 * front of the operator together (`target`, where the suppression is among
 * them): the `)` keeps them off the end of the target's line, and where a
 * line break precedes one of them, all of them move over to the right-hand
 * side (`format_left_trailing_comments` in its utils/assignment_like.rs).
 */
export function commentsAround(
  source: string,
  comments: readonly Comment[],
  suppression: Comment,
  stretch: Range,
  everywhere: boolean,
): { before: Comment[][]; after: Comment[][]; target: Comment[] } {
  const front = { start: stretch.start, end: suppression.start };
  const back = { start: suppression.end, end: stretch.end };
  let first = firstIndexAtOrAfter(comments, suppression.start, (comment) => comment.start);
  while (first > 0 && sharesLine(source, comments[first - 1] as Comment, comments[first] as Comment)) first -= 1;
  const leads =
    opensItsLine(source, comments[first] as Comment) ||
    (source[stretch.end] !== ";" &&
      !LINE_TERMINATOR.test(source.slice(back.start, back.end)) &&
      /^\(*$/.test(codeWithin(source, comments, back)));
  const inUnion =
    BEHIND_BAR.test(codeWithin(source, comments, front)) ||
    (/^\)+$/.test(codeWithin(source, comments, front)) && IN_FRONT_OF_BAR.test(codeWithin(source, comments, back)));
  if (leads || !(everywhere || inUnion)) return { before: [], after: [], target: [] };
  const target = everywhere ? behindTarget(source, comments, stretch) : [];
  return {
    before: runsWithin(source, comments, front),
    after: everywhere && !closesItsLine(source, suppression) ? runsWithin(source, comments, back) : [],
    target: target.includes(suppression) ? target : [],
  };
}

/**
 * The comments of the stretch in front of an assignment operator, where
 * nothing but closing parentheses stands between them and the target in
 * front: the ones oxfmt takes together there (see commentsAround). None
 * where the stretch is no such place.
 */
function behindTarget(source: string, comments: readonly Comment[], stretch: Range): Comment[] {
  const within = rangesWithin(comments, stretch);
  let closed = false;
  for (const [index, comment] of [...within, { start: stretch.end }].entries()) {
    const from = index === 0 ? stretch.start : (within[index - 1] as Comment).end;
    const code = source.slice(from, comment.start).replace(/\s+/g, "");
    const rest = code.replace(/^\)+/, "");
    closed ||= rest !== code;
    if (rest !== "") return closed && ASSIGNMENT_OPERATOR.test(rest) ? within.slice(0, index) : [];
  }
  return [];
}

// What Prettier reads on over from a comment to the node behind it: blanks and opening parentheses.
const TIE_GAP = /^[\s(]*$/;

/**
 * The comments behind a suppression that Prettier and Biome read it with,
 * where code stands on both sides of the suppression on its line: those up
 * to the node behind it, past blanks and opening parentheses.
 *
 * - Prettier takes such a comment for one that leads the node behind it only
 *   where nothing but blanks, opening parentheses and comments placed like
 *   it stand in between (`breakTies` in its main/comments/attach.js); a
 *   comment in between that opens its line or ends it makes the suppression
 *   trail the node in front instead. So in
 *
 *       f /* prettier-ignore *​/ (
 *         // note
 *         a( 1,2 ));
 *
 *   the note keeps the argument formatted.
 * - Biome drops the parentheses around an expression, and the line break
 *   behind the `(` with them unless a comment stands between the `(` and
 *   the expression (`visit_parenthesized` in biome_js_formatter's
 *   syntax_rewriter.rs). With that line break a suppression in front of the
 *   `(` ends its line, and trails the node in front of it; without, it leads
 *   the expression.
 *
 * None where the suppression, with the comments it shares its line with,
 * opens that line or ends it: both place it by that alone then.
 */
export function tiedBehind(source: string, comments: readonly Comment[], suppression: Comment): Comment[] {
  const at = firstIndexAtOrAfter(comments, suppression.start, (comment) => comment.start);
  let first = at;
  while (first > 0 && sharesLine(source, comments[first - 1] as Comment, comments[first] as Comment)) first -= 1;
  let last = at;
  while (last + 1 < comments.length && sharesLine(source, comments[last] as Comment, comments[last + 1] as Comment)) {
    last += 1;
  }
  if (opensItsLine(source, comments[first] as Comment) || closesItsLine(source, comments[last] as Comment)) return [];
  const behind: Comment[] = [];
  for (let index = at + 1; index < comments.length; index += 1) {
    const comment = comments[index] as Comment;
    if (!TIE_GAP.test(source.slice((comments[index - 1] as Comment).end, comment.start))) break;
    behind.push(comment);
  }
  return behind;
}

/** The code of the span: its text outside the comments, without the blanks. */
function codeWithin(source: string, comments: readonly Comment[], span: Range): string {
  let code = "";
  let from = span.start;
  for (const comment of rangesWithin(comments, span)) {
    code += source.slice(from, comment.start);
    from = comment.end;
  }
  return (code + source.slice(from, span.end)).replace(/\s+/g, "");
}

/** Whether nothing but blanks, and no line break, holds the two comments apart. */
function sharesLine(source: string, comment: Comment, next: Comment): boolean {
  const gap = source.slice(comment.end, next.start);
  return isBlank(gap) && !LINE_TERMINATOR.test(gap);
}

/**
 * The comments that have to stay for the suppression to belong to the code
 * it does, given the ones that stay anyway (`stays`):
 *
 * - In a run in front of the suppression, behind a token of its own, a line
 *   break next to a comment decides that the suppression leads the node
 *   after it. A comment the line break ends up next to has to stay: one from
 *   the first that a line break precedes on, or any where a line break only
 *   follows the last. The run the suppression stands in itself needs none,
 *   as the suppression takes the line break over.
 * - In a run behind the suppression, the first comment that a line break
 *   touches decides. Where one precedes it, it opens the run, and any
 *   comment of the run that stays opens it the same way; where one only
 *   follows it, a comment up to it has to stay to end that line. In front
 *   of an assignment operator (`=`, `+=`, `??=` and the like), that has to
 *   be one that spans lines where the decider does, and only then: oxfmt
 *   moves the comments of a line that a block comment spanning lines ends
 *   over to the right-hand side (`format_left_trailing_comments` in its
 *   utils/assignment_like.rs). The code between the suppression and the run
 *   tells whether the run is read at all: one that opens its line counts
 *   past opening parentheses alone (anything else makes the suppression
 *   trail the node in front already). One that ends a line counts past
 *   opening parentheses, where it makes the suppression trail the node in
 *   front, and past `=`, `:` and `,` alone, the tokens oxfmt reads on over
 *   to the end of the suppression's line.
 *
 * The last comment of a run in front, and the deciding one behind, stay
 * where none that serves does. Behind an assignment target in parentheses
 * (see commentsAround), one of the comments that open their line stays, the
 * first, unless one that stays opens its line.
 */
export function deciders(
  source: string,
  comments: readonly Comment[],
  suppression: Comment,
  { before, after, target }: ReturnType<typeof commentsAround>,
  stays: (comment: Comment) => boolean,
): Comment[] {
  const found: Comment[] = [];
  const openers = target.filter((comment) => opensItsLine(source, comment));
  if (openers.length > 0 && !openers.some(stays)) found.push(openers[0] as Comment);
  for (const run of before) {
    const last = run.at(-1) as Comment;
    if (isBlank(source.slice(last.end, suppression.start))) continue;
    const first = run.findIndex((comment) => opensItsLine(source, comment));
    const serving = first !== -1 ? run.slice(first) : closesItsLine(source, last) ? run : [];
    if (serving.length > 0 && !serving.some(stays)) found.push(last);
  }
  for (const run of after) {
    const first = run.findIndex((comment) => opensItsLine(source, comment) || closesItsLine(source, comment));
    if (first === -1) continue;
    const decider = run[first] as Comment;
    const between = codeWithin(source, comments, { start: suppression.end, end: decider.start });
    const ender = run.slice(0, first + 1).findLast(stays);
    let serves: boolean;
    if (opensItsLine(source, decider)) {
      serves = !/^\(*$/.test(between) || run.some(stays);
    } else if (/^\(+$/.test(between)) {
      serves = ender !== undefined;
    } else {
      serves =
        !/^[=:,]*$/.test(between) ||
        (ender !== undefined &&
          (spansLines(ender) === spansLines(decider) || !precedesAssignment(source, comments, run.at(-1) as Comment)));
    }
    if (!serves) found.push(decider);
  }
  return found;
}

// An assignment operator: `=`, alone or behind the operator it compounds.
const ASSIGNMENT_OPERATOR = /^(?:\*\*|<<|>>>?|&&|\|\||\?\?|[-+*/%&|^])?=/;

/**
 * Whether an assignment operator is the first code behind the comment, past
 * the parentheses that close around the target and the comments in between.
 */
function precedesAssignment(source: string, comments: readonly Comment[], comment: Comment): boolean {
  let index = comment.end;
  for (let next = firstIndexAtOrAfter(comments, index, (other) => other.start); ; next += 1) {
    while (index < source.length && (source[index] === ")" || isBlank(source[index] as string))) index += 1;
    if (comments[next]?.start !== index) break;
    index = (comments[next] as Comment).end;
  }
  return ASSIGNMENT_OPERATOR.test(source.slice(index, index + 4));
}

/** Whether the comment is a block comment that spans lines. */
function spansLines(comment: Comment): boolean {
  return LINE_TERMINATOR.test(comment.text);
}
