import type {
  MigrationInterface,
  QueryRunner,
} from '@rosen-bridge/extended-typeorm';

/** Dedicated local destination schema; not registered in live guard service initialization. */
export class Migration1789240000000 implements MigrationInterface {
  name = 'Migration1789240000000';
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(
      `CREATE TABLE ergo_credit_identity (singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton=1), id TEXT NOT NULL, profile TEXT NOT NULL)`,
    );
    await runner.query(`CREATE TABLE ergo_credit (
      obligationId TEXT PRIMARY KEY NOT NULL, bindingJson TEXT NOT NULL,
      candidateJson TEXT NOT NULL, candidateHash TEXT NOT NULL, preparationHash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status='prepared'))`);
    await runner.query(`CREATE TABLE ergo_credit_output (
      economicId TEXT PRIMARY KEY NOT NULL, sourceNetwork TEXT NOT NULL, publicKey TEXT NOT NULL,
      txid TEXT NOT NULL, outputIndex TEXT NOT NULL, amount TEXT NOT NULL, vaultEpoch TEXT NOT NULL,
      obligationId TEXT NOT NULL REFERENCES ergo_credit(obligationId) ON DELETE RESTRICT,
      UNIQUE(sourceNetwork,publicKey))`);
    await runner.query(`CREATE TABLE ergo_credit_input (
      boxId TEXT PRIMARY KEY NOT NULL, boxHex TEXT NOT NULL,
      obligationId TEXT NOT NULL REFERENCES ergo_credit(obligationId) ON DELETE RESTRICT)`);
  }
  async down(runner: QueryRunner): Promise<void> {
    if ((await runner.query('SELECT 1 FROM ergo_credit LIMIT 1')).length)
      throw Error('Cannot remove populated credit preparation history');
    await runner.query('DROP TABLE ergo_credit_input');
    await runner.query('DROP TABLE ergo_credit_output');
    await runner.query('DROP TABLE ergo_credit');
    await runner.query('DROP TABLE ergo_credit_identity');
  }
}
