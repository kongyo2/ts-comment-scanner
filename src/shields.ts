import { astGrepReach, rowStartOffsets, type AstGrepReach, type PrecedingNode } from "./astgrep.js";
import { commentsOf, removalUnits, type Container, type RemovalUnit } from "./containers.js";
import { hintsNextNode, monocartLines, opensRow, textHints } from "./coverage.js";
import { carriesAstGrepSuppression } from "./directives.js";
import { closesItsLine, isBlank, lineIndexAt, lineStartOffsets, occupiesWholeLines, opensItsLine } from "./lines.js";
import { byStart, firstIndexAtOrAfter, rangeAt, type Range } from "./ranges.js";
import type { Comment } from "./types.js";

/** What the shields read of a source besides its text. */
export interface ShieldContext {
  /** The source's comments, in document order. */
  comments: readonly Comment[];
  /** The comment-only JSX container each comment in one sits in. */
  containerOf: ReadonlyMap<Comment, Container>;
  /** Comments and the containers that may go with theirs, sorted: what code starts after. */
  skippable: readonly Range[];
  /** What stands in front of each comment carrying an ast-grep suppression (see SourceAnalysis). */
  preceding: ReadonlyMap<Comment, PrecedingNode>;
  /** Every directive each directive comment carries (see SourceAnalysis). */
  directives: ReadonlyMap<Comment, readonly string[]>;
  /** The JSDoc comment that keeps the tags of an earlier one off their node (see SourceAnalysis). */
  shadows: ReadonlyMap<Comment, Comment>;
  /** The cast comments a parenthesized expression follows (see SourceAnalysis). */
  casts: ReadonlySet<Comment>;
}

export interface Shielding {
  /** The removals that remain once the comments the directives need are kept. */
  removed: Comment[];
  /**
   * Lines (1-based) that a surviving directive reaches: the ones below a
   * next-line directive, the ones a line directive stands on and the ones a
   * coverage hint counts. Each stays a line of its own (see ShieldedLines).
   */
  lines: Set<number>;
}

/**
 * A stretch between a directive and the code after it in which a comment
 * has to stay, because the directive only counts while none stands there
 * (see NEXT_TOKEN_DIRECTIVES) or while it is the last one in front of that
 * code (see LAST_COMMENT_DIRECTIVES). One comment does: the first for the
 * former, on the directive's own line where one stands there, and the last
 * for the latter.
 */
interface Gap extends Range {
  stays: "first" | "last";
  /** The line the directive ends on. */
  line: number;
}

/**
 * A directive whose reach depends on what stands in front of it on its row:
 * the tool applies it to the lines `from` to `to` (1-based) when `reaches`
 * accepts the text between the row's start and the directive.
 */
interface Front {
  rowStart: number;
  at: number;
  reaches: (prefix: string) => boolean;
  from: number;
  to: number;
}

/**
 * Finds what the directives that stay need the removal to leave in place,
 * so that each applies to the same code afterwards, and keeps the comments
 * among it.
 *
 * Most directives reach lines: the line below a next-line directive
 * (`@ts-expect-error`, `eslint-disable-next-line`, ...), the lines a line
 * directive (`eslint-disable-line`, `nosemgrep` after code, ...) stands on,
 * the lines a coverage hint counts. Those lines are shielded: emptied, one
 * stays as an empty line, and none is joined to another — the removal edits
 * see to both (see ShieldedLines), so the comments on them go all the same.
 * Only a comment-only JSX container that would join such a line keeps its
 * comments, as a line break in its place would change what the element
 * renders. To the tools that only a line feed ends a line for (oxlint,
 * Semgrep, ast-grep, c8, Node's test runner), a directive reaches rows that
 * can run over several of those lines, and their lines are shielded as well.
 *
 * Other directives are read with the comments around them, and there a
 * comment has to stay:
 *
 * - below a tsc suppression, the first line each compiler cannot step over
 *   in front of the code (see tscReach);
 * - between a directive that only counts as the last comment before its
 *   target (`@deno-types`, a fall-through comment, ...), or a coverage hint
 *   that ast-v8-to-istanbul only applies to the node right after it, and
 *   that target, one comment (see Gap);
 * - in front of a directive that reaches the lines below only where it
 *   opens its row, one comment that keeps it from opening it, where those
 *   lines hold code (see Front);
 * - a JSX comment container right after a directive in a container
 *   (`{/* prettier-ignore *​/}`, which applies to the next sibling);
 * - the last JSDoc comment of a node in JavaScript, where an earlier one
 *   that stays holds tags it keeps off the node;
 * - what an ast-grep suppression is keyed to (see astGrepReach).
 *
 * Each directive a comment carries shields what it reaches, whichever one
 * names the comment. Runs to a fixpoint because a comment kept here can
 * itself be a directive (when directives are being removed selectively).
 */
export function shieldDirectives(
  source: string,
  removed: Comment[],
  kept: Comment[],
  skipped: Comment[],
  context: ShieldContext,
): Shielding {
  const lineOffsets = lineStartOffsets(source);
  const totalLines = lineOffsets.length;
  const shieldedLines = new Set<number>();
  const blockingLines = new Set<number>();
  const gaps: Gap[] = [];
  const fronts: Front[] = [];
  const siblingTargets = new Set<Container>();
  const rowTails: Range[] = [];
  const shadows = new Set<Comment>();
  const astGrepReaches: AstGrepReach[] = [];
  const processed = new Set<Comment>();
  // The hints c8 and Node find in the text, until the comment holding one is known to stay.
  let pendingHints = source.includes("ignore next") ? textHints(source) : [];
  // Where a comment tsc reads a suppression from ends: tsc stops there on its
  // way up from a diagnostic, as it does at a line it cannot step over.
  const suppressions = new Map<number, Comment[]>();
  for (const [comment, names] of context.directives) {
    if (names.some((name) => TSC_SUPPRESSIONS.has(name))) {
      suppressions.set(comment.endLine, [...(suppressions.get(comment.endLine) ?? []), comment]);
    }
  }
  let stillRemoved = removed;
  const removing = new Set(removed);
  let units: RemovalUnit[] | undefined;
  const currentUnits = (): RemovalUnit[] => (units ??= removalUnits(stillRemoved, context.containerOf));
  let rows: number[] | undefined;
  const rowOffsets = (): number[] => (rows ??= rowStartOffsets(source));
  /** The (1-based) line holding the offset. */
  const lineOf = (offset: number): number => lineIndexAt(lineOffsets, offset) + 1;
  /** The given (1-based) line, which the shields only name when the source has it, and the units on it. */
  const unitsOnLine = (line: number): LineUnits => {
    const start = lineOffsets[line - 1] as number;
    const end = lineOffsets[line] ?? source.length;
    return { start, end, units: currentUnits().filter((unit) => unit.start < end && unit.end > start) };
  };
  /** Whether the lines (1-based, inclusive, each one the source has) hold nothing but whitespace and comments. */
  const holdNoCode = (from: number, to: number): boolean => {
    const end = lineOffsets[to] ?? source.length;
    for (let index = lineOffsets[from - 1] as number; index < end; index += 1) {
      const comment = rangeAt(context.comments, index);
      if (comment !== undefined) index = comment.end - 1;
      else if (!isBlank(source[index] as string)) return false;
    }
    return true;
  };

  let added = false;
  const shieldLines = (from: number, to: number): void => {
    for (let line = from; line <= Math.min(to, totalLines); line += 1) {
      if (shieldedLines.has(line)) continue;
      shieldedLines.add(line);
      added = true;
    }
  };
  /** Shields the lines of the rows (0-based, inclusive) that only a line feed ends. */
  const shieldRows = (from: number, to: number): void => {
    const offsets = rowOffsets();
    const start = offsets[from];
    if (start !== undefined) shieldLines(lineOf(start), lineOf((offsets[to + 1] ?? source.length) - 1));
  };

  /** Collects what one of the directives the comment carries reaches. */
  const shieldReach = (comment: Comment, directive: string): void => {
    const lastComment = isLastCommentDirective(comment, directive);
    const cast = CAST_DIRECTIVES.has(directive) && context.casts.has(comment);
    if (lastComment || cast || (NEXT_TOKEN_DIRECTIVES.has(directive) && hintsNextNode(comment.text))) {
      const codeStart = codeStartAfter(source, comment.end, context.skippable);
      if (codeStart > comment.end && codeStart < source.length) {
        gaps.push({
          start: comment.end,
          end: codeStart,
          stays: lastComment || cast ? "last" : "first",
          line: comment.endLine,
        });
        added = true;
      }
      if (lastComment) return;
    }
    if (TSC_SUPPRESSIONS.has(directive)) {
      const reach = tscReach(source, comment, lineOffsets, context.skippable, (line) =>
        suppressions.get(line)?.map((suppression) => removing.has(suppression)),
      );
      for (const line of reach.blocking) {
        if (blockingLines.has(line)) continue;
        blockingLines.add(line);
        added = true;
      }
      if (reach.target !== undefined) shieldLines(reach.target, reach.target);
    }
    // The row the comment ends on, for the tools that only a line feed ends
    // a line for (oxlint, Semgrep, tree-sitter, c8): a lone CR, U+2028 or
    // U+2029 — a line break to tsc and ESLint — ends no row, so a row can run
    // over several of the lines counted here.
    const endRow = lineIndexAt(rowOffsets(), comment.end - 1);
    // A line directive covers the lines it stands on, which no removal may
    // join to another (see joiningUnits): its rows, to those tools.
    if (coversOwnLine(directive)) shieldRows(lineIndexAt(rowOffsets(), comment.start), endRow);
    if (!isNextLineDirective(directive)) return;
    // In JSX, such a directive in braces applies to the sibling after it,
    // whatever line that is on (prettier leaves the element after
    // `{/* prettier-ignore */}` as is): a comment-only container standing
    // between them has to stay. Range and file pragmas target no sibling.
    const holder = context.containerOf.get(comment);
    if (holder?.next !== undefined && !siblingTargets.has(holder.next)) {
      siblingTargets.add(holder.next);
      added = true;
    }
    // A trailing formatter or scanner suppression (`a = [1]; // oxfmt-ignore`,
    // `secret(); // skipcq`) targets what it trails, not the line below it.
    // In JSX, the container holding the comment is what has to stand on
    // lines of its own.
    if (TRAILING_TARGETS_OWN_LINE.has(directive) && !occupiesWholeLines(source, holder ?? comment)) return;
    const below = rowOffsets()[endRow + 1];
    if (directive === "nosemgrep") {
      // Semgrep reads the rule ids of a `nosemgrep:` off the rest of the row,
      // which runs on where a lone CR or U+2028 ends the comment's line: what
      // stands there is part of the ids it reads.
      const nextLine = lineOffsets[comment.endLine] ?? source.length;
      if (nextLine < (below ?? source.length) && SEMGREP_RULE_IDS.test(comment.text)) {
        rowTails.push({ start: nextLine, end: below ?? source.length });
        added = true;
      }
      // Its reach is a matter of what precedes the marker on its row.
      if (below !== undefined) {
        const rowStart = rowOffsets()[endRow] as number;
        const ownRow = comment.text.slice(comment.text.lastIndexOf("\n") + 1);
        fronts.push({
          rowStart,
          at: Math.max(rowStart, comment.start),
          reaches: (prefix) => SEMGREP_PREVIOUS_LINE.test(prefix + ownRow),
          from: lineOf(below),
          to: lineOf((rowOffsets()[endRow + 2] ?? source.length) - 1),
        });
        added = true;
      }
      return;
    }
    // The line below the directive, and the row below it. oxlint covers the
    // rest of the row a next-line comment ends on as well, up to the end of
    // the row after it (`split_inclusive('\n')` and `lines()` in its
    // `disable_directives.rs`); on the file's last row it covers the rest of
    // the file, which no removal changes.
    shieldLines(comment.endLine + 1, comment.endLine + 1);
    if (below !== undefined) {
      shieldLines(
        OXLINT_NEXT_LINE.has(directive) ? comment.endLine + 1 : lineOf(below),
        lineOf((rowOffsets()[endRow + 2] ?? source.length) - 1),
      );
    }
    if (COUNTED_NEXT_LINE.has(directive)) {
      // monocart counts the lines below the comment's last (see monocartLines).
      const trailing = source.slice(comment.end, lineOffsets[comment.endLine] ?? source.length);
      const counted = monocartLines(comment.kind, comment.text, trailing);
      if (counted !== undefined) shieldLines(comment.endLine + 1, comment.endLine + counted);
    }
  };

  const collectShields = (): boolean => {
    added = false;
    for (const comment of [...kept, ...skipped]) {
      if (processed.has(comment)) continue;
      processed.add(comment);
      const shadow = context.shadows.get(comment);
      if (shadow !== undefined) shadows.add(shadow);
      if (comment.directive === undefined) continue;
      if (carriesAstGrepSuppression(comment.text)) {
        const reach = astGrepReach(source, rowOffsets(), comment, context.preceding.get(comment) as PrecedingNode);
        astGrepReaches.push(reach);
        if (reach.nextRow !== undefined && reach.nextRow.end > reach.nextRow.start) {
          shieldLines(lineOf(reach.nextRow.start), lineOf(reach.nextRow.end - 1));
        }
        added = true;
      }
      for (const directive of context.directives.get(comment) as readonly string[]) shieldReach(comment, directive);
    }
    // c8 ignores the row holding a hint, wherever on it, and from a hint that
    // opens its row the rows below it that the hint counts; Node's test
    // runner ignores the rows below it wherever it stands. A hint in a
    // comment that goes, goes with it.
    pendingHints = pendingHints.filter((hint) => {
      const holder = rangeAt(context.comments, hint.offset);
      if (holder !== undefined && removing.has(holder)) return true;
      const offsets = rowOffsets();
      const row = lineIndexAt(offsets, hint.offset);
      shieldRows(row, row);
      if (hint.nodeRows > 0) shieldRows(row + 1, row + hint.nodeRows);
      const below = offsets[row + 1];
      if (below !== undefined) {
        fronts.push({
          rowStart: offsets[row] as number,
          at: hint.offset,
          reaches: opensRow,
          from: lineOf(below),
          to: lineOf((offsets[row + hint.rows + 1] ?? source.length) - 1),
        });
        added = true;
      }
      return false;
    });
    return added;
  };

  /** Takes those of the comments that are still being removed out of the removal and keeps them. */
  const protect = (group: readonly Comment[]): void => {
    const staying = group.filter((comment) => removing.has(comment));
    if (staying.length === 0) return;
    for (const comment of staying) removing.delete(comment);
    stillRemoved = stillRemoved.filter((comment) => removing.has(comment));
    kept.push(...staying);
    units = undefined;
  };

  /**
   * Shields what a directive reaches below its row where it opens the row,
   * and sees to it that the removal does not make it open one: with the
   * comments in front of it gone, the directive would newly reach those
   * lines. Where they hold no code, that changes nothing as long as they
   * stay lines, so they are shielded as well; where they do, the comment in
   * front that keeps the directive from opening its row stays.
   */
  const settleFront = (front: Front): void => {
    const prefix = source.slice(front.rowStart, front.at);
    if (!front.reaches(prefix)) {
      const inFront = currentUnits().filter((unit) => unit.start < front.at && unit.end > front.rowStart);
      /** The prefix once the units are deleted, all but `staying`. */
      const without = (staying?: RemovalUnit): string => {
        let text = "";
        let cursor = front.rowStart;
        for (const unit of inFront) {
          if (unit === staying) continue;
          text += source.slice(cursor, Math.max(cursor, unit.start));
          cursor = Math.min(front.at, unit.end);
        }
        return text + source.slice(cursor, front.at);
      };
      if (!front.reaches(without())) return;
      if (!holdNoCode(front.from, front.to)) {
        protect((inFront.findLast((unit) => !front.reaches(without(unit))) as RemovalUnit).comments);
        return;
      }
    }
    shieldLines(front.from, front.to);
  };

  /** Keeps the comment a gap needs, unless one that stays already serves. */
  const settleGap = (gap: Gap): void => {
    const within: Comment[] = [];
    for (
      let index = firstIndexAtOrAfter(context.comments, gap.start, (comment) => comment.start);
      (context.comments[index]?.start ?? gap.end) < gap.end;
      index += 1
    ) {
      within.push(context.comments[index] as Comment);
    }
    const first = within[0];
    if (gap.stays === "last" || first === undefined) {
      protect(within.slice(-1));
    } else {
      // Any comment keeps ast-v8-to-istanbul's hint without a target. One on
      // the hint's own line also keeps monocart from counting a line below
      // the hint (see monocartLines), so where the first stands there, only a
      // comment of that line serves.
      const serving = first.line === gap.line ? within.filter((comment) => comment.line === gap.line) : within;
      if (serving.every((comment) => removing.has(comment))) protect([first]);
    }
  };

  /** Protects what the shields collected so far hold in place; true when that kept anything. */
  const protectShields = (): boolean => {
    const removingBefore = stillRemoved.length;
    for (const front of fronts) settleFront(front);
    // A comment that would join a shielded line to another leaves its line
    // breaks behind; a container's braces have none to leave without
    // changing what the element renders, so they stay.
    for (const line of currentUnits().some((unit) => unit.braces) ? shieldedLines : []) {
      for (const unit of joiningUnits(source, unitsOnLine(line))) {
        if (unit.braces) protect(unit.comments);
      }
    }
    for (const line of blockingLines) protect(lineOpeningGroup(source, unitsOnLine(line)));
    for (const gap of gaps) settleGap(gap);
    protect([...shadows]);
    for (const target of siblingTargets) protect(target.comments);
    for (const tail of rowTails) {
      protect(commentsOf(currentUnits().filter((unit) => unit.start >= tail.start && unit.start < tail.end)));
    }
    for (const reach of astGrepReaches) protect(commentsOf(currentUnits().filter((unit) => reach.holds(unit))));
    return stillRemoved.length < removingBefore;
  };

  collectShields();
  while (protectShields()) {
    if (!collectShields()) break;
  }
  if (stillRemoved.length !== removed.length) {
    kept.sort(byStart);
  }
  return { removed: stillRemoved, lines: shieldedLines };
}

/**
 * Offset of the first character at or after `from` that is neither
 * whitespace nor inside one of the (sorted, non-overlapping) ranges, or the
 * source length when only ranges follow. `from` lies past the start of at
 * least one range (the directive the search is for); when the closest of
 * them runs past `from` — a block comment opened on the directive's line —
 * the search resumes at its end.
 */
function codeStartAfter(source: string, from: number, ranges: readonly Range[]): number {
  let next = firstIndexAtOrAfter(ranges, from, (range) => range.start);
  let index = Math.max(from, (ranges[next - 1] as Range).end);
  while (index < source.length) {
    const range = ranges[next];
    if (range !== undefined && range.start === index) {
      index = range.end;
      next += 1;
    } else if (isBlank(source[index] as string)) {
      index += 1;
    } else {
      return index;
    }
  }
  return source.length;
}

/**
 * What a tsc suppression needs left in place below it. Looking for the
 * suppression a diagnostic falls under, a compiler goes up from the
 * diagnostic's line over the lines it reads as blank or as a `//` comment
 * (see TSC_PASSABLE_LINES) and takes the first suppression it meets. So a
 * suppression applies to the first line below it that the compiler cannot
 * step over:
 *
 * - where that is the line the code below starts on, the line is the
 *   suppression's `target`, which no removal may pull more code onto;
 * - where a line in between stops the compiler first — one opening with a
 *   block comment, say — the suppression has no target for that compiler,
 *   and the line is `blocking`: deleting it would let the suppression reach
 *   the code instead;
 * - where another suppression ends on a line in between, that one takes the
 *   diagnostics from below, and this one reaches nothing past it. The line
 *   is blocking while that suppression is being removed (`suppressions`
 *   tells, for a line, whether each suppression ending on it is).
 *
 * The two compilers can stop at different lines: a line holding only a
 * vertical tab stops tsc 7, while tsc 6 searches on to the next line it
 * cannot pass.
 */
function tscReach(
  source: string,
  comment: Comment,
  lineOffsets: readonly number[],
  ranges: readonly Range[],
  suppressions: (line: number) => boolean[] | undefined,
): { blocking: number[]; target: number | undefined } {
  // A suppression applies from the line below it on, so code sharing its line
  // (`/* @ts-ignore */ foo();`) does not end the search.
  const codeStart = codeStartAfter(source, lineOffsets[comment.endLine] ?? source.length, ranges);
  if (codeStart >= source.length) return { blocking: [], target: undefined };
  const codeLine = lineIndexAt(lineOffsets, codeStart) + 1;
  const blocking: number[] = [];
  let target: number | undefined;
  for (const passable of TSC_PASSABLE_LINES) {
    let line = comment.endLine + 1;
    for (; line < codeLine; line += 1) {
      const removing = suppressions(line);
      if (removing === undefined && passable.test(source.slice(lineOffsets[line - 1], lineOffsets[line]))) continue;
      // A suppression that stays stops the compiler whatever is removed.
      if (removing?.includes(false) !== true) blocking.push(line);
      break;
    }
    if (line === codeLine) target = codeLine;
  }
  return { blocking, target };
}

/** A line, from its start to the next line's (past its line break), with the removal units holding part of it. */
interface LineUnits extends Range {
  units: RemovalUnit[];
}

/**
 * The removals on the given line when one of them opens it (holds its first
 * non-whitespace character), so that deleting them would change how the
 * line starts. None when something that survives opens the line instead, or
 * nothing on it is to be removed.
 */
function lineOpeningGroup(source: string, line: LineUnits): Comment[] {
  let first = line.start;
  while (first < line.end && isBlank(source[first] as string)) first += 1;
  return line.units.some((unit) => unit.start <= first && first < unit.end) ? commentsOf(line.units) : [];
}

/**
 * The removal units that would join the given line to another: they reach
 * past one of its ends, with something other than whitespace beyond them on
 * the line they run into. Deleting such a comment takes its line breaks
 * along, so what stands beyond it can land on the line, or what stands on
 * the line move off it, and a directive covering the line would cover other
 * code — unless line breaks of its own take its place (see applyEdits).
 */
function joiningUnits(source: string, line: LineUnits): RemovalUnit[] {
  return line.units.filter(
    (unit) =>
      (unit.end > line.end && !closesItsLine(source, unit)) || (unit.start < line.start && !opensItsLine(source, unit)),
  );
}

// The next-line directives oxlint reads.
const OXLINT_NEXT_LINE = new Set(["eslint-disable-next-line", "oxlint-disable-next-line"]);

/**
 * Whether the directive covers the lines it stands on: the `-line` forms of
 * the suppressions (`eslint-disable-line`, `tslint:disable-line`, ...), the
 * ones that cover the line holding them (see OWN_LINE_DIRECTIVES), and the
 * `ignore next` hints c8 and monocart count lines for (see
 * COUNTED_NEXT_LINE): they ignore the line holding one, from the hint on for
 * monocart, along with the lines below it.
 */
function coversOwnLine(name: string): boolean {
  return (
    (name.endsWith("-line") && !name.endsWith("-next-line")) ||
    OWN_LINE_DIRECTIVES.has(name) ||
    COUNTED_NEXT_LINE.has(name)
  );
}

// Suppressions that apply to the line holding them: Semgrep's to findings
// that start on it, CodeQL's `lgtm` to its alerts up to the comment,
// DeepSource's, SonarQube's, gitleaks', TruffleHog's and detect-secrets' to
// the line, and codespell's to its words.
const OWN_LINE_DIRECTIVES = new Set([
  "nosemgrep",
  "lgtm",
  "skipcq",
  "NOSONAR",
  "gitleaks:allow",
  "trufflehog:ignore",
  "pragma-allowlist-secret",
  "codespell:ignore",
]);

// Semgrep applies a `nosemgrep` to the line below where nothing but
// non-alphanumerics precede it on its line (`nosem_previous_line_re` in its
// Nosemgrep.ml): `// nosemgrep: rule-id` and `}); // nosemgrep` cover the next
// line, `// TODO nosemgrep` and `foo(); // nosemgrep` only their own.
const SEMGREP_PREVIOUS_LINE = /^[^a-zA-Z0-9]* *nosem(?:grep)?/i;
// A `nosemgrep` that names the rules it is for.
const SEMGREP_RULE_IDS = /nosem(?:grep)?[:=]/i;

// These suppressions only apply to the following node/line when they stand on
// their own line — trailing after code they target (at most) their own line.
// Other next-line directives (`@ts-ignore`, `no-dd-sa`, ...) target the next
// line even when they trail code.
const TRAILING_TARGETS_OWN_LINE = new Set([
  "prettier-ignore",
  "oxfmt-ignore",
  "dprint-ignore",
  "lgtm",
  "codeql",
  "skipcq",
]);

// The suppressions tsc looks past blank and `//` lines for (see tscReach).
// They stay next-line directives as well: Flow, which honours them in
// TypeScript files, applies them to the very next line.
const TSC_SUPPRESSIONS = new Set(["@ts-ignore", "@ts-expect-error"]);

// The lines each compiler steps over on its way up from a diagnostic to a
// suppression, matched against the whole line, line break included. tsc 6
// trims the line and accepts nothing or a `//` comment; tsc 7 accepts only
// spaces and tabs before the line break or the `//`.
const TSC_PASSABLE_LINES = [/^\s*(?:\/\/|$)/, /^[ \t]*(?:[\r\n]|\/\/)/];

// Directives that only count while no other comment sits between them and
// their target: deno_graph reads `@deno-types`/`@ts-types` from the last
// comment before an import, ts-prune and graphql-tag-pluck from the closest
// leading comment, and ESLint's no-fallthrough and default-case from the last
// comment before the next case or the closing brace. JetBrains IDEs take a
// `noinspection` suppression from the comment right in front of a statement,
// past whitespace alone (`getStatementToolSuppressedIn` in the platform's
// SuppressionUtil), and a `language=` injection from the comment in front of
// the literal. Deleting every comment in that gap would newly activate such a
// directive, so the last one of them stays, trailing comments in front of
// the code included. With no code left there is nothing to target, and the
// switch-clause comments are only detected in front of the `case`, `default`
// or `}` their rules read them before.
const LAST_COMMENT_DIRECTIVES = new Set([
  "@deno-types",
  "@ts-types",
  "ts-prune-ignore-next",
  "GraphQL",
  "fallthrough",
  "no-default",
  "noinspection",
  "language-injection",
]);

function isLastCommentDirective(comment: Comment, directive: string): boolean {
  // `//file:noinspection` suppresses for the whole file, wherever the code is.
  return LAST_COMMENT_DIRECTIVES.has(directive) && !(directive === "noinspection" && /^\/\/file:/.test(comment.text));
}

// The JSDoc type casts prettier keeps the parentheses of (see the rule in
// directives.ts): it does while nothing but whitespace stands between the
// comment and the parenthesis (`text.slice(previousCommentEnd, start).trim()`
// in its parse/postprocess), under its Babel, acorn and meriyah parsers. A
// comment in between leaves the cast out of effect, and prettier drops
// redundant parentheses there, so the last comment of that gap stays.
const CAST_DIRECTIVES = new Set(["@type", "@satisfies"]);

// The coverage hints ast-v8-to-istanbul, Vitest's v8 provider, applies to the
// node that starts at the very token after them, where it reads them (see
// hintsNextNode): with another comment in between, the hint has no target,
// and deleting every comment there would bring it into effect. One comment of
// the gap up to the code stays, on top of the lines below the hint, which c8,
// Node and monocart count.
const NEXT_TOKEN_DIRECTIVES = new Set([
  "istanbul-ignore-next",
  "istanbul-ignore-if",
  "istanbul-ignore-else",
  "c8-ignore-next",
  "c8-ignore-if",
  "c8-ignore-else",
  "v8-ignore-next",
  "v8-ignore-if",
  "v8-ignore-else",
  "node:coverage-ignore",
  "node:coverage-ignore-if",
  "node:coverage-ignore-else",
]);

// Directives that target the line or node directly below them. File- and
// range-scoped pragmas (`istanbul-ignore-file`, `c8-ignore-start`, ...) are
// absent: they do not target the following line, so they never shield it.
// They go by their names here: Vitest's v8 provider reads a range hint
// spelled out on any line of this file, and would drop the rest of the file
// from this project's coverage. So are the coverage hints no tool counts
// lines for — the `istanbul` ones and the `if` and `else` forms, which
// istanbul and ast-v8-to-istanbul alone read, and apply to a node wherever
// its line is (see NEXT_TOKEN_DIRECTIVES).
const NEXT_LINE_DIRECTIVES = new Set([
  "@ts-ignore",
  "@ts-expect-error",
  "biome-ignore",
  "deno-lint-ignore",
  "deno-fmt-ignore",
  "deno-coverage-ignore",
  "prettier-ignore",
  "oxfmt-ignore",
  "dprint-ignore",
  "rome-ignore",
  "c8-ignore-next",
  "v8-ignore-next",
  "node:coverage-ignore",
  // Directives that hang off the node or line directly below them: the line
  // below stays a line, so that no code moves up under them.
  "million-ignore",
  "@million-skip",
  "@million-jsx-skip",
  "deepcode-ignore",
  "skipcq",
  "lgtm",
  "codeql",
  "nosemgrep",
  "no-dd-sa",
  "datadog-disable",
  "@next-codemod-error",
  "@next-codemod-ignore",
  "$FlowFixMe",
  "$FlowExpectedError",
  "$FlowIssue",
  "$FlowIgnore",
  "pragma-allowlist-nextline-secret",
  "cspell:disable-next",
  "HTML",
]);

function isNextLineDirective(name: string): boolean {
  return name.endsWith("-next-line") || NEXT_LINE_DIRECTIVES.has(name);
}

// The coverage pragmas a line count after `ignore next` applies to: c8
// (v8-to-istanbul), Node's test-runner coverage and monocart-coverage-reports
// count lines, each in its own way (see coverage.ts). istanbul and
// ast-v8-to-istanbul, Vitest's providers, apply the hint to the next node
// whatever count follows, so `istanbul ignore next 3` covers one line.
// Everything else — `@ts-expect-error`, `eslint-disable-next-line` and
// friends — covers exactly one line too, no matter what prose like "we
// ignore next 3 legacy calls" appears in the reason text.
const COUNTED_NEXT_LINE = new Set(["c8-ignore-next", "v8-ignore-next", "node:coverage-ignore"]);
