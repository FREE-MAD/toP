# Debug Session: http-no-logs
- **Status**: [OPEN]
- **Issue**: `twowaybinding_1_DLforP` 与 `twowaybinding_1_DLforC` 作为 HTTP 云函数时完全没有日志，需判断是请求未到达实例、实例未启动，还是启动前平台层已失败。
- **Debug Server**: N/A（当前先做平台级排障，不先引入运行时埋点）
- **Log File**: N/A

## Reproduction Steps
1. 更新/部署 HTTP 云函数。
2. 通过 HTTP 访问函数地址。
3. 观察云函数日志面板无任何启动或请求日志。

## Hypotheses & Verification
| ID | Hypothesis | Likelihood | Effort | Evidence |
|----|------------|------------|--------|----------|
| A | HTTP 访问路径或网关路由未命中函数实例，请求根本没到函数 | High | Low | Pending |
| B | `scf_bootstrap` 已存在，但平台未成功执行启动脚本，实例在业务代码前就失败 | High | Low | Pending |
| C | A 侧函数缺少 `node_modules/wx-server-sdk`，启动即报依赖错误 | High | Low | Pending |
| D | HTTP 云函数的部署包根目录不对，上传后实际入口文件不在包根层 | Medium | Low | Pending |
| E | 控制台/平台层的 HTTP 访问状态异常，日志查看位置不对或未切到对应服务日志 | Medium | Low | Pending |

## Log Evidence
- 已确认 `twowaybinding_1_DLforC` 本地缺少 `node_modules/wx-server-sdk`。
- 已确认 `twowaybinding_1_DLforP` 本地存在 `node_modules/wx-server-sdk`。
- 当前仓库根目录未发现 `cloudbaserc.json` / `serverless.yml` 这类函数部署配置文件，推测主要通过 IDE 或控制台直接上传函数目录。
- 用户反馈直接访问 HTTP 地址返回：`INVALID_ENV / Env invalid`，且函数日志为空。
- 已确认代码内曾硬编码旧 A 侧 HTTP 地址：`https://loud1-6gh7jgl8c5b16a83-1398046944.ap-shanghai.app.tcloudbase.com/twowaybinding_1_DLforC`。
- 用户已提供新的 A 侧启用路由地址：`https://cloud1-6gh7jgl8c5b16a83-1398046944.ap-shanghai.app.tcloudbase.com/twowaybinding_1_DLforC`。

## Verification Conclusion
- 假设 A：**Confirmed**。`INVALID_ENV` 说明请求在平台环境映射层就失败，未进入函数实例，所以函数日志为空。
- 假设 E：**Confirmed**。当前首要问题不是函数代码日志，而是 HTTP 访问地址对应的环境无效。
- 假设 C：**Confirmed as secondary risk**。A 侧即便修正环境地址，仍有依赖缺失风险，需要补齐 `wx-server-sdk`。
- 假设 B / D：当前优先级下降。即使存在，也不是“完全无日志”的第一根因。
