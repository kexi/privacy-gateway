# Cloud Run v2 services. Mirrors infra/deploy.sh.
#
# All four are created in one apply. The shell version had to deploy in
# dependency order (gemma -> core -> synthesis -> gateway) and then patch
# A2A_PUBLIC_URL back in, because each URL was only knowable after the service
# existed. Deterministic URLs (locals.tf) remove that ordering constraint, so
# Terraform is free to create them in parallel.

# --- gemma-serving (GPU) ----------------------------------------------------
# Created only when var.gpu_enabled is true, so the rest of the fleet can be
# applied while the Cloud Run L4 quota request is still pending.
#
# google-beta is required here: gpu_zonal_redundancy_disabled and the GPU
# node_selector are not on the GA provider's Cloud Run v2 surface yet.
resource "google_cloud_run_v2_service" "gemma" {
  count = var.gpu_enabled ? 1 : 0

  provider = google-beta

  project  = var.project_id
  location = var.region
  name     = "gemma-serving"

  # Internal ingress keeps the model inside the trust boundary; IAM
  # authentication is required on top of that. Reaching it from a laptop
  # returning 403 is the evidence the boundary holds.
  ingress = "INGRESS_TRAFFIC_INTERNAL_ONLY"

  deletion_protection = false

  template {
    service_account = google_service_account.agents["sa-gemma"].email

    # The default L4 quota is 1. Raise max after a quota increase.
    # min = 0 means an idle fleet costs nothing, which matters at ~$1.42/h.
    scaling {
      min_instance_count = 0
      max_instance_count = 1
    }

    # The model is loaded per instance and kept resident, so a single instance
    # serves a handful of concurrent requests rather than one at a time.
    max_instance_request_concurrency = 4
    timeout                          = "600s"

    # Cloud Run requires the GPU node selector and instance-based billing to
    # agree; gen2 is mandatory for GPU workloads.
    node_selector {
      accelerator = var.gpu_type
    }
    # Dropping zonal redundancy cuts the L4 rate by roughly 36%
    # (0.0002909 -> 0.0001867 USD/GPU-sec). Unit price beats redundancy for a
    # single-instance demo service, and the quota requested
    # (NvidiaL4GpuAllocNoZonalRedundancyPerProjectRegion) is the matching one.
    gpu_zonal_redundancy_disabled = true
    execution_environment         = "EXECUTION_ENVIRONMENT_GEN2"

    containers {
      image = "${local.ar_path}/gemma:${var.image_tag}"

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu              = "8"
          memory           = "32Gi"
          "nvidia.com/gpu" = "1"
        }
        # Keep the CPU running outside requests so the model stays resident in
        # VRAM instead of being reloaded on the next call.
        cpu_idle          = false
        startup_cpu_boost = true
      }

      env {
        name  = "GEMMA_MODEL"
        value = var.gemma_model
      }

      # Baking a ~8.1GB model in means the first start streams a large image.
      # 60s initial delay + 60 failures x 10s allows roughly 10 minutes before
      # Cloud Run gives up.
      startup_probe {
        initial_delay_seconds = 60
        period_seconds        = 10
        failure_threshold     = 60
        timeout_seconds       = 5

        tcp_socket {
          port = 8080
        }
      }
    }
  }

  depends_on = [
    google_project_service.required,
    google_artifact_registry_repository.fleet,
  ]
}

# --- the three CPU agent services -------------------------------------------
resource "google_cloud_run_v2_service" "agents" {
  for_each = local.agent_services

  project  = var.project_id
  location = var.region
  name     = each.key

  # Ingress stays open on all three. Core and Synthesis are private by IAM (no
  # allUsers invoker), not by ingress; the Gateway needs public ingress because
  # it is the entry point. Why not internal-and-cloud-load-balancing on
  # Core/Synthesis: there is no load balancer in front of them, so it would only
  # add a failure mode without changing who can actually invoke them.
  ingress = "INGRESS_TRAFFIC_ALL"

  deletion_protection = false

  template {
    service_account = google_service_account.agents["sa-${replace(each.key, "-agent", "")}"].email

    scaling {
      min_instance_count = 0
      max_instance_count = 3
    }

    max_instance_request_concurrency = 40
    timeout                          = "300s"

    # Direct VPC egress, for the callers of internal-ingress gemma-serving.
    # Cloud Run's default egress does not traverse a VPC, so without this a
    # Cloud Run -> internal-ingress Cloud Run call is rejected with 403.
    # PRIVATE_RANGES_ONLY keeps external destinations (Vertex AI, Firestore) on
    # the normal path.
    # Why not a Serverless VPC Access connector: it bills a connector VM around
    # the clock and takes minutes to provision. Direct VPC egress needs no extra
    # resources.
    dynamic "vpc_access" {
      for_each = each.value.vpc_egress ? [1] : []

      content {
        egress = "PRIVATE_RANGES_ONLY"

        network_interfaces {
          network    = var.vpc_network
          subnetwork = var.vpc_subnet
        }
      }
    }

    containers {
      image = "${local.ar_path}/${each.value.image_dir}:${var.image_tag}"

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "1Gi"
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }

      # Shared config, this service's specifics, and the A2A identity it
      # advertises in its own Agent Card.
      dynamic "env" {
        for_each = merge(
          local.common_env,
          each.value.env,
          {
            A2A_PUBLIC_URL = local.run_url[each.key]
            A2A_HOST       = "${each.key}-${data.google_project.project.number}.${var.region}.run.app"
            A2A_PROTOCOL   = "https"
          },
        )

        content {
          name  = env.key
          value = env.value
        }
      }
    }
  }

  depends_on = [
    google_project_service.required,
    google_artifact_registry_repository.fleet,
  ]
}
