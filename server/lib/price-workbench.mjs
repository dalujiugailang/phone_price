import { DatabaseSync } from 'node:sqlite';
import {initializeFormalPublications,commitFormalPublication,carryFormalPrices} from './formal-price-publications.mjs';
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {AsyncLocalStorage} from 'node:async_hooks';

export const STORES = ['华为京东自营旗舰店','荣耀京东自营旗舰店','小米京东自营旗舰店','OPPO京东自营旗舰店','一加手机京东自营旗舰店','真我realme京东自营旗舰店','vivo京东自营旗舰店','iQOO京东自营旗舰店','三星京东自营官方旗舰店','魅族京东自营旗舰店','联想moto手机京东自营旗舰店','努比亚京东自营旗舰店','红魔京东自营旗舰店','中兴京东自营旗舰店'];
const now = () => new Date().toISOString();
const parse = (s, fallback = null) => s ? JSON.parse(s) : fallback;
export const canonical = (s) => String(s ?? '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
export function storageIdentity(s) {
  const text = canonical(s);
  const m = text.match(/^(\d+)(?:gb|g)?\+(\d+)(tb|t|gb|g)(.*)$/);
  return m ? `${Number(m[1])}:${Number(m[2]) * (/^t/.test(m[3]) ? 1024 : 1)}:${m[4]}` : `unknown-ram:${text}`;
}
export const skuIdentity = (model, storage) => `${canonical(model)}|${storageIdentity(storage)}`;
export function cents(value) {
  if (value === '' || value === null || value === undefined) return null;
  const s = String(value).replace(/,/g, '').trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(s)) throw fault(422, '金额须为非负数，最多两位小数');
  const [whole, fraction = ''] = s.split('.');
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(result) || result > 100_000_000) throw fault(422, '金额超出有效范围');
  return result;
}
export function subsidy(list, coupon) {
  if (list === null || coupon === null || coupon > list || list <= 0) return null;
  const net = list - coupon;
  return net > 600000 ? net - 50000 : net - Math.min(Math.floor((net * 15 + 50) / 100), 50000);
}
export function fault(status, message, extra = {}) { return Object.assign(new Error(message), { status, ...extra }); }
export const beijingDate = (date = new Date()) => new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Shanghai', year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
export function validDate(date) { return /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date)) && new Date(date).toISOString().slice(0,10) === date; }
function passwordHash(password, salt = randomBytes(16).toString('hex')) {
  if (typeof password !== 'string' || password.length < 10 || password.length > 200) throw fault(422, '密码需为 10–200 个字符');
  return `${salt}:${scryptSync(password, salt, 32).toString('hex')}`;
}
function checkPassword(password, stored) {
  try { const [salt] = stored.split(':'); return timingSafeEqual(Buffer.from(passwordHash(password, salt)), Buffer.from(stored)); } catch { return false; }
}
const tokenHash = (s) => createHash('sha256').update(s).digest('hex');
const brandName = (s) => canonical(s) === 'redmi' ? '小米' : String(s ?? '').trim();

export function validateQuote(q, {list = q?.list, coupon = q?.coupon, previous = null} = {}) {
  const issues = [];
  if (!q) return [{code:'NOT_COLLECTED', field:'list', message:'尚未采集'}];
  if (q.error) return [{code:'API_ERROR',field:'list',message:'接口失败，等待重试；并非未匹配或停售'}];
  if (!q.matched) issues.push({code:'NO_MATCH',field:'list',message:q.reason || '未找到合格同规格报价；不代表停售'});
  if (list === null || list <= 0) issues.push({code:'MISSING_LIST',field:'list',message:'缺少有效挂牌价'});
  if (coupon === null) issues.push({code:'MISSING_COUPON',field:'coupon',message:'券额未知；未知不等于 0'});
  if (coupon !== null && list !== null && coupon > list) issues.push({code:'INVALID_COUPON',field:'coupon',message:'券额超过挂牌价'});
  if (q.matched && !STORES.includes(q.shop)) issues.push({code:'SHOP_REJECTED',field:'list',message:'店铺不在指定 14 家范围内'});
  if (q.matched && !/^https?:\/\//i.test(q.link || '')) issues.push({code:'MISSING_LINK',field:'list',message:'缺少可核验商品链接'});
  if (list !== null && coupon !== null && q.actual !== null && q.actual !== undefined && Math.abs(list - coupon - q.actual) > 1) issues.push({code:'PRICE_COMPONENT_MISMATCH',field:'coupon',message:`挂牌减券与接口到手价相差 ${((list - coupon - q.actual)/100).toFixed(2)} 元`});
  if (q.matched && list>0 && coupon!==null && q.actual == null) issues.push({code:'MISSING_ACTUAL',field:'coupon',message:'缺少接口参考到手价，无法交叉校验'});
  if (coupon > 0) {
    if (!q.start || !q.end) issues.push({code:'COUPON_TIME_UNKNOWN',field:'coupon',message:'券有效期未确认'});
    else if (q.date < q.start.slice(0,10) || q.date > q.end.slice(0,10)) issues.push({code:'COUPON_EXPIRED',field:'coupon',message:'券不在采价日期有效期内'});
    if (q.threshold == null) issues.push({code:'COUPON_THRESHOLD_UNKNOWN',field:'coupon',message:'券门槛未确认'});
    else if (q.threshold > list) issues.push({code:'COUPON_THRESHOLD',field:'coupon',message:'单件未达到券门槛'});
  }
  if (previous && list !== null && coupon !== null && Math.abs((list - coupon)/previous - 1) > 0.2) issues.push({code:'PRICE_JUMP',field:'list',message:'净价较上次生效价变动超过 20%'});
  return issues;
}
export function reviewFocus(issues,{generation,list,coupon,quote}={}) {
  const bothMissing=list==null && coupon==null;
  const verificationIssues=issues.filter(i=>i.code==='PRICE_COMPONENT_MISMATCH');
  if(generation==='N' && bothMissing)verificationIssues.push({code:'CURRENT_GEN_NO_PRICE',field:'list',message:'未找到该N代机器京东自营销售信息，请核验'});
  return {verificationIssues,verificationCount:verificationIssues.length,reviewNotice:generation==='N-1' && bothMissing && quote?'未找到该N-1代机器京东自营销售信息':null};
}
export function partitionReviewIssues(issues) {
  const collectionCodes=new Set(['NOT_COLLECTED','NO_MATCH','API_ERROR']);
  const collectionIssues=issues.filter(issue=>collectionCodes.has(issue.code));
  const verificationIssues=issues.filter(issue=>!collectionCodes.has(issue.code));
  return {collectionIssues,verificationIssues,verificationCount:verificationIssues.length};
}

export function createPriceWorkbench({ dataDir, legacyDatabasePath, onPublished = () => {}, provider = null, bootstrap = true, clock = () => new Date() }) {
  fs.mkdirSync(dataDir, {recursive:true});
  const db = new DatabaseSync(path.join(dataDir, 'price-workbench.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,name TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('admin','reviewer','viewer')),password TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS models(id TEXT PRIMARY KEY,identity TEXT UNIQUE NOT NULL,name TEXT NOT NULL,brand TEXT NOT NULL,position TEXT NOT NULL DEFAULT '',generation TEXT NOT NULL DEFAULT '',generation_date TEXT NOT NULL DEFAULT '',version INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS skus(id TEXT PRIMARY KEY,identity TEXT UNIQUE NOT NULL,model_id TEXT NOT NULL REFERENCES models(id),storage TEXT NOT NULL,ppv TEXT NOT NULL DEFAULT '',launch_price TEXT NOT NULL DEFAULT '',active INTEGER NOT NULL DEFAULT 1,first_seen TEXT NOT NULL,legacy_json TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE IF NOT EXISTS observations(id TEXT PRIMARY KEY,sku_id TEXT NOT NULL REFERENCES skus(id),date TEXT NOT NULL,run_id TEXT,quote_json TEXT NOT NULL,raw_json TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS quote_reviews(sku_id TEXT NOT NULL,date TEXT NOT NULL,observation_id TEXT NOT NULL,actor TEXT NOT NULL,reason TEXT NOT NULL,PRIMARY KEY(sku_id,date));
    CREATE TABLE IF NOT EXISTS daily(sku_id TEXT NOT NULL REFERENCES skus(id),date TEXT NOT NULL,observation_id TEXT REFERENCES observations(id),list INTEGER,coupon INTEGER,list_version INTEGER NOT NULL DEFAULT 0,coupon_version INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 0,review_state TEXT NOT NULL DEFAULT 'pending',reviewer_id TEXT,claim_until TEXT,availability TEXT NOT NULL DEFAULT 'unknown',updated_by TEXT,updated_at TEXT,PRIMARY KEY(sku_id,date));
    CREATE TABLE IF NOT EXISTS revisions(id TEXT PRIMARY KEY,sku_id TEXT NOT NULL,date TEXT NOT NULL,list INTEGER,coupon INTEGER,final INTEGER,availability TEXT NOT NULL,observation_id TEXT,actor TEXT NOT NULL,reason TEXT NOT NULL,evidence TEXT NOT NULL,formula TEXT NOT NULL,created_at TEXT NOT NULL,supersedes TEXT);
    CREATE INDEX IF NOT EXISTS revision_lookup ON revisions(sku_id,date,created_at);
    CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,actor TEXT NOT NULL,action TEXT NOT NULL,entity TEXT NOT NULL,before_json TEXT,after_json TEXT,request_id TEXT NOT NULL,created_at TEXT NOT NULL,sku_id TEXT,business_date TEXT);
    CREATE TABLE IF NOT EXISTS imports(hash TEXT PRIMARY KEY,result_json TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,slot TEXT UNIQUE,date TEXT NOT NULL,state TEXT NOT NULL,actor TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,lease_until TEXT);
    CREATE TABLE IF NOT EXISTS run_items(run_id TEXT NOT NULL REFERENCES runs(id),sku_id TEXT NOT NULL REFERENCES skus(id),state TEXT NOT NULL DEFAULT 'queued',attempts INTEGER NOT NULL DEFAULT 0,message TEXT NOT NULL DEFAULT '',PRIMARY KEY(run_id,sku_id));
    CREATE TABLE IF NOT EXISTS outbox(id INTEGER PRIMARY KEY CHECK(id=1),pending INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL,error TEXT);
  `);
  const auditColumns=new Set(db.prepare('PRAGMA table_info(audit)').all().map(c=>c.name));
  if(!auditColumns.has('sku_id'))db.exec('ALTER TABLE audit ADD COLUMN sku_id TEXT');
  if(!auditColumns.has('business_date'))db.exec('ALTER TABLE audit ADD COLUMN business_date TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS observation_history_lookup ON observations(sku_id,date); CREATE INDEX IF NOT EXISTS revision_history_lookup ON revisions(sku_id,date)');
  db.exec('CREATE INDEX IF NOT EXISTS audit_business_date ON audit(business_date,id DESC); CREATE INDEX IF NOT EXISTS audit_sku_id ON audit(sku_id); CREATE INDEX IF NOT EXISTS audit_action ON audit(action)');
  initializeFormalPublications(db,beijingDate(clock()));
  const tx = (fn) => { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  const context=new AsyncLocalStorage();
  function audit(actor, action, entity, before, after, requestId = context.getStore() || randomUUID()) {
    const parsed=String(entity).match(/^(.*)\/(\d{4}-\d{2}-\d{2})(?:\/(?:list|coupon))?$/);
    const skuId=parsed && db.prepare('SELECT id FROM skus WHERE id=?').get(parsed[1])?parsed[1]:null;
    const businessDate=parsed?.[2] || (validDate(after?.date)?after.date:beijingDate());
    db.prepare('INSERT INTO audit(actor,action,entity,before_json,after_json,request_id,created_at,sku_id,business_date) VALUES(?,?,?,?,?,?,?,?,?)').run(actor?.id || actor || 'system',action,entity,JSON.stringify(before ?? null),JSON.stringify(after ?? null),requestId,now(),skuId,businessDate);
  }
  if (bootstrap && !db.prepare('SELECT id FROM users LIMIT 1').get()) {
    const accounts = [['admin','管理员','admin'],['reviewer1','核验人员 1','reviewer'],['reviewer2','核验人员 2','reviewer']].map(([username,name,role]) => ({username,name,role,password:randomBytes(15).toString('base64url')}));
    tx(() => { for (const u of accounts) db.prepare('INSERT INTO users(id,username,name,role,password) VALUES(?,?,?,?,?)').run(randomUUID(),u.username,u.name,u.role,passwordHash(u.password)); });
    fs.writeFileSync(path.join(dataDir,'workbench-initial-accounts.json'), JSON.stringify({notice:'首次登录后请修改密码；仅本机可读，请勿提交 Git。',accounts},null,2), {mode:0o600});
  }
  function upsertSku(row, date) {
    const identity = canonical(row.model);
    let model = db.prepare('SELECT * FROM models WHERE identity=?').get(identity);
    if (!model) {
      const id = randomUUID();
      db.prepare('INSERT INTO models(id,identity,name,brand,position,generation,generation_date) VALUES(?,?,?,?,?,?,?)').run(id,identity,row.model.trim(),brandName(row.brand),row.position || '',row.generation || '',row.generation ? date : '');
      model = db.prepare('SELECT * FROM models WHERE id=?').get(id);
    } else if (row.generation && !model.generation) db.prepare('UPDATE models SET generation=?,generation_date=?,version=version+1 WHERE id=?').run(row.generation,date,model.id);
    const key = skuIdentity(row.model,row.storage);
    const existing = db.prepare('SELECT * FROM skus WHERE identity=?').get(key);
    if (existing) return {id:existing.id,added:false};
    const id = row.id || randomUUID();
    db.prepare('INSERT INTO skus(id,identity,model_id,storage,ppv,launch_price,first_seen,legacy_json) VALUES(?,?,?,?,?,?,?,?)').run(id,key,model.id,row.storage,row.ppv || '',String(row.launchPrice || ''),date,JSON.stringify(row.snapshots || {}));
    return {id,added:true};
  }
  if (!db.prepare("SELECT value FROM meta WHERE key='migrated'").get()) {
    let legacy = null;
    if (fs.existsSync(legacyDatabasePath)) {
      const old = new DatabaseSync(legacyDatabasePath, {readOnly:true});
      try { const r = old.prepare('SELECT dates_json,rows_json FROM raw_editor_drafts WHERE id=1').get(); if (r) legacy = {dates:parse(r.dates_json),rows:parse(r.rows_json)}; } finally { old.close(); }
    }
    if (legacy) tx(() => {
      for (const row of legacy.rows) {
        const first=legacy.dates.find(d=>Object.values(row.snapshots?.[d] || {}).some(v=>String(v ?? '').trim())) || legacy.dates[0];
        const iso=first?.includes('-')?first:first?`2026-${first.split('.')[0].padStart(2,'0')}-${first.split('.')[1]}`:'2026-01-01';
        upsertSku(row,iso);
      }
      db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run('legacy_dates',JSON.stringify(legacy.dates));
      db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run('migrated',now());
      audit('system','MIGRATE_LEGACY','catalog',null,{rows:legacy.rows.length,dates:legacy.dates.length});
    });
  }
  const publicUser = (u) => u ? {id:u.id,username:u.username,name:u.name,role:u.role,active:Boolean(u.active)} : null;
  function login(username, password) {
    const u = db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(String(username));
    // Fixed-cost dummy hash keeps unknown usernames on the same expensive path.
    if (!u) { scryptSync(String(password).slice(0,200),'unknown-user',32); throw fault(401,'账号或密码不正确'); }
    if (!checkPassword(password,u.password)) throw fault(401,'账号或密码不正确');
    const token = randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(tokenHash(token),u.id,new Date(Date.now()+12*3600000).toISOString());
    audit(u,'LOGIN',u.id,null,null);
    return {user:publicUser(u),token};
  }
  function userFromToken(token) { return token ? publicUser(db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>? AND u.active=1').get(tokenHash(token),now())) : null; }
  const sku = (id) => db.prepare('SELECT s.*,m.name model,m.brand,m.position,m.generation FROM skus s JOIN models m ON m.id=s.model_id WHERE s.id=? AND s.active=1').get(id);
  const latestRevision = (id,date) => db.prepare('SELECT * FROM revisions WHERE sku_id=? AND date=? ORDER BY rowid DESC LIMIT 1').get(id,date);
  function work(id,date) {
    const row = db.prepare('SELECT * FROM daily WHERE sku_id=? AND date=?').get(id,date);
    if (!row) return null;
    const observation = row.observation_id ? db.prepare('SELECT id,quote_json,created_at FROM observations WHERE id=?').get(row.observation_id) : null;
    const quote = parse(observation?.quote_json);
    const latest=db.prepare('SELECT id,quote_json FROM observations WHERE sku_id=? AND date=? ORDER BY rowid DESC LIMIT 1').get(id,date);
    const acknowledged=db.prepare('SELECT observation_id FROM quote_reviews WHERE sku_id=? AND date=?').get(id,date)?.observation_id;
    const latestQuote=parse(latest?.quote_json);
    const signature=(q)=>JSON.stringify(['matched','list','coupon','actual','goodsId','shop','start','end','threshold','error'].map(k=>q?.[k] ?? null));
    const newObservation=latest && latest.id!==row.observation_id && latest.id!==acknowledged && signature(latestQuote)!==signature(quote)?{id:latest.id,quote:latestQuote}:null;
    let previous = db.prepare("SELECT list-coupon net FROM revisions WHERE sku_id=? AND date<? AND availability='on_sale' ORDER BY date DESC,rowid DESC LIMIT 1").get(id,date)?.net;
    if(previous===undefined){
      const legacy=parse(db.prepare('SELECT legacy_json FROM skus WHERE id=?').get(id)?.legacy_json,{});
      const iso=(d)=>d.includes('-')?d:`2026-${d.split('.')[0].padStart(2,'0')}-${d.split('.')[1]}`;
      for(const d of Object.keys(legacy).sort((a,b)=>iso(b).localeCompare(iso(a)))){
        if(iso(d)>=date)continue;
        try{const list=cents(legacy[d].listPrice),coupon=cents(legacy[d].coupon);if(list>0 && coupon!==null && coupon<=list){previous=list-coupon;break;}}catch{/* Historical text markers are not numeric prices. */}
      }
    }
    const published = db.prepare('SELECT r.* FROM revisions r JOIN formal_price_publications p ON p.date=r.date AND r.rowid<=p.revision_rowid WHERE r.sku_id=? AND r.date=? ORDER BY r.rowid DESC LIMIT 1').get(id,date);
    const operator = row.updated_by ? db.prepare('SELECT name FROM users WHERE id=?').get(row.updated_by)?.name || row.updated_by : null;
    const claimedBy = row.reviewer_id ? db.prepare('SELECT name FROM users WHERE id=?').get(row.reviewer_id)?.name : null;
    const issues=validateQuote(quote,{list:row.list,coupon:row.coupon,previous});
    const checkedCells={};
    for(const field of ['list','coupon']){
      const check=parse(db.prepare('SELECT value FROM meta WHERE key=?').get(`cell_check:${id}:${date}:${field}`)?.value);
      checkedCells[field]=Boolean(check && check.prices===JSON.stringify([row.list,row.coupon,row.list_version,row.coupon_version]) && check.observationId===(latest?.id || null));
    }
    const resolvedUnavailable=row.review_state==='confirmed' && ['discontinued','out_of_stock','not_launched'].includes(row.availability) && !newObservation;
    return {...row,checkedCells,operator,claimedBy,quote,newObservation,final:subsidy(row.list,row.coupon),issues,...partitionReviewIssues(issues),...reviewFocus(newObservation?validateQuote(newObservation.quote):issues,{generation:sku(id)?.generation,list:newObservation?newObservation.quote?.list:row.list,coupon:newObservation?newObservation.quote?.coupon:row.coupon,quote:newObservation?.quote || quote}),...(resolvedUnavailable?{verificationIssues:[],verificationCount:0,reviewNotice:null}:{}),published,dirty:!published || published.list!==row.list || published.coupon!==row.coupon || ['pending','edited'].includes(row.review_state),original:observation ? {id:observation.id,createdAt:observation.created_at} : null};
  }
  function outbox() {
    const previous=db.prepare('SELECT updated_at FROM outbox WHERE id=1').get()?.updated_at;
    const stamp=new Date(Math.max(Date.now(),previous?Date.parse(previous)+1:0)).toISOString();
    db.prepare('INSERT INTO outbox VALUES(1,1,?,NULL) ON CONFLICT(id) DO UPDATE SET pending=1,updated_at=excluded.updated_at').run(stamp);
  }
  function publish(id,date,actor,{reason,evidence,availability='on_sale',automatic=false} = {}) {
    const row = work(id,date);
    if (!row) throw fault(404,'无当日记录');
    if (automatic) {
      if(!row.issues.length)db.prepare("UPDATE daily SET review_state='api_passed' WHERE sku_id=? AND date=?").run(id,date);
      return null;
    }
    if (availability==='on_sale' && row.final === null) throw fault(422,'挂牌价和券额不完整或非法');
    const revisionId = randomUUID();
    db.prepare('INSERT INTO revisions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(revisionId,id,date,availability==='on_sale'?row.list:null,availability==='on_sale'?row.coupon:null,availability==='on_sale'?row.final:null,availability,row.observation_id,actor?.id || 'api',reason || 'API 校验通过',evidence || row.quote?.link || '', 'user_subsidy_v1',now(),row.published?.id || null);
    db.prepare('UPDATE daily SET review_state=?,availability=?,reviewer_id=NULL,claim_until=NULL,version=version+1,updated_by=?,updated_at=? WHERE sku_id=? AND date=?').run(automatic?'api_passed':'confirmed',availability,actor?.id || 'api',now(),id,date);
    audit(actor || 'api',automatic?'AUTO_PUBLISH':'CONFIRM',`${id}/${date}`,row.published,{revisionId,list:row.list,coupon:row.coupon,availability,reason,evidence});
    if(!automatic){
      const latest=db.prepare('SELECT id FROM observations WHERE sku_id=? AND date=? ORDER BY rowid DESC LIMIT 1').get(id,date);
      if(latest)db.prepare('INSERT INTO quote_reviews VALUES(?,?,?,?,?) ON CONFLICT(sku_id,date) DO UPDATE SET observation_id=excluded.observation_id,actor=excluded.actor,reason=excluded.reason').run(id,date,latest.id,actor.id,reason);
    }
    outbox();
    return revisionId;
  }
  function recordObservation(id,date,quote,raw,runId = null) {
    const observationId = randomUUID();
    const redact=(value)=>Array.isArray(value)?value.map(redact):value && typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,/token|authorization|cookie|secret|password/i.test(k)?'[REDACTED]':redact(v)])):value;
    db.prepare('INSERT INTO observations VALUES(?,?,?,?,?,?,?)').run(observationId,id,date,runId,JSON.stringify(quote),JSON.stringify(redact(raw)),now());
    const old = work(id,date);
    // Human-owned edits and confirmations are never overwritten by an API retry.
    if (old && (old.review_state==='confirmed' || old.review_state==='edited')) {
      if(old.newObservation)db.prepare('UPDATE daily SET version=version+1 WHERE sku_id=? AND date=?').run(id,date);
      return {observationId,protected:true};
    }
    const list = quote.list ?? null, coupon = quote.coupon ?? null;
    db.prepare(`INSERT INTO daily(sku_id,date,observation_id,list,coupon,updated_by,updated_at) VALUES(?,?,?,?,?,'api',?) ON CONFLICT(sku_id,date) DO UPDATE SET observation_id=excluded.observation_id,list=excluded.list,coupon=excluded.coupon,list_version=list_version+1,coupon_version=coupon_version+1,version=version+1,review_state='pending',updated_by='api',updated_at=excluded.updated_at`).run(id,date,observationId,list,coupon,now());
    const revision = publish(id,date,null,{automatic:true});
    return {observationId,published:Boolean(revision)};
  }
  function importRows(rows,date,actor,hash) {
    if (!validDate(date) || !Array.isArray(rows) || rows.length>5000) throw fault(422,'导入日期或行数不正确');
    if(date>beijingDate(clock()))throw fault(422,'不能把报价导入未来日期');
    const old = db.prepare('SELECT result_json FROM imports WHERE hash=?').get(hash);
    if (old) {const result=parse(old.result_json);if(result.date!==date)throw fault(422,'同一来源文件已在其他日期导入，不能更改日期重复入库');return {...result,repeated:true};}
    const result = tx(() => {
      let added=0,reused=0,published=0,unmatched=0;
      const seen = new Set();
      for (const r of rows) {
        if (!r.model?.trim() || !r.storage?.trim()) throw fault(422,'型号和存储不能为空');
        const identity = skuIdentity(r.model,r.storage);
        if (seen.has(identity)) throw fault(422,`来源存在重复 SKU：${r.model} ${r.storage}`);
        seen.add(identity);
        const item = upsertSku(r,date); item.added ? added++ : reused++;
        const g=r.selected;
        if(g?.time && (Number.isNaN(Date.parse(g.time)) || beijingDate(new Date(g.time))!==date))throw fault(422,`查询时间与导入日期不符：${r.model} ${r.storage}`);
        if (!g) unmatched++;
        const quote={matched:Boolean(g),date,fetchedAt:g?.time || null,list:g?cents(g.listing):null,coupon:g?cents(g.coupon):null,actual:g?cents(g.actual):null,shop:g?.shop || '',title:g?.title || '',link:g?.link || '',goodsId:g?.id || '',keyword:g?.query || `${r.model} ${r.storage}`,start:g?.start || '',end:g?.end || '',threshold:g?.threshold === '' || g?.threshold == null ? null : cents(g.threshold),notes:g?.notes || '',matchEvidence:g?.selfEvidence || ''};
        const observed=recordObservation(item.id,date,quote,r,`import:${hash}`);
        if(observed.published)published++;
        audit(actor,'IMPORT_RESULT',`${item.id}/${date}`,null,{source:'Excel 导入',observationId:observed.observationId,model:r.model,storage:r.storage,date,matched:Boolean(g),autoPublished:Boolean(observed.published),protected:Boolean(observed.protected),queryPerformed:false,plannedKeyword:quote.keyword,queryTime:quote.fetchedAt,searchCandidates:r.searchCandidates ?? null,issues:(observed.protected?validateQuote(quote):work(item.id,date).issues).map(i=>i.message)});
      }
      const summary={added,reused,total:rows.length,published,unmatched,date,hash};
      db.prepare('INSERT INTO imports VALUES(?,?,?)').run(hash,JSON.stringify(summary),now());
      audit(actor,'IMPORT',hash,null,summary);
      outbox();
      return summary;
    });
    flushProjection();
    return result;
  }
  function patchCell(id,date,{field,value,baseVersion},actor,withinTransaction=false) {
    if (!sku(id) || !validDate(date) || !['list','coupon'].includes(field)) throw fault(422,'SKU、日期或字段不正确');
    const amount = cents(value);
    const edit=() => {
      db.prepare('INSERT INTO daily(sku_id,date,updated_at) VALUES(?,?,?) ON CONFLICT DO NOTHING').run(id,date,now());
      const old=work(id,date);
      if (old[`${field}_version`] !== baseVersion) throw fault(409,'此单元格已被其他人修改，请比较后重新保存',{current:old});
      if (old.reviewer_id && old.reviewer_id!==actor.id && old.claim_until>now() && actor.role!=='admin') throw fault(409,'该记录正在由其他核验人员处理',{current:old});
      db.prepare(`UPDATE daily SET ${field}=?,${field}_version=${field}_version+1,version=version+1,review_state='edited',updated_by=?,updated_at=? WHERE sku_id=? AND date=?`).run(amount,actor.id,now(),id,date);
      audit(actor,'EDIT_CELL',`${id}/${date}/${field}`,old[field],amount);
      return work(id,date);
    };
    const result=withinTransaction?edit():tx(edit);
    if(!withinTransaction)emit('changed',{skuId:id,date});return result;
  }
  function patchMany(date,changes,actor){
    if(!Array.isArray(changes) || !changes.length || changes.length>1000)throw fault(422,'批量修改需为 1–1000 个单元格');
    const results=tx(()=>changes.map(c=>patchCell(c.id,date,c,actor,true)));
    emit('changed',{date});return {saved:results.length};
  }
  function confirm(id,date,body,actor) {
    const result=tx(() => {
      const row=work(id,date);
      if (!row) throw fault(404,'无当日记录');
      if (row.version!==body.baseVersion) throw fault(409,'记录有新修改，请刷新后再确认',{current:row});
      if (row.reviewer_id && row.reviewer_id!==actor.id && row.claim_until>now() && actor.role!=='admin') throw fault(409,'该记录已由其他人领取');
      if (!['on_sale','out_of_stock','discontinued','not_launched'].includes(body.availability)) throw fault(422,'请选择明确的在售状态');
      if (!body.reason?.trim() || !body.evidence?.trim()) throw fault(422,'确认必须填写结论和证据链接');
      if (!/^https?:\/\//i.test(body.evidence)) throw fault(422,'证据须为有效 HTTP/HTTPS 链接');
      publish(id,date,actor,body);return work(id,date);
    });
    flushProjection(); emit('changed',{skuId:id,date});return result;
  }
  function checkCell(id,date,body,actor) {
    if(!sku(id) || !validDate(date) || !['list','coupon'].includes(body.field))throw fault(422,'SKU、日期或字段不正确');
    const result=tx(()=>{
      const row=work(id,date);if(!row)throw fault(404,'无当日记录');
      if(row.version!==body.baseVersion)throw fault(409,'价格已变化，请刷新后检查');
      const latest=db.prepare('SELECT id FROM observations WHERE sku_id=? AND date=? ORDER BY rowid DESC LIMIT 1').get(id,date);
      const check={version:row.version,prices:JSON.stringify([row.list,row.coupon,row.list_version,row.coupon_version]),observationId:latest?.id || null,actor:actor.id,checkedAt:now()};
      db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`cell_check:${id}:${date}:${body.field}`,JSON.stringify(check));
      audit(actor,'CHECK_CELL',`${id}/${date}/${body.field}`,null,check);return {checked:true};
    });emit('changed',{skuId:id,date});return result;
  }
  function resetApi(date,body,actor) {
    if(actor?.role!=='admin')throw fault(403,'仅管理员可还原API版本');
    if(!validDate(date) || body.confirmed!==true)throw fault(422,'请二次确认还原操作');
    const result=tx(()=>{
      if(db.prepare("SELECT 1 FROM runs WHERE state IN ('queued','running')").get())throw fault(409,'请等待采价任务完成');
      const current=listRows(date);
      if(body.token!==current.pushToken)throw fault(409,'数据已更新，请刷新后重新确认');
      const summary={restored:0,skipped:0,date};
      for(const r of current.rows){
        const o=db.prepare("SELECT id,quote_json FROM observations WHERE sku_id=? AND date=? AND run_id IS NOT NULL AND run_id NOT LIKE 'import:%' ORDER BY rowid LIMIT 1").get(r.id,date);
        if(!o || !r.work){summary.skipped++;continue;}
        const q=parse(o.quote_json),latest=db.prepare('SELECT id FROM observations WHERE sku_id=? AND date=? ORDER BY rowid DESC LIMIT 1').get(r.id,date);
        db.prepare("UPDATE daily SET observation_id=?,list=?,coupon=?,list_version=list_version+1,coupon_version=coupon_version+1,version=version+1,review_state='pending',reviewer_id=NULL,claim_until=NULL,updated_by=?,updated_at=? WHERE sku_id=? AND date=?").run(o.id,q.list ?? null,q.coupon ?? null,actor.id,now(),r.id,date);
        db.prepare('INSERT INTO quote_reviews VALUES(?,?,?,?,?) ON CONFLICT(sku_id,date) DO UPDATE SET observation_id=excluded.observation_id,actor=excluded.actor,reason=excluded.reason').run(r.id,date,latest.id,actor.id,'还原当日首次API版本');
        audit(actor,'RESET_API_ROW',`${r.id}/${date}`,{list:r.work.list,coupon:r.work.coupon,observationId:r.work.observation_id},{list:q.list,coupon:q.coupon,observationId:o.id});summary.restored++;
      }
      audit(actor,'RESET_API',date,null,summary);return summary;
    });emit('changed',{date});return result;
  }
  function pushWarehouse(date,body,actor) {
    if(actor?.role!=='admin')throw fault(403,'仅管理员可推送数仓');
    if(!validDate(date))throw fault(422,'日期格式不正确');
    const result=tx(()=>{
      if(db.prepare("SELECT 1 FROM runs WHERE state IN ('queued','running')").get())throw fault(409,'请等待采价任务完成后再推送');
      const rows=listRows(date).rows;
      // A preview token prevents publishing prices changed after the user saw the table.
      const token=JSON.stringify(rows.map(r=>[r.id,r.work?.version ?? null,r.work?.newObservation?.id || null]));
      if(body.token!==token)throw fault(409,'数据已更新，请刷新后重新推送');
      const summary={published:0,skipped:0,unchanged:0,date};
      for(const r of rows){
        const w=r.work;
        if(!w || w.final===null){summary.skipped++;continue;}
        if(!w.dirty){summary.unchanged++;continue;}
        const evidence=r.productLink || w.quote?.link || '';
        publish(r.id,date,actor,{reason:'管理员一键推数仓：按当前挂牌价和优惠券生效',evidence});summary.published++;
      }
      commitFormalPublication(db,date,actor.id,now());
      audit(actor,'PUSH_WAREHOUSE',date,null,summary);outbox();return summary;
    });flushProjection();emit('changed',{date});return {...result,projection:db.prepare('SELECT * FROM outbox WHERE id=1').get()};
  }
  function claim(id,date,actor) {
    return tx(() => {
      const row=work(id,date);if (!row) throw fault(404,'无当日记录');
      if (row.reviewer_id && row.reviewer_id!==actor.id && row.claim_until>now() && actor.role!=='admin') throw fault(409,'该记录已被其他人领取');
      db.prepare('UPDATE daily SET reviewer_id=?,claim_until=? WHERE sku_id=? AND date=?').run(actor.id,new Date(Date.now()+15*60000).toISOString(),id,date);
      audit(actor,'CLAIM',`${id}/${date}`,null,{until:15});emit('changed',{skuId:id,date});return work(id,date);
    });
  }
  function markDelisted(id,date,body,actor) {
    if(!sku(id) || !validDate(date))throw fault(422,'SKU或日期不正确');
    const result=tx(()=>{
      const row=work(id,date);if(!row)throw fault(404,'无当日记录');
      if(row.version!==body.baseVersion)throw fault(409,'记录已变化，请刷新后重试');
      if(row.list!==null || row.coupon!==null)throw fault(422,'仅挂牌价和优惠券均为空时可标记已下架');
      if(row.reviewer_id && row.reviewer_id!==actor.id && row.claim_until>now() && actor.role!=='admin')throw fault(409,'该记录正在由其他人处理');
      publish(id,date,actor,{availability:'discontinued',reason:'人工已检查：该规格无货或已下架，保留空价格',evidence:db.prepare('SELECT value FROM meta WHERE key=?').get(`product_link:${id}`)?.value || ''});
      audit(actor,'MARK_DELISTED',`${id}/${date}`,{state:row.review_state},{availability:'discontinued',list:null,coupon:null});return work(id,date);
    });flushProjection();emit('changed',{skuId:id,date});return result;
  }
  function saveProductLink(id,body,actor) {
    if(!sku(id))throw fault(404,'SKU不存在或已归档');
    if(body.recollect && (!provider?.configured || body.date!==beijingDate(clock())))throw fault(422,'链接重新采价需配置接口且仅支持当天');
    let url;try{url=new URL(String(body.link || '').trim());}catch{throw fault(422,'请填写有效商品链接');}
    if(!['http:','https:'].includes(url.protocol) || url.username || url.password)throw fault(422,'请填写有效HTTP/HTTPS商品链接');
    const result=tx(()=>{
      if(body.recollect && db.prepare("SELECT 1 FROM runs WHERE state IN ('queued','running')").get())throw fault(409,'已有采价任务运行，请完成后再提交链接');
      const key=`product_link:${id}`,old=db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value || '';
      if(old!==(body.baseLink || ''))throw fault(409,'商品链接已被其他人修改，请刷新后重试');
      db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,url.href);
      audit(actor,'SAVE_PRODUCT_LINK',id,{link:old},{link:url.href});
      let runId=null;
      if(body.recollect){
        runId=randomUUID();const stamp=now();
        db.prepare("INSERT INTO runs VALUES(?,NULL,?,'queued',?,?,?,NULL)").run(runId,body.date,actor.id,stamp,stamp);
        db.prepare('INSERT INTO run_items(run_id,sku_id) VALUES(?,?)').run(runId,id);
        db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run(`run_link:${runId}:${id}`,JSON.stringify({link:url.href,baseVersion:work(id,body.date)?.version ?? null}));
        audit(actor,'START_LINK_RUN',`${id}/${body.date}`,null,{runId,link:url.href});
      }
      return {link:url.href,runId};
    });emit('changed',{skuId:id});return result;
  }
  function updateModel(id,body,actor) {
    const result=tx(() => {
      const old=db.prepare('SELECT * FROM models WHERE id=?').get(id); if (!old) throw fault(404,'型号不存在');
      if (old.version!==body.baseVersion) throw fault(409,'型号维度已被修改',{current:old});
      const {brand,position,generation}=body;
      if (!brand?.trim() || !['','低端','中端','旗舰','折叠'].includes(position) || !['','N','N-1','N-2','更早'].includes(generation)) throw fault(422,'品牌、机型定位或代际不正确');
      db.prepare('UPDATE models SET brand=?,position=?,generation=?,generation_date=?,version=version+1 WHERE id=?').run(brandName(brand),position,generation,beijingDate(),id);
      audit(actor,'EDIT_MODEL',id,old,body);outbox();return db.prepare('SELECT * FROM models WHERE id=?').get(id);
    });
    flushProjection();emit('changed',{modelId:id});return result;
  }
  function getDraft() {
    const legacyDates=parse(db.prepare("SELECT value FROM meta WHERE key='legacy_dates'").get()?.value,[]);
    const cutoff=db.prepare('SELECT value FROM meta WHERE key=?').get('formal_publication_policy')?.value;
    const isoLabel=d=>d.includes('-')?d:`2026-${d.split('.')[0].padStart(2,'0')}-${d.split('.')[1]}`;
    const dates=new Set(legacyDates.filter(d=>!cutoff || isoLabel(d)<cutoff));
    const labelFor=(d)=>d.slice(0,4)==='2026'?`${Number(d.slice(5,7))}.${d.slice(8)}`:d;
    const strictDates=db.prepare('SELECT date FROM formal_price_publications ORDER BY date').all().map(r=>labelFor(r.date));
    for(const date of strictDates)dates.add(date);
    const rows=db.prepare('SELECT s.*,m.name model,m.brand,m.position FROM skus s JOIN models m ON m.id=s.model_id WHERE s.active=1 ORDER BY s.rowid').all().map(r => ({id:r.id,model:r.model,storage:r.storage,brand:r.brand,position:r.position,ppv:r.ppv,launchPrice:r.launch_price,strictDates,snapshots:parse(r.legacy_json,{})}));
    const byId=new Map(rows.map(r=>[r.id,r]));
    const revisions=db.prepare('SELECT r.* FROM revisions r JOIN formal_price_publications p ON p.date=r.date AND r.rowid<=p.revision_rowid ORDER BY r.rowid').all();
    for (const r of revisions) {
      const row=byId.get(r.sku_id); if (!row) continue;
      const year=r.date.slice(0,4);
      // Legacy display labels omit year; retain full dates outside the migration year.
      const label=year==='2026'?`${Number(r.date.slice(5,7))}.${r.date.slice(8)}`:r.date;
      dates.add(label);
      const bi=row.snapshots[label]?.biPrice || '';
      row.snapshots[label]={listPrice:r.list===null?'':String(r.list/100),coupon:r.coupon===null?'':String(r.coupon/100),finalPrice:r.final===null?'':String(r.final/100),biPrice:bi,availability:r.availability};
    }
    const dateSort=(d)=> d.includes('-')?d:`2026-${d.split('.')[0].padStart(2,'0')}-${d.split('.')[1]}`;
    const orderedDates=[...dates].sort((a,b)=>dateSort(a).localeCompare(dateSort(b)));
    carryFormalPrices(rows,orderedDates);
    return {dates:orderedDates,rows,savedAt:db.prepare('SELECT updated_at FROM outbox WHERE id=1').get()?.updated_at || now()};
  }
  const listeners=new Set();
  function emit(type,payload) { for (const fn of listeners) fn({type,...payload}); }
  let projectionRefreshing=false;
  let lastProjectionAt=0;
  function flushProjection() {
    const pending=db.prepare('SELECT * FROM outbox WHERE id=1').get();
    if (!pending?.pending || projectionRefreshing || (!pending.error && Date.now()-lastProjectionAt<5000)) return;
    try {
      const draft=getDraft();
      const projection=new DatabaseSync(path.join(dataDir,'published-price-draft.sqlite'));
      try {
        projection.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS raw_editor_drafts(id INTEGER PRIMARY KEY,dates_json TEXT NOT NULL,rows_json TEXT NOT NULL,saved_at TEXT NOT NULL,updated_at TEXT NOT NULL)');
        projection.prepare('INSERT INTO raw_editor_drafts VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET dates_json=excluded.dates_json,rows_json=excluded.rows_json,saved_at=excluded.saved_at,updated_at=excluded.updated_at').run(JSON.stringify(draft.dates),JSON.stringify(draft.rows),draft.savedAt,now());
      } finally { projection.close(); }
      lastProjectionAt=Date.now();
      emit('published',{});
      projectionRefreshing=true;
      Promise.resolve(onPublished()).then(()=>{
        db.prepare('UPDATE outbox SET pending=0,error=NULL WHERE id=1 AND updated_at=?').run(pending.updated_at);
      }).catch(e=>{db.prepare('UPDATE outbox SET error=? WHERE id=1').run(e.message);}).finally(()=>{projectionRefreshing=false;});
    } catch(e) { db.prepare('UPDATE outbox SET error=? WHERE id=1').run(e.message); }
  }
  function listRows(date) {
    if (!validDate(date)) throw fault(422,'日期格式不正确');
    const rows=db.prepare('SELECT s.id,s.storage,s.active,s.first_seen,m.name model,m.brand,m.position,m.generation FROM skus s JOIN models m ON m.id=s.model_id WHERE s.active=1 ORDER BY s.rowid').all();
    for (const r of rows) { r.productLink=db.prepare('SELECT value FROM meta WHERE key=?').get(`product_link:${r.id}`)?.value || '';r.work=work(r.id,date);r.searchUrl=`https://search.jd.com/Search?keyword=${encodeURIComponent(`${r.model} ${r.storage}`)}&enc=utf-8`; }
    const summary={total:rows.length,collected:rows.filter(r=>r.work?.observation_id).length,published:rows.filter(r=>r.work?.published?.availability==='on_sale' && r.work.published.final>0).length,pending:rows.filter(r=>r.work && r.work.verificationCount>0 && (r.work.dirty || r.work.newObservation)).length,unmatched:rows.filter(r=>r.work?.issues.some(i=>i.code==='NO_MATCH')).length};
    return {date,rows,summary,pushToken:JSON.stringify(rows.map(r=>[r.id,r.work?.version ?? null,r.work?.newObservation?.id || null])),projection:db.prepare('SELECT * FROM outbox WHERE id=1').get() || null};
  }
  function createRun(date,actor,{slot=null,ids=null}={}) {
    if (!provider?.configured) throw fault(503,'采价接口未配置；管理员需配置服务端买手参数');
    if (!validDate(date)) throw fault(422,'日期格式不正确');
    if (date!==beijingDate(clock())) throw fault(422,'接口只能采集当天价格，不能把当前报价写入历史或未来日期');
    if (ids!==null && (!Array.isArray(ids) || ids.some(id=>typeof id!=='string'))) throw fault(422,'SKU 清单格式不正确');
    return tx(() => {
      if (slot) { const old=db.prepare('SELECT * FROM runs WHERE slot=?').get(slot);if(old)return old; }
      const active=db.prepare("SELECT * FROM runs WHERE state IN ('queued','running')").get();if(active)throw fault(409,'已有采价任务运行中，请等待完成');
      const id=randomUUID();const stamp=now();
      db.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?,?,NULL)').run(id,slot,date,'queued',actor?.id || 'scheduler',stamp,stamp);
      const skus=db.prepare('SELECT id FROM skus WHERE active=1').all().filter(r=>!ids || ids.includes(r.id));
      if(!skus.length)throw fault(422,'没有可采集的 SKU');
      for(const s of skus)db.prepare('INSERT INTO run_items(run_id,sku_id) VALUES(?,?)').run(id,s.id);
      audit(actor || 'scheduler','START_RUN',id,null,{date,count:skus.length});
      return db.prepare('SELECT * FROM runs WHERE id=?').get(id);
    });
  }
  let processing=false;
  async function processRun() {
    if(processing || !provider?.configured)return;
    // A lease excludes another process; an expired lease is safely reclaimable after restart.
    const run=tx(()=>{
      const r=db.prepare("SELECT * FROM runs WHERE state='queued' OR (state='running' AND lease_until<?) ORDER BY created_at LIMIT 1").get(now());
      if(!r)return null;
      db.prepare("UPDATE runs SET state='running',lease_until=?,updated_at=? WHERE id=?").run(new Date(Date.now()+120000).toISOString(),now(),r.id);return r;
    });
    if(!run)return;
    processing=true;
    provider.beginRun?.();
    const heartbeat=setInterval(()=>db.prepare('UPDATE runs SET lease_until=?,updated_at=? WHERE id=?').run(new Date(Date.now()+120000).toISOString(),now(),run.id),20000);heartbeat.unref?.();
    try {
      const items=db.prepare("SELECT i.*,s.model_id collection_model_id FROM run_items i JOIN skus s ON s.id=i.sku_id WHERE i.run_id=? AND i.state IN ('queued','running') ORDER BY s.model_id,s.storage").all(run.id);
      const grouped=new Map();for(const item of items){if(!grouped.has(item.collection_model_id))grouped.set(item.collection_model_id,[]);grouped.get(item.collection_model_id).push(item);}
      const groups=[...grouped.values()];
      let next=0;
      await Promise.all(Array.from({length:Math.min(4,groups.length)},async()=>{
        while(next<groups.length){
          for(const item of groups[next++]){
          const s=sku(item.sku_id);
          if(item.attempts>=3){db.prepare("UPDATE run_items SET state='failed',message='已达到自动重试上限' WHERE run_id=? AND sku_id=?").run(run.id,s.id);continue;}
          let finished=false;
          for(let attempt=item.attempts;attempt<3 && !finished;attempt++){
            db.prepare("UPDATE run_items SET state='running',attempts=attempts+1 WHERE run_id=? AND sku_id=?").run(run.id,s.id);
            try {
              const previous=db.prepare("SELECT quote_json FROM observations WHERE sku_id=? AND date<=? AND json_extract(quote_json,'$.matched')=1 AND json_extract(quote_json,'$.goodsId') IS NOT NULL ORDER BY rowid DESC LIMIT 1").get(s.id,run.date);
              const manual=parse(db.prepare('SELECT value FROM meta WHERE key=?').get(`run_link:${run.id}:${s.id}`)?.value);
              const manualProductLink=manual?.link || db.prepare('SELECT value FROM meta WHERE key=?').get(`product_link:${s.id}`)?.value || '';
              const result=await provider.collect({...s,manualProductLink,manualLinkOnly:Boolean(manual?.link),previousQuote:parse(previous?.quote_json)},run.date,db.prepare('SELECT m.name model,s.storage FROM skus s JOIN models m ON m.id=s.model_id WHERE s.active=1').all(),step=>{
                const action={search_started:'SEARCH_REQUEST',search_result:'SEARCH_RESULT',detail_result:'DETAIL_RESULT',detail_error:'DETAIL_ERROR',previous_link_started:'PREVIOUS_LINK_REQUEST',previous_link_result:'PREVIOUS_LINK_RESULT'}[step.stage] || 'COLLECTION_STEP';
                audit('api',action,`${s.id}/${run.date}`,null,{...step,runId:run.id,model:s.model,storage:s.storage,date:run.date});
                emit('progress',{runId:run.id});
              });
              tx(()=>{
                const before=work(s.id,run.date);
                const recorded=recordObservation(s.id,run.date,result.quote,result.raw,run.id);
                if(manual?.link && recorded.protected && before?.version===manual.baseVersion){
                  db.prepare("UPDATE daily SET observation_id=?,list=?,coupon=?,list_version=list_version+1,coupon_version=coupon_version+1,version=version+1,review_state='pending',reviewer_id=NULL,claim_until=NULL,updated_by='api',updated_at=? WHERE sku_id=? AND date=?").run(recorded.observationId,result.quote.list ?? null,result.quote.coupon ?? null,now(),s.id,run.date);
                  audit('api','APPLY_LINK_QUOTE',`${s.id}/${run.date}`,{list:before.list,coupon:before.coupon},{list:result.quote.list,coupon:result.quote.coupon,runId:run.id});
                  publish(s.id,run.date,null,{automatic:true});
                }
                db.prepare("UPDATE run_items SET state='done',message=? WHERE run_id=? AND sku_id=?").run(result.quote.matched?'已匹配':'未找到合格报价',run.id,s.id);
                audit('api','COLLECT',`${s.id}/${run.date}`,null,{runId:run.id,model:s.model,storage:s.storage,date:run.date,matched:result.quote.matched,summary:result.raw.summary || null,observationId:db.prepare('SELECT id FROM observations WHERE sku_id=? AND date=? ORDER BY rowid DESC LIMIT 1').get(s.id,run.date)?.id});
              });finished=true;
            } catch(e) {
              const message=String(e.message).slice(0,500);
              audit('api','COLLECT_ATTEMPT_FAILED',`${s.id}/${run.date}`,null,{runId:run.id,model:s.model,storage:s.storage,date:run.date,attempt:attempt+1,message,lastStep:e.collectionTrace?.steps?.at(-1) || null});
              db.prepare("UPDATE run_items SET state=?,message=? WHERE run_id=? AND sku_id=?").run(attempt<2?'running':'failed',message,run.id,s.id);
              tx(()=>recordObservation(s.id,run.date,{matched:false,error:message,date:run.date,list:null,coupon:null,actual:null},{error:message,attempt:attempt+1,trace:e.collectionTrace || null},run.id));
              if(attempt<2)await new Promise(resolve=>setTimeout(resolve,1000*2**attempt));
            }
          }
          emit('progress',{runId:run.id});flushProjection();
          }
        }
      }));
      const failed=db.prepare("SELECT COUNT(*) n FROM run_items WHERE run_id=? AND state='failed'").get(run.id).n;
      db.prepare('UPDATE runs SET state=?,lease_until=NULL,updated_at=? WHERE id=?').run(failed?'partial':'completed',now(),run.id);
      audit('system','FINISH_RUN',run.id,null,{failed});
    } finally {clearInterval(heartbeat);processing=false;emit('changed',{});}
  }
  function tick(at=new Date()) {
    flushProjection();
    const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',hourCycle:'h23'}).format(at));
    if(provider?.configured && process.env.PRICE_COLLECTION_SCHEDULE_ENABLED==='true' && hour>=10){
      const date=beijingDate(at),slot=`${date}/10:00`;
      if(!db.prepare('SELECT id FROM runs WHERE slot=?').get(slot))try{createRun(date,null,{slot});}catch(e){if(e.status!==409)console.error('price scheduler:',e.message);}
    }
    processRun().catch(e=>console.error('price collection:',e.message));
  }
  function users(actor) { if(actor?.role!=='admin')throw fault(403,'仅管理员可管理账号');return db.prepare('SELECT id,username,name,role,active FROM users ORDER BY rowid').all(); }
  function saveUser(body,actor) {
    if(actor?.role!=='admin')throw fault(403,'仅管理员可管理账号');
    if(!/^[a-zA-Z0-9_.-]{3,40}$/.test(body.username || '') || !body.name?.trim())throw fault(422,'账号须为 3–40 位字母、数字或下划线，姓名不能为空');
    return tx(()=>{
      const old=body.id?db.prepare('SELECT * FROM users WHERE id=?').get(body.id):null;
      if(body.id && !old)throw fault(404,'账号不存在');
      if(!old && body.role && body.role!=='viewer')throw fault(422,'管理员和两个核验席位已固定，其他账号只能为只读');
      const id=old?.id || randomUUID();
      if(old)db.prepare('UPDATE users SET username=?,name=?,password=? WHERE id=?').run(body.username,body.name,body.password?passwordHash(body.password):old.password,id);
      else db.prepare('INSERT INTO users VALUES(?,?,?,?,?,1)').run(id,body.username,body.name,'viewer',passwordHash(body.password));
      // Account reset revokes every existing session for this identity.
      if(body.password)db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
      audit(actor,'SAVE_USER',id,old?{username:old.username,name:old.name,role:old.role}:null,{username:body.username,name:body.name,role:old?.role || 'viewer'});
      return publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(id));
    });
  }
  function logs({query='',offset=0,limit=100,date=''}={}){
    if(date && !validDate(date))throw fault(422,'日志日期不正确');
    const size=Math.max(1,Math.min(200,Number(limit) || 100)),start=Math.max(0,Number(offset) || 0);
    const joins="FROM audit a LEFT JOIN users u ON u.id=a.actor LEFT JOIN skus s ON s.id=a.sku_id LEFT JOIN models m ON m.id=s.model_id LEFT JOIN models em ON em.id=a.entity";
    const needle=canonical(query).slice(0,200),clauses=[],params=[];
    if(date){clauses.push('a.business_date=?');params.push(date);}
    if(needle){clauses.push("instr(lower(replace(COALESCE(m.name,em.name,'')||COALESCE(s.storage,'')||a.action||a.entity||COALESCE(a.after_json,''),' ','')),?)>0");params.push(needle);}
    const where=clauses.length?'WHERE '+clauses.join(' AND '):'';
    const total=db.prepare(`SELECT COUNT(*) n ${joins} ${where}`).get(...params).n;
    const items=db.prepare(`SELECT a.*,u.name actor_name,s.storage,COALESCE(m.name,em.name) model ${joins} ${where} ORDER BY a.id DESC LIMIT ? OFFSET ?`).all(...params,size,start);
    return {items,total,offset:start,limit:size,nextOffset:start+size<total?start+size:null};
  }
  function history(id,date,{offset=0,limit=30}={}){
    offset=Math.max(0,Math.floor(Number(offset)||0));limit=Math.min(100,Math.max(1,Math.floor(Number(limit)||30)));
    return {observations:db.prepare('SELECT id,created_at,run_id,quote_json FROM observations WHERE sku_id=? AND date=? ORDER BY rowid DESC LIMIT ? OFFSET ?').all(id,date,limit,offset).map(r=>({id:r.id,created_at:r.created_at,run_id:r.run_id,quote:parse(r.quote_json),checks:validateQuote(parse(r.quote_json))})),
      revisions:db.prepare('SELECT * FROM revisions WHERE sku_id=? AND date=? ORDER BY rowid DESC LIMIT ? OFFSET ?').all(id,date,limit,offset),
      observationTotal:db.prepare('SELECT COUNT(*) n FROM observations WHERE sku_id=? AND date=?').get(id,date).n,
      revisionTotal:db.prepare('SELECT COUNT(*) n FROM revisions WHERE sku_id=? AND date=?').get(id,date).n,offset,limit};
  }
  function rawObservation(observationId,id,date,{offset=0,limit=12000}={}){
    offset=Math.max(0,Math.floor(Number(offset)||0));limit=Math.min(16000,Math.max(1,Math.floor(Number(limit)||12000)));
    const row=db.prepare('SELECT substr(raw_json,?,?) text,length(raw_json) totalChars FROM observations WHERE id=? AND sku_id=? AND date=?').get(offset+1,limit,observationId,id,date);
    if(!row)throw fault(404,'原始记录不存在');
    return {...row,offset,limit,nextOffset:offset+limit<row.totalChars?offset+limit:null};
  }
  function observationDownload(observationId,id,date){const row=db.prepare('SELECT raw_json FROM observations WHERE id=? AND sku_id=? AND date=?').get(observationId,id,date);if(!row)throw fault(404,'原始记录不存在');return row.raw_json;}
  const api={db,tx,audit,login,userFromToken,users,saveUser,importRows,patchCell,confirm,claim,checkCell,resetApi,pushWarehouse,markDelisted,updateModel,saveProductLink,getDraft,listRows,createRun,processRun,tick,flushProjection,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},models:()=>db.prepare('SELECT m.* FROM models m WHERE EXISTS(SELECT 1 FROM skus s WHERE s.model_id=m.id AND s.active=1) ORDER BY m.name').all(),status:()=>({providerConfigured:Boolean(provider?.configured),scheduleEnabled:process.env.PRICE_COLLECTION_SCHEDULE_ENABLED==='true',scheduleTime:'10:00',timezone:'Asia/Shanghai'}),logout(token){db.prepare('DELETE FROM sessions WHERE token=?').run(tokenHash(token));},history,rawObservation,observationDownload,logs,runs:()=>db.prepare('SELECT r.*,(SELECT COUNT(*) FROM run_items i WHERE i.run_id=r.id) total,(SELECT COUNT(*) FROM run_items i WHERE i.run_id=r.id AND i.state=\'done\') done,(SELECT COUNT(*) FROM run_items i WHERE i.run_id=r.id AND i.state=\'failed\') failed,(SELECT COUNT(*) FROM run_items i WHERE i.run_id=r.id AND i.state=\'done\' AND i.message=\'已匹配\') matched,(SELECT COUNT(*) FROM run_items i WHERE i.run_id=r.id AND i.state=\'done\' AND i.message=\'未找到合格报价\') unmatched FROM runs r ORDER BY r.created_at DESC LIMIT 30').all(),close(){db.close();}};
  api.changePassword=(actor,oldPassword,newPassword)=>{
    const record=db.prepare('SELECT * FROM users WHERE id=?').get(actor.id);
    if(!record || !checkPassword(oldPassword,record.password))throw fault(401,'原密码不正确');
    tx(()=>{db.prepare('UPDATE users SET password=? WHERE id=?').run(passwordHash(newPassword),actor.id);db.prepare('DELETE FROM sessions WHERE user_id=?').run(actor.id);audit(actor,'CHANGE_PASSWORD',actor.id,null,null);});
  };
  api.withRequest=(requestId,callback)=>context.run(requestId,callback);
  api.updateBiPrices=(body,actor)=>{
    if(actor?.role!=='admin')throw fault(403,'仅管理员可确认 BI 价');
    if(!Array.isArray(body.rows) || body.rows.length>5000 || !Array.isArray(body.workbookTargetPpvs))throw fault(422,'BI 数据格式不正确');
    const date=String(body.workbookTargetDate || '');
    if(!/^(?:\d{1,2}\.\d{2}|\d{4}-\d{2}-\d{2})$/.test(date))throw fault(422,'BI 日期不正确');
    let count=0;
    tx(()=>{
      const allowed=new Set(body.workbookTargetPpvs);
      for(const row of body.rows){
        const old=db.prepare('SELECT * FROM skus WHERE identity=?').get(skuIdentity(row.model,row.storage));
        if(!old?.ppv || !allowed.has(old.ppv))continue;
        const amount=cents(row.snapshots?.[date]?.biPrice);if(amount===null)continue;
        const snapshots=parse(old.legacy_json,{}),before=snapshots[date]?.biPrice ?? null;
        snapshots[date]={listPrice:'',coupon:'',finalPrice:'',...snapshots[date],biPrice:String(amount/100)};
        db.prepare('UPDATE skus SET legacy_json=? WHERE id=?').run(JSON.stringify(snapshots),old.id);
        audit(actor,'SAVE_BI',`${old.id}/${date}`,before,String(amount/100));count++;
      }
      outbox();
    });flushProjection();return {ok:true,storage:'workbench',cellsWritten:count,savedAt:now()};
  };
  api.patchMany=patchMany;
  api.adoptObservation=(id,date,body,actor)=>{
    tx(()=>{
      const row=work(id,date);if(!row || row.version!==body.baseVersion)throw fault(409,'记录已变化，请刷新后比较',{current:row});
      if(row.reviewer_id && row.reviewer_id!==actor.id && row.claim_until>now() && actor.role!=='admin')throw fault(409,'该记录已由其他人领取');
      const observation=db.prepare('SELECT * FROM observations WHERE id=? AND sku_id=? AND date=?').get(body.observationId,id,date);
      if(!observation)throw fault(404,'报价记录不存在');
      const q=parse(observation.quote_json);
      db.prepare("UPDATE daily SET observation_id=?,list=?,coupon=?,list_version=list_version+1,coupon_version=coupon_version+1,version=version+1,review_state='edited',updated_by=?,updated_at=? WHERE sku_id=? AND date=?").run(observation.id,q.list ?? null,q.coupon ?? null,actor.id,now(),id,date);
      audit(actor,'ADOPT_QUOTE',`${id}/${date}`,{observationId:row.observation_id,list:row.list,coupon:row.coupon},{observationId:observation.id,list:q.list,coupon:q.coupon});
    });emit('changed',{skuId:id,date});return work(id,date);
  };
  api.restoreRevision=(id,date,body,actor)=>{
    if(actor?.role!=='admin')throw fault(403,'仅管理员可撤销或恢复生效版本');
    tx(()=>{
      const row=work(id,date);if(!row || row.version!==body.baseVersion)throw fault(409,'记录已变化，请刷新后重试',{current:row});
      if(!body.reason?.trim())throw fault(422,'请填写撤销或恢复原因');
      const target=body.revisionId?db.prepare('SELECT * FROM revisions WHERE id=? AND sku_id=? AND date=?').get(body.revisionId,id,date):null;
      if(body.revisionId && !target)throw fault(404,'生效版本不存在');
      const availability=target?.availability || 'withdrawn',revisionId=randomUUID();
      db.prepare('INSERT INTO revisions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(revisionId,id,date,target?.list ?? null,target?.coupon ?? null,target?.final ?? null,availability,target?.observation_id || null,actor.id,body.reason,target?.evidence || '',target?.formula || 'user_subsidy_v1',now(),row.published?.id || null);
      db.prepare("UPDATE daily SET list=?,coupon=?,observation_id=?,list_version=list_version+1,coupon_version=coupon_version+1,version=version+1,availability=?,review_state='confirmed',updated_by=?,updated_at=?,reviewer_id=NULL,claim_until=NULL WHERE sku_id=? AND date=?").run(target?.list ?? null,target?.coupon ?? null,target?.observation_id || null,availability,actor.id,now(),id,date);
      audit(actor,'RESTORE_REVISION',`${id}/${date}`,row.published,{revisionId,target:target?.id || null,reason:body.reason});outbox();
    });flushProjection();emit('changed',{skuId:id,date});return work(id,date);
  };
  const unindexed=db.prepare('SELECT id,entity,after_json,created_at FROM audit WHERE business_date IS NULL').all();
  if(unindexed.length)tx(()=>{for(const a of unindexed){const target=a.entity.match(/^(.*)\/(\d{4}-\d{2}-\d{2})(?:\/(?:list|coupon))?$/);const body=parse(a.after_json,{});const date=target?.[2] || (validDate(body?.date)?body.date:beijingDate(new Date(a.created_at)));const skuId=target && db.prepare('SELECT id FROM skus WHERE id=?').get(target[1])?target[1]:null;db.prepare('UPDATE audit SET sku_id=?,business_date=? WHERE id=?').run(skuId,date,a.id);}});
  api.backfillImportLogs=()=>{
    const missing=db.prepare("SELECT o.*,s.storage,m.name model FROM observations o JOIN skus s ON s.id=o.sku_id JOIN models m ON m.id=s.model_id WHERE o.run_id LIKE 'import:%' AND NOT EXISTS(SELECT 1 FROM audit a WHERE a.action='IMPORT_RESULT' AND json_extract(a.after_json,'$.observationId')=o.id)").all();
    tx(()=>{for(const o of missing){const q=parse(o.quote_json);audit('system','IMPORT_RESULT',`${o.sku_id}/${o.date}`,null,{source:'Excel 导入明细补录',backfilled:true,observationId:o.id,model:o.model,storage:o.storage,date:o.date,matched:Boolean(q.matched),queryPerformed:false,plannedKeyword:q.keyword,queryTime:q.fetchedAt || null,importedAt:o.created_at,issues:validateQuote(q).map(i=>i.message)});}});
    return {backfilled:missing.length};
  };
  api.backfillImportLogs();
  return api;
}
