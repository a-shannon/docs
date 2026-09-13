import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  Relation,
} from '@rosen-bridge/extended-typeorm';

import { CreditOutboxEntity } from './creditOutboxEntity';

@Entity('monero_credit_delivery')
export class CreditDeliveryEntity {
  @PrimaryColumn('varchar') obligationId: string;
  @Column('varchar') payloadHash: string;
  @Column('varchar') destinationId: string;
  @Column('varchar') destinationProfile: string;
  @Column('varchar') owner: string;
  @Column('varchar') generation: string;
  @Column('varchar') leaseUntil: string;
  @Column('varchar') status: string;
  @Column('text', { nullable: true }) acknowledgement: string | null;
  @ManyToOne(() => CreditOutboxEntity, {
    nullable: false,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'obligationId', referencedColumnName: 'obligationId' })
  outbox: Relation<CreditOutboxEntity>;
}
