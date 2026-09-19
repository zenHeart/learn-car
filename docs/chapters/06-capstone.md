# 第 6 章 Capstone：最小车联网远程诊断回路

> 能力目标：capstone-telematics — 基于 TBOX、TSP 云、4G/5G 与 OTA，串通一次远程诊断数据从车端上行到云端再到手机 App 的回路，并指出其中至少两个安全风险。

## 6.1 项目目标

把前五章学到的总线、座舱、三电、ADAS 知识，落到一个能跑、能看、能验的项目上。我们构建的最小回路：

**车端（ECU+TBOX）→ 4G/5G → TSP 云 → 手机 App → 下发命令 → 车端执行**

真实场景：仪表盘报 U0100（与某 ECU 通信丢失），驾驶员收到 App 推送，点击查看详情，下发"清除 DTC"命令，车端执行并回执。

## 6.2 组件清单

- **车端模拟**：树莓派 4 + CAN 模拟器（SocketCAN + virtual CAN）或预录 CAN 报文 + Python 脚本模拟 DTC 生成。
- **TBOX**：一个运行 mqtts 客户端的 Python 服务（paho-mqtt + TLS）。
- **TSP 云**：FastAPI（Python）或 Express（Node.js），提供 RESTful API + WebSocket 推送。
- **手机 App**：H5 单页面，Vue 3 或原生 HTML/JS，用 WebSocket 订阅 TSP 推送。
- **安全基础设施**：自签 CA、服务器证书、设备证书、TLS 双向认证。

## 6.3 协议选型

- **车端 ↔ TBOX**：车内 CAN/CAN FD，由 TBOX 网关转发。
- **TBOX ↔ TSP**：MQTT over TLS（端口 8883），主题层级 `car/{vin}/dtc`、`car/{vin}/command`。
- **TSP ↔ App**：WebSocket（端口 443）+ RESTful 拉取历史。
- **App ↔ TSP 命令下发**：HTTPS POST `/api/v1/command`，JWT 鉴权。

## 6.4 链路时序

1. 树莓派模拟"ECU 通信丢失"，周期性向 TBOX 推 U0100 DTC；
2. TBOX 通过 MQTT over TLS 把 DTC 推送到 TSP；
3. TSP 把 DTC 持久化到 SQLite/PostgreSQL，并通过 WebSocket 推到订阅了 `vin=xxx` 的所有 App；
4. App 收到推送，弹通知，用户点击"查看详情"打开 H5；
5. 用户点击"清除 DTC"，App 调用 RESTful API；
6. TSP 校验用户身份、设备绑定关系与速率限制后，把命令下发到 TBOX 的 MQTT 主题；
7. TBOX 通过车内 CAN 发出 UDS 0x14（ClearDiagnosticInformation）服务；
8. ECU 回 0x54（PositiveResponse），TBOX 把结果回送 TSP；
9. TSP 推送"清除成功"到 App。

端到端延迟目标：步骤 1→3 ≤5 s；步骤 5→8 ≤3 s。

## 6.5 安全风险与缓解

至少要识别并缓解以下两类风险：

1. **设备证书私钥泄露**：TBOX 的设备证书私钥如果被逆向，攻击者可以冒充车端推送虚假 DTC。缓解：私钥存放于硬件安全模块（HSM/TEE）、证书绑定 VIN、设备指纹。
2. **命令下发鉴权薄弱**：如果没有"驾驶员确认"环节，攻击者拿到 TSP API 后可远程执行"解锁车门"等高危命令。缓解：双向认证 + 用户二次确认 + 命令速率限制 + 黑名单 VIN 列表。

可选第三类：TSP 与车端无时间戳校验，造成重放攻击。缓解：每条消息带单调递增 nonce，TSP 拒绝延迟超过 30 s 的消息。

## 6.6 弱网与降级

- **断网**：TBOX 缓存最近 1000 条 DTC，重连后批量补传；App 显示"离线模式"。
- **弱网（高延迟高丢包）**：MQTT QoS 1/2 自动重传，TSP 推送改用 HTTP long-polling fallback。
- **TSP 不可达**：TBOX 进入本地存储模式，不丢弃 DTC，恢复后立即上报。

## 6.7 验证清单

- [ ] 链路能在本地 Docker Compose 一键拉起；
- [ ] 端到端延迟 ≤5 s + ≤3 s；
- [ ] 弱网降级行为可观察（用 `tc netem` 注入 30% 丢包与 500 ms 延迟）；
- [ ] 至少一处设备证书私钥泄露攻击与缓解路径走通；
- [ ] 至少一处命令下发鉴权攻击与缓解路径走通；
- [ ] App 在 4G/5G/Wi-Fi 三种网络下推送到达率 ≥95%。

## 6.8 扩展方向

把链路升级为 OTA（远程 ECU 刷写），会共享同一套安全基础设施，但额外要求：

- 双 bank（A/B）刷写防变砖；
- 差分升级减少流量；
- 版本回滚机制；
- 监管：GB 44495/UN R156 软件更新管理体系。

## 6.9 自检题

1. MQTT over TLS 与普通 HTTPS REST 在车端上行场景中各自的优劣？
2. 为什么命令下发要做"驾驶员二次确认"而不是只在 TSP 做鉴权？
3. OTA 与诊断链路共享的安全基础设施有哪些？

## 6.10 部署清单

生产级部署还要补上：

- **可观测性**：TBOX 与 TSP 都接入 OpenTelemetry，trace 链路显示 DTC 从生成到推送 App 的全链路耗时；
- **设备管理**：TSP 维护一份 `DeviceInfo`，记录每个 TBOX 的证书、固件版本、最近心跳时间；离线超过 7 天主动告警；
- **速率限制**：单个 VIN 每分钟 ≤10 条命令；单个 App 用户每小时 ≤100 条命令；超出立即拒绝；
- **审计日志**：所有命令与 DTC 推送均落审计库，保留 7 年；
- **灾备**：TSP 主从双活，跨可用区部署；TBOX 离线模式可保留 30 天 DTC。

## 6.11 自检题答案

1. MQTT over TLS 是长连接+发布订阅模型，TBOX 一条 TCP 长连接即可同时上下行，节省车端无线模块电耗与连接次数；REST 每次都需要重新建立 TLS 会话，握手延迟高。但 REST 优势是 API 语义清晰、调试简单、跨平台好实现。生产中常见组合：车端上行用 MQTT（高频小包），App 端用 REST（低频大包）。
2. 因为 TSP 鉴权只能保证"调用方是合法 App"，无法保证"驾驶员本人在车旁"。如果攻击者拿到合法 token，可能在驾驶员不在车边时远程执行"解锁车门""鸣笛"等高危命令。让车端在收到命令后必须经车内 IVI/HMI 让驾驶员二次确认，可把"远程控制"与"物理在场"绑定。
3. OTA 与诊断共享：双向 TLS、设备证书、命令鉴权、JWT、速率限制、审计日志、设备指纹与 VIN 绑定。OTA 额外加的：A/B 双 bank、差分升级、版本回滚、签名验签 + 安全启动链。

## 6.12 参考来源

- 3GPP TS 37.900 Cellular V2X 与车联网协议
- GB 44495 智能网联汽车 软件更新通用技术要求
- UN R156 软件更新管理体系
- MQTT 5.0 协议规范