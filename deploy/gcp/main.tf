data "google_client_config" "current" {}

data "google_container_cluster" "target" {
  project  = var.project_id
  location = var.location
  name     = var.cluster_name
}

provider "google" {
  project = var.project_id
}

provider "helm" {
  kubernetes {
    host                   = "https://${data.google_container_cluster.target.endpoint}"
    token                  = data.google_client_config.current.access_token
    cluster_ca_certificate = base64decode(data.google_container_cluster.target.master_auth[0].cluster_ca_certificate)
  }
}

locals {
  ingress_tls = var.ingress_tls_secret_name == "" ? [] : [
    {
      secretName = var.ingress_tls_secret_name
      hosts      = [var.ingress_host]
    }
  ]
  chart_values = {
    image = {
      repository = var.image_repository
      tag        = var.image_tag
      digest     = var.image_digest
    }
    secretRef = {
      runtimeName = var.runtime_kubernetes_secret_name
      adminName   = var.admin_kubernetes_secret_name
    }
    serviceAccount = {
      create = true
      name   = var.service_account_name
      annotations = merge(
        var.service_account_annotations,
        {
          "iam.gke.io/gcp-service-account" = var.gcp_service_account_email
        }
      )
      automountServiceAccountToken = true
    }
    jobs = {
      serviceAccountName           = var.job_service_account_name
      automountServiceAccountToken = true
    }
    config = {
      databaseSsl          = "disable"
      artifactCurrentKeyId = var.artifact_current_key_id
      embeddingBaseUrl     = var.embedding_base_url
      embeddingModel       = var.embedding_model
      embeddingVersion     = var.embedding_version
      embeddingDimensions  = tostring(var.embedding_dimensions)
      effectAllowedHosts   = var.effect_allowed_hosts
      trustedProxyHops     = "2"
      mcpHttpEnabled       = tostring(var.mcp_http_enabled)
      mcpHttpPublicOrigin  = var.mcp_http_public_origin
      mcpHttpWriteEnabled  = tostring(var.mcp_http_write_enabled)
    }
    databaseProxy = {
      enabled = true
      image   = var.database_proxy_image
      port    = 5432
      args = [
        "--private-ip",
        "--structured-logs",
        "--address=127.0.0.1",
        "--port=5432",
        var.cloud_sql_instance_connection_name
      ]
    }
    persistence = {
      enabled       = true
      existingClaim = var.artifact_pvc_name
    }
    service = {
      annotations = {
        "cloud.google.com/neg" = jsonencode({
          ingress = true
        })
      }
    }
    api = {
      replicaCount = var.api_replica_count
    }
    worker = {
      replicaCount = var.worker_replica_count
    }
    ingress = {
      enabled     = var.ingress_enabled
      className   = var.ingress_class_name
      annotations = var.ingress_annotations
      hosts = [
        {
          host = var.ingress_host
          paths = [
            {
              path     = "/"
              pathType = "Prefix"
            }
          ]
        }
      ]
      tls               = local.ingress_tls
      tlsOnlyAnnotation = "kubernetes.io/ingress.allow-http"
      tlsOnlyValue      = "false"
    }
  }
}

resource "helm_release" "agentic_data_kernel" {
  name             = var.release_name
  namespace        = var.namespace
  create_namespace = true
  chart            = "${path.module}/../kubernetes/helm/agentic-data-kernel"
  timeout          = 900
  atomic           = true
  cleanup_on_fail  = true
  wait             = true
  wait_for_jobs    = true

  values = [
    yamlencode(local.chart_values)
  ]

  lifecycle {
    precondition {
      condition = (
        !var.ingress_enabled ||
        (
          var.ingress_tls_secret_name != "" &&
          local.chart_values.ingress.tlsOnlyValue == "false"
        )
      )
      error_message = "GCP ingress requires a TLS Secret and HTTP disabled."
    }
    precondition {
      condition = (
        (var.image_tag != "" && var.image_digest == "") ||
        (
          var.image_tag == "" &&
          can(regex("^sha256:[a-f0-9]{64}$", var.image_digest))
        )
      )
      error_message = "Set exactly one of image_tag or a valid sha256 image_digest."
    }
  }
}
