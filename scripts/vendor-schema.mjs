#!/usr/bin/env node
/**
 * Vendor the authoritative trade-service GraphQL SDL from the main repo
 * into test/fixtures/, so the operation-validation test
 * (src/__tests__/schema-validate.test.ts) can catch SDK ↔ schema drift.
 *
 * Usage:
 *   node scripts/vendor-schema.mjs [path-to-Cayman-Hashlock] [git-ref]
 *
 * Defaults: ../Cayman-Hashlock, origin/main. Run `git fetch origin` in the
 * main repo first so origin/main is current.
 *
 * The main repo's schema.ts holds TWO template literals:
 *   1. `typeDefs` — the federated HTTP schema (queries + mutations)
 *   2. `SUBSCRIPTION_SDL` — the standalone graphql-ws schema (subscriptions)
 * They are vendored as schema.graphql and schema.subscriptions.graphql.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(process.argv[2] ?? '../Cayman-Hashlock');
const ref = process.argv[3] ?? 'origin/main';
const SCHEMA_PATH = 'backend/services/trade-service/src/schema.ts';

const source = execFileSync('git', ['-C', repo, 'show', `${ref}:${SCHEMA_PATH}`], {
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
});
const sha = execFileSync('git', ['-C', repo, 'rev-parse', ref], { encoding: 'utf8' }).trim();

/** Extract the template literal that starts right after `marker`. */
function extractLiteral(src, marker) {
  const at = src.indexOf(marker);
  if (at === -1) throw new Error(`marker not found: ${marker}`);
  const start = src.indexOf('`', at) + 1;
  if (start === 0) throw new Error(`no template literal after: ${marker}`);
  // Find the closing UNESCAPED backtick.
  let end = start;
  for (;;) {
    end = src.indexOf('`', end);
    if (end === -1) throw new Error(`unterminated literal after: ${marker}`);
    if (src[end - 1] !== '\\') break;
    end += 1;
  }
  const raw = src.slice(start, end);
  if (raw.includes('${')) throw new Error(`literal after ${marker} has interpolation — extractor cannot vendor it verbatim`);
  return raw.replace(/\\`/g, '`');
}

function header(which) {
  return [
    `# Vendored GraphQL SDL — DO NOT EDIT BY HAND`,
    `# Source: Cayman-Hashlock ${SCHEMA_PATH} (${which})`,
    `# Ref: ${ref} @ ${sha}`,
    `# Vendored: ${new Date().toISOString().slice(0, 10)}`,
    `# Refresh: git -C <main-repo> fetch origin && node scripts/vendor-schema.mjs <main-repo>`,
    '',
  ].join('\n');
}

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', 'test', 'fixtures');
mkdirSync(fixtures, { recursive: true });

const typeDefs = extractLiteral(source, 'const typeDefs = parse(');
const subscriptionSdl = extractLiteral(source, 'export const SUBSCRIPTION_SDL =');

writeFileSync(join(fixtures, 'schema.graphql'), header('typeDefs — federated HTTP schema') + typeDefs);
writeFileSync(join(fixtures, 'schema.subscriptions.graphql'), header('SUBSCRIPTION_SDL — graphql-ws schema') + subscriptionSdl);
console.log(`Vendored ${ref} @ ${sha} → test/fixtures/schema.graphql + schema.subscriptions.graphql`);
