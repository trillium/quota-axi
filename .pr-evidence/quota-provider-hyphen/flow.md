before: provider id `anthropic_api` -> Firstmate validator rejects -> "invalid snapshot"
after:  provider id `anthropic-api` -> matches ^[a-z0-9]+(-[a-z0-9]+)*$ -> accepted
