import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { normalizeMaintenanceMedia } from './daily-log-save-rules.mjs';
import { preserveStockEntrySnapshot } from './purchase-batch-details.mjs';

const list = value => Array.isArray(value) ? value : [];
const text = value => typeof value === 'string' ? value.trim() : '';
export const receivingFail = (message, statusCode = 400, code = 'BATCH_RECEIVING_INVALID') => { throw Object.assign(new Error(message), { statusCode, code }); };
const fail = receivingFail;
const keyFor = (boxId,itemId) => JSON.stringify([boxId,itemId]);
export function receivingDigest(value) {
  const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])) : v;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export function receivingSources(batch) {
  const lines = new Map(list(batch?.procurement?.lines).map(line=>[line.id,line]));
  const consumed = new Map();
  for (const receipt of list(batch?.receiving?.receipts)) for (const entry of list(receipt.entries)) {
    const key = keyFor(entry.boxId,entry.itemId), old = consumed.get(key) || { stockedQuantity:0,lostQuantity:0 };
    old.stockedQuantity += Number(entry.stockedQuantity || 0); old.lostQuantity += Number(entry.lostQuantity || 0); consumed.set(key,old);
  }
  return list(batch?.procurement?.boxes).flatMap(box=>list(box.items).map(item=>{
    const line = lines.get(item.lineId), count = consumed.get(keyFor(box.id,item.id)) || {stockedQuantity:0,lostQuantity:0};
    return {boxId:box.id,itemId:item.id,lineId:item.lineId,boxNo:box.boxNo,productId:line?.productId || '',productName:line?.productName || '',size:line?.size || '',origin:line?.origin || '',orderedQuantity:item.quantity,...count,pendingQuantity:item.quantity-count.stockedQuantity-count.lostQuantity};
  }));
}
export function receivingBlockedReason(state,batch) {
  if(batch?.receiving?.schemaVersion!==1) return '历史批次缺少完整接收来源，不能再次办理入缸；原库存、损耗和采购资料仍可查看和维护。新采购请先创建批次清单。';
  if (batch?.procurement?.status !== 'confirmed') return '请先在批次资料中登记采购数量和装箱明细，并保存确认分摊，再办理入缸或到货死亡。';
  const known = new Set(list(batch?.receiving?.receipts).flatMap(r=>list(r.entries).flatMap(e=>[...list(e.stockItemIds),...list(e.lossStockItemIds)])));
  const historical = list(state.stock).some(item=>item.batchId===batch.id && !known.has(item.id));
  const historicalDeleted = list(state.approvalRequests).some(request=>request.status==='approved' && list(request.stockDetails?.items).some(item=>[item.before,item.after].some(stock=>stock?.batchId===batch.id&&!stock.procurementSource&&!known.has(item.stockItemId || stock.stockItemId || stock.id))));
  // Existing aggregate counts are historical evidence too; never make those fish available again.
  const unlinkedCounts = !batch.receiving && (Number(batch.stockedCount || 0)>0 || Number(batch.lossCount || 0)>0);
  if (historical || historicalDeleted || unlinkedCounts) return '历史批次已有未关联库存或损耗，本次接收仅支持已登记采购清单的新批次；原库存和历史记录仍保留。';
  if (receivingSources(batch).some(row=>row.pendingQuantity<0)) return '采购数量小于已接收数量，请联系管理员核对。';
  return '';
}
export function receivingSnapshot(state,batch,permissions) {
  const sources=receivingSources(batch), blockedReason=receivingBlockedReason(state,batch);
  const publicReceipts=list(batch.receiving?.receipts).map(({requestDigest,operatorId,clientMutationId,...receipt})=>receipt);
  return {ok:true,batchId:batch.id,batch,revision:Number(batch.receiving?.revision || 0),costingRevision:Number(batch.costingRevision || 0),sources,
    summary:sources.reduce((sum,row)=>{ for (const k of ['orderedQuantity','stockedQuantity','lostQuantity','pendingQuantity']) sum[k]+=row[k]; return sum; },{orderedQuantity:0,stockedQuantity:0,lostQuantity:0,pendingQuantity:0}),
    availabilityKnown:!blockedReason, receipts:publicReceipts,permissions,blockedReason};
}
export function assertReceivedProcurementUnchanged(current,next) {
  if(list(current?.receiving?.receipts).length) {
    const financial = procurement => Object.fromEntries(['schemaVersion','currency','status','lines','boxes','fees','allocation'].map(key=>[key,procurement?.[key]]));
    if(!isDeepStrictEqual(financial(current.procurement),financial(next.procurement))) fail('批次已开始接收，采购清单、装箱和费用已锁定，避免改变已接收鱼只成本；仍可修改备注等基本资料。',409,'BATCH_RECEIVING_COST_LOCKED');
  }
  const consumed=receivingSources(current).filter(row=>row.stockedQuantity+row.lostQuantity>0), nextSources=receivingSources(next);
  for(const row of consumed) {
    const source=nextSources.find(item=>item.boxId===row.boxId&&item.itemId===row.itemId);
    if(!source || source.lineId!==row.lineId || source.productId!==row.productId || source.boxNo!==row.boxNo || source.orderedQuantity < row.stockedQuantity+row.lostQuantity) fail('已接收的装箱来源不能删除、更换商品或减少至已接收数量以下；请保留原箱和采购行。',409,'BATCH_RECEIVING_SOURCE_LOCKED');
  }
}
export function assertGenericReceivingStockPatch(current,next,changedKeys=[]) {
  if(!changedKeys.includes('stock')) return;
  const previous=new Map(list(current.stock).map(item=>[item.id,item]));
  for(const item of list(next.stock)) {
    const before=previous.get(item.id);
    if(!before) fail('新增鱼只须通过采购批次接收；盘库更正请使用盘库工作台',409,'BATCH_RECEIVING_REQUIRED');
    if(before.procurementSource) {
      for(const field of ['batchId','productId','procurementSource','entryDisposition','neverEnteredTank','procurementCostSnapshot']) if(!isDeepStrictEqual(item[field],before[field])) fail('采购接收来源不可直接修改，请刷新后重试',409,'BATCH_RECEIVING_SOURCE_LOCKED');
      if(before.entryDisposition==='arrival_dead' && (item.lost!==true||text(item.subTankId))) fail('到货死亡记录不能改为在缸库存',409,'BATCH_RECEIVING_SOURCE_LOCKED');
    } else if(item.procurementSource||item.entryDisposition||item.neverEnteredTank) fail('接收来源只能由批次接收流程生成',409,'BATCH_RECEIVING_SOURCE_LOCKED');
  }
}
export function preserveReceivingStockIdentity(item,existing) {
  if(!existing?.procurementSource) {
    if(item.procurementSource || item.entryDisposition || item.neverEnteredTank) fail('接收来源只能由批次入缸或到货死亡流程生成',409,'BATCH_RECEIVING_SOURCE_LOCKED');
    return item;
  }
  if(item.batchId!==existing.batchId || item.productId!==existing.productId || (item.procurementSource && !isDeepStrictEqual(item.procurementSource,existing.procurementSource)) || (item.entryDisposition!==undefined && item.entryDisposition!==existing.entryDisposition) || (item.neverEnteredTank!==undefined && item.neverEnteredTank!==existing.neverEnteredTank)) fail('已接收鱼只的批次、商品和装箱来源不能修改',409,'BATCH_RECEIVING_SOURCE_LOCKED');
  if(existing.entryDisposition==='arrival_dead' && (item.lost!==true || text(item.subTankId))) fail('到货死亡记录不能改为在缸库存',409,'BATCH_RECEIVING_SOURCE_LOCKED');
  return {...item,procurementSource:existing.procurementSource,entryDisposition:existing.entryDisposition,neverEnteredTank:existing.neverEnteredTank,procurementCostSnapshot:existing.procurementCostSnapshot};
}
export function normalizeReceivingInput(input,today) {
  if(!input || Array.isArray(input) || Object.keys(input).some(k=>!['siteId','batchId','expectedRevision','expectedCostingRevision','clientMutationId','date','entries','proofPhotos','reason','notes'].includes(k))) fail('批次接收请求字段无效');
  for(const k of ['siteId','batchId','clientMutationId']) if(!text(input[k]) || input[k].length>120) fail('请选择批次和具体场地');
  if(input.siteId==='all' || !/^[A-Za-z0-9_-]{8,120}$/.test(input.clientMutationId)) fail('提交编号无效，请重新打开接收窗口');
  for(const k of ['expectedRevision','expectedCostingRevision']) if(!Number.isSafeInteger(input[k])||input[k]<0) fail('批次版本无效，请重新打开接收窗口');
  const date=text(input.date);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date||date>today) fail('接收日期须为有效日期，且不能晚于今天');
  for(const k of ['reason','notes']) if(input[k]!=null && (typeof input[k]!=='string'||input[k].length>2000)) fail('原因和备注不能超过2000字');
  if(!Array.isArray(input.entries)||!input.entries.length||input.entries.length>100) fail('每次请选择1至100个接收明细');
  const entries=input.entries.map(entry=>{
    if(!entry || Object.keys(entry).some(k=>!['boxId','itemId','stockedQuantity','lostQuantity','subTankId'].includes(k))) fail('接收明细字段无效');
    if(!text(entry.boxId)||!text(entry.itemId)) fail('请选择明确的箱号和品种');
    for(const k of ['stockedQuantity','lostQuantity']) if(!Number.isSafeInteger(entry[k])||entry[k]<0) fail('入缸和到货死亡数量须为非负整数');
    if(!entry.stockedQuantity&&!entry.lostQuantity) fail('每条明细至少填写一个接收数量');
    return {...entry,subTankId:text(entry.subTankId)};
  });
  if(entries.reduce((n,e)=>n+e.stockedQuantity+e.lostQuantity,0)>500) fail('单次最多接收500条，请分次接收');
  const proofPhotos=normalizeMaintenanceMedia(input.proofPhotos,'到货死亡照片');
  if(proofPhotos.some(url=>! /\.(?:jpe?g|png|webp|gif|heic|heif|avif)(?:[?#]|$)/i.test(url))) fail('到货死亡凭证须为照片');
  if(entries.some(e=>e.lostQuantity>0)&&!proofPhotos.length) fail('登记到货死亡必须上传照片，原因可以事后补充');
  return {...input,date,entries,proofPhotos,reason:text(input.reason),notes:text(input.notes)};
}
export function planBatchReceiving({state,batch,input,operator,operatorId,now=new Date().toISOString()}) {
  const blocked=receivingBlockedReason(state,batch); if(blocked) fail(blocked,409,'BATCH_RECEIVING_BLOCKED');
  if(input.date<batch.arrivalDate) fail('接收日期不能早于批次到货日期');
  if(input.expectedRevision!==Number(batch.receiving?.revision||0)||input.expectedCostingRevision!==Number(batch.costingRevision||0)) fail('批次采购或接收数量已变化，请刷新后核对剩余数量',409,'BATCH_RECEIVING_VERSION_CONFLICT');
  const sources=receivingSources(batch), totals=new Map(), sourceMap=new Map(sources.map(s=>[keyFor(s.boxId,s.itemId),s]));
  for(const entry of input.entries) {const k=keyFor(entry.boxId,entry.itemId),source=sourceMap.get(k); if(!source) fail('所选装箱品种已不存在，请刷新后重试',409);totals.set(k,(totals.get(k)||0)+entry.stockedQuantity+entry.lostQuantity);if(totals.get(k)>source.pendingQuantity) fail(`第${source.boxNo}箱「${source.productName}」仅剩${source.pendingQuantity}条待接收`,409,'BATCH_RECEIVING_QUANTITY_EXCEEDED');}
  const receiptId=`receipt-${randomUUID()}`, stockItems=[], lossRecords=[], bioRecords=[], entries=[], ordinals=new Map();
  const products=new Map(list(state.products).map(p=>[p.id,p]));
  if(products.size!==list(state.products).length) fail('商品编号重复，请先核对商品档案',409);
  for(const entry of input.entries) {
    const source=sourceMap.get(keyFor(entry.boxId,entry.itemId)),product=products.get(source.productId);
    if(!product) fail('采购商品已不存在，请先恢复商品档案',409);
    const groups=list(state.tankGroups).filter(g=>(g.siteId||'nanjing')===input.siteId).flatMap(g=>list(g.subTanks).filter(t=>t.id===entry.subTankId));
    if(entry.stockedQuantity && groups.length!==1) fail('入缸目标不存在、重复或不属于当前场地',409);
    const stored={...entry,lineId:source.lineId,productId:source.productId,stockItemIds:[],lossStockItemIds:[]};
    const allocation=list(batch.procurement.allocation?.boxes).find(b=>b.boxId===entry.boxId)?.items?.find(i=>i.itemId===entry.itemId);
    const key=keyFor(entry.boxId,entry.itemId);
    for(let index=0;index<entry.stockedQuantity+entry.lostQuantity;index++) {
      const dead=index>=entry.stockedQuantity,stockId=`stock-${randomUUID()}`;
      const ordinal=(ordinals.get(key)??source.stockedQuantity+source.lostQuantity)+1;ordinals.set(key,ordinal);
      const costSnapshot=allocation?Object.fromEntries(Object.entries(allocation).filter(([k])=>k.endsWith('Cents')).map(([k,v])=>[k,Math.floor(v/source.orderedQuantity)+(ordinal<=v%source.orderedQuantity?1:0)])):undefined;
      if(costSnapshot) costSnapshot.totalCents=Object.entries(costSnapshot).reduce((sum,[key,value])=>key==='totalCents'?sum:sum+value,0);
      let item={id:stockId,siteId:input.siteId,batchId:batch.id,productId:source.productId,subTankId:dead?'':entry.subTankId,inDate:input.date,status:'healthy',sold:false,lost:dead,basePrice:Math.max(0,Number(product.defaultPrice)||0),priceMode:'product',priceOverridden:false,commissionRate:0,code:'',notes:input.notes,
        entryDisposition:dead?'arrival_dead':'stocked',neverEnteredTank:dead,procurementSource:{receiptId,lineId:source.lineId,boxId:source.boxId,itemId:source.itemId,ordinal},procurementCostSnapshot:costSnapshot,
        ...(dead?{lossDate:input.date,lossReason:input.reason,lossProof:input.proofPhotos}: {})};
      if(!dead) item=preserveStockEntrySnapshot({item,tankGroups:state.tankGroups,sites:state.sites,operator,recordedAt:now});
      stockItems.push(item);stored[dead?'lossStockItemIds':'stockItemIds'].push(stockId);
      if(dead) {
        const lossId=`loss-${randomUUID()}`,bioId=`bio-${randomUUID()}`;
        const loss={id:lossId,siteId:input.siteId,stockItemId:stockId,date:input.date,reason:input.reason,proofPhotos:input.proofPhotos,operator,createdAt:now,sourceBioRecordId:bioId,productName:source.productName,fishCode:'',subTankId:'',tankGroupId:'',tankGroupName:'',subTankName:'',tankLocation:'到货死亡（未入缸）',tankName:'到货死亡（未入缸）',entryDisposition:'arrival_dead',receiptId};
        lossRecords.push(loss);bioRecords.push({id:bioId,siteId:input.siteId,stockItemId:stockId,date:input.date,text:`到货死亡（未入缸）${input.reason?`：${input.reason}`:''}`,photos:input.proofPhotos,videos:[],sourceType:'stockLoss',sourceLossRecordId:lossId,operator,entryDisposition:'arrival_dead',receiptId});
      }
    }
    entries.push(stored);
  }
  const receipt={id:receiptId,clientMutationId:input.clientMutationId,requestDigest:receivingDigest(input),operatorId,operator,date:input.date,createdAt:now,entries,proofPhotos:input.proofPhotos,reason:input.reason,notes:input.notes};
  const nextBatch={...batch,receiving:{schemaVersion:1,revision:Number(batch.receiving?.revision||0)+1,receipts:[...list(batch.receiving?.receipts),receipt]}};
  const operationLog={id:`log-${randomUUID()}`,time:now,operator,module:'采购批次',action:'批次接收',detail:`批次「${batch.batchNo}」入缸${entries.reduce((n,e)=>n+e.stockedQuantity,0)}条，到货死亡${entries.reduce((n,e)=>n+e.lostQuantity,0)}条；接收记录${receiptId}`};
  return {batch:nextBatch,receipt,stockItems,lossRecords,bioRecords,operationLog};
}
