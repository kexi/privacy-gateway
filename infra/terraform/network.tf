# VPC subnet backing Direct VPC egress from the agent services.
#
# ############################################################################
# Why this file exists: gemma-serving has INGRESS_TRAFFIC_INTERNAL_ONLY, and
# the callers reach it at its *public* run.app address. Cloud Run only counts
# such a request as "internal" if it genuinely traversed a VPC network. Per
# cloud.google.com/run/docs/securing/private-networking, requests between
# Cloud Run services "all require additional configuration before they are
# recognized as 'internal'", and the documented options are:
#
#   1. route ALL traffic from the source through the VPC and enable Private
#      Google Access on the subnet used by Direct VPC egress;
#   2. front the destination with Private Service Connect or an internal
#      Application Load Balancer, reaching it by internal IP;
#   3. enable Private Google Access and add DNS overrides mapping run.app to
#      private.googleapis.com / restricted.googleapis.com.
#
# This configuration implements option 1, which is why the caller services set
# egress = "ALL_TRAFFIC" (cloudrun.tf) rather than PRIVATE_RANGES_ONLY. The
# previous PRIVATE_RANGES_ONLY setting sent only RFC1918 destinations through
# the VPC; a public run.app address is not an internal address, so that traffic
# left on the normal internet path and Cloud Run rejected it with 403 — the
# defect this replaces.
#
# Why not option 2 (internal ALB / PSC): both add a load balancer or a service
# attachment plus forwarding rules, static internal IPs and private DNS zones.
# That is more billable infrastructure and more moving parts than a four-service
# demo fleet needs, and none of it changes who may invoke the service — IAM
# (roles/run.invoker, iam.tf) already does that. Option 1 needs one subnet.
#
# Why not option 3 (DNS overrides): it requires a private DNS zone rewriting
# *.run.app for the whole network, which silently changes resolution for every
# future workload in the project, including ones that legitimately want the
# public path.
# ############################################################################

# A dedicated subnet rather than mutating the project's default subnet.
#
# Why not `default`: enabling Private Google Access on it is a project-wide
# side effect on a resource Terraform does not own, and Direct VPC egress
# consumes IPs from whatever subnet it is given (roughly 2x the instance count
# plus headroom for revision churn). Keeping that on its own range means the
# fleet cannot exhaust addresses other workloads depend on.
resource "google_compute_subnetwork" "fleet" {
  project = var.project_id
  region  = var.region
  name    = var.vpc_subnet
  network = var.vpc_network

  # /24 against the Direct VPC egress minimum of /26: Cloud Run reserves IPs in
  # blocks of 16, and a /26 leaves almost no room once three services scale to
  # max_instance_count = 3 and revisions overlap during a deploy.
  ip_cidr_range = var.vpc_subnet_cidr

  # THE line that makes internal-ingress gemma-serving reachable. Without it,
  # traffic to Google's front ends from inside the subnet has no private path
  # and the internal-ingress check fails.
  private_ip_google_access = true

  depends_on = [google_project_service.required]
}
