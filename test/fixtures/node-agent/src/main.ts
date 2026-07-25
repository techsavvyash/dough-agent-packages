// Fixture node-runtime entrypoint. Reads DOUGH_TASK_INPUT, writes the prompt
// to DOUGH_RESULT_FILE. Exists to give the pack tests a small file tree with a
// nested directory; not executed by the test suite.
import { readFileSync, writeFileSync } from 'node:fs';

const inputPath = process.env.DOUGH_TASK_INPUT;
const resultPath = process.env.DOUGH_RESULT_FILE;
if (inputPath && resultPath) {
  const input = JSON.parse(readFileSync(inputPath, 'utf8')) as { prompt?: string };
  writeFileSync(resultPath, input.prompt ?? '', 'utf8');
}
