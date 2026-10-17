// pages/task/progress/progress_specialOperation/progress_specialOperation.js
// 由 A 端同名页面直接复制（2026-10-11），展示「课节列表 / 每日总结」。
// 参数按 B 端标准：
//   1) 课程详情走 B 端 parentApi.getCourseDetail(courseId)（云函数 DLforP__do / action getCourseDetail），
//      返回体用 { success, data } 口径，不再用 A 端 { code, data }；
//   2) 家长端无客户端 openid / miniEnvVersion / enterSource，isCoach / isOwner 恒为 false，
//      教练操作台入口在家长端不展示；
//   3) 进入日志（add_entry_log）是教练侧分析能力，B 端云函数未提供，这里置为 no-op，避免误调不支持动作。
const app = getApp();
const parentApi = require('../../../../utils/parent-api');
// 课程状态 / 课节完成口径收敛到统一模块（与 A 端 utils/courseState.js 同源只读副本）。
// 本文件在 pages/task/progress/progress_specialOperation/，回小程序根退 4 层。
const courseState = require('../../../../utils/courseState');

Page({
  /**
   * 页面的初始数据
   */
  data: {
    statusBarHeight: 0,
    orderId: '',
    order: {
      title: '加载中...',
      category: '',
      description: '',
      location: '',
      price_interval: '',
      schedule: [],
      fulfill_state: ''
    },
    schedule: [],
    displaySchedule: [],
    isCoach: false,
    isOwner: false,
    isShareEntry: false,
    pageMode: 'normal',
    entryFrom: 'normal',
    sharerOpenid: '',
    hasRecordedEnter: false,
    statusText: '加载中...',
    currentStep: 0,
    createdTimeDisplay: '',
    historySyncedCount: 0,
    progressCompletedCount: 0,
    progressPendingCount: 0,
    progressTotalCount: 0,
    isDisplayGuideExpanded: true,
    isSubPlanExpanded: false
  },

  // 进入来源整理：先标记是否来自分享，再在分享态里区分分享者本人和普通查看者
  parseEntryOptions(options = {}) {
    const entryFrom = options.from || 'normal';
    const isShareEntry = entryFrom === 'share' || options.shareEntry === '1';

    return {
      entryFrom,
      isShareEntry,
      sharerOpenid: options.shareOpenid || ''
    };
  },

  // 页面模式整理：分享进入优先级最高，先分分享者本人，再分普通查看者
  resolvePageMode(myOpenid = '') {
    if (!this.data.isShareEntry) {
      return 'normal';
    }

    if (this.data.sharerOpenid && this.data.sharerOpenid === myOpenid) {
      return 'share_owner';
    }

    return 'share_viewer';
  },

  isShareOwnerMode() {
    return this.data.pageMode === 'share_owner' && this.data.isOwner;
  },

  // B 端无 add_entry_log 云函数动作，进入日志置为 no-op，避免误调不支持动作报错。
  recordEntryLog() {
    return Promise.resolve();
  },

  // 分组字段读取：展示页优先读取数据库中的结构化表单
  normalizeOrderView(orderData = {}) {
    const courseTarget = orderData.course_target || {};
    const courseBasic = orderData.course_basic || {};
    const childProfile = orderData.child_profile || {};
    const childProfiles = this.normalizeChildProfiles(
      (Array.isArray(orderData.child_profiles) && orderData.child_profiles.length)
        ? orderData.child_profiles
        : [{
            nickname: childProfile.nickname || orderData.child_nickname || '',
            age: childProfile.age || orderData.child_age || '',
            gender: childProfile.gender || orderData.child_gender || '',
            height: childProfile.height || orderData.child_height || '',
            weight: childProfile.weight || orderData.child_weight || ''
          }]
    );
    const firstChildProfile = childProfiles[0] || {};

    return {
      ...orderData,
      title: courseTarget.title || orderData.title || '',
      category: courseTarget.category || orderData.category || '',
      sub_plan_name: courseTarget.sub_plan_name || orderData.sub_plan_name || '',
      course_plan: courseTarget.course_plan || orderData.course_plan || '',
      description: courseTarget.description || orderData.description || '',
      frequency: courseBasic.frequency || orderData.frequency || '',
      location: courseBasic.location || orderData.location || '',
      contact: courseBasic.contact || orderData.contact || '',
      course_size_mode: courseBasic.course_size_mode || orderData.course_size_mode || '',
      // 多孩子展示：家长页优先展示 child_profiles，旧字段继续兼容第一个孩子
      child_profiles: childProfiles,
      child_nickname: firstChildProfile.nickname || '',
      child_age: firstChildProfile.age || '',
      child_gender: firstChildProfile.gender || '',
      child_height: firstChildProfile.height || '',
      child_weight: firstChildProfile.weight || ''
    };
  },

  // 多孩子展示收口：把旧单孩子数据也整理成统一数组
  normalizeChildProfiles(childProfiles = []) {
    const safeList = Array.isArray(childProfiles) ? childProfiles : [];
    const normalizedList = safeList.map(item => ({
      nickname: String((item || {}).nickname || '').trim(),
      age: String((item || {}).age || '').trim(),
      gender: String((item || {}).gender || '').trim(),
      height: String((item || {}).height || '').trim(),
      weight: String((item || {}).weight || '').trim()
    }));

    const filteredList = normalizedList.filter(item =>
      item.nickname || item.age || item.gender || item.height || item.weight
    );

    return filteredList;
  },

  // 课节展示状态：口径收敛到 utils/courseState.buildLessonMeta
  buildLessonDisplayMeta(lesson = {}) {
    const meta = courseState.buildLessonMeta(lesson);
    return {
      ...meta,
      isCompleted: meta.isRecorded
    };
  },

  // 进度展示整理：半途接入时在前面补一个历史汇总框
  buildDisplaySchedule(schedule, orderData = {}) {
    const historyCount = (((orderData || {}).history_sync || {}).syncedCount) || 0;
    const displaySchedule = [];

    if (historyCount > 0) {
      displaySchedule.push({
        isHistorySummary: true,
        actualIndex: -1,
        title: `0-${historyCount}`,
        statusText: '历史已完成',
        displayStatusClass: 'done',
        isCompleted: true
      });
    }

    (schedule || []).forEach((item, index) => {
      displaySchedule.push({
        ...item,
        actualIndex: index,
        isHistorySummary: false
      });
    });

    return displaySchedule;
  },

  // 表头计算：口径收敛到 utils/courseState.buildLessonProgress
  buildProgressSummary(orderData = {}, schedule = []) {
    const progress = courseState.buildLessonProgress({
      ...(orderData || {}),
      schedule: Array.isArray(schedule) ? schedule : ((orderData || {}).schedule || [])
    });
    const pendingCount = Math.max(progress.totalCount - progress.completedCount, 0);

    return {
      historySyncedCount: progress.historyCount,
      progressCompletedCount: progress.completedCount,
      progressPendingCount: pendingCount,
      progressTotalCount: progress.totalCount
    };
  },

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad(options) {
    const { statusBarHeight } = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
    const entryState = this.parseEntryOptions(options);

    this.setData({
      statusBarHeight,
      ...entryState
    });
    this.startDisplayGuideAutoCollapse();

    if (wx.showShareMenu) {
      wx.showShareMenu({
        menus: ['shareAppMessage', 'shareTimeline']
      });
    }

    if (options.id) {
      this.setData({ orderId: options.id });
      this.fetchOrderDetails(options.id);
      return;
    }

    wx.showToast({
      title: '参数错误',
      icon: 'none'
    });
  },

  onShow() {
    // B 端无 enterSource 全局信号，分享态不做「会话失效自动退出」处理，保持当前展示。
    if (this.shouldExitSharePreview()) {
      this.redirectAfterShareSessionExpired();
      return;
    }

    this.startDisplayGuideAutoCollapse();
  },

  // 班级展示页说明默认展开 5 秒后自动收起，减少顶部占位
  startDisplayGuideAutoCollapse() {
    this.clearDisplayGuideTimer();
    this.displayGuideTimer = setTimeout(() => {
      this.setData({ isDisplayGuideExpanded: false });
      this.displayGuideTimer = null;
    }, 5000);
  },

  clearDisplayGuideTimer() {
    if (!this.displayGuideTimer) {
      return;
    }

    clearTimeout(this.displayGuideTimer);
    this.displayGuideTimer = null;
  },

  // B 端无 enterSource 信号，默认不退出分享态（家长端分享查看保持只读展示）。
  shouldExitSharePreview() {
    return false;
  },

  // 分享态退出分流：B 端家长端没有教练操作台，统一回上课信息 tab。
  redirectAfterShareSessionExpired() {
    wx.switchTab({
      url: '/pages/index/parent_classshow/parent_classshow'
    });
  },

  // 教练操作台跳转：家长端无此入口，统一回上课信息 tab（仅 share_owner 自己点返回时命中，安全降级）。
  openCoachConsole() {
    wx.switchTab({
      url: '/pages/index/parent_classshow/parent_classshow'
    });
  },

  // 班级展示页说明支持手动展开/收起
  toggleDisplayGuide() {
    const nextExpanded = !this.data.isDisplayGuideExpanded;
    this.setData({ isDisplayGuideExpanded: nextExpanded });
    this.clearDisplayGuideTimer();
  },

  // 课程重点折叠开关：默认收起，点击后再展开查看当前子计划详情
  toggleSubPlanSection() {
    this.setData({
      isSubPlanExpanded: !this.data.isSubPlanExpanded
    });
  },

  /**
   * 获取订单详情：按 B 端标准走 parentApi.getCourseDetail(courseId)，
   * 返回体口径 { success, data }（非 A 端 { code, data }）。
   */
  fetchOrderDetails(orderId) {
    wx.showLoading({ title: '加载中' });

    return parentApi.getCourseDetail(orderId).then(result => {
      wx.hideLoading();
      wx.stopPullDownRefresh();

      if (!result || result.success === false) {
        wx.showToast({
          title: (result && result.message) || '加载失败',
          icon: 'none'
        });
        return;
      }

      const sourceOrderData = result.data || {};
      const orderData = this.normalizeOrderView(sourceOrderData);
      // 家长端：当前用户恒非教练 / 非发布者，只读查看。
      const isCoach = false;
      const isOwner = false;
      const myOpenid = '';
      const pageMode = this.resolvePageMode(myOpenid);
      const schedule = (orderData.schedule || []).map(item => ({
        ...item,
        ...this.buildLessonDisplayMeta(item)
      }));
      const displaySchedule = this.buildDisplaySchedule(schedule, orderData);
      const progressSummary = this.buildProgressSummary(orderData, schedule);

      this.setData({
        order: orderData,
        schedule,
        displaySchedule,
        isCoach,
        isOwner,
        pageMode,
        createdTimeDisplay: this.buildCreatedTimeDisplay(orderData),
        ...progressSummary
      });

      this.updateUIByState(courseState.readCourseState(orderData));
      this.recordEntryLog({
        sourcePage: this.data.entryFrom || 'normal'
      });
    }).catch(err => {
      wx.hideLoading();
      wx.stopPullDownRefresh();
      console.error('[progress_specialOperation] [fetchOrderDetails] 网络错误:', err);
      // B 端 callCloud 在 success===false 时 reject，错误体带 message（如「未找到课程」），这里透出真实原因。
      wx.showToast({
        title: (err && (err.message || err.errMsg)) || '网络错误',
        icon: 'none'
      });
    });
  },

  /**
   * 构造创建时间展示文案
   */
  buildCreatedTimeDisplay(orderData) {
    try {
      const rawCreatedTime = orderData.createdAt || orderData.create_time;
      const createdDate = rawCreatedTime ? new Date(rawCreatedTime) : null;

      if (!createdDate || Number.isNaN(createdDate.getTime())) {
        return '';
      }

      const month = `${createdDate.getMonth() + 1}`.padStart(2, '0');
      const day = `${createdDate.getDate()}`.padStart(2, '0');
      const hour = `${createdDate.getHours()}`.padStart(2, '0');
      const minute = `${createdDate.getMinutes()}`.padStart(2, '0');

      return `${month}月${day}日 ${hour}:${minute}`;
    } catch (error) {
      return '';
    }
  },

  /**
   * 更新页面状态展示
   */
  updateUIByState(fulfillState) {
    let statusText = '课程信息展示页';
    let currentStep = 0;

    if (courseState.isClosedState(fulfillState)) {
      statusText = '当前课程已关闭';
    }

    this.setData({
      statusText,
      currentStep
    });
  },

  /**
   * 跳转到课程详情页（每日总结）
   */
  handleToClassDetail(e) {
    if (Number(e.currentTarget.dataset.history || 0) === 1) {
      return;
    }

    const index = e.currentTarget.dataset.index;
    const lesson = this.data.schedule[index];

    if (!lesson) {
      return;
    }

    const lessonStr = encodeURIComponent(JSON.stringify(lesson));
    const orderId = this.data.orderId;
    const lessonNo = lesson.lesson || (Number(index) + 1);
    const isCoach = this.data.isCoach;
    const isRoleCoach = false;
    const isOwner = this.data.isOwner;
    const pageMode = this.data.pageMode || 'normal';
    const isShareEntry = this.data.isShareEntry ? 1 : 0;
    const entryFrom = this.data.entryFrom || 'normal';
    const sharerOpenid = this.data.sharerOpenid || '';

    wx.navigateTo({
      url: `/pages/task/progress/progress_specialOperation/progress_classdetailed/progress_classdetailed?lesson=${lessonStr}&index=${index}&lessonNo=${lessonNo}&orderId=${orderId}&isCoach=${isCoach}&isRoleCoach=${isRoleCoach}&isOwner=${isOwner}&pageMode=${pageMode}&isShareEntry=${isShareEntry}&from=${entryFrom}&shareOpenid=${sharerOpenid}&sourcePage=progress_specialOperation`
    });
  },

  // 教练操作台跳转：家长端无此入口，统一回上课信息 tab。
  handleGoCoachConsole() {
    if (!this.data.orderId) {
      return;
    }

    if (!this.data.isOwner) {
      wx.showToast({
        title: '仅课程所属教练可操作',
        icon: 'none'
      });
      return;
    }

    this.openCoachConsole();
  },

  // 分享路径：家长端分享本展示页，分享者本人 openid 在客户端不可用，留空，由后端按课程归属识别。
  onShareAppMessage() {
    const title = this.data.order.title || '课程进度';

    return {
      title,
      path: `/pages/task/progress/progress_specialOperation/progress_specialOperation?id=${this.data.orderId}&from=share&shareOpenid=`
    };
  },

  /**
   * 下拉刷新
   */
  onPullDownRefresh() {
    if (this.data.orderId) {
      this.fetchOrderDetails(this.data.orderId);
      return;
    }

    wx.stopPullDownRefresh();
  },

  onUnload() {
    this.clearDisplayGuideTimer();
  },

  onHide() {
    this.clearDisplayGuideTimer();
  }
})
