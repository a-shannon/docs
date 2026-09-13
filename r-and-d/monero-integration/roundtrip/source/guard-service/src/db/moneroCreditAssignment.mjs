import { DatabaseSync } from 'node:sqlite';
import { openSync, closeSync, lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createHash, ECDH } from 'node:crypto';

const hash = text => createHash('sha256').update(text).digest('hex');
function shape(value, fields, label) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join(',') !== [...fields].sort().join(',')) throw Error(label + ':schema');
}
function text(value, label) {
  if (typeof value !== 'string' || !value.length || value.length > 256 || /[\u0000-\u001f]/.test(value)) throw Error(label + ':text');
}
function hex(value, bytes, label) {
  if (typeof value !== 'string' || !new RegExp('^[0-9a-f]{' + bytes * 2 + '}$').test(value)) throw Error(label + ':hex');
}
export function canonicalAssignment(value) {
  const normalize = item => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (Number.isSafeInteger(item)) return item;
    if (Array.isArray(item)) return item.map(normalize);
    if (item && Object.getPrototypeOf(item) === Object.prototype)
      return Object.fromEntries(Object.keys(item).sort().map(key => [key, normalize(item[key])]));
    throw Error('canonical:value');
  };
  return JSON.stringify(normalize(value));
}
function configBytes(config) {
  shape(config, ['custodyDomain','guardKey','committeeKeys','quorum','maxFaults','activationId','policyEpoch','policyDigest'], 'config');
  for (const name of ['custodyDomain','activationId','policyEpoch']) text(config[name], name);
  hex(config.policyDigest, 32, 'policyDigest');
  if (!Array.isArray(config.committeeKeys) || config.committeeKeys.length !== 4 ||
      config.quorum !== 3 || config.maxFaults !== 1 ||
      2 * config.quorum <= config.committeeKeys.length + config.maxFaults) throw Error('config:quorum');
  for (const key of config.committeeKeys) {
    hex(key, 33, 'committeeKey');
    if (!/^(02|03)/.test(key)) throw Error('committeeKey:encoding');
    try { if (ECDH.convertKey(key, 'secp256k1', 'hex', 'hex', 'compressed') !== key) throw Error(); }
    catch { throw Error('committeeKey:point'); }
  }
  if (new Set(config.committeeKeys).size !== 4 || !config.committeeKeys.includes(config.guardKey)) throw Error('config:guard');
  return canonicalAssignment(config);
}
export function assignmentConfigDigest(config) { return hash(configBytes(config)); }
export function committeeConfigDigest(config) {
  configBytes(config);
  const {guardKey: _guardKey, ...common}=config;
  return hash(canonicalAssignment(common));
}
function requestBytes(request, config, committeeDigest) {
  shape(request, ['binding','outputs'], 'request');
  shape(request.binding, ['obligationId','creditTransactionDigest','sourceIntentDigest','triggerBoxId','policyDigest','committeeDigest'], 'binding');
  const b = request.binding;
  text(b.obligationId, 'obligationId');
  for (const name of ['creditTransactionDigest','sourceIntentDigest','triggerBoxId','policyDigest','committeeDigest']) hex(b[name],32,name);
  if (b.policyDigest !== config.policyDigest || b.committeeDigest !== committeeDigest) throw Error('binding:context');
  if (!Array.isArray(request.outputs) || !request.outputs.length || request.outputs.length > 128) throw Error('outputs:count');
  const outputs = request.outputs.map(output => {
    shape(output, ['sourceNetwork','publicKey'], 'output');
    if (!['mainnet','testnet','stagenet'].includes(output.sourceNetwork)) throw Error('output:network');
    hex(output.publicKey,32,'outputKey');
    return { sourceNetwork:output.sourceNetwork, publicKey:output.publicKey,
      economicId:`monero:output-key:${output.sourceNetwork}:${output.publicKey}` };
  }).sort((a,b) => a.economicId < b.economicId ? -1 : a.economicId > b.economicId ? 1 : 0);
  if (new Set(outputs.map(o => o.economicId)).size !== outputs.length) throw Error('outputs:duplicate');
  const bytes = canonicalAssignment({binding:b,outputs});
  return {bytes,digest:hash(bytes),outputs,binding:b};
}

/** Guard-owned durable anti-equivocation state. Caller owns source/payment verification.
 * No release, epoch migration, standalone signing authority, or rollback detection. */
export class MoneroCreditAssignment {
  #db; #config; #configBytes; #digest; #committeeDigest; #path; #identity; #closed = false;
  static create(file, config) { return new MoneroCreditAssignment(file, config, true); }
  static open(file, config) { return new MoneroCreditAssignment(file, config, false); }
  constructor(file, config, create) {
    const bytes = configBytes(config);
    if (typeof file !== 'string' || !isAbsolute(file)) throw Error('custody:absolute-path');
    // Exclusive creation is explicit; open never interprets missing state as fresh.
    const fd = openSync(file, create ? 'wx' : 'r+'); closeSync(fd);
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error('custody:regular-file');
    this.#path=file; this.#identity={dev:stat.dev,ino:stat.ino};
    this.#config=structuredClone(config); this.#configBytes=bytes; this.#digest=hash(bytes); this.#committeeDigest=committeeConfigDigest(config);
    const db = new DatabaseSync(file); this.#db=db;
    try {
      db.exec('PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=EXTRA; PRAGMA foreign_keys=ON;');
      if (db.prepare('PRAGMA synchronous').get().synchronous !== 3 ||
          db.prepare('PRAGMA journal_mode').get().journal_mode !== 'wal') throw Error('custody:durability');
      if (create) this.#transaction(() => {
        db.exec(`CREATE TABLE metadata(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL,config TEXT NOT NULL,revision INTEGER NOT NULL);
          CREATE TABLE claims(obligationId TEXT PRIMARY KEY,requestDigest TEXT NOT NULL,request TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('assigned','invalidated')),reason TEXT NOT NULL);
          CREATE TABLE outputs(economicId TEXT PRIMARY KEY,obligationId TEXT NOT NULL REFERENCES claims(obligationId));`);
        db.prepare('INSERT INTO metadata VALUES(1,1,?,0)').run(bytes);
      });
      this.#verify();
    } catch (error) { db.close(); this.#closed=true; throw error; }
  }
  #live() {
    if (this.#closed) throw Error('custody:closed');
    const stat=lstatSync(this.#path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.dev!==this.#identity.dev || stat.ino!==this.#identity.ino) throw Error('custody:file-replaced');
  }
  #verify() {
    this.#live();
    const m=this.#db.prepare('SELECT * FROM metadata').all();
    if (m.length!==1 || m[0].singleton!==1 || m[0].version!==1 || m[0].config!==this.#configBytes ||
        !Number.isSafeInteger(m[0].revision) || m[0].revision<0) throw Error('custody:config-drift');
    if (this.#db.prepare('PRAGMA quick_check').get().quick_check!=='ok' ||
        this.#db.prepare('PRAGMA foreign_key_check').all().length) throw Error('custody:integrity');
    const claims=this.#db.prepare('SELECT * FROM claims').all();
    const outputs=this.#db.prepare('SELECT * FROM outputs ORDER BY economicId').all();
    for (const c of claims) {
      const parsed=JSON.parse(c.request), request=requestBytes({binding:parsed.binding,outputs:parsed.outputs.map(({sourceNetwork,publicKey})=>({sourceNetwork,publicKey}))},this.#config,this.#committeeDigest);
      if (request.bytes!==c.request || request.digest!==c.requestDigest || request.binding.obligationId!==c.obligationId ||
          !['assigned','invalidated'].includes(c.status) || (c.status==='assigned' ? c.reason!=='' : !c.reason)) throw Error('custody:claim-integrity');
      const actual=outputs.filter(o=>o.obligationId===c.obligationId).map(o=>o.economicId);
      if (canonicalAssignment(actual)!==canonicalAssignment(request.outputs.map(o=>o.economicId))) throw Error('custody:output-integrity');
    }
  }
  #transaction(fn) {
    this.#live(); this.#db.exec('BEGIN IMMEDIATE');
    try { const result=fn(); this.#db.exec('COMMIT'); return result; }
    catch(error) { this.#db.exec('ROLLBACK'); throw error; }
  }
  #bump() {
    if (this.#db.prepare('UPDATE metadata SET revision=revision+1 WHERE singleton=1 AND revision<9007199254740991').run().changes!==1) throw Error('custody:revision-exhausted');
  }
  get configDigest() { return this.#digest; }
  /** Exact custody observation only; terminal state is not usable authorization. */
  observeAssignment(request) {
    this.#live(); const r=requestBytes(structuredClone(request),this.#config,this.#committeeDigest);
    this.#db.exec('BEGIN');
    try {
      this.#verify();
      const claim=this.#db.prepare('SELECT * FROM claims WHERE obligationId=?').get(r.binding.obligationId);
      if (!claim) {
        const find=this.#db.prepare('SELECT obligationId FROM outputs WHERE economicId=?');
        throw Error(r.outputs.some(o=>find.get(o.economicId))?'assignment:conflict':'assignment:missing');
      }
      if (claim.request!==r.bytes || claim.requestDigest!==r.digest) throw Error('assignment:conflict');
      const observation={status:claim.status,requestDigest:r.digest,obligationId:claim.obligationId,reason:claim.reason};
      this.#db.exec('COMMIT');return observation;
    } catch(error) {this.#db.exec('ROLLBACK');throw error;}
  }
  /** Never assigns or recreates a claim, including after restart. */
  assertAssigned(request) {
    const observation=this.observeAssignment(request);
    if (observation.status!=='assigned') throw Error('assignment:invalidated');
    return observation;
  }
  assign(request) {
    this.#live(); const r=requestBytes(structuredClone(request),this.#config,this.#committeeDigest);
    return this.#transaction(() => {
      const previous=this.#db.prepare('SELECT * FROM claims WHERE obligationId=?').get(r.binding.obligationId);
      if (previous) {
        if (previous.request!==r.bytes || previous.requestDigest!==r.digest) return {status:'conflict'};
        if (previous.status==='invalidated') return {status:'invalidated',requestDigest:r.digest};
        return {status:'existing',requestDigest:r.digest};
      }
      const find=this.#db.prepare('SELECT obligationId FROM outputs WHERE economicId=?');
      if (r.outputs.some(o=>find.get(o.economicId))) return {status:'conflict'};
      this.#db.prepare("INSERT INTO claims VALUES(?,?,?,'assigned','')").run(r.binding.obligationId,r.digest,r.bytes);
      const insert=this.#db.prepare('INSERT INTO outputs VALUES(?,?)');
      for (const output of r.outputs) insert.run(output.economicId,r.binding.obligationId);
      this.#bump(); return {status:'assigned',requestDigest:r.digest};
    });
  }
  invalidate(obligationId, reason) {
    text(obligationId,'obligationId'); text(reason,'reason');
    return this.#transaction(() => {
      const claim=this.#db.prepare('SELECT status FROM claims WHERE obligationId=?').get(obligationId);
      if (!claim) return {status:'missing'};
      if (claim.status!=='invalidated') {
        this.#db.prepare("UPDATE claims SET status='invalidated',reason=? WHERE obligationId=?").run(reason,obligationId); this.#bump();
      }
      return {status:'invalidated'};
    });
  }
  /** Observation for caller continuity; a valid older snapshot cannot be detected locally. */
  checkpoint() {
    return this.#transaction(() => {
      const revision=this.#db.prepare('SELECT revision FROM metadata').get().revision;
      const claims=this.#db.prepare('SELECT * FROM claims ORDER BY obligationId').all().map(row=>({...row}));
      const outputs=this.#db.prepare('SELECT * FROM outputs ORDER BY economicId').all().map(row=>({...row}));
      return {configDigest:this.#digest,revision,claims:claims.length,outputs:outputs.length,
        stateDigest:hash(canonicalAssignment({configDigest:this.#digest,revision,claims,outputs}))};
    });
  }
  close() { if (!this.#closed) { this.#db.close(); this.#closed=true; } }
}
