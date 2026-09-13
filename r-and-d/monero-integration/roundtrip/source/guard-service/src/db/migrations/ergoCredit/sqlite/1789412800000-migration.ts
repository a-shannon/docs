import type {
  MigrationInterface,
  QueryRunner,
} from '@rosen-bridge/extended-typeorm';

/** Synthetic destination ledger only. No source schema or chain activation. */
export class Migration1789412800000 implements MigrationInterface {
  name = 'Migration1789412800000';
  async up(runner: QueryRunner): Promise<void> {
    const invalid =
      await runner.query(`SELECT e.obligationId FROM ergo_credit_execution e
      LEFT JOIN ergo_credit_signed s ON s.obligationId=e.obligationId
      WHERE (e.state='signed' AND s.obligationId IS NULL) OR (e.state<>'signed' AND s.obligationId IS NOT NULL)`);
    if (invalid.length)
      throw Error('Cannot migrate inconsistent signing state');
    await runner.query(`CREATE TABLE ergo_credit_effect_execution (
      obligationId TEXT PRIMARY KEY NOT NULL REFERENCES ergo_credit(obligationId) ON DELETE RESTRICT,
      preparationHash TEXT NOT NULL, signedHash TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','effecting','effected')),
      owner TEXT NOT NULL, generation TEXT NOT NULL, leaseUntil TEXT NOT NULL, updatedAt TEXT NOT NULL,
      CHECK((state='pending' AND owner='' AND generation='0' AND leaseUntil='0' AND updatedAt='0') OR
        (state IN ('effecting','effected') AND length(owner)>0 AND generation<>'0')))`);
    await runner.query(`INSERT INTO ergo_credit_effect_execution
      SELECT obligationId,preparationHash,signedHash,'pending','','0','0','0' FROM ergo_credit_signed`);
    await runner.query(`CREATE TABLE ergo_credit_ledger_identity (
      singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton=1), destinationId TEXT NOT NULL,
      destinationProfile TEXT NOT NULL, seedJson TEXT NOT NULL, seedHash TEXT NOT NULL)`);
    await runner.query(`CREATE TABLE ergo_credit_effect (
      obligationId TEXT PRIMARY KEY NOT NULL REFERENCES ergo_credit(obligationId) ON DELETE RESTRICT,
      effectId TEXT NOT NULL UNIQUE, nativeTxId TEXT NOT NULL UNIQUE,
      preparationHash TEXT NOT NULL, signedHash TEXT NOT NULL,
      inputsJson TEXT NOT NULL, outputsJson TEXT NOT NULL,
      acknowledgement TEXT NOT NULL, acknowledgementHash TEXT NOT NULL)`);
    await runner.query(`CREATE TABLE ergo_credit_utxo (
      boxId TEXT PRIMARY KEY NOT NULL, boxHex TEXT NOT NULL,
      originEffect TEXT REFERENCES ergo_credit_effect(effectId) ON DELETE RESTRICT,
      state TEXT NOT NULL CHECK(state IN ('unspent','spent')),
      spentBy TEXT REFERENCES ergo_credit_effect(effectId) ON DELETE RESTRICT,
      CHECK((state='unspent' AND spentBy IS NULL) OR (state='spent' AND spentBy IS NOT NULL)))`);
  }
  async down(runner: QueryRunner): Promise<void> {
    if (
      (await runner.query('SELECT 1 FROM ergo_credit LIMIT 1')).length ||
      (await runner.query('SELECT 1 FROM ergo_credit_ledger_identity LIMIT 1'))
        .length
    )
      throw Error('Cannot remove populated effect history');
    await runner.query('DROP TABLE ergo_credit_utxo');
    await runner.query('DROP TABLE ergo_credit_effect');
    await runner.query('DROP TABLE ergo_credit_ledger_identity');
    await runner.query('DROP TABLE ergo_credit_effect_execution');
  }
}
