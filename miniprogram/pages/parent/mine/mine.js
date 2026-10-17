const parentApi = require("../../../utils/parent-api");

// 「我的」tabBar 页面：展示家长基础资料 + 入口集合。
// 数据来源统一走 parentApi.login()（家长静默登录云函数），与首页保持同一口径。
Page({
  data: {
    loading: true,
    profile: null,
    latestRequest: null,
  },

  onShow() {
    this.bootstrap();
  },

  async bootstrap() {
    this.setData({ loading: true });
    try {
      const result = await parentApi.login();
      const parent = result.parent || null;
      const latestRequest = result.latestRequest || null;
      this.setData({
        loading: false,
        profile: parent,
        latestRequest,
      });
    } catch (error) {
      this.setData({ loading: false });
      this.showError(error, "加载失败，请稍后重试");
    }
  },

  // 跳约课填写页：直接切 tab，不带 modifyCourseId（即走"新建"路径）。
  goParentAdd() {
    wx.switchTab({
      url: "/pages/index/parent_add/parent_add",
    });
  },

  // 跳上课信息 tab
  goClassShow() {
    wx.switchTab({
      url: "/pages/index/parent_classshow/parent_classshow",
    });
  },

  // 联系客服：拉起微信客服会话（小程序原生能力）
  contactSupport() {
    if (wx.openCustomerServiceChat) {
      wx.openCustomerServiceChat({
        extInfo: { url: "" },
        fail: () => {
          wx.showToast({ title: "暂未配置客服", icon: "none" });
        },
      });
      return;
    }
    wx.showToast({ title: "请通过分享卡片联系教练", icon: "none" });
  },

  showError(error, fallbackText) {
    const message = (error && (error.message || error.errMsg)) || fallbackText;
    wx.showToast({
      title: message,
      icon: "none",
    });
  },

  // 页面级开启分享入口：转发给好友 + 分享到朋友圈
  onLoad() {
    if (wx.showShareMenu) {
      wx.showShareMenu({
        withShareTicket: true,
        menus: ["shareAppMessage", "shareTimeline"],
      });
    }
  },

  onShareAppMessage() {
    const app = getApp();
    const share = (app && app.globalData && app.globalData.share) || {};
    return {
      title: share.title || "家长约课登记 - 约课登记小程序",
      path: "/pages/index_firstpage/index_firstpage",
    };
  },

  onShareTimeline() {
    const app = getApp();
    const share = (app && app.globalData && app.globalData.share) || {};
    return {
      title: share.title || "家长约课登记 - 约课登记小程序",
    };
  },
});
