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
        # google/cloud-sdk ships python3, which is all the probe needs. Why not
        # the gateway image: it has no shell tooling, and baking a probe into the
        # production image would ship test code to production.
        image = "gcr.io/google.com/cloudsdktool/google-cloud-cli:stable"

        resources {
          limits = {
            cpu    = "1"
            memory = "512Mi"
          }
        }

        # Why python3 and not curl: the google-cloud-cli image no longer ships
        # curl, so the previous shell probe failed with "curl: command not found"
        # and reported empty status codes for every service. python3 is part of
        # the image because the SDK itself runs on it.
        # -u so each print reaches Cloud Logging as it happens: a buffered
        # failing run flushes nothing and reports only a bare exit code.
        command = ["/usr/bin/python3", "-u", "-c"]
        args = [<<-EOT
          import urllib.request, urllib.error, sys

          URLS = [
              "${local.run_url["core-agent"]}",
              "${local.run_url["synthesis-agent"]}",
              "${local.run_url["gemma-serving"]}",
          ]
          META = ("http://metadata.google.internal/computeMetadata/v1/"
                  "instance/service-accounts/default/identity?audience=")


          def status(url, token=None):
              req = urllib.request.Request(url + "/healthz")
              if token:
                  req.add_header("Authorization", "Bearer " + token)
              try:
                  with urllib.request.urlopen(req, timeout=30) as r:
                      return r.status
              except urllib.error.HTTPError as e:
                  return e.code
              except Exception as e:
                  print("  request failed: %s" % type(e).__name__)
                  return 0


          fail = 0
          for url in URLS:
              # The audience must be the callee's origin, exactly as
              # packages/common/src/http_client.ts derives it.
              req = urllib.request.Request(META + url,
                                           headers={"Metadata-Flavor": "Google"})
              with urllib.request.urlopen(req, timeout=30) as r:
                  token = r.read().decode()

              authed = status(url, token)
              anon = status(url)

              # From inside the VPC, ingress admits the request and IAM decides:
              # an authorized token is accepted, an anonymous call is refused.
              # Cloud Run answers an unauthorized caller with 403, and currently
              # 404 at the edge for an internal-ingress service, so accept either
              # refusal -- the assertion that matters is "not 200".
              print("%s no-auth=%s with-id-token=%s (expected 403/200)"
                    % (url, anon, authed))
              if authed != 200:
                  fail = 1
              if anon not in (401, 403, 404):
                  fail = 1

          print("OK: IAM admits the gateway identity and refuses an anonymous caller"
                if not fail else "FAIL: see above")
          sys.exit(fail)
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
