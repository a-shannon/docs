import {defineConfig} from 'vitest/config';
export default defineConfig({test:{environment:'node',globals:true,include:['watcherSource.spec.ts'],pool:'forks',poolOptions:{forks:{singleFork:true}},testTimeout:600000,hookTimeout:600000}});
