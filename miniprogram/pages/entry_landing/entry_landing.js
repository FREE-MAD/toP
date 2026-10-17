// B 侧入口二维码落地页。
// 作用：扫码后小程序码把 scene（entryId）带到这里，
//       onLoad 解析 scene → 调 DLforP_entry_qrcode/resolve_entry → 拿到机构快照展示。
// 设计要点（两层绑定）：
//   - 本页只做「入口识别 + 展示」，不写任何用户-机构永久绑定；
//   - 真正绑定发生在家长点击「我要预约」进入 parent_add 提交订单时（order.sourceEntryId）。
// 统一约定：云函数调用 / 路径拼接全部走 utils/parent-api，与其他页面共用同一份口径。
const parentApi = require("../../utils/parent-api");

// 新增（落地页改版）：机构展示区默认数据，整体抄自 index_firstpage 的 organization_show 默认值。
// resolveEntry 没拿到 orgShow（机构未推送展示数据）时按这套默认内容兜底展示，与首页未绑定时的兜底一致。
const DEFAULT_ORGANIZATION_PROFILE = {
  organizationName: '代码肌 · 跃动邻',
  slogan: '用代码连接体育，让专业能力被看见'
};
const DEFAULT_INTRO_INFO_LIST = [
  { label: '核心服务：', value: '体育数字化工具、教练服务连接、机构展示' },
  { label: '服务区域：', value: '不只深圳南山，软件链接万物' },
  { label: '适合群体：', value: '体育教练、体育机构及有运动服务需求的用户' },
  { label: '品牌理念：', value: '用代码提升体育服务效率，让专业更容易被看见' }
];
// 真实教练没传头像时统一兜底为 B 侧云存储官方默认男头像，保证头像位永远有图。
const DEFAULT_TEAM_AVATAR_URL = 'cloud://cloud1-d7g77k8il914e5b12.636c-cloud1-d7g77k8il914e5b12-1476831641/page_default_image/index/avatar/default_coach_avatar_male_cropped.png';
const DEFAULT_TEAM_MEMBER_LIST = [
  { avatar: '王', avatarUrl: DEFAULT_TEAM_AVATAR_URL, name: '王教练', role: '篮球主教练' }
];
// 机构课程卡默认数据，未推送课程时按默认示例兜底展示。
const DEFAULT_COURSE_LIST = [
  { name: '少儿体能基础班', price: '199 元 / 节', duration: '60 分钟 / 节', details: '面向 6-12 岁孩子的体能基础训练，耐力、灵敏、协调组合练习。', imageUrl: '' }
];
// Hero 轮播默认数据：一张图都没有时只保留 1 屏占位，避免出现空白轮播。
const DEFAULT_BRAND_HERO_SLIDES = [{ imageUrl: '' }];

// ===== 本地 Mock 数据（直入预览）=====
// 完全模拟云函数 resolveEntry 返回结构（含 snapshot + orgShow + inviteCode）。
// onLoad 默认直接 setData 这份数据，跳过云函数调用与扫码，方便本地预览 entry_landing 完整样式。
// 占位图说明：dev 期用 https://picsum.photos 占位让所有 4 个区都有真图可见。
//   微信开发者工具 → 详情 → 本地设置 → 勾选「不校验合法域名」即可加载；生产替换为 cloud:// B 侧云存储 fileID。
// 字段含义与真实云函数返回完全一致，渲染走的是同一套 buildShowViewModel → buildOrganizationShowViewModel。
const MOCK_ENTRY_DATA = {
  success: true,
  targetType: 'org',
  targetId: 'MOCK_ORG_001',
  inviteCode: 'MOCK001a',
  inviteCodeSource: 'mock_local',
  snapshot: {
    institutionName: '代码肌 · 跃动邻（Mock）',
    intro: '本地 Mock 数据，用于直入预览 entry_landing 完整样式。',
  },
  orgShow: {
    show_basic: {
      organization_name: '代码肌 · 跃动邻',
      brand_slogan: '用代码连接体育，让专业能力被看见',
      core_services: '少儿体能训练、青少年篮球、成人私教、团队拓展',
      service_area: '深圳市南山区科技园片区（Mock 区域：软件链接万物）',
      target_audience: '6-15 岁青少年体育基础训练、成人健身与减脂需求用户',
      coaching_philosophy: '以数据驱动训练，以兴趣驱动坚持，让专业教练陪伴每一次成长',
      city: '深圳',
      address: '南山区科技园 1001 号 Mock 大厦 8 楼',
      contact: '400-000-0000',
    },
    images: {
      logo: { file_id: 'https://picsum.photos/seed/orgLogo/200/200' },
      // 4 张轮播：让指示器、自定义 dot 都能看到效果
      swiper: [
        { file_id: 'https://picsum.photos/seed/heroTraining/750/400' },
        { file_id: 'https://picsum.photos/seed/heroCoach/750/400' },
        { file_id: 'https://picsum.photos/seed/heroClass/750/400' },
        { file_id: 'https://picsum.photos/seed/heroTeam/750/400' },
      ],
    },
    members: [
      { name: '王教练', role: 'admin', avatar: { file_id: 'https://i.pravatar.cc/200?img=12' } },
      { name: '李教练', role: 'coach', avatar: { file_id: 'https://i.pravatar.cc/200?img=15' } },
      { name: '张教练', role: 'coach', avatar: { file_id: 'https://i.pravatar.cc/200?img=20' } },
      { name: '陈教练', role: 'coach', avatar: { file_id: 'https://i.pravatar.cc/200?img=25' } },
      { name: '林教练', role: 'coach', avatar: { file_id: 'https://i.pravatar.cc/200?img=33' } },
      { name: '赵教练', role: 'coach', avatar: { file_id: 'https://i.pravatar.cc/200?img=45' } },
      { name: '周教练', role: 'coach', avatar: { file_id: 'https://i.pravatar.cc/200?img=51' } },
    ],
    courses: [
      {
        name: '少儿体能基础班',
        price: '199 元 / 节',
        duration: '60 分钟 / 节',
        details: '面向 6-12 岁孩子的体能基础训练，耐力、灵敏、协调组合练习，按年龄分组小班教学。',
        images: [{ file_id: 'https://picsum.photos/seed/courseKids/600/400' }],
      },
      {
        name: '青少年篮球进阶训练营',
        price: '299 元 / 节',
        duration: '90 分钟 / 节',
        details: '针对 10-15 岁孩子的篮球技战术训练，含投篮、运球、对抗与比赛观摩模块。',
        images: [{ file_id: 'https://picsum.photos/seed/courseBasket/600/400' }],
      },
      {
        name: '成人私教一对一',
        price: '499 元 / 节',
        duration: '60 分钟 / 节',
        details: '一对一量身定制训练计划，体能 / 减脂 / 增肌按目标拆解，含体测与饮食建议。',
        images: [{ file_id: 'https://picsum.photos/seed/coursePrivate/600/400' }],
      },
    ],
  },
};

Page({
  data: {
    // 解析中 / 解析失败 / 解析成功
    state: 'loading',
    entryId: '',
    targetType: '',
    targetId: '',
    snapshot: null,
    // 新增（A 侧机构展示信息同步，2026-09-05）：A 侧推送沉淀在 dev_forPshowC 的完整机构展示文档，
    // 包含 show_basic（名称/简介/城市/地址/联系）+ images（logo/轮播图，B 侧云存储 fileID）+ members（昵称/角色/头像）。
    // 机构还没推送过同步数据时为 null，页面降级用入口快照（snapshot）展示。
    orgShow: null,
    // 新增（扫码自动补识别码，2026-09-06）：resolve_entry 回传的机构家长端识别码（inviteCode）。
    // 点「我要预约」跳 parent_add 时随路径带入，约课页自动填入识别码并静默识别，家长无需手输；
    // 云函数三级回退都未命中时为空串，buildParentAddPath 会自动跳过该参数，不影响原有二维码入口链路。
    inviteCode: '',
    errorMessage: '',
    // 新增（落地页改版）：机构展示区视图模型字段，与 index_firstpage 的 organization_show 同构。
    brandHeroSlides: DEFAULT_BRAND_HERO_SLIDES,
    brandHeroCurrent: 0,
    organizationProfile: DEFAULT_ORGANIZATION_PROFILE,
    introInfoList: DEFAULT_INTRO_INFO_LIST,
    teamMembers: DEFAULT_TEAM_MEMBER_LIST,
    teamShowAll: false,
    courseList: DEFAULT_COURSE_LIST,
  },

  onLoad(options) {
    // ===== 直入预览模式（dev）=====
    // 当前开发期：跳过扫码 scene 解析与云函数调用，直接加载 MOCK_ENTRY_DATA 渲染成功页。
    // 上线恢复：删除本段直入逻辑，恢复下方注释里的 scene 解析 + resolveEntry(scene) 调用。
    console.log('[entry_landing][INFO] onLoad.directMock', { options });

    if (wx.showShareMenu) {
      wx.showShareMenu({
        withShareTicket: true,
        menus: ['shareAppMessage', 'shareTimeline'],
      });
    }

    this.loadMockEntry();

    // ===== 上线恢复（注释保留，删除上方 loadMockEntry 即可启用真实扫码链路）=====
    // let scene = '';
    // try { scene = decodeURIComponent(options.scene || options.entryId || ''); }
    // catch (e) { scene = options.scene || options.entryId || ''; }
    // if (!scene) { this.setData({ state: 'error', errorMessage: '未识别到入口信息，请重新扫码' }); return; }
    // this.resolveEntry(scene);
  },

  // 直入预览：灌入 MOCK_ENTRY_DATA，组装与 resolveEntry.success 完全一致的视图模型。
  loadMockEntry() {
    console.log('[entry_landing][INFO] loadMockEntry');
    const mock = MOCK_ENTRY_DATA;
    const orgShow = (mock.orgShow && typeof mock.orgShow === 'object') ? mock.orgShow : null;
    const viewModel = this.buildShowViewModel(orgShow, mock.snapshot || null);
    this.setData({
      state: 'success',
      entryId: 'MOCK_ENTRY_001',
      targetType: mock.targetType || '',
      targetId: mock.targetId || '',
      snapshot: mock.snapshot || null,
      orgShow,
      inviteCode: parentApi.normalizeInviteCode(mock.inviteCode || ''),
      errorMessage: '',
      ...viewModel,
    });
  },

  // 调云函数解析 entryId → 机构快照。
  // 统一走 parentApi.resolveEntry（内含冷启动 500ms 自动重试），本页不再手写 callFunction。
  // 新增（诊断日志）：云函数 resolve_entry 在 B 侧云环境执行，前端只看到结果，
  // 这里把 request / success / error 三段全部打到 console，配合 B 侧云函数日志双向核对。
  resolveEntry(scene) {
    console.log('[entry_landing][INFO] resolveEntry.start', { scene });
    this.setData({ state: 'loading', entryId: scene });
    parentApi
      .resolveEntry(scene)
      .then((result) => {
        console.log('[entry_landing][INFO] resolveEntry.success', {
          scene,
          targetType: result.targetType || '',
          targetId: result.targetId || '',
          snapshotKeys: (result.snapshot && typeof result.snapshot === 'object') ? Object.keys(result.snapshot) : [],
          institutionName: (result.snapshot && result.snapshot.institutionName) || '',
          hasLogo: !!(result.snapshot && result.snapshot.logoFileId),
          page: result.page || '',
          // 新增（机构展示同步）：记录 orgShow 命中情况，便于排查「落地页没显示完整机构信息」时是云函数没返回还是前端没渲染。
          hasOrgShow: !!(result.orgShow && typeof result.orgShow === 'object'),
          orgShowMemberCount: (result.orgShow && Array.isArray(result.orgShow.members)) ? result.orgShow.members.length : 0,
          orgShowSwiperCount: (result.orgShow && result.orgShow.images && Array.isArray(result.orgShow.images.swiper)) ? result.orgShow.images.swiper.length : 0,
          // 新增（扫码自动补识别码）：记录识别码命中情况与来源（snapshot / org_show / invite_targets），
          // 便于排查「跳约课页后识别码没自动填入」时是云函数没返回还是跳转参数丢失。
          inviteCode: result.inviteCode || '',
          inviteCodeSource: result.inviteCodeSource || '',
        });
        const orgShow = (result.orgShow && typeof result.orgShow === 'object') ? result.orgShow : null;
        // 新增（落地页改版）：把 orgShow / snapshot 组装成 organization_show 完整机构展示视图模型，
        // orgShow 有值走完整字段（轮播/简介/团队/课程），null 时降级用 snapshot（机构名 + 简介）+ 默认值。
        const viewModel = this.buildShowViewModel(orgShow, result.snapshot || null);
        this.setData({
          state: 'success',
          targetType: result.targetType || '',
          targetId: result.targetId || '',
          snapshot: result.snapshot || null,
          orgShow,
          // 新增（扫码自动补识别码）：云函数返回的识别码先过一遍统一规范化再落 data，跳转 parent_add 时作为 inviteCode 参数带入。
          inviteCode: parentApi.normalizeInviteCode(result.inviteCode || ''),
          ...viewModel,
        });
      })
      .catch((err) => {
        // 云函数返回 success:false 时 reject 回来的是 result 对象，网络失败时是 err 对象，两种都兜住。
        const isResultObj = err && typeof err === 'object' && ('success' in err || 'code' in err || 'message' in err);
        console.error('[entry_landing][ERROR] resolveEntry.fail', {
          scene,
          errType: isResultObj ? 'cloud_result' : 'js_error',
          code: err && err.code ? err.code : (err && err.errcode ? err.errcode : ''),
          success: err && typeof err.success !== 'undefined' ? err.success : '',
          message: (err && (err.message || err.errorMessage)) ? (err.message || err.errorMessage) : String(err || ''),
          // stack 只在真正的 Error 对象上有，result 对象没有。
          stack: err && err.stack ? String(err.stack).slice(0, 500) : '',
        });
        this.setData({
          state: 'error',
          errorMessage: (err && (err.message || err.errorMessage)) || '网络异常，请稍后重试',
        });
      });
  },

  // ===== 新增（落地页改版）：机构展示区（organization_show）数据组装 =====
  // 数据来源优先 orgShow（dev_forPshowC 完整展示文档），null 时降级用 snapshot（机构名 + 简介）+ 默认值。
  buildShowViewModel(orgShow, snapshot) {
    if (orgShow) {
      return this.buildOrganizationShowViewModel(orgShow);
    }
    const institutionName = String((snapshot && snapshot.institutionName) || "").trim();
    const intro = String((snapshot && snapshot.intro) || "").trim();
    return {
      brandHeroSlides: DEFAULT_BRAND_HERO_SLIDES.map((item) => ({ ...item })),
      brandHeroCurrent: 0,
      organizationProfile: {
        organizationName: institutionName || DEFAULT_ORGANIZATION_PROFILE.organizationName,
        slogan: intro || DEFAULT_ORGANIZATION_PROFILE.slogan,
      },
      introInfoList: DEFAULT_INTRO_INFO_LIST.map((item) => ({ ...item })),
      teamMembers: DEFAULT_TEAM_MEMBER_LIST.map((item) => ({ ...item })),
      courseList: DEFAULT_COURSE_LIST.map((item) => ({ ...item })),
    };
  },

  // 把 dev_forPshowC 展示文档组装成机构展示区视图模型（与 index_firstpage organization_show 同款逻辑）。
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

    // 品牌文案：机构名 / 品牌定位缺省时退默认「代码肌 · 跃动邻」。
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
      courseList: this.buildShowCourseList(orgShow),
    };
  },

  // 机构简介 4 行字段（核心服务 / 服务区域 / 适合谁 / 教练理念），真实字段缺省行退回默认值。
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

  // 团队成员一人一行：真实成员按加入顺序向下追加；没有成员退回默认（1 名示例成员）。
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

  // 机构课程列表：从 dev_forPshowC.courses 生成展示卡；无课程退回默认示例课程。
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

  // 团队成员「展开全部 / 收起」切换。
  onToggleTeamMembers() {
    this.setData({
      teamShowAll: !this.data.teamShowAll,
    });
  },

  // Hero 轮播切换：记录当前页下标，驱动自定义指示器高亮。
  onBrandHeroChange(e) {
    const current = Number(((e || {}).detail || {}).current);
    this.setData({
      brandHeroCurrent: isNaN(current) ? 0 : current,
    });
  },

  // Hero 图片加载失败兜底：只清空失败那一屏的 src，让 wxml 单独显示占位区。
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

  // 点击「我要预约」：携带入口上下文进入 parent_add，绑定在提交时发生。
  // 调整（带 id 修改，2026-10-13）：parent_add 已是 tabBar 页面，wx.navigateTo 不能跳 tabBar，
  // 改用 wx.switchTab 切到 parent_add tab；识别码与二维码入口上下文通过 globalData 透传，
  // parent_add onShow 会兜底读取并清空（onLoad 在 tab 首次创建后不再触发，必须放 onShow）。
  onGoBooking() {
    const { entryId, targetId, targetType, snapshot, inviteCode } = this.data;
    // 新增（诊断日志）：家长点击「我要预约」是转化关键一步，打印透传上下文，
    // 便于后续「约课页没显示机构入口」「绑定没生效」「识别码没自动填入」等问题回溯。
    console.log('[entry_landing][INFO] onGoBooking', {
      entryId,
      targetId,
      targetType,
      entryName: (snapshot && snapshot.institutionName) || '',
      // 新增（扫码自动补识别码）：确认跳转链接里带了识别码。
      inviteCode: inviteCode || '',
    });

    const app = getApp();
    if (app && app.globalData) {
      app.globalData.routeInviteCode = parentApi.normalizeInviteCode(inviteCode || "");
      app.globalData.entryContext = {
        sourceEntryId: entryId || "",
        targetId: targetId || "",
        targetType: targetType || "",
        // 机构名称一并带过去，约课页可直接展示「来自 XX 机构二维码入口」，无需再反查。
        entryName: (snapshot && snapshot.institutionName) || "",
      };
    }

    wx.switchTab({
      url: "/pages/index/parent_add/parent_add",
      fail: () => {
        // 兜底：极少数基础库在 tabBar 还未注册时 switchTab 失败，回落 navigateTo 走 url 透传。
        const url = parentApi.buildParentAddPath(inviteCode, {
          sourceEntryId: entryId,
          targetId,
          targetType,
          entryName: (snapshot && snapshot.institutionName) || '',
        });
        wx.navigateTo({ url });
      },
    });
  },

  // 新增（2026-10-16）：点击「查看课程」跳家长端「上课信息」页。
  // parent_classshow 已是 tabBar 页面，wx.navigateTo 不能跳 tabBar，必须用 wx.switchTab；
  // 口径与 index_firstpage 的 goClassShow 保持一致。
  onGoClassShow() {
    wx.switchTab({ url: '/pages/index/parent_classshow/parent_classshow' });
  },

  // 点击「返回首页」。
  onGoHome() {
    wx.switchTab({ url: '/pages/index_firstpage/index_firstpage' });
  },

  // 右上角「分享给好友」：分享落地页路径并带上 scene(entryId)，
  // 好友点开分享卡片等价于扫码，同样进本页解析机构入口。
  onShareAppMessage() {
    const app = getApp();
    const share = (app && app.globalData && app.globalData.share) || {};
    const { entryId, snapshot } = this.data;
    const institutionName = (snapshot && snapshot.institutionName) || '';
    return {
      title: institutionName
        ? `${institutionName} - 家长约课入口`
        : share.title || '家长约课登记 - 机构入口',
      path: entryId
        ? `/pages/entry_landing/entry_landing?scene=${encodeURIComponent(entryId)}`
        : '/pages/entry_landing/entry_landing',
    };
  },

  // 右上角「分享到朋友圈」：query 里同样带 scene，打开后 onLoad 直接解析。
  onShareTimeline() {
    const app = getApp();
    const share = (app && app.globalData && app.globalData.share) || {};
    const { entryId, snapshot } = this.data;
    const institutionName = (snapshot && snapshot.institutionName) || '';
    return {
      title: institutionName
        ? `${institutionName} - 家长约课入口`
        : share.title || '家长约课登记 - 机构入口',
      query: entryId ? `scene=${encodeURIComponent(entryId)}` : '',
    };
  },
});
