//! Offline scanner-unit probes. Mutated pruned projections are not chain-validity evidence.
#[cfg(test)]
mod tests {
    use curve25519_dalek::constants::ED25519_BASEPOINT_POINT;
    use monero_wallet::{Scanner, ViewPair, WalletOutput, extra::{Extra, ExtraField},
        ed25519::{Scalar, Point}, transaction::{Transaction, Pruned},
        block::Block, interface::ScannableBlock};
    use zeroize::Zeroizing;

    fn scalar(bytes: &str) -> Scalar {
        Scalar::read(&mut hex::decode(bytes.trim()).unwrap().as_slice()).unwrap()
    }

    fn scan(owned_outputs: usize, repeat_primary_key: bool) -> Vec<WalletOutput> {
        let spend = scalar(include_str!("../fixtures/spend_key.hex"));
        let view = scalar(include_str!("../fixtures/view_key.hex"));
        let spend_dalek: curve25519_dalek::scalar::Scalar = spend.into();
        let pair = ViewPair::new(Point::from(
            ED25519_BASEPOINT_POINT * spend_dalek),
            Zeroizing::new(view)).unwrap();
        let mut tx = Transaction::<Pruned>::read(&mut hex::decode(
            include_str!("../fixtures/pruned_tx.hex").trim()).unwrap().as_slice()).unwrap();
        let mut block = Block::read(&mut hex::decode(
            include_str!("../fixtures/block.hex").trim()).unwrap().as_slice()).unwrap();

        let Transaction::V2 { ref mut prefix, proofs: Some(ref mut proofs) } = tx
            else { panic!("fixture must be RingCT") };
        assert_eq!(prefix.outputs.len(), 2);
        assert_eq!(proofs.base.encrypted_amounts.len(), 2);
        assert_eq!(proofs.base.commitments.len(), 2);
        if owned_outputs == 1 {
            prefix.outputs.truncate(1);
            proofs.base.encrypted_amounts.truncate(1);
            proofs.base.commitments.truncate(1);
        }
        let (primary, additional) = Extra::read(&mut prefix.extra.as_slice())
            .unwrap().keys().unwrap();
        assert_eq!(primary.len(), 1);
        assert!(additional.is_none());
        if repeat_primary_key {
            prefix.extra.extend(ExtraField::PublicKey(primary[0].compress()).serialize());
            let (keys, _) = Extra::read(&mut prefix.extra.as_slice()).unwrap().keys().unwrap();
            assert_eq!(keys, vec![primary[0], primary[0]]);
        }
        // Scanner receives a caller-supplied transaction hash and global-index anchor.
        // No claim is made that modified bytes correspond to the original fixture hash.
        block.transactions = vec![[0x11; 32]];
        block.header.hardfork_version = 16;
        let scanned = Scanner::new(pair).scan(ScannableBlock {
            block, transactions: vec![tx], output_index_for_first_ringct_output: Some(2000),
        }).unwrap().not_additionally_locked();
        for output in &scanned {
            assert_eq!(output.transaction(), [0x11; 32]);
            assert!(output.index_in_transaction() < owned_outputs as u64);
            assert_eq!(output.index_on_blockchain(), 2000 + output.index_in_transaction());
            assert_eq!(output.commitment().amount, 10_000);
        }
        scanned
    }

    #[test]
    fn single_owned_output_baseline() {
        let outputs = scan(1, false);
        assert_eq!(outputs.len(), 1);
        assert_eq!(outputs[0].index_in_transaction(), 0);
        assert_eq!(outputs.iter().map(|o| o.commitment().amount).sum::<u64>(), 10_000);
    }
    #[test]
    fn repeated_primary_key_does_not_duplicate_single_output_or_amount() {
        let baseline = scan(1, false);
        let repeated = scan(1, true);
        assert_eq!(repeated.len(), 1);
        assert_eq!(repeated, baseline);
        assert_eq!(repeated.iter().map(|o| o.commitment().amount).sum::<u64>(), 10_000);
    }
    #[test]
    fn equal_value_owned_outputs_have_distinct_keys_and_locators() {
        let outputs = scan(2, false);
        assert_eq!(outputs.len(), 2);
        assert_eq!(outputs.iter().map(|o| o.index_in_transaction()).collect::<Vec<_>>(), vec![0, 1]);
        assert_ne!(outputs[0].key(), outputs[1].key());
        assert_ne!(outputs[0].index_in_transaction(), outputs[1].index_in_transaction());
        assert_ne!(outputs[0].index_on_blockchain(), outputs[1].index_on_blockchain());
        assert_eq!(outputs.iter().map(|o| o.commitment().amount).sum::<u64>(), 20_000);
    }
    #[test]
    fn repeated_primary_key_preserves_both_distinct_equal_value_outputs() {
        let baseline = scan(2, false);
        let repeated = scan(2, true);
        assert_eq!(repeated.len(), 2);
        assert_eq!(repeated, baseline);
    }
}
