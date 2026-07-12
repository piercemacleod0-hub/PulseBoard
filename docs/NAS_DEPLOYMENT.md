# PulseBoard NAS / Linux 部署教程

PulseBoard v2.0 提供无需桌面的 Web 版。后台服务持续采集 NAS 主机资源，电脑、手机和平板通过浏览器查看。

## 支持的设备

- 群晖 Synology Container Manager
- 威联通 QNAP Container Station
- 飞牛 fnOS
- Unraid
- TrueNAS SCALE
- 安装了 Docker 的 Ubuntu、Debian、Rocky Linux 等主机
- CPU 架构：AMD64（x86_64）和 ARM64（aarch64）

## 方法一：Docker Compose

### 1. 创建目录

```bash
mkdir -p pulseboard
cd pulseboard
```

### 2. 下载配置

```bash
curl -O https://raw.githubusercontent.com/piercemacleod0-hub/PulseBoard/main/docker-compose.yml
curl -o .env https://raw.githubusercontent.com/piercemacleod0-hub/PulseBoard/main/.env.example
```

### 3. 设置密码

编辑 `.env`：

```dotenv
PULSEBOARD_PASSWORD=换成你自己的强密码
PULSEBOARD_RETENTION_DAYS=30
TZ=Asia/Shanghai
```

### 4. 启动

```bash
docker compose up -d
```

打开 `http://NAS_IP:8090`，输入刚才设置的密码。

## 群晖 Container Manager

1. 在 File Station 中创建 `docker/pulseboard` 文件夹。
2. 把 `docker-compose.yml` 和改好密码的 `.env` 放入该文件夹。
3. 打开 Container Manager → 项目 → 新增。
4. 选择“通过现有 docker-compose.yml 创建项目”。
5. 项目启动后访问 `http://群晖IP:8090`。

其他支持 Compose 的 NAS 管理界面操作类似。

## NVIDIA GPU

NAS 已安装 NVIDIA 驱动和 NVIDIA Container Toolkit 时，使用额外配置启动：

```bash
docker compose -f docker-compose.yml -f docker-compose.nvidia.yml up -d
```

若 NAS 不带 NVIDIA 显卡，不需要这个文件，其他监控功能不受影响。

## 数据与升级

历史记录位于：

```text
./pulseboard-data
```

更新版本：

```bash
docker compose pull
docker compose up -d
```

只要不删除 `pulseboard-data`，升级和重建容器都不会丢失历史。

## 修改端口

如果 8090 已被占用，修改 `docker-compose.yml`：

```yaml
ports:
  - "你想使用的端口:8090"
```

## 安全建议

- 务必修改默认示例密码。
- 建议只在家庭或公司局域网内开放。
- 如需从公网访问，请通过 NAS 反向代理启用 HTTPS，不建议直接暴露 8090 端口。
- `/proc` 与 `/sys` 仅以只读方式挂载，容器启用了 `no-new-privileges`。

## 停止和卸载

```bash
docker compose down
```

需要彻底清除历史时，再手动删除 `pulseboard-data` 文件夹。
