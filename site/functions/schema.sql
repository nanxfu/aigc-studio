-- AIGC Studio 桌面端匿名遥测表结构（Cloudflare D1）
-- 初始化方式（Cloudflare Dashboard → D1 → Console，或本地 wrangler d1 execute）：
--   npx wrangler d1 execute aigc-studio-telemetry --remote --file=site/functions/schema.sql

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  install_id TEXT NOT NULL,
  event TEXT NOT NULL,
  app_version TEXT NOT NULL DEFAULT '',
  os TEXT NOT NULL DEFAULT '',
  lang TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '',
  props TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_event_ts ON events(event, ts);
CREATE INDEX IF NOT EXISTS idx_events_install_ts ON events(install_id, ts);

-- =====================================================================
-- 常用分析 SQL（直接在 Cloudflare D1 Console 粘贴查询）
-- =====================================================================
--
-- 1. 最近 7 天每日活跃安装数（DAU）与启动次数：
-- SELECT
--   date(ts / 1000, 'unixepoch', '+8 hours') AS day,
--   COUNT(DISTINCT install_id) AS dau,
--   COUNT(*) AS launches
-- FROM events
-- WHERE event = 'app_launch' AND ts >= (strftime('%s', 'now', '-7 days') * 1000)
-- GROUP BY day ORDER BY day DESC;
--
-- 2. 近 30 天算力来源（provider）与成功/失败分布：
-- SELECT
--   json_extract(props, '$.provider') AS provider,
--   SUM(CASE WHEN event = 'generate_done' THEN 1 ELSE 0 END) AS ok_count,
--   SUM(CASE WHEN event = 'generate_fail' THEN 1 ELSE 0 END) AS fail_count
-- FROM events
-- WHERE event IN ('generate_done', 'generate_fail')
--   AND ts >= (strftime('%s', 'now', '-30 days') * 1000)
-- GROUP BY provider ORDER BY ok_count DESC;
--
-- 3. 失败错误码 TOP 15（定位新用户卡点）：
-- SELECT
--   json_extract(props, '$.provider') AS provider,
--   json_extract(props, '$.errorCode') AS error_code,
--   COUNT(*) AS hits,
--   COUNT(DISTINCT install_id) AS affected_installs
-- FROM events
-- WHERE event = 'generate_fail' AND ts >= (strftime('%s', 'now', '-30 days') * 1000)
-- GROUP BY provider, error_code ORDER BY hits DESC LIMIT 15;
--
-- 4. 内置模型 / 工具热度排行：
-- SELECT
--   json_extract(props, '$.presetId') AS preset_id,
--   json_extract(props, '$.tool') AS tool,
--   COUNT(*) AS runs
-- FROM events
-- WHERE event = 'generate_done' AND ts >= (strftime('%s', 'now', '-30 days') * 1000)
-- GROUP BY preset_id, tool ORDER BY runs DESC;
--
-- 5. 资产工坊各算子使用次数：
-- SELECT
--   json_extract(props, '$.action') AS action,
--   COUNT(*) AS uses
-- FROM events
-- WHERE event = 'workshop_op' AND ts >= (strftime('%s', 'now', '-30 days') * 1000)
-- GROUP BY action ORDER BY uses DESC;
