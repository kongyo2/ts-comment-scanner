import { astGrepReach, isFileWidePosition, rowStartOffsets, type AstGrepReach, type PrecedingNode } from "./astgrep.js";
import {
  activePositionalDirectives,
  bunMarkerOffset,
  carriesAstGrepSuppression,
  isLegalComment,
  type DirectivePlacement,
} from "./directives.js";
import type { ImportGroupGap } from "./imports.js";
import type { JsxContainer } from "./jsx.js";
import { LINE_TERMINATOR, isBlank, isHorizontalSpace, lastLine, lineIndexAt, lineStartOffsets } from "./lines.js";
import { byStart, firstIndexAtOrAfter, rangesWithin, type Range } from "./ranges.js";
import { analyzeSource } from "./scanner.js";
import { applyEdits, blankLineEdits, type Edit } from "./splice.js";
import type { Comment } from "./types.js";

export interface RemoveOptions {
  jsx?: boolean;
  /** Also remove compiler/linter directive comments. Default: false (kept for safety). */
  removeDirectives?: boolean;
  /** Also remove license/legal comments. Default: false (kept for safety). */
  removeLegal?: boolean;
  /**
   * Extra protection: return true to keep a comment the way directives are
   * kept, for markers only a project's own tooling reads (a build template's
   * placeholder, a custom linter tag). Wins over removeDirectives and
   * removeLegal; such comments are reported in `kept`.
   */
  keep?: (comment: Comment) => boolean;
  /** Extra predicate: return false to leave a comment out of the removal entirely. */
  shouldRemove?: (comment: Comment) => boolean;
}

export interface RemoveResult {
  /** Source with the removed comments spliced out. */
  code: string;
  removed: Comment[];
  /**
   * Comments kept because they are protected: directives, license headers,
   * comments the `keep` predicate claims, comments whose removal would
   * change what an ast-grep suppression covers (the ones in front of it on
   * its row decide which node it trails), comments whose removal would shift
   * code under a next-line directive, JSX comment containers whose removal
   * would join another line to one a directive covers, comments that sit
   * between a directive and the code it reaches past them for (or the JSX
   * sibling it applies to), and comments whose removal would move a
   * position-dependent directive (prettier's first-comment pragma, Deno's
   * coverage file pragma, Bun's file-start marker) into effect.
   */
  kept: Comment[];
  /** Comments excluded from removal by the `shouldRemove` predicate. */
  skipped: Comment[];
  changed: boolean;
}

/**
 * Removes comments from TypeScript source without touching code.
 *
 * Safety properties:
 * - AST-based ranges: strings, template literals and regexes are never affected.
 * - Directives (`@ts-expect-error`, `eslint-disable`, ...) and license headers are
 *   kept by default, since deleting them changes build/lint behaviour.
 * - Surviving comments keep their directive semantics: when deleting a leading
 *   comment would newly activate a position-dependent directive in a kept
 *   comment (prettier's `@format` docblock pragma counts only as the file's
 *   first comment, Bun's `// @bun` only at the very start or right after a
 *   shebang line), the leading comment is kept instead.
 * - A space is inserted where removing a block comment would merge two tokens,
 *   and a line break is kept where the comment acted as one (ASI stays intact).
 * - A JSX comment goes with its braces (`{/* note *​/}`), unless that would
 *   change what the element renders: the braces split the text around them
 *   into separate strings, so where they stand between text that renders,
 *   `{" "}` takes their place when that keeps the strings identical, and
 *   otherwise the braces stay as `{}`. The output is re-parsed to prove every
 *   element renders the same strings, under the whitespace rules of
 *   TypeScript, esbuild and Babel alike.
 * - Blank lines that only separated a removed comment from the code around it
 *   go with it: no pile-up of blank lines where a comment stood between two
 *   of them, and at the start or end of the file or of a block only the blank
 *   lines already against that edge stay.
 * - Imports and exports stay in the groups TypeScript's organizeImports and
 *   dprint sort apart: where deleting the comments between two groups would
 *   leave no empty line between them, an empty line takes their place. So it
 *   does where deleting the comments after an import or a require would
 *   bring the code after it up to the line below, keeping the empty line the
 *   newline-after-import rules of eslint-plugin-import and oxlint want.
 * - A leading byte-order mark is preserved. Reported positions index into the
 *   `source` string exactly as `scanComments(source)` reports them (a BOM
 *   counts as its first character).
 * - The result is re-scanned; if the remaining comments do not match the kept
 *   set, an error is thrown instead of returning corrupted output.
 */
export function removeComments(source: string, options: RemoveOptions = {}): RemoveResult {
  const jsx = options.jsx === true;
  const analysis = analyzeSource(source, { jsx });
  const comments = analysis.comments;

  let removed: Comment[] = [];
  const kept: Comment[] = [];
  const skipped: Comment[] = [];
  for (const comment of comments) {
    if (options.shouldRemove?.(comment) === false) {
      skipped.push(comment);
    } else if (isProtected(comment, options)) {
      kept.push(comment);
    } else {
      removed.push(comment);
    }
  }

  const containers = attachContainers(source, analysis.jsx.containers, comments);
  const containerOf = new Map<Comment, Container>();
  for (const container of containers) {
    for (const comment of container.comments) containerOf.set(comment, container);
  }
  const context: ShieldContext = {
    containerOf,
    skippable: skippableRanges(comments, containerOf, new Set(removed)),
    preceding: analysis.preceding,
    directives: analysis.directives,
  };
  const search = containerSearch(containers);
  // Collapsing blank lines can only move a surviving comment to the very
  // start of the file (or of the line after a shebang), where Bun reads its
  // marker; when that changes a survivor's meaning, the attempt is repeated
  // without the collapse before any removal is given up.
  let tidyBlankLines = true;
  // The removals that leave an empty line in their place, holding two groups
  // of imports or exports apart, or the code after the imports two lines
  // below them (see gapHolders).
  const holders = new Set<Comment>();

  for (;;) {
    const shielding = shieldNextLineDirectives(source, removed, kept, skipped, context);
    removed = shielding.removed;

    if (removed.length === 0) {
      return { code: source, removed, kept, skipped, changed: false };
    }

    const removing = new Set(removed);
    search.track(new Set(containers.filter((container) => emptiedBy(container, removing))));
    const edits = removalEdits(removed, containerOf, search.droppable, holders, shielding.lineBreaks);
    const deletions = edits.filter((edit) => edit.replacement === undefined);
    const blankEdits = tidyBlankLines ? blankLineEdits(source, deletions, comments, shielding.lines, analysis.jsx) : [];
    const code = editKeepingBom(source, [...edits, ...blankEdits].sort(byStart));
    const output = analyzeSource(code, { jsx });

    if (search.adjust(changedSegments(analysis.jsx.segments, output.jsx.segments))) continue;

    // Where the output joins two groups of imports or exports that a sorter
    // sorts apart, or loses the empty line a linter finds after the imports,
    // a removal in the gap leaves an empty line in its place, and the attempt
    // is repeated.
    const holding = gapHolders(source, analysis.importGroups, output.importGroups, removed, holders);
    if (holding.length > 0) {
      for (const holder of holding) holders.add(holder);
      continue;
    }

    const survivor = firstChangedSurvivor(source, code, output.comments, kept, skipped);
    if (survivor === undefined) {
      return { code, removed, kept, skipped, changed: true };
    }
    if (blankEdits.length > 0) {
      tidyBlankLines = false;
      continue;
    }

    // A surviving comment changed meaning: with everything before it deleted
    // it became the file's first comment (or its very first bytes), turning a
    // previously inert positional directive live. Re-protect the removal
    // candidate closest before it and try again: that comment then keeps
    // holding the survivor away from the activating position, exactly as the
    // input did. (Looping, because the re-protected comment can itself be a
    // next-line directive that shields further lines.)
    const blocker = closestRemovalBefore(removed, survivor);
    if (blocker === undefined) {
      throw unexpectedResult();
    }
    removed = removed.filter((comment) => comment !== blocker);
    kept.push(blocker);
    kept.sort(byStart);
    tidyBlankLines = true;
  }
}

function unexpectedResult(): Error {
  return new Error("comment removal produced an unexpected result; refusing to continue");
}

/**
 * The items of the source's list and of the output's that correspond, in
 * pairs; throws when the lists differ in length, since removing comments
 * never adds or drops what they list.
 */
function corresponding<T>(before: readonly T[], after: readonly T[]): Array<[T, T]> {
  if (before.length !== after.length) throw unexpectedResult();
  return before.map((item, index) => [item, after[index] as T]);
}

/**
 * Compares the spliced output's comments against the comments meant to
 * survive, in document order (removal never reorders them). Throws when the
 * texts themselves differ (the output would be corrupted) and returns the
 * first surviving comment whose directive semantics changed, or undefined
 * when the output is exactly as expected. Besides the canonical directive
 * name, the position-dependent pragmas are compared on their own: a comment
 * can carry an inert `@format` underneath the directive an earlier rule
 * already named (an eslint config block, say), and that pragma going live
 * must not hide behind the unchanged name.
 */
function firstChangedSurvivor(
  source: string,
  code: string,
  actual: Comment[],
  kept: Comment[],
  skipped: Comment[],
): Comment | undefined {
  for (const [comment, survivor] of corresponding([...kept, ...skipped].sort(byStart), actual)) {
    if (survivor.text !== comment.text) {
      throw unexpectedResult();
    }
    if (survivor.directive !== comment.directive) return comment;
    const before = activePositionalDirectives(comment.kind, comment.text, positionalPlacement(source, comment));
    const after = activePositionalDirectives(survivor.kind, survivor.text, positionalPlacement(code, survivor));
    if (before.join("\n") !== after.join("\n")) return comment;
  }
  return undefined;
}

/**
 * The placement bits the position-dependent directives care about, derived
 * without a parse: the comment is the file's first comment when nothing but
 * whitespace (or a shebang) precedes it — any earlier comment's text keeps
 * the slice non-blank — it sits at the file start when it begins where Bun
 * reads its marker, and in ast-grep's file-wide position when it opens the
 * first row with the next node two or more rows down. Header status
 * needs the token structure, but removing comments never moves a comment
 * across the first token, so the positional check does not consult it.
 */
function positionalPlacement(text: string, comment: Comment): DirectivePlacement {
  const shebangLength = /^#!.*/.exec(text)?.[0].length ?? 0;
  return {
    header: false,
    firstComment: isBlank(text.slice(shebangLength, comment.start)),
    fileStart: comment.start === bunMarkerOffset(text),
    fileWide: isFileWidePosition(text, comment.start, comment.end),
  };
}

/** The removal candidate that starts closest before the comment, if any. */
function closestRemovalBefore(removals: readonly Comment[], comment: Comment): Comment | undefined {
  let closest: Comment | undefined;
  for (const removal of removals) {
    if (removal.start < comment.start) closest = removal;
  }
  return closest;
}

/**
 * The removals that are to leave an empty line in their place (see
 * Edit.blankLine), so that the output starts every group of imports and
 * exports the source starts, and keeps every empty line the linters find
 * after its imports. The gaps belong to the same statements in both texts,
 * since removing comments leaves the statements as they are. Where the
 * output joins two groups at a gap, or a linter no longer finds its empty
 * line there, the deleted comments took the gap's line breaks along, and the
 * last of them that held any — one spanning lines, or one on a line below
 * the token the gap follows — leaves an empty line, which starts a group for
 * both sorters and is the empty line both linters want. A group the output
 * starts where the source starts none can stand, for both parts of a sorted
 * group are sorted, and so can an empty line only the output has.
 */
function gapHolders(
  source: string,
  before: readonly ImportGroupGap[],
  after: readonly ImportGroupGap[],
  removals: readonly Comment[],
  holders: ReadonlySet<Comment>,
): Comment[] {
  const found: Comment[] = [];
  for (const [gap, { splits, spaced }] of corresponding(before, after)) {
    const intact =
      gap.splits.every((sorter) => splits.includes(sorter)) && gap.spaced.every((linter) => spaced.includes(linter));
    if (intact) continue;
    const inGap = removals.filter((comment) => comment.start >= gap.start && comment.end <= gap.end);
    // An empty line in the gap already starts a group for both sorters and
    // is the empty line both linters want.
    if (inGap.some((comment) => holders.has(comment))) throw unexpectedResult();
    const holder = inGap.findLast(
      (comment) => comment.endLine > comment.line || LINE_TERMINATOR.test(source.slice(gap.start, comment.start)),
    );
    if (holder === undefined) throw unexpectedResult();
    found.push(holder);
  }
  return found;
}

/**
 * Applies the edits, restoring the byte-order mark when dropping a
 * comment-only first line took it along: the mark is an encoding artifact,
 * not line content.
 */
function editKeepingBom(source: string, edits: readonly Edit[]): string {
  if (!source.startsWith("﻿")) return applyEdits(source, edits);
  // The editing itself works on the BOM-less body (with ranges shifted to
  // match) so its line handling never sees the mark, then the mark is
  // re-attached; this keeps `﻿// gone\n...` from losing the mark with
  // the dropped line.
  const shifted = edits.map((edit) => ({ ...edit, start: edit.start - 1, end: edit.end - 1 }));
  return `﻿${applyEdits(source.slice(1), shifted)}`;
}

function isProtected(comment: Comment, options: RemoveOptions): boolean {
  if (options.keep?.(comment) === true) return true;
  if (comment.directive !== undefined && options.removeDirectives !== true) return true;
  if (isLegalComment(comment.text) && options.removeLegal !== true) return true;
  return false;
}

/**
 * How a comment-only JSX container goes once all its comments do: braces
 * and all; replaced by `{" "}` together with the spaces that held it off its
 * neighbour; or with its braces kept, only the comments going.
 */
type ContainerMode = "drop" | "space" | "keep";

/** A comment-only JSX container (`{/* note *​/}`) with the comments in it. */
interface Container extends Range {
  segment: number;
  suspect: boolean;
  /** The comment-only container right after it among the siblings, if any. */
  next: Container | undefined;
  comments: Comment[];
  mode: ContainerMode;
  /** What `{" "}` would replace, when the container shares its line and is held off by spaces. */
  spaceRange: Range | undefined;
}

function attachContainers(source: string, layouts: readonly JsxContainer[], comments: readonly Comment[]): Container[] {
  const containers = new Map<JsxContainer, Container>();
  for (const layout of layouts) {
    containers.set(layout, {
      start: layout.start,
      end: layout.end,
      segment: layout.segment,
      suspect: layout.suspect,
      next: undefined,
      comments: rangesWithin(comments, layout),
      mode: "drop",
      spaceRange: spaceRange(source, layout),
    });
  }
  for (const [layout, container] of containers) {
    if (layout.next !== undefined) container.next = containers.get(layout.next);
  }
  return [...containers.values()];
}

/**
 * The range `{" "}` would take the place of: a one-line container and the
 * spaces before it when code precedes it on its line (`<b /> {/* x *​/}`), or
 * the spaces after it when it opens its line and code follows. Undefined when
 * no spaces hold it off anything on its line.
 */
function spaceRange(source: string, container: Range): Range | undefined {
  if (LINE_TERMINATOR.test(source.slice(container.start, container.end))) return undefined;
  let before = container.start;
  while (isHorizontalSpace(source[before - 1])) before -= 1;
  let after = container.end;
  while (isHorizontalSpace(source[after])) after += 1;

  if (!opensItsLine(source, container)) {
    return before < container.start ? { start: before, end: container.end } : undefined;
  }
  const codeAfter = after < source.length && !LINE_TERMINATOR.test(source[after] as string);
  return codeAfter && after > container.end ? { start: container.start, end: after } : undefined;
}

/**
 * Comments, and the comment-only containers that may go along with theirs,
 * as sorted ranges: what the search for the code after a directive skips.
 * A container counts as skippable when all its comments are removal
 * candidates, even if some get protected later — skipping it then only moves
 * the found code further down, which shields more, not less.
 */
function skippableRanges(
  comments: readonly Comment[],
  containerOf: ReadonlyMap<Comment, Container>,
  candidates: ReadonlySet<Comment>,
): Range[] {
  return mergeContainers(comments, containerOf, (container) => emptiedBy(container, candidates));
}

/**
 * The comments, in document order, with those of every container that
 * `merges` accepts merged into the container itself: one unit spanning its
 * braces in place of the comments inside them.
 */
function mergeContainers(
  comments: readonly Comment[],
  containerOf: ReadonlyMap<Comment, Container>,
  merges: (container: Container) => boolean,
): Array<Comment | Container> {
  const units: Array<Comment | Container> = [];
  for (const comment of comments) {
    const container = containerOf.get(comment);
    if (container === undefined || !merges(container)) units.push(comment);
    else if (units.at(-1) !== container) units.push(container);
  }
  return units;
}

/** Whether the container's comments are all among the given ones, so that its braces can go with them. */
function emptiedBy(container: Container, comments: ReadonlySet<Comment>): boolean {
  return container.comments.every((comment) => comments.has(comment));
}

/**
 * The edits that remove the comments: one per comment, or one per container
 * going with its braces. A holder of a gap around the imports (see
 * gapHolders) leaves an empty line in its place, and a comment that would
 * otherwise join or split the lines a directive covers one of its own line
 * breaks (see Shielding.lineBreaks).
 */
function removalEdits(
  removed: readonly Comment[],
  containerOf: ReadonlyMap<Comment, Container>,
  droppable: ReadonlySet<Container>,
  holders: ReadonlySet<Comment>,
  lineBreaks: ReadonlySet<Comment>,
): Edit[] {
  const units = mergeContainers(
    removed,
    containerOf,
    (container) => droppable.has(container) && container.mode !== "keep",
  );
  return units.map((unit): Edit => {
    if (!("comments" in unit)) {
      return { start: unit.start, end: unit.end, blankLine: holders.has(unit), lineBreak: lineBreaks.has(unit) };
    }
    return unit.mode === "drop"
      ? { start: unit.start, end: unit.end, jsx: true }
      : { ...(unit.spaceRange as Range), replacement: '{" "}' };
  });
}

/** Indexes of the JSX stretches whose rendering differs; throws when the structure itself does. */
function changedSegments(before: readonly string[], after: readonly string[]): Set<number> {
  const changed = new Set<number>();
  for (const [index, [rendering, now]] of corresponding(before, after).entries()) {
    if (rendering !== now) changed.add(index);
  }
  return changed;
}

interface ContainerSearch {
  /** Containers whose comments all go, so their braces can too. */
  readonly droppable: ReadonlySet<Container>;
  /** Records which containers can go; when that changes (comments got protected), the search starts over. */
  track(droppable: ReadonlySet<Container>): void;
  /** Adjusts the modes after an attempt rendered the given stretches differently; true when anything changed. */
  adjust(changed: ReadonlySet<number>): boolean;
}

/**
 * Decides how each comment-only container goes. Dropping the braces is tried
 * everywhere first; where the re-parsed output then renders a stretch of JSX
 * children differently, that stretch's suspect containers are settled one
 * at a time, in document order — each tries dropping, then `{" "}`, then
 * keeping its braces, while the suspects after it keep theirs — so braces
 * stay only where nothing less keeps the rendering intact. Keeping every
 * suspect's braces always does: the other containers sit between text that
 * renders nothing, which stays so however it is merged or trimmed.
 */
// The most suspects of one stretch settled one at a time; beyond that they all keep their braces.
const MAX_SUSPECTS_SETTLED = 16;

function containerSearch(containers: readonly Container[]): ContainerSearch {
  let droppable: ReadonlySet<Container> = new Set();
  /** Per stretch that rendered differently: its suspects still to settle, the first being tried. */
  const pending = new Map<number, Container[]>();

  const advance = (container: Container): boolean => {
    if (container.mode === "keep") return false;
    container.mode = container.mode === "drop" && container.spaceRange !== undefined ? "space" : "keep";
    return true;
  };

  return {
    get droppable() {
      return droppable;
    },
    track(now) {
      // Protection only ever takes comments out of the removal, so the set
      // only shrinks and its size tells whether it changed.
      if (now.size === droppable.size) return;
      droppable = now;
      pending.clear();
      for (const container of containers) container.mode = "drop";
    },
    adjust(changed) {
      let adjusted = false;
      for (const segment of changed) {
        let queue = pending.get(segment);
        if (queue === undefined) {
          // The stretch's first difference: from now on its suspects are
          // settled one at a time, the first trying to drop its braces while
          // the rest keep theirs. Every try costs a parse, so a stretch with
          // a great many of them keeps all their braces straight away.
          queue = containers.filter((c) => c.segment === segment && c.suspect && droppable.has(c));
          const giveUp = queue.length > MAX_SUSPECTS_SETTLED;
          for (const container of giveUp ? queue : queue.slice(1)) container.mode = "keep";
          pending.set(segment, giveUp ? [] : queue);
          if (giveUp || queue.length > 1) {
            adjusted = true;
            continue;
          }
        }
        // The container being tried still changes the rendering: it tries
        // the next mode. Keeping its braces cannot fail, so running out of
        // modes (or of suspects to blame) means the output is not trustworthy.
        const current = queue[0];
        if (current === undefined || !advance(current)) throw unexpectedResult();
        adjusted = true;
      }
      for (const [segment, queue] of pending) {
        if (changed.has(segment) || queue.length === 0) continue;
        // The stretch renders as before: the container being tried is
        // settled, and the next suspect tries dropping its braces.
        queue.shift();
        const next = queue[0];
        if (next !== undefined) {
          next.mode = "drop";
          adjusted = true;
        }
      }
      return adjusted;
    },
  };
}

interface ShieldContext {
  /** The comment-only JSX container each comment in one sits in. */
  containerOf: ReadonlyMap<Comment, Container>;
  /** Comments and the containers that may go with theirs, sorted: what code starts after. */
  skippable: readonly Range[];
  /** What stands in front of each comment carrying an ast-grep suppression (see SourceAnalysis). */
  preceding: ReadonlyMap<Comment, PrecedingNode>;
  /** Every directive each directive comment carries (see SourceAnalysis). */
  directives: ReadonlyMap<Comment, readonly string[]>;
}

interface Shielding {
  removed: Comment[];
  /**
   * Lines (1-based) that a surviving directive reaches: the ones below a
   * next-line directive, and the ones a line directive stands on.
   */
  lines: Set<number>;
  /**
   * Comments with code on both sides whose deletion would join one of those
   * lines to another, where no line break would take their place, or split
   * one, where a line feed would stand in for line breaks the tools that only
   * count line feeds do not count. One of the comment's own line breaks takes
   * its place (see Edit.lineBreak).
   */
  lineBreaks: Set<Comment>;
}

/**
 * What deleting part of the removal takes out of the source: a single
 * comment, or a comment-only JSX container going braces and all.
 */
interface RemovalUnit extends Range {
  comments: readonly Comment[];
  /** The unit is a container's braces, which go with the comments in them. */
  braces: boolean;
}

/**
 * Re-protects comments whose removal would delete a physical line sitting
 * under a surviving next-line directive (`@ts-expect-error`,
 * `eslint-disable-next-line`, ...). Dropping such a line would shift the
 * following code up, silently changing which line the directive applies to —
 * and with it the compiler or linter behaviour. Nor may a removal join
 * another line to one a directive covers, the lines a line directive
 * (`eslint-disable-line`, `nosemgrep` after code, ...) stands on included:
 * a comment that would leaves one of its line breaks in its place (see
 * Shielding.lineBreaks). Directives whose tools reach further get more:
 * below a tsc suppression the first line each compiler cannot step over
 * stays, oxlint's line-feed rows add the lines they run over, between a
 * directive that only counts as the last comment before its target
 * (`@deno-types`, ...) or a coverage hint that ast-v8-to-istanbul only
 * applies to the node right after it and that target every comment stays,
 * and a JSX comment container right after a directive in a container
 * (`{/* prettier-ignore *​/}`, which applies to the next sibling) stays too.
 * Each directive a comment carries shields what it reaches, whichever one
 * names the comment.
 *
 * The line checks work on whole lines, not single comments: a line holding
 * several removable comments (`/* one *​/ /* two *​/`) vanishes just the same,
 * so every comment on it has to stay — and a comment-only JSX container takes
 * its braces along. Runs to a fixpoint because a re-protected comment can
 * itself be a next-line directive shielding further lines (when directives
 * are being removed selectively).
 */
function shieldNextLineDirectives(
  source: string,
  removed: Comment[],
  kept: Comment[],
  skipped: Comment[],
  context: ShieldContext,
): Shielding {
  const lineOffsets = lineStartOffsets(source);
  const totalLines = lineOffsets.length;
  const shieldedLines = new Set<number>();
  const lineBreaks = new Set<Comment>();
  const blockingLines = new Set<number>();
  const shieldedGaps: Array<readonly [number, number]> = [];
  const siblingTargets = new Set<Container>();
  const astGrepReaches: AstGrepReach[] = [];
  const processed = new Set<Comment>();
  let stillRemoved = removed;
  let units: RemovalUnit[] | undefined;
  const currentUnits = (): RemovalUnit[] => (units ??= removalUnits(stillRemoved, context.containerOf));
  let rows: number[] | undefined;
  /** The (1-based) line holding the offset. */
  const lineOf = (offset: number): number => lineIndexAt(lineOffsets, offset) + 1;
  /**
   * Whether Semgrep can read the `nosemgrep` comment as a suppression of the
   * line below it (see SEMGREP_PREVIOUS_LINE): the line the comment ends on,
   * with the comments in front of it cut out as the removal may cut them,
   * opens with the marker.
   */
  const readsAsSemgrepPreviousLine = (comment: Comment): boolean => {
    let cursor = lineOffsets[comment.endLine - 1] as number;
    let before = "";
    const ranges = context.skippable;
    for (let index = firstIndexAtOrAfter(ranges, cursor + 1, (range) => range.end); index < ranges.length; index += 1) {
      const range = ranges[index] as Range;
      if (range.start >= comment.start) break;
      before += source.slice(cursor, Math.max(cursor, range.start));
      cursor = range.end;
    }
    if (cursor < comment.start) before += source.slice(cursor, comment.start);
    return SEMGREP_PREVIOUS_LINE.test(before + lastLine(comment.text));
  };
  /** The given (1-based) line, which the shields only name when the source has it, and the units on it. */
  const unitsOnLine = (line: number): LineUnits => {
    const start = lineOffsets[line - 1] as number;
    const end = lineOffsets[line] ?? source.length;
    return { start, end, units: currentUnits().filter((unit) => unit.start < end && unit.end > start) };
  };

  const collectShields = (): boolean => {
    let added = false;
    const shieldLines = (from: number, to: number): void => {
      for (let line = from; line <= Math.min(to, totalLines); line += 1) {
        if (shieldedLines.has(line)) continue;
        shieldedLines.add(line);
        added = true;
      }
    };
    /** Collects what one of the directives the comment carries reaches. */
    const shieldReach = (comment: Comment, directive: string): void => {
      const lastComment = LAST_COMMENT_DIRECTIVES.has(directive);
      if (lastComment || NEXT_TOKEN_DIRECTIVES.has(directive)) {
        const codeStart = codeStartAfter(source, comment.end, context.skippable);
        if (codeStart > comment.end && codeStart < source.length) {
          shieldedGaps.push([comment.end, codeStart]);
          added = true;
        }
        if (lastComment) return;
      }
      if (TSC_SUPPRESSIONS.has(directive)) {
        for (const line of firstBlockingLines(source, comment, lineOffsets, context.skippable)) {
          if (blockingLines.has(line)) continue;
          blockingLines.add(line);
          added = true;
        }
      }
      // oxlint reaches its rows' lines past the ones counted below.
      if (OXLINT_ROW_DIRECTIVES.has(directive)) {
        const reach = oxlintReachLines(source, (rows ??= rowStartOffsets(source)), lineOf, comment, directive);
        if (reach !== undefined) shieldLines(reach.from, reach.to);
      }
      // A line directive covers the lines it stands on, which no removal may
      // join to another (see joiningUnits).
      if (coversOwnLine(directive)) shieldLines(comment.line, comment.endLine);
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
      // lines of its own. Semgrep's reach is a matter of what precedes the
      // marker on its line.
      if (TRAILING_TARGETS_OWN_LINE.has(directive) && !occupiesWholeLines(source, holder ?? comment)) return;
      if (directive === "nosemgrep" && !readsAsSemgrepPreviousLine(comment)) return;
      // Counted pragmas like `c8 ignore next 3` cover several lines.
      shieldLines(comment.endLine + 1, comment.endLine + shieldedLineCount(comment, directive));
    };
    for (const comment of [...kept, ...skipped]) {
      if (processed.has(comment)) continue;
      processed.add(comment);
      if (comment.directive === undefined) continue;
      if (carriesAstGrepSuppression(comment.text)) {
        const reach = astGrepReach(
          source,
          (rows ??= rowStartOffsets(source)),
          comment,
          context.preceding.get(comment) as PrecedingNode,
        );
        astGrepReaches.push(reach);
        if (reach.nextRow !== undefined && reach.nextRow.end > reach.nextRow.start) {
          shieldLines(lineOf(reach.nextRow.start), lineOf(reach.nextRow.end - 1));
        }
        added = true;
      }
      for (const directive of context.directives.get(comment) as readonly string[]) shieldReach(comment, directive);
    }
    return added;
  };

  /** Takes the comments, all still being removed, out of the removal and keeps them. */
  const protect = (group: readonly Comment[]): void => {
    if (group.length === 0) return;
    const grouped = new Set(group);
    stillRemoved = stillRemoved.filter((comment) => !grouped.has(comment));
    kept.push(...group);
    units = undefined;
  };

  /** Protects what the shields collected so far hold in place; true when that kept anything. */
  const protectShields = (): boolean => {
    const removing = stillRemoved.length;
    for (const line of shieldedLines) {
      // A shielded line may neither vanish nor be joined to another. A
      // comment leaves a line break behind instead; a container's braces have
      // none to leave without changing what the element renders, so they stay.
      protect(vanishingLineGroup(source, unitsOnLine(line)));
      for (const unit of joiningUnits(source, unitsOnLine(line))) {
        if (unit.braces) protect(unit.comments);
        else lineBreaks.add(unit.comments[0] as Comment);
      }
    }
    for (const line of blockingLines) protect(lineOpeningGroup(source, unitsOnLine(line)));
    for (const [from, to] of shieldedGaps) {
      protect(stillRemoved.filter((comment) => comment.start >= from && comment.start < to));
    }
    for (const target of siblingTargets) protect(stillRemoved.filter((comment) => target.comments.includes(comment)));
    for (const reach of astGrepReaches) protect(commentsOf(currentUnits().filter((unit) => reach.holds(unit))));
    return stillRemoved.length < removing;
  };

  collectShields();
  while (protectShields()) {
    if (!collectShields()) break;
  }
  if (stillRemoved.length !== removed.length) {
    kept.sort(byStart);
  }
  return { removed: stillRemoved, lines: shieldedLines, lineBreaks };
}

/**
 * The removals as the edits delete them: a comment-only container whose
 * comments all go — and that is to go braces and all — is one unit spanning
 * its braces, every other comment a unit of its own. Sorted, as the comments.
 */
function removalUnits(removals: readonly Comment[], containerOf: ReadonlyMap<Comment, Container>): RemovalUnit[] {
  const removing = new Set(removals);
  const units = mergeContainers(
    removals,
    containerOf,
    (container) => container.mode === "drop" && emptiedBy(container, removing),
  );
  return units.map((unit) => ({
    start: unit.start,
    end: unit.end,
    ...("comments" in unit ? { comments: unit.comments, braces: true } : { comments: [unit], braces: false }),
  }));
}

/** The comments the units delete. */
function commentsOf(units: readonly RemovalUnit[]): Comment[] {
  return units.flatMap((unit) => unit.comments);
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
 * For each TypeScript compiler, the first line between a tsc suppression and
 * the code on the lines below it that the compiler does not step over, if
 * any. Looking for the line a suppression applies to, a compiler skips the
 * lines it reads as blank or as a `//` comment (see TSC_PASSABLE_LINES); any
 * other line — one opening with a block comment, say — ends the search,
 * leaving the suppression without a target for that compiler. Deleting that
 * line would let the suppression reach the code instead, so it has to stay.
 * The two compilers can stop at different lines: a line holding only a
 * vertical tab stops tsc 7, while tsc 6 searches on to the next line it
 * cannot pass.
 */
function firstBlockingLines(
  source: string,
  comment: Comment,
  lineOffsets: readonly number[],
  ranges: readonly Range[],
): number[] {
  // A suppression applies from the line below it on, so code sharing its line
  // (`/* @ts-ignore */ foo();`) does not end the search.
  const codeStart = codeStartAfter(source, lineOffsets[comment.endLine] ?? source.length, ranges);
  if (codeStart >= source.length) return [];
  const codeLine = lineIndexAt(lineOffsets, codeStart) + 1;
  const found: number[] = [];
  for (const passable of TSC_PASSABLE_LINES) {
    for (let line = comment.endLine + 1; line < codeLine; line += 1) {
      if (!passable.test(source.slice(lineOffsets[line - 1], lineOffsets[line]))) {
        found.push(line);
        break;
      }
    }
  }
  return found;
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
 * The removals that would make the given line disappear: every
 * non-whitespace character of the line lies inside one of them, so deleting
 * them deletes the physical line. None when the line survives (it holds
 * code, a kept comment, or nothing to remove at all).
 */
function vanishingLineGroup(source: string, line: LineUnits): Comment[] {
  if (line.units.length === 0) return [];
  for (let index = line.start; index < line.end; index += 1) {
    if (isBlank(source[index] as string)) continue;
    if (!line.units.some((unit) => unit.start <= index && index < unit.end)) return [];
  }
  return commentsOf(line.units);
}

/**
 * The removal units that would join the given line to another: they reach
 * past one of its ends, with something other than whitespace beyond them on
 * the line they run into. Deleting such a comment takes its line breaks
 * along — with nothing in their place right after an opening bracket or
 * before closing punctuation, and a line feed elsewhere (see applyEdits) — so
 * what stands beyond it can land on the line, or what stands on the line move
 * off it, and a directive covering the line would cover other code. (With
 * only whitespace beyond, the lines the comment held vanish, which
 * vanishingLineGroup weighs.)
 */
function joiningUnits(source: string, line: LineUnits): RemovalUnit[] {
  return line.units.filter(
    (unit) =>
      (unit.end > line.end && !closesItsLine(source, unit)) || (unit.start < line.start && !opensItsLine(source, unit)),
  );
}

// The directives oxlint reads on rows of its own (see oxlintReachLines).
const OXLINT_ROW_DIRECTIVES = new Set([
  "eslint-disable-next-line",
  "oxlint-disable-next-line",
  "eslint-disable-line",
  "oxlint-disable-line",
]);

/**
 * The lines (1-based, inclusive) that oxlint applies an `eslint-` or
 * `oxlint-` line or next-line comment to, past the ones the line-based
 * shields take in. oxlint finds the stretch on rows that only a line feed
 * ends (`split_inclusive('\n')` and `lines()` in its `disable_directives.rs`):
 * a next-line comment covers the rest of the row its text ends on and the
 * row after it, a line comment its own row up to the comment. A lone CR,
 * U+2028 or U+2029 — a line break to tsc and ESLint — ends no row there, so
 * a row can run over several of the lines counted here. Undefined when a
 * next-line comment stands on the file's last row: oxlint then covers the
 * rest of the file, which no removal changes.
 */
function oxlintReachLines(
  source: string,
  rows: readonly number[],
  lineOf: (offset: number) => number,
  comment: Comment,
  directive: string,
): { from: number; to: number } | undefined {
  const rowOf = (offset: number): number => lineIndexAt(rows, offset);
  if (!directive.endsWith("-next-line")) {
    return { from: lineOf(rows[rowOf(comment.start)] as number), to: comment.line };
  }
  // The comment's text ends in front of a block comment's `*/`.
  const row = rowOf(comment.kind === "block" ? comment.end - 2 : comment.end);
  if (rows[row + 1] === undefined) return undefined;
  return { from: comment.endLine + 1, to: lineOf((rows[row + 2] ?? source.length) - 1) };
}

/**
 * Whether the directive covers the lines it stands on: the `-line` forms of
 * the suppressions (`eslint-disable-line`, `tslint:disable-line`, ...), the
 * ones that cover the line holding them (see OWN_LINE_DIRECTIVES), and the
 * `ignore next` hints c8 counts lines for (see COUNTED_NEXT_LINE): it
 * ignores the line holding one along with the lines below it.
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

// The suppressions tsc looks past blank and `//` lines for (see
// firstBlockingLines). They stay next-line directives as well: Flow, which
// honours them in TypeScript files, applies them to the very next line.
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
// comment before the next case or the closing brace. Deleting the comments in
// that gap would newly activate such a directive, so the whole gap is
// shielded — trailing comments in front of the code included. With no code
// left there is nothing to target, and the switch-clause comments are only
// detected in front of the `case`, `default` or `}` their rules read them
// before.
const LAST_COMMENT_DIRECTIVES = new Set([
  "@deno-types",
  "@ts-types",
  "ts-prune-ignore-next",
  "GraphQL",
  "fallthrough",
  "no-default",
]);

// The coverage hints ast-v8-to-istanbul, Vitest's v8 provider, applies to the
// node that starts at the very token after them: with another comment in
// between, the hint has no target, and deleting that comment would bring it
// into effect. The gap up to the code is shielded like the one above, on top
// of the lines below the hint, which c8, Node and monocart count.
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
// from this project's coverage.
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
  // Directives that hang off the node or line directly below them: a
  // whole-line comment between them and their target would change what
  // they apply to, so the line below stays shielded.
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
  "noinspection",
  "language-injection",
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
// count lines. istanbul and ast-v8-to-istanbul, Vitest's providers, apply the
// hint to the next node whatever count follows, so `istanbul ignore next 3`
// covers one line. Everything else — `@ts-expect-error`,
// `eslint-disable-next-line` and friends — covers exactly one line too, no
// matter what prose like "we ignore next 3 legacy calls" appears in the
// reason text.
const COUNTED_NEXT_LINE = new Set(["c8-ignore-next", "v8-ignore-next", "node:coverage-ignore"]);

/**
 * Number of following lines a next-line pragma the comment carries covers
 * (`c8 ignore next 3` → 3). monocart reads the count past any whitespace or
 * none, and c8 and monocart stop at the last digit, so `next3` and `next 3x`
 * count 3 as well.
 */
function shieldedLineCount(comment: Comment, directive: string): number {
  if (!COUNTED_NEXT_LINE.has(directive)) return 1;
  const match = /\bignore\s*next\s*(\d+)/.exec(comment.text);
  return match ? Math.max(1, Number(match[1])) : 1;
}

/**
 * True when nothing but whitespace shares the range's first and last lines.
 * Lines are delimited by any ECMAScript line terminator, matching how the
 * scanner numbers them (a lone `\r`, U+2028 and U+2029 count too).
 */
function occupiesWholeLines(source: string, range: Range): boolean {
  return opensItsLine(source, range) && closesItsLine(source, range);
}

/** True when nothing but whitespace follows the range on its last line. */
function closesItsLine(source: string, range: Range): boolean {
  return blankToLineEdge(source, range.end, 1);
}

/** True when nothing but whitespace precedes the range on its first line. */
function opensItsLine(source: string, range: Range): boolean {
  return blankToLineEdge(source, range.start - 1, -1);
}

/**
 * True when nothing but whitespace lies from the offset on, in the direction
 * of `step`, up to the line break or the edge of the source.
 */
function blankToLineEdge(source: string, from: number, step: 1 | -1): boolean {
  for (let index = from; index >= 0 && index < source.length; index += step) {
    const char = source[index] as string;
    if (LINE_TERMINATOR.test(char)) return true;
    if (!isBlank(char)) return false;
  }
  return true;
}
