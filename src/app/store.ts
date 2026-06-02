import { createContext, useContext } from "react";

export type Role = "admin" | "staff";

export type User = { username: string; role: Role } | null;

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
  /** 销售提成比例，单位为百分比，例如 5 表示 5%。 */
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
  /** 批次提成系数，单位为百分比。100 表示按商品默认提成，0 表示本批次无提成，200 表示翻倍。 */
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
  /** 这条鱼下单时默认带出的提成比例，单位为百分比。 */
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

export type OrderItem = {
  stockItemId: string;
  productId: string;
  price: number;
  /** 下单时固化的提成比例，单位为百分比。 */
  commissionRate?: number;
  plannedShipDate?: string;
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

export type Customer = {
  id: string;
  name: string;
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
  permissions?: PermissionSet;
  role: string;
  phone: string;
  notes: string;
};

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

export type Store = {
  user: User;
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
  saveStockChange: (change: { upsert?: StockItem[]; deleteIds?: string[] }) => Promise<boolean>;
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
  savePersonnelAccount: (personnel: Personnel) => Promise<boolean>;
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
  sites: [
    { id: "jiangyin", name: "江阴" },
    { id: "nanjing", name: "南京" },
  ],
  personnel: [
    { id: "person-admin", name: "admin", username: "admin", password: "", accessRole: "admin", permissions: fullPermissions(), role: "管理员", phone: "", notes: "系统默认管理员账户" },
    { id: "person-staff", name: "staff", username: "staff", password: "", accessRole: "staff", permissions: fullPermissions(), role: "店员", phone: "", notes: "系统默认店员账户" },
    { id: "person-a", name: "店员A", username: "staff-a", password: "", accessRole: "staff", permissions: fullPermissions(), role: "养护", phone: "", notes: "" },
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
    { id: "p1", speciesId: "s1", name: "公子小丑(M)", size: "M", origin: "印尼", imageUrl: "https://images.unsplash.com/photo-1535591273668-578e31182c4f?w=200", defaultPrice: 80, commissionRate: 0, notes: "" },
    { id: "p2", speciesId: "s2", name: "蓝倒吊(S)", size: "S", origin: "菲律宾", imageUrl: "https://images.unsplash.com/photo-1524704654690-b56c05c78a00?w=200", defaultPrice: 280, commissionRate: 0, notes: "" },
    { id: "p3", speciesId: "s3", name: "黄金吊(M)", size: "M", origin: "夏威夷", imageUrl: "https://images.unsplash.com/photo-1583212292454-1fe6229603b7?w=200", defaultPrice: 350, commissionRate: 0, notes: "" },
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
      plannedShipDate: "2026-04-25",
      contactPerson: "admin",
      items: [{ stockItemId: "i5", productId: "p3", price: 350, commissionRate: 0 }],
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
  saveStockChange: async () => false,
  saveMaintenanceAction: async () => false,
  saveTankGroupChange: async () => false,
  saveDailyLog: async () => false,
  saveShipmentOutbound: async () => false,
  savePersonnelAccount: async () => false,
  deletePersonnelAccount: async () => false,
  savePersonnelPermissions: async () => false,
  changePersonnelPassword: async () => false,
  saveStateTransform: async () => false,
});

export const useStore = () => useContext(StoreContext);
