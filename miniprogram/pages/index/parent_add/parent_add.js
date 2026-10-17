const parentApi = require("../../../utils/parent-api");

// 家长约课表单页：
// 1. 先识别「识别码」对应的机构 / 自由教练（展示文案改为识别码，底层字段仍为 inviteCode）
// 2. 再提交家长和孩子信息
// 3. 提交成功后跳转到“上课信息”tab
//
// 识别码规范化规则（前端 + B 侧云函数 + A 侧云函数 必须完全一致，否则跨端匹配会失败）：
// 1) 剥离所有非字母数字字符（空格、-、_、# 等）
// 2) 统一转大写
// 3) 截断到 16 位，兼容 organization inviteCode 字段长度
// 统一实现收口在 utils/parent-api.js，本页与首页 / 机构展示页 / 上课信息页 / 二维码落地页共用同一份。
const normalizeInviteCode = parentApi.normalizeInviteCode;

// 分享 / 跳转到家长约课页时，统一通过 parent-api 的 buildParentAddPath 拼接参数。
// 这样页面内外对 inviteCode / 二维码入口参数的路径口径保持一致，后续路径规则调整只改 parent-api 一处。
const buildParentAddPath = parentApi.buildParentAddPath;

// 状态颜色映射（A 历史预约列表里每条记录的状态徽章颜色，复用 parent_classshow 的同一套）。
const STATUS_COLOR_MAP = {
  editing: "gray",
  awaiting: "orange",
  in_progress: "green",
  completed: "darkgreen",
  cancelled: "red",
  closed: "darkgray",
  pending: "blue",
  scheduled: "green",
  finished: "darkgreen",
};

// 终态集合：completed / cancelled / closed / finished 视为已结束，不再作为活跃课表展示。
const TERMINAL_STATUS = ["completed", "cancelled", "closed", "finished"];

// 把云函数返回的原始 course 记录适配为 A 历史投放列表需要的视图模型：
// 1) statusClass 落到 wxss 使用的 status-xxx 颜色；
// 2) updatedAtText 转成「YYYY-MM-DD HH:mm」，没值兜底为「时间未知」；
// 3) formSnapshot 兼容历史快照里没有 childProfiles 的老数据（fallback 到 childName/childAge 单条）。
function decorateHistoryItem(raw) {
  if (!raw) {
    return null;
  }
  const formSnapshot = (raw.formSnapshot && typeof raw.formSnapshot === "object") ? raw.formSnapshot : {};
  const status = String(raw.status || "").toLowerCase().trim();
  const updatedAtMs = Number(raw.updatedAt || raw.createdAt || 0);
  let updatedAtText = "时间未知";
  if (updatedAtMs) {
    const d = new Date(updatedAtMs);
    if (!isNaN(d.getTime())) {
      const pad = (n) => String(n).padStart(2, "0");
      updatedAtText = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
  }
  return {
    ...raw,
    formSnapshot,
    status,
    statusText: raw.statusText || (TERMINAL_STATUS.includes(status) ? "已结束" : "待安排"),
    statusClass: STATUS_COLOR_MAP[status] || "blue",
    updatedAtText,
  };
}

Page({
  data: {
    loading: true,
    inviteLoading: false,
    submitLoading: false,
    invitePreview: null,
    // 修改模式标记：tabBar 切入时若无 modifyCourseId 走「新建」，有 id 走「修改」。
    // tabbar 页面无法用 url 带参，统一通过 app.globalData.modifyCourseId 透传。
    isModify: false,
    modifyCourseId: "",
    // 单独记录路由携带进来的识别码，避免 onShow -> bootstrap 时被历史识别码覆盖。
    routeInviteCode: "",
    // 二维码入口上下文：从 entry_landing「我要预约」带进来（sourceEntryId 等）。
    // 与 routeInviteCode 一样只在 onLoad 写入，bootstrap/onShow 不覆盖；
    // 落地页本身不写任何用户-机构永久绑定，真正绑定在提交订单时发生（随 submitBooking 透传 sourceEntryId）。
    entryContext: {
      sourceEntryId: "",
      targetType: "",
      targetId: "",
      entryName: "",
    },
    // 页面内 tabbar：A 历史预约 / B 当前选择（修改/新建课程，现有的样式）。
    // 默认进 B，新建/带 id 修改都先让用户在 B 完成主要操作；
    // 但首次拉取后会保留历史列表供用户在 A 中浏览切换。
    activeTab: "current",
    // 课程码参课子 tab（current 内再分两个子 tab：表单提交 / 输入课程码）。
    subTab: "form",
    courseCodeInput: "",
    joinLoading: false,
    // A 历史预约数据：getMyCourse.allCourses 全量数据 + 视图装饰（状态颜色、更新时间等）。
    historyList: [],
    historyActive: [],
    historyTerminal: [],
    historyLoading: false,
    historyLoaded: false,
    // 课程目标：当前选中的课程类型与子项（复刻 publish_classcreate 的课程方向选择状态）。
    currentClassId: null,
    selectedSubName: null,
    currentClass: null,
    // 课程类型预设（与 A 端 publish_classcreate 保持一致，家长约课时直接选择课程方向）。
    classTypes: [
      {
        id: 'posture', name: '体态矫正',
        brief: '专门针对青少年中常见的圆肩、驼背、X/O型腿等问题设计的专项训练。',
        defaultLessons: 10, images: [],
        planText: '课程分为前期、中期、后期三个阶段推进：前期进行体态评估与基础动作学习，中期重点训练肩颈、脊柱、下肢的稳定与拉伸，后期形成家庭可执行的体态改善方案并跟踪效果。',
        subItems: ['圆肩驼背改善', '脊柱侧弯预防', 'X/O 型腿调整'],
        subPlans: {
          '圆肩驼背改善': '本子计划聚焦于现代青少年因久坐、低头使用电子设备导致的圆肩驼背问题。通过胸椎伸展、肩胛激活及颈部放松训练，帮助打开上背部、恢复自然肩颈曲线。',
          '脊柱侧弯预防': '针对脊柱发育关键期可能出现的轻度功能性侧弯，本计划强调早期筛查与干预。',
          'X/O 型腿调整': 'X型腿或O型腿多与髋关节稳定性不足、足弓塌陷或走路姿势异常相关。'
        }
      },
      {
        id: 'elite', name: '专业追高',
        brief: '提高专项成绩，适合有一定基础、想要突破的孩子',
        defaultLessons: 10, images: [],
        planText: '课程分为前期、中期、后期三个阶段推进：前期基础体能与动作技术复盘，中期进行专项速度、力量、灵敏等强化训练，后期侧重专项测试与比赛模拟。',
        subItems: ['基础能力巩固', '专项成绩突破', '考级与比赛冲刺'],
        subPlans: {
          '基础能力巩固': '本子计划旨在为高水平专项训练筑牢体能根基。',
          '专项成绩突破': '本计划以精准诊断为核心，通过阶段性测试识别技术瓶颈与体能短板。',
          '考级与比赛冲刺': '本计划紧密对标体育特长生考级、校队选拔或市级赛事评分标准。'
        }
      },
      {
        id: 'track', name: '田径专项',
        brief: '短跑、中长跑、跑跳投综合训练',
        defaultLessons: 10, images: [],
        planText: '课程分为前期、中期、后期三个阶段推进：前期学习跑姿、起跑与节奏控制，中期分模块训练短跑速度、中长跑耐力和跑跳投基础技术。',
        subItems: ['短跑爆发力', '中长跑耐力', '跑跳投综合训练'],
        subPlans: {
          '短跑爆发力': '本计划聚焦短距离项目的核心能力——瞬间加速与高速维持。',
          '中长跑耐力': '本计划面向中长距离项目，强调有氧能力与节奏感的协同发展。',
          '跑跳投综合训练': '在稳固基本跑姿基础上，拓展田径基础技能模块。'
        }
      },
      {
        id: 'exam', name: '中考体育',
        brief: '围绕中考项目进行系统训练与模拟测试',
        defaultLessons: 10, images: [],
        planText: '课程分为前期、中期、后期三个阶段推进：针对中考各项进行专项拆解练习。',
        subItems: ['长跑专项', '跳绳专项', '实心球专项'],
        subPlans: {
          '长跑专项': '本计划围绕中考长跑项目，系统提升有氧耐力与跑步经济性。',
          '跳绳专项': '本计划面向跳绳专项，强调耐力与节奏感的协同发展。',
          '实心球专项': '本计划聚焦实心球投掷的技术链条优化。'
        }
      },
      {
        id: 'kids_fitness', name: '少儿体能班',
        brief: '提升整体体能与协调性，增强自信心',
        defaultLessons: 10, images: [],
        planText: '以游戏化形式提升孩子的跑、跳、爬、钻、平衡等基础体能。',
        subItems: ['基础体能', '协调性训练', '平衡能力'],
        subPlans: {
          '基础体能': '通过趣味障碍跑、动物模仿爬行、追逐游戏等形式，全面提升儿童的力量、速度、耐力与灵活性。',
          '协调性训练': '借助多方向变向跑、手脚配合钻爬、节奏踏步等游戏化任务。',
          '平衡能力': '利用平衡木、软垫、单脚站立挑战等器材与情境，训练静态与动态平衡控制。'
        }
      },
      {
        id: 'rope', name: '跳绳班',
        brief: '跳绳基础与花样技巧训练，兼顾兴趣与考试',
        defaultLessons: 10, images: [],
        planText: '从单摇、双摇等基础节奏入手，逐步加入交叉跳、花样跳等技巧训练。',
        subItems: ['基础跳绳', '速度跳绳', '花样跳绳'],
        subPlans: {
          '基础跳绳': '从正确握绳、手腕摇动、双脚轻跳等基本要素入手，建立规范的单摇节奏。',
          '速度跳绳': '借助多方向变向跑、手脚配合钻爬、节奏踏步等游戏化任务。',
          '花样跳绳': '引入交叉跳、开合跳、弓步跳、双摇等基础花样动作。'
        }
      },
      {
        id: 'ball', name: '球类专项班',
        brief: '乒乓球、羽毛球、篮球、足球等专项兴趣培养',
        defaultLessons: 10, images: [],
        planText: '根据孩子选择的球类项目，从基本握拍、运球、传接球等动作教起。',
        subItems: ['乒乓球', '羽毛球', '篮球', '足球'],
        subPlans: {
          '乒乓球': '从握拍方式、基本站位、正反手推挡与攻球教起。',
          '羽毛球': '重点训练握拍转换、高远球挥拍轨迹、步法移动。',
          '篮球': '从持球姿势、原地运球、传接球准确性开始。',
          '足球': '围绕脚内侧传球、停球、带球变向、射门等核心技能展开训练。'
        }
      }
    ],
    form: {
      inviteCode: "",
      parentName: "",
      // 联系方式默认沿用手机号链路，兼容现有云函数和后续联系需求。
      phone: "",
      contact: "",
      // 课程基本信息：直接迁移 publish 页里的基础字段。
      frequency: "",
      location: "",
      latitude: "",
      longitude: "",
      // 课程目标：直接迁移 publish 页「第一类：课程目标」字段（选课程方向 + 标题 + 课程计划）。
      category: "",
      title: "",
      sub_plan_name: "",
      course_plan: "",
      description: "",
      // 孩子信息：直接迁移 publish 页里的多孩子录入结构。
      child_profiles: [],
      // 下面两个字段继续保留，方便和现有展示页兼容。
      childName: "",
      childAge: "",
      note: "",
    },
  },

  onLoad(options) {
    // 从分享链接携带的 inviteCode 参数进来时，先按统一规则规范化后再写入表单，避免链接里带格式字符导致匹配失败
    const inviteCode = normalizeInviteCode(options.inviteCode);
    if (inviteCode) {
      this.setData({
        routeInviteCode: inviteCode,
        "form.inviteCode": inviteCode,
      });
    }

    // 二维码入口：从 entry_landing「我要预约」跳转携带 sourceEntryId 等参数时记录入口上下文。
    // 作用：1) 页面顶部提示「来自 XX 机构/教练二维码入口」；2) 提交订单时随单透传 sourceEntryId 完成归因绑定。
    // 注意：这里只做上下文记录，不写任何永久绑定，绑定仍统一在 submitBooking 提交时发生。
    const sourceEntryId = String(options.sourceEntryId || "").trim();
    if (sourceEntryId) {
      // entryName 是中文参数，微信一般已解码，这里再兜一次 decode，失败就用原值。
      let entryName = String(options.entryName || "");
      try {
        entryName = decodeURIComponent(entryName);
      } catch (e) {
        // 解码失败保持原值即可
      }
      this.setData({
        entryContext: {
          sourceEntryId,
          targetType: String(options.targetType || "").trim(),
          targetId: String(options.targetId || "").trim(),
          entryName,
        },
      });
    }

    // 页面级开启分享入口：转发给好友 + 分享到朋友圈
    if (wx.showShareMenu) {
      wx.showShareMenu({
        withShareTicket: true,
        menus: ["shareAppMessage", "shareTimeline"],
      });
    }
  },

  onShow() {
    // tabbar 切入检查 globalData 兜底字段：entry_landing「我要预约」/ organization_show「去预约」
    // 切到本 tab 时，由于 tabBar 不能用 url 带参，识别码与二维码入口上下文改由 globalData 透传。
    // onLoad 只在首次创建时触发，tab 切回时不会重跑，因此兜底读取放 onShow 才能稳定生效。
    const app = getApp();
    if (app && app.globalData) {
      const gInviteCode = normalizeInviteCode(app.globalData.routeInviteCode || "");
      const gEntryContext = app.globalData.entryContext || null;
      if (gInviteCode) {
        this.setData({
          routeInviteCode: gInviteCode,
          "form.inviteCode": gInviteCode,
        });
        // 取出后立即清空，避免后续 onShow 反复触发。
        app.globalData.routeInviteCode = "";
      }
      if (gEntryContext && gEntryContext.sourceEntryId) {
        this.setData({
          entryContext: {
            sourceEntryId: String(gEntryContext.sourceEntryId || ""),
            targetType: String(gEntryContext.targetType || ""),
            targetId: String(gEntryContext.targetId || ""),
            entryName: String(gEntryContext.entryName || ""),
          },
        });
        app.globalData.entryContext = null;
      }
    }

    // tabbar 切入检查 modifyCourseId：从 parent_classshow「修改」按钮或 mine「修改」入口透传过来，
    // 也支持页面内 A tab「带这条去修改」自传递（onSelectHistory）。
    // 有值 → 修改模式：标记 isModify=true + 记下 courseId，自动切到 B 等待用户编辑；
    //                  bootstrap 仍按 latestRequest 回填默认表单，用户可以再在 B 里调整具体字段。
    // 无值 → 新建模式：清掉 isModify / modifyCourseId，沿用 bootstrap。
    const modifyCourseId = String(
      (app && app.globalData && app.globalData.modifyCourseId) || ""
    ).trim();
    if (modifyCourseId) {
      // 取出后立即清空，避免后续 onShow 反复触发修改模式。
      app.globalData.modifyCourseId = "";
      this.setData({
        isModify: true,
        modifyCourseId,
        activeTab: "current",
      });
    } else if (this.data.modifyCourseId) {
      // 上一次是修改模式但本次进入已无 id 透传 → 切回新建模式，避免误带 id 提交。
      this.setData({
        isModify: false,
        modifyCourseId: "",
      });
    }

    this.bootstrap();
  },

  async bootstrap() {
    this.setData({ loading: true });
    try {
      const result = await parentApi.login();
      const latestRequest = result.latestRequest || null;
      const parent = result.parent || null;
      const nextData = {
        loading: false,
      };

      if (latestRequest && latestRequest.targetSnapshot) {
        const childProfiles = this.normalizeChildProfiles(
          latestRequest.formSnapshot.childProfiles || [
            {
              nickname: latestRequest.formSnapshot.childName || "",
              age: latestRequest.formSnapshot.childAge || "",
              gender: "",
              height: "",
              weight: "",
            },
          ]
        );

        nextData.invitePreview = latestRequest.targetSnapshot;
        const courseTargetState = this.buildCourseTargetState(latestRequest.formSnapshot);
        nextData.currentClassId = courseTargetState.currentClassId;
        nextData.currentClass = courseTargetState.currentClass;
        nextData.selectedSubName = courseTargetState.selectedSubName;
        nextData.form = {
          inviteCode: latestRequest.inviteCode || "",
          parentName: latestRequest.formSnapshot.parentName || "",
          phone: latestRequest.formSnapshot.phone || latestRequest.formSnapshot.contact || "",
          contact: latestRequest.formSnapshot.contact || latestRequest.formSnapshot.phone || "",
          frequency: latestRequest.formSnapshot.frequency || "",
          location: latestRequest.formSnapshot.location || "",
          latitude: latestRequest.formSnapshot.latitude || "",
          longitude: latestRequest.formSnapshot.longitude || "",
          category: latestRequest.formSnapshot.category || "",
          title: latestRequest.formSnapshot.title || "",
          sub_plan_name: latestRequest.formSnapshot.sub_plan_name || "",
          course_plan: latestRequest.formSnapshot.course_plan || "",
          description: latestRequest.formSnapshot.description || "",
          child_profiles: childProfiles,
          childName: latestRequest.formSnapshot.childName || "",
          childAge: latestRequest.formSnapshot.childAge || "",
          note: latestRequest.formSnapshot.note || "",
        };
      } else if (parent && parent.latestInviteCode) {
        // 路由传入的识别码优先级高于历史识别码，避免家长从带码分享链接进入后又被旧记录顶掉。
        const nextInviteCode = this.data.routeInviteCode || parent.latestInviteCode || this.data.form.inviteCode;
        nextData.form = {
          ...this.data.form,
          inviteCode: nextInviteCode,
        };
      }

      // 新增（扫码自动补识别码，2026-09-06）：路由携带的识别码（扫码落地页「我要预约」/ 带码分享链接）
      // 在任何分支下优先级都最高。上面第一个分支会用 latestRequest 把表单整体回填成「上一次约课」的机构，
      // 若不拦截，家长扫了 A 机构二维码进来却显示 B 机构的旧码与旧识别卡片。
      // 这里统一兜底：路由码覆盖表单识别码；识别卡片不属于路由码时清空 invitePreview，
      // 让下方静默识别用路由码重新拉取本次入口的机构卡片。
      const routeInviteCode = this.data.routeInviteCode;
      if (routeInviteCode) {
        nextData.form = {
          ...(nextData.form || this.data.form),
          inviteCode: routeInviteCode,
        };
        const previewCode = normalizeInviteCode(
          (nextData.invitePreview && nextData.invitePreview.inviteCode) || ""
        );
        if (previewCode !== routeInviteCode) {
          nextData.invitePreview = null;
        }
      }

      this.setData(nextData);

      // 如果当前页是带识别码进入，或者历史里只有识别码但还没有 targetSnapshot，
      // 这里主动静默识别一次，确保页面能直接展示"识别成功"的 view，不用用户再手点一遍按钮。
      const previewInviteCode =
        nextData.routeInviteCode ||
        (nextData.form && nextData.form.inviteCode) ||
        this.data.routeInviteCode ||
        this.data.form.inviteCode;
      const previewTarget = nextData.invitePreview || this.data.invitePreview;
      if (previewInviteCode && !previewTarget) {
        await this.resolveInvitePreview(previewInviteCode, true);
      }
    } catch (error) {
      this.setData({ loading: false });
      this.showError(error, "加载失败，请稍后重试");
    }

    // bootstrap 主流程结束（无论成功失败），异步拉取 A 历史预约列表。
    // 这里不 await，UI 已经在主流程后显示 B 表单；A 历史列表独立显示 loading / 列表。
    this.loadHistory();
  },

  // 拉取父页面中需要的所有约课记录（活跃 + 已结束）以供 A tabbar 展示。
  // 与 parent_classshow 的 getMyCourse.allCourses 走同一条接口，保证 A/B 两边看到的历史保持一致。
  async loadHistory() {
    if (this.data.historyLoading) {
      return;
    }
    this.setData({ historyLoading: true });
    try {
      const result = await parentApi.getMyCourse();
      const allCourses = Array.isArray(result.allCourses) ? result.allCourses : [];
      const decorated = allCourses
        .map((item) => decorateHistoryItem(item))
        .filter((item) => item && item.courseId)
        // 修改模式：被选中的课节在 B 中已处于编辑态，避免 A 中把它再当作「带这条去修改」入口重复出现；
        // 如果需要从 B 反查 A 也可以在这里一并展示，依据当前需求忽略掉即可。
        .filter((item) => {
          if (this.data.modifyCourseId && item.courseId === this.data.modifyCourseId) {
            return false;
          }
          return true;
        });

      const historyActive = decorated.filter((item) => !TERMINAL_STATUS.includes(item.status));
      const historyTerminal = decorated.filter((item) => TERMINAL_STATUS.includes(item.status));

      this.setData({
        historyList: decorated,
        historyActive,
        historyTerminal,
        historyLoaded: true,
        historyLoading: false,
      });
    } catch (error) {
      this.setData({ historyLoading: false, historyLoaded: true });
      // history 列表拉取失败不中断表单主流程，只在控制台记录，由 A 中后续手动重试。
      console.warn("[parent_add] loadHistory failed:", error);
    }
  },

  // 页面内 tabbar 切换：A 历史预约 / B 当前选择。
  // 切换 A 时如果历史列表还没拉过，触发一次拉取；
  // 切换 B 时不带参数，只切视图。
  switchTab(e) {
    const tab = String((e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.tab) || "").trim();
    if (!tab || (tab !== "history" && tab !== "current")) {
      return;
    }
    if (tab === this.data.activeTab) {
      return;
    }
    const nextData = { activeTab: tab };
    if (tab === "history" && !this.data.historyLoaded) {
      // 触发后台拉取，loadHistory 内部会把 historyLoading 置位让用户看到加载状态。
      this.loadHistory();
    }
    this.setData(nextData);
  },

  // 课程码参课子 tab 切换：current 内「表单提交 / 输入课程码」两个子视图。
  switchSubTab(e) {
    const tab = String((e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.tab) || "").trim();
    if (tab !== "form" && tab !== "code") {
      return;
    }
    this.setData({ subTab: tab });
  },

  // 课程码输入：保留原值（提交前统一去空格）。
  onCourseCodeInput(e) {
    this.setData({
      courseCodeInput: String((e && e.detail && e.detail.value) || ""),
    });
  },

  // 通过课程码参课：只需要课程码，调 DLforP__do/joinCourseByCode，成功后跳「上课信息」。
  async onJoinCourseByCode() {
    if (this.data.joinLoading) {
      return;
    }
    const courseCode = String(this.data.courseCodeInput || "").replace(/\s+/g, "").trim();
    if (!courseCode) {
      wx.showToast({ title: "请先输入课程码", icon: "none" });
      return;
    }
    this.setData({ joinLoading: true });
    try {
      const result = await parentApi.joinCourseByCode({ courseCode });
      this.setData({
        joinLoading: false,
        courseCodeInput: "",
      });
      wx.showToast({
        title: (result && result.message) || "参课成功",
        icon: "success",
      });
      setTimeout(() => {
        wx.switchTab({ url: "/pages/index/parent_classshow/parent_classshow" });
      }, 500);
    } catch (error) {
      this.setData({ joinLoading: false });
      this.showError(error, "参课失败，请稍后重试");
    }
  },

  // A tab 中点击某条历史预约 / 课节：
  // 1) 把 courseId 写入 globalData.modifyCourseId（与 parent_classshow「修改」入口共用同一条路径）；
  // 2) 切到 B tab，让用户在表单页内继续修改这条课节的信息；
  // 3) 设置 isModify + modifyCourseId，提交时 submitBooking 拿到 courseId 按 id 走 modify 分支覆写原约课记录；
  //    这里不再重新触发 bootstrap 把 latestRequest 重新拉一遍——
  //    用户可能已经在 B 中编辑过当前表单，重新加载会丢内容；
  //    回填仍以最新一次约课（latestRequest）为准由 onShow → bootstrap 决定，选中的课节仅作为提交覆盖对象。
  onSelectHistory(e) {
    const fromDataset = e && e.currentTarget && e.currentTarget.dataset;
    const courseId = String((fromDataset && fromDataset.courseId) || "").trim();
    if (!courseId) {
      wx.showToast({
        title: "该记录暂不可修改",
        icon: "none",
      });
      return;
    }
    const app = getApp();
    if (app && app.globalData) {
      app.globalData.modifyCourseId = courseId;
    }
    this.applyModifyCourseId(courseId);
    this.setData({ activeTab: "current" });
    wx.showToast({
      title: "已切换到该课节的修改模式",
      icon: "none",
      duration: 1500,
    });
  },

  // A tab 空状态点"去新建"或顶部「+ 新建约课」按钮：清掉可能的 modifyCourseId 标记 + 切到 B。
  goNewFromHistory() {
    // 同步清掉 globalData 里残留的 modifyCourseId，避免下次 onShow 又被拉回修改模式。
    const app = getApp();
    if (app && app.globalData) {
      app.globalData.modifyCourseId = "";
    }
    this.setData({
      activeTab: "current",
      isModify: false,
      modifyCourseId: "",
    });
  },

  // 把 modifyCourseId 应用到页面状态（isModify + modifyCourseId + 切到 B）。
  // 与 onShow 中读取 globalData.modifyCourseId 的处理保持一致，
  // 单独提取是为了页面内 A → B 自传递的场景不需要依赖 globalData 中转。
  applyModifyCourseId(courseId) {
    if (!courseId) {
      return;
    }
    this.setData({
      isModify: true,
      modifyCourseId: courseId,
    });
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    let value = e.detail.value;

    // 联系方式这里直接收口为手机号，避免录入乱格式。
    if (field === "contact") {
      value = String(value || "").replace(/\D/g, "").slice(0, 11);
    }

    // 识别码录入时实时规范化：自动去空格/破折号/下划线等非字母数字字符、转大写、截断16位。
    // 这样用户看到的输入内容与后端存储/匹配规则完全一致，不会出现"前端显示有字符但后端说识别码不存在"的情况。
    if (field === "inviteCode") {
      value = normalizeInviteCode(value);
    }

    const nextData = {
      [`form.${field}`]: value,
    };

    // 只要用户手动改了识别码，就先清空旧的识别结果，避免页面还显示上一次识别成功的对象卡片。
    if (field === "inviteCode") {
      const currentPreviewCode = normalizeInviteCode(
        (this.data.invitePreview && this.data.invitePreview.inviteCode) || ""
      );
      if (!value || value !== currentPreviewCode) {
        nextData.invitePreview = null;
      }
    }

    this.setData(nextData);
  },

  // 根据历史回填的课程目标字段，匹配出课程类型卡片选中态（复刻 publish_classcreate 的 applyOrderToForm 回填逻辑）。
  buildCourseTargetState(snapshot) {
    const categoryName = String((snapshot && snapshot.category) || "").trim();
    const savedSubPlanName = String((snapshot && snapshot.sub_plan_name) || "").trim();
    const matchedClass = this.data.classTypes.find((item) => item.name === categoryName) || null;
    return {
      currentClassId: matchedClass ? matchedClass.id : null,
      currentClass: matchedClass,
      selectedSubName: savedSubPlanName || null,
    };
  },

  buildAutoCourseTitle(className = "", subPlanName = "") {
    const baseName = String(subPlanName || className || "").trim();
    return baseName ? `${baseName}课程` : "";
  },

  onSelectClass(e) {
    const id = e.currentTarget.dataset.id;
    if (id === this.data.currentClassId) {
      return;
    }
    const cls = this.data.classTypes.find((item) => item.id === id);
    this.setData({
      currentClassId: id,
      currentClass: cls,
      selectedSubName: null,
    });
    this.setData({
      "form.category": cls.name,
      "form.title": this.buildAutoCourseTitle(cls.name, ""),
      "form.sub_plan_name": "",
      "form.description": `我想学习${cls.name}，${cls.brief}。`,
      "form.course_plan": cls.planText || "",
    });
  },

  onSelectSubItem(e) {
    const parentId = e.currentTarget.dataset.parentId;
    const name = e.currentTarget.dataset.name;
    const targetClass = this.data.classTypes.find((item) => item.id === parentId);
    this.setData({
      currentClassId: parentId,
      currentClass: targetClass,
      selectedSubName: name,
    });
    this.setData({
      "form.category": targetClass.name,
      "form.title": this.buildAutoCourseTitle(targetClass.name, name),
      "form.sub_plan_name": name,
      "form.description": `我想学习${targetClass.name}，专项练习：${name}。`,
      "form.course_plan": (targetClass.subPlans && targetClass.subPlans[name]) || targetClass.planText || "",
    });
  },

  // 多孩子录入结构直接复用 publish 页的思路。
  normalizeChildProfiles(childProfiles = []) {
    const safeList = Array.isArray(childProfiles) ? childProfiles : [];
    const normalizedList = safeList.map((item) => ({
      nickname: String((item || {}).nickname || "").trim(),
      age: String((item || {}).age || "").trim(),
      gender: String((item || {}).gender || "").trim(),
      height: String((item || {}).height || "").trim(),
      weight: String((item || {}).weight || "").trim(),
    }));

    return normalizedList.filter(
      (item) => item.nickname || item.age || item.gender || item.height || item.weight
    );
  },

  onChildProfileInput(e) {
    const index = Number(e.currentTarget.dataset.index || 0);
    const field = String(e.currentTarget.dataset.field || "").trim();
    if (!field) {
      return;
    }

    const childProfiles = Array.isArray(this.data.form.child_profiles)
      ? [...this.data.form.child_profiles]
      : [];
    let value = String((e.detail || {}).value || "");

    if (field === "age") {
      value = value.replace(/\D/g, "");
    }

    childProfiles[index] = {
      ...(childProfiles[index] || { nickname: "", age: "", gender: "", height: "", weight: "" }),
      [field]: value,
    };

    this.setData({
      "form.child_profiles": childProfiles,
    });
  },

  onChildGenderChange(e) {
    const index = Number(e.currentTarget.dataset.index || 0);
    const childProfiles = Array.isArray(this.data.form.child_profiles)
      ? [...this.data.form.child_profiles]
      : [];

    childProfiles[index] = {
      ...(childProfiles[index] || { nickname: "", age: "", gender: "", height: "", weight: "" }),
      gender: e.detail.value || "",
    };

    this.setData({
      "form.child_profiles": childProfiles,
    });
  },

  addChildProfile() {
    const childProfiles = Array.isArray(this.data.form.child_profiles)
      ? [...this.data.form.child_profiles]
      : [];

    childProfiles.push({
      nickname: "",
      age: "",
      gender: "",
      height: "",
      weight: "",
    });

    this.setData({
      "form.child_profiles": childProfiles,
    });
  },

  removeChildProfile(e) {
    const index = Number(e.currentTarget.dataset.index || 0);
    const childProfiles = Array.isArray(this.data.form.child_profiles)
      ? [...this.data.form.child_profiles]
      : [];

    childProfiles.splice(index, 1);

    this.setData({
      "form.child_profiles": childProfiles,
    });
  },

  // 位置选择只走 chooseLocation，不额外调用 getLocation，避免误触发未开通的定位链路。
  chooseLocation() {
    wx.chooseLocation({
      success: (res) => {
        this.setData({
          "form.location": res.name || res.address || "",
          "form.latitude": res.latitude || "",
          "form.longitude": res.longitude || "",
        });
      },
      fail: (error) => {
        this.handleChooseLocationFail(error);
      },
    });
  },

  // 拒绝定位权限后，直接引导用户去设置页打开，不让页面停在无反馈状态。
  handleChooseLocationFail(error) {
    const errMsg = String((error && error.errMsg) || "");
    if (errMsg.indexOf("cancel") > -1) {
      return;
    }

    if (errMsg.indexOf("auth deny") > -1 || errMsg.indexOf("authorize no response") > -1) {
      wx.showModal({
        title: "需要位置权限",
        content: "请选择上课地点前，请先允许小程序使用位置信息。",
        confirmText: "去开启",
        success: (res) => {
          if (!res.confirm) {
            return;
          }

          wx.openSetting({
            success: (settingRes) => {
              if (settingRes.authSetting && settingRes.authSetting["scope.userLocation"]) {
                this.chooseLocation();
                return;
              }

              wx.showToast({
                title: "请先开启位置权限",
                icon: "none",
              });
            },
            fail: () => {
              wx.showToast({
                title: "打开设置失败",
                icon: "none",
              });
            },
          });
        },
      });
      return;
    }

    wx.showToast({
      title: "无法打开位置选择",
      icon: "none",
    });
  },

  isValidPhone(value) {
    return /^1[3-9]\d{9}$/.test(String(value || "").trim());
  },

  // 识别码解析统一从这里收口：
  // 1) 手动点"识别"按钮时走这里
  // 2) 页面带识别码进入时也走这里
  // 3) silent=true 时只更新 view，不额外弹错误提示，避免首屏自动识别把用户吓到
  async resolveInvitePreview(inviteCode, silent = false) {
    const normalizedInviteCode = normalizeInviteCode(inviteCode);
    if (!normalizedInviteCode) {
      if (!silent) {
        wx.showToast({
          title: "请先输入识别码",
          icon: "none",
        });
      }
      return null;
    }

    this.setData({
      inviteLoading: true,
      "form.inviteCode": normalizedInviteCode,
    });

    try {
      const result = await parentApi.resolveInvite(normalizedInviteCode);
      const target = result.target || null;
      this.setData({
        inviteLoading: false,
        invitePreview: target,
      });
      return target;
    } catch (error) {
      this.setData({
        inviteLoading: false,
        invitePreview: null,
      });
      if (!silent) {
        this.showError(error, "识别码无效或未配置");
      }
      return null;
    }
  },

  async onResolveInvite() {
    // 点击"识别"按钮时，按统一规则再次规范化识别码，防止 onInput 之外的路径（例如从历史记录回填）漏过格式化步骤
    const inviteCode = normalizeInviteCode(this.data.form.inviteCode);
    await this.resolveInvitePreview(inviteCode, false);
  },

  async onSubmit() {
    // 防重复提交：提交进行中直接拦截，避免连点产生重复约课单（提交一次 / 修改信息 / 新建预约）。
    if (this.data.submitLoading) {
      return;
    }
    const form = this.data.form;
    const childProfiles = this.normalizeChildProfiles(form.child_profiles);
    const firstChild = childProfiles[0] || {
      nickname: "",
      age: "",
      gender: "",
      height: "",
      weight: "",
    };

    // 识别码改为必填：家长必须先输入识别码并通过"识别"校验，确保约课单能正确落到对应教练/机构名下。
    // 任务位置、联系方式依然为必填；家长尊称、孩子信息为非必填。
    // 这里强制调用统一规则 normalizeInviteCode，做最后一次兜底，确保即使前面有任何路径绕过了 onInput 格式化，提交到后端的 inviteCode 口径也是一致的。
    const normalizedInviteCode = normalizeInviteCode(form.inviteCode);
    if (!normalizedInviteCode || !form.contact || !form.location) {
      wx.showToast({
        title: "请先填写完整信息",
        icon: "none",
      });
      return;
    }

    if (!this.isValidPhone(form.contact)) {
      wx.showToast({
        title: "请填写正确的11位手机号",
        icon: "none",
      });
      return;
    }

    this.setData({ submitLoading: true });

    try {
      // 识别码改为必填：必须确保识别码对应的教练/机构对象存在。
      // 如果当前页面还没有 invitePreview，或者用户改了识别码还没重新点"识别"，这里主动调一次 resolveInvite。
      if (!this.data.invitePreview || this.data.invitePreview.inviteCode !== normalizedInviteCode) {
        await this.onResolveInvite();
        if (!this.data.invitePreview) {
          this.setData({ submitLoading: false });
          return;
        }
      }

      // 二维码入口归因：从落地页带进来的 sourceEntryId 在「提交订单」这一步随单上报，
      // 落地页 / 本页都不写任何用户-机构永久绑定，绑定只在提交这一刻发生（与两层绑定设计一致）。
      const entryContext = this.data.entryContext || {};

      const submitResult = await parentApi.submitBooking({
        inviteCode: normalizedInviteCode,
        parentName: form.parentName,
        phone: form.contact,
        contact: form.contact,
        frequency: form.frequency,
        location: form.location,
        latitude: form.latitude,
        longitude: form.longitude,
        // 课程目标：跟随约课表单一并提交，落库到 course_target 并透传给 A 端创建班课程。
        category: form.category,
        title: form.title,
        sub_plan_name: form.sub_plan_name,
        course_plan: form.course_plan,
        description: form.description,
        childName: firstChild.nickname,
        childAge: firstChild.age,
        childProfiles: childProfiles,
        note: form.note,
        // 新增：家长提交的课程默认进入"待编辑"阶段，确保 A 端教练/机构管理层拿到后
        // 可以直接进入「创建班级课程」编辑态与「课节管理」调整总课时，
        // 避免 fulfill_state 被云函数写死为 pending 导致权限全锁。
        fulfill_state: "editing",
        // 新增：二维码入口上下文（扫码进入时才有值，普通分享/手动进入为空字符串，不影响原链路）。
        sourceEntryId: entryContext.sourceEntryId || "",
        sourceTargetType: entryContext.targetType || "",
        sourceTargetId: entryContext.targetId || "",
        // 新增（带 id 修改，2026-10-13）：从 parent_classshow「修改」入口或本页 A 历史预约
        // 「带这条去修改」入口透传的 courseId。
        // 云函数 submitBooking 收到 courseId 时按 id 直接定位待修改课程，走 modify 分支覆写原记录；
        // 没带 courseId 时仍走原「按识别码下的活跃课程」自动判断。
        courseId: this.data.modifyCourseId || "",
      });

      this.setData({ submitLoading: false });
      // 修改成功后清理全局 modifyCourseId，避免下一次回 B 时误带 id。
      const app = getApp();
      if (app && app.globalData) {
        app.globalData.modifyCourseId = "";
      }
      wx.showToast({
        title: submitResult && submitResult.mode === "modify" ? "信息已更新" : "提交成功",
        icon: "success",
      });

      // 阶段5-2：跳转延迟 300ms → 500ms，给云函数写入子集合留足缓冲，
      // 避免 classshow 切过来时子集合还没写完读到空。
      setTimeout(() => {
        wx.switchTab({
          url: "/pages/index/parent_classshow/parent_classshow",
        });
      }, 500);
    } catch (error) {
      this.setData({ submitLoading: false });
      this.showError(error, "提交失败，请稍后重试");
    }
  },

  showError(error, fallbackText) {
    const message = (error && (error.message || error.errMsg)) || fallbackText;
    wx.showToast({
      title: message,
      icon: "none",
    });
  },

  // 右上角「分享给好友」/ open-type="share" 按钮触发
  onShareAppMessage() {
    const app = getApp();
    const share = (app && app.globalData && app.globalData.share) || {};
    const inviteCode =
      this.data.routeInviteCode ||
      (this.data.invitePreview && this.data.invitePreview.inviteCode) ||
      this.data.form.inviteCode;
    return {
      title: share.title || "家长约课登记 - 填写约课需求",
      path: buildParentAddPath(inviteCode),
    };
  },

  // 右上角「分享到朋友圈」触发
  onShareTimeline() {
    const app = getApp();
    const share = (app && app.globalData && app.globalData.share) || {};
    const inviteCode =
      this.data.routeInviteCode ||
      (this.data.invitePreview && this.data.invitePreview.inviteCode) ||
      this.data.form.inviteCode;
    const normalizedInviteCode = normalizeInviteCode(inviteCode);
    return {
      title: share.title || "家长约课登记 - 填写约课需求",
      query: normalizedInviteCode ? `inviteCode=${encodeURIComponent(normalizedInviteCode)}` : "",
    };
  },
});