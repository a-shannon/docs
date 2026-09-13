import {defineConfig,type UserConfig} from 'vitest/config';
import roundtrip from './roundtrip.config';
const base=roundtrip as UserConfig;
export default defineConfig({...base,test:{...base.test,include:['watcherAuthority.spec.ts'],testTimeout:900000,hookTimeout:600000}});
