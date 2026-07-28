CREATE OR REPLACE VIEW mart_new_price_trend AS
WITH price_dates AS (
  SELECT DISTINCT price_date, date_label
  FROM fact_new_sku_price_daily
),
sku_dates AS (
  SELECT
    s.sku_key,
    s.product_key,
    s.brand_key,
    s.brand_name,
    p.series_name,
    s.model_name,
    s.storage,
    p.model_position,
    s.ppv,
    s.launch_price,
    d.price_date,
    d.date_label
  FROM dim_sku s
  JOIN dim_product p
    ON p.product_key = s.product_key
  CROSS JOIN price_dates d
),
raw_rows AS (
  SELECT
    sd.*,
    f.final_price AS raw_final_price,
    f.list_price AS raw_list_price,
    f.coupon AS raw_coupon,
    f.is_delisted,
    MAX(CASE WHEN f.final_price > 0 THEN sd.price_date END)
      OVER (
        PARTITION BY sd.sku_key
        ORDER BY sd.price_date
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
      ) AS effective_source_date
  FROM sku_dates sd
  LEFT JOIN fact_new_sku_price_daily f
    ON f.sku_key = sd.sku_key
   AND f.price_date = sd.price_date
)
SELECT
  r.price_date,
  r.date_label,
  r.sku_key,
  r.product_key,
  r.brand_name,
  r.series_name,
  r.model_name,
  r.storage,
  r.model_position,
  r.ppv,
  r.launch_price,
  r.raw_final_price,
  r.raw_list_price,
  r.raw_coupon,
  COALESCE(r.is_delisted, FALSE) AS is_delisted,
  r.effective_source_date,
  effective.final_price AS effective_final_price,
  effective.list_price AS effective_list_price,
  effective.coupon AS effective_coupon,
  r.raw_final_price > 0 AS has_actual_price,
  r.effective_source_date IS NOT NULL AND r.effective_source_date < r.price_date AS is_forward_filled
FROM raw_rows r
LEFT JOIN fact_new_sku_price_daily effective
  ON effective.sku_key = r.sku_key
 AND effective.price_date = r.effective_source_date;

CREATE OR REPLACE VIEW mart_new_price_trend_aggregate AS
WITH bounds AS (
  SELECT MIN(price_date) AS first_date, MAX(price_date) AS latest_date
  FROM mart_new_price_trend
),
eligible AS (
  SELECT
    t.sku_key,
    MIN(t.effective_source_date) AS first_valid_date,
    MAX(CASE WHEN t.price_date = b.latest_date AND t.effective_final_price IS NOT NULL THEN 1 ELSE 0 END) AS latest_valid
  FROM mart_new_price_trend t
  CROSS JOIN bounds b
  GROUP BY t.sku_key
),
scope_skus AS (
  SELECT '全量' AS scope_name, e.sku_key
  FROM eligible e
  WHERE e.latest_valid = 1
  UNION ALL
  SELECT '老样本', e.sku_key
  FROM eligible e
  CROSS JOIN bounds b
  WHERE e.latest_valid = 1
    AND e.first_valid_date = b.first_date
  UNION ALL
  SELECT '5.26新增', e.sku_key
  FROM eligible e
  WHERE e.latest_valid = 1
    AND e.first_valid_date = CAST(
      (SELECT config_value FROM warehouse_config WHERE config_key = 'new_batch_start_date')
      AS DATE
    )
),
sku_changes AS (
  SELECT
    t.*,
    t.effective_final_price -
      COALESCE(
        LAG(t.effective_final_price) OVER (
          PARTITION BY t.sku_key
          ORDER BY t.price_date
        ),
        t.effective_final_price
      ) AS sku_change,
    CASE
      WHEN COALESCE(
        LAG(t.effective_final_price) OVER (
          PARTITION BY t.sku_key
          ORDER BY t.price_date
        ),
        t.effective_final_price
      ) > 0
      THEN (
        t.effective_final_price -
        COALESCE(
          LAG(t.effective_final_price) OVER (
            PARTITION BY t.sku_key
            ORDER BY t.price_date
          ),
          t.effective_final_price
        )
      ) / COALESCE(
        LAG(t.effective_final_price) OVER (
          PARTITION BY t.sku_key
          ORDER BY t.price_date
        ),
        t.effective_final_price
      )
    END AS sku_change_rate
  FROM mart_new_price_trend t
),
dimension_rows AS (
  SELECT
    s.scope_name,
    '品牌' AS dimension_type,
    c.brand_name AS dimension_value,
    c.brand_name,
    c.price_date,
    c.sku_key,
    c.launch_price,
    c.effective_final_price,
    c.sku_change,
    c.sku_change_rate
  FROM sku_changes c
  JOIN scope_skus s USING (sku_key)
  WHERE c.effective_final_price IS NOT NULL
  UNION ALL
  SELECT
    s.scope_name,
    '机型定位',
    COALESCE(NULLIF(c.model_position, ''), '未定位'),
    NULL,
    c.price_date,
    c.sku_key,
    c.launch_price,
    c.effective_final_price,
    c.sku_change,
    c.sku_change_rate
  FROM sku_changes c
  JOIN scope_skus s USING (sku_key)
  WHERE c.effective_final_price IS NOT NULL
  UNION ALL
  SELECT
    s.scope_name,
    '型号系列',
    c.model_name,
    c.brand_name,
    c.price_date,
    c.sku_key,
    c.launch_price,
    c.effective_final_price,
    c.sku_change,
    c.sku_change_rate
  FROM sku_changes c
  JOIN scope_skus s USING (sku_key)
  WHERE c.effective_final_price IS NOT NULL
),
aggregated AS (
  SELECT
    scope_name,
    dimension_type,
    dimension_value,
    MAX(brand_name) AS brand_name,
    price_date,
    COUNT(DISTINCT sku_key) AS sku_count,
    AVG(launch_price) AS avg_launch_price,
    AVG(effective_final_price) AS avg_final_price,
    AVG(sku_change_rate) AS avg_sku_change_rate,
    SUM(CASE WHEN sku_change > 0 THEN 1 ELSE 0 END) AS up_sku_count,
    SUM(CASE WHEN sku_change < 0 THEN 1 ELSE 0 END) AS down_sku_count,
    SUM(CASE WHEN sku_change = 0 THEN 1 ELSE 0 END) AS flat_sku_count
  FROM dimension_rows
  GROUP BY scope_name, dimension_type, dimension_value, price_date
)
SELECT
  *,
  avg_final_price -
    LAG(avg_final_price) OVER (
      PARTITION BY scope_name, dimension_type, dimension_value
      ORDER BY price_date
    ) AS latest_change_amount,
  CASE
    WHEN LAG(avg_final_price) OVER (
      PARTITION BY scope_name, dimension_type, dimension_value
      ORDER BY price_date
    ) > 0
    THEN (
      avg_final_price -
      LAG(avg_final_price) OVER (
        PARTITION BY scope_name, dimension_type, dimension_value
        ORDER BY price_date
      )
    ) / LAG(avg_final_price) OVER (
      PARTITION BY scope_name, dimension_type, dimension_value
      ORDER BY price_date
    )
  END AS latest_change_rate
FROM aggregated;

CREATE OR REPLACE VIEW mart_new_used_risk AS
SELECT
  price.price_date AS new_price_date,
  used.data_date AS bi_data_date,
  price.sku_key,
  price.brand_name,
  price.series_name,
  price.model_name,
  price.storage,
  price.model_position,
  price.ppv,
  used.grade_name,
  price.launch_price,
  price.effective_final_price,
  used.bi_price,
  used.bi_price - price.effective_final_price AS high_collect_gap,
  used.bi_price / NULLIF(price.effective_final_price, 0) AS high_collect_risk_rate,
  used.bi_price / NULLIF(price.launch_price, 0) AS used_residual_rate,
  price.effective_final_price / NULLIF(price.launch_price, 0) AS new_residual_rate
FROM mart_new_price_trend price
LEFT JOIN LATERAL (
  SELECT
    u.data_date,
    u.grade_name,
    u.bi_price
  FROM fact_used_s_grade_price_daily u
  WHERE u.sku_key = price.sku_key
    AND u.data_date <= price.price_date
  ORDER BY u.data_date DESC
  LIMIT 1
) used ON TRUE
WHERE price.effective_final_price IS NOT NULL;

CREATE OR REPLACE VIEW mart_market_sales_trend AS
WITH latest_week AS (
  SELECT year, MAX(week_index) AS max_week_index
  FROM fact_new_product_sales_weekly
  GROUP BY year
)
SELECT
  sales.year,
  sales.week_label,
  sales.week_index,
  sales.week_start_date,
  sales.week_end_date,
  sales.product_key,
  sales.brand_name,
  sales.standard_model_name,
  sales.series_position,
  sales.price_band,
  sales.launch_date,
  sales.is_visible,
  sales.weekly_sales,
  sales.cumulative_sales,
  brand.brand_share_pct,
  total.total_index,
  total.market_note,
  total.event_name,
  sales.week_index = latest.max_week_index - 2 AS is_t_minus_2
FROM fact_new_product_sales_weekly sales
JOIN dim_brand brand_dim
  ON brand_dim.brand_name = sales.brand_name
JOIN latest_week latest
  ON latest.year = sales.year
LEFT JOIN fact_brand_market_weekly brand
  ON brand.year = sales.year
 AND brand.week_index = sales.week_index
 AND brand.entity_type = '品牌'
 AND brand.is_core_brand = TRUE
 AND brand.entity_name = brand_dim.market_entity_name
LEFT JOIN fact_brand_market_weekly total
  ON total.year = sales.year
 AND total.week_index = sales.week_index
 AND total.entity_type = '大盘';

CREATE OR REPLACE VIEW "新机价格走势表" AS
SELECT
  price_date AS "日期",
  brand_name AS "品牌",
  series_name AS "系列",
  model_name AS "型号",
  storage AS "存储",
  model_position AS "机型定位",
  sku_key AS "标准SKU",
  ppv AS "PPV",
  launch_price AS "新机发售价",
  raw_final_price AS "原始国补后价格试算",
  raw_list_price AS "原始挂牌价",
  raw_coupon AS "原始优惠券",
  effective_final_price AS "聚合国补后价格试算",
  effective_list_price AS "聚合挂牌价",
  effective_coupon AS "聚合优惠券",
  is_delisted AS "是否已下架",
  is_forward_filled AS "是否沿用上一有效价格",
  effective_source_date AS "沿用价格来源日期"
FROM mart_new_price_trend;

CREATE OR REPLACE VIEW "新机价格走势聚合表" AS
SELECT
  scope_name AS "样本范围",
  dimension_type AS "聚合维度",
  dimension_value AS "维度值",
  brand_name AS "品牌",
  price_date AS "日期",
  sku_count AS "SKU数",
  avg_launch_price AS "发布均价",
  avg_final_price AS "国补后均价",
  latest_change_amount AS "最新环比金额",
  latest_change_rate AS "最新环比率",
  avg_sku_change_rate AS "SKU环比率均值",
  up_sku_count AS "上涨SKU数",
  down_sku_count AS "下跌SKU数",
  flat_sku_count AS "持平SKU数"
FROM mart_new_price_trend_aggregate;

CREATE OR REPLACE VIEW "新旧机风险表" AS
SELECT
  new_price_date AS "新机价格日期",
  bi_data_date AS "BI数据日期",
  brand_name AS "品牌",
  series_name AS "系列",
  model_name AS "型号",
  storage AS "存储",
  model_position AS "机型定位",
  sku_key AS "标准SKU",
  ppv AS "PPV",
  grade_name AS "旧机等级",
  launch_price AS "新机发售价",
  effective_final_price AS "国补后价格试算",
  bi_price AS "BI出货价",
  high_collect_gap AS "高收价差",
  high_collect_risk_rate AS "高收风险率",
  used_residual_rate AS "旧机残值率",
  new_residual_rate AS "新机残值率"
FROM mart_new_used_risk;

CREATE OR REPLACE VIEW "市场销量趋势表" AS
SELECT
  year AS "年份",
  week_label AS "周次",
  week_start_date AS "周开始日期",
  week_end_date AS "周结束日期",
  brand_name AS "品牌",
  standard_model_name AS "型号或系列",
  series_position AS "系列定位",
  price_band AS "价格带",
  weekly_sales AS "分周销量",
  cumulative_sales AS "累计销量",
  brand_share_pct AS "品牌周度份额",
  total_index AS "大盘指数",
  market_note AS "市场备注",
  event_name AS "市场事件",
  is_t_minus_2 AS "是否T-2周"
FROM mart_market_sales_trend;
