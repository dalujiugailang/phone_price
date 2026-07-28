CREATE TABLE IF NOT EXISTS warehouse_config (
  config_key VARCHAR PRIMARY KEY,
  config_value VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS warehouse_refresh_log (
  refreshed_at TIMESTAMP NOT NULL,
  new_price_source VARCHAR NOT NULL,
  new_price_row_count BIGINT NOT NULL,
  market_row_count BIGINT NOT NULL,
  weekly_sales_row_count BIGINT NOT NULL,
  used_s_price_row_count BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS dim_brand (
  brand_key VARCHAR PRIMARY KEY,
  brand_name VARCHAR NOT NULL,
  brand_group_name VARCHAR NOT NULL,
  market_entity_name VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS dim_product (
  product_key VARCHAR PRIMARY KEY,
  brand_key VARCHAR NOT NULL,
  brand_name VARCHAR NOT NULL,
  product_name VARCHAR NOT NULL,
  series_name VARCHAR,
  model_name VARCHAR,
  model_position VARCHAR,
  series_position VARCHAR,
  product_grain VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS dim_sku (
  sku_key VARCHAR PRIMARY KEY,
  product_key VARCHAR NOT NULL,
  brand_key VARCHAR NOT NULL,
  brand_name VARCHAR NOT NULL,
  model_name VARCHAR NOT NULL,
  storage VARCHAR NOT NULL,
  ppv VARCHAR,
  launch_price DOUBLE
);

CREATE TABLE IF NOT EXISTS dim_grade (
  grade_key VARCHAR PRIMARY KEY,
  grade_name VARCHAR NOT NULL,
  is_s_grade BOOLEAN NOT NULL
);

INSERT OR REPLACE INTO dim_grade VALUES ('S', 'S', TRUE);

CREATE TABLE IF NOT EXISTS bridge_ppv_sku_mapping (
  ppv VARCHAR NOT NULL,
  sku_key VARCHAR NOT NULL,
  mapping_status VARCHAR NOT NULL,
  candidate_count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS fact_new_sku_price_daily (
  price_date DATE NOT NULL,
  date_label VARCHAR NOT NULL,
  sku_key VARCHAR NOT NULL,
  product_key VARCHAR NOT NULL,
  brand_name VARCHAR NOT NULL,
  series_name VARCHAR,
  model_name VARCHAR NOT NULL,
  storage VARCHAR NOT NULL,
  model_position VARCHAR,
  ppv VARCHAR,
  launch_price DOUBLE,
  final_price DOUBLE,
  list_price DOUBLE,
  coupon DOUBLE,
  workbook_bi_price DOUBLE,
  is_delisted BOOLEAN NOT NULL DEFAULT FALSE,
  source_name VARCHAR NOT NULL,
  source_loaded_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS fact_brand_market_weekly (
  year INTEGER NOT NULL,
  week_label VARCHAR NOT NULL,
  week_index INTEGER NOT NULL,
  week_start_date DATE NOT NULL,
  week_end_date DATE NOT NULL,
  entity_type VARCHAR NOT NULL,
  entity_name VARCHAR NOT NULL,
  brand_group_name VARCHAR NOT NULL,
  is_core_brand BOOLEAN NOT NULL,
  brand_share_pct DOUBLE,
  total_index DOUBLE,
  market_note VARCHAR,
  event_name VARCHAR,
  source_saved_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS fact_new_product_sales_weekly (
  year INTEGER NOT NULL,
  week_label VARCHAR NOT NULL,
  week_index INTEGER NOT NULL,
  week_start_date DATE NOT NULL,
  week_end_date DATE NOT NULL,
  product_key VARCHAR NOT NULL,
  brand_name VARCHAR NOT NULL,
  standard_model_name VARCHAR NOT NULL,
  series_position VARCHAR,
  price_band VARCHAR,
  launch_date DATE,
  is_visible BOOLEAN NOT NULL,
  sort_order INTEGER NOT NULL,
  cumulative_sales DOUBLE NOT NULL,
  weekly_sales DOUBLE NOT NULL,
  source_updated_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS fact_used_s_grade_price_daily (
  data_date DATE NOT NULL,
  ppv VARCHAR NOT NULL,
  sku_key VARCHAR,
  grade_id VARCHAR,
  grade_name VARCHAR NOT NULL,
  sku_name VARCHAR NOT NULL,
  bi_price DOUBLE,
  bi_base_price DOUBLE,
  final_quote DOUBLE,
  cost_price DOUBLE,
  source_file VARCHAR,
  imported_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS metric_catalog (
  metric_name VARCHAR PRIMARY KEY,
  business_definition VARCHAR NOT NULL,
  formula VARCHAR NOT NULL,
  format VARCHAR NOT NULL
);

INSERT OR REPLACE INTO metric_catalog VALUES
  ('高收价差', '旧机BI出货价高于或低于当前国补后价格试算的金额', 'BI出货价－国补后价格试算', '金额'),
  ('高收风险率', '旧机BI出货价相对于当前国补后价格试算的比例', 'BI出货价÷国补后价格试算', '百分比'),
  ('旧机残值率', '旧机BI出货价相对于新机发售价的比例', 'BI出货价÷新机发售价', '百分比'),
  ('新机残值率', '当前国补后价格试算相对于新机发售价的比例', '国补后价格试算÷新机发售价', '百分比');
