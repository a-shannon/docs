import {
  Column,
  Entity,
  Index,
  PrimaryColumn,
} from '@rosen-bridge/extended-typeorm';

@Entity('monero_deposit_decision')
@Index(['sourceNetwork', 'txid'], { unique: true })
export class DepositDecisionEntity {
  @PrimaryColumn('varchar') id: string;
  @Column('varchar') sourceNetwork: string;
  @Column('varchar') txid: string;
  @Column('varchar') retryFingerprint: string;
  @Column('varchar') envelopeDigest: string;
  @Column('text') envelope: string;
  @Column('text') authority: string;
  @Column('varchar') contextDigest: string;
}
