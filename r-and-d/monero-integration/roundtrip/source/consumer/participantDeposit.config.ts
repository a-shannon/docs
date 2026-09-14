import {defineConfig} from 'vitest/config';
import {join} from 'node:path';
import {config} from '../tools/config.mjs';

export default defineConfig({cacheDir:join(config.runtimeDirectory,'participant-deposit-cache'),test:{
  environment:'node',include:['participantDeposit.spec.ts'],pool:'forks',poolOptions:{forks:{singleFork:true}},
  testTimeout:240000,hookTimeout:30000,
}});
