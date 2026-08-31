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

  # Service-level scaling, declared explicitly so it is desired state rather
  # than whatever the last write left behind. The kill switch trips this service
  # by setting MANUAL / manual_instance_count = 0 — the documented way to hold a
  # Cloud Run service at zero instances — so `just restore-after-kill` needs
  # Terraform to own the field and put it back to AUTOMATIC. Without this block
  # an apply would see no diff and leave the GPU pinned off after a restore.
  scaling {
    scaling_mode = "AUTOMATIC"
  }

  template {
    service_account = google_service_account.agents["sa-gemma"].email

    # Max 1 because the auto-granted RTX PRO 6000 milliGPU quota covers one
    # instance. min = 0 means an idle fleet costs nothing, which matters at
    # roughly $1.6/h while an instance is up.
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
    # Dropping zonal redundancy cuts the GPU rate by roughly 36%
    # (RTX PRO 6000: 0.00056913 -> 0.00036522 USD/GPU-sec). Unit price beats
    # redundancy for a single-instance demo service, and the auto-granted
    # no-zonal-redundancy milliGPU quota is the matching one.
    gpu_zonal_redundancy_disabled = true
    execution_environment         = "EXECUTION_ENVIRONMENT_GEN2"

    containers {
      image = "${local.ar_path}/gemma:${var.image_tag}"

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          # nvidia-rtx-pro-6000 mandates at least 20 CPU / 80 GiB per
          # https://docs.cloud.google.com/run/docs/configuring/services/gpu
          cpu              = "20"
          memory           = "80Gi"
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

  # The Gateway is the public entry point and must accept internet traffic.
  # Core and Synthesis are only ever called by the Gateway, which now routes all
  # of its egress through the VPC (see below), so they can be closed to the
  # internet as well as protected by IAM. Defence in depth: IAM already denies
  # an unauthenticated caller, and internal ingress means such a caller cannot
  # even reach the service to be denied.
  #
  # This is the same rule gemma-serving follows, and it holds for the same
  # reason: caller egress = ALL_TRAFFIC plus Private Google Access on the
  # subnet (network.tf) is what makes a run.app request count as internal.
  #
  # Why not internal-and-cloud-load-balancing: there is no load balancer in
  # front of these services, so that mode would reject the very traffic it is
  # meant to admit.
  ingress = each.value.ingress

  deletion_protection = false

  template {
    service_account = google_service_account.agents["sa-${replace(each.key, "-agent", "")}"].email

    scaling {
      min_instance_count = 0
      # Gateway pinned to one instance: the extraction span cache is
      # in-process, and a Codex retry that lands on a cache-less sibling pays
      # the full extraction again — with three instances a heavy first call
      # never converges. One instance at concurrency 40 is ample for the demo.
      max_instance_count = each.key == "gateway-agent" ? 1 : 3
    }

    max_instance_request_concurrency = 40
    timeout                          = "300s"

    # Direct VPC egress, for every caller of an internal-ingress service.
    #
    # ALL_TRAFFIC, not PRIVATE_RANGES_ONLY. The callees are addressed by their
    # public run.app URLs, and Cloud Run only honours internal ingress when the
    # request actually traversed the VPC. PRIVATE_RANGES_ONLY routes just
    # RFC1918 destinations through the network, so a run.app address took the
    # ordinary internet path and was rejected with 403 — see the reasoning
    # block in network.tf, which also enables Private Google Access on the
    # subnet this attaches to. The two settings only work as a pair.
    #
    # Why not a Serverless VPC Access connector: it bills a connector VM around
    # the clock and takes minutes to provision. Direct VPC egress needs no extra
    # resources beyond the subnet.
    #
    # Cost note: ALL_TRAFFIC also sends Vertex AI and Firestore traffic through
    # the VPC. Private Google Access keeps that on Google's internal network
    # rather than pushing it out through a NAT, so no Cloud NAT is required.
    dynamic "vpc_access" {
      for_each = each.value.vpc_egress ? [1] : []

      content {
        egress = "ALL_TRAFFIC"

        network_interfaces {
          network    = var.vpc_network
          subnetwork = google_compute_subnetwork.fleet.name
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
