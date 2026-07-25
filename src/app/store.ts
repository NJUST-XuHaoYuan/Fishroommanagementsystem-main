import { createContext, useContext } from "react";

export type Role = "admin" | "staff";

export type User = { username: string; role: Role; visibleSiteIds?: string[] } | null;

export type PermissionAction = "create" | "update" | "delete";

export type PermissionModule =
  | "species"
  | "products"
  | "tankGroups"
  | "batches"
  | "stockIn"
  | "daily"
  | "lossRecords"
  | "customers"
  | "orders"
  | "accounts";

export type ModulePermission = Record<PermissionAction, boolean>;

export type PermissionSet = Record<PermissionModule, ModulePermission>;

export type Species = {
  id: string;
  name: string;
  scientificName: string;
  category: string;
  commonNames: string[];
  description: string;
  imageUrl: string;
};

export type Product = {
  id: string;
  speciesId: string;
  name: string;
  size: string;
  origin: string;
  imageUrl: string;
  defaultPrice: number;
  /** 商品最低回厂价，订单商品折后金额必须高于该价格合计。 */
  minReturnPrice?: number;
  /** 是否展示在对外网站。未设置时按展示处理，兼容旧数据。 */
  publicVisible?: boolean;
  /** 旧字段兼容：历史版本曾用百分比计算销售提成。 */
  commissionRate?: number;
  notes: string;
};

export type SubTank = {
  id: string;
  name: string;
  row?: number;
  col?: number;
};

export type TankGroup = {
  id: string;
  siteId?: string;
  name: string;
  location: string;
  rows?: number;
  cols?: number;
  subTanks: SubTank[];
};

export type PurchaseBatch = {
  id: string;
  siteId?: string;
  batchNo: string;
  supplier: string;
  arrivalDate: string;
  bioFee: number;
  shippingFee: number;
  stockedCount: number;
  lossCount: number;
  lossProof: string[];
  /** 旧字段兼容：历史版本曾用批次系数计算销售提成。 */
  commissionMultiplier?: number;
  /** 旧字段兼容：上一版曾用它表示批次默认提成比例，现不再作为最终提成比例使用。 */
  defaultCommissionRate?: number;
  notes: string;
};

export type StockStatus = "healthy" | "sick" | "feeding";

export type StockItem = {
  id: string;
  siteId?: string;
  productId: string;
  batchId: string;
  subTankId: string;
  status: StockStatus;
  /** 是否已售（由销售模块写入，与健康状态独立） */
  sold?: boolean;
  /** 是否已损耗。损耗后保留记录，但不再显示为在缸库存。 */
  lost?: boolean;
  lossDate?: string;
  lossReason?: string;
  lossProof?: string[];
  inDate: string;
  /** 这条鱼进入销售订单时默认带出的售价。 */
  basePrice: number;
  /** 是否在日常管理中手工改过单条售价。 */
  priceOverridden?: boolean;
  /** 旧字段兼容：历史版本曾用百分比计算销售提成。 */
  commissionRate?: number;
  /** 店内给单条鱼手工标记的展示编号。 */
  code?: string;
  notes: string;
};

export type BioRecord = {
  id: string;
  siteId?: string;
  stockItemId: string;
  date: string;
  text: string;
  photos: string[];
  videos?: string[];
  /** dailyLog 表示由缸组养护日志同步进来的系统记录。 */
  sourceType?: "dailyLog" | "manual" | string;
  sourceLogId?: string;
  tankGroupId?: string;
  tankGroupName?: string;
  subTankId?: string;
  subTankName?: string;
  tankLocation?: string;
  operator?: string;
};

export type DailyLog = {
  id: string;
  siteId?: string;
  date: string;
  tankGroupId?: string;
  /** 旧数据兼容：历史日志曾挂在子缸上。 */
  subTankId?: string;
  action: string;
  operator: string;
  notes: string;
  /** 已同步到哪些鱼的个体历史，避免后续移缸后旧日志跟着新鱼走。 */
  syncedStockItemIds?: string[];
  syncedAt?: string;
};

export type InventoryCheck = {
  id: string;
  siteId?: string;
  date: string;
  subTankId: string;
  systemCount: number;
  actualCount: number;
  diff: number;
  operator: string;
  notes: string;
};

export type StockLossRecord = {
  id: string;
  siteId?: string;
  stockItemId: string;
  date: string;
  reason: string;
  proofPhotos: string[];
  operator: string;
  /** 损耗发生时的缸位快照，避免后续移缸/删缸后记录显示为未知。 */
  subTankId?: string;
  tankGroupId?: string;
  tankGroupName?: string;
  subTankName?: string;
  tankLocation?: string;
  tankName?: string;
};

export type OrderStatus = "pending" | "confirmed" | "shipped" | "completed" | "cancelled" | "damaged";
export const ORDER_SOURCE_OPTIONS = ["线下", "平台下单", "私域线上"] as const;
export type OrderSource = typeof ORDER_SOURCE_OPTIONS[number];

export type OrderItem = {
  stockItemId: string;
  productId: string;
  price: number;
  /** 下单时固化的商品最低回厂价。 */
  minReturnPrice?: number;
  /** 旧字段兼容：历史版本曾用百分比计算销售提成。 */
  commissionRate?: number;
  plannedShipDate?: string;
  /** 库存记录删除后保留订单商品快照，避免丢失订单和收款历史。 */
  inventoryRemovedAt?: string;
  inventoryRemovedBy?: string;
};

export type PaymentType = "deposit" | "balance" | "shipping_fee" | "refund" | "other";

export type PaymentRecord = {
  id: string;
  time: string;       // ISO datetime "2026-04-22T10:30"
  type: PaymentType;
  amount: number;     // always positive; "refund" type = outflow
  proof: string[];    // base64 dataURL images
  notes: string;
};

export type Order = {
  id: string;
  siteId?: string;
  orderNo: string;
  createdAt?: string;
  customerId: string;
  date: string;
  source?: OrderSource | string;
  douyinOrderNo?: string;
  shippingAddress?: string;
  plannedShipDate?: string;
  contactPerson?: string;
  items: OrderItem[];
  shippingFee: number;
  packagingFee: number;
  discount: number;
  status: OrderStatus;
  notes: string;
  payments: PaymentRecord[];
};

export type ShipmentStatus = "preparing" | "outbound" | "shipped" | "delivered" | "damaged";

export type Shipment = {
  id: string;
  siteId?: string;
  orderId: string;
  /** 点击出库保存时的操作时间，精确到分钟。 */
  createdAt?: string;
  outboundDate?: string;
  shippedAt?: string;
  deliveredAt?: string;
  shipDate: string;
  carrier: string;
  trackingNo: string;
  status: ShipmentStatus;
  notes: string;
  shipMethod?: "express" | "pickup";
  actualShippingFee?: number;
  itemStockIds?: string[]; // stock item IDs included in this shipment
  damageResolution?: "refund" | "reship";
  /** 物流报损退款实际涉及的鱼，可小于本发货单商品数。 */
  damageItemStockIds?: string[];
  /** 物流报损造成的应收调整金额，和资金记录里的退款金额对应。 */
  damageRefundAmount?: number;
  /** 物流报损凭证，不代表已经实际退款。 */
  damageProof?: string[];
  /** 出库后、真正发货前上传的打包凭证。 */
  packingProof?: string[];
};

export type CustomerSource = "抖音" | "微信" | "线下" | "鱼友介绍";
export type CustomerType = "" | "B" | "C";

export type Customer = {
  id: string;
  name: string;
  customerType?: CustomerType;
  addedDate: string;
  phone: string;
  wechat: string;
  douyin: string;
  source: string;
  address: string;
  notes: string;
};

export type Personnel = {
  id: string;
  name: string;
  username: string;
  password: string;
  accessRole: Role;
  visibleSiteIds?: string[];
  permissions?: PermissionSet;
  employmentStatus?: "active" | "resigned";
  resignedAt?: string;
  role: string;
  phone: string;
  notes: string;
};

export function isPersonnelResigned(person?: Pick<Personnel, "employmentStatus" | "resignedAt"> | null): boolean {
  return person?.employmentStatus === "resigned" || Boolean(person?.resignedAt);
}

export type OperationLog = {
  id: string;
  time: string;
  operator: string;
  module: string;
  action: string;
  detail: string;
};

export type Site = {
  id: string;
  name: string;
};

export const DEFAULT_FISH_LIST_FOOTER_TEXT = `【包装费运费规则】
江浙沪皖满三件包邮
包装费统一 15 元
满 500 免包装费，满 1000 包邮

【一般生物收货、报损规则】
亲爱的顾客，感谢您的支持，下单即默认同意以下报损规则，请知悉！
【快递说明】本工作室会根据默认要求进行打包，包装费统一 15 元。若有更高规格运输需求，请提前联系，我们会加收一部分打包费。可以陆运次日达的发顺丰标快，其他地区发顺丰特快，运费实发实收。
【报损规则】一、运输包损承诺：我们承诺在揽收至签收≤36 小时内的运输安全。超出此时限或到店自提离店后，不再承担包损责任。
二、收货验收要求：签收后请立即录制开箱视频。从未拆封外箱开始连续拍摄，不得中断，清晰展示完整面单、密封袋完好性和生物实际状态。如需报损或到货状态不好，请在签收 5 小时内向客服提交视频，逾期不受理。
三、赔付标准：运输时长≤24 小时赔付 100% 货值；运输时长 24-48 小时赔付 50% 货值；运输时长≥48 小时不予赔付。死亡确认需提供鱼类剪尾视频或珊瑚开水浇灌视频。
四、特别说明：仅赔付生物货值，不含运费及包装费；仅支持退款，不支持退货。轻微运输损伤属正常现象，不在赔付范围。活动赠品及标注“不包损”商品不参与报损。
温馨提示：收到活体后请尽快过温过水，妥善安置。我们与您的共同目标是让每一个生物安全到家，感谢您的理解与配合！
【挑鱼规则】挑鱼需要额外增加费用，费用高低根据品种有所不同，详情咨询客服。`;

export type SystemSettings = {
  fishListFooterText: string;
};

export type Store = {
  user: User;
  systemSettings: SystemSettings;
  sites: Site[];
  personnel: Personnel[];
  operationLogs: OperationLog[];
  species: Species[];
  speciesCategories: string[];
  products: Product[];
  productOrigins: string[];
  tankGroups: TankGroup[];
  batches: PurchaseBatch[];
  stock: StockItem[];
  lossRecords: StockLossRecord[];
  logs: DailyLog[];
  checks: InventoryCheck[];
  bioRecords: BioRecord[];
  orders: Order[];
  shipments: Shipment[];
  customers: Customer[];
  customerSources: string[];
};

export type StoreContextType = {
  state: Store;
  activeSiteId: string;
  setActiveSiteId: React.Dispatch<React.SetStateAction<string>>;
  setState: React.Dispatch<React.SetStateAction<Store>>;
  savePatch: (patch: Partial<Omit<Store, "user">>) => Promise<boolean>;
  saveProduct: (product: Product) => Promise<boolean>;
  saveStockChange: (change: { upsert?: StockItem[]; deleteIds?: string[] }) => Promise<{ ok: boolean; error?: string }>;
  saveMaintenanceAction: (change:
    | { mode: "record"; itemIds: string[]; recordDate: string; recordText?: string; recordPhotos: string[]; recordVideos: string[] }
    | { mode: "move"; itemIds: string[]; targetSubTankId: string; moveDate?: string; moveNotes?: string }
    | { mode: "loss"; stockItemId?: string; itemIds?: string[]; lossDate: string; lossReason?: string; lossProof: string[] }
  ) => Promise<boolean>;
  saveTankGroupChange: (change: {
    mode: "upsertGroup" | "deleteGroup" | "upsertSubTank" | "deleteSubTank";
    group?: TankGroup;
    groupId?: string;
    subTank?: SubTank;
    subTankId?: string;
  }) => Promise<boolean>;
  saveDailyLog: (change: { log?: DailyLog; deleteId?: string }) => Promise<boolean>;
  saveShipmentOutbound: (change: {
    orderId: string;
    selectedItemIds: string[];
    shipMethod: "express" | "pickup";
    carrier?: string;
    shipDate: string;
    actualShippingFee?: number;
    notes?: string;
  }) => Promise<boolean>;
  saveOrderPaymentChange: (change: {
    orderId: string;
    action: "add" | "update" | "delete";
    payment?: PaymentRecord;
    paymentId?: string;
  }) => Promise<boolean>;
  savePersonnelAccount: (personnel: Personnel) => Promise<boolean>;
  resignPersonnelAccount: (id: string) => Promise<boolean>;
  deletePersonnelAccount: (id: string) => Promise<boolean>;
  savePersonnelPermissions: (id: string, permissions: PermissionSet) => Promise<boolean>;
  changePersonnelPassword: (change: { targetId?: string; oldPassword?: string; newPassword: string }) => Promise<boolean>;
  saveStateTransform: (
    transform: (latest: Omit<Store, "user">) => Omit<Store, "user">
  ) => Promise<boolean>;
};

export const uid = () => Math.random().toString(36).slice(2, 10);

export const fullPermissions = (): PermissionSet => ({
  species: { create: true, update: true, delete: true },
  products: { create: true, update: true, delete: true },
  tankGroups: { create: true, update: true, delete: true },
  batches: { create: true, update: true, delete: true },
  stockIn: { create: true, update: true, delete: true },
  daily: { create: true, update: true, delete: true },
  lossRecords: { create: true, update: true, delete: true },
  customers: { create: true, update: true, delete: true },
  orders: { create: true, update: true, delete: true },
  accounts: { create: true, update: true, delete: true },
});

export const emptyPermissions = (): PermissionSet => ({
  species: { create: false, update: false, delete: false },
  products: { create: false, update: false, delete: false },
  tankGroups: { create: false, update: false, delete: false },
  batches: { create: false, update: false, delete: false },
  stockIn: { create: false, update: false, delete: false },
  daily: { create: false, update: false, delete: false },
  lossRecords: { create: false, update: false, delete: false },
  customers: { create: false, update: false, delete: false },
  orders: { create: false, update: false, delete: false },
  accounts: { create: false, update: false, delete: false },
});

export const initialState: Store = {
  user: null,
  systemSettings: {
    fishListFooterText: DEFAULT_FISH_LIST_FOOTER_TEXT,
  },
  sites: [
    { id: "jiangyin", name: "江阴" },
    { id: "nanjing", name: "南京" },
    { id: "beijing", name: "北京" },
  ],
  personnel: [
    { id: "person-admin", name: "admin", username: "admin", password: "", accessRole: "admin", permissions: fullPermissions(), employmentStatus: "active", role: "管理员", phone: "", notes: "系统默认管理员账户" },
    { id: "person-staff", name: "staff", username: "staff", password: "", accessRole: "staff", permissions: fullPermissions(), employmentStatus: "active", role: "店员", phone: "", notes: "系统默认店员账户" },
    { id: "person-a", name: "店员A", username: "staff-a", password: "", accessRole: "staff", permissions: fullPermissions(), employmentStatus: "active", role: "养护", phone: "", notes: "" },
  ],
  operationLogs: [],
  speciesCategories: [
    "刺尾鱼科", "雀鲷科", "蝴蝶鱼科", "神仙鱼科", "隆头鱼科",
    "鳞鲀科", "炮弹鱼科", "虾虎鱼科", "海马科", "狮子鱼科",
    "石斑鱼科", "笛鲷科", "鲈科",
  ],
  productOrigins: [
    "印尼", "菲律宾", "马来西亚", "斯里兰卡", "夏威夷",
    "澳大利亚", "马尔代夫", "红海", "坦桑尼亚", "巴西",
    "人工繁殖", "国内养殖",
  ],
  customerSources: ["抖音", "微信", "线下", "鱼友介绍"],
  species: [
    { id: "s1", name: "小丑鱼", scientificName: "Amphiprioninae", category: "雀鲷科", commonNames: ["公子小丑", "尼莫"], description: "常见入门海水鱼", imageUrl: "https://images.unsplash.com/photo-1535591273668-578e31182c4f?w=200" },
    { id: "s2", name: "蓝倒吊", scientificName: "Paracanthurus hepatus", category: "刺尾鱼科", commonNames: ["蓝唐王鱼", "多利"], description: "需大缸饲养", imageUrl: "https://images.unsplash.com/photo-1524704654690-b56c05c78a00?w=200" },
    { id: "s3", name: "黄金吊", scientificName: "Zebrasoma flavescens", category: "刺尾鱼科", commonNames: ["黄三角吊"], description: "鲜艳的黄色", imageUrl: "https://images.unsplash.com/photo-1583212292454-1fe6229603b7?w=200" },
  ],
  products: [
    { id: "p1", speciesId: "s1", name: "公子小丑(M)", size: "M", origin: "印尼", imageUrl: "https://images.unsplash.com/photo-1535591273668-578e31182c4f?w=200", defaultPrice: 80, minReturnPrice: 0, publicVisible: true, commissionRate: 0, notes: "" },
    { id: "p2", speciesId: "s2", name: "蓝倒吊(S)", size: "S", origin: "菲律宾", imageUrl: "https://images.unsplash.com/photo-1524704654690-b56c05c78a00?w=200", defaultPrice: 280, minReturnPrice: 0, publicVisible: true, commissionRate: 0, notes: "" },
    { id: "p3", speciesId: "s3", name: "黄金吊(M)", size: "M", origin: "夏威夷", imageUrl: "https://images.unsplash.com/photo-1583212292454-1fe6229603b7?w=200", defaultPrice: 350, minReturnPrice: 0, publicVisible: true, commissionRate: 0, notes: "" },
  ],
  tankGroups: [
    {
      id: "g1",
      siteId: "nanjing",
      name: "A组主缸",
      location: "前厅左侧",
      rows: 2,
      cols: 2,
      subTanks: [
        { id: "t1", name: "A-1", row: 0, col: 0 },
        { id: "t2", name: "A-2", row: 0, col: 1 },
        { id: "t3", name: "A-3", row: 1, col: 0 },
        { id: "t4", name: "A-4", row: 1, col: 1 },
      ],
    },
    {
      id: "g2",
      siteId: "nanjing",
      name: "B组隔离缸",
      location: "后厅",
      rows: 1,
      cols: 2,
      subTanks: [
        { id: "t5", name: "B-1", row: 0, col: 0 },
        { id: "t6", name: "B-2", row: 0, col: 1 },
      ],
    },
  ],
  batches: [
    { id: "b1", siteId: "nanjing", batchNo: "PO-2026-001", supplier: "海洋之星水族", arrivalDate: "2026-04-10", bioFee: 5200, shippingFee: 600, stockedCount: 3, lossCount: 0, lossProof: [], commissionMultiplier: 100, notes: "首批春季货" },
    { id: "b2", siteId: "nanjing", batchNo: "PO-2026-002", supplier: "蓝海贸易", arrivalDate: "2026-04-20", bioFee: 2800, shippingFee: 400, stockedCount: 3, lossCount: 0, lossProof: [], commissionMultiplier: 100, notes: "" },
  ],
  stock: [
    { id: "i1", siteId: "nanjing", productId: "p1", batchId: "b1", subTankId: "t1", status: "healthy", inDate: "2026-04-11", basePrice: 60, notes: "" },
    { id: "i2", siteId: "nanjing", productId: "p1", batchId: "b1", subTankId: "t1", status: "feeding", inDate: "2026-04-11", basePrice: 60, notes: "已开口" },
    { id: "i3", siteId: "nanjing", productId: "p2", batchId: "b1", subTankId: "t2", status: "sick", inDate: "2026-04-11", basePrice: 220, notes: "白点观察" },
    { id: "i4", siteId: "nanjing", productId: "p3", batchId: "b2", subTankId: "t3", status: "healthy", inDate: "2026-04-21", basePrice: 280, notes: "" },
    { id: "i5", siteId: "nanjing", productId: "p3", batchId: "b2", subTankId: "t3", status: "healthy", sold: true, inDate: "2026-04-21", basePrice: 280, notes: "" },
    { id: "i6", siteId: "nanjing", productId: "p2", batchId: "b2", subTankId: "t5", status: "healthy", inDate: "2026-04-21", basePrice: 220, notes: "" },
  ],
  lossRecords: [],
  logs: [
    { id: "l1", siteId: "nanjing", date: "2026-04-25", subTankId: "t1", action: "投喂", operator: "店员A", notes: "丰年虾" },
    { id: "l2", siteId: "nanjing", date: "2026-04-25", subTankId: "t2", action: "换水", operator: "店员A", notes: "20%" },
  ],
  checks: [
    { id: "c1", siteId: "nanjing", date: "2026-04-24", subTankId: "t1", systemCount: 2, actualCount: 2, diff: 0, operator: "管理员", notes: "" },
  ],
  bioRecords: [
    { id: "br1", siteId: "nanjing", stockItemId: "i1", date: "2026-04-13", text: "入缸适应良好，开始摄食冰冻丰年虾", photos: [] },
    { id: "br2", siteId: "nanjing", stockItemId: "i1", date: "2026-04-18", text: "与配鱼关系融洽，体色鲜艳，已正常进食颗粒料", photos: [] },
    { id: "br3", siteId: "nanjing", stockItemId: "i3", date: "2026-04-12", text: "发现白点症状，已转移至隔离缸，开始下药治疗", photos: [] },
    { id: "br4", siteId: "nanjing", stockItemId: "i5", date: "2026-04-21", text: "入缸状态良好", photos: [] },
  ],
  orders: [
    {
      id: "o1",
      siteId: "nanjing",
      orderNo: "SO-2026-001",
      customerId: "c1",
      date: "2026-04-22",
      source: "线下",
      plannedShipDate: "2026-04-25",
      contactPerson: "admin",
      items: [{ stockItemId: "i5", productId: "p3", price: 350, minReturnPrice: 0, commissionRate: 0 }],
      shippingFee: 25,
      packagingFee: 15,
      discount: 0,
      status: "shipped",
      notes: "买家要求充氧打包",
      payments: [
        { id: "pay1", time: "2026-04-22T10:00", type: "deposit", amount: 200, proof: [], notes: "微信转账定金" },
        { id: "pay2", time: "2026-04-23T15:30", type: "balance", amount: 190, proof: [], notes: "支付尾款" },
      ],
    },
  ],
  shipments: [
    {
      id: "sh1",
      siteId: "nanjing",
      orderId: "o1",
      shipDate: "2026-04-23",
      carrier: "顺丰速运",
      trackingNo: "SF1234567890",
      status: "shipped",
      notes: "",
      shipMethod: "express",
      actualShippingFee: 25,
      itemStockIds: ["i5"],
    },
  ],
  customers: [
    {
      id: "c1",
      name: "李四",
      customerType: "C",
      addedDate: "2026-04-20",
      phone: "13900139001",
      wechat: "lisi123",
      douyin: "lisi_douyin",
      source: "微信",
      address: "北京市朝阳区",
      notes: "长期客户",
    },
  ],
};

// StoreContext uses initialState as default so components render safely in isolation
export const StoreContext = createContext<StoreContextType>({
  state: initialState,
  activeSiteId: "nanjing",
  setActiveSiteId: () => {},
  setState: () => {},
  savePatch: async () => false,
  saveProduct: async () => false,
  saveStockChange: async () => ({ ok: false }),
  saveMaintenanceAction: async () => false,
  saveTankGroupChange: async () => false,
  saveDailyLog: async () => false,
  saveShipmentOutbound: async () => false,
  saveOrderPaymentChange: async () => false,
  savePersonnelAccount: async () => false,
  resignPersonnelAccount: async () => false,
  deletePersonnelAccount: async () => false,
  savePersonnelPermissions: async () => false,
  changePersonnelPassword: async () => false,
  saveStateTransform: async () => false,
});

export const useStore = () => useContext(StoreContext);
