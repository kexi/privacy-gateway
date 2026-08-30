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

# No explicit publisher grant for the budget service: connecting a budget to a
# topic makes the Billing API grant its own service agent pubsub.publisher on
# that topic (the caller needs pubsub.topics.setIamPolicy, which the applier
# has). Why not grant it here: the agent has no stable, pre-provisioned email —
# an explicit member for a guessed name fails the whole apply, as observed with
# billing-budgets-pubsub@system.gserviceaccount.com. Delivery is verified after
# apply by `just kill-switch-test`, so a silent non-delivery cannot hide.

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
      currency_code = "JPY"
      units         = tostring(var.budget_jpy)
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

# ############################################################################
# Read access to Artifact Registry, which a service UPDATE requires.
#
# Not obvious, and it cost a live fire to find. `updateService` re-validates the
# container image the service references, so the caller must be able to read the
# repository even when the update touches nothing but `scaling`. Without it the
# call fails with:
#
#   PERMISSION_DENIED: Permission 'artifactregistry.repositories.downloadArtifacts'
#   denied on resource '.../repositories/agentic-fleet'
#
# `roles/run.admin` does not imply it: run.admin governs the Cloud Run resource,
# not the registry the image lives in. The failure was invisible for two live
# fires because the old code never awaited the long-running operation, so the
# rejection surfaced as a bare `{"error_class":"Error"}` with no cause.
#
# reader, not writer: the switch must be able to *validate* an image, never to
# push or delete one.
# ############################################################################
resource "google_artifact_registry_repository_iam_member" "kill_switch_reader" {
  count = var.kill_switch_enabled ? 1 : 0

  project    = var.project_id
  location   = var.region
  repository = google_artifact_registry_repository.fleet.name
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.kill_switch[0].email}"
}

# ############################################################################
# actAs on the GPU service's runtime identity, which a service UPDATE also
# requires.
#
# The second permission the live fire uncovered, immediately behind the
# Artifact Registry one. Deploying or updating a Cloud Run service means
# assigning it a runtime service account, so the caller must be able to act as
# that account — even when the update changes only `scaling` and leaves the
# identity exactly as it was:
#
#   PERMISSION_DENIED: Permission 'iam.serviceaccounts.actAs' denied on service
#   account sa-gemma@all-thinkgs.iam.gserviceaccount.com
#
# Granted per runtime identity, never project-wide: the switch updates exactly
# two services, so it should be able to impersonate exactly those two identities
# and no others.
#
# sa-gemma is needed for the scale-to-zero. sa-gateway is needed too — not for
# the invoker revocation, which is a setIamPolicy call and needs no actAs, but
# for writing the `kill-switch/tripped` annotation, which is a service update
# like any other. Missing it made the trip succeed and then fail to record
# itself (`killswitch.mark_failed`), which would have let a redelivery trip the
# fleet a second time.
# ############################################################################
resource "google_service_account_iam_member" "kill_switch_act_as_gemma" {
  count = var.kill_switch_enabled && var.gpu_enabled ? 1 : 0

  service_account_id = google_service_account.agents["sa-gemma"].name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.kill_switch[0].email}"
}

resource "google_service_account_iam_member" "kill_switch_act_as_gateway" {
  count = var.kill_switch_enabled ? 1 : 0

  service_account_id = google_service_account.agents["sa-gateway"].name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.kill_switch[0].email}"
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

      # The fleet identities the switch strips from gemma-serving's invoker
      # binding, belt-and-braces beside manual scaling at zero. Passed as
      # explicit member strings rather than derived in the service from a naming
      # convention: a convention that drifts leaves a binding alive through a
      # trip, and Terraform already knows the real emails.
      env {
        name = "KILL_SWITCH_FLEET_MEMBERS"
        value = join(",", [
          "serviceAccount:${google_service_account.agents["sa-gateway"].email}",
          "serviceAccount:${google_service_account.agents["sa-synthesis"].email}",
        ])
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

# --- dead letter --------------------------------------------------------------

# Where a budget notification goes when it could not be delivered five times.
#
# The point is not to reprocess it — by then the decision window has passed —
# but to make the loop *stop* and leave evidence that it happened. An operator
# reads it with `just logs-kill-switch-dlq`.
resource "google_pubsub_topic" "kill_switch_dead_letter" {
  count = var.kill_switch_enabled ? 1 : 0

  project = var.project_id
  name    = "billing-kill-switch-dead-letter"

  depends_on = [google_project_service.required]
}

# A subscription is what makes the topic retain anything: without one, messages
# published to it are dropped and the dead-letter policy silently discards.
resource "google_pubsub_subscription" "kill_switch_dead_letter" {
  count = var.kill_switch_enabled ? 1 : 0

  project = var.project_id
  name    = "billing-kill-switch-dead-letter-hold"
  topic   = google_pubsub_topic.kill_switch_dead_letter[0].id

  # Held long enough for a human to notice and read it, which a 600s window on
  # the live subscription is not. Nothing pulls this: it is an inbox.
  message_retention_duration = "604800s"

  depends_on = [google_project_service.required]
}

# Pub/Sub moves the message itself, so its own service agent needs to publish to
# the dead-letter topic and acknowledge on the source subscription. Without both
# grants the policy is configured but never actually fires.
resource "google_pubsub_topic_iam_member" "dead_letter_publisher" {
  count = var.kill_switch_enabled ? 1 : 0

  project = var.project_id
  topic   = google_pubsub_topic.kill_switch_dead_letter[0].name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:service-${data.google_project.project.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

resource "google_pubsub_subscription_iam_member" "dead_letter_subscriber" {
  count = var.kill_switch_enabled ? 1 : 0

  project      = var.project_id
  subscription = google_pubsub_subscription.kill_switch[0].name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:service-${data.google_project.project.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
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

  # A message that cannot be delivered has somewhere to go after five tries.
  #
  # Why this exists now: the service used to answer 500 on a failed trip, and
  # with no dead-letter policy Pub/Sub redelivered for the whole 600s retention
  # window — a revoke every ~30s that fought the operator's restore
  # (docs/proof/kill-switch.md). The handler no longer asks for redelivery, so
  # this is the second line of defence: it bounds any *transport-level* retry
  # loop (a service that will not start, a 5xx from the platform itself) that
  # the application code cannot answer its way out of.
  #
  # max_delivery_attempts is 5, the minimum the API allows: this is a cost gate,
  # and if five attempts have not tripped it, a sixth will not either.
  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.kill_switch_dead_letter[0].id
    max_delivery_attempts = 5
  }

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
