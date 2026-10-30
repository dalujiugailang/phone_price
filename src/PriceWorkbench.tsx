import {flushSync} from 'react-dom';
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Check, Download, ExternalLink, History, LockKeyhole, Play, RefreshCw, Search, ShieldCheck, X} from 'lucide-react';
import './price-workbench.css';

type User={id:string;username:string;name:string;role:'admin'|'reviewer'|'viewer';active:boolean};
type Issue={code:string;field:string;message:string};
type Quote={list:number|null;coupon:number|null;actual:number|null;link?:string;shop?:string;title?:string;keyword?:string;matched:boolean;goodsId?:string;fetchedAt?:string};
type Revision={id:string;list:number|null;coupon:number|null;final:number|null;reason:string;evidence:string;actor:string;availability:string;created_at:string};
type Work={checkedCells?:Partial<Record<'list'|'coupon',boolean>>;list:number|null;coupon:number|null;final:number|null;list_version:number;coupon_version:number;version:number;review_state:string;operator?:string;updated_at?:string;quote:Quote|null;newObservation?:{id:string;quote:Quote}|null;issues:Issue[];collectionIssues?:Issue[];verificationIssues?:Issue[];verificationCount?:number;reviewNotice?:string|null;published:Revision|null;dirty:boolean;reviewer_id?:string;claimedBy?:string;claim_until?:string};
type Row={productLink?:string;id:string;model:string;storage:string;brand:string;position:string;generation:string;searchUrl:string;work:Work|null};
type Model={id:string;name:string;brand:string;position:string;generation:string;generation_date:string;version:number};
type Payload={pushToken:string;date:string;rows:Row[];summary:{total:number;collected:number;published:number;pending:number;unmatched:number};projection:{error?:string;pending:number}|null};
type Run={id:string;date:string;state:string;total:number;done:number;failed:number;matched?:number;unmatched?:number;created_at:string};
type Audit={id:number;actor_name?:string;actor:string;action:string;entity:string;before_json:string;after_json:string;created_at:string;model?:string;storage?:string;sku_id?:string};
type LogPage={items:Audit[];total:number;offset:number;limit:number;nextOffset:number|null};
type HistoryData={observations:Array<{id:string;created_at:string;run_id?:string;quote:Quote;checks?:Issue[]}>;revisions:Revision[];observationTotal:number;revisionTotal:number;offset:number;limit:number};
type CellChange={id:string;field:'list'|'coupon';value:string;baseVersion:number};
type ApiError=Error & {status:number;current?:Work};
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const money=(n:number|null|undefined)=>n==null?'—':(n/100).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
const time=(s?:string)=>s?new Date(s).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'—';
const roleLabels={admin:'管理员',reviewer:'核验人员',viewer:'只读'};
const searchKey=(value:string)=>value.normalize('NFKC').replace(/\s+/g,'').toLowerCase();
const stateLabels:Record<string,string>={pending:'待核验',edited:'已修改 · 待确认',api_passed:'API 校验通过',confirmed:'人工已核验',queued:'排队中',running:'采集中',completed:'已完成',partial:'部分失败'};
const actionLabels:Record<string,string>={LOGIN:'登录',EDIT_CELL:'修改价格',EDIT_MODEL:'修改型号维度',CONFIRM:'人工确认生效',AUTO_PUBLISH:'自动校验生效',IMPORT:'导入批次',CLAIM:'领取核验',COLLECT:'采集报价',START_RUN:'开始采价',FINISH_RUN:'完成采价',MIGRATE_LEGACY:'迁移历史',SAVE_USER:'维护账号',RESTORE_REVISION:'撤销或恢复价格',CHANGE_PASSWORD:'修改密码',ADOPT_QUOTE:'采用候选报价',SAVE_BI:'保存 BI 价'};
Object.assign(actionLabels,{IMPORT_RESULT:'导入 SKU 明细',SEARCH_REQUEST:'开始搜索',SEARCH_RESULT:'搜索返回',DETAIL_RESULT:'商品详情核验',DETAIL_ERROR:'商品详情请求失败',PREVIOUS_LINK_REQUEST:'优先查询上次商品',PREVIOUS_LINK_RESULT:'上次商品校验',COLLECT_ATTEMPT_FAILED:'接口请求失败'});
function logSummary(log:Audit){
  const d=JSON.parse(log.after_json || 'null') || {};
  if(log.action==='IMPORT_RESULT')return `${d.matched?'导入有报价':'导入未匹配'} · 未执行新搜索${d.backfilled?' · 历史导入明细补录':''}`;
  if(log.action==='SEARCH_REQUEST')return `“${d.keyword}” · 第 ${d.page} 页${d.cacheHit?' · 复用本批次搜索响应':''}`;
  if(log.action==='SEARCH_RESULT')return `“${d.keyword}” 第 ${d.page} 页：返回 ${d.returned}，新增合格候选 ${d.eligible}，店铺排除 ${d.storeRejected}，型号/规格排除 ${d.specRejected}（原因可重叠）`;
  if(log.action==='PREVIOUS_LINK_REQUEST')return '直接查询上次匹配商品的最新详情';
  if(log.action==='PREVIOUS_LINK_RESULT')return d.accepted?'旧商品有效，已取最新价格，跳过搜索':`转入重新搜索：${(d.reasons || []).join('；')}`;
  if(log.action==='DETAIL_ERROR')return `详情请求失败：${d.message}；继续尝试其他候选`;
  if(log.action==='DETAIL_RESULT')return d.accepted?`详情合格 · ${d.shop}`:`详情排除：${(d.reasons || []).join('；')}`;
  if(log.action==='COLLECT')return `${d.matched?'取得合格报价':'本次未取得合格报价'} · 搜索 ${d.summary?.searches ?? '—'} 次 / 详情 ${d.summary?.details ?? '—'} 次`;
  if(log.action==='COLLECT_ATTEMPT_FAILED')return `第 ${d.attempt} 次请求失败：${d.message}`;
  return '展开查看前后值、结论与证据';
}
async function api<T>(url:string,body?:unknown,method?:string):Promise<T>{
  const r=await fetch(`/api/workbench${url}`,{method:method || (body?'POST':'GET'),credentials:'same-origin',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});
  const data=await r.json();if(!r.ok)throw Object.assign(new Error(data.message || '请求失败'),{status:r.status,current:data.current});return data;
}
function SafeLink({href,children}:{href?:string;children:React.ReactNode}){return href && /^https?:\/\//i.test(href)?<a href={href} target="_blank" rel="noopener noreferrer">{children}<ExternalLink size={12}/></a>:<span className="pw-muted">无商品链接</span>;}
const collectionCodes=new Set(['NOT_COLLECTED','NO_MATCH','API_ERROR']);
const collectionIssues=(w:Work)=>w.collectionIssues || w.issues.filter(i=>collectionCodes.has(i.code));
const verificationIssues=(w:Work)=>w.verificationIssues || w.issues.filter(i=>!collectionCodes.has(i.code));
const verificationCount=(w:Work)=>w.verificationCount ?? verificationIssues(w).length;
function Status({work}:{work:Work|null}){
  if(!work)return <span className="pw-badge neutral">未采集</span>;
  if(work.reviewNotice)return <span className="pw-muted">{work.reviewNotice}</span>;
  if(work.dirty && verificationCount(work)===0)return <span className="pw-badge neutral">{work.review_state==='edited'?'修改待保存确认':'采集信息已记录'}</span>;
  if(work.newObservation)return <span className={`pw-badge ${verificationCount(work)>0?'warn':'neutral'}`}>新报价待比较</span>;
  if(work.published?.availability==='withdrawn')return <span className="pw-badge neutral">已撤销生效</span>;
  if(work.review_state==='confirmed' && work.published?.availability!=='on_sale')return <span className="pw-badge neutral">{{out_of_stock:'已确认无货',discontinued:'已下架 · 已处理',not_launched:'已确认未上市'}[work.published?.availability || ''] || '已核验'}</span>;
  return <span className={`pw-badge ${work.dirty?'warn':'success'}`}>{stateLabels[work.review_state] || '待核验'}</span>;
}

function ObservationDetails({observation:o}:{observation:HistoryData['observations'][number];skuId:string;date:string}){
  const q=o.quote,method=o.run_id?.startsWith('import:')?'导入记录':o.run_id?(q.keyword==='上次匹配商品'?'上次商品直查':'关键词搜索'):'历史记录';
  const difference=q.list!=null && q.coupon!=null && q.actual!=null?q.list-q.coupon-q.actual:null;
  return <details className="pw-observation"><summary>{time(o.created_at)} · {q.matched?'取得报价':'未匹配 / 失败'}</summary><dl className="pw-history-fields">
    <dt>采价方式</dt><dd>{method}</dd><dt>查询时间</dt><dd>{time(q.fetchedAt || o.created_at)}</dd>
    <dt>挂牌价</dt><dd>{money(q.list)}</dd><dt>优惠券</dt><dd>{money(q.coupon)}</dd><dt>接口到手价</dt><dd>{money(q.actual)}</dd>
    <dt>价券差额</dt><dd>{money(difference)}</dd><dt>店铺</dt><dd>{q.shop || '—'}</dd>
    <dt>校验结果</dt><dd>{o.checks?.length?o.checks.map(i=><p key={i.code}>{i.message}</p>):o.checks?'字段校验通过':'待校验'}</dd>
  </dl>{q.title?<p className="pw-history-title">{q.title}</p>:null}<div className="pw-links"><SafeLink href={q.link}>查看商品</SafeLink></div></details>;
}

function PriceCell({row,field,date,editable,onChange,onError,onPaste}:{row:Row;field:'list'|'coupon';date:string;editable:boolean;onChange:()=>void;onError:(s:string)=>void;onPaste:(row:Row,field:'list'|'coupon',text:string)=>void}){
  const value=row.work?.[field] ?? null,version=row.work?.[`${field}_version`] ?? 0;
  const [draft,setDraft]=useState(value==null?'':String(value/100));
  const [dirty,setDirty]=useState(false),[saving,setSaving]=useState(false);
  const [conflict,setConflict]=useState<{current:Work;mine:string}|null>(null);
  useEffect(()=>{if(!dirty && !saving)setDraft(value==null?'':String(value/100));},[value,version,dirty,saving]);
  const relevant=row.work?verificationIssues(row.work).filter(i=>i.field===field || i.code==='CURRENT_GEN_NO_PRICE'):[];
  async function markChecked(workVersion=row.work?.version){
    if(!editable || !relevant.length || workVersion==null)return;
    await api(`/check-cell/${encodeURIComponent(row.id)}`,{date,field,baseVersion:workVersion});
  }
  async function save(baseVersion=version,mine=draft){
    if(!editable || saving)return;
    if(!dirty && !conflict){try{await markChecked();onChange();}catch(e){onError((e as Error).message);}return;}
    setSaving(true);
    try{const saved=await api<Work>(`/cells/${encodeURIComponent(row.id)}`,{date,field,value:mine,baseVersion},'PATCH');await markChecked(saved.version);setDirty(false);setConflict(null);onChange();}
    catch(e){const err=e as ApiError;if(err.status===409 && err.current)setConflict({current:err.current,mine});else onError(err.message);}
    finally{setSaving(false);}
  }
  return <div className={`pw-price-cell ${relevant.length?(row.work?.checkedCells?.[field]?'is-checked':'has-issue'):''}`} onPaste={e=>{const text=e.clipboardData.getData('text');if(editable && /[\t\n]/.test(text)){e.preventDefault();onPaste(row,field,text);}}}>
    <input aria-label={`${row.model} ${row.storage} ${field==='list'?'挂牌价':'优惠券'}`} inputMode="decimal" readOnly={!editable} disabled={saving} value={draft} placeholder="待补充" onChange={e=>{setDraft(e.target.value);setDirty(true);}} onBlur={()=>void save()} onKeyDown={e=>{if(e.key==='Enter')e.currentTarget.blur();}}/>
    <span className="pw-cell-state">{saving?'保存中…':dirty?'未保存':row.work?.checkedCells?.[field]?'已检查':row.work?'已保存':''}</span>
    {relevant.length>0?<span className="pw-cell-issue" title={relevant.map(i=>i.message).join('；')}>{relevant[0].message}</span>:null}
    {conflict?<div className="pw-conflict" role="alert"><b>此单元格有新修改</b><span>服务器：{money(conflict.current[field])}　我的：{conflict.mine || '空'}</span><div><button onMouseDown={e=>e.preventDefault()} onClick={()=>{setDirty(false);setDraft(conflict.current[field]==null?'':String(conflict.current[field]!/100));setConflict(null);onChange();}}>采用服务器值</button><button onMouseDown={e=>e.preventDefault()} onClick={()=>void save(conflict.current[`${field}_version`],conflict.mine)}>保存我的值</button></div></div>:null}
  </div>;
}

function ModelRow({model,editable,onChange,onError}:{model:Model;editable:boolean;onChange:()=>void;onError:(s:string)=>void}){
  const [draft,setDraft]=useState(model),[dirty,setDirty]=useState(false),[saving,setSaving]=useState(false);
  useEffect(()=>{if(!dirty)setDraft(model);},[model,dirty]);
  async function save(){setSaving(true);try{await api(`/models/${model.id}`,{brand:draft.brand,position:draft.position,generation:draft.generation,baseVersion:draft.version},'PATCH');setDirty(false);onChange();}catch(e){onError((e as Error).message);}finally{setSaving(false);}}
  return <tr><td><b>{model.name}</b></td><td><input aria-label={`${model.name} 品牌`} disabled={!editable} value={draft.brand} onChange={e=>{setDraft({...draft,brand:e.target.value});setDirty(true);}}/></td><td><select aria-label={`${model.name} 机型定位`} disabled={!editable} value={draft.position} onChange={e=>{setDraft({...draft,position:e.target.value});setDirty(true);}}><option value="">待配置</option>{['低端','中端','旗舰','折叠'].map(x=><option key={x}>{x}</option>)}</select></td><td><select aria-label={`${model.name} 代际`} disabled={!editable} value={draft.generation} onChange={e=>{setDraft({...draft,generation:e.target.value});setDirty(true);}}><option value="">待配置</option>{['N','N-1','N-2','更早'].map(x=><option key={x}>{x}</option>)}</select></td><td className="pw-muted">{model.generation_date || '—'}</td><td><button disabled={!editable || !dirty || saving} onClick={()=>void save()}>{saving?'保存中…':dirty?'保存修改':'已保存'}</button></td></tr>;
}

function Login({onDone,onClose}:{onDone:()=>void;onClose:()=>void}){
  const [username,setUsername]=useState(''),[password,setPassword]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  async function submit(e:React.FormEvent){e.preventDefault();setBusy(true);try{await api('/login',{username,password});onDone();onClose();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  return <div className="pw-overlay" onClick={onClose}><form className="pw-login" onClick={e=>e.stopPropagation()} onSubmit={submit}><button type="button" className="pw-icon close" aria-label="关闭登录" onClick={onClose}><X size={18}/></button><div className="pw-logo"><LockKeyhole size={22}/></div><h2>登录采价工作台</h2><p>管理员与两名核验人员可编辑，其他账号只读。</p><label>账号<input autoFocus required autoComplete="username" value={username} onChange={e=>setUsername(e.target.value)}/></label><label>密码<input required type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)}/></label>{error?<div className="pw-error">{error}</div>:null}<button className="pw-primary" disabled={busy}>{busy?'登录中…':'登录'}</button><span className="pw-muted">初始账号由管理员分发；请勿共用账号。</span></form></div>;
}

function AccountRow({account,onDone,onError}:{account:User;onDone:()=>void;onError:(s:string)=>void}){
  const [form,setForm]=useState({username:account.username,name:account.name,password:''}),[busy,setBusy]=useState(false);
  async function save(){setBusy(true);try{await api('/users',{id:account.id,...form});setForm({...form,password:''});onDone();}catch(e){onError((e as Error).message);}finally{setBusy(false);}}
  return <tr><td><input aria-label="账号" value={form.username} onChange={e=>setForm({...form,username:e.target.value})}/></td><td><input aria-label="姓名" value={form.name} onChange={e=>setForm({...form,name:e.target.value})}/></td><td><span className="pw-badge neutral">{roleLabels[account.role]}</span></td><td><input type="password" aria-label={`${account.name} 新密码`} autoComplete="new-password" placeholder="留空保留原密码" value={form.password} onChange={e=>setForm({...form,password:e.target.value})}/></td><td><button disabled={busy} onClick={()=>void save()}>{busy?'保存中…':'保存'}</button></td></tr>;
}

export function PriceWorkbench({onPublished}:{onPublished:()=>void}){
  const [date,setDate]=useState(today),[tab,setTab]=useState(()=>new URLSearchParams(window.location.search).get('tab')==='logs'?'logs':'daily'),[search,setSearch]=useState(()=>new URLSearchParams(window.location.search).get('search') || ''),[filter,setFilter]=useState('all');
  const [payload,setPayload]=useState<Payload|null>(null),[models,setModels]=useState<Model[]>([]),[runs,setRuns]=useState<Run[]>([]),[logs,setLogs]=useState<Audit[]>([]),[accounts,setAccounts]=useState<User[]>([]);
  const [me,setMe]=useState<{user:User|null;providerConfigured:boolean;scheduleEnabled:boolean}|null>(null);
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[loginOpen,setLoginOpen]=useState(false);
  const historyCache=useRef(new Map<string,{at:number;data:HistoryData}>());
  const historyScope=useRef('');
  const [historyOffset,setHistoryOffset]=useState(0);
  const [selectedId,setSelectedId]=useState<string|null>(null),[history,setHistory]=useState<HistoryData|null>(null),[reason,setReason]=useState(''),[evidence,setEvidence]=useState(''),[availability,setAvailability]=useState('on_sale');
  const [newUser,setNewUser]=useState({username:'',name:'',password:''});
  const [logSearch,setLogSearch]=useState(()=>new URLSearchParams(window.location.search).get('log') || ''),[logOffset,setLogOffset]=useState(0),[logTotal,setLogTotal]=useState(0),[logDate,setLogDate]=useState(today);
  const logRefreshRef=useRef<()=>void>(()=>{});
  const [pasteReview,setPasteReview]=useState<{changes:CellChange[];targets:string[]}|null>(null);
  const [passwordOpen,setPasswordOpen]=useState(false),[passwordForm,setPasswordForm]=useState({oldPassword:'',newPassword:''});
  const sequence=useRef(0),refreshRef=useRef<()=>void>(()=>{}),publishedRef=useRef(onPublished);publishedRef.current=onPublished;
  const refreshBusy=useRef(false),refreshPending=useRef(false);
  const editable=Boolean(me?.user && me.user.role!=='viewer'),isAdmin=me?.user?.role==='admin';
  const refresh=useCallback(async()=>{
    if(refreshBusy.current){refreshPending.current=true;return;}
    refreshBusy.current=true;
    const seq=++sequence.current;
    try{const [rows,modelRows,runRows]=await Promise.all([api<Payload>(`/rows?date=${date}`),api<Model[]>('/models'),api<Run[]>('/runs')]);if(seq!==sequence.current)return;setPayload(rows);setModels(modelRows);setRuns(runRows);}
    catch(e){if(seq===sequence.current)setError((e as Error).message);}finally{if(seq===sequence.current)setLoading(false);refreshBusy.current=false;if(refreshPending.current){refreshPending.current=false;queueMicrotask(()=>refreshRef.current());}}
  },[date]);
  refreshRef.current=()=>void refresh();
  const loadMe=useCallback(async()=>{try{setMe(await api('/me'));}catch(e){setError((e as Error).message);}},[]);
  useEffect(()=>{void loadMe();},[loadMe]);
  useEffect(()=>{setLoading(true);setSelectedId(null);void refresh();return()=>{sequence.current++;};},[refresh]);
  useEffect(()=>{
    const events=new EventSource('/api/workbench/events');let timer:ReturnType<typeof setTimeout>|undefined;let connected=false;
    events.onmessage=e=>{const event=JSON.parse(e.data);if(event.type==='connected'){if(!connected){connected=true;return;}}if(timer===undefined)timer=setTimeout(()=>{timer=undefined;refreshRef.current();},1000);if(event.type==='published')publishedRef.current();};
    const poll=setInterval(()=>refreshRef.current(),5000);
    return()=>{clearTimeout(timer);clearInterval(poll);events.close();};
  },[]);
  useEffect(()=>{if(isAdmin)void api<User[]>('/users').then(setAccounts).catch(e=>setError(e.message));},[isAdmin]);
  useEffect(()=>{
    if(tab!=='logs')return;
    let cancelled=false;
    const load=async()=>{try{const result=await api<LogPage|Audit[]>(`/logs?query=${encodeURIComponent(logSearch)}&offset=${logOffset}&limit=100&date=${logDate}`);if(!cancelled){setLogs(Array.isArray(result)?result:result.items);setLogTotal(Array.isArray(result)?result.length:result.total);}}catch(e){if(!cancelled)setError((e as Error).message);}};
    logRefreshRef.current=()=>void load();
    const timer=setTimeout(()=>void load(),180),poll=setInterval(()=>void load(),2000);
    return()=>{cancelled=true;clearTimeout(timer);clearInterval(poll);};
  },[tab,logSearch,logOffset,logDate]);
  const rows=useMemo(()=>{
    const q=searchKey(search);
    return (payload?.rows || []).filter(r=>{
      if(q && !searchKey(`${r.model} ${r.storage} ${r.brand}`).includes(q))return false;
      const w=r.work;
      if(tab==='review' && (!w || verificationCount(w)===0 || (!w.dirty && !w.newObservation)))return false;
      if(filter==='mismatch')return Boolean(w && verificationIssues(w).some(i=>i.code==='PRICE_COMPONENT_MISMATCH') && (w.dirty || w.newObservation));
      if(filter==='missing_price')return Boolean(r.generation==='N' && w?.list==null && w?.coupon==null && (!w || w.dirty || w.newObservation));
      return true;
    });
  },[payload,search,filter,tab,me?.user?.id]);
  const filteredModels=useMemo(()=>models.filter(m=>searchKey(`${m.name} ${m.brand}`).includes(searchKey(search))),[models,search]);
  const selected=payload?.rows.find(r=>r.id===selectedId);
  useEffect(()=>{
    if(!selectedId){setHistory(null);historyScope.current='';return;}
    const scope=`${selectedId}/${date}`;if(historyScope.current!==scope){setHistory(null);historyScope.current=scope;}
    const key=`${selectedId}/${date}/${selected?.work?.version ?? 0}/${historyOffset}`,cached=historyCache.current.get(key);
    if(cached && Date.now()-cached.at<10000){setHistory(cached.data);return;}
    let cancelled=false;
    api<HistoryData>(`/history/${encodeURIComponent(selectedId)}?date=${date}&offset=${historyOffset}`).then(h=>{if(cancelled)return;if(historyCache.current.size>=20)historyCache.current.delete(historyCache.current.keys().next().value!);historyCache.current.set(key,{at:Date.now(),data:h});setHistory(h);}).catch(e=>{if(!cancelled)setError(e.message);});return()=>{cancelled=true;};
  },[selectedId,date,selected?.work?.version,historyOffset]);
  function openDetail(r:Row){setHistoryOffset(0);setSelectedId(r.id);setReason('');setEvidence(r.productLink || r.work?.quote?.link || '');setAvailability('on_sale');}
  async function resetApi(){
    if(!payload || !window.confirm(`确认将 ${date} 的核验数据还原为当日首次 API 返回版本？\n\n会覆盖当天的人工价格修改、清除已检查颜色并恢复待核验队列；没有 API 记录的行跳过。\n已推数仓的数据不会回退，补充的商品链接和历史记录保留。如需同步还原后的值，请再次点击“一键推数仓”。`))return;
    setBusy(true);setError('');try{const r=await api<{restored:number;skipped:number}>('/reset-api',{date,token:payload.pushToken,confirmed:true});setNotice(`已还原 ${r.restored} 条首次 API 记录，跳过 ${r.skipped} 条无 API 记录；已生效数仓数据保留。`);await refresh();}catch(e){setError((e as Error).message);await refresh();}finally{setBusy(false);}
  }
  async function pushWarehouse(){if(!payload)return;setBusy(true);setError('');try{const r=await api<{published:number;skipped:number;unchanged:number}>('/push-warehouse',{date,token:payload.pushToken});setNotice(`已推送 ${r.published} 条，已生效未变 ${r.unchanged} 条，缺价跳过 ${r.skipped} 条。数仓同步状态见下方提示。`);await refresh();publishedRef.current();}catch(e){setError((e as Error).message);await refresh();}finally{setBusy(false);}}
  async function collect(ids?:string[]){setBusy(true);setError('');try{await api('/runs',{date,ids});setNotice('采价任务已创建，可在任务与日志中查看进度。');await refresh();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  async function markDelisted(){if(!selected?.work)return;setBusy(true);setError('');try{await api(`/delisted/${encodeURIComponent(selected.id)}`,{date,baseVersion:selected.work.version});setNotice('已标记下架，价格保留为空，该条核验已处理。');await refresh();publishedRef.current();}catch(e){setError((e as Error).message);await refresh();}finally{setBusy(false);}}
  async function saveProductLink(){if(!selected)return;setBusy(true);try{await api(`/product-link/${encodeURIComponent(selected.id)}`,{link:evidence,baseLink:selected.productLink || '',date,recollect:true},'PATCH');setNotice('商品链接已保存，已创建该 SKU 的重新采价任务；结果可在任务与日志查看。');await refresh();}catch(e){setError((e as Error).message);await refresh();}finally{setBusy(false);}}
  async function claim(){if(!selected)return;try{await api(`/claim/${encodeURIComponent(selected.id)}`,{date});setNotice('已领取 15 分钟，请完成核验后确认。');await refresh();}catch(e){setError((e as Error).message);}}
  async function addViewer(e:React.FormEvent){e.preventDefault();try{await api('/users',newUser);setAccounts(await api('/users'));setNewUser({username:'',name:'',password:''});setNotice('只读账号已创建。');}catch(e){setError((e as Error).message);}}
  async function changePassword(e:React.FormEvent){e.preventDefault();try{await api('/password',passwordForm);setPasswordOpen(false);setPasswordForm({oldPassword:'',newPassword:''});setNotice('密码已更新，请重新登录。');await loadMe();}catch(e){setError((e as Error).message);}}
  function preparePaste(row:Row,field:'list'|'coupon',text:string){
    const matrix=text.replace(/\r/g,'').replace(/\n$/,'').split('\n').map(r=>r.split('\t'));
    const fields:Array<'list'|'coupon'>=field==='list'?['list','coupon']:['coupon'];
    const start=rows.findIndex(r=>r.id===row.id),changes:CellChange[]=[],targets:string[]=[];
    if(matrix.length+start>rows.length || matrix.some(r=>r.length>fields.length) || matrix.length>500){setError('粘贴超出目标行或价格列；仅支持挂牌价、优惠券两列，国补后自动计算。');return;}
    matrix.forEach((cells,index)=>{const target=rows[start+index];targets.push(`${target.model} ${target.storage}`);cells.forEach((value,col)=>changes.push({id:target.id,field:fields[col],value:value.trim(),baseVersion:target.work?.[`${fields[col]}_version`] ?? 0}));});
    setPasteReview({changes,targets});
  }
  async function savePaste(){if(!pasteReview)return;setBusy(true);try{const result=await api<{saved:number}>('/batch',{date,changes:pasteReview.changes},'PATCH');setPasteReview(null);setNotice(`已保存 ${result.saved} 个单元格，确认后才会更新生效价格。`);await refresh();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  async function restore(revisionId:string|null){if(!selected?.work)return;setBusy(true);try{await api(`/restore/${encodeURIComponent(selected.id)}`,{date,revisionId,baseVersion:selected.work.version,reason});setNotice(revisionId?'已恢复该历史版本，并保留变更记录。':'已撤销当前生效价格，历史记录仍保留。');await refresh();publishedRef.current();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  async function adopt(){if(!selected?.work?.newObservation)return;setBusy(true);try{const q=selected.work.newObservation;await api(`/adopt/${encodeURIComponent(selected.id)}`,{date,observationId:q.id,baseVersion:selected.work.version});setEvidence(q.quote.link || '');setNotice('新报价已载入工作记录，填写核验结论后确认才会生效。');await refresh();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  const count=tab==='models'?filteredModels.length:rows.length;
  return <section className="pw">
    <div className="pw-heading"><div><div className="pw-eyebrow">PRICE OPERATIONS</div><h1>原始数据<span>采价与核验工作台</span></h1><p>每日只处理当天价格。型号维度单独维护，每一次修改都可追溯。</p></div><div className="pw-identity">{me?.user?<><div className="pw-avatar">{me.user.name.slice(0,1)}</div><div><b>{me.user.name}</b><span>{roleLabels[me.user.role]}</span></div><button onClick={()=>setPasswordOpen(true)}>修改密码</button><button onClick={()=>void api('/logout',{}).then(loadMe)}>退出</button></>:<><span><LockKeyhole size={14}/> 当前只读</span><button onClick={()=>setLoginOpen(true)}>登录编辑</button></>}</div></div>
    <nav className="pw-tabs" aria-label="原始数据子页面">{[['daily','每日采价'],['models','型号维度'],['review','核验队列'],['logs','任务与日志'],...(isAdmin?[['users','账号管理']]:[])].map(([id,label])=><button key={id} className={tab===id?'active':''} onClick={()=>{setTab(id);setFilter('all');}}>{label}{id==='review' && payload?.summary.pending?<span>{payload.summary.pending}</span>:null}</button>)}</nav>
    {error?<div className="pw-alert error" role="alert">{error}<button aria-label="关闭错误" onClick={()=>setError('')}><X size={15}/></button></div>:null}
    {notice?<div className="pw-alert" role="status">{notice}<button aria-label="关闭提示" onClick={()=>setNotice('')}><X size={15}/></button></div>:null}
    {payload?.projection?.pending && !payload.projection.error?<div className="pw-help">生效数据已保存，数仓正在同步…</div>:null}
    {payload?.projection?.error?<div className="pw-alert error">生效数据已保存，分析同步正在重试：{payload.projection.error}</div>:null}
    {tab!=='users' && tab!=='logs'?<>
      <div className="pw-toolbar"><div className="pw-search"><Search size={16}/><input aria-label="搜索型号或存储版本" placeholder="搜索型号、存储版本…" value={search} onChange={e=>setSearch(e.target.value)}/></div>{tab!=='models'?<><label className="pw-date-label">采价日期<input type="date" aria-label="采价日期" value={date} onChange={e=>{if(e.target.value)setDate(e.target.value);}}/></label><select aria-label="筛选问题类型" value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">全部问题类型</option><option value="mismatch">券价不一致</option><option value="missing_price">N代机型缺价</option></select><div className="pw-spacer"/><a className="pw-button" href={`/api/workbench/export.xlsx?date=${date}`}><Download size={14}/>导出</a><button className="pw-primary" disabled={!editable || busy || !me?.providerConfigured || date!==today()} title={!me?.providerConfigured?'服务端接口未配置':!editable?'请登录管理员或核验账号':''} onClick={()=>void collect()}><Play size={14}/>{busy?'处理中…':'采集当天价格'}</button>{isAdmin?<button className="pw-primary" disabled={busy || !payload || loading || payload.date!==date} onClick={()=>void pushWarehouse()}>一键推数仓</button>:null}{isAdmin && tab==='review'?<button disabled={busy || !payload || loading || payload.date!==date} onClick={()=>void resetApi()}>还原首次 API 版本</button>:null}</>:<span className="pw-muted">型号下的全部存储版本共享品牌、定位与代际</span>}</div>
      {tab!=='models'?<>
        <div className="pw-metrics">{[['监控 SKU',payload?.summary.total],['已采集',payload?.summary.collected],['已生效',payload?.summary.published],['待核验',payload?.summary.pending],['未匹配',payload?.summary.unmatched]].map(([label,n])=><div key={label}><span>{label}</span><strong>{n ?? '—'}</strong></div>)}<div className="pw-schedule"><span className={`pw-dot ${me?.scheduleEnabled?'on':''}`}/><div><b>每天 10:00 · 北京时间</b><span>{me?.scheduleEnabled?'自动采价已启用':'本地预览：自动任务未启用'}</span></div></div></div>
        <div className="pw-help"><ShieldCheck size={16}/><span>黄色表示待检查；点击单元格并离开后变蓝，表示已检查，价格无需改动。管理员“一键推数仓”按当前挂牌价和券额生效，缺价行跳过；国补后自动计算。</span></div>
        {loading || payload?.date!==date?<div className="pw-empty">正在读取 {date} 的价格记录…</div>:<div className="pw-table-scroll"><table className="pw-price-table"><thead><tr><th className="pw-model-col">型号</th><th>存储版本</th><th>挂牌价 <small>元</small></th><th>优惠券 <small>元</small></th><th>国补后 <small>公式</small></th><th>核验状态</th><th>查询与核验</th></tr></thead><tbody>{rows.map(r=><tr key={`${date}/${r.id}`}><td><b>{r.model}</b></td><td className="pw-storage">{r.storage}</td><td><PriceCell key={`list-${r.id}-${date}`} row={r} date={date} field="list" editable={editable} onChange={()=>refreshRef.current()} onError={setError} onPaste={preparePaste}/></td><td><PriceCell key={`coupon-${r.id}-${date}`} row={r} date={date} field="coupon" editable={editable} onChange={()=>refreshRef.current()} onError={setError} onPaste={preparePaste}/></td><td><div className="pw-formula">{money(r.work?.final)}<LockKeyhole size={11}/></div>{r.work && (r.work.list==null || r.work.coupon==null)?<small className="pw-muted">补齐价格后自动计算</small>:null}{r.work?.dirty && r.work.published?<small className="pw-muted">生效：{money(r.work.published.final)}</small>:null}</td><td><Status work={r.work}/>{r.work?.claimedBy && r.work.claim_until!>new Date().toISOString()?<small className="pw-owner">{r.work.claimedBy} 核验中</small>:null}{r.work && verificationCount(r.work)>0 && r.work.dirty?<small className="pw-issues">{verificationCount(r.work)} 项待检查</small>:null}</td><td><div className="pw-links"><SafeLink href={r.productLink || r.work?.quote?.link}>商品</SafeLink><SafeLink href={r.searchUrl}>搜索</SafeLink><button onClick={()=>openDetail(r)}>{editable?'核验 / 详情':'查看详情'}</button></div></td></tr>)}</tbody></table>{!rows.length?<div className="pw-empty">没有符合条件的记录</div>:null}</div>}
      </>:<div className="pw-table-scroll"><table className="pw-model-table"><thead><tr><th>型号</th><th>品牌</th><th>机型定位</th><th>代际</th><th>代际基准日期</th><th>操作</th></tr></thead><tbody>{filteredModels.map(m=><ModelRow key={m.id} model={m} editable={editable} onChange={()=>{refreshRef.current();publishedRef.current();}} onError={setError}/>)}</tbody></table></div>}
      <div className="pw-list-total">共 {count} 条 · 已全部展示</div>
    </>:null}
    {tab==='logs'?<div className="pw-log-layout"><div><div className="pw-section-title"><h2>采价任务</h2><button onClick={()=>{refreshRef.current();logRefreshRef.current();}}><RefreshCw size={14}/>刷新</button></div>{runs.length?runs.map(r=><div className="pw-run" key={r.id}><div><b>{r.date} 采价</b><span>{time(r.created_at)}</span></div><span className={`pw-badge ${r.failed?'warn':'neutral'}`}>{stateLabels[r.state] || r.state}</span><span>{r.done}/{r.total} 已处理 · 匹配 {r.matched ?? '—'} · 未匹配 {r.unmatched ?? '—'} · 请求失败 {r.failed}</span>{r.failed && editable?<button onClick={()=>void api(`/runs/${r.id}/retry`,{}).then(()=>refreshRef.current()).catch(e=>setError(e.message))}>重试失败项</button>:null}</div>):<div className="pw-empty">尚无实时 API 采价任务。导入记录与实时搜索会分别标明，不把导入未匹配当作刚刚搜索失败。</div>}</div><div className="pw-section-title"><h2>查询与操作日志</h2><span className="pw-muted">包含全部历史记录，可按型号搜索、翻页；实时任务每 2 秒更新</span></div><div className="pw-toolbar"><div className="pw-search"><Search size={16}/><input aria-label="搜索查询日志" placeholder="搜索型号、存储版本或日志内容…" value={logSearch} onChange={e=>{setLogSearch(e.target.value);setLogOffset(0);}}/></div><label className="pw-date-label">业务日期<input type="date" aria-label="日志业务日期" value={logDate} onChange={e=>{setLogDate(e.target.value);setLogOffset(0);}}/></label><span className="pw-muted">共 {logTotal} 条</span></div><div className="pw-table-scroll"><table><thead><tr><th>时间</th><th>型号 / 存储版本</th><th>操作人</th><th>阶段</th><th>结果与证据</th></tr></thead><tbody>{logs.map(l=><tr key={l.id}><td>{time(l.created_at)}</td><td>{l.model?<><b>{l.model}</b><div className="pw-muted">{l.storage}</div></>:<span className="pw-muted">批次 / 账号操作</span>}</td><td>{l.actor_name || (l.actor==='api'?'API':l.actor==='system'?'系统':l.actor)}</td><td>{actionLabels[l.action] || l.action}</td><td><details><summary>{logSummary(l)}</summary><pre>{JSON.stringify({记录对象:l.entity,修改前:JSON.parse(l.before_json || 'null'),修改后:JSON.parse(l.after_json || 'null')},null,2)}</pre></details></td></tr>)}</tbody></table>{!logs.length?<div className="pw-empty">没有符合条件的日志记录</div>:null}</div><div className="pw-pagination"><span>{logTotal?`${logOffset+1}–${Math.min(logTotal,logOffset+100)} / ${logTotal}`:'0 条记录'}</span><div><button disabled={logOffset===0} onClick={()=>setLogOffset(n=>Math.max(0,n-100))}>上一页</button><button disabled={logOffset+100>=logTotal} onClick={()=>setLogOffset(n=>n+100)}>下一页</button></div></div></div>:null}
    {tab==='users' && isAdmin?<div className="pw-accounts"><div className="pw-help"><ShieldCheck size={17}/><span>固定 1 个管理员、2 个核验席位。可修改姓名、登录账号和密码；其余新增人员均为只读。重置密码会使该账号已有登录失效。</span></div><table><thead><tr><th>登录账号</th><th>姓名</th><th>权限</th><th>重置密码（至少 10 位）</th><th>操作</th></tr></thead><tbody>{accounts.map(u=><AccountRow key={u.id} account={u} onDone={()=>{void api<User[]>('/users').then(setAccounts);setNotice('账号已保存。');void loadMe();}} onError={setError}/>)}</tbody></table><form className="pw-add-user" onSubmit={addViewer}><h3>新增只读人员</h3><input required placeholder="登录账号" aria-label="新增只读账号" value={newUser.username} onChange={e=>setNewUser({...newUser,username:e.target.value})}/><input required placeholder="姓名" aria-label="新增只读人员姓名" value={newUser.name} onChange={e=>setNewUser({...newUser,name:e.target.value})}/><input required type="password" minLength={10} placeholder="初始密码（至少 10 位）" aria-label="新增只读人员密码" value={newUser.password} onChange={e=>setNewUser({...newUser,password:e.target.value})}/><button className="pw-primary">创建只读账号</button></form></div>:null}
    {selected?<div className="pw-overlay" onClick={()=>setSelectedId(null)}><aside className="pw-drawer" onClick={e=>e.stopPropagation()} role="dialog" aria-label="报价核验详情"><div className="pw-drawer-heading"><div><span className="pw-eyebrow">{date} · 报价核验</span><h2>{selected.model}</h2><span>{selected.storage}</span></div><button className="pw-icon" aria-label="关闭详情" onClick={()=>setSelectedId(null)}><X size={20}/></button></div><div className="pw-drawer-body">{error?<div className="pw-alert error" role="alert">{error}</div>:null}{selected.work?.newObservation?<div className="pw-problems"><b>有新接口结果，人工值已保留</b><p>新挂牌 {money(selected.work.newObservation.quote.list)} / 券 {money(selected.work.newObservation.quote.coupon)} / 接口到手 {money(selected.work.newObservation.quote.actual)}</p><SafeLink href={selected.work.newObservation.quote.link}>查看新商品来源</SafeLink>{editable?<button disabled={busy} onClick={()=>void adopt()}>采用新报价</button>:null}<p>可在表格修改挂牌价和优惠券，或补充正确商品链接。</p></div>:null}<div className="pw-detail-prices"><div><span>挂牌价</span><b>{money(selected.work?.list)}</b></div><div><span>优惠券</span><b>{money(selected.work?.coupon)}</b></div><div><span>国补后</span><b>{money(selected.work?.final)}</b></div></div><div className="pw-quote-evidence"><p>接口参考到手价 <b>{money(selected.work?.quote?.actual)}</b></p><p>挂牌减券与接口价差 <b>{selected.work?.list!=null && selected.work.coupon!=null && selected.work.quote?.actual!=null?money(selected.work.list-selected.work.coupon-selected.work.quote.actual):'—'}</b></p><span>{selected.work?.quote?.shop || '尚无合格商品'}</span>{selected.work?.quote?.fetchedAt?<p>接口查询时间：{time(selected.work.quote.fetchedAt)}</p>:null}<p>{selected.work?.quote?.title}</p><div className="pw-links"><SafeLink href={selected.productLink || selected.work?.quote?.link}>打开具体商品</SafeLink><SafeLink href={selected.searchUrl}>按型号＋存储重新搜索</SafeLink></div></div>{selected.work?.dirty && collectionIssues(selected.work).length>0?<div className="pw-help"><div><b>采价状态（不计入核验项）</b>{collectionIssues(selected.work).map(i=><p key={i.code}>{i.message}</p>)}</div></div>:null}{selected.work?.dirty && verificationCount(selected.work)>0?<div className="pw-problems"><b>需要核验（{verificationCount(selected.work)} 项）</b>{verificationIssues(selected.work).map(i=><p key={i.code}>• {i.message}</p>)}</div>:null}
      {editable?<div className="pw-review-form"><h3>补充商品链接</h3><p className="pw-muted">粘贴京东商品链接后，系统会重新采价并校验型号、容量与自营店铺。</p><label>商品链接<input aria-label="商品链接" value={evidence} onChange={e=>setEvidence(e.target.value)} placeholder="https://item.jd.com/…"/></label><button className="pw-primary" disabled={busy || !evidence.trim() || date!==today()} onClick={()=>void saveProductLink()}><Check size={16}/>保存链接并重新采价</button>{selected.work && selected.work.list==null && selected.work.coupon==null?<><p className="pw-muted">搜索后确认该规格无货或已不再销售，无需填写链接，直接标记已下架。</p><button disabled={busy || selected.work.published?.availability==='discontinued' && !selected.work.dirty} onClick={()=>void markDelisted()}>已下架</button></>:null}</div>:<div className="pw-help"><LockKeyhole size={16}/>当前只读，登录核验账号后可以补充商品链接。</div>}

      <div className="pw-section-title"><h3><History size={16}/>来源与变更历史</h3></div>{history? <><p className="pw-muted">{history.observationTotal} 次接口/导入记录 · {history.revisionTotal} 个生效版本</p>{history.revisionTotal>0?<details><summary>生效版本（{history.revisionTotal}）</summary>{history.revisions.map(r=><details key={r.id}><summary>{time(r.created_at)} · {r.reason}</summary><p>挂牌 {money(r.list)} / 券 {money(r.coupon)} / 国补后 {money(r.final)}</p><SafeLink href={r.evidence}>核验证据</SafeLink></details>)}</details>:null}{history.observations.map(o=><ObservationDetails key={`${date}/${o.id}`} observation={o} skuId={selected.id} date={date}/>)}{Math.max(history.observationTotal,history.revisionTotal)>history.limit?<div className="pw-links"><button disabled={historyOffset===0} onClick={()=>setHistoryOffset(n=>Math.max(0,n-history.limit))}>上一页历史</button><span>{historyOffset+1}–{Math.min(historyOffset+history.limit,Math.max(history.observationTotal,history.revisionTotal))}</span><button disabled={historyOffset+history.limit>=Math.max(history.observationTotal,history.revisionTotal)} onClick={()=>setHistoryOffset(n=>n+history.limit)}>下一页历史</button></div>:null}</>:<p>正在加载历史…</p>}</div></aside></div>:null}
    {pasteReview?<div className="pw-overlay" onClick={()=>setPasteReview(null)}><div className="pw-login" role="dialog" aria-label="确认批量粘贴" onClick={e=>e.stopPropagation()}><h2>确认批量粘贴</h2>{error?<div className="pw-alert error">{error}</div>:null}<p>{date} · {pasteReview.targets.length} 行 · {pasteReview.changes.length} 个单元格</p><p>从 {pasteReview.targets[0]} 开始，到 {pasteReview.targets.at(-1)}。</p><p>国补后自动重算。任何版本冲突都会取消整批保存。</p><button className="pw-primary" disabled={busy} onClick={()=>void savePaste()}>{busy?'保存中…':'确认保存'}</button><button onClick={()=>setPasteReview(null)}>取消</button></div></div>:null}
    {loginOpen?<Login onDone={()=>{void loadMe();refreshRef.current();}} onClose={()=>setLoginOpen(false)}/>:null}
    {passwordOpen?<div className="pw-overlay" onClick={()=>setPasswordOpen(false)}><form className="pw-login" onClick={e=>e.stopPropagation()} onSubmit={changePassword}><h2>修改密码</h2>{error?<div className="pw-alert error">{error}</div>:null}<label>原密码<input required type="password" autoComplete="current-password" value={passwordForm.oldPassword} onChange={e=>setPasswordForm({...passwordForm,oldPassword:e.target.value})}/></label><label>新密码<input required type="password" autoComplete="new-password" minLength={10} value={passwordForm.newPassword} onChange={e=>setPasswordForm({...passwordForm,newPassword:e.target.value})}/></label><button className="pw-primary">保存并重新登录</button><button type="button" onClick={()=>setPasswordOpen(false)}>取消</button></form></div>:null}
  </section>;
}
