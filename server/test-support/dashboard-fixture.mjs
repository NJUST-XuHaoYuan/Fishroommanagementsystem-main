import { scryptSync } from "node:crypto";

export const TEST_PASSWORD = "dashboard-route-test-password";
export const CHINA_TODAY = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
const salt = "dashboard-route-test-salt";
const password = `scrypt$1$${salt}$${scryptSync(TEST_PASSWORD, salt, 32).toString("base64url")}`;
const accounts = ["admin", "staff"].map((accessRole) => ({
  id: `dashboard-${accessRole}`,
  name: `Dashboard ${accessRole}`,
  username: `dashboard-${accessRole}`,
  password,
  accessRole,
  accountEnabled: true,
  employmentStatus: "active",
  sessionVersion: 0,
  visibleSiteIds: ["nanjing", "jiangyin"],
  permissions: Object.fromEntries(["orders", "finance", "daily"].map((key) => [
    key, { create: true, update: true, delete: true },
  ])),
}));
const order = (id, date, contactPerson, price) => ({
  id, orderNo: id, date, contactPerson, siteId: "nanjing", source: "私域线上",
  status: "completed", items: [{ productId: "p1", stockItemId: id, price }],
});
export const databaseFixture = {
  revision: 101,
  state: {
    _siteSchemaVersion: 4,
    _personnelSchemaVersion: 3,
    sites: [{ id: "nanjing", name: "南京" }, { id: "jiangyin", name: "江阴" }],
    personnel: [...accounts, ...Array.from({ length: 7 }, (_, index) => ({
      id: `seller-${index}`, name: `销售${index}`, employmentStatus: "active", accountEnabled: false,
    }))],
    personnelProfileRequests: [], personnelPrivateAttachments: [], retiredPersonnelUsernames: [],
    species: [{ id: "s1", name: "黄金吊", category: "刺尾鱼科" }],
    products: [{ id: "p1", speciesId: "s1", name: "黄金吊", defaultPrice: 100 }],
    tankGroups: [
      { id: "group-nj", siteId: "nanjing", name: "南京缸", subTanks: [{ id: "tank-nj", name: "N1" }] },
      { id: "group-jy", siteId: "jiangyin", name: "江阴缸", subTanks: [{ id: "tank-jy", name: "J1" }] },
    ],
    stock: [
      { id: "lost-nj", productId: "p1", siteId: "jiangyin", subTankId: "tank-jy", inDate: "2026-08-01", lost: true, lossDate: "2026-09-01" },
      { id: "lost-jy", productId: "p1", siteId: "jiangyin", subTankId: "tank-jy", inDate: "2026-08-01", lost: true, lossDate: "2026-09-01" },
      { id: "lost-legacy-nj", productId: "p1", siteId: "nanjing", subTankId: "tank-nj", inDate: "2026-08-01", lost: true, lossDate: "2026-09-02" },
    ],
    lossRecords: [
      { id: "loss-nj", stockItemId: "lost-nj", siteId: "nanjing", subTankId: "tank-nj", tankName: "历史南京缸 / N1", date: "2026-09-01" },
      { id: "loss-jy", stockItemId: "lost-jy", siteId: "jiangyin", subTankId: "tank-jy", date: "2026-09-01" },
    ],
    orders: [
      order("before-range", "2026-08-31", "销售0", 1_000_000),
      ...Array.from({ length: 6 }, (_, index) => order(`start-${index}`, "2026-09-01", `销售${index + 1}`, (index + 1) * 100)),
      { ...order("end-range", "2026-09-02", "销售1", 650), payments: [{ type: "balance", amount: 100, time: "2026-09-02", verificationStatus: "verified" }] },
      { ...order("after-range", "2026-09-03", "销售0", 1_000_000), payments: [{ type: "balance", amount: 987, time: CHINA_TODAY, verificationStatus: "verified" }] },
    ],
    shipments: [], batches: [], customers: [], logs: [], bioRecords: [], waterQualityRecords: [], systemSettings: {},
  },
};
