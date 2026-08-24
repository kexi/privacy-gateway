# A Cloud Run Job that proves IAM *accepts* an authorized caller.
#
# `just verify-auth` runs from a laptop and can only ever observe 403 against
# core-agent, synthesis-agent and gemma-serving: they use internal ingress, and
# ingress is evaluated before IAM, so the request is refused at the network edge
# before a token is even read. That half proves the door is shut. This job is the
# other half — it proves the door opens for the right identity.
#
# It has to run inside the VPC for the same reason: nothing outside can reach the
# services at all. The job attaches to the fleet subnet with Direct VPC egress
# and runs as the Gateway's own service account, so a 200 here is the exact hop
# the Gateway makes in production, not an approximation of it.
#
# Cost: a Job costs nothing at rest. It bills only for the seconds of one
# execution, which is why this is a Job and not a long-lived probe service.

resource "google_cloud_run_v2_job" "verify_auth" {
  count = var.enable_verify_job ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = "verify-auth"

  deletion_protection = false

  template {
    template {
      # The Gateway's identity, so the job exercises the same run.invoker
      # bindings the Gateway relies on. Borrowing a broader identity would
      # prove something the fleet does not actually depend on.
      service_account = google_service_account.agents["sa-gateway"].email

      max_retries = 0
      timeout     = "120s"

      # Same egress path as every caller of an internal-ingress service:
      # ALL_TRAFFIC plus Private Google Access on the subnet is what makes a
      # run.app request count as internal. See the reasoning in network.tf.
      vpc_access {
        egress = "ALL_TRAFFIC"

        network_interfaces {
          network    = var.vpc_network
          subnetwork = google_compute_subnetwork.fleet.name
        }
      }

      containers {
        # google/cloud-sdk carries both curl and the metadata-server helpers the
        # script needs. Why not the gateway image: it has no shell tooling, and
        # baking a probe into the production image would ship test code to
        # production.
        image = "gcr.io/google.com/cloudsdktool/google-cloud-cli:stable"

        resources {
          limits = {
            cpu    = "1"
            memory = "512Mi"
          }
        }

        command = ["/bin/bash", "-c"]
        args = [<<-EOT
          set -uo pipefail
          fail=0
          for url in "${local.run_url["core-agent"]}" \
                     "${local.run_url["synthesis-agent"]}" \
                     "${local.run_url["gemma-serving"]}"; do
            # The audience must be the callee's origin, exactly as
            # packages/common/src/http_client.ts derives it.
            token=$(curl -sf -H 'Metadata-Flavor: Google' \
              "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=$${url}")

            authed=$(curl -s -o /dev/null -w '%%{http_code}' \
              -H "Authorization: Bearer $${token}" "$${url}/healthz" || true)
            anon=$(curl -s -o /dev/null -w '%%{http_code}' "$${url}/healthz" || true)

            # From inside the VPC, ingress admits the request and IAM decides:
            # an authorized token is accepted, an anonymous call is refused.
            echo "$${url} no-auth=$${anon} with-id-token=$${authed} (expected 403/200)"
            [ "$${authed}" = "200" ] || fail=1
            [ "$${anon}" = "403" ] || fail=1
          done

          if [ "$${fail}" -eq 0 ]; then
            echo "OK: IAM admits the gateway identity and refuses an anonymous caller"
          else
            echo "FAIL: see above"
          fi
          exit "$${fail}"
        EOT
        ]
      }
    }
  }

  depends_on = [
    google_cloud_run_v2_service.agents,
    google_compute_subnetwork.fleet,
  ]
}
