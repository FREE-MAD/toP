// ============================================================
// utils/courseState.js —— 前端课程流转状态的唯一真源
//
// 背景（2026-10-09 · 课程流转 T8）：
//   收敛前，前端有 4 套各自为政的状态判定：
//     progress.js / publish.js / progress_specialOperation.js / progress_classdetail.js
//   改一个状态口径要同时改 5 个文件，且「Tab 分类看 fulfill_state、完成数看有没有写 summary」
//   这种口径分裂就是这么来的。本模块把只读判定收敛到一处。
//
// 与后端的关系：
//   对应 cloudfunctions/NEW_DL_fun/_shared/courseState.js 的**只读部分**。
//   后端那份是 Node 云函数用的，这份是小程序用的，两边必须人工保持同步 ——
//   改状态值 / 后缀映射 / 课节完成口径时，**两份都要改**。
//
// B 端（代码_ToP）说明（2026-10-11）：
//   本文件由 A 端 miniprogram/utils/courseState.js 直接复制，供家长端
//   pages/task/progress/progress_specialOperation 系列展示页只读判定课程 / 课节状态。
//   本模块只做「读与判定」，不写任何数据。
// ============================================================

// ---------------------------------------------------------------------------
// 1. 课程生命周期状态（与后端 COURSE_STATE 一一对应）
// ---------------------------------------------------------------------------

const COURSE_STATE = {
  EDITING: 'editing',         // 待编辑
  AWAITING: 'awaiting',       // 待接取
  IN_PROGRESS: 'in_progress', // 进行中
  COMPLETED: 'completed',     // 已完成
  CANCELLED: 'cancelled',     // 已取消
  CLOSED: 'closed',           // 已结课
  PENDING: 'pending'          // 历史遗留值；前端也把它当作「状态未知」的哨兵，见 readCourseState
};

/** 终态：进入后不再接受接取 / 确认资料 / 生成接取码 */
const TERMINAL_STATES = [COURSE_STATE.COMPLETED, COURSE_STATE.CANCELLED, COURSE_STATE.CLOSED];

/** 接取码状态后缀（新码制：8 位课程码 + 2 位后缀） */
const STATE_SUFFIX = {
  PENDING_LESSON: 'pl',
  IN_PROGRESS: 'ip',
  DONE_LESSON: 'dl'
};

const STATE_HISTORY_FIELD = 'state_history';
const COURSE_FLOW_FIELD = 'course_flow_info';

/** 课节完成标记（后端 complete_lesson 写入 schedule[i].status） */
const LESSON_STATUS_DONE = 'DONE';

// ---------------------------------------------------------------------------
// 2. 基础工具
// ---------------------------------------------------------------------------

function pickState(primary, secondary, fallback) {
  const raw = (primary === undefined || primary === null ? '' : primary)
    || (secondary === undefined || secondary === null ? '' : secondary)
    || '';
  const value = String(raw).trim();
  return value || fallback;
}

function getCourseFlowInfo(order) {
  return (order && order[COURSE_FLOW_FIELD]) || {};
}

function getStateHistory(order) {
  const safeOrder = order || {};
  const top = Array.isArray(safeOrder[STATE_HISTORY_FIELD]) ? safeOrder[STATE_HISTORY_FIELD] : null;
  if (top && top.length) return top;
  const flow = getCourseFlowInfo(safeOrder);
  const inner = Array.isArray(flow[STATE_HISTORY_FIELD]) ? flow[STATE_HISTORY_FIELD] : null;
  return inner && inner.length ? inner : [];
}

/**
 * 读订单当前状态：内层 course_flow_info.fulfill_state 优先，回退顶层，再回退 order.status。
 *
 * 默认值刻意用 'pending'（而不是后端的 'editing'）：
 * 前端把「读不出明确状态」当成「需要按排课/接取情况兜底推断」的信号，
 * 三个显式判定（editing / awaiting / in_progress）都不成立时才走推断分支。
 * 改成 'editing' 会让所有老数据直接落「待编辑」Tab，不再走推断。
 */
function readCourseState(order, fallback) {
  const safeOrder = order || {};
  const flow = getCourseFlowInfo(safeOrder);
  return pickState(
    flow.fulfill_state,
    pickState(safeOrder.fulfill_state, safeOrder.status, ''),
    fallback === undefined ? COURSE_STATE.PENDING : fallback
  );
}

function isTerminalState(state) {
  const value = String(state || '').trim();
  if (!value) return false;
  return TERMINAL_STATES.indexOf(value) !== -1;
}

/** 已关闭 / 已取消（历史接取链路只挡这两个，不挡 completed） */
function isClosedState(state) {
  const value = String(state || '').trim();
  return value === COURSE_STATE.CLOSED || value === COURSE_STATE.CANCELLED;
}

/** 状态 → 后缀。awaiting / pending → pl；in_progress → ip；三个终态 → dl；其余 '' */
function stateSuffixOf(state) {
  const value = String(state || '').trim().toLowerCase();
  if (value === COURSE_STATE.AWAITING || value === COURSE_STATE.PENDING) return STATE_SUFFIX.PENDING_LESSON;
  if (value === COURSE_STATE.IN_PROGRESS) return STATE_SUFFIX.IN_PROGRESS;
  if (isTerminalState(value)) return STATE_SUFFIX.DONE_LESSON;
  return '';
}

/** 当前该展示的状态后缀：state_history 末尾优先，空则按 fulfill_state 兜底 */
function resolveStateSuffix(order) {
  const history = getStateHistory(order);
  if (history.length) {
    const last = String(history[history.length - 1] || '').toLowerCase();
    if (last === STATE_SUFFIX.PENDING_LESSON || last === STATE_SUFFIX.IN_PROGRESS || last === STATE_SUFFIX.DONE_LESSON) {
      return last;
    }
  }
  return stateSuffixOf(readCourseState(order, ''));
}

/**
 * 把订单归一成「显式状态」：state_history 末尾后缀优先映射成等价 fulfill_state，
 * 没有后缀时用 readCourseState 的值。用于 Tab 分类等需要单一状态字符串的场景。
 */
function normalizeExplicitState(order) {
  const suffix = resolveStateSuffix(order);
  if (suffix === STATE_SUFFIX.PENDING_LESSON) return COURSE_STATE.AWAITING;
  if (suffix === STATE_SUFFIX.IN_PROGRESS) return COURSE_STATE.IN_PROGRESS;
  if (suffix === STATE_SUFFIX.DONE_LESSON) return COURSE_STATE.COMPLETED;
  return readCourseState(order);
}

// ---------------------------------------------------------------------------
// 3. 课节完成判定（口径唯一真源）
// ---------------------------------------------------------------------------
//
// 口径（2026-10-09 Q1 已定）：**教练显式点「标记本节课完成」**才算完成，
// 后端 complete_lesson 写 schedule[i].status = 'DONE'。
// 「写了每日总结」只是**完成的前置条件**（isLessonRecorded），不等于完成。
//
// 因此存量课节（有记录、无 status）会显示为「待确认完成」，教练逐节点按钮补标即可。

/** 课节是否已写每日记录：总结内容 + 上课日期同时存在 */
function isLessonRecorded(lesson = {}) {
  const hasSummary = !!String(lesson.summary || '').trim();
  const hasSummaryDate = !!(lesson.summaryDate || lesson.startedAt || lesson.completedAt);
  return hasSummary && hasSummaryDate;
}

/** 课节是否已完成（后端已标记） */
function isLessonDone(lesson = {}) {
  return String(lesson.status || '').trim().toUpperCase() === LESSON_STATUS_DONE;
}

/**
 * 课节展示元信息（所有页面共用，避免各写一套）：
 *   isRecorded   已写每日记录（原 isCompleted 语义，仍用于锁定编辑器 / 课表锁定判据）
 *   isDone       已完成（后端 status === 'DONE'）
 *   canComplete  可标记完成（已记录但未完成）
 *   statusText   标准文案：已完成 / 待确认完成 / 待记录
 *   displayStatusClass  样式类：done / pending
 */
function buildLessonMeta(lesson = {}) {
  const isRecorded = isLessonRecorded(lesson);
  const isDone = isLessonDone(lesson);
  return {
    isRecorded,
    isDone,
    canComplete: isRecorded && !isDone,
    statusText: isDone ? '已完成' : (isRecorded ? '待确认完成' : '待记录'),
    displayStatusClass: (isDone || isRecorded) ? 'done' : 'pending'
  };
}

/**
 * 课程完成进度（所有页面共用口径）：
 *   已上完的课节数 = 半途接入的历史课节数 + schedule 里 status === 'DONE' 的课节数
 * 与后端 course_flow_info.progress_done 保持同一算法，但不依赖该字段是否已回填，
 * 因此 T7 回填前后前端显示都正确。
 */
function buildLessonProgress(order = {}) {
  const schedule = Array.isArray(order.schedule) ? order.schedule : [];
  const historyCount = Number((((order || {}).history_sync || {}).syncedCount) || 0);
  const doneScheduleCount = schedule.filter((item) => isLessonDone(item)).length;
  const fallbackTotalCount = historyCount + schedule.length;
  const rawTotal = Number(order.progress_total || fallbackTotalCount || 0);
  const totalCount = rawTotal > 0 ? rawTotal : fallbackTotalCount;
  const completedCount = Math.min(historyCount + doneScheduleCount, totalCount);

  return {
    schedule,
    historyCount,
    totalCount,
    completedCount,
    progressText: `${completedCount}/${totalCount}`
  };
}

module.exports = {
  COURSE_STATE,
  TERMINAL_STATES,
  STATE_SUFFIX,
  STATE_HISTORY_FIELD,
  COURSE_FLOW_FIELD,
  LESSON_STATUS_DONE,
  pickState,
  getCourseFlowInfo,
  getStateHistory,
  readCourseState,
  isTerminalState,
  isClosedState,
  stateSuffixOf,
  resolveStateSuffix,
  normalizeExplicitState,
  isLessonRecorded,
  isLessonDone,
  buildLessonMeta,
  buildLessonProgress
};
