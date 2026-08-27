# Automatic cost kill switch: budget -> Pub/Sub -> Cloud Run -> stop spending.
#
# ############################################################################
# What this defends against. §5 of docs/DEPLOY.md prices a forgotten
# gemma-serving instance at roughly $39/day. Every other cost in this project
# rounds to zero next to that, and the failure mode is not a runaway workload —
# it is a human closing a laptop after a demo. A budget alert that only sends
# email does nothing at 3am, so the notification drives an action instead.
#
# The chain: google_billing_budget publishes every threshold crossing to a
# Pub/Sub topic; a push subscription delivers it to the kill-switch service
# with an OIDC token; the service compares costAmount against budgetAmount and,
# at 100%, removes the gateway's allUsers invoker binding and forces
# gemma-serving to max_instance_count = 0.
#
# Why the action lives in a service rather than in a Cloud Function or a
# gcloud-in-a-Job: it is TypeScript in the same workspace, under the same
# oxlint/tsc/vitest gates, sharing the same structured logger. A shell script
# calling gcloud would be shorter and would be the one piece of the fleet with
# no tests and no field allowlist.
#
# Why the budget's own `disable_default_iam_recipients` / email path is not
# enough: notifying a human is not a control. This is.
# ############################################################################

# --- topic -------------------------------------------------------------------

resource "google_pubsub_topic" "kill_switch" {
  count = var.kill_switch_enabled ? 1 : 0

  project = var.project_id
  name    = "billing-kill-switch"

  depends_on = [google_project_service.required]
}

# The Cloud Billing budget service publishes as a Google-managed service agent,
# which needs publisher rights on the topic. Without this the budget is created
# successfully and then silently never delivers — the failure mode that makes a
# kill switch worse than useless, because it looks installed.
resource "google_pubsub_topic_iam_member" "billing_publisher" {
  count = var.kill_switch_enabled ? 1 : 0

  project = var.project_id
  topic   = google_pubsub_topic.kill_switch[0].name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:billing-budgets-pubsub@system.gserviceaccount.com"
}

# --- budget ------------------------------------------------------------------

# ############################################################################
# REQUIRES A ROLE ON THE BILLING ACCOUNT, NOT ON THE PROJECT.
#
# `terraform apply` fails here with a 403 unless the applying identity holds
# roles/billing.costsManager (or roles/billing.admin) on
# var.billing_account. Project Owner does NOT confer it: a billing account is a
# separate resource in the Cloud Billing API, outside the project's IAM policy.
#
# Grant it with:
#   gcloud billing accounts add-iam-policy-binding 0136A5-03F510-FB783D \
#     --member="user:YOU@example.com" --role="roles/billing.costsManager"
#
# See the "Automatic cost kill switch" section of docs/DEPLOY.md. Setting
# kill_switch_enabled=false skips this resource entirely if the role cannot be
# granted.
# ############################################################################
resource "google_billing_budget" "fleet" {
  count = var.kill_switch_enabled ? 1 : 0

  billing_account = replace(var.billing_account, "billingAccounts/", "")
  display_name    = "agentic-fleet-kill-switch"

  # Scoped to this project alone. The billing account may fund unrelated work,
  # and a kill switch that trips on someone else's spend would take this fleet
  # down for a reason that has nothing to do with it.
  budget_filter {
    projects = ["projects/${data.google_project.project.number}"]

    # Why not calendar_period = "MONTH" explicitly: MONTH is the default, and
    # naming it here would be a second place to keep in sync with the budget's
    # actual reset behaviour.
  }

  amount {
    specified_amount {
      currency_code = "USD"
      units         = tostring(var.budget_usd)
    }
  }

  # 50% and 80% are observation points: they put the spend trajectory into
  # Cloud Logging (`killswitch.under_budget`) while there is still time to act
  # deliberately. Only the 100% crossing trips the switch — the service
  # compares the numbers itself rather than trusting which rule fired.
  threshold_rules {
    threshold_percent = 0.5
  }

  threshold_rules {
    threshold_percent = 0.8
  }

  threshold_rules {
    threshold_percent = 1.0
  }

  all_updates_rule {
    pubsub_topic   = google_pubsub_topic.kill_switch[0].id
    schema_version = "1.0"

    # Why not disable_default_iam_recipients = true: the humans who can restore
    # the fleet should still get the email. The Pub/Sub action and the email
    # notification are complementary, not alternatives.
  }

  depends_on = [
    google_project_service.required,
    google_pubsub_topic_iam_member.billing_publisher,
  ]
}

# --- service account ---------------------------------------------------------

resource "google_service_account" "kill_switch" {
  count = var.kill_switch_enabled ? 1 : 0

  project      = var.project_id
  account_id   = "sa-kill-switch"
  display_name = "Cost kill switch (revokes public access, scales GPU to zero)"

  depends_on = [google_project_service.required]
}

# Logs only. The kill switch writes no traces: it is not part of a request path,
# so there is no trace to join.
resource "google_project_iam_member" "kill_switch_logging" {
  count = var.kill_switch_enabled ? 1 : 0

  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.kill_switch[0].email}"
}

# ############################################################################
# run.admin, granted PER SERVICE and only on the two services the switch acts on.
#
# Why not roles/run.admin at the project level: this identity is reachable —
# indirectly, through a push subscription — from a Google-operated publisher,
# and project-wide run.admin would let anything that compromised that path
# delete every service in the fleet. Scoped to gateway-agent and gemma-serving,
# the worst it can do is exactly what it exists to do.
#
# run.admin rather than run.developer: changing a service's IAM policy requires
# run.services.setIamPolicy, which run.developer does not carry.
# ############################################################################
resource "google_cloud_run_v2_service_iam_member" "kill_switch_gateway" {
  count = var.kill_switch_enabled ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.agents["gateway-agent"].name
  role     = "roles/run.admin"
  member   = "serviceAccount:${google_service_account.kill_switch[0].email}"
}

# Follows gpu_enabled: with no gemma-serving there is nothing to scale down,
# and the binding would name a service that does not exist.
resource "google_cloud_run_v2_service_iam_member" "kill_switch_gemma" {
  count = var.kill_switch_enabled && var.gpu_enabled ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.gemma[0].name
  role     = "roles/run.admin"
  member   = "serviceAccount:${google_service_account.kill_switch[0].email}"
}

# --- the service -------------------------------------------------------------

resource "google_cloud_run_v2_service" "kill_switch" {
  count = var.kill_switch_enabled ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = "kill-switch"

  # Pub/Sub push originates outside the VPC, so this cannot be internal-only the
  # way core-agent and synthesis-agent are. IAM is the whole control here: only
  # sa-kill-switch-push holds run.invoker (below), so an anonymous POST is
  # rejected before the handler sees it.
  ingress = "INGRESS_TRAFFIC_ALL"

  deletion_protection = false

  template {
    service_account = google_service_account.kill_switch[0].email

    # min 0: it must cost nothing to have installed, or the thing that saves
    # money becomes a thing that spends it. max 2: Pub/Sub can redeliver
    # concurrently, and the operations are idempotent, so a second instance is
    # harmless and keeps a retry from queueing behind a slow first attempt.
    scaling {
      min_instance_count = 0
      max_instance_count = 2
    }

    max_instance_request_concurrency = 10

    # Two Cloud Run Admin API calls, one of which is a long-running operation.
    timeout = "120s"

    # No vpc_access: this service calls only the Cloud Run Admin API over the
    # public endpoint and is called from outside the VPC. Attaching it to the
    # fleet subnet would consume addresses for no reachability it needs.

    containers {
      image = "${local.ar_path}/kill-switch:${var.image_tag}"

      ports {
        container_port = 8080
      }

      # Smallest useful shape. It handles one small JSON body a few times a
      # month.
      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle          = true
        startup_cpu_boost = false
      }

      env {
        name  = "GOOGLE_CLOUD_PROJECT"
        value = var.project_id
      }

      env {
        name  = "GOOGLE_CLOUD_LOCATION"
        value = var.region
      }

      env {
        name  = "KILL_SWITCH_GATEWAY_SERVICE"
        value = google_cloud_run_v2_service.agents["gateway-agent"].name
      }

      env {
        name  = "KILL_SWITCH_GEMMA_SERVICE"
        value = "gemma-serving"
      }
    }
  }

  depends_on = [
    google_project_service.required,
    google_artifact_registry_repository.fleet,
  ]
}

# --- push subscription -------------------------------------------------------

# The identity Pub/Sub mints its OIDC token as. A dedicated account, not
# sa-kill-switch: the caller and the callee are different principals, and
# reusing one identity for both would mean the service could invoke itself.
resource "google_service_account" "kill_switch_push" {
  count = var.kill_switch_enabled ? 1 : 0

  project      = var.project_id
  account_id   = "sa-kill-switch-push"
  display_name = "Pub/Sub push identity for the cost kill switch"

  depends_on = [google_project_service.required]
}

# The only principal that may invoke the kill-switch service. There is
# deliberately no allUsers binding here — the endpoint is public in the ingress
# sense and closed in the IAM sense.
resource "google_cloud_run_v2_service_iam_member" "kill_switch_invoker" {
  count = var.kill_switch_enabled ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.kill_switch[0].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.kill_switch_push[0].email}"
}

# Pub/Sub signs the push token as sa-kill-switch-push, which requires the
# Pub/Sub service agent to be able to mint tokens for that account.
resource "google_project_service_identity" "pubsub" {
  count = var.kill_switch_enabled ? 1 : 0

  provider = google-beta
  project  = var.project_id
  service  = "pubsub.googleapis.com"
}

resource "google_service_account_iam_member" "pubsub_token_creator" {
  count = var.kill_switch_enabled ? 1 : 0

  service_account_id = google_service_account.kill_switch_push[0].name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_project_service_identity.pubsub[0].email}"
}

resource "google_pubsub_subscription" "kill_switch" {
  count = var.kill_switch_enabled ? 1 : 0

  project = var.project_id
  name    = "billing-kill-switch-push"
  topic   = google_pubsub_topic.kill_switch[0].id

  # A budget notification is worthless a day later — by then the money is spent.
  # 10 minutes of retries is the window in which acting still helps.
  message_retention_duration = "600s"
  ack_deadline_seconds       = 60

  # No dead-letter topic: there is nowhere useful for a failed kill-switch
  # message to go. A message that cannot be handled has already been logged at
  # ERROR by the service, and the operator's next step is to look at the
  # service, not at a queue.
  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "60s"
  }

  push_config {
    push_endpoint = "${google_cloud_run_v2_service.kill_switch[0].uri}/pubsub/push"

    # The OIDC token Cloud Run's run.invoker check validates. The audience is
    # the service's base URI, which is what Cloud Run compares against.
    oidc_token {
      service_account_email = google_service_account.kill_switch_push[0].email
      audience              = google_cloud_run_v2_service.kill_switch[0].uri
    }
  }

  depends_on = [
    google_cloud_run_v2_service_iam_member.kill_switch_invoker,
    google_service_account_iam_member.pubsub_token_creator,
  ]
}
