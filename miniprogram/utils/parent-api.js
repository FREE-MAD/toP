// 家长端统一云函数调用：
// 当前实际使用的云函数目录是 DLforP__do，这里必须和已部署函数名保持一致。
// 拆双函数（2026-10-10）：这里存的是「基名」，实际调用名由下方 getFnName 补 D_/T_ 前缀。
const CLOUD_FUNCTION_NAME = "DLforP__do";
// B 侧入口二维码云函数（callFunction / HTTP 双入口），
// 名称必须与 cloudfunctions/DLforP_entry_qrcode 部署目录保持一致。
// 拆双函数（2026-10-10）：同上，基名 + getFnName 前缀。
const ENTRY_QR_FUNCTION_NAME = "DLforP_entry_qrcode";

// 新增（2026-10-10 拆双函数）：云函数名按环境加前缀 —— develop 走 D_，trial/release 走 T_，
// 口径与 A 端 miniprogram/app.js 的 getFnName 完全一致。
// 拆双后环境不再靠透传 envVersion 在函数内分流，而靠「调哪个函数」决定（函数入口已把环境钉死）。
function getFnName(baseName) {
  return (getMiniEnvVersion() === "develop" ? "D_" : "T_") + baseName;
}

// 新增（2026-09-06）：获取当前小程序运行环境版本（develop/trial/release），
// 自动透传给 B 侧云函数，B 侧按它切换 dev_/real_ 集合前缀，保证开发态与真实态数据隔离。
// 与 A 侧 app.js 的 miniEnvVersion 口径一致：取不到时默认 develop。
function getMiniEnvVersion() {
  try {
    const accountInfo = wx.getAccountInfoSync();
    return (accountInfo && accountInfo.miniProgram && accountInfo.miniProgram.envVersion) || "develop";
  } catch (e) {
    return "develop";
  }
}

function callCloud(action, data = {}) {
  return new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name: getFnName(CLOUD_FUNCTION_NAME),
      data: {
        action,
        // envVersion 不再透传：D_/T_ 函数已改读 DEPLOY_META（环境由「调哪个函数」钉死），见文件头拆双函数说明。
        ...data,
      },
      success: (res) => {
        const result = res.result || {};
        if (result.success === false) {
          reject(result);
          return;
        }
        resolve(result);
      },
      fail: reject,
    });
  });
}

// 入口二维码云函数调用：
// 改用 wx.cloud.callHTTPFunction（修复 -501001 FunctionType parameter is invalid）：
// DLforP_entry_qrcode 部署为 HTTP 云函数（scf_bootstrap + 监听 9000 端口），
// HTTP 云函数只能通过 callHTTPFunction / HTTP 网关触发，用 callFunction 调它会直接报
// -501001 FunctionType parameter is invalid，因此这里必须走 HTTP 专用通道。
// 注意：callHTTPFunction 要求基础库 ≥ 3.15.1，低版本微信会走到下面的友好提示分支。
// 云函数冷启动时第一次调用可能命中旧实例 / 未就绪而失败，
// 失败后 500ms 自动重试一次（重试本身不再重试，避免死循环），
// 与各页面历史沿用的「冷启动预热重试」约定保持一致。
function callEntryCloud(action, data = {}, allowRetry = true) {
  return new Promise((resolve, reject) => {
    // 基础库 < 3.15.1 时没有 callHTTPFunction，直接返回可读错误，避免 undefined 调用报错。
    if (!wx.cloud || typeof wx.cloud.callHTTPFunction !== "function") {
      reject({
        success: false,
        code: -1,
        message: "当前微信版本过低，请升级微信后重试",
      });
      return;
    }
    // 统一处理失败：网络失败 / HTTP 状态码异常都走同一套 500ms 冷启动重试。
    function handleFail(err) {
      if (!allowRetry) {
        reject(err);
        return;
      }
      // 冷启动重试：500ms 后用同样参数再调一次。
      setTimeout(() => {
        callEntryCloud(action, data, false).then(resolve, reject);
      }, 500);
    }
    wx.cloud.callHTTPFunction({
      name: getFnName(ENTRY_QR_FUNCTION_NAME),
      // HTTP 语义调用：POST / + JSON body；云函数侧 buildHttpEvent 会把 query + JSON body 合并成 event。
      path: "/",
      method: "post",
      data: {
        action,
        // 新增（2026-09-06）：自动透传 envVersion，B 侧 DLforP_entry_qrcode 按它切换 dev_/real_ 集合。
        envVersion: getMiniEnvVersion(),
        ...data,
      },
      success: (res) => {
        // 网关 / 函数异常时 HTTP 状态码非 200，按失败走冷启动重试。
        if (!res || !res.statusCode || Number(res.statusCode) >= 400) {
          handleFail(res || new Error("HTTP 云函数调用失败"));
          return;
        }
        // callHTTPFunction 返回 HTTP 语义：业务体在 res.data（callFunction 是 res.result）。
        let result = res && res.data ? res.data : {};
        // 兜底：个别基础库可能返回字符串体，手工解析一次。
        if (typeof result === "string") {
          try {
            result = JSON.parse(result);
          } catch (e) {
            result = {};
          }
        }
        if (result.success === false) {
          reject(result);
          return;
        }
        resolve(result);
      },
      fail: handleFail,
    });
  });
}

function login() {
  return callCloud("login");
}

function resolveInvite(inviteCode) {
  return callCloud("resolveInvite", { inviteCode });
}

function submitBooking(formData) {
  return callCloud("submitBooking", formData);
}

function getMyCourse() {
  return callCloud("getMyCourse");
}

// 家长通过课程码参课：A 端直建课程后，家长拿到课程码到 B 端输入参课。
// 云函数 DLforP__do / action joinCourseByCode 会调 A 侧查码绑定 + 在 B 落一条课程记录。
function joinCourseByCode(payload) {
  return callCloud("joinCourseByCode", payload);
}

// 查看单个课程的「课节列表 / 每日总结」详情：
// 云函数 DLforP__do / action getCourseDetail 会按当前家长 openid 找到对应课程记录，
// 并把 A 侧全量回抄的 a_result_snapshot.order_snapshot（含整张课表与每日总结）整理后返回。
// orderId：家长端取 latestRequest.courseId（家长课程记录 _id）。
function getCourseDetail(orderId) {
  return callCloud("getCourseDetail", { orderId });
}

// 扫码落地页解析入口：scene 即小程序码 scene 里携带的 entryId。
// 返回 { entryId, targetType, targetId, snapshot }，只读、不写任何用户绑定。
function resolveEntry(scene) {
  return callEntryCloud("resolve_entry", { scene });
}

// 机构展示页读取完整机构展示信息（dev_forPshowC：品牌资料 / 轮播图 / 教练成员）。
// 入参：{ organizationId? } 或 { entryId? }，至少传一个；走 HTTP 云函数通道（与 resolve_entry 同函数）。
// 机构还没推送过展示文档 / 自由教练入口时，云函数返回 orgShow:null，调用方按目标快照降级展示即可。
function getOrgShow(params = {}) {
  return callEntryCloud("get_org_show", params);
}

// 识别码规范化规则（前端 + B 侧云函数 + A 侧云函数 必须完全一致，否则跨端匹配会失败）：
// 1) 剥离所有非字母数字字符（空格、-、_、# 等）
// 2) 统一转大写
// 3) 截断到 16 位，兼容 organization inviteCode 字段长度
// 全小程序所有页面（首页 / 约课页 / 机构展示页 / 上课信息页 / 二维码落地页）统一用这一份，
// 不再在各页面拷贝重复实现，避免规则改动时漏改某一页。
function normalizeInviteCode(inviteCode) {
  return String(inviteCode || "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 16);
}

// 统一拼接「家长约课页」路径：全小程序跳 parent_add 都走这里，保证路径口径一致。
// - inviteCode：识别码，会先过 normalizeInviteCode 规范化，为空则不带该参数；
// - extraQuery：额外透传参数，目前用于二维码入口上下文
//   （sourceEntryId / targetId / targetType / entryName），值为空的字段自动跳过。
function buildParentAddPath(inviteCode, extraQuery) {
  const normalizedInviteCode = normalizeInviteCode(inviteCode);
  const params = [];
  if (normalizedInviteCode) {
    params.push(`inviteCode=${encodeURIComponent(normalizedInviteCode)}`);
  }
  if (extraQuery && typeof extraQuery === "object") {
    Object.keys(extraQuery).forEach((key) => {
      const value = extraQuery[key];
      if (value === undefined || value === null || String(value) === "") {
        return;
      }
      params.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    });
  }
  const query = params.length ? `?${params.join("&")}` : "";
  return `/pages/index/parent_add/parent_add${query}`;
}

module.exports = {
  CLOUD_FUNCTION_NAME,
  ENTRY_QR_FUNCTION_NAME,
  login,
  resolveInvite,
  submitBooking,
  getMyCourse,
  joinCourseByCode,
  getCourseDetail,
  resolveEntry,
  getOrgShow,
  normalizeInviteCode,
  buildParentAddPath,
};
