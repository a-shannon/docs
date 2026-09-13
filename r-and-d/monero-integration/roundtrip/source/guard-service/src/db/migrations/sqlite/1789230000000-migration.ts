import { MigrationInterface, QueryRunner } from 'typeorm';

export const deliverySchema = `CREATE TABLE "monero_credit_delivery" (
  "obligationId" varchar PRIMARY KEY NOT NULL, "payloadHash" varchar NOT NULL,
  "destinationId" varchar NOT NULL, "destinationProfile" varchar NOT NULL,
  "owner" varchar NOT NULL, "generation" varchar NOT NULL, "leaseUntil" varchar NOT NULL,
  "status" varchar NOT NULL CHECK ("status" IN ('claimed','delivered')),
  "acknowledgement" text,
  CHECK (("status"='claimed' AND "acknowledgement" IS NULL) OR
         ("status"='delivered' AND "acknowledgement" IS NOT NULL)),
  FOREIGN KEY ("obligationId") REFERENCES "monero_credit_outbox"("obligationId") ON DELETE RESTRICT)`;
export class Migration1789230000000 implements MigrationInterface {
  name = 'Migration1789230000000';
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(deliverySchema);
  }
  async down(runner: QueryRunner): Promise<void> {
    if (
      (await runner.query('SELECT 1 FROM "monero_credit_outbox" LIMIT 1'))
        .length
    )
      throw new Error(
        'Cannot remove a populated deposit registry delivery schema',
      );
    if (
      (await runner.query('SELECT 1 FROM "monero_credit_delivery" LIMIT 1'))
        .length
    )
      throw new Error('Cannot remove populated delivery history');
    await runner.query('DROP TABLE "monero_credit_delivery"');
  }
}
