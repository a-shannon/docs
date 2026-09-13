import type {
  MigrationInterface,
  QueryRunner,
} from '@rosen-bridge/extended-typeorm';

/** Single startup owner; preserves the accepted WMNS1 history without reencoding. */
export class Migration1789499300000 implements MigrationInterface {
  name = 'Migration1789499300000';

  async up(runner: QueryRunner): Promise<void> {
    if (!runner.isTransactionActive)
      throw Error('migration:transaction-required');
    const history = await runner.query(
      'SELECT * FROM monero_withdrawal_reservation ORDER BY reservationId',
    );
    const identity = await runner.query(
      'SELECT * FROM monero_withdrawal_identity',
    );
    const old = await runner.query(
      'SELECT * FROM monero_withdrawal_output ORDER BY reservationId',
    );
    if (
      old.length !== history.length ||
      old.some(
        (row: { reservationId: string }, i: number) =>
          row.reservationId !== history[i].reservationId,
      ) ||
      (await runner.query('PRAGMA foreign_key_check')).length
    )
      throw Error('migration:incomplete-v1-history');
    await runner.query(`CREATE TABLE monero_withdrawal_output_v2 (
      reservationId TEXT NOT NULL REFERENCES monero_withdrawal_reservation(reservationId) ON DELETE RESTRICT,
      ordinal INTEGER NOT NULL CHECK(typeof(ordinal)='integer' AND ordinal>=0 AND ordinal<16),
      network TEXT NOT NULL, publicKey TEXT NOT NULL, txid TEXT NOT NULL,
      outputIndex TEXT NOT NULL, globalIndex TEXT NOT NULL, amount TEXT NOT NULL,
      commitment TEXT NOT NULL,
      PRIMARY KEY(reservationId,ordinal),
      UNIQUE(network,publicKey), UNIQUE(network,txid,outputIndex), UNIQUE(network,globalIndex))`);
    await runner.query(`INSERT INTO monero_withdrawal_output_v2
      SELECT reservationId,0,network,publicKey,txid,outputIndex,globalIndex,amount,commitment
      FROM monero_withdrawal_output`);
    const copied = await runner.query(
      'SELECT reservationId,network,publicKey,txid,outputIndex,globalIndex,amount,commitment FROM monero_withdrawal_output_v2 ORDER BY reservationId',
    );
    if (JSON.stringify(copied) !== JSON.stringify(old))
      throw Error('migration:ownership-copy-mismatch');
    await runner.query('DROP TABLE monero_withdrawal_output');
    await runner.query(
      'ALTER TABLE monero_withdrawal_output_v2 RENAME TO monero_withdrawal_output',
    );
    if (
      JSON.stringify(
        await runner.query(
          'SELECT * FROM monero_withdrawal_reservation ORDER BY reservationId',
        ),
      ) !== JSON.stringify(history) ||
      JSON.stringify(
        await runner.query('SELECT * FROM monero_withdrawal_identity'),
      ) !== JSON.stringify(identity) ||
      (await runner.query('PRAGMA foreign_key_check')).length
    )
      throw Error('migration:history-changed');
  }

  async down(runner: QueryRunner): Promise<void> {
    if (!runner.isTransactionActive)
      throw Error('migration:transaction-required');
    if (
      (
        await runner.query(
          'SELECT 1 FROM monero_withdrawal_reservation LIMIT 1',
        )
      ).length ||
      (await runner.query('SELECT 1 FROM monero_withdrawal_output LIMIT 1'))
        .length
    )
      throw Error('Cannot downgrade populated withdrawal reservation history');
    await runner.query('DROP TABLE monero_withdrawal_output');
    await runner.query(`CREATE TABLE monero_withdrawal_output (
      reservationId TEXT PRIMARY KEY NOT NULL REFERENCES monero_withdrawal_reservation(reservationId) ON DELETE RESTRICT,
      network TEXT NOT NULL, publicKey TEXT NOT NULL, txid TEXT NOT NULL,
      outputIndex TEXT NOT NULL, globalIndex TEXT NOT NULL, amount TEXT NOT NULL,
      commitment TEXT NOT NULL,
      UNIQUE(network,publicKey), UNIQUE(network,txid,outputIndex), UNIQUE(network,globalIndex))`);
  }
}
