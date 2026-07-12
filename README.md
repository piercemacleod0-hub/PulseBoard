# PulseBoard

PulseBoard 是一款面向 Windows 的中文本机资源监控看板。它每 5 秒记录一次系统状态，在本机保存最近 30 天的历史数据，适合跑代码、训练模型、编译和长时间任务监控。

## 功能

- CPU、内存、GPU、显存实时监控
- 磁盘读写与网络流量监控
- 1 小时、6 小时、24 小时、7 天和 30 天历史曲线
- 数据按天保存为 JSONL，完全保留在本机
- 关闭主窗口后在系统托盘继续记录
- 无需 Grafana、Prometheus 或浏览器

## 安装

前往 [Releases](../../releases) 下载最新的安装版或便携版。

## 本地开发

需要 Node.js 20 或更高版本。

```powershell
npm install
npm start
```

生成 Windows 安装包：

```powershell
npm run dist
```

## 数据位置

历史记录默认保存于：

```text
%APPDATA%\PulseBoard\history
```

## 隐私

PulseBoard 不上传任何监控数据，也不需要账号。所有历史记录均保存在本机。

## 许可证

MIT
