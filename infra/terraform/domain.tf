# Custom domain for the public gateway: privacy-gateway.kexi.dev.
#
# Cloud Run domain mapping is free (no load balancer); Google provisions the
# certificate once DNS resolves to the Google front end. kexi.dev itself lives
# in Route 53, so this stack hosts a delegated Cloud DNS zone for just the
# subdomain and Route 53 carries only the NS delegation — the records the
# mapping depends on stay declared here, next to the mapping. The zone apex
# cannot hold a CNAME, so it serves Google's published GHS A/AAAA set instead.

resource "google_cloud_run_domain_mapping" "gateway" {
  count = var.gateway_domain == "" ? 0 : 1

  project  = var.project_id
  location = var.region
  name     = var.gateway_domain

  metadata {
    namespace = var.project_id
  }

  spec {
    route_name = google_cloud_run_v2_service.agents["gateway-agent"].name
  }
}

variable "gateway_domain" {
  description = "Custom domain mapped to the public gateway (empty disables the mapping)."
  type        = string
  default     = "privacy-gateway.kexi.dev"
}

resource "google_dns_managed_zone" "gateway" {
  count = var.gateway_domain == "" ? 0 : 1

  project     = var.project_id
  name        = "privacy-gateway-kexi-dev"
  dns_name    = "${var.gateway_domain}."
  description = "Delegated zone for the gateway custom domain (NS delegation lives in Route 53)."
}

# Google-published front-end addresses for domain mappings whose name sits at
# a zone apex (cloud.google.com/run/docs/mapping-custom-domains).
resource "google_dns_record_set" "gateway_a" {
  count = var.gateway_domain == "" ? 0 : 1

  project      = var.project_id
  managed_zone = google_dns_managed_zone.gateway[0].name
  name         = "${var.gateway_domain}."
  type         = "A"
  ttl          = 300
  rrdatas      = ["216.239.32.21", "216.239.34.21", "216.239.36.21", "216.239.38.21"]
}

resource "google_dns_record_set" "gateway_aaaa" {
  count = var.gateway_domain == "" ? 0 : 1

  project      = var.project_id
  managed_zone = google_dns_managed_zone.gateway[0].name
  name         = "${var.gateway_domain}."
  type         = "AAAA"
  ttl          = 300
  rrdatas      = ["2001:4860:4802:32::15", "2001:4860:4802:34::15", "2001:4860:4802:36::15", "2001:4860:4802:38::15"]
}

output "gateway_zone_name_servers" {
  description = "Point an NS record for the subdomain at these in Route 53."
  value       = var.gateway_domain == "" ? [] : google_dns_managed_zone.gateway[0].name_servers
}

output "gateway_domain_dns" {
  description = "DNS records the domain registrar must serve for the mapping."
  value       = var.gateway_domain == "" ? [] : [for r in google_cloud_run_domain_mapping.gateway[0].status[0].resource_records : "${r.name != "" ? r.name : var.gateway_domain} ${r.type} ${r.rrdata}"]
}
