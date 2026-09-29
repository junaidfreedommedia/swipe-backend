module.exports = {
  apps : [
    {
      name: "app",
      script: "npm",
      automation: true,
      args: "run prod",
      env: {
        NODE_ENV: "production",
          NODE_CONFIG_STRICT_MODE: "false"

      },
      env_staging: {
        NODE_ENV: "staging",
          NODE_CONFIG_STRICT_MODE: "false"


      },
    }
  ]
}

  
