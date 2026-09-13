import type {
  MigrationInterface,
  QueryRunner,
} from '@rosen-bridge/extended-typeorm';

/** Dedicated local signing state; original preparation records remain immutable. */
export class Migration1789326400000 implements MigrationInterface {
  name = 'Migration1789326400000';
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE ergo_credit_execution (
      obligationId TEXT PRIMARY KEY NOT NULL REFERENCES ergo_credit(obligationId) ON DELETE RESTRICT,
      state TEXT NOT NULL CHECK(state IN ('prepared','signing','signed')),
      owner TEXT NOT NULL, generation TEXT NOT NULL, leaseUntil TEXT NOT NULL, updatedAt TEXT NOT NULL,
      CHECK((state='prepared' AND owner='' AND generation='0' AND leaseUntil='0' AND updatedAt='0') OR
        (state IN ('signing','signed') AND length(owner)>0 AND generation<>'0')))`);
    await runner.query(
      `INSERT INTO ergo_credit_execution SELECT obligationId,'prepared','','0','0','0' FROM ergo_credit`,
    );
    await runner.query(`CREATE TABLE ergo_credit_signed (
      obligationId TEXT PRIMARY KEY NOT NULL REFERENCES ergo_credit(obligationId) ON DELETE RESTRICT,
      preparationHash TEXT NOT NULL, signedHex TEXT NOT NULL, signedHash TEXT NOT NULL,
      nativeTxId TEXT NOT NULL, verificationJson TEXT NOT NULL, verificationHash TEXT NOT NULL)`);
    await runner.query(`CREATE TABLE ergo_credit_execution_clock (
      singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton=1), observedAt TEXT NOT NULL)`);
    await runner.query(
      `INSERT INTO ergo_credit_execution_clock VALUES (1,'0')`,
    );
  }
  async down(runner: QueryRunner): Promise<void> {
    if ((await runner.query('SELECT 1 FROM ergo_credit LIMIT 1')).length)
      throw Error('Cannot remove populated credit signing history');
    await runner.query('DROP TABLE ergo_credit_signed');
    await runner.query('DROP TABLE ergo_credit_execution');
    await runner.query('DROP TABLE ergo_credit_execution_clock');
  }
}
