import type { JsxContainer } from "./jsx.js";
import { LINE_TERMINATOR, isHorizontalSpace, opensItsLine } from "./lines.js";
import { rangesWithin, type Range } from "./ranges.js";
import type { Comment } from "./types.js";

/**
 * How a comment-only JSX container goes once all its comments do: braces
 * and all; replaced by `{" "}` together with the spaces that held it off its
 * neighbour; or with its braces kept, only the comments going.
 */
type ContainerMode = "drop" | "space" | "keep";

/** A comment-only JSX container (`{/* note *​/}`) with the comments in it. */
export interface Container extends Range {
  segment: number;
  suspect: boolean;
  /** The comment-only container right after it among the siblings, if any. */
  next: Container | undefined;
  comments: Comment[];
  mode: ContainerMode;
  /** What `{" "}` would replace, when the container shares its line and is held off by spaces. */
  spaceRange: Range | undefined;
}

export function attachContainers(
  source: string,
  layouts: readonly JsxContainer[],
  comments: readonly Comment[],
): Container[] {
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
 * The comments, in document order, with those of every container that
 * `merges` accepts merged into the container itself: one unit spanning its
 * braces in place of the comments inside them.
 */
export function mergeContainers(
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
export function emptiedBy(container: Container, comments: ReadonlySet<Comment>): boolean {
  return container.comments.every((comment) => comments.has(comment));
}

/**
 * What deleting part of the removal takes out of the source: a single
 * comment, or a comment-only JSX container going braces and all.
 */
export interface RemovalUnit extends Range {
  comments: readonly Comment[];
  /** The unit is a container's braces, which go with the comments in them. */
  braces: boolean;
}

/**
 * The removals as the edits delete them: a comment-only container whose
 * comments all go — and that is to go braces and all — is one unit spanning
 * its braces, every other comment a unit of its own. Sorted, as the comments.
 */
export function removalUnits(
  removals: readonly Comment[],
  containerOf: ReadonlyMap<Comment, Container>,
): RemovalUnit[] {
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
export function commentsOf(units: readonly RemovalUnit[]): Comment[] {
  return units.flatMap((unit) => unit.comments);
}
