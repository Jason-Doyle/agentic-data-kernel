variable "aws_region" {
  description = "AWS region containing the existing ECS and data resources."
  type        = string
}

variable "name_prefix" {
  description = "Prefix for ECS and CloudWatch resources."
  type        = string
  default     = "agentic-data"
}

variable "image" {
  description = "Immutable Agentic Data Kernel image tag or digest."
  type        = string
}

variable "ecs_cluster_arn" {
  description = "Existing ECS cluster ARN."
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnets used by Fargate tasks."
  type        = list(string)

  validation {
    condition     = length(var.private_subnet_ids) >= 2
    error_message = "At least two private subnets are required."
  }
}

variable "task_security_group_ids" {
  description = "Security groups allowing ALB ingress, PostgreSQL, EFS, and HTTPS egress."
  type        = list(string)
}

variable "target_group_arn" {
  description = "Existing ALB target group ARN using IP targets and readiness health checks."
  type        = string
}

variable "efs_file_system_id" {
  description = "Existing encrypted EFS filesystem ID."
  type        = string
}

variable "efs_access_point_id" {
  description = "EFS access point enforcing UID and GID 10001."
  type        = string
}

variable "execution_role_arn" {
  description = "ECS task execution role with image, logs, and secret-read permissions."
  type        = string
}

variable "task_role_arn" {
  description = "ECS task role allowed to mount the EFS access point."
  type        = string
}

variable "secret_arns" {
  description = "Secrets Manager valueFrom ARNs, optionally including JSON key selectors."
  type = object({
    database_url           = string
    migration_database_url = string
    app_database_password  = string
    database_ca_cert       = optional(string)
    auth_pepper            = string
    artifact_keyring       = string
    embedding_api_key      = string
  })
}

variable "embedding_base_url" {
  description = "OpenAI-compatible embedding endpoint."
  type        = string
}

variable "embedding_model" {
  type    = string
  default = "text-embedding-3-small"
}

variable "embedding_version" {
  type    = string
  default = "openai-compatible-v1"
}

variable "embedding_dimensions" {
  type    = number
  default = 1536

  validation {
    condition = (
      var.embedding_dimensions >= 1 &&
      var.embedding_dimensions <= 2000
    )
    error_message = "embedding_dimensions must be from 1 through 2000."
  }
}

variable "artifact_current_key_id" {
  description = "Current key ID present in ARTIFACT_KEYRING."
  type        = string
  default     = "v1"
}

variable "effect_allowed_hosts" {
  description = "Comma-separated HTTPS hosts allowed for effects."
  type        = string
  default     = ""
}

variable "mcp_http_enabled" {
  description = "Expose authenticated Streamable HTTP MCP at /mcp."
  type        = bool
  default     = false
}

variable "mcp_http_public_origin" {
  description = "Exact public HTTPS origin used for remote MCP Host and Origin validation."
  type        = string
  default     = ""

  validation {
    condition = (
      var.mcp_http_public_origin == "" ||
      can(regex(
        "^https://([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\\.([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*(:([1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5]))?/?$",
        var.mcp_http_public_origin
      ))
    )
    error_message = "mcp_http_public_origin must be an HTTPS DNS origin with an optional port from 1 through 65535."
  }

  validation {
    condition     = !var.mcp_http_enabled || var.mcp_http_public_origin != ""
    error_message = "mcp_http_public_origin is required when mcp_http_enabled is true."
  }
}

variable "mcp_http_write_enabled" {
  description = "Expose execute_operation through remote MCP. Keep false for read-only agents."
  type        = bool
  default     = false

  validation {
    condition     = !var.mcp_http_write_enabled || var.mcp_http_enabled
    error_message = "mcp_http_write_enabled requires mcp_http_enabled."
  }
}

variable "services_enabled" {
  description = "Set true only after bootstrap and migration tasks succeed."
  type        = bool
  default     = false
}

variable "api_desired_count" {
  type    = number
  default = 1
}

variable "worker_desired_count" {
  type    = number
  default = 1
}

variable "api_cpu" {
  description = "Fargate CPU units for the API task."
  type        = number
  default     = 512
}

variable "api_memory" {
  description = "Fargate memory in MiB for the API task."
  type        = number
  default     = 1024
}

variable "worker_cpu" {
  description = "Fargate CPU units for the worker task."
  type        = number
  default     = 512
}

variable "worker_memory" {
  description = "Fargate memory in MiB for the worker task."
  type        = number
  default     = 1024
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "tags" {
  type    = map(string)
  default = {}
}
