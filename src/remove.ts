import { isFileWidePosition } from "./astgrep.js";
import { attachContainers, emptiedBy, mergeContainers, type Container } from "./containers.js";
import { activePositionalDirectives, bunMarkerOffset, isLegalComment, type DirectivePlacement } from "./directives.js";
import type { ImportGroupGap } from "./imports.js";
import { LINE_TERMINATOR, isBlank } from "./lines.js";
import { byStart, type Range } from "./ranges.js";
import { analyzeSource, type ScanOptions, type SourceAnalysis } from "./scanner.js";
import { shieldDirectives, type ShieldContext } from "./shields.js";
import { applyEdits, blankLineEdits, heldLines, type Edit, type ShieldedLines } from "./splice.js";
import type { Comment } from "./types.js";

export interface RemoveOptions {
  jsx?: boolean;
  /** The source is JavaScript (see ScanOptions.javascript). */
  javascript?: boolean;
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
   * comments the `keep` predicate claims, and the comments a directive that
   * stays is read with — one that stands between it and the code it would
   * otherwise apply to, or in front of it where it would otherwise open its
   * line (see shieldDirectives) — or whose removal would move a
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
 * - Surviving comments keep their directive semantics. The lines a directive
 *   covers stay lines of their own: where deleting the comments on one would
 *   empty it, an empty line stays in its place, so that the code below moves
 *   up under no next-line directive or counted coverage hint, and where it
 *   would join one to another line, the comment's own line breaks stay. A
 *   comment stays only where a tool reads the directive with it: one between
 *   a directive and the code it would otherwise apply to, or one whose
 *   removal would newly activate a position-dependent directive (prettier's
 *   `@format` docblock pragma counts only as the file's first comment, Bun's
 *   `// @bun` only at the very start or right after a shebang line).
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
  const scan: ScanOptions = { jsx: options.jsx === true, javascript: options.javascript === true };
  const analysis = analyzeSource(source, scan);
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
    comments,
    containerOf,
    skippable: skippableRanges(comments, containerOf, new Set(removed)),
    preceding: analysis.preceding,
    directives: analysis.directives,
    shadows: analysis.shadows,
    casts: analysis.casts,
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
    const shielding = shieldDirectives(source, removed, kept, skipped, context);
    removed = shielding.removed;

    if (removed.length === 0) {
      return { code: source, removed, kept, skipped, changed: false };
    }

    const removing = new Set(removed);
    search.track(new Set(containers.filter((container) => emptiedBy(container, removing))));
    const edits = removalEdits(removed, containerOf, search.droppable, holders);
    const deletions = edits.filter((edit) => edit.replacement === undefined);
    const lines: ShieldedLines = {
      shielded: shielding.lines,
      held: heldLines(source, deletions, comments, shielding.lines),
    };
    const blankEdits = tidyBlankLines ? blankLineEdits(source, deletions, comments, lines, analysis.jsx) : [];
    const code = editKeepingBom(source, [...edits, ...blankEdits].sort(byStart), lines);
    const output = analyzeSource(code, scan);

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

    const survivor = firstChangedSurvivor(source, analysis, code, output, kept, skipped);
    if (survivor === undefined) {
      return { code, removed, kept, skipped, changed: true };
    }
    if (blankEdits.length > 0) {
      tidyBlankLines = false;
      continue;
    }

    // A surviving comment changed meaning: with everything before it deleted
    // it became the file's first comment (or its very first bytes), turning a
    // previously inert positional directive live — or, in JavaScript, a
    // multi-line comment in front of it went for a line break, after which
    // tsc reads it as the JSDoc of the code behind it. Re-protect the removal
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
 * when the output is exactly as expected. Every directive a comment carries
 * is compared, and what tsc reads from it as JSDoc in JavaScript. The
 * position-dependent pragmas are compared on their own besides: a comment
 * can carry an inert `@format` underneath the directive an earlier rule
 * already named (an eslint config block, say), and where an ast-grep
 * suppression covers the file does not show in its name.
 */
function firstChangedSurvivor(
  source: string,
  analysis: SourceAnalysis,
  code: string,
  output: SourceAnalysis,
  kept: Comment[],
  skipped: Comment[],
): Comment | undefined {
  const carried = (of: SourceAnalysis, comment: Comment): string =>
    JSON.stringify([of.directives.get(comment) ?? [], of.typed.get(comment) ?? []]);
  for (const [comment, survivor] of corresponding([...kept, ...skipped].sort(byStart), output.comments)) {
    if (survivor.text !== comment.text) {
      throw unexpectedResult();
    }
    if (carried(output, survivor) !== carried(analysis, comment)) return comment;
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
function editKeepingBom(source: string, edits: readonly Edit[], lines: ShieldedLines): string {
  if (!source.startsWith("﻿")) return applyEdits(source, edits, lines);
  // The editing itself works on the BOM-less body (with ranges shifted to
  // match) so its line handling never sees the mark, then the mark is
  // re-attached; this keeps `﻿// gone\n...` from losing the mark with
  // the dropped line.
  const shifted = edits.map((edit) => ({ ...edit, start: edit.start - 1, end: edit.end - 1 }));
  return `﻿${applyEdits(source.slice(1), shifted, lines)}`;
}

function isProtected(comment: Comment, options: RemoveOptions): boolean {
  if (options.keep?.(comment) === true) return true;
  if (comment.directive !== undefined && options.removeDirectives !== true) return true;
  if (isLegalComment(comment.text) && options.removeLegal !== true) return true;
  return false;
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
 * The edits that remove the comments: one per comment, or one per container
 * going with its braces. A holder of a gap around the imports (see
 * gapHolders) leaves an empty line in its place.
 */
function removalEdits(
  removed: readonly Comment[],
  containerOf: ReadonlyMap<Comment, Container>,
  droppable: ReadonlySet<Container>,
  holders: ReadonlySet<Comment>,
): Edit[] {
  const units = mergeContainers(
    removed,
    containerOf,
    (container) => droppable.has(container) && container.mode !== "keep",
  );
  return units.map((unit): Edit => {
    if (!("comments" in unit)) return { start: unit.start, end: unit.end, blankLine: holders.has(unit) };
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
