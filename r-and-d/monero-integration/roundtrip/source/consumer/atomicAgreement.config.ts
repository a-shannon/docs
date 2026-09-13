import {defineConfig} from 'vitest/config';
export default defineConfig({test:{globals:true,environment:'node',include:['atomicAgreement.spec.ts'],pool:'forks',poolOptions:{forks:{singleFork:true}},testTimeout:10000}});
