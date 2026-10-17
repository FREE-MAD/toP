const parentApi = require("../../../utils/parent-api");

// 家长查看孩子上课信息页：
// 这里是第二个 tabbar 页面，专门用于查看当前排课状态和已安排课程。
// 这里也统一补带识别码的路径，方便家长从课程页返回填写页时继续沿用当前绑定对象。
// 路径拼接 / 识别码规范化统一收口到 utils/parent-api.js，全端页面共用一份，不再在本页拷贝。
const buildParentAddPath = parentApi.buildParentAddPath;
const normalizeInviteCode = parentApi.normalizeInviteCode;

// 状态颜色映射（与 wxss status-xxx 配套，wxml 用 status-{{statusClass}}）。
const STATUS_COLOR_MAP = {
  editing: "gray",
  awaiting: "orange",
  in_progress: "green",
  completed: "darkgreen",
  cancelled: "red",
  closed: "darkgray",
  pending: "blue",
  // 旧 4 档兼容（历史 course 文档）
  scheduled: "green",
  finished: "darkgreen",
};

// 终态集合：A/B 历史记录里标记「已结束」的判定口径，与 parent_add 共用。
const TERMINAL_STATUS = ["completed", "cancelled", "closed", "finished"];

// 把云函数返回的原始 course 记录适配为视图模型：
// 1) statusText 兜底（非终态→待安排；终态→已结束）
// 2) updatedAtText 转成「YYYY-MM-DD HH:mm」展示
// 3) status 规范化小写
function decorateCourseItem(raw) {
  if (!raw) {
    return null;
  }
  const formSnapshot = (raw.formSnapshot && typeof raw.formSnapshot === "object") ? raw.formSnapshot : {};
  const status = String(raw.status || "").toLowerCase().trim();
  const updatedAtMs = Number(raw.updatedAt || raw.createdAt || 0);
  let updatedAtText = "";
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
    updatedAtText,
  };
}

Page({
  data: {
    loading: true,
    latestRequest: null,
    parentCourseCode: "",
    statusClass: "blue",
    // 新增（parent_classshow 三段展示，2026-10-13）：除当前课程外的活跃课程列表 + 终态历史列表。
    // 三段定义：
    //   当前课程 = latestRequest（家长最最新一条，主卡片展示）
    //   多个课程 = otherActive（除 latestRequest 外的非终态课程）
    //   历史记录 = otherTerminal（除 latestRequest 外的终态课程：completed/cancelled/closed/finished）
    otherActive: [],
    otherTerminal: [],
    // 全量课程列表（A 历史记录的原始数据来源，与 latestRequest 一起保存）。
    allCourses: [],
    // 页面内 tabbar：A 历史记录 / B 当前课程。
    activeTab: "current",
    // B tab 当前展示的课节 id，默认等于 latestRequest.courseId。
    // 通过 A 中点击「切换到此课节」更新此值，B 视图随之重渲染对应课节。
    selectedCourseId: "",
    // B tab 当前展示的课节对象（基于 selectedCourseId 从 latestRequest / allCourses 中挑选）。
    currentCourse: null,
    // 当前 B tab 展示的是否为最新课节（控制 tab 标签与「返回最新课程」按钮的显隐）。
    isShowingLatest: true,
    // B tab 的动态标签文案：当前展示的是最新课节时显示「当前课程」，否则显示「正在查看：xxx」。
    currentTabLabel: "当前课程",
    // A tab 历史记录总数（用于 inner-tab 的 count 徽章）。
    historyTotalCount: 0,
  },

  onShow() {
    this.loadData();
  },

  async loadData() {
    this.setData({ loading: true });
    try {
      const result = await parentApi.getMyCourse();
      const latestRequestRaw = result.latestRequest || null;
      const allCoursesRaw = Array.isArray(result.allCourses) ? result.allCourses : [];
      const latestRequest = decorateCourseItem(latestRequestRaw);
      const allCourses = allCoursesRaw
        .map((item) => decorateCourseItem(item))
        .filter((item) => item);

      // 全量分类（2026-10-13 调整）：A 历史记录 tab 拉取并展示全部课程（含最新一条 latestRequest），
      // 不再把最新课程从列表里排除——用户在 A 中能看到自己所有约课记录并随意切换。
      // B 当前课程 tab 仍以 latestRequest / selectedCourseId 为准，两边互不影响。
      const otherActive = allCourses.filter((c) => {
        if (!c) return false;
        return !TERMINAL_STATUS.includes(c.status);
      });
      const otherTerminal = allCourses.filter((c) => {
        if (!c) return false;
        return TERMINAL_STATUS.includes(c.status);
      });

      // B tab 回退判定用的最新课程 id（latestRequest.courseId）。
      const latestId = (latestRequest && latestRequest.courseId) || "";

      // 新增：把最新课程码从 latestRequest 中统一收口。
      let nextCourseCode = "";
      if (latestRequest) {
        const safeCourseCode = String(latestRequest.parentCourseCode || "").trim();
        nextCourseCode = safeCourseCode;
      }

      const statusClass = STATUS_COLOR_MAP[(latestRequest && latestRequest.status) || "pending"] || "blue";

      // 计算 B tab 当前展示的课节：默认走 latestRequest，selectedCourseId 为空时也回退到 latestRequest。
      // 如果 selectedCourseId 在新数据里找不到对应的 course（云函数刷新后旧记录被删/状态变化），
      // 也回退到 latestRequest，避免 B 视图悬空。
      let selectedCourseId = this.data.selectedCourseId || "";
      if (!selectedCourseId || selectedCourseId === latestId) {
        selectedCourseId = latestId;
      } else {
        const stillExists = allCourses.some((c) => c.courseId === selectedCourseId) || (latestRequest && latestRequest.courseId === selectedCourseId);
        if (!stillExists) {
          selectedCourseId = latestId;
        }
      }

      const currentCourse = this.resolveCurrentCourse(selectedCourseId, latestRequest, allCourses);
      const isShowingLatest = !!latestRequest && currentCourse && currentCourse.courseId === latestRequest.courseId;

      // B tab 标签：当前展示的是最新课节时用「当前课程」，否则显示「正在查看：xx」（图标在 wxml 中渲染）
      const currentTabLabel = isShowingLatest
        ? "当前课程"
        : (currentCourse && currentCourse.targetSnapshot && currentCourse.targetSnapshot.displayName)
          ? `正在查看：${currentCourse.targetSnapshot.displayName}`
          : "当前课程";

      this.setData({
        loading: false,
        latestRequest,
        parentCourseCode: nextCourseCode,
        statusClass,
        otherActive,
        otherTerminal,
        allCourses,
        selectedCourseId,
        currentCourse,
        isShowingLatest,
        currentTabLabel,
        historyTotalCount: otherActive.length + otherTerminal.length,
      });
    } catch (error) {
      this.setData({ loading: false });
      this.showError(error, "加载失败，请稍后重试");
    }
  },

  // 根据 selectedCourseId 选出 B tab 当前展示的 course 对象：
  // 1) 等于 latestRequest.courseId 时直接走 latestRequest（兼容 builderLatestRequest 在 latestRequest 上铺的扩展字段）；
  // 2) 从 allCourses 中精确查找；
  // 3) 找不到则回退到 latestRequest（让 B 永远有内容展示）。
  resolveCurrentCourse(selectedCourseId, latestRequest, allCourses) {
    if (!selectedCourseId) {
      return latestRequest;
    }
    if (latestRequest && latestRequest.courseId === selectedCourseId) {
      return latestRequest;
    }
    const found = (allCourses || []).find((c) => c && c.courseId === selectedCourseId);
    return found || latestRequest;
  },

  // 页面内 tabbar 切换：A 历史记录 / B 当前课程。
  switchTab(e) {
    const tab = String((e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.tab) || "").trim();
    if (!tab || (tab !== "history" && tab !== "current")) {
      return;
    }
    if (tab === this.data.activeTab) {
      return;
    }
    this.setData({ activeTab: tab });
  },

  // A tab 中点击「切换到此课节」：把 selectedCourseId 切到对应 course，再自动跳到 B tab。
  onSelectHistory(e) {
    const fromDataset = e && e.currentTarget && e.currentTarget.dataset;
    const courseId = String((fromDataset && fromDataset.courseId) || "").trim();
    if (!courseId) {
      wx.showToast({
        title: "暂无可查看的课节",
        icon: "none",
      });
      return;
    }
    const latestRequest = this.data.latestRequest;
    const latestId = (latestRequest && latestRequest.courseId) || "";

    let currentCourse;
    if (latestId && courseId === latestId) {
      currentCourse = latestRequest;
    } else {
      currentCourse = (this.data.allCourses || []).find((c) => c && c.courseId === courseId) || null;
    }
    if (!currentCourse) {
      // 全量数据里也没找到（极端情况：云函数刚刷新但本地缓存的列表还没更新）。
      // 这里直接用一次强制刷新，然后再切，避免 B 视图悬空。
      this.loadData().then(() => {
        this.applyCourseSelection(courseId);
      });
      return;
    }
    this.applyCourseSelection(courseId);
  },

  // 把 selectedCourseId 应用到 data 中（更新 currentCourse、tab label、isShowingLatest）。
  applyCourseSelection(courseId) {
    if (!courseId) {
      return;
    }
    const latestRequest = this.data.latestRequest;
    const latestId = (latestRequest && latestRequest.courseId) || "";
    const currentCourse = this.resolveCurrentCourse(courseId, latestRequest, this.data.allCourses || []);
    if (!currentCourse) {
      return;
    }
    const isShowingLatest = !!latestRequest && currentCourse.courseId === latestRequest.courseId;
    const currentTabLabel = isShowingLatest
      ? "当前课程"
      : (currentCourse.targetSnapshot && currentCourse.targetSnapshot.displayName)
        ? `正在查看：${currentCourse.targetSnapshot.displayName}`
        : "当前课程";

    this.setData({
      activeTab: "current",
      selectedCourseId: courseId,
      currentCourse,
      isShowingLatest,
      currentTabLabel,
      // 切到 B 时把 statusClass 也按当前展示课程的状态重新计算，让徽章颜色一致。
      statusClass: STATUS_COLOR_MAP[currentCourse.status] || "blue",
      parentCourseCode: currentCourse.parentCourseCode || "",
    });
  },

  goParentAdd() {
    // parent_add 已是 tabBar 页面，必须用 switchTab 切换。
    // 新建模式：不透传 modifyCourseId，parent_add onShow 走 bootstrap 新建路径。
    wx.switchTab({
      url: "/pages/index/parent_add/parent_add",
    });
  },

  // 新增（带 id 修改，2026-10-13）：从 parent_classshow「修改约课信息」入口透传 courseId。
  // 切到 parent_add tab，parent_add onShow 检测到 globalData.modifyCourseId 后走修改模式，
  // 提交时 submitBooking 拿到 courseId 按 id 走 modify 分支覆写原约课记录。
  // 入参：可选 e.currentTarget.dataset.courseId —— 多个课程/历史记录列表里点击「修改」时透传指定 courseId；
  //       不传时默认取 latestRequest.courseId（主卡片「修改约课信息」按钮命中）。
  goParentModify(e) {
    const fromDataset = e && e.currentTarget && e.currentTarget.dataset;
    const datasetCourseId = String((fromDataset && fromDataset.courseId) || "").trim();
    // 如果有 data-course-id 走它，否则走当前 B tab 展示的课节，避免依赖全局 latestRequest
    // 让用户在 B 中切换到任意历史课节后点「修改此课节」都能正确透传对应 id。
    const courseId =
      datasetCourseId ||
      (this.data.currentCourse && this.data.currentCourse.courseId) ||
      (this.data.latestRequest && this.data.latestRequest.courseId) ||
      "";
    if (!courseId) {
      wx.showToast({
        title: "暂无可修改的约课记录",
        icon: "none",
      });
      return;
    }
    const app = getApp();
    if (app && app.globalData) {
      app.globalData.modifyCourseId = courseId;
    }
    wx.switchTab({
      url: "/pages/index/parent_add/parent_add",
    });
  },

  // 课节列表 / 每日总结：跳转到与 A 端同款的展示页，传课程 id（latestRequest.courseId）。
  goCourseDetail(e) {
    let courseId = String((this.data.currentCourse && this.data.currentCourse.courseId) || "").trim();
    const fromDataset = e && e.currentTarget && e.currentTarget.dataset;
    const datasetCourseId = String((fromDataset && fromDataset.courseId) || "").trim();
    if (datasetCourseId) {
      courseId = datasetCourseId;
    }
    if (!courseId) {
      wx.showToast({
        title: "暂无课程可查看",
        icon: "none",
      });
      return;
    }
    wx.navigateTo({
      url: `/pages/task/progress/progress_specialOperation/progress_specialOperation?id=${courseId}`,
    });
  },

  // 新增（三段展示配套，2026-10-13）：从多个课程/历史记录列表里点击「查看详情」时按 courseId 跳转。
  // 入参：e.currentTarget.dataset.courseId —— wxml 透传该条课程的 courseId。
  goCourseDetailById(e) {
    const courseId = String(
      (e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.courseId) || ""
    ).trim();
    if (!courseId) {
      wx.showToast({
        title: "暂无课程可查看",
        icon: "none",
      });
      return;
    }
    wx.navigateTo({
      url: `/pages/task/progress/progress_specialOperation/progress_specialOperation?id=${courseId}`,
    });
  },

  showError(error, fallbackText) {
    const message = (error && (error.message || error.errMsg)) || fallbackText;
    wx.showToast({
      title: message,
      icon: "none",
    });
  },

  copyParentCourseCode(e) {
    const fromDataset = e && e.currentTarget && e.currentTarget.dataset;
    const datasetCode = String((fromDataset && fromDataset.code) || "").trim();
    const courseCode = datasetCode || String(this.data.parentCourseCode || "").trim();
    if (!courseCode) {
      wx.showToast({
        title: "暂无可复制课程码",
        icon: "none",
      });
      return;
    }

    wx.setClipboardData({
      data: courseCode,
      success: () => {
        wx.showToast({
          title: "课程码已复制",
          icon: "success",
        });
      },
      fail: () => {
        wx.showToast({
          title: "复制失败，请重试",
          icon: "none",
        });
      },
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
    const inviteCode = (this.data.latestRequest && this.data.latestRequest.inviteCode) || "";
    return {
      title: share.title || "家长约课登记 - 上课安排",
      path: buildParentAddPath(inviteCode),
    };
  },

  // 右上角「分享到朋友圈」触发
  onShareTimeline() {
    const app = getApp();
    const share = (app && app.globalData && app.globalData.share) || {};
    const inviteCode = (this.data.latestRequest && this.data.latestRequest.inviteCode) || "";
    const normalizedInviteCode = normalizeInviteCode(inviteCode);
    return {
      title: share.title || "家长约课登记 - 上课安排",
      query: normalizedInviteCode ? `inviteCode=${encodeURIComponent(normalizedInviteCode)}` : "",
    };
  },
});