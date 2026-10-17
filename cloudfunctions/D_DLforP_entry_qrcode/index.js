// B 侧入口二维码云函数（HTTP 云函数模式）。
//
// ===== 拆双函数（2026-10-10）=====
// 本目录 D_DLforP_entry_qrcode 是「开发版」部署单元：环境固定 develop（读写 dev_entry_registry 等），
// 登记在文件下方 deploy-meta 块里，函数不读请求判断环境。
// 正式版 T_DLforP_entry_qrcode 由 cloudfunctions/sync-dev-to-true.js 从本目录镜像生成（人工执行，密码 NEWDL123），
// 环境固定 release（代表 real，读写 real_* 集合）——T_ 目录禁止手改。
// 调用方按环境选 D_ / T_：B 前端（miniprogram/utils/parent-api.js）按小程序环境选函数名；
// A 侧（_shared/http.js 的 bQrcodeEntryD/T）按 A 端请求环境选地址。
//
// 设计目的：
// 1) A 侧（机构 / 教练管理端）创建机构 / 教练后，通过 HTTP 调用本函数，
//    生成「归属于小程序 B」的小程序码（wxacode.getUnlimited）。
// 2) 二维码 scene 携带 entryId（形如 ENTRY_9XK82），不直接塞业务 ID，
//    用一张 B 侧中转表 dev_entry_registry 维护 entryId → targetType/targetId 的映射，
//    未来扩展教练 / 课程 / 活动入口都不用改扫码协议。
// 3) 扫码后用户进入 B 的 pages/entry_landing/entry_landing，onLoad 里拿 scene
//    调 resolve_entry 解析出展示快照，只做「入口识别」，不写任何用户-机构永久绑定；
//    真正绑定发生在家长提交订单时（order.organizationId / order.sourceEntryId）。
//
// 部署说明：
// - HTTP 云函数模式：scf_bootstrap 启动 node index.js，监听 9000 端口；
// - 镜像 B 侧 twowaybinding_1_DLforP 的 HTTP 入口约定，A 侧可像调 A 的 HTTP 云函数一样调本函数；
// - 部署命令示例：tcb fn deploy --env-id cloud1-d7g77k8il914e5b12 --force DLforP_entry_qrcode
//
// 链路：
//   A 前端 → A 云函数（如 ForOrganizationDo）
//        → HTTP POST/GET 本函数 ?action=generate_entry_qrcode
//        → wxacode.getUnlimited({ scene: entryId, page, envVersion })
//        → cloud.uploadFile 存码 → 回填 qrcodeFileId
//        → 返回 fileID 给 A，A 入库 + 展示

const http = require("http");
const https = require("https");
const { URL } = require("url");
const cloud = require("wx-server-sdk");

// HTTP 云函数模式下 cloud.DYNAMIC_CURRENT_ENV 依赖的 SCF 上下文（TENCENTCLOUD_ENV / SCF_NAMESPACE）
// 不一定能注入，会导致 env 解析为空，SDK 无法定位到绑定小程序 B 的环境，进而拿不到 access_token。
// 因此硬编码 B 侧环境 ID，避免 access_token 解析失败（-501001）。
const B_ENV_ID = "cloud1-d7g77k8il914e5b12";
cloud.init({
  env: B_ENV_ID,
});

const db = cloud.database();

// ===== deploy-meta:start =====
// 关键字段登记（2026-10-10）：本部署单元「是哪一侧 / 环境固定为什么 / 源目录是谁」全部登记在这一块。
// 环境已由「部署哪个函数」物理固定（D_ = develop，T_ = real），业务代码不再读请求判断环境，一律以本块为准。
// 不可覆写：sync-dev-to-true.js 每次同步都会强制覆写 T_ 侧本块 —— D_ 源里的值到不了 T_，手改 T_ 也会在下一次同步被覆盖。
const DEPLOY_META = Object.freeze({
  side: 'D',                 // 'D' = 开发版部署单元；'T' = 正式版部署单元
  envVersion: 'develop',     // 固定环境：'develop'（dev_*）| 'release'（代表 real，real_*）
  isDev: true,               // = envVersion === 'develop' 的预计算值，业务代码直接用，不再做 === 'develop' 判断
  sourceDir: 'D_DLforP_entry_qrcode',    // 源目录（T_ 侧登记它镜像的 D_ 目录名；仅排查用）
  managedBy: 'sync-dev-to-true.js'
});
// ===== deploy-meta:end =====
// 上移到此处（require 之后、所有 console.log 之前）：让冷启动日志也能引用 DEPLOY_META.side 区分 D_/T_ 部署单元。

// 诊断日志：确认 init 时使用的 env，并打印 HTTP 云函数运行时拿到的 env / namespace 相关变量，
// 用于核对 SCF 网关触发时上下文是否完整（若 TENCENTCLOUD_ENV 缺失，正是 DYNAMIC_CURRENT_ENV 失效的根因）。
console.log("[" + DEPLOY_META.side + "_DLforP_entry_qrcode][INFO] cloud.init.resolved_env", {
  resolvedEnv: B_ENV_ID,
  dynamicEnvCurrent: String(cloud.DYNAMIC_CURRENT_ENV || ""),
  processEnvKeys: Object.keys(process.env).filter((k) => /env|namespace|scf|tcb/i.test(k)),
  tencentcloudEnv: process.env.TENCENTCLOUD_ENV || "",
  scfNamespace: process.env.SCF_NAMESPACE || "",
});

// 启动阶段先打一条模块装载日志，便于确认实例是否真的把业务代码跑起来了。
console.log("[" + DEPLOY_META.side + "_DLforP_entry_qrcode][INFO] module.loaded", {
  pid: process.pid,
  portFromEnv: process.env.PORT || "",
  nodeEnv: process.env.NODE_ENV || "",
});

// ===== 常量收口 =====
// 新增（2026-09-06）：B 侧集合按 envVersion 分流——develop 走 dev_*，release/trial 走 real_*。
// 与 A 侧 NDLdev_/NDLreal_ 分流口径对齐，保证开发态与真实态数据物理隔离。
// 集合名从 const 改为 let，由 handleMain 入口按部署侧固定环境（deploy-meta）赋值；
// 云函数单实例内多次请求会复用同一模块，必须在每次请求入口重算，避免串库。
let CURRENT_ENV_VERSION = "develop";
// B 侧 entry 中转表：develop→dev_entry_registry，release→real_entry_registry。
let ENTRY_COLLECTION = "dev_entry_registry";
// 云存储目录：每个 entryId 一张 PNG，便于覆盖重生成。
// 顶层目录按环境物理隔离：develop→dev/，release→real/（最外层 real/dev，再往下才是业务目录）。
// applyEnvVersion() 里按部署侧 DEPLOY_META.isDev 重算；D_ 恒写 dev/，T_ 镜像后恒写 real/。
let QR_STORAGE_DIR = "dev/entry_qrcode";
// 新增（A 侧机构展示信息同步，2026-09-05）：B 侧机构展示集合。
// 用途：A 侧机构资料（名称/简介/城市/地址/轮播图/成员等）分散在 A 的 NDLdev_organization 与 NDLdev_users，
// 通过 DLforP_entry_qrcode 的 sync_org_show 动作由 A 推送到本集合，扫码落地页 resolve_entry 直接读取展示，
// 避免 B 侧跨环境读 A 数据（两个云环境数据库互相不可见，只能靠 A 侧主动 HTTP 推送）。
// develop→dev_forPshowC，release→real_forPshowC。
let SHOW_COLLECTION = "dev_forPshowC";
// 阶段5（识别码收敛，2026-10-13）：原 dev_invite_targets / real_invite_targets 识别码缓存集合
// 已停读停写（家长输码侧 DLforP__do 的唯一缓存家收敛到 forPshowC，未命中回 A 自愈并回写），
// 本函数删除第 ③ 级 invite_targets 反查，集合可手动删除。

// 新增（2026-09-06）：根据 envVersion 重新计算集合名，在 handleMain 入口调用。
// 规则与 A 侧 getCollectionName 一致：develop 用 dev_ 前缀，其余（release/trial/空）用 real_ 前缀。
function applyEnvVersion() {
  // 环境来自部署侧登记（deploy-meta）：D_ 恒 develop、T_ 恒 release，不再从请求读取。
  CURRENT_ENV_VERSION = DEPLOY_META.isDev ? "develop" : "release";
  const prefix = DEPLOY_META.isDev ? "dev_" : "real_";
  ENTRY_COLLECTION = `${prefix}entry_registry`;
  SHOW_COLLECTION = `${prefix}forPshowC`;
  // 云存储顶层目录按环境物理隔离：develop→dev/，release→real/。数据库集合用 dev_/real_ 前缀，
  // 云存储文件夹按要求用 dev/real 作最外层目录（不带下划线），其下才是原业务目录，两环境数据互不污染。
  const storageTop = DEPLOY_META.isDev ? "dev" : "real";
  QR_STORAGE_DIR = `${storageTop}/entry_qrcode`;
  SHOW_STORAGE_DIR = `${storageTop}/forPshowC`;
}

// 新增（A 侧机构展示信息同步）：机构展示图片（logo/轮播图/成员头像）在 B 侧云存储的存放目录。
// A 侧 cloud:// fileID 在 B 环境无法渲染、getTempFileURL 也取不到，必须下载后转存到 B 云存储。
// 顶层目录按环境物理隔离：develop→dev/，release→real/（最外层 real/dev，再往下才是业务目录）。
// applyEnvVersion() 里按部署侧 DEPLOY_META.isDev 重算；D_ 恒写 dev/，T_ 镜像后恒写 real/。
let SHOW_STORAGE_DIR = "dev/forPshowC";
// 二维码落地页：B 侧扫码后统一进这个页面，由它解析 scene 再路由到具体业务页。
const DEFAULT_LANDING_PAGE = "pages/entry_landing/entry_landing";
// 默认指向本部署单元登记的环境（D_ = develop，方便不发布就能扫码调试；T_ = release）。
// 调用方仍可用入参 envVersion 覆盖（业务参数透传，不是环境判断）。
const DEFAULT_ENV_VERSION = DEPLOY_META.envVersion;
// entryId 协议：ENTRY_ + 6 位大写英数字（去掉易混字符），总长 12 字符，远小于 scene 32 字符上限。
const ENTRY_ID_PREFIX = "ENTRY_";
const ENTRY_ID_SUFFIX_LEN = 6;
// 复用项目里 M 码的字符集（0/O/1/I/L 全部剔除，避免扫码识别和肉眼辨认出错）。
const ENTRY_CHARS = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
// entryId 唯一性冲突重试上限，沿用 generateUniqueMCode 的 10 次约定。
const MAX_ENTRY_ID_RETRY = 10;

// ===== 通用工具 =====
function normalizeStr(value = "", maxLen = 0) {
  let s = String(value == null ? "" : value).trim();
  if (maxLen > 0) {
    s = s.slice(0, maxLen);
  }
  return s;
}

// 新增（扫码自动补识别码，2026-09-06）：识别码规范化，规则与前端 parent-api.normalizeInviteCode
// 及 DLforP__do / A 侧云函数完全一致：剥离非字母数字 → 转大写 → 截断 16 位。
// 跨端口径必须一致，否则扫码自动填入的识别码会与家长手输 / 后端匹配链路对不上。
function normalizeInviteCodeLike(value = "") {
  return String(value == null ? "" : value)
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase()
    .slice(0, 16);
}

// 生成单个 entryId 候选：前缀 + 指定长度的随机字符串。
function buildEntryIdCandidate() {
  let suffix = "";
  for (let i = 0; i < ENTRY_ID_SUFFIX_LEN; i += 1) {
    suffix += ENTRY_CHARS[Math.floor(Math.random() * ENTRY_CHARS.length)];
  }
  return `${ENTRY_ID_PREFIX}${suffix}`;
}

// entryId 唯一性校验：查 dev_entry_registry 是否已存在该 entryId。
// 新增（诊断日志）：每次唯一性查询打一条日志，便于排查 entryId 冲突重试次数。
async function isEntryIdOccupied(entryId = "") {
  try {
    const res = await db
      .collection(ENTRY_COLLECTION)
      .where({ entryId })
      .limit(1)
      .get();
    const occupied = Array.isArray(res.data) && res.data.length > 0;
    console.log("[" + DEPLOY_META.side + "_DLforP_entry_qrcode][INFO] isEntryIdOccupied.check", {
      entryId,
      occupied,
      collection: ENTRY_COLLECTION,
    });
    return occupied;
  } catch (err) {
    // DB 查询失败：打印错误后按「未占用」返回会导致写入冲突，按「已占用」返回则让上层继续重试更安全。
    console.error("[DLforP_entry_qrcode][ERROR] isEntryIdOccupied.db_fail", {
      entryId,
      collection: ENTRY_COLLECTION,
      message: err && err.message ? err.message : String(err),
    });
    throw err;
  }
}

// 生成唯一 entryId：最多重试 MAX_ENTRY_ID_RETRY 次，沿用 generateUniqueMCode 的套路。
// 新增（诊断日志）：每次重试打印 attempt 与候选 entryId，便于定位候选冲突分布。
async function generateUniqueEntryId() {
  for (let attempt = 0; attempt < MAX_ENTRY_ID_RETRY; attempt += 1) {
    const candidate = buildEntryIdCandidate();
    // eslint-disable-next-line no-await-in-loop
    const occupied = await isEntryIdOccupied(candidate);
    if (!occupied) {
      console.log("[" + DEPLOY_META.side + "_DLforP_entry_qrcode][INFO] generateUniqueEntryId.ok", {
        entryId: candidate,
        attempts: attempt + 1,
      });
      return candidate;
    }
    console.warn("[DLforP_entry_qrcode][WARN] generateUniqueEntryId.collision", {
      candidate,
      attempt,
      maxAttempts: MAX_ENTRY_ID_RETRY,
    });
  }
  console.error("[DLforP_entry_qrcode][ERROR] generateUniqueEntryId.exhausted", {
    maxAttempts: MAX_ENTRY_ID_RETRY,
    prefix: ENTRY_ID_PREFIX,
    charsetLen: ENTRY_CHARS.length,
  });
  throw new Error("entryId 生成失败，请稍后重试");
}

// 收口 targetType 白名单，避免脏数据写入中转表。
function normalizeTargetType(targetType = "") {
  const t = normalizeStr(targetType).toLowerCase();
  // organization = 机构入口；individual = 个人教练入口。后续新增在这里加即可。
  const allowed = ["organization", "individual"];
  return allowed.indexOf(t) >= 0 ? t : "";
}

// 快照只保留下列字段，避免把 A 侧机构文档整份塞进来导致 entry 表膨胀。
function normalizeSnapshot(snapshot = {}) {
  const s = snapshot && typeof snapshot === "object" ? snapshot : {};
  return {
    institutionName: normalizeStr(s.institutionName || s.name, 64),
    logoFileId: normalizeStr(s.logoFileId || s.logo, 256),
    intro: normalizeStr(s.intro || s.description, 500),
    // 新增（扫码自动补识别码，2026-09-06）：A 侧生成 / 刷新二维码时可随快照推送机构家长端识别码，
    // resolve_entry 直接回传给落地页 → 家长点「我要预约」自动填入约课页；
    // 按统一规则规范化，兼容 invitation_code 别名；老快照没该字段时为空串，不影响展示。
    inviteCode: normalizeInviteCodeLike(s.inviteCode || s.invitation_code),
    // updatedAt 由 A 侧推快照时带上，方便 B 判断是否过期。
    updatedAt: s.updatedAt || new Date(),
  };
}

// 统一返回结构，避免前端到处判 success 字段是否存在。
function buildResult(success, payload = {}) {
  if (success) {
    return { success: true, code: 0, ...payload };
  }
  return {
    success: false,
    code: payload.code || 500,
    message: payload.message || "未知错误",
    errorMessage: payload.errorMessage || payload.message || "",
  };
}

// 新增（A 侧联动需要）：取云存储文件的 HTTPS 临时访问链接。
// 背景：B 侧 cloud:// fileID 只能在小程序 B 的云环境内渲染，A 侧小程序拿到 fileID 也无法显示；
// 跨端展示二维码必须靠临时 HTTPS 链接（A 侧拿到后会自行下载并转存到 A 侧云存储，不依赖链接长期有效）。
// 设计：临时链接取不到时返回空字符串并告警，绝不阻断二维码生成主流程。
async function fetchTempFileUrl(fileId = "") {
  if (!fileId) {
    console.warn("[DLforP_entry_qrcode][WARN] fetchTempFileUrl.skip_empty_fileid");
    return "";
  }
  try {
    const tempRes = await cloud.getTempFileURL({ fileList: [fileId] });
    const item = tempRes && Array.isArray(tempRes.fileList) ? tempRes.fileList[0] : null;
    if (item && item.status === 0 && item.tempFileURL) {
      // 新增（诊断日志）：成功获取临时链接时打印 fileID 前缀与链接签名片段，便于核对 COS 签名有效期。
      console.log("[" + DEPLOY_META.side + "_DLforP_entry_qrcode][INFO] fetchTempFileUrl.ok", {
        fileIdPrefix: String(fileId).slice(0, 60),
        tempUrlLen: item.tempFileURL.length,
        tempUrlTail: String(item.tempFileURL).slice(-24),
      });
      return item.tempFileURL;
    }
    // status 非 0 时 fileList 项里通常带 errMsg，打日志便于排查。
    console.warn("[DLforP_entry_qrcode][WARN] getTempFileURL fail", item || {});
    return "";
  } catch (err) {
    console.warn(
      "[DLforP_entry_qrcode][WARN] getTempFileURL error",
      err && err.message ? err.message : err
    );
    return "";
  }
}

// 新增（A 侧机构展示信息同步）：确保 dev_forPshowC 集合存在。
// 背景：云开发 SDK 对不存在的集合执行 add / where 查询会直接报错（collection not exists），
// 与 DLforP__do 的 ensureForPClassCollection 同套路：createCollection 报「已存在」错误时静默吞掉。
async function ensureShowCollection() {
  try {
    await db.createCollection(SHOW_COLLECTION);
    console.log("[" + DEPLOY_META.side + "_DLforP_entry_qrcode][INFO] ensureShowCollection.created", {
      collection: SHOW_COLLECTION,
    });
  } catch (err) {
    // 集合已存在（-501001 / collection already exists 等）属预期，静默；其余错误打日志但不阻断（后续读写再报真实错误）。
    console.warn("[DLforP_entry_qrcode][WARN] ensureShowCollection.skip", {
      collection: SHOW_COLLECTION,
      message: err && err.message ? err.message : String(err),
    });
  }
}

// 新增（A 侧机构展示信息同步）：HTTPS GET 下载二进制图片，返回 Buffer。
// 用于把 A 侧云存储的临时链接（A 侧 getTempFileURL 生成）下载后转存到 B 侧云存储。
// 失败时返回 null，由调用方决定跳过（图片转存失败不阻断机构展示文字信息落库）。
function httpsGetBuffer(urlStr = "", maxBytes = 8 * 1024 * 1024) {
  return new Promise((resolve) => {
    let urlObj;
    try {
      urlObj = new URL(urlStr);
    } catch (err) {
      console.warn("[DLforP_entry_qrcode][WARN] httpsGetBuffer.bad_url", {
        urlPrefix: String(urlStr).slice(0, 60),
        message: err && err.message ? err.message : String(err),
      });
      resolve(null);
      return;
    }
    const req = https.request(
      {
        hostname: urlObj.hostname,
        path: `${urlObj.pathname}${urlObj.search}`,
        method: "GET",
      },
      (response) => {
        // 非 2xx 一律视为失败（COS 临时链接过期会返回 403）。
        const status = response.statusCode || 0;
        if (status < 200 || status >= 300) {
          console.warn("[DLforP_entry_qrcode][WARN] httpsGetBuffer.http_status", {
            status,
            urlPrefix: String(urlStr).slice(0, 60),
          });
          resolve(null);
          return;
        }
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            console.warn("[DLforP_entry_qrcode][WARN] httpsGetBuffer.too_large", {
              size,
              maxBytes,
            });
            req.destroy();
            resolve(null);
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          const buf = Buffer.concat(chunks);
          if (!buf.length) {
            resolve(null);
            return;
          }
          resolve(buf);
        });
      }
    );
    req.on("error", (err) => {
      console.warn("[DLforP_entry_qrcode][WARN] httpsGetBuffer.error", {
        message: err && err.message ? err.message : String(err),
      });
      resolve(null);
    });
    // 15 秒超时保护：图片下载卡死不能拖垮整个同步请求。
    req.setTimeout(15000, () => {
      console.warn("[DLforP_entry_qrcode][WARN] httpsGetBuffer.timeout", {
        urlPrefix: String(urlStr).slice(0, 60),
      });
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

// 新增（A 侧机构展示信息同步）：从 A 侧 fileID 尾缀猜图片扩展名（A 侧路径约定带 .jpg/.png）。
// 云存储 cloudPath 必须带正确后缀，否则小程序 image 组件渲染可能异常。
function guessImageExt(sourceFileId = "", tempUrl = "") {
  const s = `${sourceFileId || ""}${tempUrl || ""}`.toLowerCase();
  if (s.endsWith(".jpg") || s.endsWith(".jpeg")) {
    return "jpg";
  }
  return "png";
}

// 新增（A 侧机构展示信息同步）：单张图片「下载 → 转存 B 云存储」。
// 幂等由调用方控制：传 existingFileId（旧文档里同 source_file_id 对应的 B 侧 fileID）时直接复用，不重复下载。
// 任一环节失败返回 { failed: true }，不抛异常、不阻断同步主流程。
async function transferShowImage({ sourceFileId, tempUrl, cloudPath, existingFileId }) {
  const srcId = String(sourceFileId || "").trim();
  const tempLink = String(tempUrl || "").trim();
  // 情况 1：A 侧源 fileID 没变且旧文档已有 B 侧 fileID → 直接复用（幂等，省下载+上传配额）。
  if (srcId && existingFileId) {
    return { source_file_id: srcId, file_id: existingFileId, reused: true };
  }
  if (!srcId) {
    // A 侧没传该图（机构没配 logo / 轮播图为空等），属正常情况。
    return { source_file_id: "", file_id: "", skipped: true };
  }
  if (!tempLink) {
    console.warn("[DLforP_entry_qrcode][WARN] transferShowImage.missing_temp_url", {
      sourceFileIdPrefix: srcId.slice(0, 60),
    });
    return { source_file_id: srcId, file_id: "", failed: true, reason: "missing_temp_url" };
  }
  const buffer = await httpsGetBuffer(tempLink);
  if (!buffer) {
    return { source_file_id: srcId, file_id: "", failed: true, reason: "download_failed" };
  }
  try {
    const uploadRes = await cloud.uploadFile({ cloudPath, fileContent: buffer });
    console.log("[" + DEPLOY_META.side + "_DLforP_entry_qrcode][INFO] transferShowImage.ok", {
      sourceFileIdPrefix: srcId.slice(0, 60),
      cloudPath,
      fileLen: buffer.length,
      fileId: uploadRes.fileID,
    });
    return { source_file_id: srcId, file_id: uploadRes.fileID || "" };
  } catch (err) {
    console.warn("[DLforP_entry_qrcode][WARN] transferShowImage.upload_fail", {
      cloudPath,
      message: err && err.message ? err.message : String(err),
    });
    return { source_file_id: srcId, file_id: "", failed: true, reason: "upload_failed" };
  }
}

// 新增（A 侧机构展示信息同步）：成员列表收口，只保留展示需要的字段。
// 脱敏约定：手机号一律不推到 B（落地页面向家长公开），仅保留昵称 + 角色 + 头像。
// 调整（2026-09-06）：收口字段增加 staff_role（成员具体身份展示文案，A 侧已翻译成中文），
// 空值时前端回退「管理层/教练」泛化角色，老文档无此字段不受影响。
function normalizeShowMembers(members) {
  const list = Array.isArray(members) ? members : [];
  return list
    .slice(0, 50)
    .map((m) => {
      const item = m && typeof m === "object" ? m : {};
      return {
        name: normalizeStr(item.name, 32),
        role: normalizeStr(item.role, 16) || "coach",
        // 新增（2026-09-06）：成员具体身份（主教/副教练/自填文本），仅展示用，不涉及敏感信息。
        staff_role: normalizeStr(item.staff_role, 20),
        avatar: item.avatar && typeof item.avatar === "object" ? item.avatar : {},
      };
    })
    .filter((m) => m.name || (m.avatar && m.avatar.fileId));
}

// 新增（A 侧机构展示信息同步）：展示文字字段收口。
function normalizeShowBasic(show = {}) {
  const s = show && typeof show === "object" ? show : {};
  return {
    organization_name: normalizeStr(s.organization_name, 64),
    intro: normalizeStr(s.intro, 500),
    city: normalizeStr(s.city, 32),
    address: normalizeStr(s.address, 128),
    contact_name: normalizeStr(s.contact_name, 32),
    // 联系电话推送到 B 供机构展示使用；是否在落地页展示由 B 前端自行决定。
    contact_phone: normalizeStr(s.contact_phone, 20),
    // 新增（家长端机构展示页改版，2026-09-05）：品牌定位 / 核心服务 / 服务区域 / 适合谁 / 教练理念
    // 五个展示区块字段，A 侧机构资料后续会逐步推送；这里先把存储通道打通：
    // 未推送时为空串，前端按 wx:if 隐藏整行，对现有落地页 / 机构展示页零影响。
    brand_slogan: normalizeStr(s.brand_slogan, 100), // 一句品牌定位（品牌区副标题）
    core_services: normalizeStr(s.core_services, 500), // 核心服务
    service_area: normalizeStr(s.service_area, 300), // 服务区域
    target_audience: normalizeStr(s.target_audience, 500), // 适合谁
    coaching_philosophy: normalizeStr(s.coaching_philosophy, 500), // 教练理念
    // 新增（扫码自动补识别码，2026-09-06）：机构家长端识别码随展示同步落库，
    // resolve_entry 在入口快照缺码时作为第二级回退（A 侧 sync_org_show 推送，未推送为空串）。
    invite_code: normalizeInviteCodeLike(s.invite_code || s.inviteCode),
  };
}

// 新增（2026-10-14 课程收集）：A 侧推送的机构课程列表收口，只保留展示字段。
// 图片对象原样透传给后续转存步骤（transferred 后替换为 { source_file_id, file_id }）。
// 每门课程：{ course_id, name, price, duration, details, images[] }，文本缺省的空课程直接过滤。
const SHOW_COURSE_MAX_COUNT = 20;
const SHOW_COURSE_IMAGE_MAX_COUNT = 5;
function normalizeShowCourses(courses) {
  const list = Array.isArray(courses) ? courses : [];
  return list
    .slice(0, SHOW_COURSE_MAX_COUNT)
    .map((c) => {
      const item = c && typeof c === "object" ? c : {};
      const images = Array.isArray(item.images) ? item.images : [];
      return {
        course_id: normalizeStr(item.course_id, 64),
        name: normalizeStr(item.name, 64),
        price: normalizeStr(item.price, 20),
        duration: normalizeStr(item.duration, 32),
        details: normalizeStr(item.details, 500),
        images: images
          .slice(0, SHOW_COURSE_IMAGE_MAX_COUNT)
          .map((img) => (img && typeof img === "object" ? img : {})),
      };
    })
    .filter((c) => c.name || c.price || c.duration || c.details || c.images.length);
}

// ===== A 侧机构展示信息同步（动作 6：sync_org_show，A 侧推送） =====
// 入参：{ organizationId, entryId?, show, images: { logo, swiper[] }, members[], courses[]?, sourceUpdatedAt? }
// 设计要点：
// 1) organizationId 为唯一键，一机构一条文档（重复推送走 update，幂等）；
// 2) 文字信息直接落库；图片（logo/轮播图/成员头像）走「A 侧临时链接下载 → B 云存储转存」，
//    A 侧 cloud:// fileID 在 B 环境无法渲染，转存后 B 侧 image 组件可直接用 B 的 fileID；
// 3) 图片转存失败不阻断文字信息同步（失败的图片 B 侧 fileID 置空，A 侧源 fileID 保留，
//    下次推送 source_file_id 变化或重试时会再次尝试转存）。
async function syncOrgShow(params = {}) {
  const organizationId = normalizeStr(params.organizationId, 64);
  if (!organizationId) {
    return buildResult(false, { code: 400, message: "organizationId 不能为空" });
  }
  const entryId = normalizeStr(params.entryId, 64);
  const showBasic = normalizeShowBasic(params.show);
  const members = normalizeShowMembers(params.members);
  const imagesInput = params.images && typeof params.images === "object" ? params.images : {};
  const logoInput = imagesInput.logo && typeof imagesInput.logo === "object" ? imagesInput.logo : {};
  const swiperInput = Array.isArray(imagesInput.swiper) ? imagesInput.swiper.slice(0, 5) : [];
  // 新增（2026-10-14 课程收集）：课程列表收口，图片转存在下方步骤 4.5 完成
  const courses = normalizeShowCourses(params.courses);

  console.log("[" + DEPLOY_META.side + "_DLforP_entry_qrcode][INFO] syncOrgShow.start", {
    organizationId,
    entryId,
    hasLogo: !!logoInput.fileId,
    swiperCount: swiperInput.length,
    memberCount: members.length,
    // 新增（2026-10-14 课程收集）：课程数量，便于日志对账
    courseCount: courses.length,
  });

  // 0) 确保集合存在（首次同步前 dev_forPshowC 可能还没建）。
  await ensureShowCollection();

  // 1) 查现有文档：organizationId 唯一键，存在则 update（幂等），不存在则 add。
  let existedDoc = null;
  try {
    const existedRes = await db
      .collection(SHOW_COLLECTION)
      .where({ organizationId })
      .limit(1)
      .get();
    existedDoc = Array.isArray(existedRes.data) && existedRes.data.length ? existedRes.data[0] : null;
  } catch (dbErr) {
    console.error("[DLforP_entry_qrcode][ERROR] syncOrgShow.query_fail", {
      organizationId,
      message: dbErr && dbErr.message ? dbErr.message : String(dbErr),
    });
    return buildResult(false, { code: 500, message: "机构展示信息查询失败，请稍后重试" });
  }
  // 旧文档里「A 源 fileID → B fileID」的映射，用于本次图片幂等复用（源没变就不重新下载）。
  const oldImages = (existedDoc && existedDoc.images) || {};
  const oldLogo = oldImages.logo || {};
  const oldSwiperList = Array.isArray(oldImages.swiper) ? oldImages.swiper : [];
  const oldMembers = Array.isArray(existedDoc && existedDoc.members) ? existedDoc.members : [];

  // 2) 转存机构 logo（取 diy 二维码图或轮播图第一张，由 A 侧决定传哪个）。
  const oldLogoBySource = String(oldLogo.source_file_id || "") === String(logoInput.fileId || "")
    ? String(oldLogo.file_id || "")
    : "";
  const logoResult = await transferShowImage({
    sourceFileId: logoInput.fileId,
    tempUrl: logoInput.tempUrl,
    existingFileId: oldLogoBySource,
    cloudPath: `${SHOW_STORAGE_DIR}/${organizationId}/logo.${guessImageExt(logoInput.fileId, logoInput.tempUrl)}`,
  });

  // 3) 转存轮播图：按 A 侧源 fileID 匹配旧文档轮播图映射（按位置对不上时退化为逐个 source 比对）。
  const oldSwiperMap = {};
  oldSwiperList.forEach((item) => {
    if (item && item.source_file_id) {
      oldSwiperMap[String(item.source_file_id)] = String(item.file_id || "");
    }
  });
  const swiperResults = [];
  for (let i = 0; i < swiperInput.length; i += 1) {
    const item = swiperInput[i] && typeof swiperInput[i] === "object" ? swiperInput[i] : {};
    // eslint-disable-next-line no-await-in-loop
    const result = await transferShowImage({
      sourceFileId: item.fileId,
      tempUrl: item.tempUrl,
      existingFileId: oldSwiperMap[String(item.fileId || "")] || "",
      cloudPath: `${SHOW_STORAGE_DIR}/${organizationId}/swiper_${i}.${guessImageExt(item.fileId, item.tempUrl)}`,
    });
    swiperResults.push(result);
  }

  // 4) 转存成员头像：旧映射按成员（openid 缺失，用 name+role+source 组合近似匹配）。
  const oldMemberMap = {};
  oldMembers.forEach((m) => {
    const avatar = (m && m.avatar) || {};
    if (avatar.source_file_id) {
      oldMemberMap[`${m.name}|${m.role}|${String(avatar.source_file_id)}`] = String(avatar.file_id || "");
    }
  });
  for (let i = 0; i < members.length; i += 1) {
    const avatarInput = members[i].avatar || {};
    const key = `${members[i].name}|${members[i].role}|${String(avatarInput.fileId || "")}`;
    // eslint-disable-next-line no-await-in-loop
    const result = await transferShowImage({
      sourceFileId: avatarInput.fileId,
      tempUrl: avatarInput.tempUrl,
      existingFileId: oldMemberMap[key] || "",
      cloudPath: `${SHOW_STORAGE_DIR}/${organizationId}/member_${i}.${guessImageExt(avatarInput.fileId, avatarInput.tempUrl)}`,
    });
    members[i].avatar = result;
  }

  // 4.5) 转存课程图片（2026-10-14 课程收集）：按「course_id + A 侧源 fileID」近似匹配旧文档映射，
  // 源没变就复用 B 侧 fileID（幂等），变了则重新下载转存；失败项 file_id 置空、A 源 fileID 保留待下次重试。
  const oldCourses = Array.isArray(existedDoc && existedDoc.courses) ? existedDoc.courses : [];
  const oldCourseImageMap = {};
  oldCourses.forEach((c) => {
    (Array.isArray(c && c.images) ? c.images : []).forEach((img) => {
      if (img && img.source_file_id) {
        oldCourseImageMap[`${c.course_id}|${String(img.source_file_id)}`] = String(img.file_id || "");
      }
    });
  });
  for (let ci = 0; ci < courses.length; ci += 1) {
    const courseImages = courses[ci].images;
    for (let ii = 0; ii < courseImages.length; ii += 1) {
      const imageInput = courseImages[ii] && typeof courseImages[ii] === "object" ? courseImages[ii] : {};
      const key = `${courses[ci].course_id}|${String(imageInput.fileId || "")}`;
      // eslint-disable-next-line no-await-in-loop
      const result = await transferShowImage({
        sourceFileId: imageInput.fileId,
        tempUrl: imageInput.tempUrl,
        existingFileId: oldCourseImageMap[key] || "",
        cloudPath: `${SHOW_STORAGE_DIR}/${organizationId}/course_${ci}_${ii}.${guessImageExt(imageInput.fileId, imageInput.tempUrl)}`,
      });
      courseImages[ii] = result;
    }
    courses[ci].images = courseImages;
  }

  // 5) 组装展示文档并落库（add 或 update，幂等覆盖）。
  const now = new Date();
  const showDoc = {
    organizationId,
    entryId,
    show_basic: showBasic,
    images: {
      logo: logoResult,
      swiper: swiperResults,
    },
    members,
    // 新增（2026-10-14 课程收集）：机构课程列表（文字 + 已转存到 B 侧云存储的课程图片）随展示文档落库，
    // 家长端 get_org_show / resolve_entry 整文档返回时一并带出，前端按空值降级默认展示
    courses,
    source_updated_at: params.sourceUpdatedAt || null,
    synced_at: now,
    status: "active",
  };

  let docId = "";
  try {
    if (existedDoc) {
      docId = existedDoc._id;
      await db.collection(SHOW_COLLECTION).doc(docId).update({ data: showDoc });
    } else {
      const addRes = await db.collection(SHOW_COLLECTION).add({ data: { ...showDoc, createdAt: now } });
      docId = addRes._id;
    }
  } catch (dbErr) {
    console.error("[DLforP_entry_qrcode][ERROR] syncOrgShow.write_fail", {
      organizationId,
      docId,
      message: dbErr && dbErr.message ? dbErr.message : String(dbErr),
    });
    return buildResult(false, { code: 500, message: "机构展示信息写入失败，请稍后重试" });
  }

  // 转存失败摘要：A 侧日志对账用（失败的图片 B 侧 fileID 为空，落地页渲染时自动跳过）。
  const failedCount =
    (logoResult.failed ? 1 : 0) +
    swiperResults.filter((r) => r.failed).length +
    members.filter((m) => m.avatar && m.avatar.failed).length +
    // 新增（2026-10-14 课程收集）：课程图片转存失败数一并计入，A 侧 failedImageCount 对账口径对齐
    courses.reduce((acc, c) => acc + c.images.filter((img) => img && img.failed).length, 0);
  console.log("[" + DEPLOY_META.side + "_DLforP_entry_qrcode][INFO] syncOrgShow.complete", {
    organizationId,
    docId,
    existed: !!existedDoc,
    logoOk: !!logoResult.file_id,
    swiperOkCount: swiperResults.filter((r) => r.file_id).length,
    memberCount: members.length,
    // 新增（2026-10-14 课程收集）：课程数量与图片转存成功数，便于日志对账
    courseCount: courses.length,
    courseImageOkCount: courses.reduce((acc, c) => acc + c.images.filter((img) => img && img.file_id).length, 0),
    failedCount,
  });
  return buildResult(true, {
    organizationId,
    entryId,
    showDocId: docId,
    existed: !!existedDoc,
    failedCount,
  });
}

// 新增（A 侧机构展示信息同步）：按 organizationId 读取 B 侧机构展示文档（内部复用，不对外注册为动作）。
// 查询失败 / 无记录一律返回 null，绝不影响 resolve_entry 主流程。
async function findShowDocByOrganizationId(organizationId = "") {
  if (!organizationId) {
    return null;
  }
  try {
    const res = await db
      .collection(SHOW_COLLECTION)
      .where({ organizationId, status: "active" })
      .limit(1)
      .get();
    return Array.isArray(res.data) && res.data.length ? res.data[0] : null;
  } catch (dbErr) {
    // 集合尚不存在 / 查询异常都吞掉：机构展示信息是增强内容，缺失时落地页降级用 entry 快照展示。
    console.warn("[DLforP_entry_qrcode][WARN] findShowDocByOrganizationId.fail", {
      organizationId,
      message: dbErr && dbErr.message ? dbErr.message : String(dbErr),
    });
    return null;
  }
}

// 动作 7（新增，2026-09-05）：家长端「机构展示页」按 organizationId / entryId 读取完整机构展示文档。
// 入参（HTTP POST / callFunction 均可）：{ organizationId? } 或 { entryId? }，至少传一个。
// 与 resolve_entry 的分工：
//   - resolve_entry 只认 entryId，给扫码落地页「第一触点」用，返回入口快照 + orgShow；
//   - 本动作给「已绑定机构的家长」在机构展示页用：家长手里可能只有 A 侧 organizationId（随识别码
//     解析透传），也可能有提交约课时落库的 entryId，两种 key 都支持；
//   - 展示文档不存在（机构还没推送过 / 自由教练入口）时 orgShow=null，不算错误，前端降级用目标快照展示。
async function getOrgShow(params = {}) {
  const organizationIdInput = normalizeStr(params.organizationId, 64);
  const entryIdInput = normalizeStr(params.entryId, 64);
  if (!organizationIdInput && !entryIdInput) {
    console.warn("[DLforP_entry_qrcode][WARN] getOrgShow.empty_key");
    return buildResult(false, { code: 400, message: "organizationId 或 entryId 至少传一个" });
  }

  let organizationId = organizationIdInput;
  // 只传 entryId 的场景：先查入口注册表把 entryId 换成 organizationId（注册表 targetId 即 A 侧机构主键）。
  if (!organizationId && entryIdInput) {
    let entryDoc = null;
    try {
      const res = await db
        .collection(ENTRY_COLLECTION)
        .where({ entryId: entryIdInput, status: "active" })
        .limit(1)
        .get();
      entryDoc = Array.isArray(res.data) && res.data.length ? res.data[0] : null;
    } catch (dbErr) {
      console.error("[DLforP_entry_qrcode][ERROR] getOrgShow.entry_query_fail", {
        entryId: entryIdInput,
        message: dbErr && dbErr.message ? dbErr.message : String(dbErr),
      });
      return buildResult(false, { code: 500, message: "入口查询失败，请稍后重试" });
    }
    if (!entryDoc) {
      console.warn("[DLforP_entry_qrcode][WARN] getOrgShow.entry_not_found", { entryId: entryIdInput });
      return buildResult(false, { code: 404, message: "入口已失效或不存在，请联系机构重新获取二维码" });
    }
    if (entryDoc.targetType !== "organization") {
      // 非机构入口（如自由教练）没有机构展示文档：返回 null 让前端走目标快照降级，不按错误处理。
      return buildResult(true, { orgShow: null, targetType: entryDoc.targetType || "" });
    }
    organizationId = normalizeStr(entryDoc.targetId, 64);
  }

  const orgShow = await findShowDocByOrganizationId(organizationId);
  console.log("[" + DEPLOY_META.side + "_DLforP_entry_qrcode][INFO] getOrgShow.ok", {
    organizationId,
    entryId: entryIdInput,
    hasOrgShow: !!orgShow,
  });
  return buildResult(true, {
    orgShow,
    organizationId,
    entryId: entryIdInput,
  });
}

// ===== 微信服务端 HTTP 直调（不再走 cloud.openapi 云调用） =====
// 背景：cloud.openapi.wxacode.getUnlimited 是「云调用」，必须由小程序端 wx.cloud.callFunction 触发的
// 云函数才能拿到 wxCloudApiToken 票据，进而换出 access_token。本函数是 HTTP 云函数，被 A 侧通过
// HTTP POST 触发，没有 wxCloudApiToken，会直接报 -501001 invalid wx openapi access_token。
// 解决方案：改用标准服务端模式——用 B 小程序的 AppID + AppSecret 调微信开放接口 HTTP API，
// 不依赖云调用票据，可从任意服务端发起。
// AppID / AppSecret 通过 cloudbase 控制台的环境变量注入（WX_APPID / WX_APP_SECRET），不入代码仓库。

// 模块级 access_token 缓存：避免每次生成都重新换取 token（access_token 默认 2 小时有效）。
// 单实例多请求共享；不同实例各自维护自己的缓存。
let cachedAccessToken = { token: "", expiresAt: 0, fetchedAt: 0 };

// 通用微信开放接口 JSON 请求工具（GET / POST JSON），失败 reject 一个带 wxErrcode 的 Error。
function wxHttpJson(urlStr, method = "GET", body = null) {
  return new Promise((resolve, reject) => {
    let urlObj;
    try {
      urlObj = new URL(urlStr);
    } catch (err) {
      reject(new Error("微信接口 URL 格式非法"));
      return;
    }
    const bodyStr = body ? JSON.stringify(body) : "";
    const options = {
      hostname: urlObj.hostname,
      path: `${urlObj.pathname}${urlObj.search}`,
      method,
      headers: {},
    };
    if (body) {
      options.headers["Content-Type"] = "application/json; charset=utf-8";
      options.headers["Content-Length"] = Buffer.byteLength(bodyStr);
    }
    const req = https.request(options, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString("utf-8");
        let parsed = null;
        try {
          parsed = text ? JSON.parse(text) : {};
        } catch (e) {
          reject(new Error(`微信接口返回非 JSON: ${text.slice(0, 500)}`));
          return;
        }
        resolve(parsed);
      });
    });
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// 获取 B 小程序的 access_token（带模块级缓存，提前 5 分钟失效避免边缘 case）。
// AppID/AppSecret 从环境变量读取；缺失时抛出明确错误，便于在 cloudbase 控制台补齐。
async function getWxAccessToken() {
  const now = Date.now();
  // 提前 5 分钟失效，避免临过期边缘 case。
  if (cachedAccessToken.token && cachedAccessToken.expiresAt - now > 5 * 60 * 1000) {
    console.log("[" + DEPLOY_META.side + "_DLforP_entry_qrcode][INFO] access_token.reuse_cached", {
      remainSec: Math.floor((cachedAccessToken.expiresAt - now) / 1000),
    });
    return cachedAccessToken.token;
  }

  const appid = process.env.WX_APPID || "";
  const secret = process.env.WX_APP_SECRET || "";
  if (!appid || !secret) {
    console.error("[DLforP_entry_qrcode][ERROR] access_token.missing_credentials", {
      hasAppid: !!appid,
      hasSecret: !!secret,
    });
    throw new Error(
      "缺少微信小程序 AppID/AppSecret，请在 cloudbase 控制台为本云函数配置环境变量 WX_APPID / WX_APP_SECRET"
    );
  }

  const tokenUrl = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(
    appid
  )}&secret=${encodeURIComponent(secret)}`;
  console.log("[" + DEPLOY_META.side + "_DLforP_entry_qrcode][INFO] access_token.fetch.start", {
    appidPrefix: appid.slice(0, 6),
  });

  const res = await wxHttpJson(tokenUrl, "GET");
  if (!res || !res.access_token) {
    console.error("[DLforP_entry_qrcode][ERROR] access_token.fetch.fail", {
      errcode: res && res.errcode,
      errmsg: res && res.errmsg ? String(res.errmsg).slice(0, 300) : "",
    });
    throw new Error(
      `获取 access_token 失败: errcode=${res && res.errcode}, errmsg=${res && res.errmsg}`
    );
  }

  cachedAccessToken = {
    token: res.access_token,
    expiresAt: now + (res.expires_in || 7200) * 1000,
    fetchedAt: now,
  };
  console.log("[" + DEPLOY_META.side + "_DLforP_entry_qrcode][INFO] access_token.fetch.ok", {
    expiresIn: res.expires_in || 7200,
  });
  return cachedAccessToken.token;
}

// 直接调微信开放接口 wxacode.getUnlimited（HTTP POST，参数同官方文档）。
// 成功返回 { buffer, contentType }（contentType 形如 image/png）；
// 失败抛出带 wxErrcode/wxErrmsg 的 Error（微信返回 JSON: { errcode, errmsg }）。
async function callWxacodeGetUnlimited(accessToken, params = {}) {
  const urlStr = `https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=${encodeURIComponent(
    accessToken
  )}`;
  const body = {
    scene: params.scene,
    page: params.page,
    // 官方字段是 check_path（下划线），云调用 SDK 用驼峰 checkPath；这里直接走 HTTP 必须用下划线。
    check_path: params.checkPath !== false,
    env_version: params.envVersion,
    width: params.width || 280,
  };

  return new Promise((resolve, reject) => {
    let urlObj;
    try {
      urlObj = new URL(urlStr);
    } catch (err) {
      reject(new Error("wxacode 接口 URL 格式非法"));
      return;
    }
    const bodyStr = JSON.stringify(body);
    const req = https.request(
      {
        hostname: urlObj.hostname,
        path: `${urlObj.pathname}${urlObj.search}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": Buffer.byteLength(bodyStr),
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const buf = Buffer.concat(chunks);
          const contentType = (response.headers && response.headers["content-type"]) || "";
          // 成功时微信返回图片二进制，content-type 为 image/*。
          if (contentType.startsWith("image/")) {
            resolve({ buffer: buf, contentType });
            return;
          }
          // 失败时返回 JSON，尝试解析出 errcode/errmsg。
          let errJson = null;
          try {
            errJson = JSON.parse(buf.toString("utf-8"));
          } catch (e) {
            reject(
              new Error(
                `wxacode 接口返回非图片非 JSON: ${buf.toString("utf-8").slice(0, 500)}`
              )
            );
            return;
          }
          const err = new Error(
            `wxacode 错误[${errJson.errcode}]: ${errJson.errmsg || "生成二维码失败"}`
          );
          err.wxErrcode = errJson.errcode;
          err.wxErrmsg = errJson.errmsg || "";
          reject(err);
        });
      }
    );
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

// ===== 业务动作 =====

// 动作 1：生成入口二维码（A 侧调用，幂等）。
// 入参：{ targetType, targetId, snapshot?, page?, envVersion? }
// 幂等策略：
//   - 同 targetType+targetId 已有 active 记录且已带 qrcodeFileId → 直接返回，不重复调微信接口；
//   - 若存在 qr_failed / upload_failed 失败记录 → 复用原 entryId 原地重试，避免 entryId 不断新建。
async function generateEntryQrcode(params = {}) {
  console.log("[" + DEPLOY_META.side + "_DLforP_entry_qrcode][INFO] generateEntryQrcode.start", {
    targetType: params.targetType,
    targetId: params.targetId,
    page: params.page,
    envVersion: params.envVersion,
    hasSnapshot: !!(params.snapshot && typeof params.snapshot === "object"),
  });
  const targetType = normalizeTargetType(params.targetType);
  if (!targetType) {
    return buildResult(false, { code: 400, message: "targetType 非法，仅支持 organization / individual" });
  }
  const targetId = normalizeStr(params.targetId, 64);
  if (!targetId) {
    return buildResult(false, { code: 400, message: "targetId 不能为空" });
  }

  const page = normalizeStr(params.page, 128) || DEFAULT_LANDING_PAGE;
  const envVersion = normalizeStr(params.envVersion, 16) || DEFAULT_ENV_VERSION;

  // 1) 幂等 / 失败复用：先按 targetType+targetId 查最近一条记录（active、qr_failed、upload_failed 都算）。
  console.log("[" + DEPLOY_META.side + "_DLforP_entry_qrcode][INFO] generateEntryQrcode.entry_query.start", {
    targetType,
    targetId,
    collection: ENTRY_COLLECTION,
  });
  const existedRes = await db
    .collection(ENTRY_COLLECTION)
    .where({ targetType, targetId })
    .orderBy("createdAt", "desc")
    .limit(1)
    .get();
  const existedDoc = Array.isArray(existedRes.data) && existedRes.data.length ? existedRes.data[0] : null;
  console.log("[" + DEPLOY_META.side + "_DLforP_entry_qrcode][INFO] generateEntryQrcode.entry_query.result", {
    found: !!existedDoc,
    existedEntryId: existedDoc ? existedDoc.entryId : "",
    existedStatus: existedDoc ? existedDoc.status : "",
    existedHasQrcode: !!(existedDoc && existedDoc.qrcodeFileId),
  });
  if (existedDoc && existedDoc.status === "active" && existedDoc.qrcodeFileId) {
    // 已成功生成过：直接返回，避免重复消耗 wxacode.getUnlimited 配额。
    return buildResult(true, {
      entryId: existedDoc.entryId,
      qrcodeFileId: existedDoc.qrcodeFileId,
      // 新增：附带临时 HTTPS 链接，供 A 侧跨端下载/展示（见 fetchTempFileUrl 说明）。
      qrcodeTempUrl: await fetchTempFileUrl(existedDoc.qrcodeFileId),
      scene: existedDoc.entryId,
      page: existedDoc.page || page,
      envVersion: existedDoc.envVersion || envVersion,
      reused: true,
    });
  }

  // 2) 生成唯一 entryId（或复用失败记录的旧 entryId 原地重试）。
  let entryId = "";
  let docId = "";
  let reusedFailed = false;
  const snapshot = normalizeSnapshot(params.snapshot);
  const now = new Date();
  if (existedDoc && (existedDoc.status === "qr_failed" || existedDoc.status === "upload_failed")) {
    // 上一次生成/上传失败：直接复用原 entryId 原地更新，保持 scene 不变，不产生脏 entryId。
    entryId = existedDoc.entryId;
    docId = existedDoc._id;
    reusedFailed = true;
    // 先把 snapshot 回写到最新值（机构可能在失败后改过名称/介绍）。
    // 新增（诊断日志 + try-catch）：update 失败时打印完整错误并继续主流程，不让回写 snapshot 阻断二维码重试。
    try {
      await db
        .collection(ENTRY_COLLECTION)
        .doc(docId)
        .update({
          data: {
            snapshot,
            page,
            envVersion,
            updatedAt: now,
          },
        });
      console.log("[" + DEPLOY_META.side + "_DLforP_entry_qrcode][INFO] generateEntryQrcode.reuse_snapshot_update.ok", {
        entryId,
        docId,
        targetType,
        targetId,
      });
    } catch (dbErr) {
      console.error("[DLforP_entry_qrcode][ERROR] generateEntryQrcode.reuse_snapshot_update.fail", {
        entryId,
        docId,
        targetType,
        targetId,
        message: dbErr && dbErr.message ? dbErr.message : String(dbErr),
      });
      // snapshot 回写失败不阻断：继续往下走，用最新 snapshot 的 intent 不改变 entryId
    }
    console.log("[" + DEPLOY_META.side + "_DLforP_entry_qrcode][INFO] generateEntryQrcode.reuse_failed_entry", {
      entryId,
      targetType,
      targetId,
      oldStatus: existedDoc.status,
    });
  } else {
    // 全新入口：生成唯一 entryId 并写入初始记录（status=active 但 qrcodeFileId 暂空）。
    entryId = await generateUniqueEntryId();
    // 新增（诊断日志 + try-catch）：初始记录写入失败时抛出明确错误，避免 docId 为空导致后续 update 全部失败。
    let createRes = null;
    try {
      createRes = await db.collection(ENTRY_COLLECTION).add({
        data: {
          entryId,
          scene: entryId,
          targetType,
          targetId,
          page,
          envVersion,
          snapshot,
          qrcodeFileId: "",
          status: "active",
          createdAt: now,
          updatedAt: now,
        },
      });
      docId = createRes._id;
      console.log("[" + DEPLOY_META.side + "_DLforP_entry_qrcode][INFO] generateEntryQrcode.create_entry.ok", {
        entryId,
        docId,
        targetType,
        targetId,
      });
    } catch (dbErr) {
      console.error("[DLforP_entry_qrcode][ERROR] generateEntryQrcode.create_entry.fail", {
        entryId,
        targetType,
        targetId,
        collection: ENTRY_COLLECTION,
        message: dbErr && dbErr.message ? dbErr.message : String(dbErr),
      });
      throw dbErr;
    }
  }

  // 3) 调微信接口生成小程序码（归属于小程序 B）。
  //    不再使用 cloud.openapi.wxacode.getUnlimited（云调用），改用 HTTP 直调微信开放接口：
  //    用 B 小程序的 AppID + AppSecret 换 access_token，再调 /wxa/getwxacodeunlimit 拿图片 buffer。
  //    check_path:false：联调期允许 page 尚未发布到对应 envVersion，避免 errno 47001。
  //    注意：envVersion=release 时 page 必须已在线上版本存在。
  let qrBuffer = null;
  try {
    const wxParams = {
      scene: entryId,
      page,
      checkPath: false,
      envVersion,
      width: 280,
    };
    console.log("[" + DEPLOY_META.side + "_DLforP_entry_qrcode][INFO] wxacode.getUnlimited.call", wxParams);

    // 第一步：拿 access_token（带模块级缓存，2 小时内不重复换 token）。
    const accessToken = await getWxAccessToken();
    // 第二步：HTTP 直调微信开放接口生成小程序码。
    const wxRes = await callWxacodeGetUnlimited(accessToken, wxParams);
    // 成功返回 { buffer, contentType }；失败时 callWxacodeGetUnlimited 已 reject 带 wxErrcode 的 Error。
    if (!wxRes || !wxRes.buffer) {
      throw new Error("wxacode 未返回有效图片数据");
    }
    qrBuffer = wxRes.buffer;
    console.log("[" + DEPLOY_META.side + "_DLforP_entry_qrcode][INFO] wxacode.getUnlimited.ok", {
      entryId,
      bufferLen: (wxRes.buffer && wxRes.buffer.length) || 0,
      contentType: wxRes.contentType || "",
    });
  } catch (err) {
    // 生成失败：把 entry 记录标记为 qr_failed，并把微信原始错误码打进日志，方便定位 wxacode 失败根因。
    const errMsg = err && err.message ? err.message : String(err);
    // 多源提取微信原始错误码：SDK 抛错时 errcode 可能挂在 errCode / errcode / code / wxErrcode 不同字段上，
    // 还可能只埋在 message 字符串里（形如 "...fail -501001 ..."），全部兜底取一遍，避免日志里 wxErrcode 为空。
    const extractedWxErrcode =
      (err && (err.errCode || err.errcode || err.code || err.wxErrcode)) ||
      (function extractFromMsg() {
        const m = String(errMsg).match(/(-?\d{3,})/);
        return m ? Number(m[1]) : "";
      })();
    console.error("[DLforP_entry_qrcode][ERROR] wxacode.getUnlimited.fail", {
      entryId,
      targetType,
      targetId,
      page,
      envVersion,
      wxErrcode: extractedWxErrcode,
      message: errMsg,
      reusedFailed,
      // 完整错误对象快照（取常见字段，避免循环引用导致序列化失败），用于排查 access_token / 调用上下文等问题。
      errSnapshot: {
        name: err && err.name ? err.name : "",
        errCode: err && err.errCode != null ? err.errCode : "",
        errcode: err && err.errcode != null ? err.errcode : "",
        code: err && err.code != null ? err.code : "",
        errMsg: err && err.errMsg ? err.errMsg : "",
        errmsg: err && err.errmsg ? err.errmsg : "",
        stack: err && err.stack ? String(err.stack).slice(0, 1000) : "",
        constructor: err && err.constructor ? err.constructor.name : "",
      },
    });
    await db
      .collection(ENTRY_COLLECTION)
      .doc(docId)
      .update({ data: { status: "qr_failed", updatedAt: new Date() } });
    return buildResult(false, {
      code: 502,
      message: `生成二维码失败: ${errMsg}`,
      entryId,
      wxErrcode: extractedWxErrcode,
    });
  }

  // 5) 上传到云存储，拿稳定 fileID 返回给 A 侧。
  const cloudPath = `${QR_STORAGE_DIR}/${entryId}.png`;
  let qrcodeFileId = "";
  try {
    const uploadRes = await cloud.uploadFile({ cloudPath, fileContent: qrBuffer });
    qrcodeFileId = uploadRes.fileID;
    console.log("[" + DEPLOY_META.side + "_DLforP_entry_qrcode][INFO] uploadFile.ok", {
      entryId,
      cloudPath,
      fileLen: (qrBuffer && qrBuffer.length) || 0,
      qrcodeFileId,
    });
  } catch (err) {
    // 上传失败：标记为 upload_failed，并打印错误详情；docId 在全新/复用失败两种分支都已赋值。
    const errMsg = err && err.message ? err.message : String(err);
    console.error("[DLforP_entry_qrcode][ERROR] uploadFile.fail", {
      entryId,
      cloudPath,
      message: errMsg,
      reusedFailed,
    });
    await db
      .collection(ENTRY_COLLECTION)
      .doc(docId)
      .update({ data: { status: "upload_failed", updatedAt: new Date() } });
    return buildResult(false, {
      code: 502,
      message: `二维码上传失败: ${errMsg}`,
      entryId,
    });
  }

  // 6) 回填 fileID，并把状态恢复为 active（复用失败分支时，原 status 可能是 qr_failed/upload_failed）。
  // 新增（诊断日志 + try-catch）：回填失败是致命的，必须打印 docId 与 qrcodeFileId，方便人工介入 DB 手工补全。
  try {
    await db
      .collection(ENTRY_COLLECTION)
      .doc(docId)
      .update({ data: { qrcodeFileId, status: "active", updatedAt: new Date() } });
    console.log("[" + DEPLOY_META.side + "_DLforP_entry_qrcode][INFO] generateEntryQrcode.backfill_qrcode.ok", {
      entryId,
      docId,
      qrcodeFileId,
      status: "active",
    });
  } catch (dbErr) {
    console.error("[DLforP_entry_qrcode][ERROR] generateEntryQrcode.backfill_qrcode.fail", {
      entryId,
      docId,
      qrcodeFileId,
      cloudPath,
      message: dbErr && dbErr.message ? dbErr.message : String(dbErr),
    });
    // 回填失败：fileID 已在云存储存在，只是 DB 没记录，抛出去让上层返回明确错误，让 A 侧 retry 会再次命中幂等回填。
    throw dbErr;
  }

  const finalTempUrl = await fetchTempFileUrl(qrcodeFileId);
  const finalResult = buildResult(true, {
    entryId,
    qrcodeFileId,
    // 新增：附带临时 HTTPS 链接，供 A 侧跨端下载/展示（见 fetchTempFileUrl 说明）。
    qrcodeTempUrl: finalTempUrl,
    scene: entryId,
    page,
    envVersion,
    reused: false,
  });
  console.log("[" + DEPLOY_META.side + "_DLforP_entry_qrcode][INFO] generateEntryQrcode.complete", {
    entryId,
    qrcodeFileId,
    hasTempUrl: !!finalTempUrl,
    page,
    envVersion,
  });
  return finalResult;
}

// 新增（扫码自动补识别码，2026-09-06）：解析入口对应的家长端识别码（inviteCode）。
// 阶段5（识别码收敛，2026-10-13）：从三级收敛为两级，任一命中即返回；
// 全部未命中 / 查询异常返回空串，绝不影响 resolve_entry 主流程（落地页展示不依赖识别码）：
//   ① entry 快照 snapshot.inviteCode：A 侧生成 / 刷新二维码时随快照推送（新链路，最准最新）；
//   ② dev_forPshowC 展示文档 show_basic.invite_code：A 侧 sync_org_show 同步机构展示时推送（机构重新保存后即有）。
// 原第 ③ 级 dev_invite_targets 缓存反查已删除：识别码唯一缓存家收敛到 forPshowC，
// 家长输码侧（DLforP__do/findInviteTarget）未命中会回 A 识别并回写 forPshowC 完成自愈，
// 扫码侧不再需要独立的反查兜底；机构在 A 侧重新保存一次即可同时补齐快照与展示文档的码。
// 个人教练入口（targetType=individual）目前没有机构主键可关联，两级都可能为空，靠 ① 未来 A 侧推送。
async function findEntryInviteCode(entryDoc, orgShow) {
  const entryId = String((entryDoc && entryDoc.entryId) || "");
  const targetType = String((entryDoc && entryDoc.targetType) || "");

  // ① 入口快照
  const snapshotCode = normalizeInviteCodeLike(
    (entryDoc && entryDoc.snapshot && entryDoc.snapshot.inviteCode) || ""
  );
  if (snapshotCode) {
    console.log("[" + DEPLOY_META.side + "_DLforP_entry_qrcode][INFO] findEntryInviteCode.hit_snapshot", {
      entryId,
      inviteCode: snapshotCode,
    });
    return { inviteCode: snapshotCode, source: "snapshot" };
  }

  // ② 机构展示文档
  const showCode = normalizeInviteCodeLike(
    (orgShow && orgShow.show_basic && orgShow.show_basic.invite_code) || ""
  );
  if (showCode) {
    console.log("[" + DEPLOY_META.side + "_DLforP_entry_qrcode][INFO] findEntryInviteCode.hit_org_show", {
      entryId,
      inviteCode: showCode,
    });
    return { inviteCode: showCode, source: "org_show" };
  }

  // 两级都未命中：返回空串，前端走原链路（家长手动输码，输码侧有回 A 自愈兜底）。
  console.warn("[" + DEPLOY_META.side + "_DLforP_entry_qrcode][WARN] findEntryInviteCode.miss", {
    entryId,
    targetType,
    diagnosisHint:
      "入口快照与 forPshowC 展示文档均未推码；机构在 A 侧重新保存一次即可补推，或家长手动输码走回 A 识别",
  });
  return { inviteCode: "", source: "" };
}

// 动作 2：扫码解析（B 侧 entry_landing 调用）。
// 入参：{ scene }
// 返回：{ entryId, targetType, targetId, snapshot, inviteCode } —— 只读，不写任何用户绑定。
// 新增（诊断日志）：B 侧落地页扫码是家长端关键入口，完整打印 scene、查询命中情况，便于排查「扫码后提示入口失效」。
async function resolveEntry(params = {}) {
  const scene = normalizeStr(params.scene || params.entryId, 64);
  console.log("[" + DEPLOY_META.side + "_DLforP_entry_qrcode][INFO] resolveEntry.start", {
    scene,
    collection: ENTRY_COLLECTION,
  });
  if (!scene) {
    console.warn("[DLforP_entry_qrcode][WARN] resolveEntry.empty_scene");
    return buildResult(false, { code: 400, message: "scene 不能为空" });
  }

  let doc = null;
  try {
    const res = await db
      .collection(ENTRY_COLLECTION)
      .where({ entryId: scene, status: "active" })
      .limit(1)
      .get();
    doc = Array.isArray(res.data) && res.data.length ? res.data[0] : null;
  } catch (dbErr) {
    console.error("[DLforP_entry_qrcode][ERROR] resolveEntry.db_fail", {
      scene,
      message: dbErr && dbErr.message ? dbErr.message : String(dbErr),
    });
    return buildResult(false, { code: 500, message: "入口查询失败，请稍后重试" });
  }
  if (!doc) {
    console.warn("[DLforP_entry_qrcode][WARN] resolveEntry.not_found", {
      scene,
      // 给出诊断提示，区分「不存在」与「存在但被禁用/生成失败」。
      diagnosisHint: "建议用 entryId=" + scene + " 直查 " + ENTRY_COLLECTION + " 全量记录确认 status",
    });
    return buildResult(false, { code: 404, message: "入口已失效或不存在，请联系机构重新获取二维码" });
  }

  console.log("[" + DEPLOY_META.side + "_DLforP_entry_qrcode][INFO] resolveEntry.ok", {
    entryId: doc.entryId,
    targetType: doc.targetType,
    targetId: doc.targetId,
    hasSnapshot: !!(doc.snapshot && typeof doc.snapshot === "object"),
    hasLogo: !!(doc.snapshot && doc.snapshot.logoFileId),
    page: doc.page || DEFAULT_LANDING_PAGE,
  });
  // 新增（A 侧机构展示信息同步）：机构入口时顺带读取 dev_forPshowC 的完整展示文档合并返回，
  // 落地页一次请求即可拿到「文字 + 轮播图 + 成员」完整信息，无需二次调用；
  // 无记录（机构还没推送过）/ 查询异常时 orgShow=null，落地页降级用 entry 快照展示，不报错。
  let orgShow = null;
  if (doc.targetType === "organization") {
    orgShow = await findShowDocByOrganizationId(doc.targetId);
    console.log("[" + DEPLOY_META.side + "_DLforP_entry_qrcode][INFO] resolveEntry.org_show", {
      entryId: doc.entryId,
      targetId: doc.targetId,
      hasOrgShow: !!orgShow,
      orgShowSyncedAt: orgShow && orgShow.synced_at ? String(orgShow.synced_at) : "",
    });
  }
  // 新增（扫码自动补识别码，2026-09-06）：顺带解析入口对应的家长端识别码，
  // 落地页点「我要预约」时带进修课页自动填入；两级回退全部未命中时为空串，不影响落地页展示。
  const inviteInfo = await findEntryInviteCode(doc, orgShow);
  console.log("[" + DEPLOY_META.side + "_DLforP_entry_qrcode][INFO] resolveEntry.invite_code", {
    entryId: doc.entryId,
    targetType: doc.targetType,
    inviteCode: inviteInfo.inviteCode || "",
    inviteCodeSource: inviteInfo.source || "",
  });
  return buildResult(true, {
    entryId: doc.entryId,
    targetType: doc.targetType,
    targetId: doc.targetId,
    snapshot: doc.snapshot || {},
    // 新增：完整机构展示信息（show_basic / images / members），可能为 null。
    orgShow,
    // 新增（扫码自动补识别码）：入口对应的家长端识别码 + 命中来源（snapshot / org_show），可能为空串。
    inviteCode: inviteInfo.inviteCode || "",
    inviteCodeSource: inviteInfo.source || "",
    page: doc.page || DEFAULT_LANDING_PAGE,
  });
}

// 动作 3：查询已生成的二维码（A 侧展示用，不重生成）。
// 入参：{ targetId } 或 { entryId }
// 新增（诊断日志）：A 侧查询二维码详情时打印查询条件与命中情况，便于定位「前端展示空白 / fileID 为空」。
async function getEntryQrcode(params = {}) {
  const entryId = normalizeStr(params.entryId, 64);
  const targetId = normalizeStr(params.targetId, 64);
  console.log("[" + DEPLOY_META.side + "_DLforP_entry_qrcode][INFO] getEntryQrcode.start", {
    entryId,
    targetId,
    collection: ENTRY_COLLECTION,
  });
  if (!entryId && !targetId) {
    console.warn("[DLforP_entry_qrcode][WARN] getEntryQrcode.empty_both_key");
    return buildResult(false, { code: 400, message: "entryId 或 targetId 至少传一个" });
  }

  const where = {};
  if (entryId) {
    where.entryId = entryId;
  } else {
    where.targetId = targetId;
    where.status = "active";
  }
  let doc = null;
  try {
    const res = await db
      .collection(ENTRY_COLLECTION)
      .where(where)
      .limit(1)
      .get();
    doc = Array.isArray(res.data) && res.data.length ? res.data[0] : null;
  } catch (dbErr) {
    console.error("[DLforP_entry_qrcode][ERROR] getEntryQrcode.db_fail", {
      entryId,
      targetId,
      message: dbErr && dbErr.message ? dbErr.message : String(dbErr),
    });
    return buildResult(false, { code: 500, message: "二维码查询失败，请稍后重试" });
  }
  if (!doc || !doc.qrcodeFileId) {
    console.warn("[DLforP_entry_qrcode][WARN] getEntryQrcode.not_found_or_empty", {
      entryId,
      targetId,
      foundDoc: !!doc,
      docStatus: doc ? doc.status : "",
      docHasQrcode: !!(doc && doc.qrcodeFileId),
    });
    return buildResult(false, { code: 404, message: "尚未生成二维码" });
  }

  const tempUrl = await fetchTempFileUrl(doc.qrcodeFileId);
  console.log("[" + DEPLOY_META.side + "_DLforP_entry_qrcode][INFO] getEntryQrcode.ok", {
    entryId: doc.entryId,
    targetId: doc.targetId,
    qrcodeFileIdPrefix: String(doc.qrcodeFileId).slice(0, 60),
    hasTempUrl: !!tempUrl,
    page: doc.page || DEFAULT_LANDING_PAGE,
  });
  return buildResult(true, {
    entryId: doc.entryId,
    qrcodeFileId: doc.qrcodeFileId,
    // 新增：附带临时 HTTPS 链接，供 A 侧跨端下载/展示（见 fetchTempFileUrl 说明）。
    qrcodeTempUrl: tempUrl,
    scene: doc.entryId,
    page: doc.page || DEFAULT_LANDING_PAGE,
    envVersion: doc.envVersion || DEFAULT_ENV_VERSION,
    snapshot: doc.snapshot || {},
  });
}

// 动作 4：刷新机构快照（A 侧改了机构资料后主动推）。
// 入参：{ entryId, snapshot }
// 设计：只更新 snapshot，不触碰二维码本身，避免无谓重新生成。
// 新增（诊断日志）：机构改名、换 Logo 后刷新快照频繁失败时，用这些日志核对 snapshot 字段是否被正确写入。
async function refreshEntrySnapshot(params = {}) {
  const entryId = normalizeStr(params.entryId, 64);
  console.log("[" + DEPLOY_META.side + "_DLforP_entry_qrcode][INFO] refreshEntrySnapshot.start", {
    entryId,
    hasSnapshot: !!(params.snapshot && typeof params.snapshot === "object"),
    snapshotKeys: params.snapshot && typeof params.snapshot === "object" ? Object.keys(params.snapshot) : [],
  });
  if (!entryId) {
    console.warn("[DLforP_entry_qrcode][WARN] refreshEntrySnapshot.empty_entryid");
    return buildResult(false, { code: 400, message: "entryId 不能为空" });
  }
  const snapshot = normalizeSnapshot(params.snapshot);

  let doc = null;
  try {
    const res = await db
      .collection(ENTRY_COLLECTION)
      .where({ entryId })
      .limit(1)
      .get();
    doc = Array.isArray(res.data) && res.data.length ? res.data[0] : null;
  } catch (dbErr) {
    console.error("[DLforP_entry_qrcode][ERROR] refreshEntrySnapshot.query_fail", {
      entryId,
      message: dbErr && dbErr.message ? dbErr.message : String(dbErr),
    });
    return buildResult(false, { code: 500, message: "查询入口记录失败，请稍后重试" });
  }
  if (!doc) {
    console.warn("[DLforP_entry_qrcode][WARN] refreshEntrySnapshot.entry_not_found", { entryId });
    return buildResult(false, { code: 404, message: "entryId 不存在" });
  }

  try {
    await db
      .collection(ENTRY_COLLECTION)
      .doc(doc._id)
      .update({ data: { snapshot, updatedAt: new Date() } });
    console.log("[" + DEPLOY_META.side + "_DLforP_entry_qrcode][INFO] refreshEntrySnapshot.ok", {
      entryId,
      docId: doc._id,
      targetType: doc.targetType,
      targetId: doc.targetId,
      newInstitutionName: snapshot.institutionName || "",
    });
  } catch (dbErr) {
    console.error("[DLforP_entry_qrcode][ERROR] refreshEntrySnapshot.update_fail", {
      entryId,
      docId: doc._id,
      message: dbErr && dbErr.message ? dbErr.message : String(dbErr),
    });
    return buildResult(false, { code: 500, message: "快照刷新失败，请稍后重试" });
  }

  return buildResult(true, { entryId });
}

// 动作 5：禁用入口（机构停用 / 二维码失效）。
// 入参：{ entryId }
// 注意：微信侧已生成的小程序码无法主动吊销，靠 resolve_entry 查不到 active 记录来拦截扫码。
// 新增（诊断日志）：机构停用入口是敏感动作，完整打印调用前后状态，便于事后审计。
async function disableEntry(params = {}) {
  const entryId = normalizeStr(params.entryId, 64);
  console.log("[" + DEPLOY_META.side + "_DLforP_entry_qrcode][INFO] disableEntry.start", { entryId });
  if (!entryId) {
    console.warn("[DLforP_entry_qrcode][WARN] disableEntry.empty_entryid");
    return buildResult(false, { code: 400, message: "entryId 不能为空" });
  }

  let doc = null;
  try {
    const res = await db
      .collection(ENTRY_COLLECTION)
      .where({ entryId })
      .limit(1)
      .get();
    doc = Array.isArray(res.data) && res.data.length ? res.data[0] : null;
  } catch (dbErr) {
    console.error("[DLforP_entry_qrcode][ERROR] disableEntry.query_fail", {
      entryId,
      message: dbErr && dbErr.message ? dbErr.message : String(dbErr),
    });
    return buildResult(false, { code: 500, message: "查询入口记录失败，请稍后重试" });
  }
  if (!doc) {
    console.warn("[DLforP_entry_qrcode][WARN] disableEntry.entry_not_found", { entryId });
    return buildResult(false, { code: 404, message: "entryId 不存在" });
  }

  const oldStatus = doc.status || "";
  try {
    await db
      .collection(ENTRY_COLLECTION)
      .doc(doc._id)
      .update({ data: { status: "disabled", updatedAt: new Date() } });
    console.log("[" + DEPLOY_META.side + "_DLforP_entry_qrcode][INFO] disableEntry.ok", {
      entryId,
      docId: doc._id,
      targetType: doc.targetType,
      targetId: doc.targetId,
      oldStatus,
      newStatus: "disabled",
    });
  } catch (dbErr) {
    console.error("[DLforP_entry_qrcode][ERROR] disableEntry.update_fail", {
      entryId,
      docId: doc._id,
      oldStatus,
      message: dbErr && dbErr.message ? dbErr.message : String(dbErr),
    });
    return buildResult(false, { code: 500, message: "停用入口失败，请稍后重试" });
  }

  return buildResult(true, { entryId });
}

// ===== 动作分发 =====
const ACTION_HANDLERS = {
  generate_entry_qrcode: generateEntryQrcode,
  resolve_entry: resolveEntry,
  get_entry_qrcode: getEntryQrcode,
  refresh_entry_snapshot: refreshEntrySnapshot,
  disable_entry: disableEntry,
  // 新增（A 侧机构展示信息同步，2026-09-05）：A 侧推送机构展示信息（文字 + 图片转存 + 成员）到 dev_forPshowC。
  sync_org_show: syncOrgShow,
  // 新增（家长端机构展示页改版，2026-09-05）：家长端按 organizationId / entryId 只读拉取完整机构展示文档。
  get_org_show: getOrgShow,
};

async function handleMain(event = {}) {
  // 新增（2026-09-06）：请求入口先按 envVersion 切换集合前缀（develop→dev_*，其余→real_*）。
  // 必须放在所有业务逻辑之前，确保本次请求读写的是对应环境的集合。
  // 调整（2026-10-10）：环境不再取 event.envVersion，改由部署侧登记固定（deploy-meta）。
  applyEnvVersion();
  const action = normalizeStr(event.action);
  // 入口日志：打印 action 与关键入参快照（snapshot 整体不打，避免日志膨胀，只标 has 标志）。
  console.log("[" + DEPLOY_META.side + "_DLforP_entry_qrcode][INFO] handleMain.entry", {
    action,
    hasTargetType: !!event.targetType,
    targetId: event.targetId || "",
    hasSnapshot: !!(event.snapshot && typeof event.snapshot === "object"),
    scene: event.scene || "",
    entryId: event.entryId || "",
    page: event.page || "",
    // 调整（2026-10-10）：envVersion 登记部署侧固定值，不再打印请求透传值。
    envVersion: DEPLOY_META.envVersion,
    // 新增（2026-09-06）：打印当前请求实际命中的集合名，便于排查 dev/real 是否串库。
    entryCollection: ENTRY_COLLECTION,
    showCollection: SHOW_COLLECTION,
  });
  if (!action) {
    console.warn("[DLforP_entry_qrcode][WARN] handleMain.missing_action");
    return buildResult(false, { code: 400, message: "缺少 action 参数" });
  }
  const handler = ACTION_HANDLERS[action];
  if (!handler) {
    console.warn("[DLforP_entry_qrcode][WARN] handleMain.unknown_action", { action });
    return buildResult(false, { code: 404, message: `未知操作类型: ${action}` });
  }
  try {
    const result = await handler(event);
    // 出口日志：打印 action 执行结果摘要（success/code/entryId），便于链路排查。
    console.log("[" + DEPLOY_META.side + "_DLforP_entry_qrcode][INFO] handleMain.complete", {
      action,
      success: !!(result && result.success),
      code: result ? result.code : "",
      entryId: result ? result.entryId : "",
      message: result ? String(result.message || "").slice(0, 200) : "",
    });
    return result;
  } catch (err) {
    console.error("[DLforP_entry_qrcode][ERROR] handleMain.fail", {
      action,
      message: err && err.message ? err.message : String(err),
      stack: err && err.stack ? String(err.stack).slice(0, 1000) : "",
    });
    return buildResult(false, {
      code: 500,
      message: err && err.message ? err.message : String(err),
    });
  }
}

exports.main = handleMain;
module.exports = { main: handleMain };

// ===== HTTP 云函数入口（监听 9000，镜像 twowaybinding_1_DLforC 的模式）=====
function writeJson(res, status, body) {
  const payload = JSON.stringify(body || {});
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type, authorization",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  });
  res.end(payload);
}

// 收集 POST body，最大 1MB，防止超大请求打满内存。
function collectRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

// 把 HTTP 请求（query + body）拼成云函数风格的 event，复用同一套 handleMain。
// 新增（诊断日志）：JSON 解析失败 / querystring 解析失败之前是静默吞掉，导致 A 侧看到 action 丢失但 B 侧日志没有任何线索，
// 现在明确打出 body 首段、解析错误消息、最终 fallback 到哪个分支，便于快速定位「HTTP body 格式不合法被整体丢弃」。
async function buildHttpEvent(req, rawBody = "") {
  const requestUrl = new URL(req.url || "/", "http://127.0.0.1");
  const event = { action: "" };

  // query 参数优先。
  let queryParamCount = 0;
  requestUrl.searchParams.forEach((value, key) => {
    event[key] = value;
    queryParamCount += 1;
  });

  // POST body：如果是 JSON 就合并；如果是 querystring 就也合并进来。
  const bodyText = typeof rawBody === "string" ? rawBody.trim() : "";
  if (bodyText) {
    if (bodyText.startsWith("{")) {
      try {
        const parsedBody = JSON.parse(bodyText);
        const bodyKeyCount = Object.keys(parsedBody).length;
        Object.assign(event, parsedBody);
        console.log("[" + DEPLOY_META.side + "_DLforP_entry_qrcode][INFO] buildHttpEvent.json_body.merge_ok", {
          queryParamCount,
          bodyKeyCount,
          // 只打印关键顶层键，不暴露 snapshot 内容。
          bodyTopKeys: Object.keys(parsedBody).slice(0, 10),
        });
      } catch (e) {
        // 新增（诊断日志）：JSON 解析失败——这是非常常见的联动事故源头（例如 A 侧 Content-Type 不对、
        // body 被二次编码、特殊字符打断 JSON）。之前完全静默，A 侧会看到 action 缺失但找不到原因。
        console.warn("[DLforP_entry_qrcode][WARN] buildHttpEvent.json_body.parse_fail", {
          queryParamCount,
          bodyLen: bodyText.length,
          bodyPreview: bodyText.slice(0, 200),
          parseError: e && e.message ? e.message : String(e),
          fallback: "ignore_body_use_query_only",
        });
      }
    } else {
      try {
        const bodyUrl = new URL(`?${bodyText}`, "http://127.0.0.1");
        let bodyParamCount = 0;
        bodyUrl.searchParams.forEach((value, key) => {
          event[key] = value;
          bodyParamCount += 1;
        });
        console.log("[" + DEPLOY_META.side + "_DLforP_entry_qrcode][INFO] buildHttpEvent.qs_body.merge_ok", {
          queryParamCount,
          bodyParamCount,
        });
      } catch (qsErr) {
        // querystring 分支也可能因为 body 有特殊字符导致 URL 构造失败，同样打日志防止静默。
        console.warn("[DLforP_entry_qrcode][WARN] buildHttpEvent.qs_body.parse_fail", {
          queryParamCount,
          bodyLen: bodyText.length,
          bodyPreview: bodyText.slice(0, 200),
          parseError: qsErr && qsErr.message ? qsErr.message : String(qsErr),
          fallback: "ignore_body_use_query_only",
        });
      }
    }
  }

  return event;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 9000) || 9000;

  const server = http.createServer(async (req, res) => {
    try {
      const method = String(req.method || "GET").toUpperCase();
      const requestUrl = new URL(req.url || "/", "http://127.0.0.1");

      console.log("[" + DEPLOY_META.side + "_DLforP_entry_qrcode][INFO] http.request", {
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

      // 健康检查：GET / 或 /health 无业务参数时返回探活信息。
      if (
        requestUrl.pathname === "/health" ||
        (requestUrl.pathname === "/" && method === "GET" && !requestUrl.search)
      ) {
        writeJson(res, 200, {
          success: true,
          code: 0,
          message: "DLforP_entry_qrcode HTTP 云函数已启动",
        });
        return;
      }

      const rawBody = method === "POST" ? await collectRequestBody(req) : "";
      // 打印请求体大小，便于排查 A 侧是否把 snapshot 等参数完整传过来。
      console.log("[" + DEPLOY_META.side + "_DLforP_entry_qrcode][INFO] http.body.received", {
        method,
        bodyLen: rawBody ? rawBody.length : 0,
        bodyPreview: rawBody ? String(rawBody).slice(0, 300) : "",
      });
      const event = await buildHttpEvent(req, rawBody);
      // 打印解析后的 event 关键字段（不打印 snapshot 整体，避免日志膨胀）。
      console.log("[" + DEPLOY_META.side + "_DLforP_entry_qrcode][INFO] http.event.parsed", {
        action: event.action || "",
        targetType: event.targetType || "",
        targetId: event.targetId || "",
        hasSnapshot: !!(event.snapshot && typeof event.snapshot === "object"),
        entryId: event.entryId || "",
        scene: event.scene || "",
      });
      const result = await handleMain(event, {});
      // 打印响应摘要，便于排查 B 侧最终给 A 侧返回了什么。
      console.log("[" + DEPLOY_META.side + "_DLforP_entry_qrcode][INFO] http.response.send", {
        httpStatus: 200,
        success: !!(result && result.success),
        code: result ? result.code : "",
        entryId: result ? result.entryId : "",
        message: result ? String(result.message || "").slice(0, 200) : "",
      });
      writeJson(res, 200, result);
    } catch (error) {
      console.error("[DLforP_entry_qrcode][ERROR] http.fail", {
        message: error && (error.message || error.errMsg) || String(error),
        stack: error && error.stack || "",
      });
      writeJson(res, 500, {
        success: false,
        code: 500,
        message: "DLforP_entry_qrcode HTTP 服务执行失败",
        errorMessage: error && (error.message || error.errMsg) || String(error),
      });
    }
  });

  server.listen(port, "0.0.0.0", () => {
    console.log("[" + DEPLOY_META.side + "_DLforP_entry_qrcode][INFO] http.listen", { port });
  });
}
