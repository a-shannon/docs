import {config,sourceRoot,sourceURL,rosenURL} from '../tools/config.mjs';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(config.rosenRoot+'/package.json');
const ts = require('typescript');
export async function resolve(specifier, context, next) {
  try { return await next(specifier, context); } catch (error) {
    for (const suffix of ['.js', '.ts', '/index.js', '/index.ts']) {
      try { return await next(specifier + suffix, context); } catch {}
    }
    throw error;
  }
}
export async function load(url, context, next) {
  if (url.endsWith('.ts')) return {format:'module',shortCircuit:true,source:ts.transpileModule(await fs.readFile(new URL(url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText};
  return next(url, context);
}
