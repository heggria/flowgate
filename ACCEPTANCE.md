# 验收状态

本文件区分开发行为、真实网络、组合安装包和正式分发。原计划见 [PLAN_AUDIT.md](PLAN_AUDIT.md)，证书相关项目按用户要求延期，其他未完成项保留。

## 已验证的行为

完整入口 `npm run verify` 使用隔离数据、本地协议服务器和测试证书，不修改系统路由、DNS 或代理。

- 类型与 AST 依赖边界、单写事务/幂等/排空、持久交接、unknown 原生结果核对、写锁恢复。
- 插件依赖、原子贡献、内核适配生命周期、统一实例追踪、任务检查点、并发存储与有界清理。
- HTTP/SOCKS 入站，SOCKS、Shadowsocks、VMess、VLESS、Trojan、Hysteria2、TUIC 的实际本地 TCP、IPv6、DNS、UDP 矩阵。
- 选定外部出口、规则直连、断线无直连回退、重启恢复；内部网关通过应用所选代理访问上游，流式取消和更新期间排空。
- 内核/桥接强杀、宿主挂死和连续迟发崩溃、版本隔离和兼容回退；Renderer 重建期间转发保持。
- 操作取消、加密凭据引用/热轮换/重启恢复，诊断不记录订阅正文与密钥。
- TUF 入口、签名、摘要、路径/链接/额外文件校验；双签根轮换、过期、离线回执、撤回；UI/Service 更新与并发配置交接。
- 暂停期间准入保护与跨进程期限暂停、恢复后重新观测和原生核对；这是注入电源事件测试。
- 节点/订阅/规则集管理、失败保留、内核测速、草稿、命令/设置/详情贡献、界面与扩展管理。

系统所有权测试调用生产 Swift 算法，但使用注入后端，覆盖 PAC 保留、第三方部分修改、提交失败重试、服务消失，以及旧会话重试不能清理新资源；它不是实际 SystemConfiguration 特权写入。

## 当前外部网络验收

2026-09-10，在本机现有默认出口 `utun5` 上，手动 HTTP CONNECT 和 SOCKS5h 到 example.com 的 HTTPS 请求、HTTP CONNECT 到 Cloudflare 的 HTTPS 请求均通过，TLS 验证开启。默认路由、系统代理和 DNS 的前后观察一致。该实验发现并修复了手动模式自动绑定网卡绕开系统路由的问题，生产代码修复后的复验通过。

外部 IPv6 字面地址请求未通过；系统不经过应用直接访问相同地址也失败。记录为当前网络路径未通过，不认为应用已完成外部 IPv6 验收。本地 IPv6 协议矩阵的成功不能替代这一项。

这些请求不读取或保存公网出口 IP、账户信息或响应正文，也未关闭或重配现有 VPN。未据接口名推断 VPN 所有者。

## 构建、安装包与远程发布

工程流水线包含静态检查、依赖审计、macOS 全套验证、原子构建、来源/哈希清单、独立安装包后台真实请求，以及成功主分支构建的开发预发布。主分支要求 PR 与两项远程检查通过。开发包为 ad-hoc 签名，不等于 Developer ID 签名、公证或可用于特权模式的正式发行。

业务更新使用独立 TUF 角色和实际 [HTTPS 仓库](https://github.com/heggria/flowgate/tree/updates)，[发布配置 PR #4](https://github.com/heggria/flowgate/pull/4) 已通过远程检查并合并。初始历史版本的隐藏应用下载、签名验证、激活、真实转发及重启验收通过。操作程序见 BUSINESS_UPDATES.md；最终整合源码的检查见 [PR #5](https://github.com/heggria/flowgate/pull/5)。正式交付还须发布该整合代码对应的新业务版本，历史版本的成功不能代替最终包验证。

## 尚未通过的真机项目

- Wi-Fi/有线切换、外部 VPN/PAC 启停与重连、受限制网络路径的真实分流。
- 实际 macOS 睡眠/唤醒、长时间日常运行与这些条件下的异常退出恢复。
- 当前环境的外部 IPv6 路径。

## 用户要求延期的证书项目

Developer ID 同团队签名、公证、正式 helper 注册与管理员批准、真实系统代理/TUN 接管恢复和特权崩溃矩阵，以及 Squirrel.Mac 完整应用正式安装更新延期。保留实现和后续验收要求；不再索取证书，也不把它作为独立业务开发的阻塞。完整 v1 尚不能标记全部通过。

## 本轮组合验证记录

工作树 `fix/runtime-recovery` 合并工程基线与 UI 专项后，68 项单元测试、协议、原生故障、签名更新、凭据和电源测试通过，记录在 `work/ui-network-combined-verify.log`。该日志最后的规则集定位错误是旧测试未适配弹窗，修正后 `work/combined-features-recheck.log` 通过。

`work/combined-ui-tail.log` 中草稿、完整业务路径、UI 设计、一致性和 96 组布局检查通过；随后加载状态测试发现启动时空白，修复后的 `work/combined-states-recheck.log` 覆盖加载/错误/待处理状态、扩展生命周期与真实转发。不得把保留的失败日志单独称为整套通过。

后台不抢焦点检查见 `work/combined-background.log`；实际安装包身份、签名一致性与真实转发见 `work/combined-package.log`，该包仍是 feed 整合前的开发包。最终源码与分发包需要对应新的 CI 和安装包验证记录。

真实外网修复前后记录为 `work/external-network.log`、`work/external-network-no-bind.log`、`work/external-network-fixed.log`；外部 IPv6 失败保留在 `work/external-ipv6.log`。失败证据未删除。

短时持续检查 `work/sustained-result.json`：252 秒内完成 120 个本地请求与 6 个外部 HTTPS 请求，内核 PID 和 Service 代次保持不变，窗口始终隐藏；这不等于日常时长或真实睡眠验收。远程首次慢环境发现规则弹窗关闭前的重复文本定位，测试改为先等待关闭再检查保存内容，`work/e2e-dialog-recheck.log` 复验通过。
