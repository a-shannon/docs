import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import test from 'node:test';
import {
  captureSuffix,
  OFFICIAL_MONERO_RPC_EXAMPLE_ADDRESS,
  restoreSuffix,
  rewind,
} from './moneroForkFixture.mjs';

const hash = (value) => value.toString(16).padStart(64, '0');

class FakeNode {
  constructor(blocks) {
    this.blocks = blocks.map((block) => structuredClone(block));
    this.known = new Map(blocks.map((block) => [block.blob, structuredClone(block)]));
    this.submittedTransactions = [];
  }

  async isolated() {
    return {height: this.blocks.length};
  }

  async rpc(method, params = {}) {
    if (method === 'get_block') {
      const block = this.blocks[params.height];
      if (!block) throw Error('missing block');
      return {status: 'OK', block_header: {height: block.height, hash: block.hash, orphan_status: false}, blob: block.blob, tx_hashes: block.transactions.map((transaction) => transaction.txId)};
    }
    if (method === 'flush_txpool') return {status: 'OK'};
    if (method === 'submit_block') {
      const block = this.known.get(params[0]);
      if (!block || block.height !== this.blocks.length) throw Error('unexpected block');
      this.blocks.push(structuredClone(block));
      return {status: 'OK'};
    }
    throw Error(`unexpected RPC ${method}`);
  }

  async call(path, body) {
    assert.equal(path, '/pop_blocks');
    assert.equal(body.keep_txs, false);
    this.blocks.splice(this.blocks.length - body.nblocks, body.nblocks);
    return {status: 'OK'};
  }

  async transaction(txId) {
    for (const block of this.blocks) {
      const transaction = block.transactions.find((item) => item.txId === txId);
      if (transaction) return {txs: [{as_hex: transaction.hex}]};
    }
    throw Error('missing transaction');
  }

  async submit(bytes) {
    this.submittedTransactions.push(Buffer.from(bytes).toString('hex'));
    return {status: 'OK'};
  }

  branch(count) {
    for (let index = 0; index < count; index++) {
      const height = this.blocks.length;
      this.blocks.push({height, hash: hash(1000 + height), blob: `bb${height.toString(16).padStart(2, '0')}`, transactions: []});
    }
  }
}

function fixture() {
  return new FakeNode(Array.from({length: 7}, (_, height) => ({
    height,
    hash: hash(height + 1),
    blob: `aa${height.toString(16).padStart(2, '0')}`,
    transactions: height === 4 ? [{txId: hash(900), hex: 'cafe'}] : [],
  })));
}

test('archives, rewinds, replaces, and restores an exact bounded suffix', async () => {
  const node = fixture();
  const archive = await captureSuffix(node, 4);
  assert.equal(Object.isFrozen(archive), true);
  assert.deepEqual(archive.blocks.map((block) => block.height), [4, 5, 6]);
  assert.deepEqual(await rewind(node, archive.baseHeight), {height: 3, hash: hash(4), popped: 3});
  node.branch(3);
  assert.notEqual(node.blocks.at(-1).hash, archive.tipHash);
  assert.deepEqual(await restoreSuffix(node, archive), {height: 6, hash: archive.tipHash});
  assert.deepEqual(node.blocks.map((block) => block.hash), Array.from({length: 7}, (_, height) => hash(height + 1)));
  assert.deepEqual(node.submittedTransactions, ['cafe']);
});

test('rejects genesis rewind, over-large archives, and a mismatched retained base without rewinding it', async () => {
  const node = fixture();
  await assert.rejects(captureSuffix(node, 0), /genesis rewind/);
  await assert.rejects(rewind(node, -1), /non-negative/);
  const archive = await captureSuffix(node, 4);
  await rewind(node, 2);
  node.blocks.push({height: 3, hash: hash(777), blob: 'aa03', transactions: []});
  const retainedFork = structuredClone(node.blocks);
  await assert.rejects(restoreSuffix(node, archive), /base hash mismatch/);
  assert.deepEqual(node.blocks, retainedFork);
  const long = new FakeNode(Array.from({length: 258}, (_, height) => ({height, hash: hash(height + 1), blob: 'aa', transactions: []})));
  await assert.rejects(captureSuffix(long, 1), /block limit/);
});

test('snapshots a mutable archive before the first node await', async () => {
  const node = fixture();
  const archive = structuredClone(await captureSuffix(node, 4));
  const rpc = node.rpc.bind(node);
  let mutateArchive = false;
  node.rpc = async (method, params) => {
    if (mutateArchive && method === 'get_block' && params.height === archive.baseHeight) {
      mutateArchive = false;
      archive.blocks[0].blob = 'bb04';
      archive.blocks[0].hash = hash(777);
      archive.tipHash = hash(778);
    }
    return rpc(method, params);
  };
  await rewind(node, archive.baseHeight);
  node.branch(3);
  mutateArchive = true;
  assert.deepEqual(await restoreSuffix(node, archive), {height: 6, hash: hash(7)});
});

test('owned fakechain smoke restores six mined blocks after a three-block alternate branch', {skip: process.env.MONERO_FORK_FIXTURE_LOCAL_TEST !== '1'}, async () => {
  const runtimeRoot = process.env.MONERO_FORK_FIXTURE_RUNTIME;
  assert(runtimeRoot, 'Explicit fixture runtime directory required');
  mkdirSync(runtimeRoot, {recursive: true});
  const {LocalMonero} = await import('./localMonero.ts');
  let node;
  try {
    node = await LocalMonero.start(runtimeRoot);
    await node.mine(6, OFFICIAL_MONERO_RPC_EXAMPLE_ADDRESS);
    const tip = (await node.isolated()).height - 1;
    const archive = await captureSuffix(node, tip - 2);
    assert.equal(archive.blocks.length, 3);
    await rewind(node, archive.baseHeight);
    await node.mine(3, OFFICIAL_MONERO_RPC_EXAMPLE_ADDRESS);
    assert.notEqual((await node.rpc('get_block', {height: archive.tipHeight})).block_header.hash, archive.tipHash);
    assert.deepEqual(await restoreSuffix(node, archive), {height: archive.tipHeight, hash: archive.tipHash});
  } finally {
    await node?.stop();
  }
});
