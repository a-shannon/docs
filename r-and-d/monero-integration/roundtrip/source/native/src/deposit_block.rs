//! Bounded reconstruction of one block's owned outputs with a caller-configured view pair.
//! Hash/byte agreement is not node consensus, historical key uniqueness or unspent authority.
use monero_wallet::{
    block::Block,
    interface::ScannableBlock,
    transaction::{Input, Pruned, Transaction},
    Scanner, ViewPair, WalletOutput,
};
use std::collections::HashSet;

/// Local resource policy, not Monero consensus limits. All counts include coinbase except
/// `max_transactions`, which counts only the supplied normal transactions.
#[derive(Clone, Copy)]
pub struct Limits {
    pub max_block_bytes: usize,
    pub max_transaction_bytes: usize,
    pub max_total_bytes: usize,
    pub max_transactions: usize,
    pub max_outputs_per_transaction: usize,
    pub max_outputs: usize,
    pub max_owned_outputs: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    ByteBound,
    TransactionBound,
    OutputBound,
    BlockEncoding,
    BlockHash,
    BlockHeight,
    TransactionEncoding,
    TransactionCount,
    TransactionHash,
    TransactionKind,
    DuplicateTransaction,
    RingctIndex,
    UnsupportedProtocol,
    Scan,
    DuplicateOutput,
}
type Result<T> = std::result::Result<T, Error>;

/// Outputs remain owned Rust values with their timelock metadata. No offset serialization
/// or maturity assertion is provided. Callers must independently apply deposit policy.
pub struct ScannedBlock {
    block_hash: [u8; 32],
    height: u64,
    first_ringct_index: Option<u64>,
    ringct_outputs: u64,
    outputs: Vec<WalletOutput>,
}
impl ScannedBlock {
    pub fn block_hash(&self) -> [u8; 32] {
        self.block_hash
    }
    pub fn height(&self) -> u64 {
        self.height
    }
    pub fn first_ringct_index(&self) -> Option<u64> {
        self.first_ringct_index
    }
    pub fn ringct_outputs(&self) -> u64 {
        self.ringct_outputs
    }
    pub fn outputs(&self) -> &[WalletOutput] {
        &self.outputs
    }
    pub fn into_outputs(self) -> Vec<WalletOutput> {
        self.outputs
    }
}

/// Parse full canonical bytes, bind ordered transactions, then scan the configured vault.
/// `first_ringct_index` is daemon/indexer authority, NOT committed by the block hash.
/// The caller must cross-check it against its independent endpoint/history policy.
/// The pinned wallet scans V2 outputs only and supports block protocols through version 16.
/// Only the primary vault address is scanned; subaddresses are not registered by this API.
pub fn scan(
    view: &ViewPair,
    block_bytes: &[u8],
    transaction_blobs: &[Vec<u8>],
    first_ringct_index: Option<u64>,
    expected_hash: [u8; 32],
    expected_height: u64,
    limits: Limits,
) -> Result<ScannedBlock> {
    if block_bytes.is_empty() || block_bytes.len() > limits.max_block_bytes {
        return Err(Error::ByteBound);
    }
    if transaction_blobs.len() > limits.max_transactions {
        return Err(Error::TransactionBound);
    }
    let mut total_bytes = block_bytes.len();
    for bytes in transaction_blobs {
        if bytes.is_empty() || bytes.len() > limits.max_transaction_bytes {
            return Err(Error::ByteBound);
        }
        total_bytes = total_bytes
            .checked_add(bytes.len())
            .ok_or(Error::ByteBound)?;
    }
    if total_bytes > limits.max_total_bytes {
        return Err(Error::ByteBound);
    }
    let mut reader = block_bytes;
    // Pinned monero-io read_raw_vec grows only after each successful element read;
    // it does not allocate the declared vector length. Block::read also validates
    // exactly one coinbase Gen input before its number() accessor is reachable.
    let block = Block::read(&mut reader).map_err(|_| Error::BlockEncoding)?;
    if !reader.is_empty() || block.serialize() != block_bytes {
        return Err(Error::BlockEncoding);
    }
    if block.hash() != expected_hash {
        return Err(Error::BlockHash);
    }
    if u64::try_from(block.number()).map_err(|_| Error::BlockHeight)? != expected_height {
        return Err(Error::BlockHeight);
    }
    if block.header.hardfork_version > 16 {
        return Err(Error::UnsupportedProtocol);
    }
    if block.transactions.len() != transaction_blobs.len() {
        return Err(Error::TransactionCount);
    }
    if block.transactions.len() > limits.max_transactions {
        return Err(Error::TransactionBound);
    }
    let mut hashes = HashSet::new();
    hashes.insert(block.miner_transaction().hash());
    let mut transactions = Vec::with_capacity(transaction_blobs.len());
    let mut output_count = 0usize;
    let mut ringct_outputs = 0u64;
    let mut count_outputs = |tx: &Transaction| -> Result<()> {
        let count = tx.prefix().outputs.len();
        if count > limits.max_outputs_per_transaction {
            return Err(Error::OutputBound);
        }
        output_count = output_count.checked_add(count).ok_or(Error::OutputBound)?;
        if output_count > limits.max_outputs {
            return Err(Error::OutputBound);
        }
        if tx.version() == 2 {
            ringct_outputs = ringct_outputs
                .checked_add(u64::try_from(count).map_err(|_| Error::RingctIndex)?)
                .ok_or(Error::RingctIndex)?;
        }
        Ok(())
    };
    count_outputs(block.miner_transaction())?;
    for (bytes, expected) in transaction_blobs.iter().zip(&block.transactions) {
        let mut reader = bytes.as_slice();
        let tx = Transaction::read(&mut reader).map_err(|_| Error::TransactionEncoding)?;
        if !reader.is_empty() || tx.serialize() != *bytes {
            return Err(Error::TransactionEncoding);
        }
        if tx.hash() != *expected {
            return Err(Error::TransactionHash);
        }
        if !hashes.insert(*expected) {
            return Err(Error::DuplicateTransaction);
        }
        if tx
            .prefix()
            .inputs
            .iter()
            .any(|input| matches!(input, Input::Gen(_)))
            || matches!(tx, Transaction::V2 { proofs: None, .. })
        {
            return Err(Error::TransactionKind);
        }
        count_outputs(&tx)?;
        transactions.push(Transaction::<Pruned>::from(tx));
    }
    // Mirrors the wallet's V2 (including V2 coinbase) output-index accounting and
    // checks the exclusive end before scanning, even when the view owns no output.
    match (ringct_outputs, first_ringct_index) {
        (0, None) => {}
        (0, Some(_)) | (_, None) => return Err(Error::RingctIndex),
        (count, Some(first)) => {
            first.checked_add(count).ok_or(Error::RingctIndex)?;
        }
    }
    let outputs = Scanner::new(view.clone())
        .scan(ScannableBlock {
            block,
            transactions,
            output_index_for_first_ringct_output: first_ringct_index,
        })
        .map_err(|_| Error::Scan)?
        .ignore_additional_timelock();
    if outputs.len() > limits.max_owned_outputs {
        return Err(Error::OutputBound);
    }
    let (mut keys, mut identities, mut indices) = (HashSet::new(), HashSet::new(), HashSet::new());
    for output in &outputs {
        if !keys.insert(output.key().compress().to_bytes())
            || !identities.insert((output.transaction(), output.index_in_transaction()))
            || !indices.insert(output.index_on_blockchain())
        {
            return Err(Error::DuplicateOutput);
        }
    }
    Ok(ScannedBlock {
        block_hash: expected_hash,
        height: expected_height,
        first_ringct_index,
        ringct_outputs,
        outputs,
    })
}

#[cfg(test)]
#[path = "deposit_block_tests.rs"]
mod tests;
