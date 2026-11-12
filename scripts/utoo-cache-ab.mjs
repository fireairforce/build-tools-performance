import { spawn, execFileSync } from 'node:child_process';
import {
  createWriteStream,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const caseName = process.env.CASE ?? 'react-1k';
const order = process.env.AB_ORDER ?? 'ABBA';
if (!['react-1k', 'react-dashboard'].includes(caseName))
  throw new Error(`Unsupported experiment case: ${caseName}`);
if (!['ABBA', 'BAAB'].includes(order))
  throw new Error(`Unsupported experiment order: ${order}`);
const output = path.resolve(
  process.env.AB_RESULTS_DIR ?? `results/utoo-cache-ab-${caseName}-${order}`,
);
mkdirSync(output, { recursive: true });
const modeNames = { A: 'default', B: 'mmap-disabled' };
const experiment = {
  case: caseName,
  order,
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim(),
  warmupTimesPerBlock: Number(process.env.AB_WARMUP_TIMES ?? 1),
  runTimesPerBlock: Number(process.env.AB_RUN_TIMES ?? 3),
  cachePolicy: 'Each cold/warm pair starts with a fresh compiler cache.',
  baseline: 'f9adccb49b16e7aa23bc96441409b5da48b4c092',
};
writeFileSync(
  path.join(output, 'experiment.json'),
  JSON.stringify(experiment, null, 2),
);

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};
const distribution = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    median: median(sorted),
    min: sorted[0],
    max: sorted.at(-1),
    p90: sorted[Math.ceil(sorted.length * 0.9) - 1],
    values,
  };
};
const records = [];
function summarize() {
  const groups = {};
  for (const mode of Object.values(modeNames)) {
    const warm = records.filter(
      (record) => record.mode === mode && record.phase === 'dev-warm',
    );
    if (!warm.length) continue;
    groups[mode] = Object.fromEntries(
      ['startupTime', 'serverReadyTime', 'pageReadyTime'].map((metric) => [
        metric,
        distribution(warm.map((record) => record[metric])),
      ]),
    );
  }
  writeFileSync(
    path.join(output, 'ab-summary.json'),
    JSON.stringify({ ...experiment, groups, records }, null, 2),
  );
  let markdown = `## Utoo cache A/B: ${caseName}, ${order}\n\n`;
  markdown +=
    'A: default (environment variable absent); B: `TURBO_PERSISTENCE_MMAP=0`. Both run sequentially on this runner.\n\n';
  markdown +=
    '| Mode | Samples | Warm total median | Server ready median | Page ready median | Total min–max |\n| --- | ---: | ---: | ---: | ---: | ---: |\n';
  for (const [mode, stats] of Object.entries(groups))
    markdown += `| ${mode} | ${stats.startupTime.count} | ${stats.startupTime.median}ms | ${stats.serverReadyTime.median}ms | ${stats.pageReadyTime.median}ms | ${stats.startupTime.min}–${stats.startupTime.max}ms |\n`;
  markdown +=
    '\n### Measured pairs\n\n| Block | Mode | Iteration | Cold total | Warm total | Warm server ready | Warm page ready |\n| --- | --- | ---: | ---: | ---: | ---: | ---: |\n';
  for (const warm of records.filter((record) => record.phase === 'dev-warm')) {
    const cold = records.find(
      (record) =>
        record.block === warm.block &&
        record.iteration === warm.iteration &&
        record.phase === 'dev-cold',
    );
    markdown += `| ${warm.block} | ${warm.mode} | ${warm.iteration} | ${cold?.startupTime ?? '?'}ms | ${warm.startupTime}ms | ${warm.serverReadyTime}ms | ${warm.pageReadyTime}ms |\n`;
  }
  writeFileSync(path.join(output, 'ab-summary.md'), markdown);
}

try {
  for (const [index, mode] of [...order].entries()) {
    const block = `${index + 1}-${modeNames[mode]}`;
    const results = path.join(output, block);
    const env = {
      ...process.env,
      CASE: caseName,
      TOOLS: 'utoo',
      WARMUP_TIMES: String(experiment.warmupTimesPerBlock),
      RUN_TIMES: String(experiment.runTimesPerBlock),
      RESULTS_DIR: results,
      BENCHMARK_DEV_TIMING_ONLY: '1',
      BENCHMARK_DIAGNOSTICS: '1',
    };
    delete env.TURBO_PERSISTENCE_MMAP;
    if (mode === 'B') env.TURBO_PERSISTENCE_MMAP = '0';
    console.log(`Starting ${caseName} block ${block}, order ${order}`);
    const log = createWriteStream(path.join(output, `${block}.log`));
    const child = spawn(process.execPath, ['scripts/benchmark.ts'], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      log.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
      log.write(chunk);
    });
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve(code ?? signal));
    });
    await new Promise((resolve) => log.end(resolve));
    if (code !== 0) throw new Error(`Block ${block} exited with ${code}`);
    const environment = JSON.parse(
      readFileSync(path.join(results, 'environment.json'), 'utf8'),
    );
    if (environment.persistenceMmap !== (mode === 'B' ? '0' : null))
      throw new Error(`Unexpected MMAP setting in ${block}`);
    const candidates = readdirSync(results).filter((file) =>
      /-timing-dev-(cold|warm)-attempt-\d+\.json$/.test(file),
    );
    const acceptedAttempts = new Map(
      JSON.parse(readFileSync(path.join(results, 'attempts.json'), 'utf8'))
        .filter(
          (attempt) =>
            attempt.succeeded &&
            attempt.measurement === 'timing' &&
            attempt.unit === 'dev',
        )
        .map((attempt) => [attempt.iteration, attempt.attempt]),
    );
    const successful = new Map();
    for (const file of candidates) {
      const record = JSON.parse(readFileSync(path.join(results, file), 'utf8'));
      if (
        !record.succeeded ||
        record.warmup ||
        acceptedAttempts.get(record.iteration) !== record.attempt
      )
        continue;
      for (const metric of ['startupTime', 'serverReadyTime', 'pageReadyTime'])
        if (!Number.isFinite(record[metric]))
          throw new Error(`Invalid ${metric}: ${file}`);
      const { stdout, stderr, browserLog, diskCache, ...timing } = record;
      successful.set(`${record.iteration}-${record.phase}`, {
        ...timing,
        mode: modeNames[mode],
        block,
        source: path.relative(output, path.join(results, file)),
        cacheBytes: diskCache?.bytes,
        cacheFiles: diskCache?.files.length,
      });
    }
    if (successful.size !== experiment.runTimesPerBlock * 2)
      throw new Error(
        `Unexpected measured sample count in ${block}: ${successful.size}`,
      );
    records.push(...successful.values());
    summarize();
  }
} finally {
  summarize();
}
