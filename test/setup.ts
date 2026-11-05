import { afterAll } from "bun:test";

import { removeTempDirs } from "./helpers.ts";

// A preload's afterAll runs once, after the last test file: every temp folder this run made goes then.
afterAll(removeTempDirs);
