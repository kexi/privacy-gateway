# Example variable overrides. Copy to a local .tfvars (which .gitignore
# excludes) and pass with `-var-file`, or set them on the command line.
#
# Never put secrets here: this file is committed, and Terraform state is not a
# secret store.

project_id = "all-thinkgs"
region     = "us-central1"

# The tag `just build` pushed. `just deploy` sets this for you.
image_tag = "latest"

# Set to false while the Cloud Run L4 quota request is pending, so the rest of
# the fleet can be applied first. Flip to true once it is granted.
gpu_enabled = true

gemini_model = "gemini-3.5-flash"
gemma_model  = "gemma4:12b"
