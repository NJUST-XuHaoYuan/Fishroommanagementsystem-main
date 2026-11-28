import { normalizeReceivingInput, planBatchReceiving, receivingDigest, receivingSnapshot, receivingFail } from './purchase-batch-receiving-rules.mjs';
import { refreshBatchStockCounts } from './batch-stock-counts.mjs';
const list=value=>Array.isArray(value)?value:[];
const fail=receivingFail;
const STATE_SQL=`SELECT data -> 'personnel' AS personnel, data -> 'sites' AS sites, data -> 'batches' AS batches,
 data -> 'products' AS products, data -> 'tankGroups' AS "tankGroups", data -> 'stock' AS stock,
 data -> 'approvalRequests' AS "approvalRequests" FROM app_state WHERE id=$1`;
export function createBatchReceivingHandler({pool,stateId,readBody,sendJson,refreshAuth,requireSite,requirePermission,hasPermission,normalizeSiteId,todayInChina,maxOperationLogs=1000}) {
 return async(req,res,url)=>{
  if(!['/api/batches/receiving','/api/batches/receive'].includes(url.pathname)) return false;
  res.setHeader('Cache-Control','no-store, private');let client;
  try {
   const read=url.pathname==='/api/batches/receiving';
   if(req.method!==(read?'GET':'POST')) fail('不支持的请求方式',405);
   let input;
   if(!read){try {input=JSON.parse(await readBody(req,128*1024));}catch{fail('接收请求不是有效JSON');} input=normalizeReceivingInput(input,todayInChina());}
   const siteId=read?url.searchParams.get('siteId'):input.siteId,batchId=read?url.searchParams.get('batchId'):input.batchId;
   if(!siteId||siteId==='all'||!batchId) fail('请选择具体场地和采购批次');
   client=await pool.connect();await client.query('BEGIN');
   const state=(await client.query(STATE_SQL+(read?'':' FOR UPDATE'),[stateId])).rows[0];
   if(!state) fail('系统数据暂不可用',503);
   refreshAuth(req,state);requireSite(req,state,siteId);
   const account=req.auth?.account;
   if(!['batches','stockIn'].some(module=>['create','update','delete'].some(action=>hasPermission(account,module,action)))) requirePermission(req,'stockIn','create');
   const matches=list(state.batches).filter(b=>b.id===batchId&&normalizeSiteId(b.siteId)===siteId);
   if(matches.length!==1) fail('采购批次不存在或编号重复',404,'BATCH_NOT_FOUND');
   const batch=matches[0];
   const permissions={canStock:hasPermission(account,'stockIn','create'),canLoss:hasPermission(account,'stockIn','create')&&hasPermission(account,'lossRecords','create')};
   if(read){await client.query('COMMIT');sendJson(req,res,200,receivingSnapshot(state,batch,permissions));return true;}
   if(input.entries.some(e=>e.stockedQuantity>0)&&!permissions.canStock) requirePermission(req,'stockIn','create');
   if(input.entries.some(e=>e.lostQuantity>0)&&!permissions.canLoss) fail('没有登记到货死亡的权限',403,'PERMISSION_DENIED');
   const actor=account.username;
   const replay=list(batch.receiving?.receipts).find(r=>r.clientMutationId===input.clientMutationId);
   if(replay){
    if(replay.requestDigest!==receivingDigest(input)||replay.operatorId!==actor) fail('提交编号已用于其他内容，请重新打开接收窗口',409,'BATCH_RECEIVING_IDEMPOTENCY_CONFLICT');
    const ids=new Set(list(replay.entries).flatMap(e=>[...list(e.stockItemIds),...list(e.lossStockItemIds)]));
    await client.query('COMMIT');sendJson(req,res,200,{...receivingSnapshot(state,batch,permissions),receiptId:replay.id,replayed:true,stockItems:list(state.stock).filter(s=>{ if(!ids.has(s.id))return false;try{const locations=list(state.tankGroups).filter(g=>list(g.subTanks).some(t=>t.id===s.subTankId));if(locations.length>1)return false;requireSite(req,state,normalizeSiteId(locations[0]?.siteId||s.siteId));return true;}catch{return false;} }),lossRecords:[],bioRecords:[]});return true;
   }
   const mutation=planBatchReceiving({state,batch,input,operator:actor,operatorId:actor});
   const stock=[...list(state.stock),...mutation.stockItems];
   const saved=refreshBatchStockCounts([mutation.batch],stock.filter(item=>item.batchId===batchId))[0];
   const batches=list(state.batches).map(b=>b.id===batchId?saved:b);
   await client.query("UPDATE app_state SET data=jsonb_set(jsonb_set(data,'{stock}',$2::jsonb,true),'{batches}',$3::jsonb,true),updated_at=now() WHERE id=$1",[stateId,JSON.stringify(stock),JSON.stringify(batches)]);
   for(const key of ['bioRecords','lossRecords']) if(mutation[key].length) await client.query(`UPDATE app_state SET data=jsonb_set(data,'{${key}}',COALESCE(data -> '${key}','[]'::jsonb) || $2::jsonb,true),updated_at=now() WHERE id=$1`,[stateId,JSON.stringify(mutation[key])]);
   await client.query(`UPDATE app_state SET data=jsonb_set(data,'{operationLogs}',(
    SELECT COALESCE(json_agg(entry ORDER BY ordering),'[]'::json)::jsonb FROM (
     SELECT $2::jsonb AS entry,0::bigint AS ordering UNION ALL
     SELECT operation_row.item,operation_row.ordinality FROM jsonb_array_elements(COALESCE(data -> 'operationLogs','[]'::jsonb)) WITH ORDINALITY AS operation_row(item,ordinality) WHERE operation_row.ordinality <= $3
    ) AS audit_rows),true),updated_at=now() WHERE id=$1`,[stateId,JSON.stringify(mutation.operationLog),maxOperationLogs-1]);
   await client.query('COMMIT');
   sendJson(req,res,200,{...receivingSnapshot({...state,stock,batches},saved,permissions),receiptId:mutation.receipt.id,replayed:false,stockItems:mutation.stockItems,lossRecords:mutation.lossRecords,bioRecords:mutation.bioRecords,operationLog:mutation.operationLog});
  }catch(error){if(client)await client.query('ROLLBACK').catch(()=>{});sendJson(req,res,error.statusCode||500,{ok:false,code:error.code||'BATCH_RECEIVING_UNAVAILABLE',error:error.statusCode?error.message:'批次接收失败，请稍后重试'});}
  finally{client?.release();}
  return true;
 };
}
