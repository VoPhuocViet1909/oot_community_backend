module.exports = {
  apps: [
    {
      name: 'ott-backend',
      script: 'src/app.js',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
