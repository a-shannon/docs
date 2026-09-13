import {
  BlockEntity,
  ExtractorStatusEntity,
  migrations as scannerMigrations,
} from '@rosen-bridge/abstract-scanner';
import {
  AddressTxsEntity,
  migrations as addressTxExtractorMigrations,
} from '@rosen-bridge/evm-address-tx-extractor';
import { DataSource } from '@rosen-bridge/extended-typeorm';
import {
  CommitmentEntity,
  EventTriggerEntity,
  migrations as watcherDataExtractorMigrations,
} from '@rosen-bridge/watcher-data-extractor';

import Configs from '../configs/configs';
import { AddressEntity } from './entities/addressEntity';
import { ArbitraryEntity } from './entities/arbitraryEntity';
import { ChainAddressBalanceEntity } from './entities/chainAddressBalanceEntity';
import { ConfirmedEventEntity } from './entities/confirmedEventEntity';
import { CreditDeliveryEntity } from './entities/creditDeliveryEntity';
import { CreditOutboxEntity } from './entities/creditOutboxEntity';
import { DepositDecisionEntity } from './entities/depositDecisionEntity';
import { DepositOutputEntity } from './entities/depositOutputEntity';
import { EventView } from './entities/eventView';
import { RejectedEventEntity } from './entities/rejectedEventEntity';
import { ReprocessEntity } from './entities/reprocessEntity';
import { RevenueChartView } from './entities/revenueChartView';
import { RevenueEntity } from './entities/revenueEntity';
import { RevenueView } from './entities/revenueView';
import { TransactionEntity } from './entities/transactionEntity';
import migrations from './migrations';

const dbType = Configs.dbType as keyof typeof migrations;
const dbConfigs = {
  entities: [
    DepositDecisionEntity,
    DepositOutputEntity,
    CreditOutboxEntity,
    CreditDeliveryEntity,
    BlockEntity,
    ExtractorStatusEntity,
    CommitmentEntity,
    EventTriggerEntity,
    ConfirmedEventEntity,
    TransactionEntity,
    RevenueEntity,
    RevenueView,
    RevenueChartView,
    EventView,
    AddressTxsEntity,
    ArbitraryEntity,
    ReprocessEntity,
    ChainAddressBalanceEntity,
    AddressEntity,
    RejectedEventEntity,
  ],
  migrations: [
    ...scannerMigrations[dbType],
    ...watcherDataExtractorMigrations[dbType],
    ...addressTxExtractorMigrations[dbType],
    ...migrations[dbType],
  ],
  synchronize: false,
  logging: false,
};
let dataSource: DataSource;
if (Configs.dbType === 'sqlite') {
  dataSource = new DataSource({
    type: 'sqlite',
    database: Configs.dbPath,
    ...dbConfigs,
  });
} else {
  dataSource = new DataSource({
    type: 'postgres',
    host: Configs.dbHost,
    port: Configs.dbPort,
    username: Configs.dbUser,
    password: Configs.dbPassword,
    database: Configs.dbName,
    ...dbConfigs,
  });
}

export { dataSource };
