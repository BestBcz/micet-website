# MiCet Tag 商店上线

现有 VPS 继续运行网站，现有 Practice 后端负责检查并发放 AquaCore 的永久 Tag。Vape、Heart 分别定价。价格留空时该商品只展示。网站订单保存在网站自己的 D1 中，玩家权益由游戏服保存。

## 1. 准备商户配置

在小豆卖家门户确认应用已开通游戏虚拟商品的对应通道，登记 VPS 出口 IP，将应用的通知地址设为 `https://micet.cc.cd/api/payments/xiaodou`。商户公钥上传到门户，保留对应的商户私钥。平台公钥和平台 key ID 用于校验支付结果，轮换期间可以同时配置多个平台公钥。[小豆接入指南](https://xdfair.cn/docs/quickstart/) · [事件通知](https://xdfair.cn/docs/webhook/)

将以下条目合并到 **仓库外保存的现有私有配置文件**。示例中的尖括号需要替换。价格填整数分，100 分等于 1 元。下单时冻结价格，采用平台默认的卖家承担手续费方式。

```dotenv
MICET_SELF_HOSTED=1
MICET_SITE_ORIGIN=https://micet.cc.cd
MICET_BRIDGE_SECRET=<现有网站和游戏服共用的密钥>
XD_BASE_URL=<应用凭证页给出的 HTTPS API 接入地址>
XD_APP_ID=<应用 ID>
XD_KEY_ID=<商户签名密钥 ID>
XD_PRIVATE_KEY='<PKCS8 商户私钥 PEM，可用单行 Base64 正文>'
XD_PLATFORM_KEYS='{"<平台密钥 ID>":"<平台 SPKI 公钥的单行 Base64 正文>"}'
# 选填；留空时使用小豆签名下单响应中的 HTTPS 收银地址。
# 如需限定域名，填已确认的 https://域名，末尾不加斜杠。
XD_CASHIER_ORIGIN=
XD_CHANNELS=ALIPAY_H5,WECHAT_H5
MICET_PRICE_VAPE_FEN=
MICET_PRICE_HEART_FEN=
```

`XD_CHANNELS` 只填写账户实际开通的通道。要暂停新单，可清空渠道后重启，保留密钥和回调以继续处理已有订单。公网自托管使用 `MICET_SELF_HOSTED=1`，清除旧的 `MICET_PUBLIC_LAUNCH` 和 `MICET_LOCAL_TEST` 启动参数。平台私钥材料仅放在 VPS 的私有文件中，浏览器、插件和 Git 仓库都只需各自已有的配置。

## 2. 更新网站和游戏服

沿用已运行项目的目录、Node 版本（推荐 24）及 D1 路径。保留现有 `.wrangler/state` 和仓库外配置。在已有依赖的 1.5 GB VPS 上，可以增量安装此次增加的二维码依赖。停止原网站进程后，上传源码和锁文件，在项目根目录执行：

```sh
npm install --include=dev --prefer-offline --no-audit --no-fund --maxsockets=1
npm run build
```

已有账号绑定功能的数据库通常已执行 `0000` 和 `0001`。对同一个数据库执行一次新增迁移；全新数据库按 `drizzle` 中的 0000、0001、0002 顺序执行。若不确定迁移进度，先用同一命令的 `--command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"` 替换 `--file ...` 查看现有表。

```sh
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0002_xiaodou_shop.sql
```

将以下命令中的配置来源路径替换为上一步的私有文件。每次重新构建后重新安装私有配置；若网站已有 systemd 服务，使用原服务启动相同的 `npm start` 命令。

```sh
install -m 600 /path/to/private/micet.dev.vars dist/server/.dev.vars
npm start -- --port 8787
```

在 Practice 服停服更新时，将插件替换为 MicetSiteBridge 0.4.0，并沿用已能绑定账号的 `self-hosted`、`site-url` 和 `bridge-secret` 配置。它使用已安装的 AquaCore 和 MicetPvP。正式价格可在网站和游戏插件均已更新后填写并重启网站。

## 3. Tunnel 和首单

保留现有网站及桥接规则。Tunnel 的网站目标为 `http://127.0.0.1:8787`，主机名路径字段留空。若现有 WAF 对路径或方法做了限制，追加以下入口。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/micet/shop`、`/api/micet/orders`、`/api/payments/return` | 商品、当前玩家的订单、从收银台返回订单页 |
| POST | `/api/micet/checkout` | 绑定后的玩家下单 |
| POST | `/api/payments/xiaodou` | 小豆服务端回调，允许直接到源站，对该路径免浏览器挑战及登录拦截 |

`/api/payments/reconcile` 只供网站启动进程在 VPS 本机调用，公网规则可拦截这个路径。实际买家地址由 Tunnel 随请求提供，请保留 `CF-Connecting-IP`。应用通过平台签名验证回调，再按商户单号和金额入账。

打开 `https://micet.cc.cd/#shop`，用已绑定且未持有目标 Tag 的玩家购买。桌面显示二维码，手机可点「打开收银台」。在小豆后台用网站显示的商户订单号核对金额。付款后可关掉浏览器，网站进程每分钟检查到期的待核订单；玩家进入 Practice 后桥接插件会重试发放，在「我的订单」中可以查看到账状态。在游戏中打开 Tag 菜单确认实际权益。

## 对账和退款

从「我的订单」复制商户订单号，在小豆后台对账。支付失败或关闭后平台迟到确认收款，网站仍可处理。同一 Tag 出现两笔不同的已付款订单时，重复款会进入人工处理。提交退款使用商户已有的平台流程，网站接收退款结果。足额退款若早于首次领取任务，会取消发货。部分退款、已发货退款或可能已发放的退款进入人工核查，由服主管理退款和玩家权益；自动流程不会扣除已拥有的 Tag。

如网站中断较久，恢复后检查订单和平台日对账单，尤其核对已发货后的退款。平台重试耗尽的退款通知需凭订单号向平台申请补推。[小豆退款与对账](https://xdfair.cn/docs/refund-reconciliation/)
