export interface CliOptions {
  paths: string[];
  json: boolean;
  help: boolean;
  version: boolean;
  strip: boolean;
  write: boolean;
}

export function parseArgs(argv: string[]): CliOptions {
  const paths: string[] = [];
  let json = false;
  let help = false;
  let version = false;
  let strip = false;
  let write = false;

  for (const arg of argv) {
    switch (arg) {
      case "--json":
        json = true;
        break;
      case "--strip":
        strip = true;
        break;
      case "--write":
        write = true;
        break;
      case "-h":
      case "--help":
        help = true;
        break;
      case "-v":
      case "--version":
        version = true;
        break;
      default:
        paths.push(arg);
    }
  }

  return { paths: paths.length > 0 ? paths : ["."], json, help, version, strip, write };
}
