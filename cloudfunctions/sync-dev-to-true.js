// 关于云函数任何生物，ai不可以操作T_xxx = 正式版云函数
// 唯一操作途径是通过这个文件 sync-dev-to-true.js 迁移
// ai不允许执行迁移
// 这个注释绝对不允许删除
// 启动命令 node sync-dev-to-true.js
// 执行密码 NEWDL123（与 A 端 NEW_DL_fun/sync-dev-to-true.js 同款同密码）
//
// ===== B 端（代码_ToP）说明（2026-10-10 · deploy-meta 强制覆写版，与 A 端脚本同款）=====
//   D_xxx = 开发版云函数（源，唯一手改入口）；
//   T_xxx = 正式版云函数（本脚本的产物，只读，禁止手改）。
//
//   环境模型（本版核心变化）：每个函数入口文件里有一个「deploy-meta」登记块，登记关键字段：
//     side（'D' / 'T'）、envVersion（'develop' / 'release'）、isDev、sourceDir。
//   业务代码一律读 DEPLOY_META 拿环境，不再读请求里的 envVersion —— 环境已由「部署哪个函数」物理固定。
//   本脚本在每次镜像后【强制覆写】T_ 侧该块（side='T' / envVersion='release' / isDev=false /
//   sourceDir=<源 D_ 目录名>）——D_ 源里的值到不了 T_，手改 T_ 也会在下一次同步被覆盖（不可覆写）。
//
//   校验（两道防线）：
//     1) 源目录里没有任何 deploy-meta 块 → 直接抛错（不允许生成无登记的 T_）；
//     2) 覆写后回读：块内必须是 side 'T' / envVersion 'release' / isDev false，否则抛错。
//   另附 WARN：T_ 内若仍残留老写法「{ envVersion: 'develop' }」，会提示人工确认。
//   改写范围：T_ 目录下所有 .js（node_modules 等除外）—— B 侧登记块不一定写在 index.js，
//   DLforP__do 的实际入口是 index.js 转 require 的 login_index.js，按目录全量扫才不会漏。
//
//   现状（2026-10-10）：B 端已拆 D_DLforP__do / D_DLforP_entry_qrcode / D_twowaybinding_1_DLforP 三对；
//   哪份要再拆，就把它复制成 D_xxx（手改只在 D_ 侧做）再跑本脚本生成 T_xxx，之后每次改完 D_ 都重跑一次。
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const PACKAGE_NAME = 'package.json';
const START_PASSWORD = 'NEWDL123';
const D_PREFIX = 'D_';
const T_PREFIX = 'T_';
// 复制时排除：依赖（云端按 package.json 安装）、git、同步清单
const EXCLUDE = new Set(['node_modules', '.git', '.sync-manifest.json']);

// ===== deploy-meta 块（唯一规则：强制覆写）=====
const META_BLOCK_START = '// ===== deploy-meta:start';
const META_BLOCK_END = '// ===== deploy-meta:end';

/** 生成 T_ 侧登记块（每次同步重算，幂等；sourceDir 登记它镜像的 D_ 目录名） */
function buildTrueMetaBlock(dName) {
  return [
    META_BLOCK_START,
    '// 关键字段登记（由 sync-dev-to-true.js 每次同步强制覆写：D_ 源里的值到不了这里，手改也会被下一次同步覆盖）。',
    '// 正式版部署单元：环境固定 release（代表 real，real_*），业务代码不读请求判断环境，一律以本块为准。',
    'const DEPLOY_META = Object.freeze({',
    "  side: 'T',                 // 'D' = 开发版部署单元；'T' = 正式版部署单元",
    "  envVersion: 'release',     // 固定环境：'develop'（dev_*）| 'release'（代表 real，real_*）",
    '  isDev: false,              // = envVersion === \'develop\' 的预计算值，业务代码直接用',
    `  sourceDir: '${dName}',  // 源目录：本 T_ 镜像自该 D_ 目录（仅排查用）`,
    "  managedBy: 'sync-dev-to-true.js'",
    '});',
    META_BLOCK_END
  ].join('\n');
}

/** 取「deploy-meta」块（含起止标记行，不含结尾换行）；找不到返回 null */
function extractDeployMetaBlock(text) {
  const startIdx = text.indexOf(META_BLOCK_START);
  const endIdx = text.indexOf(META_BLOCK_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return null;
  const endLineEnd = text.indexOf('\n', endIdx);
  return text.slice(startIdx, endLineEnd === -1 ? text.length : endLineEnd);
}

/** 把 D_ 侧登记块整体替换为 T_ 侧版本；幂等 */
function rewriteDeployMetaBlock(text, dName) {
  const startIdx = text.indexOf(META_BLOCK_START);
  const endIdx = text.indexOf(META_BLOCK_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return { text, patched: false };
  }
  const lineStart = text.lastIndexOf('\n', startIdx - 1) + 1;
  const endLineEnd = text.indexOf('\n', endIdx);
  const tail = endLineEnd === -1 ? '' : text.slice(endLineEnd);
  return { text: text.slice(0, lineStart) + buildTrueMetaBlock(dName) + tail, patched: true };
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch (e) { return false; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (e) { return false; }
}

// 递归收集文件相对路径（POSIX 分隔）：相对路径 -> 绝对路径
function walk(dir, base = dir, out = {}) {
  if (!isDir(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    if (EXCLUDE.has(name)) continue;
    const abs = path.join(dir, name);
    if (fs.statSync(abs).isDirectory()) {
      walk(abs, base, out);
    } else {
      out[path.relative(base, abs).split(path.sep).join('/')] = abs;
    }
  }
  return out;
}

/**
 * 目录级 deploy-meta 强制覆写：扫描 T_ 目录下所有 .js（node_modules 等除外）。
 *
 * @param {string} tDir  T_ 函数目录
 * @param {string} tName T_ 函数名（仅用于日志）
 * @param {string} dName 源 D_ 目录名（写入 sourceDir）
 * @returns {{ patched: number, skipped: boolean }}
 */
function applyTrueDeployMeta(tDir, tName, dName) {
  const files = Object.keys(walk(tDir)).filter((rel) => rel.endsWith('.js'));
  if (!files.length) {
    throw new Error(`${tName} 目录下没有 .js 文件，无法登记 deploy-meta`);
  }

  let patched = 0;
  for (const rel of files) {
    const filePath = path.join(tDir, rel);
    const source = fs.readFileSync(filePath, 'utf8');
    const result = rewriteDeployMetaBlock(source, dName);
    if (!result.patched) continue;

    fs.writeFileSync(filePath, result.text);
    patched += 1;

    // 回读校验：登记块必须真的落成 T_ 值，否则 T_ 会带着 develop 上线写进开发数据
    const check = fs.readFileSync(filePath, 'utf8');
    const region = extractDeployMetaBlock(check);
    const ok = !!region
      && region.includes("side: 'T'")
      && region.includes("envVersion: 'release'")
      && region.includes('isDev: false')
      && !region.includes("side: 'D'")
      && !region.includes("envVersion: 'develop'");
    if (!ok) {
      throw new Error(`${tName}/${rel} deploy-meta 覆写后不是 T_ 登记值，请人工检查`);
    }
  }

  if (!patched) {
    throw new Error(
      `${tName} 目录内没有 deploy-meta 块 —— 请先在源目录 ${dName} 的入口文件里补上登记块再同步`
    );
  }

  // 附加提示（不阻断）：T_ 内残留老写法 envVersion: 'develop' 时提醒人工确认
  for (const rel of files) {
    const text = fs.readFileSync(path.join(tDir, rel), 'utf8');
    if (/envVersion:\s*'develop'/.test(text)) {
      console.warn(`[sync-dev-to-true] ${tName}/${rel} 仍存在「envVersion: 'develop'」写法，请人工确认是否应改为 DEPLOY_META.envVersion`);
    }
  }

  return { patched, skipped: false };
}

/**
 * 同步单个 D_ 目录：镜像到同名 T_ 目录（排除 node_modules/.git/.sync-manifest.json）。
 * - 先删 T_ 里 D_ 已没有的文件（防幽灵文件）
 * - 再复制 D_ → T_
 * - 最后强制覆写 T_ 侧 deploy-meta 登记块
 */
function syncOne(functionDir) {
  const baseName = path.basename(functionDir);
  if (!baseName.startsWith(D_PREFIX)) {
    console.log(`[sync-dev-to-true] 跳过非 D_ 目录：${baseName}`);
    return;
  }
  const tName = T_PREFIX + baseName.slice(D_PREFIX.length);
  const tDir = path.join(path.dirname(functionDir), tName);
  const srcFiles = walk(functionDir);

  // 1) 清理：删除 T_ 里 D_ 已不存在的文件
  if (isDir(tDir)) {
    const dstFiles = walk(tDir);
    for (const rel of Object.keys(dstFiles)) {
      if (!srcFiles[rel]) {
        fs.unlinkSync(path.join(tDir, rel));
      }
    }
  }

  // 2) 复制：D_ → T_
  for (const rel of Object.keys(srcFiles)) {
    const to = path.join(tDir, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(srcFiles[rel], to);
  }

  // 3) 强制覆写 deploy-meta：T_ 的 side/envVersion/sourceDir 必须由本脚本说了算
  const metaResult = applyTrueDeployMeta(tDir, tName, baseName);
  console.log(`[sync-dev-to-true] ${tName} deploy-meta 覆写：${metaResult.patched} 个文件（side='T' / envVersion='release' / sourceDir='${baseName}'）`);

  console.log(`[sync-dev-to-true] 已同步 ${baseName} -> ${tName}（${Object.keys(srcFiles).length} 个文件）`);
}

// 启动密码校验：必须手动输入正确密码后，才允许执行同步。
function verifyStartPassword() {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    rl.question('[sync-dev-to-true] 请输入启动密码: ', (answer) => {
      rl.close();
      if (String(answer || '').trim() !== START_PASSWORD) {
        reject(new Error('启动密码错误，本次同步已取消'));
        return;
      }
      resolve();
    });
  });
}

async function main() {
  await verifyStartPassword();
  const root = __dirname;
  const targets = fs.readdirSync(root, { withFileTypes: true })
    .filter((item) => item.isDirectory())
    .filter((item) => item.name.startsWith(D_PREFIX))
    .filter((item) => isFile(path.join(root, item.name, PACKAGE_NAME)))
    .map((item) => path.join(root, item.name));

  if (!targets.length) {
    console.log('[sync-dev-to-true] 未找到 D_ 云函数目录（没有要拆的函数时本脚本空跑即正常）');
    return;
  }

  targets.forEach(syncOne);
}

main().catch((error) => {
  console.error(`[sync-dev-to-true] ${error.message}`);
  process.exitCode = 1;
});
