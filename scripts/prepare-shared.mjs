import { readFile, writeFile } from 'node:fs/promises';

const source = new URL('../js/match-logic.js', import.meta.url);
const target = new URL('../functions/match-logic.generated.js', import.meta.url);
const expected = await readFile(source);
let current;
try {
  current = await readFile(target);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (!current?.equals(expected)) {
  if (process.argv.includes('--check')) {
    throw new Error('Shared match rules are stale. Run npm run prepare:shared.');
  }
  await writeFile(target, expected);
}
console.log('Shared client/server match rules are identical.');
