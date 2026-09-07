# AWS ECS Fargate with OpenTofu

This module deploys Agentic Data Kernel task definitions and services into an
existing AWS landing zone.

## Required AWS resources

- ECS cluster;
- at least two private subnets;
- security groups allowing ALB to API port 4318, tasks to PostgreSQL 5432,
  tasks to EFS 2049, and required HTTPS egress;
- an ALB HTTPS listener and IP target group whose health check uses
  `/health/ready`;
- RDS PostgreSQL 18 with pgvector 0.8+ and pgcrypto;
- encrypted EFS with mount targets and an access point enforcing UID/GID
  `10001`;
- task execution and task IAM roles;
- Secrets Manager values matching the deployment contract.

The execution role must read every supplied secret. The task role must be
allowed to mount the EFS access point with transit encryption.
Private subnets need NAT or the appropriate VPC endpoints to pull the image,
write logs, and read Secrets Manager.

Reference the RDS CA bundle through `secret_arns.database_ca_cert` unless it is
already present in the container's system trust store.

## Deploy

```powershell
Copy-Item .\deploy\aws\terraform.tfvars.example `
  .\deploy\aws\terraform.tfvars

# Uncomment and set every required value, including an immutable image.
tofu -chdir=deploy\aws init
tofu -chdir=deploy\aws apply
```

The initial apply creates services with desired count zero. Run bootstrap and
migration tasks in order:

```powershell
$network = tofu -chdir=deploy\aws output -raw network_configuration_json
$bootstrap = tofu -chdir=deploy\aws output -raw bootstrap_task_definition_arn
$migrate = tofu -chdir=deploy\aws output -raw migrate_task_definition_arn
$clusterArn = Read-Host "Existing ECS cluster ARN"
$network | Set-Content -NoNewline .\agentic-network.json

function Invoke-AgenticEcsTask {
  param([string]$TaskDefinition)

  $taskArn = aws ecs run-task `
    --cluster $clusterArn `
    --launch-type FARGATE `
    --platform-version 1.4.0 `
    --task-definition $TaskDefinition `
    --network-configuration file://agentic-network.json `
    --query "tasks[0].taskArn" `
    --output text
  if ($LASTEXITCODE -ne 0 -or -not $taskArn -or $taskArn -eq "None") {
    throw "Failed to start $TaskDefinition"
  }

  aws ecs wait tasks-stopped `
    --cluster $clusterArn `
    --tasks $taskArn
  if ($LASTEXITCODE -ne 0) {
    throw "Failed while waiting for $taskArn"
  }

  $exitCode = aws ecs describe-tasks `
    --cluster $clusterArn `
    --tasks $taskArn `
    --query "tasks[0].containers[0].exitCode" `
    --output text
  if ($exitCode -ne "0") {
    throw "$TaskDefinition exited with code $exitCode"
  }
}

Invoke-AgenticEcsTask $bootstrap
Invoke-AgenticEcsTask $migrate
```

Then set `services_enabled = true` and apply again.

Use the same two-phase sequence for every image upgrade:

1. apply the new immutable `image` with `services_enabled = false`;
2. run bootstrap and migration to exit code zero;
3. apply unchanged inputs with `services_enabled = true`.

Do not update the image while leaving `services_enabled = true`.

Secrets are referenced by ARN and are not created by this module. Do not pass
secret values through `.tfvars`.

Remote MCP shares the ALB-backed API at `/mcp`. Enable it with
`mcp_http_enabled`, configure the exact HTTPS `mcp_http_public_origin`, and
leave `mcp_http_write_enabled` false unless a narrowly scoped write identity
and review boundary are in place.
