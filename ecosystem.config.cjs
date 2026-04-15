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
      },
    },
  ],
};
