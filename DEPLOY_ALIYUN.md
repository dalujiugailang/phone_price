# 阿里云服务器部署说明

## 适用架构

- 前端：`Vite build` 生成的静态文件
- 后端：`Express + SQLite`
- 对外访问：`Nginx -> Node(8787)`

## 推荐方案

- Docker 服务器：优先使用 `docker compose`
- 普通 Linux 服务器：可使用 `Nginx + PM2`

## 服务器建议

- 系统：`Ubuntu 22.04` 或 `Alibaba Cloud Linux 3`
- Node：`22.5+`
- 进程管理：`PM2`
- 反向代理：`Nginx`

## 首次部署

### 方案 A：Docker Compose

```bash
mkdir -p /www/wwwroot/gtm-price-monitor
cd /www/wwwroot/gtm-price-monitor
```

上传项目后执行：

```bash
docker compose up -d --build
```

说明：

- `Caddy` 会自动申请和续期 HTTPS 证书
- 主数据源会保存在宿主机的 `data/新机售价监控.xlsx`
- 市场趋势数据源会保存在宿主机的 `data/市场总量份额趋势.xlsx`
- 原始数据编辑草稿会保存在宿主机的 `data/raw-editor-draft.sqlite`
- 市场趋势草稿会保存在宿主机的 `data/market-trend.sqlite`
- 域名 `gtmdudu.xyz` 和 `www.gtmdudu.xyz` 必须先指向服务器公网 IP

如果服务器根目录已经有在线更新过的 `新机售价监控.xlsx`，首次升级到数据目录挂载前先执行：

```bash
cd /www/wwwroot/gtm-price-monitor
mkdir -p data backup-before-data-split
cp 新机售价监控.xlsx backup-before-data-split/新机售价监控.$(date +%Y%m%d%H%M%S).xlsx 2>/dev/null || true
cp data/raw-editor-draft.sqlite backup-before-data-split/raw-editor-draft.$(date +%Y%m%d%H%M%S).sqlite 2>/dev/null || true
cp 新机售价监控.xlsx data/新机售价监控.xlsx
```

后续发布代码时不要用本地 `新机售价监控.xlsx` 覆盖服务器的 `data/新机售价监控.xlsx`。

更新发布：

```bash
cd /www/wwwroot/gtm-price-monitor
git pull
docker compose up -d --build
```

查看日志：

```bash
docker compose logs -f
```

### 方案 B：Nginx + PM2

```bash
mkdir -p /www/wwwroot/gtm-price-monitor
cd /www/wwwroot/gtm-price-monitor
npm install
npm run build
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

## Nginx

将 `deploy/nginx.gtm-price-monitor.conf` 放到 Nginx 站点配置目录后启用，然后重载：

```bash
nginx -t
systemctl reload nginx
```

## HTTPS

在 DNS 的 `A` 记录已经指向服务器公网 IP 后，申请证书：

```bash
certbot --nginx -d gtmdudu.xyz -d www.gtmdudu.xyz
```

## 持久化数据

- 主 Excel 数据源：`data/新机售价监控.xlsx`
- 市场趋势 Excel 数据源：`data/市场总量份额趋势.xlsx`
- 原始数据编辑 SQLite：`data/raw-editor-draft.sqlite`
- 市场趋势 SQLite：`data/market-trend.sqlite`
- 这些文件保存在项目目录的 `data/` 下，重启 PM2、Docker 或服务器后依然会保留

## 发布更新

```bash
cd /www/wwwroot/gtm-price-monitor
npm install
npm run build
pm2 restart gtm-price-monitor
```
