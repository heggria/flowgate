# FlowGate

macOS Apple Silicon 上的模块化代理工作区，使用 Electron 44.3.0、React 19 和 sing-box 1.14.0。

当前可运行版本已经具备真实手动 HTTP/SOCKS 代理、订阅/节点管理与测速、规则集来源、分流、独立 DNS 与接口出口、实时连接统计、独立业务服务和经过 TUF 验证的业务版本切换。系统代理/TUN 的 Swift helper 已实现并编译，但尚未完成签名安装和真实系统接管验收；不能把当前构建当作已完成全部 v1 验收的正式发行版。

## 启动

```sh
npm ci
npm run setup:kernel
npm start
```

需要 macOS Apple Silicon、Node.js 24 和 Xcode Command Line Tools（可运行 `xcode-select --install` 安装）。默认不接管系统网络。选择节点并连接后，将需要代理的应用指向 `127.0.0.1:17890`（支持 HTTP 与 SOCKS5）。关闭窗口会保留托盘；退出会清理本应用管理的连接。

内核二进制放在 `vendor/sing-box`，不提交 Git。`vendor/manifest.json` 记录官方来源与完整归档摘要。新机器需下载、校验并解包该固定版本；`npm ci` 负责 Electron 运行时。

## 验证

```sh
npm run verify
```

检查包括 TypeScript、依赖方向、单元/故障测试、真实 Electron 操作、真实 sing-box 转发、独立流式能力包、真实 Electron 的签名 UI/Service 更新与失败回退。测试使用隔离数据和本地服务，不修改本机全局代理、DNS 或路由。证据写入忽略的 `work/`。

## 打包

```sh
npm run build
npm run package:mac
```

生成 `dist-app/FlowGate.app`。默认是本机开发签名，不能启用要求正式团队签名的特权 helper。输出已存在时需选择新的 `FLOWGATE_PACKAGE_DIR`，避免覆盖已有应用。

正式分发还需要 Apple Developer ID、正确的 Electron 签名/公证流程、官方 HTTPS 更新源及离线 TUF 信任根。开发构建不代表已完成正式签名、公证或特权网络验收。

## 结构

- `packages/contracts`：IPC、配置、操作、能力包和 Release Set 契约。
- `packages/domain`：纯配置校验、编译与路径预览。
- `packages/service`：单写数据、配置操作、恢复协调、sing-box 原生 gRPC 遥测。
- `packages/extensions`：独立订阅解析、受限订阅下载与网络发现。
- `packages/runtime`：原子模块激活、贡献点、清理、能力作用域和生命周期。
- `packages/shell`、`src/desktop`：稳定外壳、监督、原生会话、更新协调、恢复界面。
- `packages/release`：TUF、签名回执、完整文件验证和隔离/回退。
- `packages/client`、`src/ui`：与 Electron 解耦的客户端契约、React 工作区和静态产品模块。
- `native`：Swift 桥接、带双向签名约束的 XPC helper、系统设置所有权恢复日志。
- `packages/gateway-test`：内部流式能力包；不是面向用户的 LLM 网关。

完整验收边界见 `ACCEPTANCE.md`，发布配置见 `RELEASING.md`。

## 开源许可

FlowGate 自有代码采用 [GPL-3.0-or-later](LICENSE)。第三方代码和协议定义保留各自声明，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。仓库不包含用户订阅、凭据、测试运行记录或预编译内核。
