// app.js
App({
  onLaunch: function () {
    // 云开发环境ID：用户提供的实际云环境
    // 切换环境：修改 env 常量即可，可选值：
    //   cloud1-6gh7jgl8c5b16a83 (原环境)
    //   dl2-d1g4cmi4j6d336bb1 (之前使用)
    //   cloud1-d7g77k8il914e5b12 (当前使用)
    const env = "cloud1-d7g77k8il914e5b12";
    this.globalData = {
      // env 参数说明：
      // env 参数决定接下来小程序发起的云开发调用（wx.cloud.xxx）会请求到哪个云环境的资源
      // 此处请填入环境 ID, 环境 ID 可在微信开发者工具右上顶部工具栏点击云开发按钮打开获取
      env,
      // 全局分享默认配置（供各页面 onShare* 回调读取，避免重复硬编码）
      share: {
        title: "家长约课登记 - 约课登记小程序",
        path: "/pages/index_firstpage/index_firstpage",
      },
    };
    if (!wx.cloud) {
      console.error("请使用 2.2.3 或以上的基础库以使用云能力");
    } else {
      wx.cloud.init({
        // 这里允许先留空，开发者工具里选择默认云环境后也能直接调试这个小项目。
        env: this.globalData.env || undefined,
        traceUser: true,
      });
    }

    // 全局开启右上角分享菜单（转发好友 + 分享到朋友圈），携带 withShareTicket 以便获取群分享数据
    // 说明：wx.showShareMenu 需要页面上下文，全局在此调用一次做兜底；
    // 每个页面仍需声明 onShareAppMessage / onShareTimeline 后，菜单中才会出现对应入口
    if (wx.showShareMenu && typeof wx.showShareMenu === "function") {
      try {
        wx.showShareMenu({
          withShareTicket: true,
          menus: ["shareAppMessage", "shareTimeline"],
        });
      } catch (e) {
        // 基础库版本差异可能导致 menus 参数不被识别，静默失败，页面级回调已保证入口可用
      }
    }
  },
});
