# LeoQuant 后端策略引擎（V1）

独立运行的 Node.js 策略引擎：**关掉网页也会持续运行**。

- 轮询币安公开行情（现货 `api.binance.com`，不可用时自动切换 `data-api.binance.vision`；合约 `fapi.binance.com`，不可用时切换 OKX 永续）
- 基于真实历史K线（最多 1500 根）的回测与**开仓前评估**（相似条件胜率、预期收益、止损最大亏损、盈亏比、信号理由）
- **默认模拟盘**：网格 / 马丁策略，支持止盈、止损、移动止盈、杠杆、仓位、「低于 X% 胜率放弃开仓」
- SQLite 持久化：订单、每笔订单开仓前评估存档、运行日志、引擎状态（重启后恢复）
- REST API，H5 页面在「更多 → 后端策略引擎」填写地址和令牌即可切换到后端模式；不填则使用浏览器内模拟
- 可选实盘（ccxt）：交易所 API Key 在服务器端 **AES-256-GCM 加密存储**（主密钥来自环境变量 `MASTER_KEY`），**永不返回前端**；必须设置 `LIVE_TRADING=true` 才会启用

> ⚠️ 胜率/预估为历史回测估算，不代表未来，不保证盈利。实盘可能造成本金全部损失，请自行承担风险。

## 一、部署到海外 VPS（推荐 Docker）

> 币安会对部分地区（例如美国）的服务器 IP 返回 451。请选择币安允许访问的地区（例如新加坡、日本、欧洲）的 VPS。
> 本引擎在币安合约接口不可用时会自动改用 OKX 公共行情，但**实盘下单仍需交易所允许你的服务器所在地区**。

```bash
# 1. 安装 Docker（Ubuntu/Debian）
curl -fsSL https://get.docker.com | sh

# 2. 拉取代码
git clone https://github.com/xinc76599-sys/leochain-site.git
cd leochain-site/server

# 3. 配置
cp .env.example .env
openssl rand -hex 32        # 生成 MASTER_KEY，填入 .env
openssl rand -hex 24        # 生成 API_TOKEN，填入 .env
nano .env

# 4. 启动
docker compose up -d --build
docker compose logs -f      # 看到 "LeoQuant server :8080" 即成功
curl http://127.0.0.1:8080/api/health
```

### HTTPS（必需）
GitHub Pages 是 https 页面，浏览器不允许它调用 http 后端，所以后端需要 https。最简单：用 Caddy 自动签证书。

```bash
# 域名 A 记录指向 VPS 后：
sudo apt install -y caddy
echo 'quant.你的域名.com {
  reverse_proxy 127.0.0.1:8080
}' | sudo tee /etc/caddy/Caddyfile
sudo systemctl restart caddy
```
然后在 H5「更多 → 后端策略引擎」填 `https://quant.你的域名.com` 和 `API_TOKEN`。

### 不用 Docker
```bash
# Node.js 18+（推荐 20）
cd server && npm install --omit=dev
set -a; source .env; set +a
node src/index.js
# 常驻：npm i -g pm2 && pm2 start src/index.js --name leoquant && pm2 save
```

## 二、环境变量

| 变量 | 说明 | 默认 |
|---|---|---|
| `PORT` | 监听端口 | 8080 |
| `API_TOKEN` | 访问令牌，所有接口（除 /api/health）需 `Authorization: Bearer <令牌>`。**未设置时禁止存储密钥和实盘** | 空 |
| `CORS_ORIGIN` | 允许的前端域名 | `*` |
| `MASTER_KEY` | AES-256 主密钥（64位hex，或任意字符串经 SHA-256 派生） | 空（禁止存储密钥） |
| `LIVE_TRADING` | `true` 才允许实盘 | `false` |
| `MAX_LIVE_NOTIONAL` | 实盘单笔最大名义价值 USDT | 50 |
| `LIVE_EXCHANGE` | ccxt 交易所 id | binance |
| `DATA_DIR` | SQLite 目录 | `./data`（Docker 为 `/data`） |
| `INITIAL_BALANCE` | 模拟盘初始资金 | 10000 |
| `TICK_MS` | 引擎轮询间隔 | 4000 |

## 三、API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查（无需令牌） |
| GET | `/api/state` | 账户汇总、策略、持仓、订单、日志 |
| POST | `/api/evaluate` | 回测 + 开仓前评估，body 为策略参数 |
| POST | `/api/strategies` | 启动策略 `{cfg, gate:{gate:true,minWin:55}}` |
| POST | `/api/strategies/:id/stop` | 停止某策略 |
| POST | `/api/stop-all` | 紧急停止全部策略 |
| POST | `/api/close-all` | 按最新价平掉全部持仓 |
| POST | `/api/reset` | 重置模拟账户 `{initial:10000}` |
| GET | `/api/orders` `/api/evaluations` `/api/logs` | 历史记录（`?limit=`） |
| GET | `/api/keys` | 已配置的交易所（仅返回脱敏 `****abcd`） |
| POST | `/api/keys` | 存储密钥 `{exchange, apiKey, secret, password?}`（加密落盘，只写不读） |
| DELETE | `/api/keys/:exchange` | 删除密钥 |

策略参数示例：
```json
{"symbol":"BTCUSDT","market":"spot","type":"grid","interval":"15m","bars":1500,
 "margin":100,"lev":3,"tp":1.5,"sl":3,"trail":0,"gridRange":6,"gridN":6}
```
马丁：`"type":"martingale","martTrigger":1.5,"martStep":1.5,"martMult":1.5,"martMaxAdds":3,"martLookback":20`

## 四、实盘（谨慎）

1. `.env` 设置 `API_TOKEN`、`MASTER_KEY`，确认 `MAX_LIVE_NOTIONAL` 很小。
2. 交易所创建 API Key：**只开交易权限、关闭提现、绑定 VPS IP 白名单**。
3. 存储密钥（只在服务器本机或 https 下操作）：
   ```bash
   curl -X POST https://quant.你的域名.com/api/keys -H "Authorization: Bearer $API_TOKEN" \
     -H 'Content-Type: application/json' -d '{"exchange":"binance","apiKey":"...","secret":"..."}'
   ```
4. `LIVE_TRADING=true` 后重启；启动策略时在 `cfg` 中加 `"live":true`（H5 V1 不提供实盘按钮，需通过 API 显式开启）。
5. 每笔实盘单同时记录在模拟账本中；下单/平仓失败会写入日志，**需人工检查交易所实际持仓**。

V1 实盘限制：仅做多；现货不使用杠杆；合约使用 `setLeverage` + 市价单，平仓为 reduceOnly 市价单；未处理部分成交、交易所端止损单与断线重连补单。

## 五、本地自测
```bash
cd server && npm install
PORT=8812 API_TOKEN=test MASTER_KEY=$(openssl rand -hex 32) node src/index.js
curl localhost:8812/api/health
```
