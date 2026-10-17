const parentApi = require("../../utils/parent-api");

// 主页面：
// 第一个 view 进入家长约课表单页。
// 第二个 view 进入机构展示页，默认空，填写完成后展示绑定对象信息。
// 首页也统一走带识别码参数的路径，避免“首页进去有识别码，二跳后又丢了”的情况。
// 路径拼接 / 识别码规范化统一收口到 utils/parent-api.js，全端页面共用一份，不再在本页拷贝。
const buildParentAddPath = parentApi.buildParentAddPath;
const normalizeInviteCode = parentApi.normalizeInviteCode;

// 新增：机构展示区默认数据，整体抄自 A 侧 pages/organization/organization 的 organization_show 默认值；
// B 侧家长首页拿不到 A 侧机构资料接口，未绑定时直接按这套默认内容展示，和 A 侧未加载到机构数据时的兜底表现一致
// 再次同步（2026-09-05）：A 侧 organization.js 默认值已更新为「代码肌 · 跃动邻」版本，这里逐字对齐，禁止再回退旧版「星耀体育训练中心」文案
const DEFAULT_ORGANIZATION_PROFILE = {
  organizationName: '代码肌 · 跃动邻',
  slogan: '用代码连接体育，让专业能力被看见'
};
// 同步（2026-09-05）：A 侧 organization_show 简介卡已改为 4 行（核心服务 / 服务区域 / 适合谁 / 教练理念），
// 「成立时间」行非必要已移除（A 侧创建表单未收集 established_year），这里同步保持两端默认展示一致；
// 再次同步（2026-09-05）：4 行默认文案与 label 一并按 A 侧 DEFAULT_INTRO_INFO_LIST 最新版本逐字对齐（第 3/4 行 label 变为 适合群体 / 品牌理念）
const DEFAULT_INTRO_INFO_LIST = [
  { label: '核心服务：', value: '体育数字化工具、教练服务连接、机构展示' },
  { label: '服务区域：', value: '不只深圳南山，软件链接万物' },
  { label: '适合群体：', value: '体育教练、体育机构及有运动服务需求的用户' },
  { label: '品牌理念：', value: '用代码提升体育服务效率，让专业更容易被看见' }
];
// 新增（2026-09-15）：B 侧团队成员头像兜底 URL。
// 真实教练没传头像（NDLdev_users.avatarUrl 为空 → dev_forPshowC.members[].avatar.file_id 为空）时，
// os-team-avatar 不再退回红底首字文字，统一兜底为 B 侧云存储官方默认男头像，保证头像位永远有图。
// 该图已上传至 B 侧 cloud1-d7g77k8il914e5b12 云存储 page_default_image/index/avatar/ 路径下。
const DEFAULT_TEAM_AVATAR_URL = 'cloud://cloud1-d7g77k8il914e5b12.636c-cloud1-d7g77k8il914e5b12-1476831641/page_default_image/index/avatar/default_coach_avatar_male_cropped.png';

// 调整（2026-09-06）：团队成员改为「一人一行」展示，默认/兜底只保留 1 名示例成员；
// 真实成员加入后按加入顺序向下追加，列表最多同时展示 5 人，超过 5 人由展示层折叠展开
// 调整（2026-09-15）：示例成员补 avatarUrl=DEFAULT_TEAM_AVATAR_URL，os-team-avatar 兜底走图片分支
const DEFAULT_TEAM_MEMBER_LIST = [
  { avatar: '王', avatarUrl: DEFAULT_TEAM_AVATAR_URL, name: '王教练', role: '篮球主教练' }
];
// 新增（2026-10-14 课程收集）：机构展示区「机构课程」卡默认数据 —— 与 A 侧 organization.js
// DEFAULT_COURSE_LIST 逐字对齐；未绑定 / 未推送课程时按默认示例兜底展示。
const DEFAULT_COURSE_LIST = [
  { name: '少儿体能基础班', price: '199 元 / 节', duration: '60 分钟 / 节', details: '面向 6-12 岁孩子的体能基础训练，耐力、灵敏、协调组合练习。', imageUrl: '' }
];
// 新增：Hero 轮播默认数据：一张图都没有时只保留 1 屏占位，避免出现空白轮播（B 侧暂无图片来源，先固定占位）
const DEFAULT_BRAND_HERO_SLIDES = [{ imageUrl: '' }];

Page({
  data: {
    loading: true,
    profile: null,
    latestRequest: null,
    statusClass: "blue",
    targetCard: null,
    // 新增（2026-10-16 开发调试入口）：是否展示「入口落地页 entry_landing」转跳 view，
    // 仅开发环境（develop）为 true，体验版 / 线上版恒为 false，线上用户看不到该入口。
    isDevEnv: false,
    // 新增：机构展示区数据（抄自 A 侧 organization_show 的 data 结构）
    brandHeroSlides: DEFAULT_BRAND_HERO_SLIDES,
    brandHeroCurrent: 0,
    organizationProfile: DEFAULT_ORGANIZATION_PROFILE,
    introInfoList: DEFAULT_INTRO_INFO_LIST,
    teamMembers: DEFAULT_TEAM_MEMBER_LIST,
    // 团队成员折叠开关：true=只展示前 5 人，false=已展开全部
    teamShowAll: false,
    // 新增（2026-10-14 课程收集）：机构课程列表（organization_show「机构课程」卡），无数据时退默认示例
    courseList: DEFAULT_COURSE_LIST,
  },

  onShow() {
    this.bootstrap();
  },

  async bootstrap() {
    this.setData({ loading: true });
    try {
      const result = await parentApi.login();
      const latestRequest = result.latestRequest || null;
      const targetCard =
        (latestRequest && latestRequest.targetSnapshot) ||
        (result.parent && result.parent.targetSnapshot) ||
        null;
      // 阶段5补齐：按状态算颜色 class（与 parent_classshow 同款），首页"当前进度"徽章用
      const STATUS_COLOR_MAP = {
        editing: "gray",
        awaiting: "orange",
        in_progress: "green",
        completed: "darkgreen",
        cancelled: "red",
        closed: "darkgray",
        pending: "blue",
        scheduled: "green",
        finished: "darkgreen"
      };
      const statusClass = STATUS_COLOR_MAP[(latestRequest && latestRequest.status) || "pending"] || "blue";

      this.setData({
        loading: false,
        profile: result.parent || null,
        latestRequest,
        targetCard,
        statusClass,
        // 新增：机构展示区 Hero 文案组装 —— 家长已绑定展示对象时，
        // 把绑定对象名 / 简介映射进标题和副标题（承接原「已绑定：xxx」展示逻辑）；
        // 未绑定时保持 A 侧默认展示内容不变
        organizationProfile: targetCard
          ? {
              organizationName:
                String(targetCard.displayName || DEFAULT_ORGANIZATION_PROFILE.organizationName).trim() ||
                DEFAULT_ORGANIZATION_PROFILE.organizationName,
              slogan:
                String(targetCard.description || DEFAULT_ORGANIZATION_PROFILE.slogan).trim() ||
                DEFAULT_ORGANIZATION_PROFILE.slogan,
            }
          : { ...DEFAULT_ORGANIZATION_PROFILE },
      });

      // 新增（2026-09-05）：异步拉取机构展示真实数据（不阻塞首页主流程），
      // 拉到 dev_forPshowC 展示文档后覆盖展示区默认值；拉不到（未绑定 / 未推送 / 失败）保持默认完整值
      this.loadOrganizationShow(latestRequest, targetCard).catch(() => {});
    } catch (error) {
      this.setData({ loading: false });
      this.showError(error, "加载失败，请稍后重试");
    }
  },

  // 新增（2026-09-05）：机构展示区数据库拉取逻辑 —— 首页展示区原先只渲染写死默认值，
  // 现在参照 pages/index/organization_show 详情页的链路：login 拿到绑定目标后，
  // 用 organizationId / entryId 调 DLforP_entry_qrcode 的 get_org_show 拉 dev_forPshowC 展示文档，
  // 拉到真实数据就覆盖默认展示；拉不到（未绑定 / 机构未推送 / 请求失败）保持默认完整值，不报错、不弹提示。
  async loadOrganizationShow(latestRequest, targetCard) {
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
    organizationId = organizationId || (targetCard && targetCard.organizationId) || "";
    entryId = entryId || (targetCard && targetCard.entryId) || "";

    // 3) 旧数据兜底：两个 key 都没有但有识别码，重新识别一次触发云函数缓存自愈。
    if (!organizationId && !entryId && targetCard && targetCard.inviteCode) {
      try {
        const resolveResult = await parentApi.resolveInvite(targetCard.inviteCode);
        const freshTarget = (resolveResult && resolveResult.target) || null;
        if (freshTarget) {
          organizationId = freshTarget.organizationId || "";
          entryId = freshTarget.entryId || "";
        }
      } catch (error) {
        // 重新识别失败不阻断：首页继续用默认值展示。
        console.warn("[index_firstpage][WARN] resolveInvite.refresh_fail", {
          message: (error && (error.message || error.errMsg)) || String(error || ""),
        });
      }
    }

    if (!organizationId && !entryId) {
      // 未绑定 / 旧数据且识别码也反查不到：保持默认展示。
      return;
    }

    try {
      const showResult = await parentApi.getOrgShow({ organizationId, entryId });
      const orgShow = (showResult && showResult.orgShow) || null;
      if (!orgShow) {
        // 云函数正常返回但没有展示文档（自由教练 / 机构还没推送）：保持默认展示。
        return;
      }
      this.setData(this.buildOrganizationShowViewModel(orgShow));
    } catch (error) {
      // 云函数失败 / 文档不存在：保持默认展示，只打日志不弹错误（首页主体仍可用）。
      console.warn("[index_firstpage][WARN] getOrgShow.fail", {
        organizationId,
        entryId,
        message: (error && (error.message || error.errMsg)) || String(error || ""),
      });
    }
  },

  // 新增（2026-09-05）：把 dev_forPshowC 展示文档组装成首页展示区视图模型；
  // 字段缺省时逐项退回 A 侧同步过来的默认（完整）值，保证展示永远完整不空。
  buildOrganizationShowViewModel(orgShow) {
    const basic = (orgShow && orgShow.show_basic) || {};
    const images = (orgShow && orgShow.images) || {};
    const members = orgShow && Array.isArray(orgShow.members) ? orgShow.members : [];

    // Hero 轮播：只取转存到 B 侧云存储成功的 fileID；一张都没有时回退默认占位。
    const swiperFileIds = (Array.isArray(images.swiper) ? images.swiper : [])
      .map((item) => (item && item.file_id) || "")
      .filter(Boolean);
    const brandHeroSlides = swiperFileIds.length
      ? swiperFileIds.map((fileId) => ({ imageUrl: fileId }))
      : DEFAULT_BRAND_HERO_SLIDES.map((item) => ({ ...item }));

    // 品牌文案：机构名 / 品牌定位缺省时退默认「代码肌 · 跃动邻」（2026-09-05 已随 A 侧默认值同步更新）。
    const organizationProfile = {
      organizationName:
        String(basic.organization_name || "").trim() || DEFAULT_ORGANIZATION_PROFILE.organizationName,
      slogan: String(basic.brand_slogan || "").trim() || DEFAULT_ORGANIZATION_PROFILE.slogan,
    };

    return {
      brandHeroSlides,
      brandHeroCurrent: 0,
      organizationProfile,
      introInfoList: this.buildIntroInfoList(basic),
      teamMembers: this.buildShowTeamMembers(members),
      // 新增（2026-10-14 课程收集）：机构课程卡从 orgShow.courses 生成，无数据退回默认示例
      courseList: this.buildShowCourseList(orgShow),
    };
  },

  // 同步（2026-09-05）：机构简介 4 行字段（核心服务 / 服务区域 / 适合谁 / 教练理念）——
  // 与 A 侧 organization.js 的 buildIntroInfoList 保持一致，真实字段缺省行退回默认（完整）值。
  buildIntroInfoList(basic = {}) {
    const entries = [
      { label: "核心服务：", value: basic.core_services },
      { label: "服务区域：", value: basic.service_area },
      { label: "适合谁：", value: basic.target_audience },
      { label: "教练理念：", value: basic.coaching_philosophy },
    ];
    return entries.map((entry, index) => {
      const fallback = DEFAULT_INTRO_INFO_LIST[index] || entry;
      const normalizedValue = String(entry.value || "").trim() || fallback.value;
      return {
        label: entry.label || fallback.label,
        value: normalizedValue,
      };
    });
  },

  // 同步（2026-09-06）：团队成员一人一行 —— 与 A 侧 buildShowTeamMembers 保持一致：
  // 真实成员（admin=团队管理层，其余=团队执行教练）按加入顺序向下追加、不再补足/截断；
  // 没有成员时退回默认（1 名示例成员）值；超过 5 人由展示层折叠，「展开全部」可看全部。
  // 调整（2026-09-15）：真实成员 avatar.file_id 为空时兜底 DEFAULT_TEAM_AVATAR_URL，
  // 让 os-team-avatar 永远走图片分支显示默认男头像，不再退回红底首字文字兜底。
  buildShowTeamMembers(members) {
    const realMembers = (Array.isArray(members) ? members : []).map((member) => {
      const nickname = String((member && member.name) || "").trim() || "团队成员";
      const role = String((member && member.role) || "").trim();
      const realAvatarUrl = String((member && member.avatar && member.avatar.file_id) || "").trim();
      return {
        avatar: nickname.slice(0, 1) || "员",
        avatarUrl: realAvatarUrl || DEFAULT_TEAM_AVATAR_URL,
        name: nickname,
        role: role === "admin" ? "团队管理层" : "团队执行教练",
      };
    });

    if (!realMembers.length) {
      return DEFAULT_TEAM_MEMBER_LIST.map((item) => ({ ...item }));
    }
    return realMembers;
  },

  // 新增（2026-10-14 课程收集）：机构课程列表 —— 从 dev_forPshowC.courses 生成展示卡。
  // 图片取 B 侧转存成功的第一张 file_id，课程名 / 授课时长 / 详情直接透传；无课程退回默认示例课程。
  buildShowCourseList(orgShow = {}) {
    const courses = Array.isArray(orgShow && orgShow.courses) ? orgShow.courses : [];
    const realCourses = courses.map((course) => {
      const images = Array.isArray(course && course.images) ? course.images : [];
      const firstImageFileId = images
        .map((img) => (img && img.file_id) || "")
        .find((fileId) => !!fileId) || "";
      return {
        name: String((course && course.name) || "").trim(),
        price: String((course && course.price) || "").trim(),
        duration: String((course && course.duration) || "").trim(),
        details: String((course && course.details) || "").trim(),
        imageUrl: firstImageFileId,
      };
    }).filter((course) => course.name || course.duration || course.details);

    if (!realCourses.length) {
      return DEFAULT_COURSE_LIST.map((item) => ({ ...item }));
    }
    return realCourses;
  },

  // 团队成员「展开全部 / 收起」切换：成员超过 5 人时折叠只展示前 5 人，点入口看剩余成员
  onToggleTeamMembers() {
    this.setData({
      teamShowAll: !this.data.teamShowAll,
    });
  },

  // 新增：Hero 轮播切换（抄自 A 侧 organization.js）：记录当前页下标，驱动自定义指示器高亮
  onBrandHeroChange(e) {
    const current = Number(((e || {}).detail || {}).current);
    this.setData({
      brandHeroCurrent: isNaN(current) ? 0 : current,
    });
  },

  // 新增：Hero 图片加载失败兜底（抄自 A 侧 organization.js）：只清空失败那一屏的 src，让 wxml 单独显示占位区
  onBrandHeroImageError(e) {
    const index = Number((((e || {}).currentTarget || {}).dataset || {}).index);
    const brandHeroSlides = this.data.brandHeroSlides || [];
    if (isNaN(index) || !brandHeroSlides[index]) {
      return;
    }
    const nextSlides = brandHeroSlides.map((slide, slideIndex) =>
      slideIndex === index ? { ...slide, imageUrl: "" } : slide
    );
    this.setData({
      brandHeroSlides: nextSlides,
    });
  },

  goParentAdd() {
    // parent_add 已是 tabBar 页面，必须用 switchTab 切换。
    // 识别码回填交给 parent_add 自己的 bootstrap（按 latestRequest / parent.latestInviteCode 兜底）。
    wx.switchTab({
      url: "/pages/index/parent_add/parent_add",
    });
  },

  goOrganizationShow() {
    wx.navigateTo({
      url: "/pages/index/organization_show/organization_show",
    });
  },

  goClassShow() {
    wx.switchTab({
      url: "/pages/index/parent_classshow/parent_classshow",
    });
  },

  showError(error, fallbackText) {
    const message = (error && (error.message || error.errMsg)) || fallbackText;
    wx.showToast({
      title: message,
      icon: "none",
    });
  },

  // 页面加载/显示时开启分享入口：转发给好友 + 分享到朋友圈
  // （全局 app.js 已兜底调用，此处页面级再次调用保证当前页菜单稳定生效）
  // 新增（2026-10-16 开发调试入口）：同时判定当前运行环境，决定是否展示最顶部的 entry_landing 转跳 view。
  // 口径与 utils/parent-api.js 的 getMiniEnvVersion 一致：取不到时默认 develop。
  onLoad() {
    let isDevEnv = false;
    try {
      const accountInfo = wx.getAccountInfoSync();
      isDevEnv = ((accountInfo && accountInfo.miniProgram && accountInfo.miniProgram.envVersion) || "develop") === "develop";
    } catch (e) {
      isDevEnv = true;
    }
    this.setData({ isDevEnv });

    if (wx.showShareMenu) {
      wx.showShareMenu({
        withShareTicket: true,
        menus: ["shareAppMessage", "shareTimeline"],
      });
    }
  },

  // 新增（2026-10-16 开发调试入口）：点击最顶部转跳 view 进入入口二维码落地页 entry_landing。
  // 该页是普通页面（非 tabBar），用 navigateTo 跳转，可正常返回首页。
  // 注意：entry_landing 依赖 scene(entryId) 解析机构入口，不带参数进入时页面会走「未识别到入口信息」的失败态，
  // 属正常表现（本入口只用于开发期快速打开该页面），需要真实数据时请仍按扫码路径进入。
  goEntryLanding() {
    wx.navigateTo({
      url: "/pages/entry_landing/entry_landing",
    });
  },

  // 右上角「分享给好友」/ open-type="share" 按钮触发
  onShareAppMessage() {
    const app = getApp();
    const share = (app && app.globalData && app.globalData.share) || {};
    const inviteCode =
      (this.data.targetCard && this.data.targetCard.inviteCode) ||
      (this.data.latestRequest && this.data.latestRequest.inviteCode) ||
      (this.data.profile && this.data.profile.latestInviteCode) ||
      "";
    return {
      title: share.title || "家长约课登记 - 约课登记小程序",
      path: buildParentAddPath(inviteCode),
    };
  },

  // 右上角「分享到朋友圈」触发（需页面声明才会出现入口）
  onShareTimeline() {
    const app = getApp();
    const share = (app && app.globalData && app.globalData.share) || {};
    const inviteCode =
      (this.data.targetCard && this.data.targetCard.inviteCode) ||
      (this.data.latestRequest && this.data.latestRequest.inviteCode) ||
      (this.data.profile && this.data.profile.latestInviteCode) ||
      "";
    const normalizedInviteCode = normalizeInviteCode(inviteCode);
    return {
      title: share.title || "家长约课登记 - 约课登记小程序",
      query: normalizedInviteCode ? `inviteCode=${encodeURIComponent(normalizedInviteCode)}` : "",
    };
  },
});
