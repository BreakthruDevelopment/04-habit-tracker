# Infrastructure

Deployment lives in [BreakthruDevelopment/30-apps-infra](https://github.com/BreakthruDevelopment/30-apps-infra), the only
repo the clouds trust. This app repo publishes a container image on every push to `main` (see
`.github/workflows/publish.yml`); the infra repo deploys a specific tag to the app's cloud.

| Cloud | Runs the container on | Database |
| --- | --- | --- |
| AWS | Lambda (via the Lambda Web Adapter baked into the image) behind API Gateway | RDS Postgres |
| Azure | Container Apps | Flexible Server Postgres |
| Google Cloud | Cloud Run | Postgres on a private e2-micro VM |
| Oracle Cloud | Docker on the Always Free Ampere VM, behind Caddy | Postgres on the same VM |
