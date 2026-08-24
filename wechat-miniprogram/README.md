# 海水生物鱼单微信小程序

这是原鱼单网站的原生微信小程序版本，复用现有后端公开接口：

- `GET /api/public/catalog`
- `GET /api/public/bio-records?stockItemId=...`

## 当前发布配置

- 小程序 AppID：`wxcf900cefaee1432b`
- 正式接口：`https://www.marineforest.com.cn`
- `request` 合法域名：`https://www.marineforest.com.cn`
- `downloadFile` 合法域名：`https://www.marineforest.com.cn`、`https://cdn.aquaml.com`
- 开发者工具本地私有配置不提交到 Git；正式预览前应开启合法域名校验。

公开鱼单快照可在仓库根目录更新。生成器会同步读取每条公开库存的维护记录，因此需要等待几分钟：

```bash
node scripts/generate-wechat-fallback.mjs
```

小程序优先请求实时接口；内置快照仅在实时接口临时不可用时降级展示。

## 导入与调试

1. 在微信开发者工具中导入 `wechat-miniprogram` 目录。
2. 选择“公开目录”编译模式查看四个大类及其小类。
3. 点击小类进入商品页，点击商品进入可选个体，再点击个体进入详情页。
4. “小类商品”“可选个体”和“个体详情”编译模式可用于直接调试后三层页面。

## 正式发布前

1. 确认正式 HTTPS 接口、目录接口和维护记录接口可用。
2. 在微信公众平台配置上述 `request` 和 `downloadFile` 合法域名。
3. 在开发者工具中开启合法域名校验并完成真机预览。
4. 上传稳定版本，设置体验版并测试后提交审核。

微信小程序正式环境不支持裸 IP 和 HTTP 图片地址。内置快照只用于接口故障时兜底，不会自动同步后台库存变化。

## 页面

- `pages/catalog/index`：四个固定大类及其小类目录。
- `pages/products/index`：当前小类的商品搜索与选择。
- `pages/specimens/index`：当前商品的在售个体与状态筛选，并兼容旧品种链接。
- `pages/detail/index`：个体详情、选鱼码、维护时间轴。

小程序只展示公开目录数据，不读取客户、订单、成本、员工、权限等后台私有信息。
