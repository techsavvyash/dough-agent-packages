#!/usr/bin/env bun
// echo-node — a dependency-free node-runtime fixture agent.
//
// It speaks the worker's DOUGH_* env contract (dough-worker
// src/runtime/env-contract.ts) end to end, so the package repo can exercise a
// real node-agent run against a temp environment without the worker:
//
//   - reads DOUGH_TASK_INPUT: a FILE path whose contents are the JSON document
//     { taskId, prompt, context: { runtime, agentDir, workspace? } };
//   - prints the parsed input to stdout (human/inspection channel);
//   - writes a DETERMINISTIC result string to the file at DOUGH_RESULT_FILE
//     (the result channel the worker reads back);
//   - exits 0 on success, non-zero with a diagnostic on any contract violation.
//
// Deterministic by construction: the result is a pure function of the input's
// taskId + prompt, so two runs on the same input produce identical bytes (the
// property the registry's content-addressing relies on).

import { readFileSync, writeFileSync } from 'node:fs';

/** The DOUGH_TASK_INPUT document shape (worker env-contract TaskInputFile). */
interface TaskInputFile {
  taskId: string;
  prompt: string;
  context: {
    runtime: string;
    agentDir: string;
    workspace?: string;
  };
}

/** Build the deterministic result the agent writes to DOUGH_RESULT_FILE. */
export function formatResult(input: TaskInputFile): string {
  return `echo-node handled task ${input.taskId}: ${input.prompt}`;
}

function fail(message: string): never {
  process.stderr.write(`echo-node: ${message}\n`);
  process.exit(1);
}

function main(): void {
  const inputPath = process.env.DOUGH_TASK_INPUT;
  const resultPath = process.env.DOUGH_RESULT_FILE;
  if (!inputPath) fail('DOUGH_TASK_INPUT is not set');
  if (!resultPath) fail('DOUGH_RESULT_FILE is not set');

  let raw: string;
  try {
    raw = readFileSync(inputPath, 'utf8');
  } catch (err) {
    fail(`cannot read DOUGH_TASK_INPUT (${inputPath}): ${(err as Error).message}`);
  }

  let input: TaskInputFile;
  try {
    input = JSON.parse(raw) as TaskInputFile;
  } catch (err) {
    fail(`DOUGH_TASK_INPUT is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof input.taskId !== 'string' || typeof input.prompt !== 'string') {
    fail('DOUGH_TASK_INPUT is missing a string taskId/prompt');
  }

  // Inspection channel: the parsed input, pretty-printed.
  process.stdout.write(`${JSON.stringify(input, null, 2)}\n`);

  // Result channel: the deterministic artifact the worker reads back.
  try {
    writeFileSync(resultPath, formatResult(input), 'utf8');
  } catch (err) {
    fail(`cannot write DOUGH_RESULT_FILE (${resultPath}): ${(err as Error).message}`);
  }

  process.exit(0);
}

// Only run when invoked directly (not when imported by tests, which call
// formatResult / drive main via a subprocess).
if (import.meta.main) {
  main();
}
