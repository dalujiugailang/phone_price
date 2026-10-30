import {fault,beijingDate,validDate} from './price-workbench.mjs';
import {randomUUID} from 'node:crypto';
import XLSX from 'xlsx';

export function registerPriceWorkbenchRoutes(app,service) {
  const prefix='/api/workbench';
  const cookieName='gtm_workbench';
  const attempts=new Map();
  const safe=(fn)=>(req,res,next)=>Promise.resolve().then(()=>fn(req,res,next)).catch(e=>res.status(e.status || 500).json({message:e.status?e.message:'服务暂时不可用，请重试',...(e.current?{current:e.current}:{})}));
  const token=(req)=>String(req.headers.cookie || '').split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='))?.slice(cookieName.length+1);
  const user=(req)=>service.userFromToken(token(req));
  const requireUser=(req,role)=>{const u=user(req);if(!u)throw fault(401,'请先登录');if(role==='admin' && u.role!=='admin' || role==='edit' && u.role==='viewer')throw fault(403,'当前账号只有只读权限');return u;};
  const validOrigin=(req)=>{
    const origin=req.get('origin');if(!origin)return true;
    try {const host=new URL(origin).host;return host===req.get('host') || (process.env.WORKBENCH_ALLOWED_ORIGINS || 'http://localhost:8001,http://127.0.0.1:8001').split(',').includes(origin);}catch{return false;}
  };
  app.use('/api',(req,res,next)=>{const id=randomUUID();res.setHeader('X-Request-Id',id);service.withRequest(id,next);});
  // Protect legacy mutations too; worker endpoints keep their pre-existing dedicated token validation.
  app.use('/api',safe((req,res,next)=>{
    const p=req.path;
    if(['GET','HEAD','OPTIONS'].includes(req.method))return next();
    if(!validOrigin(req))throw fault(403,'请求来源不允许');
    if(p.startsWith('/workbench/'))return next();
    if(/^\/weekly-sales\/automation\/jobs\//.test(p))return next();
    if(['/bi-price-lookup','/expert/ask','/expert/ask/stream'].includes(p))return next();
    if(p==='/raw-editor-draft'){
      if(req.body?.workbookSyncMode==='latestBiPriceOnly')return res.json(service.updateBiPrices(req.body,requireUser(req,'admin')));
      throw fault(410,'整表写入已关闭，请使用每日采价工作台');
    }
    requireUser(req,'admin');return next();
  }));
  app.get(`${prefix}/me`,safe((req,res)=>res.json({user:user(req),...service.status()})));
  app.post(`${prefix}/login`,safe((req,res)=>{
    const key=req.ip,record=attempts.get(key) || {count:0,until:Date.now()+60000};
    if(Date.now()>record.until){record.count=0;record.until=Date.now()+60000;}
    if(record.count>=8)throw fault(429,'登录尝试过多，请一分钟后重试');
    record.count++;attempts.set(key,record);
    const result=service.login(req.body.username,req.body.password);
    attempts.delete(key);
    const secure=req.secure || req.get('x-forwarded-proto')==='https';
    res.setHeader('Set-Cookie',`${cookieName}=${result.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure?'; Secure':''}`);
    res.json({user:result.user});
  }));
  app.post(`${prefix}/logout`,safe((req,res)=>{if(token(req))service.logout(token(req));res.setHeader('Set-Cookie',`${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);res.json({ok:true});}));
  app.post(`${prefix}/password`,safe((req,res)=>{service.changePassword(requireUser(req),req.body.oldPassword,req.body.newPassword);res.json({ok:true});}));
  app.get(`${prefix}/rows`,safe((req,res)=>res.json(service.listRows(String(req.query.date || beijingDate())))));
  app.get(`${prefix}/product-links`,safe((req,res)=>res.json(service.productLinks(String(req.query.date || beijingDate())))));
  app.get(`${prefix}/models`,safe((req,res)=>res.json(service.models())));
  app.post(`${prefix}/check-cell/:id`,safe((req,res)=>res.json(service.checkCell(req.params.id,req.body.date,req.body,requireUser(req,'edit')))));
  app.post(`${prefix}/delisted/:id`,safe((req,res)=>res.json(service.markDelisted(req.params.id,req.body.date,req.body,requireUser(req,'edit')))));
  app.post(`${prefix}/reset-api`,safe((req,res)=>res.json(service.resetApi(req.body.date,req.body,requireUser(req,'admin')))));
  app.post(`${prefix}/push-warehouse`,safe((req,res)=>res.json(service.pushWarehouse(req.body.date,req.body,requireUser(req,'admin')))));
  app.patch(`${prefix}/product-link/:id`,safe((req,res)=>res.json(service.saveProductLink(req.params.id,req.body,requireUser(req,'edit')))));
  app.patch(`${prefix}/models/:id`,safe((req,res)=>res.json(service.updateModel(req.params.id,req.body,requireUser(req,'edit')))));
  app.patch(`${prefix}/cells/:id`,safe((req,res)=>res.json(service.patchCell(req.params.id,req.body.date,req.body,requireUser(req,'edit')))));
  app.patch(`${prefix}/batch`,safe((req,res)=>res.json(service.patchMany(req.body.date,req.body.changes,requireUser(req,'edit')))));
  app.post(`${prefix}/restore/:id`,safe((req,res)=>res.json(service.restoreRevision(req.params.id,req.body.date,req.body,requireUser(req,'admin')))));
  app.post(`${prefix}/adopt/:id`,safe((req,res)=>res.json(service.adoptObservation(req.params.id,req.body.date,req.body,requireUser(req,'edit')))));
  app.post(`${prefix}/confirm/:id`,safe((req,res)=>res.json(service.confirm(req.params.id,req.body.date,req.body,requireUser(req,'edit')))));
  app.post(`${prefix}/claim/:id`,safe((req,res)=>res.json(service.claim(req.params.id,req.body.date,requireUser(req,'edit')))));
  app.get(`${prefix}/history/:id`,safe((req,res)=>res.json(service.history(req.params.id,String(req.query.date),{offset:req.query.offset,limit:req.query.limit}))));
  app.get(`${prefix}/history/:id/observations/:observationId`,safe((req,res)=>{
    const {id,observationId}=req.params,date=String(req.query.date);
    if(req.query.download==='1'){res.attachment(`observation-${observationId}.json`).type('application/json').send(service.observationDownload(observationId,id,date));return;}
    res.json(service.rawObservation(observationId,id,date,{offset:req.query.offset,limit:req.query.limit}));
  }));
  app.get(`${prefix}/logs`,safe((req,res)=>res.json(service.logs({query:String(req.query.query || ''),offset:req.query.offset,limit:req.query.limit,date:String(req.query.date || '')}))));
  app.get(`${prefix}/runs`,safe((req,res)=>res.json(service.runs())));
  app.post(`${prefix}/runs`,safe((req,res)=>{const result=service.createRun(req.body.date,requireUser(req,'edit'),{ids:req.body.ids});res.status(202).json(result);service.processRun().catch(e=>console.error('price worker:',e.message));}));
  app.post(`${prefix}/runs/:id/retry`,safe((req,res)=>{
    const u=requireUser(req,'edit');
    const run=service.db.prepare('SELECT * FROM runs WHERE id=?').get(req.params.id);
    if(!run)throw fault(404,'任务不存在');
    const ids=service.db.prepare("SELECT sku_id FROM run_items WHERE run_id=? AND state='failed'").all(run.id).map(x=>x.sku_id);
    if(!ids.length)throw fault(422,'该任务没有失败项');
    const result=service.createRun(run.date,u,{ids});res.status(202).json(result);service.processRun().catch(e=>console.error('price worker:',e.message));
  }));
  app.get(`${prefix}/users`,safe((req,res)=>res.json(service.users(requireUser(req,'admin')))));
  app.post(`${prefix}/users`,safe((req,res)=>res.json(service.saveUser(req.body,requireUser(req,'admin')))));
  app.post(`${prefix}/import`,safe((req,res)=>{
    const u=requireUser(req,'admin');
    if(!req.body.hash || !/^[a-f0-9]{64}$/.test(req.body.hash))throw fault(422,'需要来源文件 SHA256');
    res.json(service.importRows(req.body.rows,req.body.date,u,req.body.hash));
  }));
  app.get(`${prefix}/export.xlsx`,safe((req,res)=>{
    const date=String(req.query.date || beijingDate());if(!validDate(date))throw fault(422,'日期不正确');
    const rows=service.listRows(date).rows;
    const data=[['型号','存储版本','挂牌价','优惠券','国补后','接口参考到手价','核验状态','商品链接','搜索链接']];
    for(const r of rows)data.push([r.model,r.storage,r.work?.list==null?'':r.work.list/100,r.work?.coupon==null?'':r.work.coupon/100,'',r.work?.quote?.actual==null?'':r.work.quote.actual/100,r.work?.review_state || '未采集',r.work?.quote?.link || '',r.searchUrl]);
    const sheet=XLSX.utils.aoa_to_sheet(data);
    for(let i=2;i<=rows.length+1;i++){
      sheet[`E${i}`]={t:'n',z:'#,##0.00',f:`IF(OR(NOT(ISNUMBER(C${i})),NOT(ISNUMBER(D${i})),C${i}<=0,D${i}>C${i}),"",ROUND(IF(C${i}-D${i}>6000,C${i}-D${i}-500,C${i}-D${i}-MIN((C${i}-D${i})*15%,500)),2))`,...(rows[i-2].work?.final!=null?{v:rows[i-2].work.final/100}:{})};
      for(const column of ['C','D','F'])if(sheet[`${column}${i}`]?.t==='n')sheet[`${column}${i}`].z='#,##0.00';
    }
    sheet['!cols']=[{wch:32},{wch:20},...Array.from({length:4},()=>({wch:18})),{wch:16},{wch:45},{wch:45}];
    const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,sheet,date);res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');res.setHeader('Content-Disposition',`attachment; filename="price-${date}.xlsx"`);res.send(XLSX.write(book,{type:'buffer',bookType:'xlsx'}));
  }));
  app.get(`${prefix}/events`,(req,res)=>{
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive','X-Accel-Buffering':'no'});
    res.write(`data: ${JSON.stringify({type:'connected',id:randomUUID()})}\n\n`);
    const unsubscribe=service.subscribe(e=>res.write(`data: ${JSON.stringify(e)}\n\n`));
    const heartbeat=setInterval(()=>res.write(': heartbeat\n\n'),20000);heartbeat.unref?.();req.on('close',()=>{clearInterval(heartbeat);unsubscribe();});
  });
  const timer=setInterval(()=>service.tick(),15000);timer.unref?.();
  return {stop(){clearInterval(timer);},user};
}
