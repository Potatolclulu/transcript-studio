# 上线准备与已知边界

## 当前状态

**2026-10-31 本地更新：语音供应商已按用户要求切换为豆包。** 本地网页完成官方 6 秒音频的真实识别、搜索、四格式导出与分钟结算；详见 [本地验证说明](local-validation.md)。这些改动尚未部署；下面的已部署版本记录仍指旧预览站。YouTube/X 音频获取和完整上传链路仍未完成，不能按原 Supadata 方案宣称支持。

2026 年 10 月 31 日已部署 Cloudflare 预览站：`https://transcript-studio.transcript-studio.workers.dev`。真实转录和收款关闭，没有购买供应商套餐或发出真实付款、邮件。`Transcript Studio` 是临时品牌。

D1 `transcript-studio`、私有 R2 `transcript-studio-private`、任务队列 `transcript-studio-tasks` 和死信队列 `transcript-studio-dead` 已创建。远端数据库迁移已完成，Workers 绑定与每分钟定时任务已部署。当前版本 `a763c53c-b8e5-4ce1-83ed-81a55d9dd8b8` 已承接 100% 流量。

部署控制面返回成功，但当前机器通过终端和浏览器访问 `workers.dev` 都遇到连接重置，尚未完成公网页面和 API 验收。接入正式域名后仍需重新检查。现有账户允许创建资源和部署，没有核实账户当前订阅套餐，也没有升级或扣款。

后续 TLS 诊断：DNS 查询返回了不一致的地址；保留原主机名与证书校验、定向连接 Cloudflare 地址 `104.21.54.254` 时，首页 HTTPS 返回 200，`/api/config` 返回预期生产配置。因此已验证远端首页及 API 可以正常提供 HTTPS，普通浏览器访问路径仍受 DNS/网络差异影响。未关闭 TLS 校验、未修改系统 DNS 或 hosts；上述地址仅用于诊断，不应固定写入用户配置。

已按 Cloudflare 官方 agent setup 指引安装 19 个技能至 `~/.trae-cn/skills/`，并在 TRAE CN 用户 `mcp.json` 中注册 `https://mcp.cloudflare.com/mcp`，保留原有服务及备份。需重启/重新加载 TRAE 后才能加载新 MCP，首次调用需要 OAuth。部署使用现有 Wrangler OAuth，不依赖新 MCP。

## 外部配置

| 服务 | 必需配置 | 验收 |
|---|---|---|
| Cloudflare | 新建独立 D1、私有 R2、任务队列和死信队列；替换 `wrangler.jsonc` 的 D1 ID | 远端迁移、队列消费、每分钟 cron 与定时恢复 |
| 豆包语音 | Secret `DOUBAO_API_KEY`、`DOUBAO_RESOURCE_ID=volc.seedasr.auc`、`TRANSCRIPTION_PROVIDER=doubao`，明确每日预算 | 本地短音频已通过；生产媒体读取、长稿、识别质量与真实费用待验收 |
| 平台音频获取 | 尚需实现 YouTube/X 获取服务和视频转码 | 各平台公开样本成功率、失败提示、登录限制和成本 |
| 媒体探测 | `PROBE_URL`、独立 `PROBE_SECRET`、容器端 `MEDIA_ORIGIN` | 文件格式/音轨/损坏/边界、签名地址可访问，容器内存与时限 |
| R2 直传 | `R2_ACCOUNT_ID`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`、`R2_BUCKET_NAME` | CORS 仅允许正式站域名和 PUT / Content-Type；桶不公开 |
| 媒体读取 | 至少 32 字符 `MEDIA_SIGNING_SECRET` | 限时 Worker 地址的 GET / HEAD / Range 与供应商读取 |
| Resend | `RESEND_API_KEY`、`EMAIL_FROM` | 正式域名 SPF/DKIM/DMARC、登录邮件与完成邮件 |
| Creem | `CREEM_API_KEY`、`CREEM_WEBHOOK_SECRET`、两个 Product ID | 沙箱单次购买、重复回调、金额/环境/商品验证、退款与争议样本 |
| 网站 | `PUBLIC_ORIGIN`、`SUPPORT_EMAIL` | 正式 HTTPS 域名、条款/隐私说明、客服入口 |

密钥使用 Cloudflare Secret 配置；`wrangler secret put NAME` 会立即创建并部署版本，需在准备部署时执行。不能放在前端、Git 或公开文档。生产设置 `APP_ENV=production`、`LOCAL_ASR_TEST_ENABLED=false`，关闭所有开发入口。本地测试 Key 尚未上传。

当前套餐是候选价格：9 美元 / 120 分钟、19 美元 / 300 分钟。Creem 商品必须是 USD 一次性购买，与配置金额一致；浏览器返回付款成功页不充值，仅签名回调充值。

## 部署顺序

1. 创建独立资源，配置生产域名与供应商密钥。配置媒体容器，资源限制建议起步为 512 MB 内存、2 个同时探测，并保留反向代理请求时限。
2. 运行 `npm run verify`。执行 `npx wrangler d1 migrations apply DB --remote` 前确认选中的是本工程新数据库。
3. 在真实转录和收款关闭时执行部署，检查首页、鉴权、存储、队列和定时任务。
4. 用沙箱充值并完成自有文件和公开视频样本。官方 API 能力不等于本站实测通过。
5. 完成供应商数据用途/保存/删除条款核验、正式法律页面、退款经营规则和域名邮箱验收。
6. 明确设置每日预算后才开启 `TRANSCRIPTION_ENABLED=true`；付款验收后才开启 `BILLING_ENABLED=true`。逐平台验收，X 不通过时不要对外宣称开放。

## 并发与状态未知

数据库 `jobs.active` 是实际名额。队列消费者并发仅控制执行，不替代这个计数。初始全站 2，每人 1；队列最多每人 10 个等待/处理任务。

`review` 表示首次请求可能已被上游接受，网站没有拿到可靠结果。不能再次提交生成。24 小时后会变成 `review_refunded`，分钟退回，但仍占名额；这是避免未知上游任务与新任务叠加的保守处理。若两条都未知，全站暂停启动新任务，经营者需核对。

后台尚未提供管理员网页。通过受控 CLI 查看任务元数据、`attempts` 和供应商控制台，用任务 ID 核实；不要输出正文、私有文件地址或密钥。确认上游已终止/失败后，可用参数化维护脚本或 Cloudflare D1 控制台，把对应 `review` / `review_refunded` 任务设置为 `failed`、`active=0`、`updated_at=当前 Unix 秒`，并记录原因。`review` 的 SQL 触发器会退分钟；已退款任务不会重复退。**不明确上游状态时不要释放名额。**

目前没有人工回填迟到转录的管理工具。迟到结果不得重新扣用户分钟；需要人工交付时另行开发有审计的管理入口。上传探测进程意外中断后，用户重新上传；未使用文件由过期清理收回。

## 仍需补齐的生产工作

- 40 个样本、跨至少 3 天的平台获取与质量验收；真实文件可读性、字幕时序和完整性。
- Creem 真实退款/争议事件结构的验收。遇到未匹配回调返回失败并人工核查；不要把单元测试当作支付商合同验收。
- 平台页面目前使用 React 渲染、各自标题和限制入口；SEO 的独立静态预渲染、正式 canonical 与 sitemap 需要选定域名后补齐。
- 自动完成邮件已接入；退信监控、告警接收、独立管理员恢复工具和正式数据删除政策仍待生产配置。
- 没有翻译、说话人识别、X 播放器定位、上传媒体播放器、长久保存或私密链接支持。时间按钮仅 YouTube 打开原视频定位，其他来源选择文字段落。
- 数据删除依赖每分钟 cron 与可用 R2。生产应监测 cron 缺失、删除失败、死信队列和未知任务数；日志目前只记录错误类型与 API 路径。

这些边界不影响本地样例阅读，但正式收费前需要完成相关验收。
