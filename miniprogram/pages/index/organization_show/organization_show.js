const parentApi = require("../../../utils/parent-api");

// 机构展示页（2026-09-05 改版）：
// 默认空，只有家长完成填写并绑定识别码后，才展示对应机构 / 自由教练信息。
// 页面按四个区块渲染：
//   1) 品牌区：机构 logo + 机构名称 + 一句品牌定位 + 机构/自由教练标签；
//   2) 轮播图：A 侧推送、已转存到 B 侧云存储的品牌轮播图，无图时展示空白态；
//   3) 基本信息：机构简介 / 核心服务 / 服务区域 / 适合谁 / 教练理念 + 城市地址联系人，空值行整行隐藏；
//   4) 教练信息：机构成员（头像 / 昵称 / 角色），自由教练降级展示对接教练姓名。
// 数据来源：login 拿到绑定目标（targetCard）→ 用 organizationId / entryId 调
// DLforP_entry_qrcode/get_org_show 拉 dev_forPshowC 完整展示文档（orgShow）；
// orgShow 为空（自由教练 / 机构还没推送 / 请求失败）时降级用 targetCard 基础字段展示，不报错、不弹提示。
// 路径拼接 / 识别码规范化统一收口到 utils/parent-api.js，全端页面共用一份，不再在本页拷贝。
const buildParentAddPath = parentApi.buildParentAddPath;
const normalizeInviteCode = parentApi.normalizeInviteCode;

Page({
  data: {
    loading: true,
    targetCard: null,
    latestRequest: null,
    // A→B 同步的完整机构展示文档（show_basic / images / members），null 时页面降级用 targetCard。
    orgShow: null,
    // 区块一：品牌区视图模型
    brand: {
      name: "",
      slogan: "",
      tagText: "",
      logoFileId: "",
    },
    // 区块二：轮播图（B 侧云存储 fileID 数组，由 orgShow.images.swiper 提取）
    swiperImages: [],
    // 区块三：基本信息行 [{ label, value }]，空值行已过滤，无内容时整块隐藏
    infoRows: [],
    // 区块四：教练 / 机构成员 [{ name, roleText, avatarFileId }]，无内容时整块隐藏
    coaches: [],
  },

  onShow() {
    this.loadData();
  },

  async loadData() {
    this.setData({ loading: true });
    try {
      const result = await parentApi.login();
      const latestRequest = result.latestRequest || null;
      const targetCard =
        (latestRequest && latestRequest.targetSnapshot) ||
        (result.parent && result.parent.targetSnapshot) ||
        null;

      this.setData({
        loading: false,
        targetCard,
        latestRequest,
      });

      // 绑定目标存在后，异步拉取完整机构展示文档；失败 / 无文档都不阻断页面，降级用 targetCard。
      if (targetCard) {
        await this.loadOrgShow(targetCard, latestRequest);
      }
    } catch (error) {
      this.setData({ loading: false });
      this.showError(error, "加载失败，请稍后重试");
    }
  },

  // 拉取 dev_forPshowC 完整机构展示文档并组装四个区块的视图模型。
  // key 来源优先级：
  //   1) 提交约课时落库的扫码入口上下文（latestRequest.entryContext：entryId / 机构入口 targetId=organizationId）；
  //   2) 识别码目标快照里 A 侧透传的 organizationId / entryId（新链路 / 缓存自愈后会有）；
  //   3) 两个 key 都没有但 inviteCode 在手：重新走一次 resolveInvite，
  //      云函数侧遇到旧缓存（缺 organizationId 的机构目标）会自动回 A 侧重取并回写缓存完成自愈。
  async loadOrgShow(targetCard, latestRequest) {
    let organizationId = "";
    let entryId = "";

    // 1) 扫码提交约课落库的入口上下文。
    const entryContext = (latestRequest && latestRequest.entryContext) || null;
    if (entryContext) {
      entryId = entryContext.entryId || "";
      if (entryContext.targetType === "organization") {
        organizationId = entryContext.targetId || "";
      }
    }

    // 2) 识别码目标快照里 A 侧透传的字段。
    organizationId = organizationId || targetCard.organizationId || "";
    entryId = entryId || targetCard.entryId || "";

    // 3) 旧数据兜底：两个 key 都没有但有识别码，重新识别一次触发云函数缓存自愈。
    if (!organizationId && !entryId && targetCard.inviteCode) {
      try {
        const resolveResult = await parentApi.resolveInvite(targetCard.inviteCode);
        const freshTarget = (resolveResult && resolveResult.target) || null;
        if (freshTarget) {
          organizationId = freshTarget.organizationId || "";
          entryId = freshTarget.entryId || "";
        }
      } catch (error) {
        // 重新识别失败不阻断：页面用 targetCard 基础字段降级展示。
        console.warn("[organization_show][WARN] resolveInvite.refresh_fail", {
          message: (error && (error.message || error.errMsg)) || String(error || ""),
        });
      }
    }

    if (!organizationId && !entryId) {
      // 自由教练 / 旧数据且识别码也反查不到：直接用 targetCard 组装基础展示。
      this.applyViewModel(null);
      return;
    }

    try {
      const showResult = await parentApi.getOrgShow({ organizationId, entryId });
      const orgShow = (showResult && showResult.orgShow) || null;
      this.setData({ orgShow });
      this.applyViewModel(orgShow);
    } catch (error) {
      // 云函数失败 / 文档不存在：降级基础展示，只打日志不弹错误（页面主体仍可用）。
      console.warn("[organization_show][WARN] getOrgShow.fail", {
        organizationId,
        entryId,
        message: (error && (error.message || error.errMsg)) || String(error || ""),
      });
      this.applyViewModel(null);
    }
  },

  // 把 orgShow + targetCard 合并成模板直接消费的视图模型；orgShow 为 null 时只用 targetCard。
  applyViewModel(orgShow) {
    const targetCard = this.data.targetCard || {};
    const basic = (orgShow && orgShow.show_basic) || {};
    const images = (orgShow && orgShow.images) || {};
    const members = orgShow && Array.isArray(orgShow.members) ? orgShow.members : [];

    // 区块一：品牌区。品牌名优先用机构展示文档，缺省回退绑定目标名；slogan 未推送时不渲染副标题。
    const name = basic.organization_name || targetCard.displayName || "";
    const slogan = basic.brand_slogan || "";
    const tagText = targetCard.targetType === "org" ? "机构" : "自由教练";
    const logoFileId = (images.logo && images.logo.file_id) || "";

    // 区块二：轮播图，只取转存到 B 侧云存储成功的 fileID。
    const swiperImages = (Array.isArray(images.swiper) ? images.swiper : [])
      .map((item) => (item && item.file_id) || "")
      .filter(Boolean);

    // 区块三：基本信息固定顺序，所有行保持显示（调整 2026-09-05：不再隐藏空值行，
    // 空值统一展示「暂无」占位；九项在 A 侧机构创建/编辑表单里全部必填，老数据才会出现暂无）。
    const PLACEHOLDER = "暂无";
    const rowCandidates = [
      { label: "机构简介", value: basic.intro || targetCard.description || "" },
      { label: "核心服务", value: basic.core_services || "" },
      { label: "服务区域", value: basic.service_area || "" },
      { label: "适合谁", value: basic.target_audience || "" },
      { label: "教练理念", value: basic.coaching_philosophy || "" },
      { label: "所在城市", value: basic.city || "" },
      { label: "机构地址", value: basic.address || "" },
      { label: "联系人", value: basic.contact_name || "" },
      { label: "联系电话", value: basic.contact_phone || "" },
    ];
    const infoRows = rowCandidates.map((row) => ({
      label: row.label,
      value: String(row.value || "").trim() || PLACEHOLDER,
    }));

    // 区块四：教练信息。机构成员（admin 展示为管理层，其余为教练）；
    // 新增（2026-09-06）：成员具体身份 staff_role（主教/副教练/自填文本，A 侧推送的中文文案）优先展示，
    // 老文档无此字段或为空时回退「管理层/教练」泛化角色。
    // 没有成员数据（自由教练 / 机构未推送成员）时，降级用绑定目标里的对接教练姓名兜一个卡片。
    let coaches = members.map((member) => ({
      name: member.name || "教练",
      roleText:
        (member.staff_role && String(member.staff_role).trim()) ||
        (member.role === "admin" ? "管理层" : "教练"),
      avatarFileId: (member.avatar && member.avatar.file_id) || "",
    }));
    if (!coaches.length) {
      const fallbackCoachName =
        targetCard.coachName ||
        (targetCard.targetType !== "org" ? targetCard.displayName : "") ||
        "";
      if (fallbackCoachName) {
        coaches = [{ name: fallbackCoachName, roleText: "对接教练", avatarFileId: "" }];
      }
    }

    this.setData({
      brand: { name, slogan, tagText, logoFileId },
      swiperImages,
      infoRows,
      coaches,
    });
  },

  goParentAdd() {
    const inviteCode =
      (this.data.targetCard && this.data.targetCard.inviteCode) ||
      (this.data.latestRequest && this.data.latestRequest.inviteCode) ||
      "";
    // 调整（带 id 修改，2026-10-13）：parent_add 已是 tabBar 页面，wx.navigateTo 不能跳 tabBar，
    // 改用 wx.switchTab；识别码通过 globalData.routeInviteCode 透传，
    // parent_add onShow 会兜底读取并清空。
    const app = getApp();
    if (app && app.globalData) {
      app.globalData.routeInviteCode = parentApi.normalizeInviteCode(inviteCode);
    }
    wx.switchTab({
      url: "/pages/index/parent_add/parent_add",
      fail: () => {
        // 兜底：极少数基础库在 tabBar 还未注册时 switchTab 失败，回落 navigateTo 走 url 透传。
        wx.navigateTo({ url: buildParentAddPath(inviteCode) });
      },
    });
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

  // 右上角「分享给好友」/ open-type="share" 按钮触发
  onShareAppMessage() {
    const app = getApp();
    const share = (app && app.globalData && app.globalData.share) || {};
    const inviteCode =
      (this.data.targetCard && this.data.targetCard.inviteCode) ||
      (this.data.latestRequest && this.data.latestRequest.inviteCode) ||
      "";
    return {
      title: share.title || "家长约课登记 - 机构/教练信息",
      path: buildParentAddPath(inviteCode),
    };
  },

  // 右上角「分享到朋友圈」触发
  onShareTimeline() {
    const app = getApp();
    const share = (app && app.globalData && app.globalData.share) || {};
    const inviteCode =
      (this.data.targetCard && this.data.targetCard.inviteCode) ||
      (this.data.latestRequest && this.data.latestRequest.inviteCode) ||
      "";
    const normalizedInviteCode = normalizeInviteCode(inviteCode);
    return {
      title: share.title || "家长约课登记 - 机构/教练信息",
      query: normalizedInviteCode ? `inviteCode=${encodeURIComponent(normalizedInviteCode)}` : "",
    };
  },
});
