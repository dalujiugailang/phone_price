module.exports = {
  apps: [
    {
      name: 'gtm-price-monitor',
      cwd: '/www/wwwroot/gtm-price-monitor',
      script: 'npm',
      args: 'start',
      env: {
        NODE_ENV: 'production',
        PORT: '8787',
        PRICE_MONITOR_DATA_DIR: '/www/wwwroot/gtm-price-monitor/data',
        PRICE_MONITOR_WORKBOOK_PATH: '/www/wwwroot/gtm-price-monitor/data/新机售价监控.xlsx',
        PRICE_MONITOR_DRAFT_DB_PATH: '/www/wwwroot/gtm-price-monitor/data/raw-editor-draft.sqlite',
        MARKET_TREND_WORKBOOK_PATH: '/www/wwwroot/gtm-price-monitor/data/市场总量份额趋势.xlsx',
        MARKET_TREND_DRAFT_DB_PATH: '/www/wwwroot/gtm-price-monitor/data/market-trend.sqlite',
      },
    },
  ],
};
