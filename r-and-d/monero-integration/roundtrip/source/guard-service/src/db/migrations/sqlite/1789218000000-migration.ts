import { MigrationInterface, QueryRunner } from 'typeorm';

// Portable DDL: uint64 data is text, never a signed SQL integer.
export const depositSchema = [
  `CREATE TABLE "monero_deposit_context" ("id" varchar PRIMARY KEY NOT NULL, "digest" varchar NOT NULL, "body" text NOT NULL)`,
  `CREATE TABLE "monero_deposit_decision" (
    "id" varchar PRIMARY KEY NOT NULL, "sourceNetwork" varchar NOT NULL, "txid" varchar NOT NULL,
    "retryFingerprint" varchar NOT NULL, "envelopeDigest" varchar NOT NULL, "envelope" text NOT NULL,
    "authority" text NOT NULL, "contextDigest" varchar NOT NULL, UNIQUE ("sourceNetwork", "txid"))`,
  `CREATE TABLE "monero_deposit_output" (
    "economicId" varchar PRIMARY KEY NOT NULL, "sourceNetwork" varchar NOT NULL, "publicKey" varchar NOT NULL,
    "txid" varchar NOT NULL, "outputIndex" varchar NOT NULL, "amount" varchar NOT NULL, "decisionId" varchar NOT NULL,
    UNIQUE ("sourceNetwork", "publicKey"), UNIQUE ("sourceNetwork", "txid", "outputIndex"),
    FOREIGN KEY ("decisionId") REFERENCES "monero_deposit_decision"("id") ON DELETE RESTRICT)`,
  `CREATE TABLE "monero_credit_outbox" (
    "decisionId" varchar PRIMARY KEY NOT NULL, "obligationId" varchar UNIQUE NOT NULL,
    "payloadHash" varchar NOT NULL, "payload" text NOT NULL, "status" varchar NOT NULL,
    FOREIGN KEY ("decisionId") REFERENCES "monero_deposit_decision"("id") ON DELETE RESTRICT)`,
];

export class Migration1789218000000 implements MigrationInterface {
  name = 'Migration1789218000000';
  async up(runner: QueryRunner): Promise<void> {
    for (const sql of depositSchema) await runner.query(sql);
  }
  async down(runner: QueryRunner): Promise<void> {
    // Rollback is only for an empty, never-used schema. Historical ownership must survive.
    for (const table of [
      'monero_credit_outbox',
      'monero_deposit_output',
      'monero_deposit_decision',
      'monero_deposit_context',
    ]) {
      const rows = await runner.query(`SELECT 1 FROM "${table}" LIMIT 1`);
      if (rows.length)
        throw new Error('Cannot remove a populated deposit registry');
    }
    for (const table of [
      'monero_credit_outbox',
      'monero_deposit_output',
      'monero_deposit_decision',
      'monero_deposit_context',
    ])
      await runner.query(`DROP TABLE "${table}"`);
  }
}
