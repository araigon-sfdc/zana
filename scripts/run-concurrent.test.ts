import { expect, it } from 'vitest';
import { parseJobs, runConcurrent } from './run-concurrent.mjs';

const collect = () => { const chunks: string[] = []; return { chunks, out: (text: string) => { chunks.push(text); } }; };

it('parses label=command specs and rejects malformed ones', () => {
  expect(parseJobs(['a=echo x=y'])).toEqual([{ label: 'a', command: 'echo x=y' }]);
  for (const bad of ['nolabel', '=cmd', 'label=']) expect(() => parseJobs([bad])).toThrow('invalid job');
});

it('runs jobs concurrently and prints each captured block', async () => {
  const { chunks, out } = collect();
  const started = Date.now();
  const code = await runConcurrent(['one=sleep 0.4 && echo first', 'two=sleep 0.4 && echo second'], { out });
  expect(code).toBe(0);
  expect(Date.now() - started).toBeLessThan(750);
  const text = chunks.join('');
  expect(text).toContain('one: passed');
  expect(text).toContain('first');
  expect(text).toContain('second');
});

it('fails when any job fails but still lets the others finish', async () => {
  const { chunks, out } = collect();
  const code = await runConcurrent(['bad=echo broke >&2; exit 3', 'good=sleep 0.2 && echo fine'], { out });
  expect(code).toBe(1);
  const text = chunks.join('');
  expect(text).toContain('bad: FAILED (exit 3)');
  expect(text).toContain('broke');
  expect(text).toContain('good: passed');
});

it('reports spawn errors and refuses an empty job list', async () => {
  const { chunks, out } = collect();
  expect(await runConcurrent(['gone=true'], { cwd: '/nonexistent-dir-for-run-concurrent', out })).toBe(1);
  expect(chunks.join('')).toContain('gone: FAILED');
  await expect(runConcurrent([])).rejects.toThrow('no jobs');
});
