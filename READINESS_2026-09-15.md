# 持续发布准备：2026-09-15

## 当前证据与结论

此前候选代码 `6f04012c61b91b57c6621bafb6d65ff69d0ceb48` 已通过 [精确提交的远程检查](https://github.com/heggria/flowgate/actions/runs/34931766531)，包括 103 项单元测试、完整协议/更新/故障/UI 回归、后台不抢焦点、安装包转发和归档。[草稿 PR #12](https://github.com/heggria/flowgate/pull/12) 尚未合并或用于正式发布。

本轮修复了正式签名后文件清单失效、源码归档与实际构建提交不一致、带引号的凭据未脱敏，以及停止失败后关闭流程没有释放桥接管道的问题。签名后清单仅允许指定原生程序改变，保留签名前哈希；归档绑定精确的干净源码提交，并校验应用包、源码和来源说明三个文件。

精确提交的 CI 交付包已下载到本机，三个校验和与源码归档提交再次核对通过；解压后的 CI 应用也通过包内清单、签名完整性、隐藏启动和实际本地转发验证。下载通过隔离的测试代理完成，原用户数据与系统网络设置前后保持一致。结果见 `work/readiness/ci6f-download-result.json`、`ci6f-local-package-result.json`；这是开发包，不是已公证正式发行版。

## 已完成的真实特权验收

在无既有辅助服务的临时 GitHub-hosted macOS 机器上，使用生产安装器、XPC 与 root helper 完成以下六项；不是注入系统后端。

| 接入方式 | 场景           | 实际请求                               | 进程退出与设置恢复 |
| -------- | -------------- | -------------------------------------- | ------------------ |
| 系统代理 | 正常停止       | 通过 macOS URLSession 自动代理发现转发 | 通过               |
| 系统代理 | 内核 SIGKILL   | 强杀前真实转发通过                     | 通过               |
| 系统代理 | helper SIGKILL | 强杀前真实转发通过                     | 通过               |
| 定向 TUN | 正常停止       | 通过 `198.18.0.88/32` 路由转发         | 通过               |
| 定向 TUN | 内核 SIGKILL   | 强杀前真实转发通过                     | 通过               |
| 定向 TUN | helper SIGKILL | 强杀前真实转发通过                     | 通过               |

helper 强杀后，在恢复断言之前没有重新调用 helper，避免用重启恢复替代 watchdog 证据。最终使用生产卸载器清理；代理、DNS、默认路由与原值一致，辅助服务安装文件已移除。对应结果为 `work/readiness/ci6f-results/privileged-ci-result.json`，包构建号为 79。

这证明上述隔离机器路径；不代表所有 VPN/整机 TUN 共存、用户 Mac 的管理员交互、真实睡眠或 Developer ID 分发已通过。

## 外网对照与持续运行

- 早期 616 秒、30 次真实节点 HTTPS 请求中，28 次成功，2 次访问 Cloudflare 被重置。失败记录完整保留。
- 新包与已安装旧版交替各请求 Cloudflare 8 次，各有 3 次失败；系统原有路径 8 次成功。旧版包含一次已收到部分正文后的超时，其他失败为连接重置，不能统称为 TLS 握手失败。
- 使用同一新包、请求同一小资源时，原节点 6 次中有 2 次重置；另一个服务器端点不同的已配置节点 6 次成功，系统路径 6 次成功。证据更指向原节点路径的不稳定，仍不能定位具体网络环节，也不能证明没有任何应用问题。
- 全部实验使用隔离副本，原节点选择、用户数据、系统代理、DNS 和默认路由前后一致。
- `25803c9` 测试包的半小时本地持续检查通过：1800 秒、358 次实际 HTTP/SOCKS 请求、29 次启停、14 次页面重载；服务代次稳定，每次停止后的测试内核退出，网络设置前后一致。179 次采样的最大间隔为 11 秒。结果见 `work/readiness/soak-result.json`；不能写成最新提交的独立长稳或日常时长验收。

详细结果位于 `work/readiness/sustained-result.json`、`paired-result.json`、`node-comparison-result.json`。内存采样、短时成功和本地回环均不能替代日常时长、外网或实际睡眠/切网验收。

## 后续修复：完整应用更新状态

后台更新器原来仅修改私有字符串；设置页忽略检查请求的返回值，也没有接收异步结果。已新增主进程状态快照与可选的 Shell 事件接口，让检查、下载、失败、最新版本和下载完成状态显示到页面。重新进入设置时读取最新状态；递增序号防止旧快照覆盖新事件。重复检查或已有待安装更新时不会再次调用更新器，失败后可以重试，底层异常不会直接暴露到界面。

修复前的针对性界面用例因检查状态不可见失败；修复后，页面事件、离页后失败、下载完成及过期结果保护通过。真实隔离应用中的 main/preload/renderer 通知与错误状态读取也通过，106 项单元测试、类型检查、构建、边界检查及界面状态/无障碍/交互回归通过。对应记录为 `work/readiness/application-update-*.log`。该用例加入常规 `verify`，使用测试事件和无更新源的开发应用，不等于签名更新源的实际下载、安装验收。此后续变更仍需新提交的远程全套检查。

## 后续远程发现与验收扩展

`4a1c560` 的 push 检查通过完整行为、界面与安装包验证，真实系统代理/定向 TUN 六项也通过；新增独立 TUN 因测试接口名仅为 `utun` 而在启动时被内核拒绝。退出时卸载成功，网络设置一致。已改为按实际接口列表选择空闲 `utunN`，随后 `74d88ab` 的实际共存结果通过，具体范围如下。

同一提交的 PR 检查在草稿测试遇到顶部通知与表单错误同时存在，原全局 alert 定位不唯一。测试改为定位 DNS 表单的具体错误；同时修复 DNS 无效输入显示底层英文错误、无主机地址的 `udp://`/`tls://` 可通过保存校验的问题。107 项单元测试、草稿端到端与真实 DNS 转发专项通过；失败输入仍保留草稿。

隔离安装矩阵新增校验失败的替换不卸载正在工作的旧服务、同版本重装后的 XPC/真实转发，以及重复卸载。这些新特权用例已在 `74d88ab` 的实际 CI 中通过。记录位于 `work/readiness/ci4a1-*-failed.log`、`dns-*.log` 与 `installer-matrix-typecheck.log`。

## 最新完整检查与发布工具准备

`74d88ab23af4f5507997a0ac7d3e889b32651886` 的 [push 检查](https://github.com/heggria/flowgate/actions/runs/34934928108) 和 [PR 检查](https://github.com/heggria/flowgate/actions/runs/34934930985) 均通过。107 项单元测试、完整行为/UI/安装包与归档检查通过；实际 root 流程的六项基线、三个双 TUN 场景、替换校验失败保留旧服务、同版本重装共 11 项通过，重复卸载后安装文件移除，系统代理/DNS/默认路由与之前一致。两个 TUN 使用独立内核、专用路由和各自受限的 HTTP 出口；这仍不是全局 TUN 与任意 VPN 的完整验收。日志提取结果为 `work/readiness/ci74-privileged-result.json`。

新增 `prepare:application-release` 在完整签名、同团队原生组件、公证票据、Gatekeeper、清单和版本递增检查之后准备 ZIP、静态更新目录、源码和校验和，不上传文件。真实开发包被按预期拒绝，正式签名成功路径仍未验证。用唯一标识的隔离 Electron 副本运行实际 Squirrel 解析器，生成的同版本目录、损坏 JSON、缺下载地址、下一次检查恢复均通过；未下载或安装任何更新。详见 [APPLICATION_UPDATES.md](APPLICATION_UPDATES.md)。发布工具与新增解析测试已在 `f0a678e` 的 push 检查中通过；正式签名成功路径仍需凭据与实际产物验收。

## 生产完整 TUN 补充验收

`10a241c` 的 [push 检查](https://github.com/heggria/flowgate/actions/runs/34936892966) 和 [PR 检查](https://github.com/heggria/flowgate/actions/runs/34936896175) 均通过。新增第 12 项直接使用生产编译配置：完整 TUN、专用规则到本机 HTTP 节点、其余直连，与独立定向 TUN 同时真实转发。没有测试用的 lo0 绑定或 /32 接管缩减。公开 IPv4 地址的路由指向本应用 TUN，HTTPS 请求与停止后恢复通过；独立 TUN 在本应用停止后继续转发。证据为 `work/readiness/ci10a-privileged-result.json`。该场景未发现需要额外绑定 lo0 的产品缺陷，但仍不代表任意 VPN、Service 的完整协调策略或外部 IPv6。

另新增独立 Swift SCPreferences 写入器，在临时 CI 机器上修改有效 HTTP 代理，再检查正常停止/helper 崩溃能否保留第三方 HTTP 设置、恢复自己仍拥有的 HTTPS/SOCKS，并由 URLSession 实际访问第三方出口。这两项在 `46e0ae5` 的 [push 检查](https://github.com/heggria/flowgate/actions/runs/34937776955) 与 [PR 检查](https://github.com/heggria/flowgate/actions/runs/34937778466) 均通过，包含此前场景共 14 项真实特权验收。分支精确提交的证据为 `work/readiness/ci46-privileged-result.json`；PR 构建使用 GitHub 合并提交 `4b9e8cf`，另存 `ci46-pr-privileged-result.json`。最后卸载、安装文件移除和网络设置恢复通过。

另准备了 Service 自动协调场景：同一受保护 CI 入口直接组合生产 Service、原生会话和真实系统检查器。第三方改写后等待正常轮询自行停止本应用，并核对持久化成功操作、第三方设置和实际转发。未新增桌面权限开关；类型检查、7 项相关单元测试和本机拒绝执行守卫通过，远程实际结果尚未产生。该场景只覆盖自动让出系统代理，不能代表所有网络变化策略。

## 仍未完成

完整 TUN 与 VPN 共存矩阵、外部 IPv6、真实睡眠和切网、日常长稳、正式 Apple 签名/公证以及完整应用更新仍待补齐。持续标准见 [RELEASE_READINESS.md](RELEASE_READINESS.md)，动态进度见 `work/STATE.md`。
