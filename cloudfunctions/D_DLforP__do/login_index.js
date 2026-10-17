// B 侧家长端主入口云函数（login / submitBooking / getMyCourse 等）。
//
// ===== 拆双函数（2026-10-10）=====
// 本目录 D_DLforP__do 是「开发版」部署单元：环境固定 develop（读写 dev_ForP 等 dev_* 集合），登记在
// 文件下方 deploy-meta 块里，函数不读请求判断环境。
// 正式版 T_DLforP__do 由 cloudfunctions/sync-dev-to-true.js 从本目录镜像生成（人工执行，密码 NEWDL123），
// 环境固定 release（代表 real，读写 real_* 集合）——T_ 目录禁止手改。
// 前端（miniprogram/utils/parent-api.js）按小程序环境选 D_ / T_ 函数名，不再靠透传 envVersion 分流。
const https = require("https");
const cloud = require("wx-server-sdk");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

// ForP 按 dev_ForP / real_ForP 区分。
// 调整（2026-09-06）：从硬编码 dev_ForP 改为按 envVersion 动态分流——develop→dev_ForP，release/trial→real_ForP。
// 与 A 侧 NDLdev_/NDLreal_ 及 B 侧 DLforP_entry_qrcode 的 dev_/real_ 分流口径对齐。
// 注意：下面 4 个名字按当前项目口径统一视为 ForP 数据库里的 4 个字段，不再保留其它旧结构命名。
let FORP_DB_ALIAS = "dev_ForP";
const FORP_ENV_MAP = {
  // 开发态直接跟随当前云环境，避免本地调试时还要多维护一层环境映射。
  dev_ForP: cloud.DYNAMIC_CURRENT_ENV,
  // 真库环境后续单独配置；当前开发代码不在这里直接写死。
  real_ForP: "",
};

function createForPDb(dbAlias = FORP_DB_ALIAS) {
  const env = FORP_ENV_MAP[dbAlias] || cloud.DYNAMIC_CURRENT_ENV;
  return cloud.database({ env });
}

const db = createForPDb();
const _ = db.command;
// 当前按最新口径，B 不再依赖本地 twowaybinding_1_DLforP 上传，
// 直接由已在用的 DLforP__do 通过 HTTP 调 A 云端的 twowaybinding_1_DLforC。
// 拆双函数（2026-10-10）：A 侧该函数已拆成 D_/T_ 两个部署单元，地址按本次请求环境选择：
//   develop              → /devenv（A 侧 D_twowaybinding_1_DLforC，读写 NDLdev_ 集合）
//   其余（trial/release/空）→ /trueenv（A 侧 T_twowaybinding_1_DLforC，读写 NDLreal_ 集合）
// 路由为 A 侧 HTTP 访问服务实际配置（2026-10-10 确认）：/devenv、/trueenv。
// A_DLFORC_URL_LEGACY 是旧路由地址：迁移期「新地址路由不到」时由 requestAHttpApi 自动回退，
// 等双份部署验证通过、A 侧旧路由下线后，删掉该常量与回退分支即可。
const A_TENCLOUD_BASE_URL = "https://cloud1-6gh7jgl8c5b16a83-1398046944.ap-shanghai.app.tcloudbase.com";
const A_DLFORC_URL_DEV = `${A_TENCLOUD_BASE_URL}/devenv`;
const A_DLFORC_URL_TRUE = `${A_TENCLOUD_BASE_URL}/trueenv`;
const A_DLFORC_URL_LEGACY = `${A_TENCLOUD_BASE_URL}/twowaybinding_1_DLforC`;

// 按本次请求环境选 A 侧地址：仅 develop 走 D_，判定与 applyEnvVersion 的 dev/real 口径完全一致。
function resolveADLforCUrl(envVersion = "") {
  return envVersion === "develop" ? A_DLFORC_URL_DEV : A_DLFORC_URL_TRUE;
}
const SOURCE_FROM_B_PARENT = "在小程序B由家长提交经过api中转进入小程序A移交教练操作";
const BRIDGE_STATUS_PENDING = "pending";
const BRIDGE_STATUS_SYNCED = "synced";
const BRIDGE_STATUS_FAILED = "failed";
const ACTION_RESOLVE_INVITE = "resolveInvite";
const ACTION_SYNC_PARENT_BOOKING_TO_A = "syncParentBookingToA";
const ACTION_JOIN_COURSE_BY_CODE = "joinCourseByCode";
const SOURCE_FROM_B_JOIN_CODE = "在小程序B由家长输入课程码参课";

// 当前家长侧只保留 2 个实际数据合集：dev_ForP / real_ForP。
// P_identity / P_basic / P_CourseFormCollection / P_CourseWithCoach / TOP_invite_targets
// 就是 dev_ForP / real_ForP 这两个合集里的字段，不再当作独立合集创建。
// 调整（2026-09-06）：改为 let，由 applyEnvVersion 在请求入口动态赋值。
let FORP_COLLECTION = FORP_DB_ALIAS;
const IDENTITY_FIELD = "P_identity";
const BASIC_FIELD = "P_basic";
const FORM_FIELD = "P_CourseFormCollection";
const COURSE_FIELD = "P_CourseWithCoach";
// RECORD_FIELD_KEY 仅用于识别 / 清理历史存量旧文档（forPField 标记散落记录），
// 识别码链路（阶段5 收敛后）不再依赖它。
const RECORD_FIELD_KEY = "forPField";
// 阶段5-1（识别码收敛，2026-10-13）：机构类识别码的唯一本地缓存家收敛到 forPshowC
// （一机构一条投影文档，organizationId 唯一键，与门面页展示共用同一张表）。
// 旧 dev_invite_targets / real_invite_targets 集合停读停写，可手动删除；
// 旧 dev_ForP 顶层 TOP_invite_targets 混杂文档同样停读停写。
// 由 applyEnvVersion 动态切换 dev_forPshowC / real_forPshowC。
let SHOW_COLLECTION = "dev_forPshowC";
// 新增：识别码缓存——家长文档内嵌数组（只存该家长自己识别并使用过的码，对应"归到对应家长的文档下"的诉求）
const RECOGNIZED_HISTORY_FIELD = "P_recognized_invites";
// 阶段1-1：ForP 拆子集合——主文档瘦身，原内嵌数组拆到独立集合（dev_/real_ 各 3 个）。
// ForP_forms = 原 P_CourseFormCollection[]，ForP_courses = 原 P_CourseWithCoach[]，
// ForP_invites = 原 P_recognized_invites[]。由 applyEnvVersion 动态切换 dev_/real_ 前缀。
let FORP_FORMS_COLLECTION = "dev_ForP_forms";
let FORP_COURSES_COLLECTION = "dev_ForP_courses";
let FORP_INVITES_COLLECTION = "dev_ForP_invites";

// 新增（2026-09-06）：根据 envVersion 重新计算 FORP 相关集合名，在 exports.main 入口调用。
// 规则与 A 侧 getCollectionName 一致：develop 用 dev_ 前缀，其余（release/trial/空）用 real_ 前缀。
// dev 和 real 共用同一云环境（FORP_ENV_MAP 中 real_ForP 为空 → 回退 DYNAMIC_CURRENT_ENV），
// 仅通过集合名前缀做物理隔离，无需重建 db 实例。

// 新增（2026-09-07 修复）：记录本次请求实际生效的环境版本。
// 原因：B 侧通过 HTTP 调 A 侧 twowaybinding_1_DLforC（resolveInvite / syncParentBookingToA）时，
// 之前请求里不带 envVersion，A 侧取不到就默认 develop → 永远查 NDLdev_organization / 写 NDLdev_execution_orders，
// 导致 release 环境下识别码识别失败（机构实际在 NDLreal_organization）、正式订单桥接写串库。
// 这里收口为模块级变量，所有发往 A 侧的 HTTP 请求统一透传，口径与 A 侧一致：develop→dev 库，其余→real 库。
let CURRENT_ENV_VERSION = "develop";

function applyEnvVersion() {
  // 环境来自部署侧登记（deploy-meta）：D_ 恒 develop、T_ 恒 release，不再从请求读取。
  // 这里只把固定环境换算成集合前缀 / 别名（develop → dev_*，release → real_*），无任何环境判断。
  CURRENT_ENV_VERSION = DEPLOY_META.isDev ? "develop" : "release";
  const prefix = DEPLOY_META.isDev ? "dev_" : "real_";
  FORP_DB_ALIAS = `${prefix}ForP`;
  FORP_COLLECTION = FORP_DB_ALIAS;
  SHOW_COLLECTION = `${prefix}forPshowC`;
  FORP_FORMS_COLLECTION = `${prefix}ForP_forms`;
  FORP_COURSES_COLLECTION = `${prefix}ForP_courses`;
  FORP_INVITES_COLLECTION = `${prefix}ForP_invites`;
}

// ===== deploy-meta:start =====
// 关键字段登记（2026-10-10）：本部署单元「是哪一侧 / 环境固定为什么 / 源目录是谁」全部登记在这一块。
// 环境已由「部署哪个函数」物理固定（D_ = develop，T_ = real），业务代码不再读请求判断环境，一律以本块为准。
// 不可覆写：sync-dev-to-true.js 每次同步都会强制覆写 T_ 侧本块 —— D_ 源里的值到不了 T_，手改 T_ 也会在下一次同步被覆盖。
const DEPLOY_META = Object.freeze({
  side: 'D',                 // 'D' = 开发版部署单元；'T' = 正式版部署单元
  envVersion: 'develop',     // 固定环境：'develop'（dev_*）| 'release'（代表 real，real_*）
  isDev: true,               // = envVersion === 'develop' 的预计算值，业务代码直接用，不再做 === 'develop' 判断
  sourceDir: 'D_DLforP__do', // 源目录（T_ 侧登记它镜像的 D_ 目录名；仅排查用）
  managedBy: 'sync-dev-to-true.js'
});
// ===== deploy-meta:end =====

// 暴露给入口 index.js：让其按部署侧 side（'D'/'T'）打印入口日志 tag，线上即可区分 D_/T_ 部署单元。
// 说明：SCF 把函数目录铺平到 /var/user，运行时拿不到函数名，只能靠这里登记的 side 区分。
exports.DEPLOY_META = DEPLOY_META;

// 运行日志：开发态统一打印 ForP 路由、关键入参和结果，方便排查当前到底落到了哪条链路。
function maskOpenid(openid) {
  const text = String(openid || "");
  if (text.length <= 8) {
    return text;
  }
  return `${text.slice(0, 4)}***${text.slice(-4)}`;
}

function logInfo(label, extra = {}) {
  console.log(`[DLforP__do][${FORP_DB_ALIAS}][INFO] ${label}`, extra);
}

function logError(label, error, extra = {}) {
  const safeError = error || {};
  console.error(`[DLforP__do][${FORP_DB_ALIAS}][ERROR] ${label}`, {
    ...extra,
    message: safeError.message || safeError.errMsg || String(safeError),
    stack: safeError.stack || "",
  });
}

function getNow() {
  return new Date();
}

function getOpenid() {
  const wxContext = cloud.getWXContext();
  return wxContext.OPENID || "";
}

// 识别码规范化规则必须与 A 侧（twowaybinding_1_DLforC / NEWDL_execution_order）完全一致：
// 1) 统一剥离所有非字母数字字符（例如空格、-、_、# 等），避免家长录入时因格式差异导致两端匹配失败
// 2) 全部转大写，保证大小写不敏感
// 3) 截断到 16 位，兼容 A 侧 organization collection 中 inviteCode 字段的长度上限
function normalizeInviteCode(inviteCode) {
  return String(inviteCode || "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 16);
}

function normalizeChildProfiles(childProfiles = []) {
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
}

// dev_ForP 现在按「每个家长 1 条主文档」收口。
// 文档里固定保留身份 / 基础信息 / 表单列表 / 课程列表这几个大类。
function generateInnerRecordId(prefix = "record") {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

// 新增身份分类：把 openid 从根节点挪进 P_identity，避免业务字段继续散落在根上。
function buildDefaultPIdentity(openid = "", now = getNow()) {
  return {
    openid: String(openid || "").trim(),
    createdAt: now,
    updatedAt: now,
  };
}

function buildDefaultPBasic(now = getNow()) {
  return {
    role: "V",
    latestInviteCode: "",
    latestFormId: "",
    latestCourseId: "",
    targetSnapshot: null,
    // 这里专门保留“创建”和“历史记录”，对应你现在定的 P_basic 职责。
    historyRecords: [
      {
        type: "create_parent_basic",
        text: "首次静默登录时创建基础信息",
        at: now,
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
}

function getParentIdentity(parentDoc = {}) {
  return parentDoc && parentDoc[IDENTITY_FIELD] || null;
}

function getParentBasic(parentDoc = {}) {
  return parentDoc && parentDoc[BASIC_FIELD] || null;
}

function getParentFormList(parentDoc = {}) {
  return Array.isArray(parentDoc && parentDoc[FORM_FIELD]) ? parentDoc[FORM_FIELD] : [];
}

function getParentCourseList(parentDoc = {}) {
  return Array.isArray(parentDoc && parentDoc[COURSE_FIELD]) ? parentDoc[COURSE_FIELD] : [];
}

function normalizeNestedRecord(record = {}, prefix = "record") {
  const now = getNow();
  const nextRecord = {
    ...record,
  };
  delete nextRecord[RECORD_FIELD_KEY];

  return {
    ...nextRecord,
    _id: nextRecord._id || generateInnerRecordId(prefix),
    createdAt: nextRecord.createdAt || nextRecord.updatedAt || now,
    updatedAt: nextRecord.updatedAt || nextRecord.createdAt || now,
  };
}

function hasLegacyParentRootFields(parentDoc = {}) {
  return Boolean(
    typeof parentDoc[RECORD_FIELD_KEY] !== "undefined" ||
    typeof parentDoc.openid !== "undefined" ||
    typeof parentDoc.role !== "undefined" ||
    typeof parentDoc.latestInviteCode !== "undefined" ||
    typeof parentDoc.latestFormId !== "undefined" ||
    typeof parentDoc.latestCourseId !== "undefined" ||
    typeof parentDoc.targetSnapshot !== "undefined" ||
    typeof parentDoc.historyRecords !== "undefined"
  );
}

function buildParentRootCleanupData() {
  return {
    [RECORD_FIELD_KEY]: _.remove(),
    openid: _.remove(),
    role: _.remove(),
    latestInviteCode: _.remove(),
    latestFormId: _.remove(),
    latestCourseId: _.remove(),
    targetSnapshot: _.remove(),
    historyRecords: _.remove(),
  };
}

function buildParentClientView(parentDoc = {}) {
  const pIdentity = getParentIdentity(parentDoc) || {};
  const pBasic = getParentBasic(parentDoc) || {};
  return {
    _id: parentDoc._id || "",
    openid: pIdentity.openid || "",
    role: pBasic.role || "V",
    latestInviteCode: pBasic.latestInviteCode || "",
    latestFormId: pBasic.latestFormId || "",
    latestCourseId: pBasic.latestCourseId || "",
    targetSnapshot: pBasic.targetSnapshot || null,
    historyRecords: Array.isArray(pBasic.historyRecords) ? pBasic.historyRecords : [],
    createdAt: pBasic.createdAt || parentDoc.createdAt || null,
    updatedAt: pBasic.updatedAt || parentDoc.updatedAt || null,
    [IDENTITY_FIELD]: pIdentity,
    [BASIC_FIELD]: pBasic,
    // 阶段1：表单/课程已拆到 ForP_forms/ForP_courses 子集合，主文档不再内嵌
  };
}

function pickLatestRecord(recordList = []) {
  const safeList = Array.isArray(recordList) ? [...recordList] : [];
  safeList.sort((left, right) => {
    const leftTime = new Date((left && (left.updatedAt || left.createdAt)) || 0).getTime();
    const rightTime = new Date((right && (right.updatedAt || right.createdAt)) || 0).getTime();
    return rightTime - leftTime;
  });
  return safeList[0] || null;
}

function findRecordById(recordList = [], recordId = "") {
  return (Array.isArray(recordList) ? recordList : []).find((item) => item && item._id === recordId) || null;
}

function findCourseByFormId(recordList = [], formId = "") {
  return (Array.isArray(recordList) ? recordList : []).find((item) => item && item.formId === formId) || null;
}

async function ensureCollection(collectionName) {
  try {
    await db.createCollection(collectionName);
    logInfo("ensureCollection.create", {
      collectionName,
    });
  } catch (error) {
    // 集合已存在时直接忽略，保持这个小项目的启动逻辑尽量简单。
    logInfo("ensureCollection.skip", {
      collectionName,
      message: error && (error.message || error.errMsg) || "collection exists",
    });
  }
}

function buildStatusText(status) {
  // 阶段0-4：扩到 7 档文案，与 A 端 courseState 的 fulfill_state 对齐。
  // editing/awaiting 之前恒回落 pending（家长永远看到"待安排"），现在各自独立。
  // 保留 scheduled/finished 旧值映射，兼容历史 course 文档里已存的 4 档 status。
  const statusTextMap = {
    editing: "待编辑",
    awaiting: "待接取",
    in_progress: "进行中",
    completed: "已完成",
    cancelled: "已取消",
    closed: "已结课",
    pending: "待安排",
    // 旧 4 档兼容（历史数据）
    scheduled: "已安排",
    finished: "已完成",
  };

  return statusTextMap[status] || "待安排";
}

function buildTargetSnapshot(target = {}) {
  return {
    inviteCode: target.inviteCode || "",
    targetType: target.targetType || "coach",
    displayName: target.displayName || "未命名对象",
    description: target.description || "",
    pageTitle: target.pageTitle || "约课登记",
    coachName: target.coachName || "",
    organizationName: target.organizationName || "",
    themeColor: target.themeColor || "#2f6bff",
    // 新增（机构展示页改版，2026-09-05）：A 侧 resolveInvite 对机构目标会回传
    // organizationId（A 侧机构主键）/ entryId（入口二维码 ID），这里原样透传，
    // 家长端「机构展示页」用它们调 DLforP_entry_qrcode/get_org_show 拉取完整机构展示文档。
    organizationId: target.organizationId || "",
    entryId: target.entryId || "",
  };
}

function buildQueryString(payload = {}) {
  const query = new URLSearchParams();

  Object.keys(payload || {}).forEach((key) => {
    const value = payload[key];

    if (typeof value === "undefined") {
      return;
    }

    if (value === null) {
      query.append(key, "");
      return;
    }

    if (typeof value === "object") {
      query.append(key, JSON.stringify(value));
      return;
    }

    query.append(key, String(value));
  });

  return query.toString();
}

// B -> A 的桥接结果统一从这里收口，避免前端和数据库各自猜字段。
function extractAOrderId(bridgeResult = {}) {
  const resultData = bridgeResult && bridgeResult.data || {};
  const nestedData = resultData && resultData.data || {};

  return (
    resultData.orderId ||
    resultData._id ||
    resultData.a_order_id ||
    nestedData.orderId ||
    nestedData._id ||
    nestedData.a_order_id ||
    ""
  );
}

// 家长课程码改为由 A 侧生成并回传，B 侧这里只负责提取和落库。
function extractParentCourseCode(bridgeResult = {}) {
  const resultData = bridgeResult && bridgeResult.data || {};
  const nestedData = resultData && resultData.data || {};

  // 新增：兼容 A 侧不同链路透出的字段：
  // - NEWDL_execution_order.syncParentBookingToA 回的是顶层 parent_course_code / joinCode / courseCode
  // - 旧链路 twowaybinding_1_DLforC 还会把 joinCode/courseCode 放在 data.data 嵌套里
  // 最终统一只取一个值：有就返回，没有就返回空串，上层照旧兜底生成 hash。
  const candidates = [
    resultData.parent_course_code,
    resultData.joinCode,
    resultData.courseCode,
    nestedData.parent_course_code,
    nestedData.joinCode,
    nestedData.courseCode,
    (bridgeResult && bridgeResult.parent_course_code),
    (bridgeResult && bridgeResult.joinCode),
    (bridgeResult && bridgeResult.courseCode),
  ];

  for (let i = 0; i < candidates.length; i += 1) {
    // 调整（2026-09-16 二次定版）：机构新码制课程码含小写字母（如 xing0001b），这里不再强制转大写，
    // 保留 A 侧原始大小写落库；旧随机码本身全大写，展示与匹配不受影响。
    const code = String(candidates[i] || "").trim();
    if (code) {
      return code;
    }
  }

  return "";
}

function buildTargetCard(target = {}) {
  return {
    inviteCode: target.inviteCode || "",
    targetType: target.targetType || "coach",
    displayName: target.displayName || "未命名对象",
    description: target.description || "",
    pageTitle: target.pageTitle || "约课登记",
    coachName: target.coachName || "",
    organizationName: target.organizationName || "",
    themeColor: target.themeColor || "#2f6bff",
    // 新增（机构展示页改版，2026-09-05）：与 buildTargetSnapshot 保持同一份字段口径，
    // 机构目标携带 organizationId / entryId，供家长端机构展示页拉取完整展示文档。
    organizationId: target.organizationId || "",
    entryId: target.entryId || "",
  };
}

// 阶段5（识别码收敛，2026-10-13）：原 buildInviteTargetRecord（往 dev_ForP 顶层写 TOP_invite_targets
// 混杂文档）已删除——识别码不再有 ForP 顶层形态，唯一缓存家是 forPshowC。

function buildBridgePayload(payload = {}) {
  // B侧直连A侧 twowaybinding_1_DLforC 时协议收口在这里。
  // 二次强制规范化 inviteCode，保证即使上游调用方漏了规范化步骤，发给A侧的识别码口径也一定与入库查询规则一致。
  const rawPayload = payload || {};
  return {
    action: ACTION_SYNC_PARENT_BOOKING_TO_A,
    source: SOURCE_FROM_B_PARENT,
    ...rawPayload,
    inviteCode: normalizeInviteCode(rawPayload.inviteCode),
    // 新增（2026-09-07 修复）：订单桥接必须透传 envVersion，A 侧据此选择
    // NDLdev_/NDLreal_ 前缀的机构库与订单库；否则 release 订单会在 A 侧误查 dev 机构库、
    // 订单误写入 NDLdev_execution_orders，造成正式环境串库。放在 spread 之后，防止上游覆盖。
    envVersion: CURRENT_ENV_VERSION,
  };
}

function buildResolveInvitePayload(inviteCode = "") {
  return {
    action: ACTION_RESOLVE_INVITE,
    inviteCode: normalizeInviteCode(inviteCode),
    // 新增（2026-09-07 修复）：识别码识别同样透传 envVersion。
    // A 侧取不到 envVersion 时默认 develop 只查 NDLdev_organization，
    // release 环境的机构在 NDLreal_organization，不透传会直接返回「识别码不存在」。
    envVersion: CURRENT_ENV_VERSION,
  };
}

// 调整（2026-10-10 拆双函数）：拆成「按给定地址发一次」+「选地址 + 兜底回退」两层。
function requestAHttpApiAt(baseUrl, payload = {}) {
  // 阶段4-1/4-2：B→A 改 POST（payload 放 body，避免多孩子 childProfiles 时 URL 超 2-8KB 限制），
  // 加 15s 显式超时（旧 https.get 无超时，对端不响应会卡到平台 20s 强杀）。
  // 过渡期 A 侧若仍只认 GET（旧部署），POST 未命中/网络失败自动回退 GET，保证不断链
  // （与 A 侧 _sync.js requestBHttpApiAt 同款 POST+GET 兜底）。
  // 业务失败（success:false 且 HTTP 2xx）不回退，避免同一笔约课被 A 侧重复创建。
  const queryString = buildQueryString(payload);
  const requestUrl = queryString ? `${baseUrl}?${queryString}` : baseUrl;
  const rawBody = JSON.stringify(payload);
  const TIMEOUT_MS = 15000;

  // 统一响应解析：GET/POST 共用，保证回退前后响应结构一致（含 a_order_id 提取）。
  function handleResponse(response, usedUrl) {
    return new Promise((resolve) => {
      let rawText = "";
      response.on("data", (chunk) => {
        rawText += chunk;
      });
      response.on("end", () => {
        let parsedBody = rawText;
        try {
          parsedBody = rawText ? JSON.parse(rawText) : {};
        } catch (error) {
          parsedBody = {
            success: false,
            message: "A 侧返回的不是 JSON",
            rawText,
          };
        }
        resolve({
          success: (response.statusCode || 0) < 400 && (!parsedBody || parsedBody.success !== false),
          requestUrl: usedUrl,
          statusCode: response.statusCode || 0,
          headers: response.headers || {},
          data: parsedBody,
          a_order_id: extractAOrderId(parsedBody),
        });
      });
      response.on("error", () => {
        resolve({
          success: false,
          requestUrl: usedUrl,
          statusCode: 0,
          headers: {},
          data: { success: false, message: "A 侧响应读取失败" },
          a_order_id: "",
        });
      });
    });
  }

  function doGet() {
    return new Promise((resolve, reject) => {
      const req = https.get(requestUrl, (response) => {
        handleResponse(response, requestUrl).then(resolve);
      });
      req.on("error", reject);
      req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error("B→A GET 超时")));
    });
  }

  function doPost() {
    return new Promise((resolve, reject) => {
      let urlObj;
      try {
        urlObj = new URL(requestUrl);
      } catch (e) {
        reject(e);
        return;
      }
      const req = https.request(
        {
          hostname: urlObj.hostname,
          port: urlObj.port || undefined,
          path: `${urlObj.pathname}${urlObj.search}`,
          method: "POST",
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": Buffer.byteLength(rawBody),
          },
        },
        (response) => {
          handleResponse(response, requestUrl).then(resolve);
        }
      );
      req.on("error", reject);
      req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error("B→A POST 超时")));
      req.write(rawBody);
      req.end();
    });
  }

  // POST 优先；网络失败或路由不到（4xx/非JSON）才回退 GET；业务失败不回退。
  return doPost()
    .then((postResult) => {
      const isBizFail =
        postResult &&
        (postResult.statusCode || 0) >= 200 &&
        (postResult.statusCode || 0) < 400 &&
        postResult.data &&
        postResult.data.success === false;
      if ((postResult && postResult.success) || isBizFail) {
        return postResult;
      }
      return doGet();
    })
    .catch(() => doGet());
}

// 判定「请求根本没到业务函数」：HTTP 4xx（网关无路由 / 函数未部署）或响应体不是业务 JSON。
// 只有这种路由级失败才回退旧地址；A 侧业务失败（success:false 且带 code/message）一律不回退，
// 避免同一笔建单被重复执行。
function isARouteMiss(result) {
  if (!result) {
    return true;
  }
  if (Number(result.statusCode || 0) >= 400) {
    return true;
  }
  const data = result.data;
  if (!data || typeof data !== "object") {
    return true;
  }
  if (data.rawText && typeof data.success === "undefined") {
    return true;
  }
  return typeof data.success === "undefined" && typeof data.code === "undefined";
}

async function requestAHttpApi(payload = {}) {
  const primaryUrl = resolveADLforCUrl(CURRENT_ENV_VERSION);
  let result;
  try {
    result = await requestAHttpApiAt(primaryUrl, payload);
  } catch (primaryError) {
    // 连不上 / DNS 层失败也按「路由不到」处理：给旧地址最后一次机会，旧地址也失败则抛出。
    logInfo("requestAHttpApi.fallback", {
      from: primaryUrl,
      to: A_DLFORC_URL_LEGACY,
      statusCode: 0,
      reason: (primaryError && (primaryError.message || primaryError.errMsg)) || String(primaryError),
    });
    return requestAHttpApiAt(A_DLFORC_URL_LEGACY, payload);
  }
  if (!isARouteMiss(result)) {
    return result;
  }

  // 兜底（拆双迁移期）：A 侧 D_/T_ 还没部署时，回退旧函数名地址，保证桥接不中断。
  logInfo("requestAHttpApi.fallback", {
    from: primaryUrl,
    to: A_DLFORC_URL_LEGACY,
    statusCode: (result && result.statusCode) || 0,
  });
  return requestAHttpApiAt(A_DLFORC_URL_LEGACY, payload);
}

async function syncBookingToA(payload = {}) {
  const safePayload = buildBridgePayload(payload);
  logInfo("syncBookingToA.start", {
    action: safePayload.action,
    inviteCode: safePayload.inviteCode || "",
    fromBFormId: safePayload.from_b_form_id || "",
    fromBCourseId: safePayload.from_b_course_id || "",
  });

  const bridgeResult = await requestAHttpApi(safePayload);
  logInfo("syncBookingToA.success", {
    action: safePayload.action,
    inviteCode: safePayload.inviteCode || "",
    fromBFormId: safePayload.from_b_form_id || "",
    fromBCourseId: safePayload.from_b_course_id || "",
    aOrderId: extractAOrderId(bridgeResult),
  });

  return bridgeResult;
}

async function resolveInviteByA(inviteCode = "") {
  const safePayload = buildResolveInvitePayload(inviteCode);
  logInfo("resolveInviteByA.start", {
    inviteCode: safePayload.inviteCode || "",
    // 新增（2026-09-07）：打印透传给 A 侧的环境版本，release 必须为 release，否则 A 侧会误查 dev 库
    envVersion: safePayload.envVersion || "",
  });

  const result = await requestAHttpApi(safePayload);
  logInfo("resolveInviteByA.finish", {
    inviteCode: safePayload.inviteCode || "",
    envVersion: safePayload.envVersion || "",
    success: result && result.success !== false,
    statusCode: result && result.statusCode || 0,
  });

  return result;
}

async function findParentByOpenid(openid) {
  // 先按新结构 P_identity.openid 查；查不到再回退到旧根字段 openid，保证历史数据还能被接住。
  const identityRes = await db.collection(FORP_COLLECTION).where({
    [`${IDENTITY_FIELD}.openid`]: openid,
  }).limit(20).get();
  const identityList = Array.isArray(identityRes.data) ? identityRes.data : [];
  const structuredParent = identityList.find((item) => !item[RECORD_FIELD_KEY] || item[RECORD_FIELD_KEY] === BASIC_FIELD) || null;
  if (structuredParent) {
    return structuredParent;
  }

  const legacyRes = await db.collection(FORP_COLLECTION).where({
    openid,
  }).limit(20).get();
  const legacyList = Array.isArray(legacyRes.data) ? legacyRes.data : [];
  return legacyList.find((item) => !item[RECORD_FIELD_KEY] || item[RECORD_FIELD_KEY] === BASIC_FIELD) || null;
}

async function createDefaultParent(openid) {
  const now = getNow();
  const pIdentity = buildDefaultPIdentity(openid, now);
  const pBasic = buildDefaultPBasic(now);
  const parentData = {
    [IDENTITY_FIELD]: pIdentity,
    [BASIC_FIELD]: pBasic,
    // 阶段1：表单/课程拆到子集合，主文档不再初始化内嵌数组
    isMigrated: true,
    createdAt: now,
    updatedAt: now,
  };

  const addRes = await db.collection(FORP_COLLECTION).add({
    data: parentData,
  });

  return {
    _id: addRes._id,
    ...parentData,
  };
}

async function upgradeLegacyParentDoc(parentDoc) {
  if (!parentDoc) {
    return parentDoc;
  }
  // 阶段1-2/3-5：改为一次性迁移——旧内嵌数组 P_CourseFormCollection/P_CourseWithCoach
  // 拆到 ForP_forms/ForP_courses 子集合，主文档删除内嵌字段并打 isMigrated 标记。
  // 已迁移（isMigrated）直接跳过，不再每次 login 触发。迁移失败不阻塞 login，下次再试。
  if (parentDoc.isMigrated) {
    return parentDoc;
  }

  const now = getNow();
  const currentIdentity = getParentIdentity(parentDoc) || {};
  const effectiveOpenid = currentIdentity.openid || parentDoc.openid || "";
  const hasStructuredParent = Boolean(
    getParentIdentity(parentDoc) &&
    getParentBasic(parentDoc) &&
    Array.isArray(parentDoc[FORM_FIELD]) &&
    Array.isArray(parentDoc[COURSE_FIELD])
  );
  const hasLegacyRootFields = hasLegacyParentRootFields(parentDoc);

  let rawFormList = [];
  let rawCourseList = [];
  if (hasStructuredParent) {
    rawFormList = getParentFormList(parentDoc);
    rawCourseList = getParentCourseList(parentDoc);
  } else if (hasLegacyRootFields) {
    // 旧分表结构（RECORD_FIELD_KEY 标记的散落记录）
    const formRes = await db.collection(FORP_COLLECTION).where({
      [RECORD_FIELD_KEY]: FORM_FIELD,
      openid: effectiveOpenid,
    }).get();
    const courseRes = await db.collection(FORP_COLLECTION).where({
      [RECORD_FIELD_KEY]: COURSE_FIELD,
      openid: effectiveOpenid,
    }).get();
    rawFormList = formRes.data || [];
    rawCourseList = courseRes.data || [];
  }

  // 无任何旧数据（新文档）：直接打标记跳过
  if (!rawFormList.length && !rawCourseList.length) {
    try {
      await db.collection(FORP_COLLECTION).doc(parentDoc._id).update({
        data: { isMigrated: true, ...buildParentRootCleanupData(), updatedAt: now },
      });
    } catch (e) {
      logError("upgradeLegacyParentDoc.markMigrated.fail", e, { parentId: parentDoc._id });
    }
    return { ...parentDoc, isMigrated: true };
  }

  const formList = rawFormList.map((item) => normalizeNestedRecord(item, "legacy_form"));
  const courseList = rawCourseList.map((item) => normalizeNestedRecord(item, "legacy_course"));
  const latestForm = pickLatestRecord(formList);
  const latestCourse = pickLatestRecord(courseList);

  try {
    // 迁移：每条旧记录写入子集合（带 parentOpenid 外键，供子集合索引查询）
    for (const item of formList) {
      const doc = { ...item, parentOpenid: effectiveOpenid, parentId: parentDoc._id, migratedAt: now };
      delete doc[RECORD_FIELD_KEY];
      await db.collection(FORP_FORMS_COLLECTION).add({ data: doc });
    }
    for (const item of courseList) {
      const doc = { ...item, parentOpenid: effectiveOpenid, parentId: parentDoc._id, migratedAt: now };
      delete doc[RECORD_FIELD_KEY];
      await db.collection(FORP_COURSES_COLLECTION).add({ data: doc });
    }

    // 主文档：更新 P_basic 指针 + 删除内嵌数组 + 清根字段 + 打 isMigrated
    const defaultBasic = buildDefaultPBasic(parentDoc.createdAt || now);
    const currentBasic = getParentBasic(parentDoc) || {};
    const nextPBasic = {
      ...defaultBasic,
      ...currentBasic,
      role: currentBasic.role || parentDoc.role || "P",
      latestInviteCode:
        currentBasic.latestInviteCode ||
        parentDoc.latestInviteCode ||
        (latestForm && latestForm.inviteCode) ||
        (latestCourse && latestCourse.inviteCode) ||
        "",
      latestFormId: currentBasic.latestFormId || parentDoc.latestFormId || (latestForm && latestForm._id) || "",
      latestCourseId: currentBasic.latestCourseId || parentDoc.latestCourseId || (latestCourse && latestCourse._id) || "",
      targetSnapshot:
        currentBasic.targetSnapshot ||
        parentDoc.targetSnapshot ||
        (latestCourse && latestCourse.targetSnapshot) ||
        (latestForm && latestForm.targetSnapshot) ||
        null,
      historyRecords: Array.isArray(currentBasic.historyRecords) && currentBasic.historyRecords.length
        ? currentBasic.historyRecords
        : defaultBasic.historyRecords,
      createdAt: currentBasic.createdAt || parentDoc.createdAt || now,
      updatedAt: now,
    };
    const nextPIdentity = {
      ...buildDefaultPIdentity(effectiveOpenid, parentDoc.createdAt || now),
      ...currentIdentity,
      openid: effectiveOpenid,
      updatedAt: now,
    };
    await db.collection(FORP_COLLECTION).doc(parentDoc._id).update({
      data: {
        [IDENTITY_FIELD]: _.set(nextPIdentity),
        [BASIC_FIELD]: _.set(nextPBasic),
        [FORM_FIELD]: _.remove(),
        [COURSE_FIELD]: _.remove(),
        ...buildParentRootCleanupData(),
        isMigrated: true,
        updatedAt: now,
      },
    });

    const nextParentDoc = { ...parentDoc, [IDENTITY_FIELD]: nextPIdentity, [BASIC_FIELD]: nextPBasic, isMigrated: true, updatedAt: now };
    delete nextParentDoc[FORM_FIELD];
    delete nextParentDoc[COURSE_FIELD];
    delete nextParentDoc[RECORD_FIELD_KEY];
    return nextParentDoc;
  } catch (error) {
    // 迁移失败不阻塞 login，下次 login 再试
    logError("upgradeLegacyParentDoc.migrate.fail", error, { parentId: parentDoc._id });
    return parentDoc;
  }
}

async function getOrCreateParent(openid) {
  let parent = await findParentByOpenid(openid);
  if (!parent) {
    parent = await createDefaultParent(openid);
  }
  return await upgradeLegacyParentDoc(parent);
}

// 阶段5-2（识别码收敛，2026-10-13）：识别码查找从三级（dev_invite_targets → dev_ForP 顶层混杂文档 → 回 A）
// 收敛为两级，机构类识别码的唯一本地缓存家 = forPshowC：
//   第 1 优先级：查 forPshowC.show_basic.invite_code（一机构一条投影文档，
//               A 侧 sync_org_show / 二维码快照推送时落库，家长识别时回写）；
//   第 2 优先级：本地未命中 → 回 A 侧真实机构库识别（权威源），命中后把码回写进 forPshowC 完成自愈。
// 存量机构的码即使只存在旧 invite_targets / ForP 顶层混杂文档里，也会经第 2 优先级回 A 重取，不丢识别能力。
// 个人教练类目标（无 organizationId）不落 forPshowC 缓存，每次直接回 A 识别。
async function findInviteTarget(inviteCode) {
  const code = normalizeInviteCode(inviteCode);
  if (!code) {
    return null;
  }

  // 第 1 优先级：forPshowC 唯一机构投影表（按 show_basic.invite_code 点查，一步命中）
  const orgShowTarget = await findInviteInOrgShow(code);
  if (orgShowTarget) {
    logInfo("findInviteTarget.hitOrgShow", {
      inviteCode: code,
      displayName: orgShowTarget.displayName || "",
      organizationId: orgShowTarget.organizationId || "",
    });
    return orgShowTarget;
  }

  // 第 2 优先级：本地缓存未命中，回退到 A 侧真实机构库做识别
  // 【重要】查到结果后只回写 forPshowC（有 organizationId 才写），不再写 dev_invite_targets，
  // 也不向 dev_ForP 顶层写入 TOP_invite_targets 混杂文档。
  try {
    const remoteResult = await resolveInviteByA(code);
    const remoteData = remoteResult && remoteResult.data || {};
    const remoteTarget = remoteData && remoteData.target || null;

    if (!remoteResult || remoteResult.success === false || !remoteTarget) {
      logInfo("findInviteTarget.remoteNotFound", { inviteCode: code });
      return null;
    }

    const snapshot = buildTargetSnapshot(remoteTarget);
    // 回写 forPshowC 完成自愈（fire-and-forget，失败不影响本次返回，下次识别再试）
    const targetForReturn = {
      ...(remoteTarget || {}),
      inviteCode: code,
    };
    upsertInviteIntoOrgShow(targetForReturn).catch(() => {});

    logInfo("findInviteTarget.remoteHit", {
      inviteCode: code,
      displayName: (snapshot && snapshot.displayName) || "",
    });
    return snapshot;
  } catch (error) {
    logError("findInviteTarget.remoteFail", error, {
      inviteCode: code,
    });
    return null;
  }
}

// 阶段1-2：以下 5 个查询从"读主文档内嵌数组"改为"查 ForP_forms/ForP_courses 子集合"。
// 子集合文档带 parentOpenid 外键（迁移/提交时写入），按 _id 或 parentOpenid+updatedAt 查询。
async function getLatestForm(openid) {
  if (!openid) return null;
  try {
    const res = await db.collection(FORP_FORMS_COLLECTION).where({ parentOpenid: openid }).orderBy("updatedAt", "desc").limit(1).get();
    return (res && res.data && res.data[0]) || null;
  } catch (e) {
    return null;
  }
}

async function getLatestCourse(openid) {
  if (!openid) return null;
  try {
    const res = await db.collection(FORP_COURSES_COLLECTION).where({ parentOpenid: openid }).orderBy("updatedAt", "desc").limit(1).get();
    return (res && res.data && res.data[0]) || null;
  } catch (e) {
    return null;
  }
}

async function getFormById(formId) {
  if (!formId) return null;
  try {
    const res = await db.collection(FORP_FORMS_COLLECTION).doc(formId).get();
    return (res && res.data) || null;
  } catch (e) {
    return null;
  }
}

async function getCourseById(courseId) {
  if (!courseId) return null;
  try {
    const res = await db.collection(FORP_COURSES_COLLECTION).doc(courseId).get();
    return (res && res.data) || null;
  } catch (e) {
    return null;
  }
}

async function getCourseByFormId(formId) {
  if (!formId) return null;
  try {
    const res = await db.collection(FORP_COURSES_COLLECTION).where({ formId }).orderBy("updatedAt", "desc").limit(1).get();
    return (res && res.data && res.data[0]) || null;
  } catch (e) {
    return null;
  }
}

// 不允许重复提交（2026-10-11）：查「当前家长 + 指定识别码」下是否还存在未结课的约课记录。
// 未结课 = status 不属于 completed / cancelled / closed / finished（含历史 4 档 finished）。
// 命中活跃记录 → 后续 submitBooking 按「修改信息」复用原 formId/courseId 覆写，避免重复新建预约；
// 未命中（首次提交 / 旧记录已结课/取消） → 走「新建预约」。
async function findActiveCourseByInviteCode(openid, inviteCode) {
  if (!openid || !inviteCode) return null;
  try {
    const res = await db
      .collection(FORP_COURSES_COLLECTION)
      .where({ parentOpenid: openid, inviteCode })
      .orderBy("updatedAt", "desc")
      .limit(20)
      .get();
    const list = (res && res.data) || [];
    const TERMINAL = ["completed", "cancelled", "closed", "finished"];
    return (
      list.find((item) => {
        const status = String((item && item.status) || "").toLowerCase().trim();
        return !TERMINAL.includes(status);
      }) || null
    );
  } catch (e) {
    logError("findActiveCourseByInviteCode.swallow", e, { inviteCode });
    return null;
  }
}

// 新增（带 id 修改，2026-10-13）：按 courseId 直接查一条课程记录，用于「修改」入口。
// 与 findActiveCourseByInviteCode 的差异：不要求同识别码、不要求活跃状态——
// 家长从 parent_classshow「修改」按钮明确传 courseId 进来，云函数无条件覆写原记录
// （只要记录属于当前家长），让家长也能修改已结课/取消等终态课程的资料。
// 越权拦截：parentOpenid/openid 任一匹配当前用户即可（兼容新旧写入字段）。
async function findActiveCourseById(openid, courseId) {
  if (!openid || !courseId) return null;
  try {
    const res = await db.collection(FORP_COURSES_COLLECTION).doc(courseId).get();
    const doc = (res && res.data) || null;
    if (!doc) return null;
    const owner = String((doc.parentOpenid || doc.openid) || "").trim();
    if (owner && owner !== openid) {
      logInfo("findActiveCourseById.mismatch", {
        openid: maskOpenid(openid),
        courseId,
        owner: maskOpenid(owner),
      });
      return null;
    }
    return doc;
  } catch (e) {
    logError("findActiveCourseById.swallow", e, { courseId });
    return null;
  }
}

// 新增（2026-10-13 · 修复「每日总结始终为 0 / 数据没到 B 端」）：
// A 端 buildCoachResultSyncPayload 推送的 a_result_snapshot.order_snapshot 是把 A 端订单「原始 doc」原样复制的，
// 而 A 端订单的课表权威存储在内层 course_flow_info.schedule（顶层 schedule 在订单 update 时被 _.remove() 删除），
// 课程目标/基础信息分别落在 teaching_record / course_config / course_basic_info。
// 但本端展示页（从 A 端 progress_specialOperation 系列复制而来）期望的是 A 端 normalizeOrderForClient
// 归一化后的结构（顶层 schedule / course_target / course_basic / child_profile / history_sync ...）。
// 结果：B 端拿到 order_snapshot 却读不到 schedule → 课节列表空白、每日总结与课时进度恒为 0。
// 下面两个函数在 B 端读侧复刻同一套归一化，保证新旧推送数据都能正确展示。
function extractSnapshotSchedule(aResultSnapshot) {
  if (!aResultSnapshot || typeof aResultSnapshot !== "object") return [];
  const orderSnapshot = aResultSnapshot.order_snapshot;
  if (orderSnapshot && typeof orderSnapshot === "object") {
    if (Array.isArray(orderSnapshot.schedule) && orderSnapshot.schedule.length) {
      return orderSnapshot.schedule;
    }
    const flow = orderSnapshot.course_flow_info;
    if (flow && Array.isArray(flow.schedule) && flow.schedule.length) {
      return flow.schedule;
    }
  }
  if (Array.isArray(aResultSnapshot.schedule) && aResultSnapshot.schedule.length) {
    return aResultSnapshot.schedule;
  }
  return [];
}

function normalizeSnapshotForParent(orderData = {}) {
  const flow = (orderData && orderData.course_flow_info) || {};
  const teachingRecord = orderData.teaching_record || {};
  const courseConfig = orderData.course_config || {};
  const courseBasicInfo = orderData.course_basic_info || {};
  const childProfile = orderData.child_profile || {};
  const schedule = Array.isArray(flow.schedule)
    ? flow.schedule
    : (Array.isArray(orderData.schedule) ? orderData.schedule : []);
  const doneCount = schedule.filter(
    (item) => String((item && item.status) || "").toUpperCase() === "DONE"
  ).length;
  const rawProgressTotal = Number(flow.progress_total || orderData.progress_total || 0);
  const rawProgressDone = Number(flow.progress_done || orderData.progress_done || 0);

  return {
    ...orderData,
    course_target: orderData.course_target || teachingRecord,
    course_basic: orderData.course_basic || {
      frequency: courseConfig.frequency || orderData.frequency || "",
      course_size_mode: courseConfig.course_size_mode || orderData.course_size_mode || "",
      location: courseBasicInfo.location || orderData.location || "",
      contact: courseBasicInfo.contact || orderData.contact || "",
    },
    title: teachingRecord.title || orderData.title || "",
    category: teachingRecord.category || orderData.category || "",
    description: teachingRecord.description || orderData.description || "",
    sub_plan_name: teachingRecord.sub_plan_name || orderData.sub_plan_name || "",
    course_plan: teachingRecord.course_plan || orderData.course_plan || "",
    frequency: courseConfig.frequency || orderData.frequency || "",
    class_count: courseConfig.class_count || orderData.class_count || 0,
    course_size_mode: courseConfig.course_size_mode || orderData.course_size_mode || "",
    location: courseBasicInfo.location || orderData.location || "",
    contact: courseBasicInfo.contact || orderData.contact || "",
    child_profile: childProfile,
    child_nickname: childProfile.nickname || orderData.child_nickname || "",
    child_age: childProfile.age || orderData.child_age || "",
    fulfill_state: flow.fulfill_state || orderData.fulfill_state || orderData.status || "",
    // 课时进度：A 端扁平字段优先，缺失/为 0 时从课表兜底计算（总课时 = 课表长度，已完成 = DONE 课节数）。
    progress_total: rawProgressTotal > 0 ? rawProgressTotal : schedule.length,
    progress_done: rawProgressDone > 0 ? rawProgressDone : doneCount,
    schedule,
    history_sync: flow.history_sync || orderData.history_sync || null,
  };
}

function buildLatestRequest(formDoc, courseDoc) {
  if (!formDoc && !courseDoc) {
    return null;
  }

  // 阶段2-2：A 端结果快照（10-10 起全量推扁平字段），统一在这里取一次，供下方扁平字段复用。
  const aResultSnapshot =
    (courseDoc && courseDoc.a_result_snapshot) ||
    (formDoc && formDoc.a_result_snapshot) ||
    null;
  // 修复（2026-10-13 · 每日总结始终为 0）：A 端快照的课表在内层 course_flow_info.schedule，
  // 这里统一取出整张课表，供下方 progressTotal / progressDone / schedule 复用。
  const snapshotSchedule = extractSnapshotSchedule(aResultSnapshot);
  // 阶段2-2：status 优先取快照里的 fulfill_state（A 端真实 7 档），回落 courseDoc.status
  //（阶段0-4 后新回抄写入的也是 7 档），最后兜底 pending。
  const status =
    (aResultSnapshot && aResultSnapshot.fulfill_state) ||
    (courseDoc && courseDoc.status) ||
    "pending";
  const targetSnapshot =
    (courseDoc && courseDoc.targetSnapshot) ||
    (formDoc && formDoc.targetSnapshot) ||
    null;
  const courseBasic =
    (formDoc && formDoc.course_basic) ||
    {};
  const childProfiles = normalizeChildProfiles(
    (formDoc && formDoc.child_profiles) || []
  );
  const firstChild =
    (formDoc && formDoc.child_profile) ||
    childProfiles[0] ||
    {};

  return {
    _id: (courseDoc && courseDoc._id) || (formDoc && formDoc._id) || "",
    formId: (formDoc && formDoc._id) || (courseDoc && courseDoc.formId) || "",
    courseId: (courseDoc && courseDoc._id) || "",
    openid: (formDoc && formDoc.openid) || (courseDoc && courseDoc.openid) || "",
    inviteCode:
      (formDoc && formDoc.inviteCode) ||
      (courseDoc && courseDoc.inviteCode) ||
      "",
    source:
      (courseDoc && courseDoc.source) ||
      (formDoc && formDoc.source) ||
      "",
    bridgeStatus:
      (courseDoc && courseDoc.bridge_status) ||
      (formDoc && formDoc.bridge_status) ||
      "",
    aOrderId:
      (courseDoc && courseDoc.a_order_id) ||
      (formDoc && formDoc.a_order_id) ||
      "",
    // 阶段2-2：顶层 parent_course_code 直接取，取代原 6 层下钻 raw.data.data.joinCode/courseCode。
    // A 端 buildCoachResultSyncPayload 已在快照顶层带 parent_course_code（阶段3-1）；
    // 旧数据兜底只留 raw.data 一层，再深的历史结构不再下钻（A 端 10-10 起全量推扁平快照）。
    parentCourseCode:
      (aResultSnapshot && aResultSnapshot.parent_course_code) ||
      (aResultSnapshot && aResultSnapshot.joinCode) ||
      (aResultSnapshot && aResultSnapshot.courseCode) ||
      (courseDoc && courseDoc.parent_course_code) ||
      (formDoc && formDoc.parent_course_code) ||
      ((aResultSnapshot && aResultSnapshot.raw && aResultSnapshot.raw.data) || {}).parent_course_code ||
      ((aResultSnapshot && aResultSnapshot.raw && aResultSnapshot.raw.data) || {}).joinCode ||
      ((aResultSnapshot && aResultSnapshot.raw && aResultSnapshot.raw.data) || {}).courseCode ||
      "",
    lastSyncAt:
      (courseDoc && courseDoc.last_sync_at) ||
      (formDoc && formDoc.last_sync_at) ||
      null,
    bridgeErrorMessage:
      (courseDoc && courseDoc.bridge_error_message) ||
      (formDoc && formDoc.bridge_error_message) ||
      "",
    // 新增 A 侧结果快照：这里只返回执行结果态，不回写家长原始表单字段。
    aResultSnapshot,
    // 阶段2-2：快照 12 个扁平字段提升到 latestRequest 顶层，前端直接读 latestRequest.xxx，
    // 不再依赖 raw 六层下钻。A 端 10-10 起全量推扁平快照，旧数据无这些字段时回落默认值。
    fulfillState: (aResultSnapshot && aResultSnapshot.fulfill_state) || status,
    // 修复（2026-10-13 · 每日总结始终为 0）：旧数据 / 部分同步链路下 a_result_snapshot.progress_total
    // 和 progress_done 顶层扁平字段缺失或恒为 0，导致 parent_classshow 上课信息页「课时进度」
    // 始终显示 0 / 0。这里在顶层字段为 0 时，从整张课表兜底计算：
    // 总数 = schedule.length，已完成 = status === 'DONE' 的课节数。
    // 安全性：兜底计算只在 progressTotal 为 0 且 schedule 非空时执行，不覆盖 A 端推送的真实值。
    progressTotal: (() => {
      const rawTotal = Number((aResultSnapshot && aResultSnapshot.progress_total) || 0);
      if (rawTotal > 0) return rawTotal;
      return snapshotSchedule.length;
    })(),
    progressDone: (() => {
      const rawDone = Number((aResultSnapshot && aResultSnapshot.progress_done) || 0);
      if (rawDone > 0) return rawDone;
      return snapshotSchedule.filter((item) => String((item && item.status) || "").toUpperCase() === "DONE").length;
    })(),
    // 新增：把整张 schedule 也带到 latestRequest 顶层，方便 parent_classshow 直接展示课节列表，
    // 不必每次都跳 progress_specialOperation 才能看到每日总结。
    schedule: snapshotSchedule,
    closeSummary: (aResultSnapshot && aResultSnapshot.close_summary) || "",
    closeCoachNote: (aResultSnapshot && aResultSnapshot.close_coach_note) || "",
    cancelReason: (aResultSnapshot && aResultSnapshot.cancel_reason) || "",
    scheduleStats: (aResultSnapshot && aResultSnapshot.schedule_stats) || null,
    latestLesson: (aResultSnapshot && aResultSnapshot.latest_lesson) || null,
    completedAt: (aResultSnapshot && aResultSnapshot.completed_at) || null,
    cancelledAt: (aResultSnapshot && aResultSnapshot.cancelled_at) || null,
    closedAt: (aResultSnapshot && aResultSnapshot.closed_at) || null,
    status,
    statusText: buildStatusText(status),
    targetSnapshot,
    // 新增（机构展示页改版，2026-09-05）：扫码入口归因上下文（提交约课时随单落库），
    // 家长端机构展示页优先用它（entryId / 机构入口时的 targetId=organizationId）拉取完整展示文档。
    entryContext:
      (formDoc && formDoc.entryContext) ||
      (courseDoc && courseDoc.entryContext) ||
      null,
    formSnapshot: {
      parentName: (formDoc && formDoc.parentName) || "",
      phone: (formDoc && formDoc.phone) || courseBasic.contact || "",
      contact: courseBasic.contact || (formDoc && formDoc.phone) || "",
      frequency: courseBasic.frequency || "",
      location: courseBasic.location || "",
      latitude: courseBasic.latitude || "",
      longitude: courseBasic.longitude || "",
      childName: firstChild.nickname || (formDoc && formDoc.childName) || "",
      childAge: firstChild.age || (formDoc && formDoc.childAge) || "",
      childProfiles,
      note: (formDoc && formDoc.note) || "",
      // 课程目标：跟随家长约课表单落库，供 parent_add bootstrap 回填课程方向选择。
      category: (formDoc && formDoc.course_target && formDoc.course_target.category) || "",
      title: (formDoc && formDoc.course_target && formDoc.course_target.title) || "",
      sub_plan_name: (formDoc && formDoc.course_target && formDoc.course_target.sub_plan_name) || "",
      course_plan: (formDoc && formDoc.course_target && formDoc.course_target.course_plan) || "",
      description: (formDoc && formDoc.course_target && formDoc.course_target.description) || "",
    },
    coachSchedule: (courseDoc && courseDoc.coachSchedule) || null,
    createdAt:
      (courseDoc && courseDoc.createdAt) ||
      (formDoc && formDoc.createdAt) ||
      null,
    updatedAt:
      (courseDoc && courseDoc.updatedAt) ||
      (formDoc && formDoc.updatedAt) ||
      null,
  };
}

// ---------- 阶段5-3（识别码收敛，2026-10-13）：机构类识别码缓存统一收敛到 forPshowC ----------
// 设计口径：
// 1. forPshowC 是 B 库唯一的机构投影表（一机构一条，organizationId 唯一键），
//    门面页展示（A 侧 sync_org_show 推送）与识别码缓存（本文件回写）共用这一张表，
//    不再另设 invite_targets 独立集合，也不再有 ForP 顶层混杂文档；
// 2. 查询入口：按 show_basic.invite_code 点查，命中后从展示文档还原统一的 target 卡片；
// 3. 回写入口：A 侧 resolveInvite 兜底命中后，仅补写 invite_code 字段（已建文档）
//    或落一张极简卡片（未建文档），绝不整包覆盖 A 侧推送的展示字段（images / members 等），
//    A 侧下次 sync_org_show 会按 organizationId 幂等覆盖补全；
// 4. 个人教练类目标（无 organizationId）不进 forPshowC，每次识别直接回 A，保证结果一定正确；
// 5. 家长自己的识别历史仍归 ForP_invites 子集合（appendRecognizedHistoryToParent，阶段1-2 已拆）。

// 从 forPshowC 展示文档还原统一的 target 卡片（字段口径与 buildTargetCard 对齐）
function buildTargetCardFromOrgShow(showDoc = {}, code = "") {
  const showBasic = (showDoc && showDoc.show_basic) || {};
  const orgName = String(showBasic.organization_name || "").trim();
  return {
    inviteCode: normalizeInviteCode(code),
    targetType: "org",
    displayName: orgName || "未命名机构",
    description: String(showBasic.intro || ""),
    pageTitle: "约课登记",
    coachName: "",
    organizationName: orgName,
    themeColor: "#2f6bff",
    organizationId: String((showDoc && showDoc.organizationId) || "").trim(),
    entryId: String((showDoc && showDoc.entryId) || "").trim(),
  };
}

// 第 1 优先级查询：按规范化识别码查 forPshowC
// （集合不存在等异常吞掉返回 null，自然回落第 2 优先级回 A，不影响识别能力）
async function findInviteInOrgShow(code = "") {
  const safeCode = normalizeInviteCode(code);
  if (!safeCode) {
    return null;
  }
  try {
    const res = await db.collection(SHOW_COLLECTION).where({
      "show_basic.invite_code": safeCode,
    }).limit(1).get();
    const showDoc = Array.isArray(res.data) && res.data.length ? res.data[0] : null;
    if (!showDoc || !String(showDoc.organizationId || "").trim()) {
      return null;
    }
    return buildTargetCardFromOrgShow(showDoc, safeCode);
  } catch (error) {
    logError("findInviteInOrgShow.swallow", error, {
      inviteCode: safeCode,
    });
    return null;
  }
}

// 第 2 优先级回写：A 侧识别命中后，把识别码回写进 forPshowC（自愈缓存）
// - 已有该机构文档：只补 show_basic.invite_code（顺带补缺失的顶层 entryId），不碰展示字段；
// - 还没有文档：落一张极简卡片（minimal_card 标记），A 侧下次 sync_org_show 推送时幂等覆盖补全；
// - 无 organizationId（个人教练）：不写缓存，直接返回。
async function upsertInviteIntoOrgShow(target = {}) {
  const safeCode = normalizeInviteCode(target && target.inviteCode);
  const organizationId = String((target && target.organizationId) || "").trim();
  if (!safeCode || !organizationId) {
    return;
  }
  try {
    await ensureCollection(SHOW_COLLECTION);
    const now = getNow();
    const displayName = String(target.displayName || "").trim();
    const entryId = String(target.entryId || "").trim();
    const existedRes = await db.collection(SHOW_COLLECTION).where({
      organizationId,
    }).limit(1).get();
    const existed = Array.isArray(existedRes.data) && existedRes.data.length ? existedRes.data[0] : null;

    if (existed) {
      const patchData = {
        "show_basic.invite_code": safeCode,
        synced_at: now,
      };
      if (entryId && !String(existed.entryId || "").trim()) {
        patchData.entryId = entryId;
      }
      await db.collection(SHOW_COLLECTION).doc(existed._id).update({
        data: patchData,
      });
      logInfo("upsertInviteIntoOrgShow.patch", {
        inviteCode: safeCode,
        organizationId,
        docId: existed._id,
      });
      return;
    }

    await db.collection(SHOW_COLLECTION).add({
      data: {
        organizationId,
        entryId,
        show_basic: {
          organization_name: displayName,
          intro: String(target.description || ""),
          invite_code: safeCode,
        },
        images: {},
        members: [],
        status: "active",
        minimal_card: true,
        synced_at: now,
        createdAt: now,
      },
    });
    logInfo("upsertInviteIntoOrgShow.add", {
      inviteCode: safeCode,
      organizationId,
      displayName,
    });
  } catch (error) {
    // 缓存写入失败不影响识别结果的返回，仅打日志
    logError("upsertInviteIntoOrgShow.swallow", error, {
      inviteCode: safeCode,
      organizationId,
    });
  }
}

// 新增：把本次使用的识别码+机构信息追加到对应家长文档的 P_recognized_invites 内嵌数组
// 对应"归到对应家长的文档下"的核心诉求；仅在 submitBooking（真正使用了识别码）时调用，
// 纯 resolveInvite（只是识别看看）不写入，避免家长历史里堆满无效浏览记录。
// 使用数组对象的结构 { inviteCode, displayName, recognizedAt }，
// 并做去重：同一个 inviteCode 只保留最近一次的时间（旧的先 _.pull 再 concat）。
async function appendRecognizedHistoryToParent(parentId = "", openid = "", inviteCode = "", target = {}) {
  const safeParentId = String(parentId || "").trim();
  const safeOpenid = String(openid || "").trim();
  const safeCode = normalizeInviteCode(inviteCode);
  if (!safeParentId || !safeCode) {
    return;
  }
  try {
    const now = getNow();
    const snapshot = buildTargetSnapshot(target) || {};
    const historyItem = {
      parentOpenid: safeOpenid,
      parentId: safeParentId,
      inviteCode: safeCode,
      displayName: String(snapshot.displayName || snapshot.organizationName || "").trim(),
      coachName: String(snapshot.coachName || "").trim(),
      themeColor: String(snapshot.themeColor || "").trim(),
      recognizedAt: now,
      createdAt: now,
    };
    // 阶段1-2：识别码历史写入 ForP_invites 子集合（不再 append 到主文档 P_recognized_invites 内嵌数组）
    await db.collection(FORP_INVITES_COLLECTION).add({ data: historyItem });
    logInfo("appendRecognizedHistoryToParent.done", {
      parentId: safeParentId.slice(0, 6) + "***",
      inviteCode: safeCode,
      displayName: historyItem.displayName,
    });
  } catch (error) {
    // 写入失败不影响提交表单的主流程
    logError("appendRecognizedHistoryToParent.swallow", error, {
      parentId: (parentId || "").slice(0, 6) + "***",
      inviteCode: safeCode,
    });
  }
}
// ---------- 识别码缓存：独立集合 + 家长内嵌识别历史 end ----------

// ---------- forP_class 视图集合：辅助函数（新增） ----------
// 说明：forP_class 专门缓存"每个家长给前端展示的最新视图"，
// 避免每次读都从 dev_ForP 内嵌数组里实时查找+拼接。写入失败一律只打日志，
// 绝不影响主流程（submitBooking/syncCoachResultToB 的业务结果），
// 一致性由 login 阶段的兜底刷新保证。

// 阶段1-2/3-3：forP_class 视图缓存已整体删除（ensureForPClassCollection / buildForPClassDoc /
// findForPClassDoc / isForPClassFresh / upsertForPClassDoc）。latestRequest 改由 getLatestRequest
// 直接从 ForP_courses 子集合实时查，不再走缓存。dev/real_forP_class 集合可手动删除。


async function getLatestRequest(openid, parent) {
  const parentBasic = getParentBasic(parent) || {};
  let formDoc = null;
  let courseDoc = null;

  // 阶段1-2：从 ForP_forms/ForP_courses 子集合查（不再读主文档内嵌数组）
  if (parentBasic.latestFormId) {
    formDoc = await getFormById(parentBasic.latestFormId);
  }
  if (!formDoc) {
    formDoc = await getLatestForm(openid);
  }

  if (parentBasic.latestCourseId) {
    courseDoc = await getCourseById(parentBasic.latestCourseId);
  }
  if (!courseDoc && formDoc) {
    courseDoc = await getCourseByFormId(formDoc._id);
  }
  if (!courseDoc) {
    courseDoc = await getLatestCourse(openid);
  }

  return buildLatestRequest(formDoc, courseDoc);
}

// 新增（parent_classshow 三段展示，2026-10-13）：一次拉家长所有课程 + 表单，
// 按 courseDoc ↔ formId 配对，用 buildLatestRequest 构造每条课程视图。
// 家长端按「当前课程 / 多个课程 / 历史记录」分组展示，每条都带 courseId 让「修改」按钮可以直接透传 id。
// 性能：courses 与 forms 各一次 where 拉全量（最多 100 条），formMap 在内存里按 _id 索引，避免 N 次 doc().get()。
async function listCoursesByOpenid(openid) {
  if (!openid) return [];
  try {
    const courseRes = await db
      .collection(FORP_COURSES_COLLECTION)
      .where({ parentOpenid: openid })
      .orderBy("updatedAt", "desc")
      .limit(100)
      .get();
    const courseList = (courseRes && courseRes.data) || [];
    if (!courseList.length) return [];

    const formRes = await db
      .collection(FORP_FORMS_COLLECTION)
      .where({ parentOpenid: openid })
      .orderBy("updatedAt", "desc")
      .limit(100)
      .get();
    const formMap = {};
    ((formRes && formRes.data) || []).forEach((f) => {
      if (f && f._id) formMap[f._id] = f;
    });

    return courseList
      .map((c) => {
        const formDoc = (c && c.formId && formMap[c.formId]) || null;
        return buildLatestRequest(formDoc, c);
      })
      .filter(Boolean);
  } catch (e) {
    logError("listCoursesByOpenid.swallow", e, { openid: maskOpenid(openid) });
    return [];
  }
}

async function login() {
  const openid = getOpenid();
  logInfo("login.start", {
    openid: maskOpenid(openid),
  });
  if (!openid) {
    return {
      success: false,
      message: "无法获取当前用户身份",
    };
  }

  await ensureCollection(FORP_COLLECTION);
  const parent = await getOrCreateParent(openid);

  // 阶段1-2/3-3：forP_class 视图缓存已删除，直接从 ForP_courses 子集合实时查 latestRequest。
  const latestRequest = await getLatestRequest(openid, parent);

  logInfo("login.success", {
    openid: maskOpenid(openid),
    parentId: (parent && parent._id) || "",
    latestFormId: (latestRequest && latestRequest.formId) || "",
    latestCourseId: (latestRequest && latestRequest.courseId) || "",
  });

  return {
    success: true,
    openid,
    parent: buildParentClientView(parent),
    latestRequest,
  };
}

async function resolveInvite(event) {
  logInfo("resolveInvite.start", {
    inviteCode: normalizeInviteCode(event && event.inviteCode),
  });
  await ensureCollection(FORP_COLLECTION);

  const inviteCode = normalizeInviteCode(event.inviteCode);
  if (!inviteCode) {
    return {
      success: false,
      // 展示文案统一为「识别码」，底层字段 inviteCode 保持不变
      message: "请先输入识别码",
    };
  }

  const target = await findInviteTarget(inviteCode);
  if (!target) {
    logInfo("resolveInvite.miss", {
      inviteCode,
    });
    return {
      success: false,
      message: "识别码不存在",
    };
  }

  logInfo("resolveInvite.success", {
    inviteCode,
    targetType: target.targetType || "",
    displayName: target.displayName || "",
  });
  return {
    success: true,
    target: buildTargetCard(target),
  };
}

async function submitBooking(event) {
  const openid = getOpenid();
  logInfo("submitBooking.start", {
    openid: maskOpenid(openid),
    inviteCode: normalizeInviteCode(event && event.inviteCode),
  });
  if (!openid) {
    return {
      success: false,
      message: "无法获取当前用户身份",
    };
  }

  await ensureCollection(FORP_COLLECTION);

  const inviteCode = normalizeInviteCode(event.inviteCode);
  const parentName = String(event.parentName || "").trim();
  const contact = String(event.contact || event.phone || "").trim();
  const phone = String(event.phone || contact || "").trim();
  const frequency = String(event.frequency || "").trim();
  const location = String(event.location || "").trim();
  const latitude = event.latitude || "";
  const longitude = event.longitude || "";
  // 新增：优先使用前端 parent_add.js 传过来的 fulfill_state，
  // 没传时默认 'editing'（家长提交的新课程默认是待编辑阶段），
  // 避免旧链路写死 pending 导致 A 端权限被锁死在非编辑阶段。
  const explicitFulfillState = String(event.fulfill_state || "").trim();
  const fulfillState =
    explicitFulfillState === "editing" ||
    explicitFulfillState === "awaiting" ||
    explicitFulfillState === "in_progress"
      ? explicitFulfillState
      : "editing";
  let childProfiles = normalizeChildProfiles(event.childProfiles || []);
  if (!childProfiles.length) {
    childProfiles = normalizeChildProfiles([
      {
        nickname: String(event.childName || "").trim(),
        age: String(event.childAge || "").trim(),
        gender: String(event.childGender || "").trim(),
        height: String(event.childHeight || "").trim(),
        weight: String(event.childWeight || "").trim(),
      },
    ]);
  }
  const firstChild = childProfiles[0] || {
    nickname: "",
    age: "",
    gender: "",
    height: "",
    weight: "",
  };
  // 这里继续保留单孩子平铺字段，方便现有展示页直接读取，不强制它们一次性改成多孩子渲染。
  const childName = firstChild.nickname || "";
  const childAge = firstChild.age || "";
  const note = String(event.note || "").trim();
  // 课程目标字段（跟随家长约课表单提交）：与 A 端 course_target 结构对齐。
  const courseTarget = {
    category: String(event.category || "").trim(),
    title: String(event.title || "").trim(),
    sub_plan_name: String(event.sub_plan_name || "").trim(),
    course_plan: String(event.course_plan || "").trim(),
    description: String(event.description || "").trim(),
  };

  // 新增（机构展示页改版，2026-09-05）：家长从扫码落地页（entry_landing）进约课页提交时，
  // 前端会带上入口上下文（parent_add.js submitBooking 透传 sourceEntryId / sourceTargetType / sourceTargetId）。
  // 之前这组字段到云函数后被丢弃，B 侧只剩 inviteCode，机构展示页反查不到完整展示文档；
  // 这里收口成 entryContext 随表单 / 课程记录一起落库，buildLatestRequest 再带给前端机构展示页使用。
  // 机构入口时 targetId 即 A 侧 organizationId，可直接用于查 dev_forPshowC。
  const entryContext = {
    entryId: String(event.sourceEntryId || "").trim(),
    targetType: String(event.sourceTargetType || "").trim(),
    targetId: String(event.sourceTargetId || "").trim(),
  };

  // 识别码改为必填：必须确保识别码对应的教练/机构对象存在，才能正确分配约课单。
  // 同时任务位置、联系方式也为必填；家长姓名、孩子信息为选填。
  if (!inviteCode || !contact || !location) {
    logInfo("submitBooking.invalid", {
      openid: maskOpenid(openid),
      inviteCode,
      hasParentName: !!parentName,
      hasContact: !!contact,
      hasLocation: !!location,
      childCount: childProfiles.length,
    });
    return {
      success: false,
      message: "请先填写完整信息",
    };
  }

  // 识别码改为必填：无条件执行识别码有效性校验，确保对应的教练/机构对象真实存在。
  let target = await findInviteTarget(inviteCode);
  if (!target) {
    logInfo("submitBooking.inviteMiss", {
      openid: maskOpenid(openid),
      inviteCode,
    });
    return {
      success: false,
      message: "识别码不存在，请联系教练确认",
    };
  }

  const parent = await getOrCreateParent(openid);
  const now = getNow();
  const parentBasic = getParentBasic(parent) || buildDefaultPBasic(now);
  // 识别码为必填，target 必然已存在，这里直接构造 targetSnapshot，保证下游能拿到正确的归属教练/机构信息。
  const targetSnapshot = buildTargetSnapshot(target);

  // 提交语义（2026-10-13 调整）：「带 id 修改，没带 id 新建」。
  //
  // 原逻辑（2026-10-11）：没传 courseId 时会按 findActiveCourseByInviteCode 自动把同识别码下的
  // 活跃课程转成「修改信息」，导致家长第二次提交（同识别码）永远无法新建第二条约课——
  // 与新需求「没带 id = 新建」冲突，这里移除该自动回落。
  //
  // 现在的判定：
  //   1) 前端 parent_add「修改」入口（parent_classshow / A 历史预约「带这条去修改」）透传 event.courseId
  //      → 按 id 查找待修改课程（findActiveCourseById，无条件覆写，含已结课/取消等终态）；
  //   2) 没传 courseId（新建模式 /「+ 新建约课」按钮 / 首次提交）
  //      → 直接走「新建预约」，生成全新 formId / courseId 落新记录。
  const courseIdFromClient = String(event.courseId || "").trim();
  let existingActive = null;
  if (courseIdFromClient) {
    existingActive = await findActiveCourseById(openid, courseIdFromClient);
  }
  const isModify = !!(existingActive && existingActive._id && existingActive.formId);
  const formId = isModify ? existingActive.formId : generateInnerRecordId("form");
  const courseId = isModify ? existingActive._id : generateInnerRecordId("course");
  // 修改信息时保留原记录的创建时间，避免每次修改都把 createdAt 刷新成现在。
  const preservedCreatedAt = isModify ? (existingActive.createdAt || now) : now;

  // 约课表单仍按 P_CourseFormCollection 分类，但现在挂到同一个家长主文档里。
  const formData = {
    _id: formId,
    openid,
    parentBasicId: parent._id,
    inviteCode,
    source: SOURCE_FROM_B_PARENT,
    bridge_status: BRIDGE_STATUS_PENDING,
    a_order_id: "",
    parent_course_code: "",
    last_sync_at: null,
    bridge_error_message: "",
    a_result_snapshot: null,
    targetSnapshot,
    // 新增（机构展示页改版）：扫码入口归因上下文，机构展示页据此拉取完整展示文档。
    entryContext,
    parentName,
    phone,
    course_basic: {
      frequency,
      location,
      contact,
      latitude,
      longitude,
    },
    // 课程目标：与 A 端 course_target 结构对齐（category/title/sub_plan_name/description/course_plan）。
    course_target: courseTarget,
    child_profile: {
      nickname: firstChild.nickname || "",
      age: firstChild.age || "",
      gender: firstChild.gender || "",
      height: firstChild.height || "",
      weight: firstChild.weight || "",
    },
    child_profiles: childProfiles,
    childName,
    childAge,
    note,
    createdAt: preservedCreatedAt,
    updatedAt: now,
  };

  // 课程记录仍按 P_CourseWithCoach 分类，但现在挂到同一个家长主文档里。
  const courseData = {
    _id: courseId,
    openid,
    parentBasicId: parent._id,
    formId,
    inviteCode,
    source: SOURCE_FROM_B_PARENT,
    bridge_status: BRIDGE_STATUS_PENDING,
    a_order_id: "",
    parent_course_code: "",
    last_sync_at: null,
    bridge_error_message: "",
    a_result_snapshot: null,
    targetSnapshot,
    // 新增（机构展示页改版）：课程记录同步保留扫码入口归因上下文，与表单记录口径一致。
    entryContext,
    status: "pending",
    coachSchedule: null,
    createdAt: preservedCreatedAt,
    updatedAt: now,
  };

  const nextHistoryRecords = (parentBasic.historyRecords || []).concat([
    {
      type: isModify ? "modify_course_form" : "submit_course_form",
      text: isModify ? "修改家长约课信息" : "提交新的家长约课表单",
      inviteCode,
      formId,
      courseId,
      at: now,
    },
  ]);
  const nextPBasic = {
    ...parentBasic,
    role: "P",
    latestInviteCode: inviteCode,
    latestFormId: formId,
    latestCourseId: courseId,
    targetSnapshot,
    historyRecords: nextHistoryRecords,
    updatedAt: now,
  };
  // 阶段1-2：表单/课程写入子集合（doc(_id).set 指定 _id=formId/courseId，与 latestFormId/latestCourseId 指针一致）
  const formDocData = { ...formData, parentOpenid: openid, parentId: parent._id };
  delete formDocData._id;
  await db.collection(FORP_FORMS_COLLECTION).doc(formId).set({ data: formDocData });
  const courseDocData = { ...courseData, parentOpenid: openid, parentId: parent._id };
  delete courseDocData._id;
  await db.collection(FORP_COURSES_COLLECTION).doc(courseId).set({ data: courseDocData });

  // 主文档只更新 P_basic 指针（latestFormId/latestCourseId/targetSnapshot/historyRecords），不再内嵌数组
  await db.collection(FORP_COLLECTION).doc(parent._id).update({
    data: {
      [BASIC_FIELD]: _.set(nextPBasic),
      updatedAt: now,
    },
  });

  let nextParent = {
    ...parent,
    [BASIC_FIELD]: nextPBasic,
    updatedAt: now,
  };

  let bridgeStatus = BRIDGE_STATUS_PENDING;
  let aOrderId = "";
  let parentCourseCode = "";
  let lastSyncAt = null;
  let bridgeErrorMessage = "";
  let aResultSnapshot = null;

  try {
    const bridgeResult = await syncBookingToA({
      inviteCode,
      parentName,
      phone,
      contact,
      frequency,
      location,
      latitude,
      longitude,
      childName,
      childAge,
      childProfiles,
      note,
      targetSnapshot,
      // 课程目标：跟随约课单透传给 A 侧 twowaybinding_1_DLforC，落 teaching_record（course_target）。
      category: courseTarget.category,
      title: courseTarget.title,
      sub_plan_name: courseTarget.sub_plan_name,
      course_plan: courseTarget.course_plan,
      description: courseTarget.description,
      // 新增：把前端指定的 fulfill_state（或我们兜底的 editing）透传给 A 侧，
      // 让 twowaybinding_1_DLforC 不再写死为 pending，避免 A 端课程管理权限被锁死。
      fulfill_state: fulfillState,
      from_b_form_id: formId,
      from_b_course_id: courseId,
      from_b_openid: openid,
    });

    lastSyncAt = getNow();
    aOrderId = extractAOrderId(bridgeResult);
    parentCourseCode = extractParentCourseCode(bridgeResult);
    aResultSnapshot = {
      a_order_id: aOrderId,
      parent_course_code: parentCourseCode,
      raw: bridgeResult && bridgeResult.data ? bridgeResult.data : null,
    };

    if (bridgeResult && bridgeResult.success !== false) {
      bridgeStatus = BRIDGE_STATUS_SYNCED;
    } else {
      bridgeStatus = BRIDGE_STATUS_FAILED;
      bridgeErrorMessage = String(
        bridgeResult && (
          bridgeResult.message ||
          bridgeResult.errorMessage ||
          (bridgeResult.data && bridgeResult.data.message)
        ) || "A 侧桥接失败"
      ).trim();
    }
  } catch (error) {
    bridgeStatus = BRIDGE_STATUS_FAILED;
    lastSyncAt = getNow();
    bridgeErrorMessage = String(
      error && (error.message || error.errMsg) || error || "A 侧桥接失败"
    ).trim();
    logError("submitBooking.bridgeFail", error, {
      inviteCode,
      formId,
      courseId,
    });
  }

  // 新增双写桥接状态：无论 A 成功还是失败，都把本次桥接结果留在 B 侧，方便后续补偿。
  const bridgeUpdatedAt = getNow();
  const bridgedFormData = {
    ...formData,
    source: SOURCE_FROM_B_PARENT,
    bridge_status: bridgeStatus,
    a_order_id: aOrderId,
    parent_course_code: parentCourseCode,
    last_sync_at: lastSyncAt,
    bridge_error_message: bridgeErrorMessage,
    a_result_snapshot: aResultSnapshot,
    updatedAt: bridgeUpdatedAt,
  };
  const bridgedCourseData = {
    ...courseData,
    source: SOURCE_FROM_B_PARENT,
    bridge_status: bridgeStatus,
    a_order_id: aOrderId,
    parent_course_code: parentCourseCode,
    last_sync_at: lastSyncAt,
    bridge_error_message: bridgeErrorMessage,
    a_result_snapshot: aResultSnapshot,
    updatedAt: bridgeUpdatedAt,
  };
  const bridgedPBasic = {
    ...nextPBasic,
    updatedAt: bridgeUpdatedAt,
  };

  // 阶段1-2：桥接结果双写——覆盖更新子集合里刚写入的表单/课程文档（按 _id=formId/courseId）
  const bridgedFormDocData = { ...bridgedFormData, parentOpenid: openid, parentId: parent._id };
  delete bridgedFormDocData._id;
  await db.collection(FORP_FORMS_COLLECTION).doc(formId).set({ data: bridgedFormDocData });
  const bridgedCourseDocData = { ...bridgedCourseData, parentOpenid: openid, parentId: parent._id };
  delete bridgedCourseDocData._id;
  await db.collection(FORP_COURSES_COLLECTION).doc(courseId).set({ data: bridgedCourseDocData });

  // 主文档更新 P_basic 时间戳
  await db.collection(FORP_COLLECTION).doc(parent._id).update({
    data: {
      [BASIC_FIELD]: _.set(bridgedPBasic),
      updatedAt: bridgeUpdatedAt,
    },
  });

  nextParent = {
    ...nextParent,
    [BASIC_FIELD]: bridgedPBasic,
    updatedAt: bridgeUpdatedAt,
  };

  // 给前端返回的 request 对象提前算好
  const latestRequestForReturn = buildLatestRequest(bridgedFormData, bridgedCourseData);

  // 阶段1-2：forP_class 视图缓存已删除，不再 upsert；latestRequest 直接返回前端。

  // 新增：将本次真正使用的识别码追加到该家长文档的内嵌 P_recognized_invites 数组，
  // 对应"将识别码缓存归到对应家长的文档下"的诉求；
  // 只存该家长自己提交过的识别码（纯浏览识别的不写入，避免历史噪音）。
  // 函数内部已吞所有异常，失败不影响主流程。
  await appendRecognizedHistoryToParent(parent._id || "", openid, inviteCode, targetSnapshot);

  logInfo("submitBooking.success", {
    openid: maskOpenid(openid),
    inviteCode,
    parentId: parent._id || "",
    formId,
    courseId,
    childCount: childProfiles.length,
    bridgeStatus,
    aOrderId,
    parentCourseCode,
  });
  return {
    success: true,
    parent: buildParentClientView(nextParent),
    bridgeStatus,
    aOrderId,
    parentCourseCode,
    bridgeErrorMessage,
    request: latestRequestForReturn,
    // 新增（不允许重复提交）：告知前端本次是「修改信息」还是「新建预约」，便于展示对应文案。
    mode: isModify ? "modify" : "create",
  };
}

async function getMyCourse() {
  const openid = getOpenid();
  logInfo("getMyCourse.start", {
    openid: maskOpenid(openid),
  });
  if (!openid) {
    return {
      success: false,
      message: "无法获取当前用户身份",
    };
  }

  await ensureCollection(FORP_COLLECTION);

  const parent = await getOrCreateParent(openid);

  // 阶段1-2/3-3：forP_class 视图缓存已删除，直接从 ForP_courses 子集合实时查 latestRequest。
  const latestRequest = await getLatestRequest(openid, parent);

  // 新增（parent_classshow 三段展示，2026-10-13）：拉家长所有课程列表，
  // 前端按「当前课程 / 多个课程 / 历史记录」分组展示，每条都带 courseId 让「修改」按钮直接透传 id。
  // latestRequest 仍单独返回，前端首页/我的页只关心最新一条；parent_classshow 同时用 latestRequest + allCourses。
  const allCourses = await listCoursesByOpenid(openid);

  logInfo("getMyCourse.success", {
    openid: maskOpenid(openid),
    parentId: (parent && parent._id) || "",
    latestFormId: (latestRequest && latestRequest.formId) || "",
    latestCourseId: (latestRequest && latestRequest.courseId) || "",
    allCoursesCount: Array.isArray(allCourses) ? allCourses.length : 0,
  });

  return {
    success: true,
    latestRequest,
    allCourses,
  };
}

// 新增（2026-10-11）：家长端「课节列表 / 每日总结」展示页专用 —— 按课程 id 取单条课程，
// 把 A 侧全量回抄的 a_result_snapshot.order_snapshot（含整张课表 + 每日总结）整理成
// 与 A 端 get_oneorder 同构的订单对象返回，前端展示页直接复用 normalizeOrderView。
// 入参：event.orderId = 家长课程记录 _id（前端取 latestRequest.courseId）。
// 安全：只允许返回属于当前 openid 的课程，避免越权查看他人课程。
async function getCourseDetail(event = {}) {
  const openid = getOpenid();
  logInfo("getCourseDetail.start", {
    openid: maskOpenid(openid),
    orderId: String((event && event.orderId) || ""),
  });
  if (!openid) {
    return { success: false, message: "无法获取当前用户身份" };
  }

  await ensureCollection(FORP_COLLECTION);
  await ensureCollection(FORP_COURSES_COLLECTION);

  const orderId = String((event && event.orderId) || "").trim();

  let courseDoc = null;
  if (orderId) {
    courseDoc = await getCourseById(orderId);
  }
  if (!courseDoc) {
    // 没传 id 或 id 查不到时，回落到该家长最新一条课程，避免页面白屏。
    courseDoc = await getLatestCourse(openid);
  }

  // 越权拦截：课程必须属于当前家长（parentOpenid / openid 任一匹配即可，兼容新旧写入）。
  const courseOwner = String((courseDoc && (courseDoc.parentOpenid || courseDoc.openid)) || "");
  if (!courseDoc || (courseOwner && courseOwner !== openid)) {
    logInfo("getCourseDetail.notFound", {
      openid: maskOpenid(openid),
      orderId,
      hasCourse: !!courseDoc,
    });
    return { success: false, message: "未找到课程" };
  }

  // 表单记录用于补齐 course_basic / course_target / child_profiles 等 B 侧原始字段（order_snapshot 缺失时兜底）。
  let formDoc = null;
  if (courseDoc.formId) {
    formDoc = await getFormById(courseDoc.formId);
  }

  const snapshot =
    (courseDoc && courseDoc.a_result_snapshot) ||
    (formDoc && formDoc.a_result_snapshot) ||
    null;

  // order_snapshot 是 A 侧整包订单（10-10 起全量推），与 A 端 get_oneorder 返回的订单同构。
  const orderSnapshot =
    snapshot && typeof snapshot.order_snapshot === "object" ? snapshot.order_snapshot : null;

  // 修复（2026-10-13 · 每日总结始终为 0）：A 端推送的 order_snapshot 是原始订单 doc，
  // 课表在内层 course_flow_info.schedule（不是顶层 order_snapshot.schedule），B 端旧读法拿不到 → 课节列表空白 + 每日总结恒为 0。
  // 这里用 extractSnapshotSchedule 统一从 order_snapshot.schedule / course_flow_info.schedule / a_result_snapshot.schedule 兜底取课表。
  const snapshotSchedule = extractSnapshotSchedule(snapshot);
  const fallbackSchedule =
    (snapshotSchedule.length ? snapshotSchedule : null) ||
    (courseDoc && Array.isArray(courseDoc.coachSchedule) && courseDoc.coachSchedule.length ? courseDoc.coachSchedule : null) ||
    null;

  // 组装返回订单：优先 order_snapshot（schedule / course_target / course_basic / course_flow_info 等齐全），
  // 再合并快照顶层扁平字段做兜底，最后用 B 侧表单字段补齐可能缺失的结构化字段。
  const orderData = {};
  if (orderSnapshot) {
    Object.assign(orderData, orderSnapshot);
  }
  // 兜底 schedule：order_snapshot 缺失或 schedule 字段为空时，用 fallbackSchedule 补齐。
  if (fallbackSchedule && !Array.isArray(orderData.schedule)) {
    orderData.schedule = fallbackSchedule;
  }
  if (snapshot) {
    [
      "fulfill_state",
      "progress_total",
      "progress_done",
      "parent_course_code",
      "close_summary",
      "close_coach_note",
      "cancel_reason",
      "completed_at",
      "cancelled_at",
      "closed_at",
      "schedule_stats",
      "latest_lesson",
    ].forEach((key) => {
      if (snapshot[key] !== undefined && orderData[key] === undefined) {
        orderData[key] = snapshot[key];
      }
    });
  }
  if (formDoc) {
    if (!orderData.course_basic && formDoc.course_basic) orderData.course_basic = formDoc.course_basic;
    if (!orderData.course_target && formDoc.course_target) orderData.course_target = formDoc.course_target;
    if (!orderData.child_profiles && formDoc.child_profiles) orderData.child_profiles = formDoc.child_profiles;
    if (!orderData.child_profile && formDoc.child_profile) orderData.child_profile = formDoc.child_profile;
  }
  // 兜底时间：A 端订单用 createdAt，B 侧课程记录也有 createdAt，便于展示页 buildCreatedTimeDisplay。
  if (!orderData.createdAt) {
    orderData.createdAt =
      (courseDoc && courseDoc.createdAt) || (formDoc && formDoc.createdAt) || null;
  }

  // 修复（2026-10-13 · 每日总结始终为 0）：把原始 order_snapshot 归一化成展示页预期的结构
  // （顶层 schedule / course_target / course_basic / child_profile / history_sync / progress 等），
  // 否则家长端展示页（从 A 端复制）读不到课表 → 课节列表与每日总结恒为空。
  const normalizedOrderData = normalizeSnapshotForParent(orderData);

  logInfo("getCourseDetail.success", {
    openid: maskOpenid(openid),
    courseId: (courseDoc && courseDoc._id) || "",
    aOrderId: (courseDoc && courseDoc.a_order_id) || "",
    scheduleCount: Array.isArray(normalizedOrderData.schedule) ? normalizedOrderData.schedule.length : 0,
  });

  return {
    success: true,
    data: normalizedOrderData,
    courseId: (courseDoc && courseDoc._id) || "",
    aOrderId: (courseDoc && courseDoc.a_order_id) || "",
  };
}

// ===== 课程码参课（joinCourseByCode）新增 =====
// 场景：家长忘记在 B 约课，A 端教练直建了课程后，家长拿到课程码到 B 输入参课。
// 流程：B 调 A 侧 twowaybinding_1_DLforC/joinCourseByCode（查码 + 绑定家长 openid），
// 成功后在 B 建一条课程记录（ForP_courses），出现在家长「上课信息」列表。

// 组装发往 A 侧的参课载荷（课程码 + 家长身份）。
function buildJoinCourseByCodePayload(payload = {}) {
  const rawPayload = payload || {};
  return {
    action: ACTION_JOIN_COURSE_BY_CODE,
    courseCode: String(rawPayload.courseCode || "").replace(/\s+/g, "").trim(),
    parentOpenid: String(rawPayload.parentOpenid || "").trim(),
    parentName: String(rawPayload.parentName || "").trim(),
    parentPhone: String(rawPayload.parentPhone || "").trim(),
    envVersion: CURRENT_ENV_VERSION,
  };
}

// 从 A 侧返回的课程卡片构造 B 侧 targetSnapshot（展示归属机构/教练）。
function buildTargetSnapshotFromCourseCard(card = {}) {
  const inviteCode = normalizeInviteCode(card.inviteCode || "");
  const orgName = String(card.orgName || "").trim();
  const coachName = String(card.coachName || "").trim();
  const title = String(card.title || "").trim();
  const displayName = orgName || coachName || "已参课课程";
  return {
    inviteCode,
    targetType: card.orgId ? "org" : "coach",
    displayName,
    description: title ? `${displayName} - ${title}` : `${displayName} - 课程码参课`,
    pageTitle: `${displayName} - 我的课程`,
    coachName,
    organizationName: orgName,
    themeColor: "#2f6bff",
    organizationId: String(card.orgId || "").trim(),
    entryId: "",
  };
}

// 家长通过课程码参课：调 A 查码绑定 → B 落课程记录 → 更新家长指针。
async function joinCourseByCode(event) {
  const openid = getOpenid();
  const rawCourseCode = String((event && event.courseCode) || "").replace(/\s+/g, "").trim();
  logInfo("joinCourseByCode.start", {
    openid: maskOpenid(openid),
    courseCode: rawCourseCode,
  });
  if (!openid) {
    return { success: false, message: "无法获取当前用户身份" };
  }

  await ensureCollection(FORP_COLLECTION);
  await ensureCollection(FORP_COURSES_COLLECTION);

  if (!rawCourseCode) {
    return { success: false, message: "请先输入课程码" };
  }

  const parent = await getOrCreateParent(openid);
  const now = getNow();
  const parentBasic = getParentBasic(parent) || buildDefaultPBasic(now);

  // 1) 调 A 侧 joinCourseByCode：查码 + 绑定家长 openid，返回课程卡片。
  let bridgeResult;
  try {
    bridgeResult = await requestAHttpApi(buildJoinCourseByCodePayload({
      courseCode: rawCourseCode,
      parentOpenid: openid,
      parentName: String((event && event.parentName) || "").trim(),
      parentPhone: String((event && event.parentPhone) || (event && event.contact) || "").trim(),
    }));
  } catch (error) {
    logError("joinCourseByCode.bridgeFail", error, { courseCode: rawCourseCode });
    return {
      success: false,
      message: "参课失败，请稍后重试",
    };
  }

  const resultData = (bridgeResult && bridgeResult.data) || {};
  if (bridgeResult && bridgeResult.success === false) {
    return {
      success: false,
      message: String(resultData.message || resultData.errorMessage || "未找到对应课程码"),
    };
  }

  const aOrderId = extractAOrderId(bridgeResult);
  const parentCourseCode = extractParentCourseCode(bridgeResult) || rawCourseCode;
  // A 侧在 data.data.course 里返回课程卡片（顶层同时铺了关键字段，兜底用 resultData）。
  const card = (resultData && resultData.course) || resultData || {};

  // 2) B 侧落一条课程记录（ForP_courses 子集合），出现在家长「上课信息」。
  const targetSnapshot = buildTargetSnapshotFromCourseCard(card);
  const courseId = generateInnerRecordId("course");
  const courseData = {
    openid,
    parentBasicId: parent._id,
    parentOpenid: openid,
    parentId: parent._id,
    formId: "",
    inviteCode: targetSnapshot.inviteCode,
    source: SOURCE_FROM_B_JOIN_CODE,
    bridge_status: BRIDGE_STATUS_SYNCED,
    a_order_id: aOrderId,
    parent_course_code: parentCourseCode,
    last_sync_at: now,
    bridge_error_message: "",
    a_result_snapshot: {
      a_order_id: aOrderId,
      parent_course_code: parentCourseCode,
      raw: resultData,
    },
    targetSnapshot,
    entryContext: { entryId: "", targetType: "", targetId: "" },
    status: "pending",
    coachSchedule: null,
    createdAt: now,
    updatedAt: now,
  };
  await db.collection(FORP_COURSES_COLLECTION).doc(courseId).set({ data: courseData });

  // 3) 主文档更新 P_basic 指针。
  const nextHistoryRecords = (parentBasic.historyRecords || []).concat([
    {
      type: "join_course_by_code",
      text: "通过课程码参课",
      inviteCode: targetSnapshot.inviteCode,
      courseId,
      parent_course_code: parentCourseCode,
      at: now,
    },
  ]);
  const nextPBasic = {
    ...parentBasic,
    role: "P",
    latestInviteCode: targetSnapshot.inviteCode || parentBasic.latestInviteCode || "",
    latestCourseId: courseId,
    targetSnapshot,
    historyRecords: nextHistoryRecords,
    updatedAt: now,
  };
  await db.collection(FORP_COLLECTION).doc(parent._id).update({
    data: {
      [BASIC_FIELD]: _.set(nextPBasic),
      updatedAt: now,
    },
  });

  logInfo("joinCourseByCode.success", {
    openid: maskOpenid(openid),
    courseCode: rawCourseCode,
    courseId,
    aOrderId,
    parentCourseCode,
  });

  return {
    success: true,
    message: "参课成功",
    courseId,
    aOrderId,
    parentCourseCode,
    courseCode: parentCourseCode,
    targetSnapshot,
  };
}

exports.main = async (event) => {
  // 新增（2026-09-06）：请求入口先按 envVersion 切换集合前缀（develop→dev_*，其余→real_*）。
  // 必须放在所有业务逻辑之前，确保本次请求读写的是对应环境的集合。
  // 调整（2026-10-10）：环境不再取 event.envVersion，改由部署侧登记固定（deploy-meta）。
  applyEnvVersion();
  const action = event.action || "login";
  logInfo("main.route", {
    action,
    // 新增（2026-09-06）：打印当前请求实际命中的集合名，便于排查 dev/real 是否串库。
    // 调整（2026-10-10）：envVersion 登记部署侧固定值，不再打印请求透传值。
    envVersion: DEPLOY_META.envVersion,
    forpCollection: FORP_COLLECTION,
    showCollection: SHOW_COLLECTION,
    // 调整（阶段1-1 拆子集合）：原 forP_class 视图缓存已删除，这里改打印 3 个拆分子集合名，保留 dev/real 串库排查能力。
    forpFormsCollection: FORP_FORMS_COLLECTION,
    forpCoursesCollection: FORP_COURSES_COLLECTION,
    forpInvitesCollection: FORP_INVITES_COLLECTION,
  });

  // 新增：全局兜底——任何未被 await/.catch 的 Promise rejection 都不要让 Node 崩溃（Node 15+ 默认崩溃）
  // 对应之前 findInviteTarget 里 fire-and-forget 的 upsert 调用，防止它们内部出错直接让进程退出
  // 只在当前这一次云函数实例内生效
  if (typeof process !== "undefined" && process && typeof process.on === "function") {
    try {
      process.on("unhandledRejection", (reason, promise) => {
        const reasonText = reason && (reason.message || reason.errMsg || String(reason).slice(0, 200));
        console.error("[DLforP__do][unhandledRejection.swallow]", {
          reason: reasonText,
          action,
          hasPromise: !!promise,
        });
      });
    } catch (_noop) { /* 注册失败忽略 */ }
  }

  try {
    switch (action) {
      case "login":
        return await login();
      case "resolveInvite":
        return await resolveInvite(event);
      case "submitBooking":
        return await submitBooking(event);
      case "getMyCourse":
        return await getMyCourse();
      case "getCourseDetail":
        return await getCourseDetail(event);
      case "joinCourseByCode":
        return await joinCourseByCode(event);
      default:
        logInfo("main.unsupported", {
          action,
        });
        return {
          success: false,
          message: "不支持的操作类型",
        };
    }
  } catch (error) {
    // 加固：把真实错误 message / errCode / 错误名带出，不要只返回笼统的"云函数执行失败"
    // 方便排查，尤其是部署后第一次调用触发的运行期错误
    const errName = (error && error.name) || "Error";
    const errMsg = (error && (error.message || error.errMsg)) || String(error || "");
    const errCode = error && (error.errCode || error.code || null);
    const safeErr = `${errName}${errCode ? `[${errCode}]` : ""}: ${errMsg}`;
    logError("main.crash", error, {
      action,
      // 多带一份已拼接的短文字，方便云函数日志直接搜索
      errSnippet: safeErr.slice(0, 300),
    });
    return {
      success: false,
      message: "云函数执行失败",
      // 新增：debug 字段携带真实错误信息，前端不用展示但控制台/抓包能看到
      debug: {
        action,
        errorName: errName,
        errorCode: errCode,
        errorMessage: errMsg,
        // requestID 方便对齐 SCF 控制台
        requestID: event && event.__context ? event.__context.request_id : "",
      },
    };
  }
};
