import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const workspace = process.env.ROSEN_WORKSPACE;
assert(workspace && isAbsolute(workspace), 'Set ROSEN_WORKSPACE to the prepared Rosen workspace');
const rosenURL = path => pathToFileURL(join(workspace, path)).href;

// Run the installed Rosen scanner, including its real SQLite block/status
// persistence. Only network transactions and the proposed proof-aware extractor
// are doubles. This characterizes an integration contract, not Monero admission.
const scannerRoot = 'node_modules/@rosen-bridge/abstract-scanner/';
const packageInfo = JSON.parse(readFileSync(new URL(rosenURL(scannerRoot + 'package.json'))));
assert.equal(packageInfo.version, '2.0.3');
for (const [path, expected] of [
  ['scanner/abstract/scanner.js', '1a3faec29d99e70fd640bea510f292c4ed2028b4643f656131590bc4b3a551f8'],
  ['scanner/abstract/generalScanner.js', 'a3bb756a29a80b28cd5ad8f3380779969636abbccf19082f67354312a51a8fa6'],
  ['scanner/action.js', '1a23da037f4391594f9b309aa58a346580f0d19e4dc49533591b693e8efe8928'],
]) {
  const bytes = readFileSync(new URL(rosenURL(scannerRoot + 'dist/' + path)));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, path);
}
const { GeneralScanner, BlockEntity, ExtractorStatusEntity, PROCEED } =
  await import(rosenURL(scannerRoot + 'dist/index.js'));
const { DataSource } = await import(rosenURL('node_modules/@rosen-bridge/extended-typeorm/dist/index.js'));

async function fixture(t, missingPolicy, transactions = [[], ['delayed'], ['later']]) {
  const db = new DataSource({ type: 'sqlite', database: ':memory:', synchronize: true,
    entities: [BlockEntity, ExtractorStatusEntity] });
  await db.initialize();
  t.after(() => db.destroy());
  const blocks = transactions.map((txs, height) => ({ height, hash: 'block-' + height,
    parentHash: 'block-' + (height - 1), timestamp: 1000 + height, txCount: txs.length }));
  const available = new Set(['later']);
  const accepted = [], attempts = [], errors = [];
  const logger = { debug() {}, info() {}, warn() {}, error(message) { errors.push(message); },
    child() { return this; } };
  const network = {
    async getCurrentHeight() { return blocks.length - 1; },
    async getBlockAtHeight(height) { assert(blocks[height]); return blocks[height]; },
    async getBlockTxs(hash, height) {
      assert.equal(hash, blocks[height].hash); attempts.push(height); return transactions[height];
    },
  };
  const extractor = {
    getId: () => 'delivery-probe',
    async initializeData() {},
    async hasEventInHeightRange() { return true; },
    async forkBlock() { throw Error('Unexpected fork in fixed-chain probe'); },
    async processTransactions(txs) {
      for (const txid of txs) {
        if (!available.has(txid)) {
          if (missingPolicy === 'retry-block') return false;
          assert.equal(missingPolicy, 'skip-transaction');
          continue;
        }
        accepted.push(txid);
      }
      return true;
    },
  };
  const scanner = new GeneralScanner('delivery-probe', db, -1, network, 0, logger);
  await scanner.registerExtractor(extractor);
  return {
    available, accepted, attempts, db,
    async update() { await scanner.update(); assert.deepEqual(errors, [], 'Scanner swallowed an error'); },
    async cursor() { return (await scanner.action.getLastSavedBlock())?.height; },
    async status(height) { return (await db.getRepository(BlockEntity).findOneBy({ height }))?.status; },
  };
}

test('block retry preserves a delayed candidate but withholds unrelated later blocks', async t => {
  const f = await fixture(t, 'retry-block');
  await f.update();
  assert.equal(await f.cursor(), 0);
  assert.equal(await f.status(1), 'PROCESSING');
  assert.deepEqual(f.accepted, []);
  await f.update();
  assert.deepEqual(f.attempts, [0, 1, 1]);
  assert.equal(await f.cursor(), 0);
  f.available.add('delayed');
  await f.update();
  assert.deepEqual(f.accepted, ['delayed', 'later']);
  assert.equal(await f.cursor(), 2);
  assert.equal(await f.status(1), PROCEED);
});

test('skipping unavailable proof advances the cursor without revisiting the delayed candidate', async t => {
  const f = await fixture(t, 'skip-transaction');
  await f.update();
  assert.equal(await f.cursor(), 2);
  assert.deepEqual(f.accepted, ['later']);
  f.available.add('delayed');
  await f.update();
  assert.deepEqual(f.attempts, [0, 1, 2]);
  assert.deepEqual(f.accepted, ['later']);
});

test('block retry repeats earlier extractor side effects unless the extractor makes them idempotent', async t => {
  const f = await fixture(t, 'retry-block', [[], ['later', 'delayed'], []]);
  await f.update();
  await f.update();
  assert.equal(await f.cursor(), 0);
  assert.deepEqual(f.accepted, ['later', 'later']);
});
