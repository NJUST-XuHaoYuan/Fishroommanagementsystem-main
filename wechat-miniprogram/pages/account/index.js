const auth = require("../../utils/customer-auth");
const { returnToParent } = require("../../utils/navigation");

Page({
  data: { customer: null, checking: true, busy: false, accepted: false, error: "" },
  onShow() { this.refreshAccount(); },
  onBackTap() { returnToParent("pages/catalog/index"); },
  async refreshAccount() {
    if (this.data.busy) return;
    this.setData({ checking: true, error: "" });
    try { this.setData({ customer: await auth.currentCustomer() }); }
    catch (error) { this.setData({ customer: null, error: error.status === 401 ? "登录已过期，请重新登录" : error.message }); }
    finally { this.setData({ checking: false }); }
  },
  onConsentChange(event) { this.setData({ accepted: event.detail.value.includes("privacy") }); },
  onPrivacyTap() { wx.navigateTo({ url: "/pages/privacy/index" }); },
  onCopyServiceAccount() { wx.setClipboardData({ data: "marineforest2024" }); },
  async onLoginTap() {
    if (this.data.busy || this.data.checking) return;
    this.setData({ busy: true, error: "" });
    try { this.setData({ customer: await auth.login(this.data.accepted) }); }
    catch (error) { this.setData({ error: error.message }); }
    finally { this.setData({ busy: false }); }
  },
  onLogoutTap() { this.confirmEndSession(false); },
  onDeleteTap() { this.confirmEndSession(true); },
  confirmEndSession(deleting) {
    if (this.data.busy || this.data.checking) return;
    wx.showModal({
      title: deleting ? "注销账号？" : "退出登录？",
      content: deleting ? "将删除本小程序的访客账号并退出所有设备。微信客服会话不会被删除。注销后仍可浏览鱼单。" : "退出后仍可浏览鱼单和咨询客服。",
      confirmText: deleting ? "确认注销" : "退出登录",
      confirmColor: deleting ? "#b43232" : "#07544e",
      success: async (result) => {
        if (!result.confirm || this.data.busy) return;
        this.setData({ busy: true, error: "" });
        try {
          await auth.endSession(deleting);
          this.setData({ customer: null, accepted: false });
        } catch (error) { this.setData({ error: error.message }); }
        finally { this.setData({ busy: false }); }
      }
    });
  }
});
