const projectRoot = __dirname;

module.exports = {
  apps: [
    {
      name: "ai-detective-backend",
      cwd: projectRoot,
      script: "npm",
      args: "run start --workspace ai-detective-backend-ts",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
