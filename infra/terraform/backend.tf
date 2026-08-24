# Remote state in GCS.
#
# The bucket name is deliberately absent: it is supplied at init time with
# `-backend-config=bucket=...`, which `just tf-init` does from the
# TF_STATE_BUCKET environment variable (default `<project_id>-tfstate`).
# Why not hardcode it: the bucket lives outside Terraform's own lifecycle -- it
# has to exist before the first `terraform init` -- and keeping the name out of
# the committed config lets a second environment reuse this directory unchanged.
#
# Create the bucket once with `just tf-bootstrap`. That recipe is the ONLY place
# in this repository where a resource is created by gcloud rather than
# Terraform, for the chicken-and-egg reason above. It is idempotent.
terraform {
  backend "gcs" {
    prefix = "agentic-fleet"
  }
}
