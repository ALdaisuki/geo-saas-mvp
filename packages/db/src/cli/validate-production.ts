import { loadProductionDeploymentEnv } from "@geo/config";

loadProductionDeploymentEnv();
console.info("Production secret preflight passed");
