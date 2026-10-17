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

// 当前家长侧只保留 2 个实际数据合集：dev_ForP / real_ForP。
// P_identity / P_basic / P_CourseFormCollection / P_CourseWithCoach / TOP_invite_targets
// 就是 dev_ForP / real_ForP 这两个合集里的字段，不再当作独立合集创建。
// 调整（2026-09-06）：改为 let，由 applyEnvVersion 在请求入口动态赋值。
let FORP_COLLECTION = FORP_DB_ALIAS;
const IDENTITY_FIELD = "P_identity";
const BASIC_FIELD = "P_basic";
const FORM_FIELD = "P_CourseFormCollection";
const COURSE_FIELD = "P_CourseWithCoach";
// 【旧结构兼容：只读不写】
// 原来识别码缓存作为 TOP_invite_targets 写在 dev_ForP 顶层，和家长文档混在一起。
// 现改为：写到独立集合 dev_invite_targets（跨家长共享缓存）+ 家长文档内嵌 P_recognized_invites（该家长自己的识别历史）。
// INVITE_FIELD / RECORD_FIELD_KEY 仅用于查询历史存量的旧文档以做兼容，不再往 dev_ForP 顶层写入新的 TOP_invite_targets。
const INVITE_FIELD = "TOP_invite_targets";
const RECORD_FIELD_KEY = "forPField";
// 新增：识别码缓存——独立集合（跨家长共享），从 dev_ForP 顶层分离出去，避免混杂两种文档
// 调整（2026-09-06）：改为 let，由 applyEnvVersion 动态切换 dev_invite_targets / real_invite_targets。
let INVITE_TARGETS_COLLECTION = "dev_invite_targets";
// 新增：识别码缓存——家长文档内嵌数组（只存该家长自己识别并使用过的码，对应"归到对应家长的文档下"的诉求）
const RECOGNIZED_HISTORY_FIELD = "P_recognized_invites";
// 新增：forP_class 专门存放"给前端使用的最新视图数据"，每个家长一条，
// 写操作（submitBooking / syncCoachResultToB）完成后 upsert，读操作直接查询，
// 避免每次都从 dev_ForP 的内嵌数组里实时拼接。真实环境对应 real_forP_class。
// 调整（2026-09-06）：改为 let，由 applyEnvVersion 动态切换 dev_forP_class / real_forP_class。
let FORP_CLASS_COLLECTION = "dev_forP_class";
const VIEW_META_FIELD = "_view_meta";

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

function applyEnvVersion(envVersion = "") {
  // 与 A 侧 getCollectionPrefix 同一判定：仅 develop 走 dev，release/trial/空 一律按 release 走 real
  CURRENT_ENV_VERSION = envVersion === "develop" ? "develop" : "release";
  FORP_DB_ALIAS = envVersion === "develop" ? "dev_ForP" : "real_ForP";
  FORP_COLLECTION = FORP_DB_ALIAS;
  INVITE_TARGETS_COLLECTION = FORP_DB_ALIAS === "real_ForP" ? "real_invite_targets" : "dev_invite_targets";
  FORP_CLASS_COLLECTION = FORP_DB_ALIAS === "real_ForP" ? "real_forP_class" : "dev_forP_class";
}

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
    [FORM_FIELD]: getParentFormList(parentDoc),
    [COURSE_FIELD]: getParentCourseList(parentDoc),
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
  const statusTextMap = {
    pending: "待安排",
    scheduled: "已安排",
    finished: "已完成",
    cancelled: "已取消",
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

function buildInviteTargetRecord(target = {}, now = getNow()) {
  const safeTarget = buildTargetCard(target);
  return {
    [RECORD_FIELD_KEY]: INVITE_FIELD,
    inviteCode: safeTarget.inviteCode,
    targetType: safeTarget.targetType,
    displayName: safeTarget.displayName,
    description: safeTarget.description,
    pageTitle: safeTarget.pageTitle,
    coachName: safeTarget.coachName,
    organizationName: safeTarget.organizationName,
    themeColor: safeTarget.themeColor,
    // 新增（机构展示页改版，2026-09-05）：扁平缓存同步保留机构主键 / 入口 ID。
    organizationId: safeTarget.organizationId,
    entryId: safeTarget.entryId,
    createdAt: now,
    updatedAt: now,
  };
}

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
  const queryString = buildQueryString(payload);
  const requestUrl = queryString
    ? `${baseUrl}?${queryString}`
    : baseUrl;

  return new Promise((resolve, reject) => {
    https
      .get(requestUrl, (response) => {
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
            requestUrl,
            statusCode: response.statusCode || 0,
            headers: response.headers || {},
            data: parsedBody,
            a_order_id: extractAOrderId(parsedBody),
          });
        });
      })
      .on("error", (error) => {
        reject(error);
      });
  });
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
    [FORM_FIELD]: [],
    [COURSE_FIELD]: [],
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

  const now = getNow();
  const currentIdentity = getParentIdentity(parentDoc) || {};
  const effectiveOpenid = currentIdentity.openid || parentDoc.openid || "";
  const hasStructuredParent = Boolean(
    getParentIdentity(parentDoc) &&
    getParentBasic(parentDoc) &&
    Array.isArray(parentDoc[FORM_FIELD]) &&
    Array.isArray(parentDoc[COURSE_FIELD])
  );

  if (hasStructuredParent && !hasLegacyParentRootFields(parentDoc)) {
    return parentDoc;
  }

  let rawFormList = [];
  let rawCourseList = [];

  if (hasStructuredParent) {
    rawFormList = getParentFormList(parentDoc);
    rawCourseList = getParentCourseList(parentDoc);
  } else {
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

  const formList = rawFormList.map((item) => normalizeNestedRecord(item, "legacy_form"));
  const courseList = rawCourseList.map((item) => normalizeNestedRecord(item, "legacy_course"));
  const latestForm = pickLatestRecord(formList);
  const latestCourse = pickLatestRecord(courseList);
  const nextPIdentity = {
    ...buildDefaultPIdentity(effectiveOpenid, parentDoc.createdAt || now),
    ...currentIdentity,
    openid: effectiveOpenid,
    updatedAt: now,
  };
  const defaultBasic = buildDefaultPBasic(parentDoc.createdAt || now);
  const currentBasic = getParentBasic(parentDoc) || {};
  const nextPBasic = {
    ...defaultBasic,
    ...currentBasic,
    role: currentBasic.role || parentDoc.role || ((formList.length || courseList.length) ? "P" : "V"),
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
      : Array.isArray(parentDoc.historyRecords) && parentDoc.historyRecords.length
      ? parentDoc.historyRecords
      : defaultBasic.historyRecords,
    createdAt: currentBasic.createdAt || parentDoc.createdAt || now,
    updatedAt: now,
  };

  // 修复：旧结构升级的顶层嵌套字段也用 _.set() 强制覆盖，
  // 避免旧文档内嵌字段是 null / 非对象时递归 merge 崩掉
  await db.collection(FORP_COLLECTION).doc(parentDoc._id).update({
    data: {
      [IDENTITY_FIELD]: _.set(nextPIdentity),
      [BASIC_FIELD]: _.set(nextPBasic),
      [FORM_FIELD]: _.set(formList),
      [COURSE_FIELD]: _.set(courseList),
      ...buildParentRootCleanupData(),
      updatedAt: now,
    },
  });

  const nextParentDoc = {
    ...parentDoc,
    [IDENTITY_FIELD]: nextPIdentity,
    [BASIC_FIELD]: nextPBasic,
    [FORM_FIELD]: formList,
    [COURSE_FIELD]: courseList,
    updatedAt: now,
  };
  delete nextParentDoc[RECORD_FIELD_KEY];
  delete nextParentDoc.openid;
  delete nextParentDoc.role;
  delete nextParentDoc.latestInviteCode;
  delete nextParentDoc.latestFormId;
  delete nextParentDoc.latestCourseId;
  delete nextParentDoc.targetSnapshot;
  delete nextParentDoc.historyRecords;

  return nextParentDoc;
}

async function getOrCreateParent(openid) {
  let parent = await findParentByOpenid(openid);
  if (!parent) {
    parent = await createDefaultParent(openid);
  }
  return await upgradeLegacyParentDoc(parent);
}

async function findInviteTarget(inviteCode) {
  const code = normalizeInviteCode(inviteCode);
  if (!code) {
    return null;
  }

  // 新增（机构展示页改版，2026-09-05）：机构类目标必须带 organizationId，
  // 家长端机构展示页才能拉到 dev_forPshowC 完整展示文档（轮播图 / 教练成员等）。
  // 2026-09-05 前写入的旧缓存（独立集合 snapshot / 旧顶层混杂文档）没有该字段，
  // 命中后不直接返回，落到第 3 优先级回 A 侧重取并回写缓存，完成一次自愈，之后都走新结构。
  const isStaleOrgTarget = (target) =>
    !!(target && target.targetType === "org" && !String(target.organizationId || "").trim());

  // 第 1 优先级：查独立集合 dev_invite_targets（新结构，跨家长共享，不和家长文档混杂）
  const standaloneTarget = await findInviteInStandaloneCollection(code);
  if (standaloneTarget) {
    // 独立集合存的是扁平结构+snapshot，这里还原成统一的 target 卡片格式
    const standaloneCandidate = standaloneTarget.snapshot || standaloneTarget;
    if (!isStaleOrgTarget(standaloneCandidate)) {
      logInfo("findInviteTarget.hitStandalone", {
        inviteCode: code,
        displayName: standaloneCandidate.displayName || "",
      });
      return standaloneCandidate;
    }
    logInfo("findInviteTarget.staleStandaloneRefresh", {
      inviteCode: code,
      displayName: standaloneCandidate.displayName || "",
    });
  }

  // 第 2 优先级（兼容旧数据）：查旧的 dev_ForP 顶层 TOP_invite_targets 混杂文档
  // 命中则原样返回，同时"顺手迁移"一份到新独立集合（下次识别就走第 1 优先级了）
  if (!standaloneTarget) {
    const legacyRes = await db.collection(FORP_COLLECTION).where({
      [RECORD_FIELD_KEY]: INVITE_FIELD,
      inviteCode: code,
    }).limit(1).get();
    const legacyTarget = (legacyRes && legacyRes.data && legacyRes.data[0]) || null;
    if (legacyTarget && !isStaleOrgTarget(legacyTarget)) {
      logInfo("findInviteTarget.hitLegacyMigrate", {
        inviteCode: code,
        legacyDocId: legacyTarget._id || "",
        displayName: legacyTarget.displayName || "",
      });
      // 异步迁移一份到新集合，不等待结果，不阻塞当前返回（即使失败也无所谓，下次还会再尝试）
      upsertStandaloneInviteTarget(legacyTarget).catch(() => {});
      return legacyTarget;
    }
    if (legacyTarget) {
      logInfo("findInviteTarget.staleLegacyRefresh", {
        inviteCode: code,
        legacyDocId: legacyTarget._id || "",
        displayName: legacyTarget.displayName || "",
      });
    }
  }

  // 第 3 优先级：本地任何缓存都没命中，回退到 A 侧真实机构库做识别
  // 【重要】查到结果后只 upsert 到新独立集合 dev_invite_targets，
  // 不再向 dev_ForP 顶层写入 TOP_invite_targets 混杂文档，保持 dev_ForP 顶层纯净。
  try {
    const remoteResult = await resolveInviteByA(code);
    const remoteData = remoteResult && remoteResult.data || {};
    const remoteTarget = remoteData && remoteData.target || null;

    if (!remoteResult || remoteResult.success === false || !remoteTarget) {
      logInfo("findInviteTarget.remoteNotFound", { inviteCode: code });
      return null;
    }

    const snapshot = buildTargetSnapshot(remoteTarget);
    // 只写新独立集合；同时保证 target 上带规范化后的 inviteCode
    const targetForReturn = {
      ...(remoteTarget || {}),
      inviteCode: code,
    };
    upsertStandaloneInviteTarget(targetForReturn).catch(() => {});

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

async function getLatestForm(parentDoc) {
  return pickLatestRecord(getParentFormList(parentDoc));
}

async function getLatestCourse(parentDoc) {
  return pickLatestRecord(getParentCourseList(parentDoc));
}

async function getFormById(parentDoc, formId) {
  if (!formId) {
    return null;
  }

  return findRecordById(getParentFormList(parentDoc), formId);
}

async function getCourseById(parentDoc, courseId) {
  if (!courseId) {
    return null;
  }

  return findRecordById(getParentCourseList(parentDoc), courseId);
}

async function getCourseByFormId(parentDoc, formId) {
  if (!formId) {
    return null;
  }

  return findCourseByFormId(getParentCourseList(parentDoc), formId);
}

function buildLatestRequest(formDoc, courseDoc) {
  if (!formDoc && !courseDoc) {
    return null;
  }

  const status = (courseDoc && courseDoc.status) || "pending";
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
    parentCourseCode:
      (courseDoc && courseDoc.parent_course_code) ||
      (formDoc && formDoc.parent_course_code) ||
      (((courseDoc && courseDoc.a_result_snapshot) || (formDoc && formDoc.a_result_snapshot) || {}).parent_course_code) ||
      (((courseDoc && courseDoc.a_result_snapshot) || (formDoc && formDoc.a_result_snapshot) || {}).joinCode) ||
      (((courseDoc && courseDoc.a_result_snapshot) || (formDoc && formDoc.a_result_snapshot) || {}).courseCode) ||
      // 新增：a_result_snapshot.raw 里可能还嵌了一层 data.data.joinCode/courseCode（旧 twowaybinding 返回结构），
      // 这里继续下钻，避免家长看到"同步成功但没码"的历史数据
      (((((courseDoc && courseDoc.a_result_snapshot) || (formDoc && formDoc.a_result_snapshot) || {}).raw || {}).data || {}).parent_course_code) ||
      (((((courseDoc && courseDoc.a_result_snapshot) || (formDoc && formDoc.a_result_snapshot) || {}).raw || {}).data || {}).joinCode) ||
      (((((courseDoc && courseDoc.a_result_snapshot) || (formDoc && formDoc.a_result_snapshot) || {}).raw || {}).data || {}).courseCode) ||
      ((((((courseDoc && courseDoc.a_result_snapshot) || (formDoc && formDoc.a_result_snapshot) || {}).raw || {}).data || {}).data || {}).parent_course_code) ||
      ((((((courseDoc && courseDoc.a_result_snapshot) || (formDoc && formDoc.a_result_snapshot) || {}).raw || {}).data || {}).data || {}).joinCode) ||
      ((((((courseDoc && courseDoc.a_result_snapshot) || (formDoc && formDoc.a_result_snapshot) || {}).raw || {}).data || {}).data || {}).courseCode) ||
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
    aResultSnapshot:
      (courseDoc && courseDoc.a_result_snapshot) ||
      (formDoc && formDoc.a_result_snapshot) ||
      null,
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

// ---------- 识别码缓存：独立集合 + 家长内嵌识别历史（新增） ----------
// 说明：
// 1. 原来的识别码缓存在 dev_ForP 顶层写 TOP_invite_targets 标记文档，和家长文档混杂；
//    现在改为使用【独立集合 dev_invite_targets】存跨家长共享的识别码卡片缓存，
//    避免 dev_ForP 里同时存在家长主文档和识别码缓存文档两种顶层记录。
// 2. 另外在每个家长主文档下新增【内嵌数组 P_recognized_invites】，
//    仅存该家长自己"真正使用过（即提交表单时使用）"的识别码历史，
//    满足"将识别码缓存归到对应家长文档下"的诉求；
//    纯粹 resolveInvite 但没提交的不写入家长历史，避免噪音。
// 3. 旧的 dev_ForP 顶层 TOP_invite_targets 文档保留只读兼容，不删除、也不再写新的。

// 新增：确保独立识别码缓存集合存在
async function ensureStandaloneInviteCollection() {
  try {
    await db.createCollection(INVITE_TARGETS_COLLECTION);
    logInfo("ensureStandaloneInviteCollection.create", {
      collectionName: INVITE_TARGETS_COLLECTION,
    });
  } catch (error) {
    logInfo("ensureStandaloneInviteCollection.skip", {
      collectionName: INVITE_TARGETS_COLLECTION,
      message: (error && (error.message || error.errMsg)) || "collection exists",
    });
  }
}

// 新增：从独立集合 dev_invite_targets 里按规范化后的 inviteCode 查询缓存卡片
async function findInviteInStandaloneCollection(code = "") {
  const safeCode = normalizeInviteCode(code);
  if (!safeCode) {
    return null;
  }
  try {
    await ensureStandaloneInviteCollection();
    const res = await db.collection(INVITE_TARGETS_COLLECTION).where({
      inviteCode: safeCode,
    }).limit(1).get();
    return Array.isArray(res.data) && res.data.length ? res.data[0] : null;
  } catch (error) {
    logError("findInviteInStandaloneCollection.swallow", error, {
      inviteCode: safeCode,
    });
    return null;
  }
}

// 新增：把 A 侧查到的识别码 target 卡片 upsert 到独立集合（跨家长共享）
// 每个规范化 inviteCode 只存一条；重复识别时只更新快照字段和 updatedAt。
async function upsertStandaloneInviteTarget(target = {}) {
  if (!target) {
    return;
  }
  const safeCode = normalizeInviteCode(target.inviteCode || "");
  if (!safeCode) {
    return;
  }
  try {
    await ensureStandaloneInviteCollection();
    const now = getNow();
    // 规范化 target，防止带进来 _id / forPField 等无关字段污染独立集合
    const cleanTarget = buildTargetSnapshot(target) || {};
    const docToSave = {
      inviteCode: safeCode,
      targetType: String(cleanTarget.targetType || "").trim(),
      displayName: String(cleanTarget.displayName || "").trim(),
      coachName: String(cleanTarget.coachName || "").trim(),
      organizationName: String(cleanTarget.organizationName || "").trim(),
      description: String(cleanTarget.description || "").trim(),
      pageTitle: String(cleanTarget.pageTitle || "").trim(),
      themeColor: String(cleanTarget.themeColor || "").trim(),
      // 新增（扫码自动补识别码，2026-09-06）：机构主键 / 入口 ID 顶层冗余一份
      // （snapshot 子对象里同样有），供 DLforP_entry_qrcode/resolve_entry 扫码时
      // 直接按顶层字段 where 反查识别码，避免跨函数依赖嵌套字段点查。
      organizationId: String(cleanTarget.organizationId || "").trim(),
      entryId: String(cleanTarget.entryId || "").trim(),
      // 保留完整 target 快照，后续如果 buildTargetSnapshot 结构变动也不会丢字段
      snapshot: cleanTarget,
      updatedAt: now,
    };

    const existed = await db.collection(INVITE_TARGETS_COLLECTION).where({
      inviteCode: safeCode,
    }).limit(1).get();
    if (Array.isArray(existed.data) && existed.data.length) {
      const docId = existed.data[0]._id;
      // 更新时保留 createdAt（如果原文档有），其它都用最新值覆盖
      const keepCreatedAt = (existed.data[0] && existed.data[0].createdAt) || now;
      await db.collection(INVITE_TARGETS_COLLECTION).doc(docId).update({
        data: {
          ...docToSave,
          createdAt: keepCreatedAt,
        },
      });
      logInfo("upsertStandaloneInviteTarget.update", {
        inviteCode: safeCode,
        docId,
        displayName: docToSave.displayName,
      });
    } else {
      const addRes = await db.collection(INVITE_TARGETS_COLLECTION).add({
        data: {
          ...docToSave,
          createdAt: now,
        },
      });
      logInfo("upsertStandaloneInviteTarget.add", {
        inviteCode: safeCode,
        newDocId: addRes && addRes._id || "",
        displayName: docToSave.displayName,
      });
    }
  } catch (error) {
    // 缓存写入失败不影响识别结果的返回，仅打日志
    logError("upsertStandaloneInviteTarget.swallow", error, {
      inviteCode: normalizeInviteCode(target && target.inviteCode),
    });
  }
}

// 新增：把本次使用的识别码+机构信息追加到对应家长文档的 P_recognized_invites 内嵌数组
// 对应"归到对应家长的文档下"的核心诉求；仅在 submitBooking（真正使用了识别码）时调用，
// 纯 resolveInvite（只是识别看看）不写入，避免家长历史里堆满无效浏览记录。
// 使用数组对象的结构 { inviteCode, displayName, recognizedAt }，
// 并做去重：同一个 inviteCode 只保留最近一次的时间（旧的先 _.pull 再 concat）。
async function appendRecognizedHistoryToParent(parentId = "", inviteCode = "", target = {}) {
  const safeParentId = String(parentId || "").trim();
  const safeCode = normalizeInviteCode(inviteCode);
  if (!safeParentId || !safeCode) {
    return;
  }
  try {
    const now = getNow();
    const snapshot = buildTargetSnapshot(target) || {};
    const historyItem = {
      inviteCode: safeCode,
      displayName: String(snapshot.displayName || snapshot.organizationName || "").trim(),
      coachName: String(snapshot.coachName || "").trim(),
      themeColor: String(snapshot.themeColor || "").trim(),
      recognizedAt: now,
    };
    // 先 push 最新的到数组最前面
    // 如果字段不存在 / 旧值是 null 或其他非数组类型，TCB 会报错；全部兜底到直接 _.set() 一个新数组
    const cmd = db.command;
    await db.collection(FORP_COLLECTION).doc(safeParentId).update({
      data: {
        [RECOGNIZED_HISTORY_FIELD]: cmd.push({
          each: [historyItem],
          position: 0, // 最新的放到数组最前面
        }),
        updatedAt: now,
      },
    }).catch(async (pushErr) => {
      // 兼容多种失败场景：
      // 1) 字段不存在 → field not exist
      // 2) 旧值非数组 → cannot / not array
      // 3) 旧值为 null → Cannot create field 'xxx' in element {P_recognized_invites: null}
      const msg = (pullErr && (pullErr.errMsg || pullErr.message)) || "";
      if (/field.*not.*exist|cannot.*array|cannot create field/i.test(msg)) {
        await db.collection(FORP_COLLECTION).doc(safeParentId).update({
          data: {
            // 兜底也用 _.set()，确保旧值为 null / 非对象时不会再递归 merge
            [RECOGNIZED_HISTORY_FIELD]: _.set([historyItem]),
            updatedAt: now,
          },
        });
        logInfo("appendRecognizedHistoryToParent.fallbackSet", {
          parentId: safeParentId.slice(0, 6) + "***",
          inviteCode: safeCode,
          reason: msg.slice(0, 120),
        });
      } else {
        throw pushErr; // 其他错误继续抛，外层 catch 吞
      }
    });
    logInfo("appendRecognizedHistoryToParent.done", {
      parentId: safeParentId.slice(0, 6) + "***",
      inviteCode: safeCode,
      displayName: historyItem.displayName,
    });
  } catch (error) {
    // 写入家长识别历史失败不影响提交表单的主流程
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

// 新增：确保 dev_forP_class 集合存在，避免第一次写入时集合不存在报错
async function ensureForPClassCollection() {
  try {
    await db.createCollection(FORP_CLASS_COLLECTION);
    logInfo("ensureForPClassCollection.create", {
      collectionName: FORP_CLASS_COLLECTION,
    });
  } catch (error) {
    // 集合已存在时直接忽略
    logInfo("ensureForPClassCollection.skip", {
      collectionName: FORP_CLASS_COLLECTION,
      message: (error && (error.message || error.errMsg)) || "collection exists",
    });
  }
}

// 新增：把 latestRequest 封装成 forP_class 集合要落的完整文档
function buildForPClassDoc(openid = "", parentId = "", latestRequest = null) {
  const now = getNow();
  const safeRequest = latestRequest || {};
  return {
    openid: String(openid || "").trim(),
    parentId: String(parentId || "").trim(),
    // 最新请求视图（原样透传给前端）
    latestRequest: safeRequest,
    // 视图元信息：updatedAt 用于登录兜底时判断视图是否过期
    [VIEW_META_FIELD]: {
      updatedAt: now,
      refreshedBy: "DLforP__do",
    },
    createdAt: now,
    updatedAt: now,
  };
}

// 新增：按 openid 从 forP_class 查当前家长的视图缓存
async function findForPClassDoc(openid = "") {
  const safeOpenid = String(openid || "").trim();
  if (!safeOpenid) {
    return null;
  }
  try {
    await ensureForPClassCollection();
    const res = await db.collection(FORP_CLASS_COLLECTION).where({
      openid: safeOpenid,
    }).limit(1).get();
    return Array.isArray(res.data) && res.data.length ? res.data[0] : null;
  } catch (error) {
    logError("findForPClassDoc.fail", error, {
      openid: maskOpenid(safeOpenid),
      collectionName: FORP_CLASS_COLLECTION,
    });
    return null;
  }
}

// 新增：判断 forP_class 缓存是否"新鲜"
// 规则：视图的 _view_meta.updatedAt >= 家长主文档.updatedAt，就认为不需要重算
function isForPClassFresh(classDoc = {}, parentDoc = {}) {
  if (!classDoc || !parentDoc) {
    return false;
  }
  const viewTime = new Date(
    (classDoc && classDoc[VIEW_META_FIELD] && classDoc[VIEW_META_FIELD].updatedAt)
    || classDoc.updatedAt
    || 0
  ).getTime();
  const parentTime = new Date(parentDoc.updatedAt || 0).getTime();
  return Number.isFinite(viewTime) && Number.isFinite(parentTime) && viewTime >= parentTime;
}

// 新增：把最新视图 upsert 到 forP_class（每个家长一条）
// 重要：任何异常都吞掉，不影响调用方的主流程返回
async function upsertForPClassDoc(openid = "", parentId = "", latestRequest = null) {
  const safeOpenid = String(openid || "").trim();
  const safeParentId = String(parentId || "").trim();
  if (!safeOpenid) {
    return;
  }
  try {
    await ensureForPClassCollection();
    const nextDoc = buildForPClassDoc(safeOpenid, safeParentId, latestRequest);
    const existed = await db.collection(FORP_CLASS_COLLECTION).where({
      openid: safeOpenid,
    }).limit(1).get();

    if (Array.isArray(existed.data) && existed.data.length) {
      const docId = existed.data[0]._id;
      // 更新时保留 createdAt，只覆盖视图字段和时间戳
      await db.collection(FORP_CLASS_COLLECTION).doc(docId).update({
        data: {
          parentId: nextDoc.parentId,
          latestRequest: nextDoc.latestRequest,
          [VIEW_META_FIELD]: nextDoc[VIEW_META_FIELD],
          updatedAt: nextDoc.updatedAt,
        },
      });
      logInfo("upsertForPClassDoc.update", {
        openid: maskOpenid(safeOpenid),
        docId,
        hasLatestRequest: !!latestRequest,
      });
    } else {
      const addRes = await db.collection(FORP_CLASS_COLLECTION).add({
        data: nextDoc,
      });
      logInfo("upsertForPClassDoc.add", {
        openid: maskOpenid(safeOpenid),
        newDocId: addRes && addRes._id || "",
        hasLatestRequest: !!latestRequest,
      });
    }
  } catch (error) {
    // 写入失败不影响主流程，仅打错误日志，登录兜底会自动修复不一致
    logError("upsertForPClassDoc.swallow", error, {
      openid: maskOpenid(safeOpenid),
      collectionName: FORP_CLASS_COLLECTION,
    });
  }
}
// ---------- forP_class 视图集合：辅助函数 end ----------

async function getLatestRequest(openid, parent) {
  const parentBasic = getParentBasic(parent) || {};
  let formDoc = null;
  let courseDoc = null;

  if (parentBasic.latestFormId) {
    formDoc = await getFormById(parent, parentBasic.latestFormId);
  }

  if (!formDoc) {
    formDoc = await getLatestForm(parent);
  }

  if (parentBasic.latestCourseId) {
    courseDoc = await getCourseById(parent, parentBasic.latestCourseId);
  }

  if (!courseDoc && formDoc) {
    courseDoc = await getCourseByFormId(parent, formDoc._id);
  }

  if (!courseDoc) {
    courseDoc = await getLatestCourse(parent);
  }

  return buildLatestRequest(formDoc, courseDoc);
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
  // 新增：同时确保 forP_class 集合存在，避免第一次查缓存时报错
  await ensureForPClassCollection();

  const parent = await getOrCreateParent(openid);

  // 新增：优先从 forP_class 视图缓存取 latestRequest；
  // 缓存新鲜就直接用，省去从内嵌数组 find+拼对象的开销；
  // 缓存不存在/过期/读失败，就回退到原来的实时计算逻辑，并顺手补写缓存做兜底修复
  let latestRequest = null;
  let fromForPClass = false;
  try {
    const classDoc = await findForPClassDoc(openid);
    if (classDoc && isForPClassFresh(classDoc, parent)) {
      latestRequest = (classDoc.latestRequest && typeof classDoc.latestRequest === "object")
        ? classDoc.latestRequest
        : null;
      if (latestRequest) {
        fromForPClass = true;
        logInfo("login.useForPClassCache", {
          openid: maskOpenid(openid),
          cacheDocId: classDoc._id || "",
        });
      }
    }
  } catch (error) {
    // 读 forP_class 异常一律忽略，继续走原逻辑
    logError("login.readForPClass.swallow", error, {
      openid: maskOpenid(openid),
    });
  }

  // 缓存没命中或过期，实时拼
  if (!latestRequest) {
    latestRequest = await getLatestRequest(openid, parent);
    // 新增：顺手 upsert 一份最新视图回 forP_class，作为兜底修复
    // （submitBooking 写 forP_class 失败、或者老数据迁移后没有缓存，都会在这里补齐）
    await upsertForPClassDoc(openid, (parent && parent._id) || "", latestRequest);
  }

  logInfo("login.success", {
    openid: maskOpenid(openid),
    parentId: (parent && parent._id) || "",
    latestFormId: (latestRequest && latestRequest.formId) || "",
    latestCourseId: (latestRequest && latestRequest.courseId) || "",
    // 新增：日志里带上来源，方便排查是用了缓存还是实时计算
    fromForPClass,
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
  const formId = generateInnerRecordId("form");
  const courseId = generateInnerRecordId("course");

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
    createdAt: now,
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
    createdAt: now,
    updatedAt: now,
  };

  const nextHistoryRecords = (parentBasic.historyRecords || []).concat([
    {
      type: "submit_course_form",
      text: "提交新的家长约课表单",
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
  const nextFormList = getParentFormList(parent).concat([formData]);
  const nextCourseList = getParentCourseList(parent).concat([courseData]);

  // 修复：第 1 次写主文档（pending 状态）——嵌套字段同样用 _.set() 强制覆盖
  // 否则旧 P_basic.targetSnapshot === null 时，递归 merge 新对象会报
  // "Cannot create field 'coachName' in element {targetSnapshot: null}"
  await db.collection(FORP_COLLECTION).doc(parent._id).update({
    data: {
      [BASIC_FIELD]: _.set(nextPBasic),
      [FORM_FIELD]: _.set(nextFormList),
      [COURSE_FIELD]: _.set(nextCourseList),
      updatedAt: now,
    },
  });

  let nextParent = {
    ...parent,
    [BASIC_FIELD]: nextPBasic,
    [FORM_FIELD]: nextFormList,
    [COURSE_FIELD]: nextCourseList,
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
  const bridgedFormList = nextFormList.map((item) => item._id === formId ? bridgedFormData : item);
  const bridgedCourseList = nextCourseList.map((item) => item._id === courseId ? bridgedCourseData : item);

  // 修复：三个顶层嵌套字段（对象/数组）用 _.set() 强制整字段覆盖写入，
  // 而不是走默认的递归 merge。
  // 原因：旧文档的 P_basic.targetSnapshot 可能是 null（非对象），如果递归 merge 新的 targetSnapshot 对象，
  // TCB/MongoDB 会直接抛 Cannot create field 'xxx' in element {targetSnapshot: null}。
  // _.set() 保证"把整个字段整体替换掉"，不会去尝试在 null 父节点下创建子字段。
  await db.collection(FORP_COLLECTION).doc(parent._id).update({
    data: {
      [BASIC_FIELD]: _.set(bridgedPBasic),
      [FORM_FIELD]: _.set(bridgedFormList),
      [COURSE_FIELD]: _.set(bridgedCourseList),
      updatedAt: bridgeUpdatedAt,
    },
  });

  nextParent = {
    ...nextParent,
    [BASIC_FIELD]: bridgedPBasic,
    [FORM_FIELD]: bridgedFormList,
    [COURSE_FIELD]: bridgedCourseList,
    updatedAt: bridgeUpdatedAt,
  };

  // 新增：给前端返回的 request 对象提前算好，下面写 forP_class 时直接复用，避免重复 build
  const latestRequestForReturn = buildLatestRequest(bridgedFormData, bridgedCourseData);

  // 新增：dev_ForP 主文档写入成功后，把最新视图 upsert 到 forP_class
  // 注意：upsertForPClassDoc 内部已经吞掉所有异常，这里即使失败也不影响主流程返回
  await upsertForPClassDoc(openid, parent._id || "", latestRequestForReturn);

  // 新增：将本次真正使用的识别码追加到该家长文档的内嵌 P_recognized_invites 数组，
  // 对应"将识别码缓存归到对应家长的文档下"的诉求；
  // 只存该家长自己提交过的识别码（纯浏览识别的不写入，避免历史噪音）。
  // 函数内部已吞所有异常，失败不影响主流程。
  await appendRecognizedHistoryToParent(parent._id || "", inviteCode, targetSnapshot);

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
  // 新增：同时确保 forP_class 集合存在，避免第一次查缓存时报错
  await ensureForPClassCollection();

  const parent = await getOrCreateParent(openid);

  // 新增：优先从 forP_class 视图缓存取 latestRequest（和 login 同样的策略）
  let latestRequest = null;
  let fromForPClass = false;
  try {
    const classDoc = await findForPClassDoc(openid);
    if (classDoc && isForPClassFresh(classDoc, parent)) {
      latestRequest = (classDoc.latestRequest && typeof classDoc.latestRequest === "object")
        ? classDoc.latestRequest
        : null;
      if (latestRequest) {
        fromForPClass = true;
        logInfo("getMyCourse.useForPClassCache", {
          openid: maskOpenid(openid),
          cacheDocId: classDoc._id || "",
        });
      }
    }
  } catch (error) {
    logError("getMyCourse.readForPClass.swallow", error, {
      openid: maskOpenid(openid),
    });
  }

  // 缓存没命中或过期，实时拼 + 补写缓存兜底
  if (!latestRequest) {
    latestRequest = await getLatestRequest(openid, parent);
    await upsertForPClassDoc(openid, (parent && parent._id) || "", latestRequest);
  }

  logInfo("getMyCourse.success", {
    openid: maskOpenid(openid),
    parentId: (parent && parent._id) || "",
    latestFormId: (latestRequest && latestRequest.formId) || "",
    latestCourseId: (latestRequest && latestRequest.courseId) || "",
    // 新增：日志里带上来源，方便排查是用了缓存还是实时计算
    fromForPClass,
  });

  return {
    success: true,
    latestRequest,
  };
}

exports.main = async (event) => {
  // 新增（2026-09-06）：请求入口先按 envVersion 切换集合前缀（develop→dev_*，其余→real_*）。
  // 必须放在所有业务逻辑之前，确保本次请求读写的是对应环境的集合。
  applyEnvVersion(event.envVersion || "");
  const action = event.action || "login";
  logInfo("main.route", {
    action,
    // 新增（2026-09-06）：打印当前请求实际命中的集合名，便于排查 dev/real 是否串库。
    envVersion: event.envVersion || "",
    forpCollection: FORP_COLLECTION,
    inviteTargetsCollection: INVITE_TARGETS_COLLECTION,
    forpClassCollection: FORP_CLASS_COLLECTION,
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
