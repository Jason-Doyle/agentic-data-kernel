# Azure Container Apps with Bicep

This module deploys the API, worker, runtime-role bootstrap job, and migration
job into an existing Azure Container Apps environment.

`namePrefix` must contain 2 to 21 lowercase alphanumeric or hyphen characters,
start with a letter, and end with an alphanumeric character.

## Required Azure resources

- an Azure Container Apps managed environment with VNet access to PostgreSQL;
- a Premium Azure Files NFS share linked to the environment under
  `artifactStorageName`;
- Azure Database for PostgreSQL Flexible Server 18 with `vector` and
  `pgcrypto` allowed;
- a runtime user-assigned identity that can read only `DATABASE_URL`,
  `AUTH_PEPPER`, `ARTIFACT_KEYRING`, `EMBEDDING_API_KEY`, and the optional
  database CA secret;
- a separate administrative job identity that can read only
  `MIGRATION_DATABASE_URL`, `APP_DATABASE_PASSWORD`, and the optional database
  CA secret;
- Key Vault secrets matching the deployment contract;
- private DNS and routing between Container Apps and PostgreSQL.

Azure Files SMB and Blob FUSE are not supported because they do not provide
the required POSIX hard-link semantics. The NFS share and Container Apps
environment must use private VNet connectivity.

## Deploy

Copy the disabled example parameter file, then uncomment and replace every
example, including the immutable `image` release:

```powershell
Copy-Item .\deploy\azure\main.example.bicepparam `
  .\deploy\azure\main.bicepparam

$resourceGroup = Read-Host "Existing resource group"
$namePrefix = Read-Host "Lowercase workload prefix"
.\deploy\azure\deploy.ps1 `
  -ResourceGroup $resourceGroup `
  -NamePrefix $namePrefix
```

The wrapper validates Azure Container Apps naming constraints before invoking
Bicep.

The first deployment keeps API and worker minimum replicas at zero and omits
API ingress. Run each job and wait for success before continuing:

```powershell
function Invoke-AgenticContainerJob {
  param(
    [string]$ResourceGroup,
    [string]$Name
  )

  $execution = az containerapp job start `
    --resource-group $ResourceGroup `
    --name $Name `
    --query name `
    --output tsv
  if ($LASTEXITCODE -ne 0 -or -not $execution) {
    throw "Failed to start $Name"
  }

  do {
    Start-Sleep -Seconds 5
    $status = az containerapp job execution show `
      --resource-group $ResourceGroup `
      --name $Name `
      --job-execution-name $execution `
      --query properties.status `
      --output tsv
    if ($LASTEXITCODE -ne 0) {
      throw "Failed to read $Name execution $execution"
    }
  } while ($status -in @("Running", "Processing"))

  if ($status -ne "Succeeded") {
    throw "$Name execution $execution ended as $status"
  }
}

Invoke-AgenticContainerJob $resourceGroup "$namePrefix-bootstrap"
Invoke-AgenticContainerJob $resourceGroup "$namePrefix-migrate"
```

Then redeploy with `startWorkloads = true`, which starts the workloads and
enables API ingress.

Use the same two-phase sequence for every image upgrade:

1. deploy the new immutable `image` with `startWorkloads = false`;
2. run bootstrap and migration to successful completion;
3. redeploy unchanged inputs with `startWorkloads = true`.

Do not update the image while leaving `startWorkloads = true`.

The worker is intentionally fixed at one replica in this bounded
single-primary reference profile.

Reference the PostgreSQL CA bundle through `databaseCaSecretUrl` when it is not
already present in the container's system trust store.

Container Apps terminates TLS for its managed public hostname. Use an internal
environment plus Application Gateway or Front Door when organizational policy
requires private ingress, WAF, or centralized custom-domain TLS.

To expose remote MCP for Microsoft Agent Framework or Azure SRE Agent, set
`mcpHttpEnabled = true` and set `mcpHttpPublicHostname` to the exact public DNS
hostname. The template constructs the HTTPS origin and rejects schemes, ports,
paths, queries, and credentials. Keep `mcpHttpWriteEnabled = false` for
investigation-only connectors.
