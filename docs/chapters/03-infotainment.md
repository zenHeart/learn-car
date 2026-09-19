# 第 3 章 车机系统（IVI）分层与冷启动

> 能力目标：infotainment — 从 Bootloader、Hypervisor、QNX/Linux/Android Automotive OS 到应用框架，串通一次冷启动过程并指出语音/导航/媒体各自运行在哪一层。

## 3.1 车机系统全景

车机（In-Vehicle Infotainment，IVI）= 屏幕 + 操作系统 + 应用 + 通信。2026 年主流车机的典型硬件是高通 SA8155/SA8295 等高算力 SoC，配备 8–16 GB LPDDR5、128–256 GB UFS、2–4 路 MIPI DSI 显示屏、多路 MIPI CSI 摄像头、12 V/24 V 电源管理与车规级 PMIC。

软件栈从下到上分五层：

1. **Bootloader 层**：SBL（Secondary Boot Loader）+ ABL（Application Boot Loader），负责从 eMMC/UFS 加载下一阶段镜像、做 Secure Boot 验签。
2. **Hypervisor 层**：QNX Hypervisor、ACRN 或 openHypervisor，在同一颗 SoC 上跑两个或多个 Guest OS。
3. **Guest OS 层**：仪表盘用 QNX Neutrino（实时 + 功能安全），座舱主屏用 Android Automotive（应用生态）。
4. **中间件层**：Audio Server（FIFO/PulseAudio）、Bluetooth/Wi-Fi 栈、HAL/AIDL 接口。
5. **应用框架层**：Android Automotive 的 Car API、CarPropertyManager、CarHvacManager、Cockpit HMI 框架。

## 3.2 冷启动链路

按下车辆电源或长按启动键，冷启动链路按时间顺序如下：

- **T+0 ms**：PMIC 上电，时钟稳定，MCU 复位向量跳转到 ROM Boot。
- **T+50 ms**：PBL（Primary Boot Loader）从 eMMC 读 XBL（eXtended Boot Loader）到 RAM，跑 Secure Boot 验签。
- **T+200 ms**：ABL 加载 QNX IFS（Image File System）和 Android boot.img，初始化 TrustZone 与安全监控（QSEE/TEE）。
- **T+500 ms**：Hypervisor 启动，把 QNX 与 Android Automotive 调度到不同 vCPU，启动硬件虚拟化（IOMMU、SMMU）。
- **T+1500 ms**：QNX Guest OS 完成内核初始化，加载仪表 HMI（Cluster Service）并显示启动 Logo（黑屏转 Logo）。
- **T+2500 ms**：Android Automotive 完成 init、Zygote、SystemServer 启动，加载 CarService、SystemUI、HVAC 控制 UI。
- **T+4000 ms**：HVAC 与方向盘按键响应、仪表盘渲染第一帧车速/RPM。
- **T+6000 ms**：HMI 主屏（地图、媒体、设置）首次渲染。
- **T+8000 ms**：导航与语音助手完全可用（引擎声、提示音、语音热词唤醒）。

行业硬约束是 T+8 s 内必须出 HMI，否则被判为启动失败。

## 3.3 语音/导航/媒体各自住在哪一层

- **仪表盘**：QNX Guest OS，运行 QML/C++ 写的 Cluster UI，由 CAN/LIN 网关送来的车速、转速、燃油/电量直接绑定到 QML 数据模型。
- **主屏 HMI**：Android Automotive，运行 Java/Kotlin 写的 SystemUI + 应用。
- **导航**：Android Automotive 应用层，但底层引擎（地图渲染、路径规划）通常跑在 QNX 或 RTOS 核上以保证安全。导航 HUD 投影到仪表盘时通过 QNX Display Sharing 把 Android 的 Surface 镜像到 QNX Cluster。
- **媒体**：Android Automotive 的 MediaSession + CarMediaService；底层音频由 Android AudioFlinger 路由到 DSP。
- **语音助手**：通常由独立 ASR/TTS 域提供（云端 + 车端唤醒融合），车端始终跑一个 low-power 唤醒词引擎（KWS）由 DSP/低功耗核承担。

## 3.4 常见失效与定位

- **黑屏**：从 PMIC → SBL → Hypervisor → QNX → HMI 全链路排查。常用方法：UART 抓 log、检查 Secure Boot 错误码、用 JTAG 跑最小内核。
- **SOC 异常重启**：看 ramoops（Android 的 pstore）抓上一次内核 panic 日志；查是否有看门狗未喂。
- **语音无响应**：先看 KWS 引擎是否在 DSP 侧启动，再看云端 ASR 是否握手成功；最后看 TTS 是否被 AudioFlinger 抢占。

## 3.5 自检题

1. 为什么仪表盘普遍跑 QNX 而座舱跑 Android Automotive？
2. 冷启动 8s 出 HMI 的硬约束对中间件启动顺序有什么影响？
3. 语音热词唤醒（KWS）为什么要跑在低功耗 DSP 而不是 SoC 主核？

## 3.5 HMI 渲染与动画性能

车机主屏帧率必须稳定 60 FPS（部分高端车 120 FPS），否则会被驾驶员察觉卡顿。Android Automotive 上的优化手段包括：

- **SurfaceFlinger 多图层合成**：导航、媒体、HVAC 各自独立 Surface，避免一方动画阻塞全局重绘；
- **Vulkan/OpenGL ES 后端**：用 GPU 加速代替 CPU 软渲染；
- **Choreographer 帧调度**：UI 线程 vs 渲染线程同步，确保 16.6 ms 一帧；
- **Activity 启动优化**：冷启动时禁用自动初始化第三方 SDK，仅在用户进入对应应用时再加载。

仪表盘 QNX 端用 QML + Scene Graph，UI 元素直接绑 CAN 信号；QML 的 property binding 在收到新 CAN 信号时自动重绘，无需手动 invalidate。

## 3.6 车机常见 Bug 现场排查

排查车机 bug 时，常用工具有：

- `adb logcat -b all`：看 Android Automotive 全缓冲日志；
- `qnx sloginfo`：QNX 系统日志，输出到 slog 二进制文件；
- `tracing/perfetto`：CPU 调度与系统调用追踪；
- `tcpdump + canutils candump`：抓 CAN 与车内以太网帧；
- `dumpsys media.audio_policy`：排查音频焦点问题；
- `pstore/ramoops`：内核 panic 后保留的最后日志。

L1 阶段先学会用 logcat + sloginfo 看基础错误信息；后续再去研究 perfetto trace 与系统调用追踪。

## 3.7 自检题答案

1. 仪表盘是 ASIL B 安全实时域（不允许黑屏、不允许重启），需要高实时与功能安全等级的 OS；座舱主屏需要丰富应用生态，Android Automotive 提供完整 Java/Kotlin 应用框架。两者用 Hypervisor 隔离在同一 SoC 上是兼顾安全与生态的事实最优解。
2. 8 s 出 HMI 意味着 Bootloader → Hypervisor → QNX 启动 → Android Automotive init → SystemServer → HMI 首帧 这条链路中任何一步都需要时间预算。常见策略是 QNX 先行接管仪表盘（1.5 s 内出 Logo），Android Automotive 在后台并行 init，6–8 s 出 HMI。
3. KWS 引擎需要常驻监听唤醒词（"你好小 X"），如果放在 SoC 主核，整车熄火后会持续耗电（数百毫安级），长期放置会拖垮 12 V 蓄电池；放在低功耗 DSP 或独立 MCU，功耗可压到 1–5 mA，熄火数周仍可保持唤醒能力。

## 3.8 车机 OTA 升级链路

车机的 OTA 升级由 TBOX 拉取 TSP 上的新镜像包，签名验签后通过车内以太网或 CAN 注入到 IVI 主机，再走 ABL 的 A/B 双 bank 切换机制完成升级。整个流程必须在 30 分钟内完成，并且升级失败时自动回滚到旧版本，避免车辆变砖。

## 3.9 学习路线

后续深入车机可沿三条路径展开：一是 Hypervisor 配置（QNX Hypervisor 资源隔离）；二是 Android Automotive 的 CarPropertyManager 与 CarHvacManager 实战；三是 Android Automotive 与 Android Auto 的边界与互操作（投影协议）。

## 3.10 参考来源

- QNX Neutrino RTOS 官方文档
- Android Automotive 架构与 Car API（source.android.com/docs/automotive）
- 高通 SA8155/SA8295 平台 BSP 公开文档
- Android Perfetto Trace 文档