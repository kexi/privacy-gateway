# tflint configuration for infra/terraform.
#
# The bundled terraform ruleset covers naming, deprecated syntax, unused
# declarations and documentation requirements. The google plugin is not enabled:
# it downloads a release archive at `tflint --init` time, which would make the
# lint step depend on network access from lefthook and the Nix devShell.
config {
  call_module_type = "none"
}

plugin "terraform" {
  enabled = true
  preset  = "recommended"
}
