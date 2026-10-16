#!/usr/bin/env node
/**
 * Runs shell commands concurrently and prints each one's captured output as a
 * block when it finishes, so parallel typecheck/test output stays readable.
 * Usage: node scripts/run-concurrent.mjs "label=command" ["label=command" ...]
 * Exits 1 if any command fails; every command always runs to completion.
 */
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function parseJobs(specs) {
  return specs.map((spec) => {
    const split = spec.indexOf('=');
    if (split < 1 || split === spec.length - 1) throw new Error(`invalid job "${spec}"; expected label=command`);
    return { label: spec.slice(0, split), command: spec.slice(split + 1) };
  });
}

function runJob({ label, command }, { cwd, out }) {
  const started = Date.now();
  return new Promise((resolveJob) => {
    const chunks = [];
    const child = spawn(command, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => chunks.push(chunk));
    const finish = (status, note = '') => {
      const seconds = Math.round((Date.now() - started) / 1000);
      out(`\n── ${label}: ${status === 0 ? 'passed' : `FAILED (${note || `exit ${status}`})`} in ${seconds}s ──\n${Buffer.concat(chunks).toString()}`);
      resolveJob(status === 0);
    };
    child.on('error', (error) => finish(1, error.message));
    child.on('close', (status, signal) => finish(status ?? 1, signal ?? ''));
  });
}

export async function runConcurrent(specs, { cwd = process.cwd(), out = (text) => process.stdout.write(text) } = {}) {
  const jobs = parseJobs(specs);
  if (!jobs.length) throw new Error('no jobs given');
  const results = await Promise.all(jobs.map((job) => runJob(job, { cwd, out })));
  return results.every(Boolean) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runConcurrent(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    console.error(`run-concurrent: ${error.message}`);
    process.exitCode = 1;
  });
}
