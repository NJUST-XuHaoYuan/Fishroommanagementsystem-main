Page({
  onPrivacyContractTap() {
    wx.openPrivacyContract({ fail() { wx.showToast({ title: "平台隐私指引暂不可用", icon: "none" }); } });
  }
});
