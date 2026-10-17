// 新增统一启动入口：云函数平台默认从 index.js 进入（package.json 的 main 字段同时保留做双重兜底）。
// 为什么单独加这个文件：SCF 构建阶段会按常见约定优先扫描 index.js 作为 entryFile，
// 如果目录里只有 login_index.js / LinkToC_index.js，部分版本的微信开发者工具在
// BuildCodeViaSCF 时会报 ResourceNotFound.Entryfile: entryFile did not find in code or layers。
//
// 当前这条家长侧链路已经明确收口：
// 1) 静默登录（login）走 login_index.js；
// 2) 识别码识别（resolveInvite）走 login_index.js；（展示文案改为识别码，底层字段仍用 inviteCode）
// 3) 表单提交（submitBooking）走 login_index.js；
// 4) 家长课程查询（getMyCourse）走 login_index.js。
// LinkToC_index.js 继续保留文件，但不再作为这条链路的实际入口，避免动作路由分散后再次出现“不支持的操作类型”。
const parentEntry = require('./login_index.js');

// 入口日志：这里专门记一层 action 和入口命中，方便看清是不是已经统一收口到了 login_index.js。
function logInfo(label, extra = {}) {
  console.log(`[DLforP__do][entry][INFO] ${label}`, extra);
}

// 显式转发：当前家长侧动作全部统一走 login_index.js。
function routeMain(event = {}, context = {}) {
  logInfo('routeMain.start', {
    action: event.action || 'login',
  });
  if (parentEntry && typeof parentEntry.main === 'function') {
    return parentEntry.main(event, context);
  }

  logInfo('routeMain.missingMain', {
    action: event.action || 'login',
  });
  return Promise.resolve({
    success: false,
    message: '入口初始化异常：login_index.js 未导出 main 函数',
  });
}

// 统一只导出一个 main，符合“最小可启动入口”约定，避免构建系统识别失败。
exports.main = routeMain;
module.exports = { main: routeMain };
