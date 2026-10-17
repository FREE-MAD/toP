// B 侧中转云函数最小入口。
// 当前这里保留作备用中转；最新链路已经改成由 DLforP__do 直接转发到 A 云端 HTTP。
//
// 注意：
// 1) 拆双函数（2026-10-10）：本目录 D_twowaybinding_1_DLforP 是「开发版」部署单元，环境固定 develop
//    （读写 dev_ForP_forms / dev_ForP_courses 等 dev_* 子集合），登记在下方 deploy-meta 块里、函数不读请求判断环境；
//    正式版 T_twowaybinding_1_DLforP 由 cloudfunctions/sync-dev-to-true.js 从本目录镜像生成
//    （人工执行，密码 NEWDL123），环境固定 release（读写 real_*）——T_ 目录禁止手改。
//    调用方（A 侧 _shared/http.js 的 bTwowaybindingD/T）按环境选地址。
// 2) 当前前端还没有切到这个函数名，所以不会影响现有链路；
// 3) A 侧当前要求走 GET，所以这里先统一把 event 参数拼到 query 上。
// 4) 当前补上 HTTP 云函数启动能力，避免云端部署时缺少 scf_bootstrap / 9000 端口入口。
const http = require("http");
const { URL } = require("url");
const https = require("https");
const cloud = require("wx-server-sdk");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const db = cloud.database({
  env: cloud.DYNAMIC_CURRENT_ENV,
});
// 阶段0-3：补 _ = db.command，回抄 update 用 _.set() 强制覆盖（与 DLforP__do 一致），
// 防止旧文档字段为 null 时递归 merge 报错导致 A→B 回抄静默失败。
const _ = db.command;

// ===== deploy-meta:start =====
// 关键字段登记（2026-10-10）：本部署单元「是哪一侧 / 环境固定为什么 / 源目录是谁」全部登记在这一块。
// 环境已由「部署哪个函数」物理固定（D_ = develop，T_ = real），业务代码不再读请求判断环境，一律以本块为准。
// 不可覆写：sync-dev-to-true.js 每次同步都会强制覆写 T_ 侧本块 —— D_ 源里的值到不了 T_，手改 T_ 也会在下一次同步被覆盖。
const DEPLOY_META = Object.freeze({
  side: 'D',                    // 'D' = 开发版部署单元；'T' = 正式版部署单元
  envVersion: 'develop',        // 固定环境：'develop'（dev_*）| 'release'（代表 real，real_*）
  isDev: true,                  // = envVersion === 'develop' 的预计算值，业务代码直接用，不再做 === 'develop' 判断
  sourceDir: 'D_twowaybinding_1_DLforP', // 源目录（T_ 侧登记它镜像的 D_ 目录名；仅排查用）
  managedBy: 'sync-dev-to-true.js'
});
// ===== deploy-meta:end =====
// 上移到此处（require 之后、所有 console.log 之前）：让冷启动日志也能引用 DEPLOY_META.side 区分 D_/T_ 部署单元。

// 启动阶段先打一条模块装载日志，便于确认实例是否真的把业务代码跑起来了。
console.log("[" + DEPLOY_META.side + "_twowaybinding_1_DLforP][INFO] module.loaded", {
  pid: process.pid,
  portFromEnv: process.env.PORT || "",
  nodeEnv: process.env.NODE_ENV || "",
});

// A 的 HTTP 云函数路由地址。
// 当前按最新联调口径，B 只能直连 A 云端的 twowaybinding_1_DLforC，不允许再走其他 A 云函数。
// 拆双函数（2026-10-10）：A 侧已拆成 D_/T_ 两个部署单元，地址按本次请求环境选择：
//   develop              → /devenv（A 侧 D_twowaybinding_1_DLforC，读写 NDLdev_ 集合）
//   其余（trial/release/空）→ /trueenv（A 侧 T_twowaybinding_1_DLforC，读写 NDLreal_ 集合）
// 路由为 A 侧 HTTP 访问服务实际配置（2026-10-10 确认）：/devenv、/trueenv。
// A_DLFORC_URL_LEGACY 是旧路由地址：迁移期「新地址路由不到」时由 requestAHttpApi 自动回退，
// 等双份部署验证通过、A 侧旧路由下线后，删掉该常量与回退分支即可。
const A_TENCLOUD_BASE_URL = "https://cloud1-6gh7jgl8c5b16a83-1398046944.ap-shanghai.app.tcloudbase.com";
const A_DLFORC_URL_DEV = `${A_TENCLOUD_BASE_URL}/devenv`;
const A_DLFORC_URL_TRUE = `${A_TENCLOUD_BASE_URL}/trueenv`;
const A_DLFORC_URL_LEGACY = `${A_TENCLOUD_BASE_URL}/twowaybinding_1_DLforC`;

// 本次请求实际生效的环境版本（由 applyEnvVersion 在请求入口赋值），用于选 A 侧 D_/T_ 地址。
let CURRENT_ENV_VERSION = "develop";

// 按本次请求环境选 A 侧地址：仅 develop 走 D_，判定与 applyEnvVersion 的 dev/real 口径完全一致。
function resolveADLforCUrl(envVersion = "") {
  return envVersion === "develop" ? A_DLFORC_URL_DEV : A_DLFORC_URL_TRUE;
}
const ACTION_SYNC_PARENT_BOOKING_TO_A = "syncParentBookingToA";
const ACTION_SYNC_COACH_RESULT_TO_B = "syncCoachResultToB";
const SOURCE_FROM_B_PARENT = "在小程序B由家长提交经过api中转进入小程序A移交教练操作";
const BRIDGE_STATUS_SYNCED = "synced";
// 调整（2026-09-06）：改为 let，由 applyEnvVersion 动态切换 dev_ForP / real_ForP。
let FORP_COLLECTION = "dev_ForP";
const IDENTITY_FIELD = "P_identity";
const BASIC_FIELD = "P_basic";
const FORM_FIELD = "P_CourseFormCollection";
const COURSE_FIELD = "P_CourseWithCoach";
// 阶段1-3：ForP 拆子集合——回抄改 upsert ForP_forms/ForP_courses（不再写主文档内嵌数组）。
// 原 forP_class 视图缓存已整体删除（见下方阶段1-3/3-3 注释），不再有"标记过期"机制，前端实时查子集合。
// 改为 let，由 applyEnvVersion 动态切换 dev_/real_ 前缀（develop→dev_*，release→real_*）。
let FORP_FORMS_COLLECTION = "dev_ForP_forms";
let FORP_COURSES_COLLECTION = "dev_ForP_courses";

// 新增（2026-09-06）：根据 envVersion 重新计算集合名，在 handleMain 入口调用。
// 规则与 DLforP__do / DLforP_entry_qrcode 一致：develop→dev_*，其余→real_*。
function applyEnvVersion() {
  // 环境来自部署侧登记（deploy-meta）：D_ 恒 develop、T_ 恒 release，不再从请求读取。
  // CURRENT_ENV_VERSION 同时决定调 A 侧哪个地址：D_ → A 侧 D_twowaybinding_1_DLforC，T_ → A 侧 T_。
  CURRENT_ENV_VERSION = DEPLOY_META.isDev ? "develop" : "release";
  const prefix = DEPLOY_META.isDev ? "dev_" : "real_";
  FORP_COLLECTION = `${prefix}ForP`;
  FORP_FORMS_COLLECTION = `${prefix}ForP_forms`;
  FORP_COURSES_COLLECTION = `${prefix}ForP_courses`;
}

function buildQueryString(event = {}) {
  const query = new URLSearchParams();

  Object.keys(event || {}).forEach((key) => {
    const value = event[key];

    if (typeof value === "undefined") {
      return;
    }

    if (value === null) {
      query.append(key, "");
      return;
    }

    if (typeof value === "object") {
      // 嵌套对象先按 JSON 字符串透传，先保证链路可用。
      query.append(key, JSON.stringify(value));
      return;
    }

    query.append(key, String(value));
  });

  return query.toString();
}

// 识别码规范化规则必须与 A 侧（twowaybinding_1_DLforC / NEWDL_execution_order）完全一致：
// 1) 统一剥离所有非字母数字字符（例如空格、-、_、# 等），避免家长录入时因格式差异导致两端匹配失败
// 2) 全部转大写，保证大小写不敏感
// 3) 截断到 16 位，兼容 A 侧 organization collection 中 inviteCode 字段的长度上限
// 说明：twowaybinding_1_DLforP 是备用的 B→A 中转入口，也必须按同一规则规范化，保证备用链路和主链路行为一致
function normalizeInviteCode(inviteCode) {
  return String(inviteCode || "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 16);
}

// B -> A 的最小协议在这里显式收口，避免页面层和云函数层直接裸传杂字段。
function buildPayloadForA(event = {}) {
  const safeEvent = event || {};

  if (safeEvent.action === ACTION_SYNC_PARENT_BOOKING_TO_A) {
    return {
      action: ACTION_SYNC_PARENT_BOOKING_TO_A,
      source: safeEvent.source || "",
      // 中转时统一规范化 inviteCode，保证不管上游调用方有没有先规范化，发给 A 侧的字段都符合统一口径
      inviteCode: normalizeInviteCode(safeEvent.inviteCode),
      parentName: safeEvent.parentName || "",
      phone: safeEvent.phone || "",
      contact: safeEvent.contact || "",
      frequency: safeEvent.frequency || "",
      location: safeEvent.location || "",
      latitude: typeof safeEvent.latitude === "undefined" ? "" : safeEvent.latitude,
      longitude: typeof safeEvent.longitude === "undefined" ? "" : safeEvent.longitude,
      childName: safeEvent.childName || "",
      childAge: safeEvent.childAge || "",
      childProfiles: Array.isArray(safeEvent.childProfiles) ? safeEvent.childProfiles : [],
      note: safeEvent.note || "",
      targetSnapshot: safeEvent.targetSnapshot || null,
      from_b_form_id: safeEvent.from_b_form_id || "",
      from_b_course_id: safeEvent.from_b_course_id || "",
      from_b_openid: safeEvent.from_b_openid || "",
    };
  }

  return safeEvent;
}

function extractAOrderId(parsedBody = {}) {
  const safeBody = parsedBody || {};
  const nestedData = safeBody.data || {};

  return (
    safeBody.orderId ||
    safeBody._id ||
    safeBody.a_order_id ||
    nestedData.orderId ||
    nestedData._id ||
    nestedData.a_order_id ||
    ""
  );
}

function getParentFormList(parentDoc = {}) {
  return Array.isArray(parentDoc && parentDoc[FORM_FIELD]) ? parentDoc[FORM_FIELD] : [];
}

function getParentCourseList(parentDoc = {}) {
  return Array.isArray(parentDoc && parentDoc[COURSE_FIELD]) ? parentDoc[COURSE_FIELD] : [];
}

function buildCourseStatusFromSnapshot(resultSnapshot = {}) {
  // 阶段0-4：改为 7 态透传，与 A 端 courseState 的 fulfill_state 对齐，不再压缩成 4 档。
  // 原压缩逻辑把 editing/awaiting 全部回落 pending，导致家长永远看到"待安排"，
  // 即使教练已在 A 端确认课程（editing/awaiting）。现原样落 status，由 buildStatusText 映射文案。
  const VALID_STATES = [
    "editing",
    "awaiting",
    "in_progress",
    "completed",
    "cancelled",
    "closed",
    "pending",
  ];
  const fulfillState = String(resultSnapshot.fulfill_state || "").trim();
  if (VALID_STATES.includes(fulfillState)) {
    return fulfillState;
  }
  return "pending";
}

async function findParentByOpenid(openid = "") {
  const safeOpenid = String(openid || "").trim();
  if (!safeOpenid) {
    return null;
  }

  const identityRes = await db.collection(FORP_COLLECTION).where({
    [`${IDENTITY_FIELD}.openid`]: safeOpenid,
  }).limit(1).get();
  if (Array.isArray(identityRes.data) && identityRes.data.length) {
    return identityRes.data[0];
  }

  const legacyRes = await db.collection(FORP_COLLECTION).where({
    openid: safeOpenid,
  }).limit(1).get();
  return Array.isArray(legacyRes.data) && legacyRes.data.length ? legacyRes.data[0] : null;
}

// 阶段1-3/3-3：forP_class 视图缓存已删除（ensureForPClassCollection / invalidateForPClassCache）。
// 回抄直接 upsert ForP_courses/ForP_forms 子集合，前端实时查，不再需要缓存失效机制。


// A -> B 回抄：不覆盖家长原始表单，只补状态、摘要、A 侧订单 id，并把 A 侧整包快照原样存入
// （a_result_snapshot：2026-10-10 起 A 侧全量推，含整张课表；展示 / 过滤由 B 端页面自行筛选）。
async function syncCoachResultToB(event = {}) {
  const fromBOpenid = String(event.from_b_openid || "").trim();
  const fromBFormId = String(event.from_b_form_id || "").trim();
  const fromBCourseId = String(event.from_b_course_id || "").trim();
  const aOrderId = String(event.a_order_id || "").trim();
  const now = new Date();
  const resultSnapshot = typeof event.a_result_snapshot === "object" && event.a_result_snapshot
    ? event.a_result_snapshot
    : tryParseJsonText(event.a_result_snapshot || "");
  const courseStatus = buildCourseStatusFromSnapshot(resultSnapshot);

  if (!fromBOpenid) {
    return {
      success: false,
      message: "缺少 from_b_openid",
    };
  }

  if (!fromBFormId && !fromBCourseId) {
    return {
      success: false,
      message: "缺少 B 侧表单或课程 id",
    };
  }

  const parentDoc = await findParentByOpenid(fromBOpenid);
  if (!parentDoc || !parentDoc._id) {
    return {
      success: false,
      message: "未找到 B 侧家长主文档",
    };
  }

  // 阶段1-3：回抄改为 upsert ForP_courses / ForP_forms 子集合文档（不再 update 主文档内嵌数组）。
  // 定位课程文档：优先 fromBCourseId（子集合 doc _id），否则按 formId 查。
  let courseDocId = fromBCourseId;
  if (!courseDocId && fromBFormId) {
    try {
      const found = await db.collection(FORP_COURSES_COLLECTION).where({ formId: fromBFormId }).limit(1).get();
      courseDocId = (found && found.data && found.data[0] && found.data[0]._id) || "";
    } catch (e) {
      courseDocId = "";
    }
  }

  const bridgeFields = {
    source: SOURCE_FROM_B_PARENT,
    bridge_status: BRIDGE_STATUS_SYNCED,
    a_order_id: aOrderId,
    parent_course_code: (resultSnapshot && resultSnapshot.parent_course_code) || "",
    last_sync_at: now,
    bridge_error_message: "",
    a_result_snapshot: resultSnapshot,
    updatedAt: now,
  };

  // 更新课程子集合文档（带 7 档 status）
  if (courseDocId) {
    try {
      await db.collection(FORP_COURSES_COLLECTION).doc(courseDocId).update({
        data: { ...bridgeFields, status: courseStatus },
      });
    } catch (e) {
      console.warn("[twowaybinding_1_DLforP] update ForP_courses failed:", e && (e.message || e.errMsg));
    }
  }

  // 更新表单子集合文档（按 fromBFormId = doc _id）
  if (fromBFormId) {
    try {
      await db.collection(FORP_FORMS_COLLECTION).doc(fromBFormId).update({
        data: bridgeFields,
      });
    } catch (e) {
      console.warn("[twowaybinding_1_DLforP] update ForP_forms failed:", e && (e.message || e.errMsg));
    }
  }

  // 主文档 P_basic.updatedAt 刷新（freshness 信号；forP_class 已删，无需 invalidate）
  try {
    const currentBasic = parentDoc[BASIC_FIELD] || {};
    await db.collection(FORP_COLLECTION).doc(parentDoc._id).update({
      data: {
        [BASIC_FIELD]: _.set({ ...currentBasic, updatedAt: now }),
        updatedAt: now,
      },
    });
  } catch (e) {
    /* 忽略，子集合已更新成功 */
  }

  return {
    success: true,
    message: "A 侧结果已回抄到 B",
    a_order_id: aOrderId,
    from_b_form_id: fromBFormId,
    from_b_course_id: fromBCourseId,
    status: courseStatus,
  };
}

// 调整（2026-10-10 拆双函数）：拆成「按给定地址发一次」+「选地址 + 兜底回退」两层。
function requestAHttpApiAt(baseUrl, event = {}) {
  const relayPayload = buildPayloadForA(event);
  const queryString = buildQueryString(relayPayload);
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
            // A 侧如果暂时没回 JSON，这里先保留原文，方便联调。
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

async function requestAHttpApi(event = {}) {
  const primaryUrl = resolveADLforCUrl(CURRENT_ENV_VERSION);
  let result;
  try {
    result = await requestAHttpApiAt(primaryUrl, event);
  } catch (primaryError) {
    // 连不上 / DNS 层失败也按「路由不到」处理：给旧地址最后一次机会，旧地址也失败则抛出。
    console.log("[" + DEPLOY_META.side + "_twowaybinding_1_DLforP][INFO] requestAHttpApi.fallback", {
      from: primaryUrl,
      to: A_DLFORC_URL_LEGACY,
      statusCode: 0,
      reason: (primaryError && (primaryError.message || primaryError.errMsg)) || String(primaryError),
    });
    return requestAHttpApiAt(A_DLFORC_URL_LEGACY, event);
  }
  if (!isARouteMiss(result)) {
    return result;
  }

  // 兜底（拆双迁移期）：A 侧 D_/T_ 还没部署时，回退旧函数名地址，保证桥接不中断。
  console.log("[" + DEPLOY_META.side + "_twowaybinding_1_DLforP][INFO] requestAHttpApi.fallback", {
    from: primaryUrl,
    to: A_DLFORC_URL_LEGACY,
    statusCode: (result && result.statusCode) || 0,
  });
  return requestAHttpApiAt(A_DLFORC_URL_LEGACY, event);
}

function tryParseJsonText(text = "") {
  const safeText = String(text || "").trim();
  if (!safeText) {
    return {};
  }

  try {
    return JSON.parse(safeText);
  } catch (error) {
    return {};
  }
}

function collectRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    req.on("data", (chunk) => {
      chunks.push(chunk);
    });

    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });

    req.on("error", reject);
  });
}

function buildHttpEvent(req, rawBody = "") {
  const requestUrl = new URL(req.url || "/", "http://127.0.0.1");
  const queryObject = Object.fromEntries(requestUrl.searchParams.entries());
  const bodyObject = tryParseJsonText(rawBody);

  return {
    ...queryObject,
    ...(bodyObject && typeof bodyObject === "object" && !Array.isArray(bodyObject) ? bodyObject : {}),
    rawBody,
    httpMethod: String(req.method || "GET").toUpperCase(),
    requestPath: requestUrl.pathname,
    headers: req.headers || {},
  };
}

function writeJson(res, statusCode = 200, data = {}) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(data));
}

async function handleMain(event = {}, context = {}) {
  // 新增（2026-09-06）：请求入口先按 envVersion 切换集合前缀（develop→dev_*，其余→real_*）。
  // 调整（2026-10-10）：环境不再取 event.envVersion，改由部署侧登记固定（deploy-meta）。
  applyEnvVersion();
  console.log("[" + DEPLOY_META.side + "_twowaybinding_1_DLforP][INFO] main.start", {
    action: event.action || "",
    hasContext: !!context,
    // 新增（2026-09-06）：打印当前请求实际命中的集合名，便于排查 dev/real 是否串库。
    // 调整（2026-10-10）：envVersion 登记部署侧固定值，不再打印请求透传值。
    envVersion: DEPLOY_META.envVersion,
    forpCollection: FORP_COLLECTION,
    forpCoursesCollection: FORP_COURSES_COLLECTION,
    // 调整（2026-10-10）：A→B 改全量快照推送后，event 整体打印会把整张课表刷进日志；
    // 只留排查必要的信封字段，快照体积单独打字节数。
    fromBFormId: event.from_b_form_id || "",
    fromBCourseId: event.from_b_course_id || "",
    aOrderId: event.a_order_id || "",
    syncReason: event.sync_reason || "",
    snapshotBytes: Buffer.byteLength(JSON.stringify(event.a_result_snapshot || {}), "utf8"),
  });

  try {
    if (event.action === ACTION_SYNC_COACH_RESULT_TO_B) {
      const result = await syncCoachResultToB(event);
      console.log("[" + DEPLOY_META.side + "_twowaybinding_1_DLforP][INFO] main.syncCoachResultToB", {
        action: event.action || "",
        aOrderId: result.a_order_id || "",
        fromBFormId: event.from_b_form_id || "",
        fromBCourseId: event.from_b_course_id || "",
      });
      return result;
    }

    const relayPayload = buildPayloadForA(event);
    const result = await requestAHttpApi(relayPayload);
    console.log("[" + DEPLOY_META.side + "_twowaybinding_1_DLforP][INFO] main.success", {
      action: event.action || "",
      statusCode: result.statusCode,
      requestUrl: result.requestUrl,
      aOrderId: result.a_order_id || "",
    });
    return result;
  } catch (error) {
    console.error("[twowaybinding_1_DLforP][ERROR] main.fail", {
      action: event.action || "",
      message: error && (error.message || error.errMsg) || String(error),
      stack: error && error.stack || "",
    });
    return {
      success: false,
      message: "B 侧转发 A 云端 twowaybinding_1_DLforC 失败",
      errorMessage: error && (error.message || error.errMsg) || String(error),
    };
  }
}

// 兼容保留普通云函数调用方式，避免已有本地联调入口直接失效。
exports.main = handleMain;

// HTTP 云函数模式下，直接在 9000 端口起一个最小服务，把请求转给现有中转逻辑。
if (require.main === module) {
  const port = Number(process.env.PORT || 9000) || 9000;

  const server = http.createServer(async (req, res) => {
    try {
      const method = String(req.method || "GET").toUpperCase();
      const requestUrl = new URL(req.url || "/", "http://127.0.0.1");

      // HTTP 请求一进来就先记日志，避免探活请求被误以为“没有触发函数”。
      console.log("[" + DEPLOY_META.side + "_twowaybinding_1_DLforP][INFO] http.request", {
        method,
        path: requestUrl.pathname,
        search: requestUrl.search || "",
      });

      if (method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "content-type, authorization",
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        });
        res.end();
        return;
      }

      // GET 根路径且没有业务参数时，才返回启动探活信息；
      // 如果 GET 已经带了 query，就继续走现有中转逻辑，避免把业务请求误判成健康检查。
      if (
        requestUrl.pathname === "/health" ||
        (requestUrl.pathname === "/" && method === "GET" && !requestUrl.search)
      ) {
        // 探活分支单独留痕，方便区分“只是探活”还是“真正业务调用”。
        console.log("[" + DEPLOY_META.side + "_twowaybinding_1_DLforP][INFO] http.health", {
          method,
          path: requestUrl.pathname,
        });
        writeJson(res, 200, {
          success: true,
          code: 0,
          message: "twowaybinding_1_DLforP HTTP 云函数已启动",
        });
        return;
      }

      const rawBody = method === "POST" ? await collectRequestBody(req) : "";
      const event = buildHttpEvent(req, rawBody);
      const result = await handleMain(event, {});
      writeJson(res, 200, result);
    } catch (error) {
      console.error("[twowaybinding_1_DLforP][ERROR] http.fail", {
        message: error && (error.message || error.errMsg) || String(error),
        stack: error && error.stack || "",
      });
      writeJson(res, 500, {
        success: false,
        code: 500,
        message: "twowaybinding_1_DLforP HTTP 服务执行失败",
        errorMessage: error && (error.message || error.errMsg) || String(error),
      });
    }
  });

  server.listen(port, "0.0.0.0", () => {
    console.log("[" + DEPLOY_META.side + "_twowaybinding_1_DLforP][INFO] http.listen", {
      port,
    });
  });
}
