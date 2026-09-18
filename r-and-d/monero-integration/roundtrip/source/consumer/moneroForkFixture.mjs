import assert from 'node:assert/strict';

export const OFFICIAL_MONERO_RPC_EXAMPLE_ADDRESS =
  '44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A';

const MAX_BLOCKS = 256;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_BLOCK_BYTES = 16 * 1024 * 1024;
const MAX_TRANSACTION_BYTES = 16 * 1024 * 1024;
const HASH = /^[0-9a-f]{64}$/;
const HEX = /^(?:[0-9a-f]{2})+$/;

function integer(value, name) {
  assert(Number.isSafeInteger(value) && value >= 0, `${name} must be a non-negative safe integer`);
  return value;
}

function hash(value, name) {
  assert(typeof value === 'string' && HASH.test(value), `${name} must be a canonical hash`);
  return value;
}

function hex(value, name, maximumBytes) {
  assert(typeof value === 'string' && HEX.test(value) && value.length / 2 <= maximumBytes, `${name} exceeds its bound`);
  return value;
}

function record(value, name) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${name} must be an object`);
  return value;
}

function nodeHeight(info) {
  const height = integer(record(info, 'node info').height, 'node height');
  assert(height > 0, 'node has no genesis block');
  return height - 1;
}

async function blockAt(node, height) {
  const result = record(await node.rpc('get_block', {height}), 'get_block result');
  assert.equal(result.status, 'OK', 'get_block status');
  const header = record(result.block_header, 'block header');
  assert.equal(integer(header.height, 'block height'), height, 'block height mismatch');
  assert.equal(header.orphan_status, false, 'block is orphaned');
  const txIds = result.tx_hashes ?? [];
  assert(Array.isArray(txIds) && txIds.length <= 10_000, 'block transaction list exceeds its bound');
  const transactions = [];
  for (const txId of txIds) {
    hash(txId, 'block transaction hash');
    const response = record(await node.transaction(txId), 'transaction result');
    assert(Array.isArray(response.txs) && response.txs.length === 1, 'transaction lookup is incomplete');
    const transaction = record(response.txs[0], 'transaction row');
    transactions.push(Object.freeze({txId, hex: hex(transaction.as_hex, 'transaction bytes', MAX_TRANSACTION_BYTES)}));
  }
  return Object.freeze({
    height,
    hash: hash(header.hash, 'block hash'),
    blob: hex(result.blob, 'block bytes', MAX_BLOCK_BYTES),
    transactions: Object.freeze(transactions),
  });
}

function archiveShape(archive) {
  const value = record(archive, 'archive');
  const baseHeight = integer(value.baseHeight, 'archive base height');
  const tipHeight = integer(value.tipHeight, 'archive tip height');
  assert(baseHeight >= 0 && tipHeight > baseHeight, 'archive height range is invalid');
  hash(value.baseHash, 'archive base hash');
  hash(value.tipHash, 'archive tip hash');
  assert(Array.isArray(value.blocks) && value.blocks.length >= 1 && value.blocks.length <= MAX_BLOCKS, 'archive block count exceeds its bound');
  assert.equal(value.blocks.length, tipHeight - baseHeight, 'archive block range is incomplete');
  let bytes = 0;
  for (const [index, block] of value.blocks.entries()) {
    const current = record(block, 'archive block');
    assert.equal(integer(current.height, 'archive block height'), baseHeight + index + 1, 'archive block order');
    hash(current.hash, 'archive block hash');
    bytes += hex(current.blob, 'archive block bytes', MAX_BLOCK_BYTES).length / 2;
    assert(Array.isArray(current.transactions) && current.transactions.length <= 10_000, 'archive transaction count exceeds its bound');
    for (const transaction of current.transactions) {
      const row = record(transaction, 'archive transaction');
      hash(row.txId, 'archive transaction hash');
      bytes += hex(row.hex, 'archive transaction bytes', MAX_TRANSACTION_BYTES).length / 2;
    }
    assert(bytes <= MAX_ARCHIVE_BYTES, 'archive byte limit exceeded');
  }
  assert.equal(value.blocks.at(-1).hash, value.tipHash, 'archive tip hash mismatch');
  return value;
}

function snapshotArchive(archive) {
  const value = archiveShape(archive);
  return Object.freeze({
    baseHeight: value.baseHeight,
    baseHash: value.baseHash,
    tipHeight: value.tipHeight,
    tipHash: value.tipHash,
    blocks: Object.freeze(value.blocks.map((block) => Object.freeze({
      height: block.height,
      hash: block.hash,
      blob: block.blob,
      transactions: Object.freeze(block.transactions.map((transaction) => Object.freeze({
        txId: transaction.txId,
        hex: transaction.hex,
      }))),
    }))),
  });
}

export async function captureSuffix(node, startHeight) {
  integer(startHeight, 'start height');
  assert(startHeight >= 1, 'genesis rewind is forbidden');
  const before = await node.isolated();
  const tipHeight = nodeHeight(before);
  assert(startHeight <= tipHeight, 'start height is beyond the tip');
  assert(tipHeight - startHeight + 1 <= MAX_BLOCKS, 'archive block limit exceeded');
  const base = await blockAt(node, startHeight - 1);
  const blocks = [];
  let bytes = base.blob.length / 2;
  for (let height = startHeight; height <= tipHeight; height++) {
    const block = await blockAt(node, height);
    bytes += block.blob.length / 2 + block.transactions.reduce((sum, transaction) => sum + transaction.hex.length / 2, 0);
    assert(bytes <= MAX_ARCHIVE_BYTES, 'archive byte limit exceeded');
    blocks.push(block);
  }
  const after = await node.isolated();
  assert.equal(nodeHeight(after), tipHeight, 'chain advanced during archive capture');
  const finalTip = await blockAt(node, tipHeight);
  assert.equal(finalTip.hash, blocks.at(-1).hash, 'chain changed during archive capture');
  return Object.freeze({
    baseHeight: startHeight - 1,
    baseHash: base.hash,
    tipHeight,
    tipHash: finalTip.hash,
    blocks: Object.freeze(blocks),
  });
}

export async function rewind(node, height) {
  integer(height, 'rewind height');
  assert(height >= 0, 'genesis rewind is forbidden');
  const before = await node.isolated();
  const beforeTip = nodeHeight(before);
  assert(height <= beforeTip, 'rewind height is beyond the tip');
  const base = await blockAt(node, height);
  const nblocks = beforeTip - height;
  assert(nblocks <= MAX_BLOCKS, 'rewind block limit exceeded');
  if (nblocks > 0) {
    const popped = record(await node.call('/pop_blocks', {nblocks, keep_txs: false}), 'pop_blocks result');
    assert.equal(popped.status, 'OK', 'pop_blocks status');
  }
  const flushed = record(await node.rpc('flush_txpool', {}), 'flush_txpool result');
  assert.equal(flushed.status, 'OK', 'flush_txpool status');
  const after = await node.isolated();
  assert.equal(nodeHeight(after), height, 'rewind height mismatch');
  const retained = await blockAt(node, height);
  assert.equal(retained.hash, base.hash, 'rewind base hash mismatch');
  return Object.freeze({height, hash: retained.hash, popped: nblocks});
}

export async function restoreSuffix(node, archive) {
  const checked = snapshotArchive(archive);
  const retained = await blockAt(node, checked.baseHeight);
  assert.equal(retained.hash, checked.baseHash, 'archive base hash mismatch');
  const base = await rewind(node, checked.baseHeight);
  assert.equal(base.hash, checked.baseHash, 'archive base hash mismatch');
  for (const block of checked.blocks) {
    for (const transaction of block.transactions) {
      const submitted = record(await node.submit(Buffer.from(transaction.hex, 'hex')), 'transaction submission');
      assert.equal(submitted.status, 'OK', 'transaction submission status');
    }
    const submitted = record(await node.rpc('submit_block', [block.blob]), 'block submission');
    assert.equal(submitted.status, 'OK', 'block submission status');
    const restored = await blockAt(node, block.height);
    assert.equal(restored.hash, block.hash, 'restored block hash mismatch');
  }
  const after = await node.isolated();
  assert.equal(nodeHeight(after), checked.tipHeight, 'restored tip height mismatch');
  const tip = await blockAt(node, checked.tipHeight);
  assert.equal(tip.hash, checked.tipHash, 'restored tip hash mismatch');
  return Object.freeze({height: checked.tipHeight, hash: tip.hash});
}
