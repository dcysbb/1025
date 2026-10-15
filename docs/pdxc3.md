# PDXC3 / PD1V/M 位移台

控制台左侧「位移台」页独立于真空联锁，保留运动与停止操作；连接模式、USB/TCP 方式、控制器序列号、IPv4 地址、端口、XYZ 通道映射、方向反转及单次步数上限集中在「硬件连接」页，并保存到运行数据目录的 `stage.json`。不会修改真空规、DAM 或阀门配置。旧配置默认继续使用 TCP。

CH1、CH2、CH3 必须各映射到一个轴；默认依次为 XYZ。修改映射前先断开位移台。网络地址留空时，通过官方 XA 的 `TLMC_DiscoverEthernetDeviceInfo` 搜索本机活动网段，每个网段最多 1024 个地址，仅查询指定端口（默认 TCP 40303），并按序列号和型号匹配。也可填写明确的 IPv4 地址。程序不自动改网卡设置，不扫描串口。

连接只读取状态，不启用驱动、不回零、不清零、不移动。通道故障、运动状态未知或正在运动时拒绝新移动。PD1V/M 无位置编码器，因此仅提供有限步数的正反向移动，不提供绝对位置或毫米位置显示。驱动使用开环 `TLMC_MoveMode_Relative`，将带符号的脉冲数传入 XA；不使用持续运动命令。脉冲对应的实际位移随驱动参数、负载、方向变化，软件步数上限不是机械限位。

「全部停止」向三个通道分别发送立即停止；一个通道失败也会继续尝试其余通道。通信中断不重发移动指令，也不会自动重新启用驱动。断开或后台退出时，如果曾发送移动或运动状态不确定，会先尝试停止；停止未确认时保留错误供操作员处理。恢复连接后需要重新手动操作，不回放之前的移动。

真实设备须先核对通道的 PD1V/M 及适配线配置。显示「位移台类型不匹配」「输出电源未就绪」表示控制器报告了这些标志，不能据此判断具体接线故障。此时保持连接用于查看状态，禁止移动；用 Thorlabs 软件或设备手册核对配置和连接。模拟模式必须明确选择，界面会持续标注，不会从连接失败自动切换。

## 安装与验证

Python 3.10+；依赖已固定为 `thorlabs-xa==1.8.0.28770`，Windows 打包脚本同时收集其本机库和许可证。普通开发安装：`pip install -r backend/requirements-dev.txt`。不需要安装完整 XA GUI 才能运行本控制台。

后端 API 为 `GET /api/stage`、`PUT /api/stage/config` 和 `POST /api/stage/{connect,disconnect,move,stop}`。写操作沿用操作员权限与 Origin 校验。移动体示例：`{"axis":"x","direction":1,"steps":10}`。模拟测试与通信测试不代表机械运动已验证。

协议依据：Thorlabs XA Native API SDK 的 `TLMC_Startup`、`deviceDiscovery.interval`、`TLMC_DiscoverEthernetDeviceInfo`、`TLMC_Open`、`TLMC_Move`、`TLMC_Stop`；PDXC3 的三个子通道参照[官方 Python 示例](https://github.com/Thorlabs/Motion_Control_Examples/blob/main/Python/XA/PDXC3Subchannel/pdxc3_subchannel_test_script.py)。SDK 来源：[Thorlabs XA Python SDK](https://pypi.org/project/thorlabs-xa/1.8.0.28770/)。
