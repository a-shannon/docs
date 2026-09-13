import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  Relation,
} from '@rosen-bridge/extended-typeorm';

import { DepositDecisionEntity } from './depositDecisionEntity';

@Entity('monero_credit_outbox')
export class CreditOutboxEntity {
  @PrimaryColumn('varchar') decisionId: string;
  @Column('varchar', { unique: true }) obligationId: string;
  @Column('varchar') payloadHash: string;
  @Column('text') payload: string;
  @Column('varchar') status: string;
  @ManyToOne(() => DepositDecisionEntity, {
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'decisionId' })
  decision: Relation<DepositDecisionEntity>;
}
