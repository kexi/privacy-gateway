# Provider and Terraform version pins.
#
# Why pessimistic constraints (~>) rather than exact ones: the lock file
# (.terraform.lock.hcl) already pins the exact provider builds and their hashes,
# so these only bound the range a `terraform init -upgrade` may move within.

terraform {
  required_version = "~> 1.15"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.9"
    }
    # google-beta carries the Cloud Run v2 GPU surface (node_selector /
    # gpu_zonal_redundancy_disabled) ahead of the GA provider. Only
    # google_cloud_run_v2_service uses it; everything else stays on GA.
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 7.9"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

provider "google-beta" {
  project = var.project_id
  region  = var.region
}
