// 这个文件当前只作为兼容排查入口保留。
// 当前 ForP 已统一按 dev_ForP / real_ForP + 4 个字段收口。
// 当前前端统一走 DLforP__do/login_index.js 作为云函数入口，
// 这里保留仅用于参考和误调用排查，不再作为实际数据读写入口。
const https = require("https");
const cloud = require("wx-server-sdk");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

// ForP 只保留 dev_ForP / real_ForP 两套口径。
// P_basic / P_CourseFormCollection / P_CourseWithCoach / TOP_invite_targets
// 就是 dev_ForP / real_ForP 这两个合集里的字段，不再各自作为独立合集创建。
const FORP_DB_ALIAS = "dev_ForP";
const FORP_ENV_MAP = {
  dev_ForP: cloud.DYNAMIC_CURRENT_ENV,
  real_ForP: "",
};

function createForPDb(dbAlias = FORP_DB_ALIAS) {
  const env = FORP_ENV_MAP[dbAlias] || cloud.DYNAMIC_CURRENT_ENV;
  return cloud.database({ env });
}

const db = createForPDb();

const FORP_COLLECTION = FORP_DB_ALIAS;
const BASIC_FIELD = "P_basic";
const FORM_FIELD = "P_CourseFormCollection";
const COURSE_FIELD = "P_CourseWithCoach";
const INVITE_FIELD = "TOP_invite_targets";
const RECORD_FIELD_KEY = "forPField";
// 拆双函数（2026-10-10）：A 侧 twowaybinding_1_DLforC 已拆成 D_/T_ 两个部署单元。
// 本文件是 dev 口径的兼容排查入口（FORP_DB_ALIAS 固定 dev_ForP），所以固定走 A 侧 D_ 路由 /devenv
// （A 侧 HTTP 访问服务实际配置，2026-10-10 确认）；旧路由地址保留兜底（新地址路由不到时自动回退），
// 等 A 侧旧路由下线后再删。
const A_HTTP_BASE_URL = "https://cloud1-6gh7jgl8c5b16a83-1398046944.ap-shanghai.app.tcloudbase.com/devenv";
const A_HTTP_LEGACY_URL = "https://cloud1-6gh7jgl8c5b16a83-1398046944.ap-shanghai.app.tcloudbase.com/twowaybinding_1_DLforC";
const ACTION_RESOLVE_INVITE = "resolveInvite";

// 运行日志：即使这个文件当前不是主入口，也保留同一套日志格式，方便排查是否被误调用。
function maskOpenid(openid) {
  const text = String(openid || "");
  if (text.length <= 8) {
    return text;
  }
  return `${text.slice(0, 4)}***${text.slice(-4)}`;
}

function logInfo(label, extra = {}) {
  console.log(`[DLforP__do][LinkToC][${FORP_DB_ALIAS}][INFO] ${label}`, extra);
}

function logError(label, error, extra = {}) {
  const safeError = error || {};
  console.error(`[DLforP__do][LinkToC][${FORP_DB_ALIAS}][ERROR] ${label}`, {
    ...extra,
    message: safeError.message || safeError.errMsg || String(safeError),
    stack: safeError.stack || "",
  });
}

function getOpenid() {
  const wxContext = cloud.getWXContext();
  return wxContext.OPENID || "";
}

function normalizeInviteCode(inviteCode) {
  // 兼容链路与主入口统一同一套识别码规范化规则，避免备用入口与正式入口出现不同结果。
  return String(inviteCode || "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 16);
}

async function ensureCollection(collectionName) {
  try {
    await db.createCollection(collectionName);
    logInfo("ensureCollection.create", {
      collectionName,
    });
  } catch (error) {
    // 集合已存在时不用额外处理。
    logInfo("ensureCollection.skip", {
      collectionName,
      message: error && (error.message || error.errMsg) || "collection exists",
    });
  }
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

// 调整（2026-10-10 拆双函数）：拆成「按给定地址发一次」+「主地址失败回退旧地址」两层。
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
            data: parsedBody,
          });
        });
      })
      .on("error", reject);
  });
}

function requestAHttpApi(payload = {}) {
  return requestAHttpApiAt(A_HTTP_BASE_URL, payload).catch((error) => {
    // 新地址连不上 / 路由不到时，给旧函数名地址一次兜底机会（兼容排查入口，失败即抛出）。
    logInfo("requestAHttpApi.fallback", {
      from: A_HTTP_BASE_URL,
      to: A_HTTP_LEGACY_URL,
      reason: (error && (error.message || error.errMsg)) || String(error),
    });
    return requestAHttpApiAt(A_HTTP_LEGACY_URL, payload);
  });
}

function enrichRequestStatus(request) {
  if (!request) {
    return null;
  }

  const statusTextMap = {
    pending: "待安排",
    scheduled: "已安排",
    finished: "已完成",
    cancelled: "已取消",
  };

  return {
    ...request,
    statusText: statusTextMap[request.status] || "待安排",
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

  const res = await db.collection(FORP_COLLECTION).where({
    [RECORD_FIELD_KEY]: INVITE_FIELD,
    inviteCode,
  }).limit(1).get();
  let target = res.data[0];

  // 兼容入口也补上 A 侧兜底，避免误调用这个文件时又回到旧的“只查 B 本地缓存”逻辑。
  if (!target) {
    try {
      const remoteResult = await requestAHttpApi({
        action: ACTION_RESOLVE_INVITE,
        inviteCode,
      });
      if (remoteResult && remoteResult.success !== false) {
        target = remoteResult.data && remoteResult.data.target || null;
      }
    } catch (error) {
      logError("resolveInvite.remoteFail", error, {
        inviteCode,
      });
    }
  }

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

  // 当前只保留 dev_ForP / real_ForP 两个实际合集，课程记录用字段分类读取。
  await ensureCollection(FORP_COLLECTION);

  const res = await db
    .collection(FORP_COLLECTION)
    .where({
      [RECORD_FIELD_KEY]: COURSE_FIELD,
      openid,
    })
    .orderBy("updatedAt", "desc")
    .limit(1)
    .get();

  logInfo("getMyCourse.success", {
    openid: maskOpenid(openid),
    hit: !!(res.data && res.data[0]),
  });
  return {
    success: true,
    latestRequest: enrichRequestStatus(res.data[0] || null),
  };
}

exports.main = async (event) => {
  const action = event.action || "resolveInvite";
  logInfo("main.route", {
    action,
  });

  try {
    switch (action) {
      case "resolveInvite":
        return await resolveInvite(event);
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
    logError("main.crash", error, {
      action,
    });
    return {
      success: false,
      message: "云函数执行失败",
    };
  }
};
