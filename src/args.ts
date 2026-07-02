export type OutputFormat = "text" | "json" | "github";
export type DirectiveMode = "include" | "skip" | "only";

export interface CliOptions {
  paths: string[];
  format: OutputFormat;
  ignore: string[];
  extensions: string[] | undefined;
  directives: DirectiveMode;
  failOnComment: boolean;
  remove: boolean;
  removeDirectives: boolean;
  removeLegal: boolean;
  dryRun: boolean;
  help: boolean;
  version: boolean;
}

/** Invalid command line input; the CLI reports the message and exits with code 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

const FORMATS: readonly OutputFormat[] = ["text", "json", "github"];
const DIRECTIVE_CONFLICT = "--skip-directives and --only-directives cannot be combined";

export function parseArgs(argv: string[]): CliOptions {
  const paths: string[] = [];
  const ignore: string[] = [];
  const extensions: string[] = [];
  let format: OutputFormat = "text";
  let directives: DirectiveMode = "include";
  let failOnComment = false;
  let remove = false;
  let removeDirectives = false;
  let removeLegal = false;
  let dryRun = false;
  let help = false;
  let version = false;
  let pathsOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;

    if (pathsOnly || !arg.startsWith("-") || arg === "-") {
      paths.push(arg);
      continue;
    }

    const [flag, inlineValue] = splitFlag(arg);
    const readValue = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      const next = argv[index + 1];
      if (next === undefined) throw new UsageError(`option ${flag} requires a value`);
      index += 1;
      return next;
    };
    const rejectValue = (): void => {
      if (inlineValue !== undefined) throw new UsageError(`option ${flag} does not take a value`);
    };

    switch (flag) {
      case "--":
        rejectValue();
        pathsOnly = true;
        break;
      case "--format": {
        const value = readValue();
        if (!FORMATS.includes(value as OutputFormat)) {
          throw new UsageError(`unknown format: ${value} (expected ${FORMATS.join(", ")})`);
        }
        format = value as OutputFormat;
        break;
      }
      case "--json":
        rejectValue();
        format = "json";
        break;
      case "--ignore":
        ignore.push(readValue());
        break;
      case "--ext":
        extensions.push(
          ...readValue()
            .split(",")
            .map((extension) => extension.trim())
            .filter((extension) => extension !== ""),
        );
        break;
      case "--skip-directives":
        rejectValue();
        if (directives === "only") throw new UsageError(DIRECTIVE_CONFLICT);
        directives = "skip";
        break;
      case "--only-directives":
        rejectValue();
        if (directives === "skip") throw new UsageError(DIRECTIVE_CONFLICT);
        directives = "only";
        break;
      case "--fail-on-comment":
        rejectValue();
        failOnComment = true;
        break;
      case "--remove":
        rejectValue();
        remove = true;
        break;
      case "--remove-directives":
        rejectValue();
        removeDirectives = true;
        break;
      case "--remove-legal":
        rejectValue();
        removeLegal = true;
        break;
      case "--dry-run":
        rejectValue();
        dryRun = true;
        break;
      case "-h":
      case "--help":
        rejectValue();
        help = true;
        break;
      case "-v":
      case "--version":
        rejectValue();
        version = true;
        break;
      default:
        throw new UsageError(`unknown option: ${flag}`);
    }
  }

  if (!remove) {
    for (const [set, flag] of [
      [dryRun, "--dry-run"],
      [removeDirectives, "--remove-directives"],
      [removeLegal, "--remove-legal"],
    ] as const) {
      if (set) throw new UsageError(`${flag} requires --remove`);
    }
  }
  if (remove && failOnComment) {
    throw new UsageError("--fail-on-comment cannot be combined with --remove");
  }
  if (remove && format === "github") {
    throw new UsageError("--format github cannot be combined with --remove");
  }
  if (remove && directives === "only" && !removeDirectives) {
    throw new UsageError(
      "--remove --only-directives would remove nothing; add --remove-directives to delete directives",
    );
  }
  if (remove && directives === "skip" && removeDirectives) {
    throw new UsageError("--remove-directives cannot be combined with --skip-directives");
  }

  return {
    paths: paths.length > 0 ? paths : ["."],
    format,
    ignore,
    extensions: extensions.length > 0 ? extensions : undefined,
    directives,
    failOnComment,
    remove,
    removeDirectives,
    removeLegal,
    dryRun,
    help,
    version,
  };
}

function splitFlag(arg: string): [string, string | undefined] {
  const equalsIndex = arg.indexOf("=");
  if (arg.startsWith("--") && equalsIndex > 2) {
    return [arg.slice(0, equalsIndex), arg.slice(equalsIndex + 1)];
  }
  return [arg, undefined];
}
