# 验收状态

完整 v1 尚未完成。下列本地行为已实现并持续验证，正式系统接管与发布仍有独立验收条件。原计划逐项追踪见 [PLAN_AUDIT.md](PLAN_AUDIT.md) 第 9 节。

## 自动验收

`npm run verify` 是完整入口，使用隔离数据、本地协议服务器和临时测试证书；不修改系统代理、DNS 或路由。

- 类型、依赖边界、42 项单元/局部测试、业务与原生构建。
- 单写锁、幂等操作、事务排空、版本化交接；模块依赖与原子贡献、任务检查点、存储迁移、期限和资源释放。
- 节点/订阅管理、草稿与保存失败保护、真实内核测量、规则集 HTTPS 导入/刷新/失败保留。
- HTTP 与 SOCKS 入站，外部 HTTP 出口，IP 规则直连；SOCKS、Shadowsocks、VMess、VLESS、Trojan、Hysteria2、TUIC 的 TCP、IPv6 目标、DNS 和 UDP 本地矩阵。
- 外部 SOCKS 停止后不直连回退，重启后恢复；明确接口和独立解析器的本地测试。接口测试使用 lo0，不是 VPN 验收。
- HTTPS / SOCKS5h egress 的证书校验、目标范围和无直连回退。
- 内核、桥接、Service、Extension、Renderer 强杀；手动内核遗留清理、写入禁止、恢复后真实转发。控制诊断按 trace/代次/模块记录，正文和凭据不进入日志。
- 加密凭据的跨进程引用、热轮换、冲突拒绝和应用重启恢复。
- TUF 签名、摘要、入口、路径/链接/额外文件拒绝，根密钥轮换、过期、离线回执、撤回与隔离。
- 签名 UI/Service 更新、流式网关排空、失败回退，以及配置正在应用时的版本交接；不回滚用户数据、不重放已提交操作。
- 界面的真实流量历史、搜索/详情、时间范围、深浅色、窄窗口、命令贡献、深链和崩溃重建。

以 `work/goal-final-verify.log` 和 `work/{e2e,native,protocols,native-faults,ownership,gateway,update,credentials,cancellation,features,drafts,ui}-result.json` 为实际运行证据。日志出现失败时不能声称整套通过，修复后须重跑受影响项目。

## 系统所有权测试的范围

`tests/OwnershipTests.swift` 执行生产所有权算法，但使用注入的配置后端，验证 PAC 保留、第三方字段保护、提交失败重试、持久恢复和网络服务消失。它不会调用真实 SystemConfiguration 写入，也不能替代特权 helper 验收。

## 必须继续完成的系统与发布验收

1. Developer ID 同团队签名、公证、真实 helper 注册与管理员批准；系统代理/TUN 建立、断开、所有权恢复和主进程/helper 异常退出。
2. 用户实际使用的 VPN/PAC/外部代理与真实 IPv4/IPv6/DNS 路径共存；网络切换、睡眠/唤醒及长时间使用。不能承诺兼容所有强制 VPN 或系统过滤器。
3. 用户提供的官方 HTTPS 元数据/产物仓库、正式角色密钥和信任根、Squirrel.Mac 完整应用 feed；实际发布、撤回与生产轮换流程。
4. 在正式远端仓库运行现有 CI，而不是将本地运行称为远程 CI 已通过。

本机有效签名身份仍为 0，正式更新配置保持关闭。这些条件未达到前，不标记“全部计划完成”。Web 独立宿主、其他桌面系统、完整模型网关和多代滚动网关属于原计划的后续范围。
