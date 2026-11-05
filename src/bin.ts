#!/usr/bin/env node
import { main } from "./index.ts";

main(process.argv.slice(2)).then(
  (code) => {
    // Exit once stdout has drained: on macOS a pipe is written asynchronously, and exiting at
    // once can cut a long --json answer short. Exiting at all (rather than letting the loop run
    // dry) stops idle keep-alive sockets from holding the terminal for seconds.
    process.exitCode = code;
    process.stdout.write("", () => process.exit(code));
  },
  (e: unknown) => {
    console.error(e instanceof Error ? `error: ${e.message}` : e);
    process.exit(1);
  },
);
