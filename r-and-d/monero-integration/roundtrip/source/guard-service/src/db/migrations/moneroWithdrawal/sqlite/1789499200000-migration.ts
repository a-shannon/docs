import type {
  MigrationInterface,
  QueryRunner,
} from '@rosen-bridge/extended-typeorm';

/** Isolated prototype history. Never registered in live guard initialization. */
export class Migration1789499200000 implements MigrationInterface {
  name = 'Migration1789499200000';
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE monero_withdrawal_identity (
      singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton=1),
      sourceNetwork TEXT NOT NULL, network TEXT NOT NULL,
      vaultSpend TEXT NOT NULL, vaultView TEXT NOT NULL, lastNow TEXT NOT NULL)`);
    await runner.query(`CREATE TABLE monero_withdrawal_reservation (
      reservationId TEXT PRIMARY KEY NOT NULL, reservationHash TEXT NOT NULL,
      requestJson TEXT NOT NULL, selectionBytes TEXT NOT NULL,
      eventId TEXT NOT NULL, sourceNetwork TEXT NOT NULL,
      network TEXT NOT NULL, vaultSpend TEXT NOT NULL, vaultView TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('reserved','claimed','completed')),
      owner TEXT NOT NULL, generation TEXT NOT NULL, leaseUntil TEXT NOT NULL,
      receiptJson TEXT, receiptHash TEXT,
      UNIQUE(sourceNetwork,eventId),
      CHECK((state='completed' AND receiptJson IS NOT NULL AND receiptHash IS NOT NULL) OR
            (state!='completed' AND receiptJson IS NULL AND receiptHash IS NULL)))`);
    await runner.query(`CREATE TABLE monero_withdrawal_output (
      reservationId TEXT PRIMARY KEY NOT NULL REFERENCES monero_withdrawal_reservation(reservationId) ON DELETE RESTRICT,
      network TEXT NOT NULL, publicKey TEXT NOT NULL, txid TEXT NOT NULL,
      outputIndex TEXT NOT NULL, globalIndex TEXT NOT NULL, amount TEXT NOT NULL,
      commitment TEXT NOT NULL,
      UNIQUE(network,publicKey), UNIQUE(network,txid,outputIndex), UNIQUE(network,globalIndex))`);
  }
  async down(runner: QueryRunner): Promise<void> {
    if (
      (
        await runner.query(
          'SELECT 1 FROM monero_withdrawal_reservation LIMIT 1',
        )
      ).length
    )
      throw Error('Cannot remove populated withdrawal reservation history');
    await runner.query('DROP TABLE monero_withdrawal_output');
    await runner.query('DROP TABLE monero_withdrawal_reservation');
    await runner.query('DROP TABLE monero_withdrawal_identity');
  }
}
