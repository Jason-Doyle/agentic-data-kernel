locals {
  artifact_mount_path = "/var/lib/agentic-data/artifacts"
  common_environment = [
    { name = "DATABASE_SSL", value = "require" },
    { name = "DATABASE_POOL_SIZE", value = "10" },
    { name = "DATABASE_STATEMENT_TIMEOUT_MS", value = "30000" },
    { name = "ARTIFACT_CURRENT_KEY_ID", value = var.artifact_current_key_id },
    { name = "ARTIFACT_DIR", value = local.artifact_mount_path },
    { name = "EMBEDDING_BASE_URL", value = var.embedding_base_url },
    { name = "EMBEDDING_MODEL", value = var.embedding_model },
    { name = "EMBEDDING_VERSION", value = var.embedding_version },
    { name = "EMBEDDING_DIMENSIONS", value = tostring(var.embedding_dimensions) },
    { name = "EFFECT_ALLOWED_HOSTS", value = var.effect_allowed_hosts },
    { name = "HOST", value = "0.0.0.0" },
    { name = "PORT", value = "4318" },
    { name = "LOG_LEVEL", value = "info" },
    { name = "TRUSTED_PROXY_HOPS", value = "1" },
    { name = "WORKER_MONITOR_HOST", value = "0.0.0.0" },
    { name = "WORKER_MONITOR_PORT", value = "4319" },
    { name = "SHUTDOWN_TIMEOUT_MS", value = "10000" },
    { name = "MCP_HTTP_ENABLED", value = tostring(var.mcp_http_enabled) },
    { name = "MCP_HTTP_PUBLIC_ORIGIN", value = var.mcp_http_public_origin },
    { name = "MCP_HTTP_WRITE_ENABLED", value = tostring(var.mcp_http_write_enabled) }
  ]
  runtime_secrets = [
    { name = "DATABASE_URL", valueFrom = var.secret_arns.database_url },
    { name = "AUTH_PEPPER", valueFrom = var.secret_arns.auth_pepper },
    { name = "ARTIFACT_KEYRING", valueFrom = var.secret_arns.artifact_keyring },
    { name = "EMBEDDING_API_KEY", valueFrom = var.secret_arns.embedding_api_key }
  ]
  database_ca_secret = var.secret_arns.database_ca_cert == null ? [] : [
    {
      name      = "DATABASE_CA_CERT_BASE64"
      valueFrom = var.secret_arns.database_ca_cert
    }
  ]
  network_configuration = {
    awsvpcConfiguration = {
      subnets        = var.private_subnet_ids
      securityGroups = var.task_security_group_ids
      assignPublicIp = "DISABLED"
    }
  }
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/ecs/${var.name_prefix}/api"
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/ecs/${var.name_prefix}/worker"
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

resource "aws_cloudwatch_log_group" "jobs" {
  name              = "/ecs/${var.name_prefix}/jobs"
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${var.name_prefix}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.api_cpu)
  memory                   = tostring(var.api_memory)
  execution_role_arn       = var.execution_role_arn
  task_role_arn            = var.task_role_arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  volume {
    name = "artifacts"

    efs_volume_configuration {
      file_system_id     = var.efs_file_system_id
      root_directory     = "/"
      transit_encryption = "ENABLED"

      authorization_config {
        access_point_id = var.efs_access_point_id
        iam             = "ENABLED"
      }
    }
  }

  container_definitions = jsonencode([
    {
      name                   = "api"
      image                  = var.image
      essential              = true
      user                   = "10001:10001"
      readonlyRootFilesystem = true
      command                = ["node", "dist/production/cli.js", "serve"]
      environment            = local.common_environment
      secrets                = concat(local.runtime_secrets, local.database_ca_secret)
      portMappings = [
        {
          name          = "http"
          containerPort = 4318
          hostPort      = 4318
          protocol      = "tcp"
          appProtocol   = "http"
        }
      ]
      mountPoints = [
        {
          sourceVolume  = "artifacts"
          containerPath = local.artifact_mount_path
          readOnly      = false
        }
      ]
      healthCheck = {
        command = [
          "CMD-SHELL",
          "node -e \"fetch('http://127.0.0.1:4318/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""
        ]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 30
      }
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.api.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "api"
        }
      }
    }
  ])

  tags = var.tags
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${var.name_prefix}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.worker_cpu)
  memory                   = tostring(var.worker_memory)
  execution_role_arn       = var.execution_role_arn
  task_role_arn            = var.task_role_arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  volume {
    name = "artifacts"

    efs_volume_configuration {
      file_system_id     = var.efs_file_system_id
      root_directory     = "/"
      transit_encryption = "ENABLED"

      authorization_config {
        access_point_id = var.efs_access_point_id
        iam             = "ENABLED"
      }
    }
  }

  container_definitions = jsonencode([
    {
      name                   = "worker"
      image                  = var.image
      essential              = true
      user                   = "10001:10001"
      readonlyRootFilesystem = true
      command                = ["node", "dist/production/cli.js", "worker"]
      environment            = local.common_environment
      secrets                = concat(local.runtime_secrets, local.database_ca_secret)
      mountPoints = [
        {
          sourceVolume  = "artifacts"
          containerPath = local.artifact_mount_path
          readOnly      = false
        }
      ]
      portMappings = [
        {
          name          = "monitor"
          containerPort = 4319
          hostPort      = 4319
          protocol      = "tcp"
          appProtocol   = "http"
        }
      ]
      healthCheck = {
        command = [
          "CMD-SHELL",
          "node -e \"fetch('http://127.0.0.1:4319/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""
        ]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 30
      }
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.worker.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "worker"
        }
      }
    }
  ])

  tags = var.tags
}

resource "aws_ecs_task_definition" "bootstrap" {
  family                   = "${var.name_prefix}-bootstrap"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = var.execution_role_arn
  task_role_arn            = var.task_role_arn

  container_definitions = jsonencode([
    {
      name                   = "bootstrap"
      image                  = var.image
      essential              = true
      user                   = "10001:10001"
      readonlyRootFilesystem = true
      command                = ["node", "dist/production/cli.js", "bootstrap-role"]
      environment = [
        { name = "DATABASE_SSL", value = "require" }
      ]
      secrets = concat([
        {
          name      = "MIGRATION_DATABASE_URL"
          valueFrom = var.secret_arns.migration_database_url
        },
        {
          name      = "APP_DATABASE_PASSWORD"
          valueFrom = var.secret_arns.app_database_password
        }
      ], local.database_ca_secret)
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.jobs.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "bootstrap"
        }
      }
    }
  ])

  tags = var.tags
}

resource "aws_ecs_task_definition" "migrate" {
  family                   = "${var.name_prefix}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = var.execution_role_arn
  task_role_arn            = var.task_role_arn

  container_definitions = jsonencode([
    {
      name                   = "migrate"
      image                  = var.image
      essential              = true
      user                   = "10001:10001"
      readonlyRootFilesystem = true
      command                = ["node", "dist/production/cli.js", "migrate"]
      environment = [
        { name = "DATABASE_SSL", value = "require" },
        { name = "EMBEDDING_MODEL", value = var.embedding_model },
        { name = "EMBEDDING_VERSION", value = var.embedding_version },
        { name = "EMBEDDING_DIMENSIONS", value = tostring(var.embedding_dimensions) }
      ]
      secrets = concat([
        {
          name      = "MIGRATION_DATABASE_URL"
          valueFrom = var.secret_arns.migration_database_url
        }
      ], local.database_ca_secret)
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.jobs.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "migrate"
        }
      }
    }
  ])

  tags = var.tags
}

resource "aws_ecs_service" "api" {
  name                  = "${var.name_prefix}-api"
  cluster               = var.ecs_cluster_arn
  task_definition       = aws_ecs_task_definition.api.arn
  desired_count         = var.services_enabled ? var.api_desired_count : 0
  launch_type           = "FARGATE"
  platform_version      = "1.4.0"
  force_new_deployment  = var.services_enabled
  wait_for_steady_state = true

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = var.task_security_group_ids
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = var.target_group_arn
    container_name   = "api"
    container_port   = 4318
  }

  tags = var.tags
}

resource "aws_ecs_service" "worker" {
  name                  = "${var.name_prefix}-worker"
  cluster               = var.ecs_cluster_arn
  task_definition       = aws_ecs_task_definition.worker.arn
  desired_count         = var.services_enabled ? var.worker_desired_count : 0
  launch_type           = "FARGATE"
  platform_version      = "1.4.0"
  force_new_deployment  = var.services_enabled
  wait_for_steady_state = true

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = var.task_security_group_ids
    assign_public_ip = false
  }

  tags = var.tags
}
