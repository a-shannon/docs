import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  Relation,
} from '@rosen-bridge/extended-typeorm';

import { DepositDecisionEntity } from './depositDecisionEntity';

@Entity('monero_deposit_output')
@Index(['sourceNetwork', 'publicKey'], { unique: true })
@Index(['sourceNetwork', 'txid', 'outputIndex'], { unique: true })
export class DepositOutputEntity {
  @PrimaryColumn('varchar') economicId: string;
  @Column('varchar') sourceNetwork: string;
  @Column('varchar') publicKey: string;
  @Column('varchar') txid: string;
  @Column('varchar') outputIndex: string;
  @Column('varchar') amount: string;
  @Column('varchar') decisionId: string;
  @ManyToOne(() => DepositDecisionEntity, {
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'decisionId' })
  decision: Relation<DepositDecisionEntity>;
}
