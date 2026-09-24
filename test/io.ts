import type { CliIO } from "../src/run.js";

export interface CapturedIO {
  io: CliIO;
  /** Everything written to stdout so far, joined. */
  out: () => string;
  /** Everything written to stderr so far, joined. */
  err: () => string;
}

/** A CliIO that records what `run` writes, so tests can assert on the CLI's output. */
export function capture(): CapturedIO {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  return {
    io: { out: (text) => outChunks.push(text), err: (text) => errChunks.push(text) },
    out: () => outChunks.join(""),
    err: () => errChunks.join(""),
  };
}
